import { CodexControlRequestError, findCodexForksByThreadSource } from "./codex";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";
import { errorFields, log } from "./log";
import { providers } from "./providers";
import { slackCall } from "./rate-limit";
import { isTransientSlackError } from "./slack-errors";
import { slackMessageSourceUrl } from "./slack-links";
import {
  beginForkRequest,
  claimForkRequestBinding,
  claimForkRequestDelivery,
  completeForkRequestDelivery,
  getForkRequest,
  getForkIngressBarrier,
  listRecoverableForkRequests,
  markForkRequestAmbiguous,
  markForkRequestAnchorPosted,
  markForkRequestCreated,
  markForkRequestDeliveryRetry,
  markForkRequestRecoveryAmbiguous,
  markForkRequestRejected,
  parkForkRequestBinding,
  parkForkRequestDelivery,
  recoverForkRequestBinding,
  recoverForkRequestCreated,
  recoverForkRequestDelivery,
  releaseForkRequestBinding,
  resetForkRequestAfterDeadOwner,
  type ForkRequestRow,
} from "./state";

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const MAX_FORK_SOURCE_EXCERPT_CHARS = 320;

export function forkSourceExcerpt(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const characters = Array.from(normalized);
  if (characters.length <= MAX_FORK_SOURCE_EXCERPT_CHARS) return normalized;
  return `${characters.slice(0, MAX_FORK_SOURCE_EXCERPT_CHARS - 1).join("").trimEnd()}…`;
}

function escapeSlackMrkdwn(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function forkAnchorMessage(request: ForkRequestRow): string {
  const provider = request.provider_id === "codex" ? "Codex" : "Claude Code";
  const excerpt = forkSourceExcerpt(request.source_message_excerpt);
  if (!request.source_message_ts) {
    return `Forked ${provider} from the latest complete session. Reply in this new thread to continue the fork.`;
  }
  const sourceUrl = slackMessageSourceUrl(request.slack_channel_id, request.source_message_ts);
  const source = `<${sourceUrl}|this source message>`;
  if (!excerpt) {
    return `Forked ${provider} from ${source}. Reply in this new thread to continue the fork.`;
  }
  return [
    `Forked ${provider} from ${source}:`,
    `> ${escapeSlackMrkdwn(excerpt)}`,
    "Reply in this new thread to continue the fork.",
  ].join("\n");
}

function ownerIsAlive(
  request: ForkRequestRow,
  isAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean,
) {
  return request.owner_pid != null && isAlive({
    pid: request.owner_pid,
    bootId: request.owner_boot_id || "",
    startTicks: request.owner_process_start_ticks || "",
  });
}

async function recoverCodexProviderResult(request: ForkRequestRow): Promise<ForkRequestRow> {
  const matches = await findCodexForksByThreadSource({
    sourceSessionUUID: request.source_provider_session_uuid,
    threadSource: request.provider_request_key,
    cwd: request.cwd,
  });
  if (matches.length === 1) {
    await retryTransientDatabaseOperation({
      operation: () => recoverForkRequestCreated(request.request_id, matches[0]),
    });
  } else if (matches.length > 1) {
    if (request.status === "forking") {
      await retryTransientDatabaseOperation({
        operation: () => markForkRequestRecoveryAmbiguous(
          request.request_id,
          `Codex returned ${matches.length} forks for one request marker; refusing to choose one.`,
        ),
      });
    }
  } else if (request.status === "forking") {
    await retryTransientDatabaseOperation({
      operation: () => resetForkRequestAfterDeadOwner(request.request_id),
    });
  }
  return getForkRequest(request.request_id)!;
}

async function createProviderFork(request: ForkRequestRow, instanceId: string): Promise<ForkRequestRow> {
  const leased = beginForkRequest(request.request_id, instanceId);
  if (!leased) return getForkRequest(request.request_id)!;
  let forkedProviderSessionUUID: string;
  try {
    const result = await providers[leased.provider_id].fork({
      cwd: leased.cwd,
      additionalDirs: JSON.parse(leased.additional_dirs_json),
      sessionUUID: leased.source_provider_session_uuid,
      lastTurnId: leased.last_provider_turn_id,
      threadSource: leased.provider_request_key,
    });
    if (!result.sessionUUID) {
      throw new Error("Provider fork completed without a session id.");
    }
    forkedProviderSessionUUID = result.sessionUUID;
  } catch (error) {
    if (error instanceof CodexControlRequestError && error.outcome === "rejected") {
      await retryTransientDatabaseOperation({
        operation: () => markForkRequestRejected(leased.request_id, instanceId, error.message),
      });
    } else {
      await retryTransientDatabaseOperation({
        operation: () => markForkRequestAmbiguous(leased.request_id, instanceId, String(error)),
      });
      if (leased.provider_id === "codex") {
        try {
          await recoverCodexProviderResult(getForkRequest(leased.request_id)!);
        } catch (recoveryError) {
          log("warn", "codex_fork_ambiguity_recovery_failed", {
            request_id: leased.request_id,
            ...errorFields(recoveryError),
          });
        }
      }
    }
    return getForkRequest(request.request_id)!;
  }
  await retryTransientDatabaseOperation({
    operation: () => markForkRequestCreated(leased.request_id, instanceId, forkedProviderSessionUUID),
  });
  return getForkRequest(request.request_id)!;
}

async function deliverForkAnchor(input: {
  request: ForkRequestRow;
  client: any;
  instanceId: string;
  shouldStop?: () => boolean;
}): Promise<ForkRequestRow> {
  let delayMs = 1_000;
  while (!input.shouldStop?.()) {
    const leased = claimForkRequestDelivery(input.request.request_id, input.instanceId);
    if (!leased) return getForkRequest(input.request.request_id)!;
    let posted: any;
    try {
      posted = await slackCall(input.client, "chat.postMessage", {
        channel: leased.slack_channel_id,
        text: forkAnchorMessage(leased),
        client_msg_id: leased.slack_client_msg_id,
      }, { channel: leased.slack_channel_id, user: leased.requested_by });
      if (!posted?.ts) throw new Error("Slack did not return a timestamp for the fork anchor.");
    } catch (error) {
      if (!isTransientSlackError(error)) {
        parkForkRequestDelivery(leased.request_id, input.instanceId, String(error));
        return getForkRequest(leased.request_id)!;
      }
      markForkRequestDeliveryRetry(leased.request_id, input.instanceId, String(error));
      if (input.shouldStop?.()) return getForkRequest(leased.request_id)!;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
      continue;
    }
    const persisted = await retryTransientDatabaseOperation({
      operation: () => markForkRequestAnchorPosted(
        leased.request_id,
        input.instanceId,
        posted.ts,
      ),
      shouldStop: input.shouldStop,
    });
    if (persisted.stopped) return getForkRequest(leased.request_id)!;
    return persisted.value;
  }
  return getForkRequest(input.request.request_id)!;
}

async function bindForkAnchor(input: {
  request: ForkRequestRow;
  instanceId: string;
  shouldStop?: () => boolean;
  completeDelivery?: typeof completeForkRequestDelivery;
}): Promise<ForkRequestRow> {
  let delayMs = 50;
  while (!input.shouldStop?.()) {
    const leased = claimForkRequestBinding(input.request.request_id, input.instanceId);
    if (!leased) return getForkRequest(input.request.request_id)!;
    try {
      const completion = await retryTransientDatabaseOperation({
        operation: () => (input.completeDelivery || completeForkRequestDelivery)(
          leased.request_id,
          input.instanceId,
        ),
        shouldStop: input.shouldStop,
      });
      if (completion.stopped) return getForkRequest(leased.request_id)!;
      return getForkRequest(leased.request_id)!;
    } catch (error) {
      const message = String(error);
      if (message.includes("already bound to a different session")) {
        parkForkRequestBinding(leased.request_id, input.instanceId, message);
        return getForkRequest(leased.request_id)!;
      }
      releaseForkRequestBinding(leased.request_id, input.instanceId, message);
      if (input.shouldStop?.()) return getForkRequest(leased.request_id)!;
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }
  return getForkRequest(input.request.request_id)!;
}

export async function executeForkRequest(input: {
  requestId: string;
  client: any;
  instanceId: string;
  shouldStop?: () => boolean;
  completeDelivery?: typeof completeForkRequestDelivery;
}): Promise<ForkRequestRow> {
  let request = getForkRequest(input.requestId);
  if (!request) throw new Error(`Unknown fork request ${input.requestId}.`);
  if (request.status === "claimed") request = await createProviderFork(request, input.instanceId);
  if (request.status === "forked") {
    request = await deliverForkAnchor({ ...input, request });
  }
  if (request.status === "binding") {
    request = await bindForkAnchor({ ...input, request });
  }
  return request;
}

export async function reconcileForkRequests(input: {
  client: any;
  instanceId: string;
  isOwnerAlive: (identity: { pid: number; bootId: string; startTicks: string }) => boolean;
  shouldStop?: () => boolean;
}) {
  const counts = { delivered: 0, pending: 0, ambiguous: 0, error: 0 };
  for (let request of listRecoverableForkRequests()) {
    if (input.shouldStop?.()) break;
    try {
      if (request.status === "forking") {
        if (ownerIsAlive(request, input.isOwnerAlive)) {
          counts.pending += 1;
          continue;
        }
        if (request.provider_id === "codex") {
          request = await recoverCodexProviderResult(request);
        } else {
          markForkRequestRecoveryAmbiguous(
            request.request_id,
            "Claude Code fork ownership ended before the child session id was persisted.",
          );
          request = getForkRequest(request.request_id)!;
        }
      } else if (request.status === "delivering") {
        if (ownerIsAlive(request, input.isOwnerAlive)) {
          counts.pending += 1;
          continue;
        }
        recoverForkRequestDelivery(request.request_id);
        request = getForkRequest(request.request_id)!;
      } else if (request.status === "binding") {
        if (ownerIsAlive(request, input.isOwnerAlive)) {
          counts.pending += 1;
          continue;
        }
        if (request.owner_instance_id) recoverForkRequestBinding(request.request_id);
        request = getForkRequest(request.request_id)!;
      } else if (request.status === "ambiguous" && request.provider_id === "codex") {
        request = await recoverCodexProviderResult(request);
      }

      request = await executeForkRequest({
        requestId: request.request_id,
        client: input.client,
        instanceId: input.instanceId,
        shouldStop: input.shouldStop,
      });
      if (request.status === "delivered") counts.delivered += 1;
      else if (request.status === "ambiguous") counts.ambiguous += 1;
      else if (["error", "parked"].includes(request.status)) counts.error += 1;
      else counts.pending += 1;
    } catch (error) {
      counts.pending += 1;
      log("error", "fork_request_recovery_failed", {
        request_id: request.request_id,
        ...errorFields(error),
      });
    }
  }
  return counts;
}

export function forkRequestResultMessage(request: ForkRequestRow): string {
  if (request.status === "delivered" && request.slack_message_ts) {
    const anchorUrl = slackMessageSourceUrl(request.slack_channel_id, request.slack_message_ts);
    return `Fork created: <${anchorUrl}|open the new thread>.`;
  }
  if (
    request.status === "forking"
    || request.status === "claimed"
    || request.status === "forked"
    || request.status === "delivering"
    || request.status === "binding"
  ) {
    return "fork request is still in progress";
  }
  if (request.status === "ambiguous") {
    return `fork outcome is ambiguous and no second fork was started: ${request.error || "provider result could not be confirmed"}`;
  }
  return `fork failed: ${request.error || request.status}`;
}

export async function waitForForkBinding(input: {
  channelId: string;
  threadTs: string;
  shouldStop?: () => boolean;
  timeoutMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const wait = input.wait || sleep;
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (getForkIngressBarrier(input.channelId, input.threadTs)) {
    if (input.shouldStop?.()) throw new Error("Concierge stopped while the fork thread was being initialized.");
    if (Date.now() >= deadline) {
      throw new Error("The fork thread is still being initialized. Please resend this message in a moment.");
    }
    await wait(50);
  }
}
