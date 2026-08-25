import {
  claimDeploymentNotice,
  claimDeploymentWake,
  failDeploymentRun,
  getDeploymentNotice,
  listPendingDeploymentNotices,
  listPendingDeploymentWakes,
  listPreparedDeploymentRuns,
  listRunnableDeploymentRepairs,
  markDeploymentNoticeDelivered,
  markDeploymentNoticeRetry,
  parkDeploymentNotice,
  parkDeploymentWake,
  recoverDeadDeploymentRuns,
  recoverDeploymentNoticeClaims,
  recoverDeploymentWakeClaims,
  settleDeploymentWakeFromTurn,
  type ClaimedDeploymentWake,
  type DeploymentRunRow,
  type DeploymentWakeRow,
} from "./deployment-state";
import { runDurableNoticeWorker } from "./durable-notice-worker";
import { errorFields, log } from "./log";
import { postLongReply } from "./slack-post";
import { isTransientSlackError } from "./slack-errors";

export interface DeploymentWorkerServices {
  launchRun(run: DeploymentRunRow): Promise<void>;
  launchRepair?(incidentId: string): Promise<void>;
  executeWake(claim: ClaimedDeploymentWake): Promise<void>;
}

export async function reconcileDeploymentWork(input: {
  client: any;
  ownerInstanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
  shouldStop(): boolean;
  services: DeploymentWorkerServices;
}): Promise<{
  deadRuns: number;
  wakeRecovery: { retried: number; parked: number; settled: number };
  recoveredNotices: number;
  launched: number;
  repairsLaunched: number;
  wakesStarted: number;
}> {
  const wakeRecovery = recoverDeploymentWakeClaims(input.isOwnerAlive);
  const recoveredNotices = recoverDeploymentNoticeClaims(input.isOwnerAlive);
  const deadRuns = recoverDeadDeploymentRuns(input.isOwnerAlive);
  let repairsLaunched = 0;
  for (const incident of listRunnableDeploymentRepairs()) {
    if (input.shouldStop()) break;
    try {
      if (!input.services.launchRepair) throw new Error("Deployment repair launcher is unavailable.");
      await input.services.launchRepair(incident.id);
      repairsLaunched += 1;
    } catch (error) {
      log("error", "deployment_repair_launch_failed", {
        ...errorFields(error),
        deployment_run_id: incident.run_id,
        deployment_repair_incident_id: incident.id,
      });
    }
  }
  let launched = 0;
  for (const run of listPreparedDeploymentRuns()) {
    if (input.shouldStop()) break;
    try {
      await input.services.launchRun(run);
      launched += 1;
    } catch (error) {
      const launchError = String(error);
      failDeploymentRun(
        run.id,
        `Transient deployment launch failed: ${launchError}`,
        "failed",
        {
          noticeReason: "Concierge could not start the detached deployment runner.",
          diagnostics: {
            stage: "runner-launch",
            command_output: launchError,
          },
        },
      );
      log("error", "deployment_run_launch_failed", {
        ...errorFields(error),
        deployment_run_id: run.id,
        unit_name: run.unit_name,
      });
    }
  }

  await Promise.all(listPendingDeploymentNotices().map(async (notice) => {
    const outcome = await runDurableNoticeWorker({
      load: () => {
        const current = getDeploymentNotice(notice.id);
        return current && {
          noticeStatus: current.status,
          attempts: current.attempts,
          nextAttemptMs: current.next_attempt_ms,
        };
      },
      claim: (nowMs) => {
        const claimed = claimDeploymentNotice(notice.id, input.ownerInstanceId, nowMs);
        return claimed && {
          noticeStatus: claimed.status,
          attempts: claimed.attempts,
          nextAttemptMs: claimed.next_attempt_ms,
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
      maximumAttempts: 8,
    });
    log(outcome === "delivered" ? "info" : "warn", "deployment_notice_settled", {
      deployment_run_id: notice.run_id,
      deployment_notice_id: notice.id,
      outcome,
    });
  }));

  let wakesStarted = 0;
  const pendingWakes = listPendingDeploymentWakes();
  await Promise.all(pendingWakes.map(async (wake) => {
    if (input.shouldStop()) return;
    const claim = claimDeploymentWake(wake.id, input.ownerInstanceId);
    if (!claim) return;
    wakesStarted += 1;
    log("info", "deployment_verification_wake_started", {
      deployment_run_id: wake.run_id,
      deployment_wake_id: wake.id,
      turn_id: claim.turnId,
      session_id: claim.session.id,
      channel: wake.slack_channel_id,
      thread_ts: wake.slack_thread_ts,
    });
    try {
      await input.services.executeWake(claim);
      const settled = settleDeploymentWakeFromTurn(wake.id);
      log(settled?.status === "delivered" ? "info" : "warn", "deployment_verification_wake_settled", {
        deployment_run_id: wake.run_id,
        deployment_wake_id: wake.id,
        turn_id: claim.turnId,
        status: settled?.status || "missing",
        error: settled?.error || null,
      });
    } catch (error) {
      parkDeploymentWake(wake.id, `Verification worker failed: ${String(error)}`);
      log("error", "deployment_verification_wake_failed", {
        ...errorFields(error),
        deployment_run_id: wake.run_id,
        deployment_wake_id: wake.id,
        turn_id: claim.turnId,
      });
    }
  }));

  return { deadRuns, wakeRecovery, recoveredNotices, launched, repairsLaunched, wakesStarted };
}

export function deploymentWakeEnvironment(wake: DeploymentWakeRow, ownerInstanceId: string) {
  return {
    CONCIERGE_DEPLOYMENT_RUN_ID: wake.run_id,
    CONCIERGE_DEPLOYMENT_WAKE_ID: wake.id,
    CONCIERGE_OWNER_INSTANCE_ID: ownerInstanceId,
  };
}
