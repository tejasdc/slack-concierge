import { createHash } from "node:crypto";
import {
  beginDeploymentRepair,
  claimDeploymentNotice,
  failDeploymentRun,
  getLastKnownGoodRelease,
  getDeploymentNotice,
  listPendingDeploymentNotices,
  listPreparedDeploymentRuns,
  listRunnableDeploymentRepairs,
  markDeploymentNoticeDelivered,
  markDeploymentNoticeRetry,
  parkDeploymentNotice,
  recoverDeadDeploymentRuns,
  recoverDeploymentNoticeClaims,
  requestAutomaticDeployment,
  type DeploymentRunRow,
} from "./deployment-state";
import { runDurableNoticeWorker } from "./durable-notice-worker";
import { errorFields, log } from "./log";
import { postLongReply } from "./slack-post";
import { isTransientSlackError } from "./slack-errors";

export interface DeploymentWorkerServices {
  discoverDesiredCommit?(): Promise<string | null>;
  launchRun(run: DeploymentRunRow): Promise<void>;
  launchRepair?(incidentId: string): Promise<void>;
}

export async function reconcileDeploymentWork(input: {
  client: any;
  ownerInstanceId: string;
  isOwnerAlive(identity: { pid: number; bootId: string; startTicks: string }): boolean;
  shouldStop(): boolean;
  services: DeploymentWorkerServices;
}): Promise<{
  deadRuns: number;
  recoveredNotices: number;
  automaticDeploymentPrepared: boolean;
  launched: number;
  repairsLaunched: number;
}> {
  const recoveredNotices = recoverDeploymentNoticeClaims(input.isOwnerAlive);
  const deadRuns = recoverDeadDeploymentRuns(input.isOwnerAlive);
  let automaticDeploymentPrepared = false;
  if (input.services.discoverDesiredCommit && !input.shouldStop()) {
    try {
      const desiredCommit = await input.services.discoverDesiredCommit();
      if (desiredCommit) {
        const automatic = requestAutomaticDeployment(desiredCommit);
        automaticDeploymentPrepared = automatic.reason === "prepared";
      }
    } catch (error) {
      log("error", "automatic_deployment_discovery_failed", errorFields(error));
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
      const failure = `Transient deployment launch failed: ${launchError}`;
      const lastKnownGood = getLastKnownGoodRelease();
      if (run.desired_commit && lastKnownGood) {
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

  return { deadRuns, recoveredNotices, automaticDeploymentPrepared, launched, repairsLaunched };
}
