import {
  cleanupArtifactDirectoryIfEmpty,
  openVerifiedArtifactStream,
  removeArtifactStagingTree,
  removeDeliveredArtifact,
  type ArtifactFile,
} from "./artifacts";
import { runDurableNoticeWorker } from "./durable-notice-worker";
import { errorFields, log } from "./log";
import { singleAttemptSlackCall } from "./rate-limit";
import { isTransientSlackError, slackErrorCode, slackErrorData } from "./slack-errors";
import {
  claimTurnArtifactDelivery,
  getTurnArtifactDelivery,
  isTurnArtifactStagingCleanupComplete,
  listTurnArtifactStagingCleanupDue,
  markTurnArtifactDelivered,
  markTurnArtifactAmbiguous,
  markTurnArtifactRetry,
  markTurnArtifactStagingRemoved,
  parkTurnArtifactDelivery,
  type TurnArtifactDeliveryRow,
} from "./state";

const activeArtifactDeliveries = new Map<string, Promise<ArtifactDeliveryOutcome>>();
export const TURN_ARTIFACT_MAX_ATTEMPTS = 8;

export type ArtifactDeliveryOutcome = "delivered" | "stopped" | "permanent_failure";

export interface ArtifactDeliveryOptions {
  shouldStop?: () => boolean;
  wait?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
  maximumAttempts?: number;
  projectFailure?: (turnId: number) => Promise<unknown>;
}

function artifactFile(row: TurnArtifactDeliveryRow): ArtifactFile {
  return {
    path: row.source_path,
    filename: row.filename,
    size: row.byte_size,
    device: row.source_device,
    inode: row.source_inode,
    sha256: row.content_sha256,
    mtimeMs: row.source_mtime_ms,
  };
}

function durableNoticeStatus(row: TurnArtifactDeliveryRow): "pending" | "sending" | "delivered" | "parked" {
  return row.status === "ambiguous" ? "parked" : row.status;
}

function cleanupStagingFile(row: TurnArtifactDeliveryRow) {
  removeDeliveredArtifact(artifactFile(row));
  markTurnArtifactStagingRemoved(row.artifact_id);
  if (isTurnArtifactStagingCleanupComplete(row.turn_id)) {
    removeArtifactStagingTree(row.directory_path);
  } else {
    cleanupArtifactDirectoryIfEmpty(row.directory_path);
  }
}

function isExplicitArtifactRateLimit(error: unknown) {
  const data = slackErrorData(error);
  const status = Number(data.status || data.statusCode || data.response?.status || 0);
  const code = slackErrorCode(error).toLowerCase();
  return status === 429 || code === "ratelimited" || code === "rate_limited";
}

function isExplicitPermanentSlackRejection(error: unknown) {
  const data = (error as any)?.data;
  return Boolean(data && typeof data === "object" && typeof data.error === "string")
    && !isTransientSlackError(error);
}

export function scheduleTurnArtifactDelivery(
  client: any,
  artifactId: string,
  ownerInstanceId: string,
  user?: string,
  options: ArtifactDeliveryOptions = {},
): Promise<ArtifactDeliveryOutcome> {
  const existing = activeArtifactDeliveries.get(artifactId);
  if (existing) return existing;
  let slackFileId: string | null = null;
  let failureDisposition: "retry" | "parked" | "ambiguous" = "parked";
  const delivery = runDurableNoticeWorker({
    load: () => {
      const row = getTurnArtifactDelivery(artifactId);
      return row ? {
        ...row,
        noticeStatus: durableNoticeStatus(row),
        nextAttemptMs: row.next_attempt_ms,
      } : null;
    },
    claim: (nowMs) => {
      const row = claimTurnArtifactDelivery(artifactId, ownerInstanceId, nowMs);
      return row ? {
        ...row,
        noticeStatus: durableNoticeStatus(row),
        nextAttemptMs: row.next_attempt_ms,
      } : null;
    },
    deliver: async (row) => {
      failureDisposition = "parked";
      const file = openVerifiedArtifactStream(artifactFile(row));
      try {
        try {
          const response: any = await singleAttemptSlackCall(client, "files.uploadV2", {
            channel_id: row.slack_channel_id,
            thread_ts: row.slack_thread_ts,
            file,
            filename: row.filename,
            title: row.filename,
          });
          slackFileId = response?.files?.[0]?.id || null;
        } catch (error) {
          failureDisposition = isExplicitArtifactRateLimit(error)
            ? "retry"
            : isExplicitPermanentSlackRejection(error) ? "parked" : "ambiguous";
          throw error;
        }
      } finally {
        if (!file.destroyed) file.destroy();
      }
    },
    markDelivered: () => {
      const delivered = markTurnArtifactDelivered(artifactId, ownerInstanceId, slackFileId);
      try {
        cleanupStagingFile(delivered);
      } catch (error) {
        log("warn", "artifact_staging_cleanup_failed", {
          artifact_id: artifactId,
          turn_id: delivered.turn_id,
          ...errorFields(error),
        });
      }
    },
    markRetry: (error, nextAttemptMs) => {
      markTurnArtifactRetry(artifactId, ownerInstanceId, error, nextAttemptMs);
    },
    markParked: (error) => {
      if (failureDisposition === "ambiguous") {
        markTurnArtifactAmbiguous(artifactId, ownerInstanceId, error, options.now?.() ?? Date.now());
      } else {
        parkTurnArtifactDelivery(artifactId, ownerInstanceId, error, options.now?.() ?? Date.now());
      }
    },
    isRetryable: () => failureDisposition === "retry",
    shouldStop: options.shouldStop,
    wait: options.wait,
    now: options.now,
    initialDelayMs: options.initialDelayMs,
    maximumDelayMs: options.maximumDelayMs,
    maximumAttempts: options.maximumAttempts ?? TURN_ARTIFACT_MAX_ATTEMPTS,
  }).then(async (outcome) => {
    const latest = getTurnArtifactDelivery(artifactId);
    if (outcome === "permanent_failure" && latest) {
      try {
        await options.projectFailure?.(latest.turn_id);
      } catch (error) {
        log("error", "artifact_failure_status_schedule_failed", {
          artifact_id: artifactId,
          turn_id: latest.turn_id,
          ...errorFields(error),
        });
      }
    }
    return outcome;
  }).finally(() => {
    if (activeArtifactDeliveries.get(artifactId) === delivery) activeArtifactDeliveries.delete(artifactId);
  });
  activeArtifactDeliveries.set(artifactId, delivery);
  return delivery;
}

export function cleanExpiredArtifactStaging(nowMs = Date.now()) {
  let removed = 0;
  for (const row of listTurnArtifactStagingCleanupDue(nowMs)) {
    try {
      cleanupStagingFile(row);
      removed += 1;
    } catch (error) {
      log("warn", "expired_artifact_staging_cleanup_failed", {
        artifact_id: row.artifact_id,
        turn_id: row.turn_id,
        ...errorFields(error),
      });
    }
  }
  return removed;
}
