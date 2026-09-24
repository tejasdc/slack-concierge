import { createHash } from "node:crypto";
import {
  adoptRewrittenDesiredCommit,
  beginDeploymentRepair,
  claimDeploymentTurnReaction,
  claimDeploymentNotice,
  failDeploymentRun,
  getActiveDeploymentRun,
  getDeploymentDesiredState,
  getDeploymentTurnReaction,
  getLastKnownGoodRelease,
  getDeploymentNotice,
  listPendingDeploymentTurnReactions,
  listPendingDeploymentNotices,
  listPreparedDeploymentRuns,
  listRunnableDeploymentRepairs,
  markDeploymentNoticeDelivered,
  markDeploymentNoticeRetry,
  markDeploymentTurnReactionDelivered,
  markDeploymentTurnReactionRetry,
  parkDeploymentNotice,
  parkDeploymentRepair,
  parkDeploymentTurnReaction,
  recordDeploymentTurnReactionDiscoveryFailure,
  recoverDeadDeploymentRuns,
  recoverDeploymentTurnReactionClaims,
  recoverDeploymentNoticeClaims,
  registerDeploymentTurnReactionTargets,
  requestAutomaticDeployment,
  type DeploymentTurnReactionRow,
  type DeploymentTurnReactionState,
  type DeploymentRunRow,
} from "./deployment-state";
import { deploymentReactionTargetsForCommitRange } from "./deployment-reaction-provenance";
import { commitMainHas } from "./release-history";
import { runDurableNoticeWorker } from "./durable-notice-worker";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { postLongReply } from "./slack-post";
import { isTransientSlackError, slackErrorCode } from "./slack-errors";

const DEPLOYMENT_REACTION_EMOJI: Record<DeploymentTurnReactionState, string> = {
  deploying: "package",
  repairing: "hammer_and_wrench",
  deployed: "rocket",
  parked: "octagonal_sign",
};

const DEPLOYMENT_REACTION_STATES = Object.keys(DEPLOYMENT_REACTION_EMOJI) as DeploymentTurnReactionState[];
const sqlTimeMs = (time: string) => Date.parse(time.endsWith("Z") ? time : `${time.replace(" ", "T")}Z`);

function deploymentReactionNoticeShape(row: DeploymentTurnReactionRow) {
  return {
    ...row,
    noticeStatus: row.projection_status,
    attempts: row.projection_attempts,
    nextAttemptMs: row.projection_next_attempt_ms,
    startedAtMs: sqlTimeMs(row.created_at),
  };
}

async function projectDeploymentReactionTarget(
  client: any,
  row: DeploymentTurnReactionRow,
  timestamp: string,
) {
  try {
    await slackCall(client, "reactions.add", {
      channel: row.slack_channel_id,
      timestamp,
      name: DEPLOYMENT_REACTION_EMOJI[row.desired_state],
    }, { channel: row.slack_channel_id });
  } catch (error) {
    if (slackErrorCode(error) !== "already_reacted") throw error;
  }
  const skippedLifecycleState = row.desired_revision - row.projected_revision > 1;
  const statesToRemove = skippedLifecycleState
    ? DEPLOYMENT_REACTION_STATES.filter((state) => state !== row.desired_state)
    : row.projected_state && row.projected_state !== row.desired_state
      ? [row.projected_state]
      : [];
  for (const state of statesToRemove) {
    try {
      await slackCall(client, "reactions.remove", {
        channel: row.slack_channel_id,
        timestamp,
        name: DEPLOYMENT_REACTION_EMOJI[state],
      }, { channel: row.slack_channel_id });
    } catch (error) {
      if (slackErrorCode(error) !== "no_reaction") throw error;
    }
  }
}

function registerReactionTargetsForCommitRange(input: {
  runId: string;
  baseCommit: string;
  candidateCommit: string;
  state: DeploymentTurnReactionState;
  turnId?: number;
}) {
  try {
    const targets = deploymentReactionTargetsForCommitRange(
      process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge",
      input.baseCommit,
      input.candidateCommit,
    );
    return registerDeploymentTurnReactionTargets(
      input.runId,
      input.turnId === undefined ? targets : targets.filter((target) => target.turnId === input.turnId),
      input.state,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordDeploymentTurnReactionDiscoveryFailure(input.runId, message);
    log("error", "deployment_turn_reaction_discovery_failed", {
      ...errorFields(error),
      deployment_run_id: input.runId,
    });
    return 0;
  }
}

export function refreshActiveDeploymentReactionTargets(turnId?: number) {
  const activeRun = getActiveDeploymentRun();
  const lastKnownGood = getLastKnownGoodRelease();
  const attributableCommit = activeRun?.candidate_commit || activeRun?.desired_commit;
  if (!activeRun || !lastKnownGood || !attributableCommit) return 0;
  return registerReactionTargetsForCommitRange({
    runId: activeRun.id,
    baseCommit: lastKnownGood.git_commit,
    candidateCommit: attributableCommit,
    state: activeRun.repair_state && activeRun.repair_state !== "retrying" ? "repairing" : "deploying",
    turnId,
  });
}

export interface DeploymentWorkerServices {
  launchRun(run: DeploymentRunRow): Promise<void>;
  launchRepair?(incidentId: string): Promise<void>;
}

/**
 * The commit a deployment can actually install. A force-push can leave the recorded one on no
 * branch, and then every deployment installs main, ends with that commit still unmet and starts
 * the next one — nine restarts in eleven minutes on 2026-09-23, with his update notice never
 * clearing. Main's head is adopted once, loudly, instead of chasing what no longer exists.
 */
function installableDesiredCommit(): string | null {
  const desired = getDeploymentDesiredState();
  if (!desired) return null;
  const main = commitMainHas(desired.desired_commit);
  if (!main || !main.rewritten) return desired.desired_commit;
  const adopted = adoptRewrittenDesiredCommit({ head: main.head, rewrittenFrom: desired.desired_commit });
  log("warn", "deployment_desired_commit_rewritten", {
    rewritten_from: desired.desired_commit,
    adopted: adopted?.desired_commit ?? null,
    github_delivery_id: desired.github_delivery_id,
  });
  return adopted?.desired_commit ?? null;
}

function sharedCheckoutClean(): boolean {
  const result = Bun.spawnSync({
    cmd: ["git", "status", "--porcelain", "--untracked-files=all"],
    cwd: process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge",
    stdout: "pipe", stderr: "ignore", timeout: 5000,
  });
  return result.exitCode === 0 && result.stdout.length === 0;
}

export async function reconcileDeploymentWork(input: {
  client: any;
  ownerInstanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
  shouldStop(): boolean;
  services: DeploymentWorkerServices;
  onTurnReactionSettled?: (turnId: number) => void;
}): Promise<{
  deadRuns: number;
  recoveredNotices: number;
  recoveredReactions: number;
  automaticDeploymentPrepared: boolean;
  launched: number;
  repairsLaunched: number;
  reactionsStarted: number;
}> {
  const recoveredNotices = recoverDeploymentNoticeClaims(input.isOwnerAlive);
  const recoveredReactions = recoverDeploymentTurnReactionClaims();
  const deadRuns = recoverDeadDeploymentRuns(input.isOwnerAlive);
  let automaticDeploymentPrepared = false;
  if (!input.shouldStop()) {
    try {
      const desired = installableDesiredCommit();
      if (desired) {
        const automatic = requestAutomaticDeployment(desired, "concierge", sharedCheckoutClean());
        automaticDeploymentPrepared = automatic.reason === "prepared";
      }
    } catch (error) {
      log("error", "automatic_deployment_request_failed", errorFields(error));
    }
  }
  refreshActiveDeploymentReactionTargets();
  let launched = 0;
  for (const run of listPreparedDeploymentRuns()) {
    if (input.shouldStop()) break;
    try {
      await input.services.launchRun(run);
      launched += 1;
    } catch (error) {
      const launchError = String(error);
      const failure = `Transient deployment launch failed: ${launchError}`;
      const lastKnownGood = getLastKnownGoodRelease();
      if (run.desired_commit && lastKnownGood) {
        registerReactionTargetsForCommitRange({
          runId: run.id,
          baseCommit: lastKnownGood.git_commit,
          candidateCommit: run.desired_commit,
          state: "repairing",
        });
        beginDeploymentRepair({
          runId: run.id,
          failedCommit: run.desired_commit,
          restoredCommit: lastKnownGood.git_commit,
          failureFingerprint: createHash("sha256").update(`runner-launch\0${launchError}`).digest("hex"),
          error: failure,
        });
      } else {
        failDeploymentRun(
          run.id,
          failure,
          "failed",
          {
            noticeReason: "Concierge could not start the detached deployment runner.",
            diagnostics: {
              stage: "runner-launch",
              command_output: launchError,
            },
          },
        );
      }
      log("error", "deployment_run_launch_failed", {
        ...errorFields(error),
        deployment_run_id: run.id,
        unit_name: run.unit_name,
      });
    }
  }

  let repairsLaunched = 0;
  for (const incident of listRunnableDeploymentRepairs()) {
    if (input.shouldStop()) break;
    try {
      if (!input.services.launchRepair) throw new Error("Deployment repair launcher is unavailable.");
      await input.services.launchRepair(incident.id);
      repairsLaunched += 1;
    } catch (error) {
      if ((error as any)?.code === "start-limit-hit") {
        parkDeploymentRepair(incident.id, "The repair service reached its native process start limit.", {
          noticeReason: "Autonomous repair stopped because its service repeatedly failed to start.",
        });
      }
      log("error", "deployment_repair_launch_failed", {
        ...errorFields(error),
        deployment_run_id: incident.run_id,
        deployment_repair_incident_id: incident.id,
      });
    }
  }

  let reactionsStarted = 0;
  await Promise.all(listPendingDeploymentTurnReactions().map(async (reaction) => {
    if (input.shouldStop()) return;
    let claimed: DeploymentTurnReactionRow | null = null;
    reactionsStarted += 1;
    const outcome = await runDurableNoticeWorker({
      load: () => {
        const current = getDeploymentTurnReaction(reaction.turn_id);
        return current && deploymentReactionNoticeShape(current);
      },
      claim: (nowMs) => {
        claimed = claimDeploymentTurnReaction(reaction.turn_id, nowMs);
        return claimed && deploymentReactionNoticeShape(claimed);
      },
      deliver: async (current) => {
        await projectDeploymentReactionTarget(input.client, current, current.slack_message_ts);
        if (current.slack_user_msg_ts !== current.slack_message_ts) {
          await projectDeploymentReactionTarget(input.client, current, current.slack_user_msg_ts);
        }
      },
      markDelivered: () => {
        if (!claimed) throw new Error("Deployment reaction projection completed without a claim.");
        markDeploymentTurnReactionDelivered(claimed.turn_id, claimed.desired_revision, claimed.desired_state);
      },
      markRetry: (error, nextAttemptMs) => {
        if (!claimed) throw new Error("Deployment reaction projection retried without a claim.");
        markDeploymentTurnReactionRetry(claimed.turn_id, claimed.desired_revision, error, nextAttemptMs);
      },
      markParked: (error) => {
        if (!claimed) throw new Error("Deployment reaction projection parked without a claim.");
        parkDeploymentTurnReaction(claimed.turn_id, claimed.desired_revision, error);
      },
      isRetryable: isTransientSlackError,
      shouldStop: input.shouldStop,
      breakerKey: `deployment-reaction:${reaction.run_id}:${reaction.turn_id}`,
      breakerWhat: "A deployment status update",
    });
    log(outcome === "delivered" ? "info" : "warn", "deployment_turn_reaction_settled", {
      deployment_run_id: reaction.run_id,
      turn_id: reaction.turn_id,
      desired_state: reaction.desired_state,
      outcome,
    });
    input.onTurnReactionSettled?.(reaction.turn_id);
  }));

  await Promise.all(listPendingDeploymentNotices().map(async (notice) => {
    const outcome = await runDurableNoticeWorker({
      load: () => {
        const current = getDeploymentNotice(notice.id);
        return current && {
          noticeStatus: current.status,
          attempts: current.attempts,
          nextAttemptMs: current.next_attempt_ms,
          startedAtMs: sqlTimeMs(current.created_at),
        };
      },
      claim: (nowMs) => {
        const claimed = claimDeploymentNotice(notice.id, input.ownerInstanceId, nowMs);
        return claimed && {
          noticeStatus: claimed.status,
          attempts: claimed.attempts,
          nextAttemptMs: claimed.next_attempt_ms,
          startedAtMs: sqlTimeMs(claimed.created_at),
        };
      },
      deliver: async () => {
        const current = getDeploymentNotice(notice.id);
        if (!current || current.status !== "sending") throw new Error("Deployment notice lost its sending lease.");
        await postLongReply({
          client: input.client,
          channel: current.slack_channel_id,
          threadTs: current.slack_thread_ts,
          text: current.text,
          user: current.requested_by_user_id || undefined,
          idempotencyKey: current.client_msg_id,
        });
      },
      markDelivered: () => markDeploymentNoticeDelivered(notice.id, input.ownerInstanceId),
      markRetry: (error, nextAttemptMs) => markDeploymentNoticeRetry(
        notice.id,
        input.ownerInstanceId,
        error,
        nextAttemptMs,
      ),
      markParked: (error) => parkDeploymentNotice(notice.id, input.ownerInstanceId, error),
      isRetryable: isTransientSlackError,
      shouldStop: input.shouldStop,
      breakerKey: `deployment-notice:${notice.id}`,
      breakerWhat: "A deployment notice",
    });
    log(outcome === "delivered" ? "info" : "warn", "deployment_notice_settled", {
      deployment_run_id: notice.run_id,
      deployment_notice_id: notice.id,
      outcome,
    });
  }));

  return {
    deadRuns,
    recoveredNotices,
    recoveredReactions,
    automaticDeploymentPrepared,
    launched,
    repairsLaunched,
    reactionsStarted,
  };
}
