import { App, LogLevel } from "@slack/bolt";
import toml from "@iarna/toml";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  addDir,
  appendInbox,
  appendTodo,
  attachMigratedProjectChannel,
  ensureChannelProject,
  newProject,
  removeDir,
  slugifySlackChannelName,
} from "./channel";
import { errorFields, log } from "./log";
import { configuredSkillRoutes, loadSkillPrompt, selectSkillRoute } from "./skill-routes";
import {
  normalizeProviderAliasKey,
  providerAliasFromText,
  resolveProviderAlias,
  selectProviderForTurn,
  stripProviderAliases,
} from "./aliases";
import { providers } from "./providers";
import { findCodexTurnIdsByReplayText } from "./codex";
import {
  associateLegacyTurnsWithSlackThread,
  attachComparisonThread,
  attachComparisonTurn,
  beginInlineCapture,
  claimSlackUserInput,
  claimInlineCaptureConfirmation,
  claimSlackInputRecoveryNotice,
  claimSteeringFailureNotice,
  claimComparisonRequest,
  claimForkRequest,
  clearAbandonedDrain,
  ChannelMode,
  classifySlackUserInput,
  createOrGetSession,
  createTurnSteeringMessage,
  deliveredChunkIndexes,
  finishTurn,
  finishInlineCapture,
  finalizeTurnSteeringMessageAmbiguity,
  finishComparisonRequest,
  finishComparisonFromTurnOutcome,
  getSlackThreadStatus,
  heartbeatProcessInstance,
  getSlackInputRecoveryNotice,
  getInlineCaptureConfirmation,
  getSlackUserInputClaim,
  getSteeringFailureNotice,
  listOrphanedSlackInputClaims,
  listPendingInlineCaptureConfirmations,
  listPendingSlackThreadStatusProjections,
  listPendingTurnStatusProjections,
  listPendingTurnReactionCleanups,
  listPendingSlackInputRecoveryNotices,
  listPendingSteeringFailureNotices,
  markSlackInputRecoveryNoticeDelivered,
  markSlackInputRecoveryNoticeRetry,
  markInlineCaptureConfirmationDelivered,
  markInlineCaptureConfirmationRetry,
  markInlineCaptureListDone,
  markInlineCaptureListSkipped,
  markInlineCaptureVaultDone,
  markSteeringFailureNoticeDelivered,
  markSteeringFailureNoticeFailed,
  markTurnDeliveryFailed,
  markTurnSteeringMessageFailed,
  markTurnSteeringMessageAmbiguous,
  markTurnSteeringMessageSending,
  markTurnSteeringMessageSent,
  failPendingSlackUserInput,
  markDeliveryChunkDelivered,
  markSlackThreadStatusProjectionDelivered,
  markSlackThreadStatusProjectionRetry,
  parkSlackThreadStatusProjection,
  parkInlineCaptureConfirmation,
  parkSlackInputRecoveryNotice,
  parkSteeringFailureNotice,
  registerProcessInstance,
  recordDeliveryAttempt,
  reconcileComparisonRequests,
  recoverDeferredSteeringFailureNotices,
  recoverInlineCaptureConfirmationClaims,
  recoverSlackThreadStatusProjectionClaims,
  recoverSlackInputRecoveryNoticeClaims,
  recoverSteeringFailureNoticeClaims,
  recoverUnsettledSteeringMessages,
  releaseOrphanedSlackInputClaims,
  replaceMissingSlackThreadStatusMessage,
  stopProcessInstance,
  getSlackChannels,
  getChannel,
  getProviderTurnBoundaryForSlackMessage,
  getSessionById,
  getSessionByUuid,
  getSessionForThread,
  getSteeringMessageForSlackMessage,
  listSessionUserPrompts,
  parseAdditionalPaths,
  ProviderId,
  type SteeringFailureNoticeRow,
  type InlineCaptureConfirmationRow,
  type SlackInputRecoveryNoticeRow,
  acquireSessionTurn,
  resolveForkParentSession,
  resolveComparisonSourceSession,
  requestSlackThreadStatusProjection,
  claimSlackThreadStatusProjection,
  claimTurnStatusProjection,
  getTurnStatusProjection,
  requestTurnStatusProjection,
  reserveSessionForThread,
  recordTurnStatusMessage,
  recordTurnProviderTurnId,
  replaceMissingTurnStatusMessage,
  markTurnStatusProjectionDelivered,
  markTurnStatusProjectionRetry,
  parkTurnStatusProjection,
  recoverTurnStatusProjectionClaims,
  recoverTurnReactionCleanupClaims,
  recordSlackThreadStatusMessage,
  setSessionStatus,
  updateChannelMode,
  updateChannelProvider,
  updateTurnSteeringReplayText,
  upsertSession,
  turnHasAcceptedSteering,
} from "./state";
import {
  executeForkRequest,
  forkRequestResultMessage,
  reconcileForkRequests,
  waitForForkBinding,
} from "./fork-requests";
import { currentProcessIdentity, isProcessIdentityAlive } from "./runtime-identity";
import { slackCall } from "./rate-limit";
import { postLongReply } from "./slack-post";
import { formatDuration } from "./text";
import { runSlackThreadStatusProjection } from "./thread-status";
import { postThreadStatusThroughAnchor, turnStatusClientMessageId } from "./turn-status-projection";
import { scheduleTurnReactionCleanup } from "./turn-reaction-cleanup";
import { agentsFingerprint, syncAgentsCanvas, syncAllAgentsCanvases } from "./canvas";
import { type SlackMessageFile } from "./attachments";
import { slackPermalinkPrompt } from "./slack-links";
import { executeAgentTurn } from "./turn-execution";
import { reconcileRecoverableTurns } from "./turn-recovery";
import { TurnListEffects } from "./turn-list-effects";
import {
  appendListItem,
  completeListItem,
  ensureChannelList,
  refreshListMirror,
} from "./lists";
import { isPaidPlanListError, isTransientSlackError, slackErrorCode } from "./slack-errors";
import { startupCutoverDecision } from "./project-cutover-state";
import {
  effectiveSessionModeForMessage,
  persistentSessionThreadTs,
  resolveMessageRouting,
} from "./routing";
import { runDeliveryWorker } from "./delivery-worker";
import {
  createKeyedTaskScheduler,
  isTransientDatabaseError,
  retryTransientDatabaseOperation,
  runDurableNoticeWorker,
} from "./durable-notice-worker";
import {
  buildComparisonAnchorMessage,
  buildComparisonModal,
  buildUserOnlyComparisonPrompt,
  COMPARISON_SHORTCUT_ID,
  COMPARISON_VIEW_ID,
  comparisonClientMessageId,
  comparisonAnchorSourceText,
  comparisonTargetLabel,
  openComparisonModal,
  parseComparisonRequest,
  replayableComparisonPrompts,
  turnInputPolicy,
} from "./comparison";
import { steeringTargetKey, TurnSteeringController } from "./steering";
import { CaptureDeliveryWorker, loadCaptureQueueToken } from "./capture-delivery-worker";

const cfg: any = toml.parse(readFileSync(`${homedir()}/.config/concierge/slack.toml`, "utf-8"));
const claudeCodeBotUserId = cfg.claude_code_bot_user_id || process.env.CLAUDE_CODE_BOT_USER_ID || null;

const app = new App({
  token: cfg.bot_token,
  appToken: cfg.app_token,
  signingSecret: cfg.signing_secret,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});

let myBotUserId: string | null = null;
let myBotId: string | null = null;
let startedAt = Date.now();
const instanceId = randomUUID();
const processIdentity = currentProcessIdentity();
let draining = false;
let activeTurnCount = 0;
let activeInputHandlerCount = 0;
let resolveDrained: (() => void) | null = null;
let captureDeliveryWorker: CaptureDeliveryWorker | null = null;
const activeSteeringTargets = new Map<string, {
  turnId: number;
  controller: TurnSteeringController;
}>();
const runKeyedDurableTask = createKeyedTaskScheduler((key, error) => {
  log("error", "durable_notice_worker_failed", { key, ...errorFields(error) });
});
const activeThreadStatusProjectionTasks = new Map<
  string,
  Promise<"delivered" | "stopped" | "permanent_failure">
>();
const activeTurnStatusProjectionTasks = new Map<
  number,
  Promise<"delivered" | "stopped" | "permanent_failure">
>();

function resolveDrainIfIdle() {
  if (activeTurnCount !== 0 || activeInputHandlerCount !== 0 || !resolveDrained) return;
  resolveDrained();
  resolveDrained = null;
}

const projectCutoverStartup = startupCutoverDecision(process.env.CONCIERGE_STATE_DIR!);
if (!projectCutoverStartup.allowStartup) {
  throw new Error("Project scaffold cutover is incomplete; provider admission remains closed");
}
if (!projectCutoverStartup.preserveDrain) clearAbandonedDrain(isProcessIdentityAlive);
registerProcessInstance(instanceId, processIdentity.pid, processIdentity.bootId, processIdentity.startTicks);
let heartbeatInFlight: Promise<void> | null = null;
function scheduleProcessHeartbeat() {
  if (heartbeatInFlight || draining) return;
  const heartbeat = retryTransientDatabaseOperation({
    operation: () => heartbeatProcessInstance(instanceId),
    shouldStop: () => draining,
  })
    .then(() => {})
    .catch((error) => {
      log("error", "process_heartbeat_failed", { instance_id: instanceId, ...errorFields(error) });
    })
    .finally(() => {
      if (heartbeatInFlight === heartbeat) heartbeatInFlight = null;
    });
  heartbeatInFlight = heartbeat;
}
setInterval(scheduleProcessHeartbeat, 15_000);

const skillRoutes = configuredSkillRoutes(
  cfg.substack_editor_bot_user_id || process.env.SUBSTACK_EDITOR_BOT_USER_ID,
);

async function deliverTurnOutcome(input: {
  turnId: number;
  client: any;
  channel: string;
  threadTs: string;
  text: string;
  user?: string;
}): Promise<"delivered" | "stopped" | "permanent_failure"> {
  return runDeliveryWorker({
    recordAttempt: () => recordDeliveryAttempt(input.turnId, null),
    recordFailure: (error) => {
      markTurnDeliveryFailed(input.turnId, String(error));
      log("warn", "turn_delivery_retry_scheduled", { turn_id: input.turnId, ...errorFields(error) });
    },
    shouldStop: () => draining,
    isRetryable: isTransientSlackError,
    wait: async (milliseconds) => {
      const deadline = Date.now() + milliseconds;
      while (!draining && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      }
    },
    attempt: async () => {
      await postLongReply({
        client: input.client,
        channel: input.channel,
        threadTs: input.threadTs,
        text: input.text,
        user: input.user,
        idempotencyKey: `turn:${input.turnId}:outcome`,
        skipChunkIndexes: deliveredChunkIndexes(input.turnId),
        onChunkPosted: (index, ts) => markDeliveryChunkDelivered(input.turnId, index, ts),
      });
    },
  });
}

async function hydrateLegacySlackThreadOwnership(input: {
  client: any;
  channel: string;
  threadTs: string;
  user?: string;
}) {
  const messageTimestamps: string[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await slackCall(input.client, "conversations.replies", {
      channel: input.channel,
      ts: input.threadTs,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    }, { channel: input.channel, user: input.user });
    messageTimestamps.push(
      ...(page.messages || []).map((message: any) => String(message.ts || "")).filter(Boolean),
    );
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && messageTimestamps.length < 1_000);
  return associateLegacyTurnsWithSlackThread(input.channel, input.threadTs, messageTimestamps);
}

function commandChannelName(command: any) {
  return String(command.channel_name || command.channel_id || "").trim().replace(/^#/, "");
}

function selectSkill(text: string) {
  return selectSkillRoute(skillRoutes, text);
}

function skillPrompt(skill: ReturnType<typeof selectSkill>) {
  return loadSkillPrompt(skill);
}

function stripBotMentions(text: string) {
  return stripProviderAliases(
    text.replace(/<@[A-Z0-9]+>\s*/g, "").replace(/@substack-editor/gi, ""),
  );
}

function unavailableForkSourceMessage(channelId: string, messageTs: string, fallback: string) {
  const steeringMessage = getSteeringMessageForSlackMessage(channelId, messageTs);
  if (steeringMessage?.status === "queued") {
    return "This steering message has not reached the agent yet, so it cannot be used as a fork point.";
  }
  if (steeringMessage?.status === "failed") {
    return "This steering message did not reach the agent, so it cannot be used as a fork point.";
  }
  if (steeringMessage?.status === "ambiguous") {
    return "Concierge could not prove whether this steering message reached the agent, so it cannot be used as a fork point.";
  }
  return fallback;
}

async function resolveExactForkTurnId(input: {
  parent: { provider_id: ProviderId; agent_session_uuid: string };
  boundary: {
    turnId: number;
    providerTurnId: string | null;
    replayText: string | null;
    sourceKind: "user" | "outcome";
  } | null;
  cwd: string;
  requireBoundary: boolean;
}): Promise<string | null> {
  if (!input.boundary) {
    if (input.requireBoundary) {
      throw new Error(
        "The selected Slack message does not own a provider turn boundary. Use Fork from here on an agent request or completed agent response.",
      );
    }
    return null;
  }
  if (input.parent.provider_id !== "codex") {
    throw new Error(
      "Claude Code does not expose a point-in-time fork boundary. Use /fork without a message timestamp to fork its latest complete session.",
    );
  }
  if (input.boundary.sourceKind === "user" && turnHasAcceptedSteering(input.boundary.turnId)) {
    throw new Error(
      "This request received accepted steering before its agent turn completed, so Codex has no exact boundary at the original message. Fork from the completed agent response instead.",
    );
  }
  if (input.boundary.providerTurnId) return input.boundary.providerTurnId;
  if (!input.boundary.replayText) {
    throw new Error(
      "This legacy turn has no canonical provider input, so Concierge cannot prove an exact fork point.",
    );
  }
  const matches = await findCodexTurnIdsByReplayText({
    sessionUUID: input.parent.agent_session_uuid,
    replayText: input.boundary.replayText,
    cwd: input.cwd,
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? "This legacy Codex turn could not be matched to an exact provider boundary. Use /fork without a message timestamp to clone the latest complete session."
      : "This legacy Codex input matches multiple provider turns, so Concierge cannot choose a safe fork boundary.");
  }
  recordTurnProviderTurnId(input.boundary.turnId, matches[0]);
  return matches[0];
}

function steeringFailureNoticeText(message: Pick<SteeringFailureNoticeRow, "status" | "error">) {
  if (message.error?.includes("attachments")) {
    return "Attachments cannot steer an active turn yet. Send the file as a new top-level agent request.";
  }
  return message.status === "ambiguous"
    ? "Concierge could not confirm whether that steering message reached the agent. It will not be used for replay or comparison; please restate it in your next message."
    : "That steering message was not applied to the agent turn. Please send it again as a new message.";
}

function deterministicSlackClientMessageId(key: string) {
  const hex = createHash("sha256")
    .update(key)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function waitForNoticeRetry(milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  while (!draining && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
  }
}

async function persistThreadStatusState<T>(operation: () => T): Promise<T> {
  const result = await retryTransientDatabaseOperation({
    operation,
  });
  if (result.stopped) throw new Error("Status projection persistence stopped.");
  return result.value;
}

async function scheduleSlackThreadStatusProjection(
  client: any,
  channel: string,
  threadTs: string,
  user?: string | null,
): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const key = `${channel}:${threadTs}`;
  const existing = activeThreadStatusProjectionTasks.get(key);
  if (existing) {
    await existing;
    const latest = getSlackThreadStatus(channel, threadTs);
    if (!draining && latest?.projection_status === "pending") {
      return scheduleSlackThreadStatusProjection(client, channel, threadTs, user);
    }
    if (latest?.projection_status === "delivered") return "delivered";
    if (latest?.projection_status === "parked") return "permanent_failure";
    return "stopped";
  }

  const task = runSlackThreadStatusProjection({
    load: () => persistThreadStatusState(() => getSlackThreadStatus(channel, threadTs)),
    claim: (nowMs) => persistThreadStatusState(
      () => claimSlackThreadStatusProjection(channel, threadTs, nowMs),
    ),
    update: async (row) => {
      await slackCall(client, "chat.update", {
        channel,
        ts: row.slack_status_msg_ts,
        text: row.desired_text || "Status unavailable.",
      }, { channel, user: user || undefined });
    },
    post: (row, clientMessageId) => postThreadStatusThroughAnchor({
      anchorTurnId: row.anchor_turn_id,
      projectAnchorTurn: (turnId) => scheduleSlackTurnStatusProjection(client, turnId, user),
      loadStatusMessageTs: () => getSlackThreadStatus(channel, threadTs)?.slack_status_msg_ts || "",
      updateAnchoredMessage: async (messageTs) => {
        await slackCall(client, "chat.update", {
          channel,
          ts: messageTs,
          text: row.desired_text || "Status unavailable.",
        }, { channel, user: user || undefined });
      },
      postNewMessage: () => slackCall(client, "chat.postMessage", {
        channel,
        thread_ts: row.slack_thread_ts,
        text: row.desired_text || "Status unavailable.",
        client_msg_id: clientMessageId,
      }, { channel, user: user || undefined }),
    }),
    recordMessage: (row, messageTs) => persistThreadStatusState(() => {
      recordSlackThreadStatusMessage(channel, threadTs, row.message_generation, messageTs);
    }),
    replaceMissingMessage: (row) => persistThreadStatusState(() => {
      replaceMissingSlackThreadStatusMessage(
        channel,
        threadTs,
        row.message_generation,
        row.slack_status_msg_ts,
      );
    }),
    markDelivered: (row) => persistThreadStatusState(() => {
      markSlackThreadStatusProjectionDelivered(channel, threadTs, row.desired_revision);
    }),
    markRetry: (row, error, nextAttemptMs) => persistThreadStatusState(() => {
      markSlackThreadStatusProjectionRetry(channel, threadTs, row.desired_revision, error, nextAttemptMs);
    }),
    markParked: (row, error) => persistThreadStatusState(() => {
      parkSlackThreadStatusProjection(channel, threadTs, row.desired_revision, error);
    }),
    isMissingUpdateError: (error) => ["message_not_found", "cant_update_message"]
      .includes(slackErrorCode(error)),
    isMissingDuplicateError: (error) => slackErrorCode(error) === "duplicate_message_not_found",
    isRetryable: isTransientSlackError,
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
  }).finally(() => {
    if (activeThreadStatusProjectionTasks.get(key) === task) {
      activeThreadStatusProjectionTasks.delete(key);
    }
  });
  activeThreadStatusProjectionTasks.set(key, task);
  const outcome = await task;
  const latest = getSlackThreadStatus(channel, threadTs);
  if (!draining && latest?.projection_status === "pending") {
    return scheduleSlackThreadStatusProjection(client, channel, threadTs, user);
  }
  return outcome;
}

async function scheduleSlackTurnStatusProjection(
  client: any,
  turnId: number,
  user?: string | null,
): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const existing = activeTurnStatusProjectionTasks.get(turnId);
  if (existing) {
    await existing;
    const latest = getTurnStatusProjection(turnId);
    if (!draining && latest?.projection_status === "pending") {
      return scheduleSlackTurnStatusProjection(client, turnId, user);
    }
    if (latest?.projection_status === "delivered") return "delivered";
    if (latest?.projection_status === "parked") return "permanent_failure";
    return "stopped";
  }

  const initial = getTurnStatusProjection(turnId);
  if (!initial) return "permanent_failure";
  const task = runSlackThreadStatusProjection({
    load: () => persistThreadStatusState(() => getTurnStatusProjection(turnId)),
    claim: (nowMs) => persistThreadStatusState(() => claimTurnStatusProjection(turnId, nowMs)),
    update: async (row) => {
      await slackCall(client, "chat.update", {
        channel: row.slack_channel_id,
        ts: row.slack_status_msg_ts,
        text: row.desired_text || "Status unavailable.",
      }, { channel: row.slack_channel_id, user: user || undefined });
    },
    post: async (row, clientMessageId) => slackCall(client, "chat.postMessage", {
      channel: row.slack_channel_id,
      thread_ts: row.slack_thread_ts,
      text: row.desired_text || "Status unavailable.",
      client_msg_id: clientMessageId,
    }, { channel: row.slack_channel_id, user: user || undefined }),
    recordMessage: (row, messageTs) => persistThreadStatusState(() => {
      recordTurnStatusMessage(turnId, row.message_generation, messageTs);
    }),
    replaceMissingMessage: (row) => persistThreadStatusState(() => {
      replaceMissingTurnStatusMessage(
        turnId,
        row.message_generation,
        row.slack_status_msg_ts,
      );
    }),
    markDelivered: (row) => persistThreadStatusState(() => {
      markTurnStatusProjectionDelivered(turnId, row.desired_revision);
    }),
    markRetry: (row, error, nextAttemptMs) => persistThreadStatusState(() => {
      markTurnStatusProjectionRetry(turnId, row.desired_revision, error, nextAttemptMs);
    }),
    markParked: (row, error) => persistThreadStatusState(() => {
      parkTurnStatusProjection(turnId, row.desired_revision, error);
    }),
    isMissingUpdateError: (error) => ["message_not_found", "cant_update_message"]
      .includes(slackErrorCode(error)),
    isMissingDuplicateError: (error) => slackErrorCode(error) === "duplicate_message_not_found",
    isRetryable: isTransientSlackError,
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
    clientMessageId: (row) => turnStatusClientMessageId(turnId, row.message_generation),
  }).finally(() => {
    if (activeTurnStatusProjectionTasks.get(turnId) === task) {
      activeTurnStatusProjectionTasks.delete(turnId);
    }
  });
  activeTurnStatusProjectionTasks.set(turnId, task);
  const outcome = await task;
  const latest = getTurnStatusProjection(turnId);
  if (!draining && latest?.projection_status === "pending") {
    return scheduleSlackTurnStatusProjection(client, turnId, user);
  }
  return outcome;
}

async function projectSlackTurnStatus(input: {
  client: any;
  turnId: number;
  text: string;
  user?: string | null;
}) {
  await persistThreadStatusState(() => requestTurnStatusProjection(input.turnId, input.text));
  return scheduleSlackTurnStatusProjection(input.client, input.turnId, input.user);
}

async function projectSlackThreadSummary(input: {
  client: any;
  channel: string;
  threadTs: string;
  turnId: number;
  text: string;
  user?: string | null;
}) {
  await persistThreadStatusState(() => requestSlackThreadStatusProjection({
    channel: input.channel,
    threadTs: input.threadTs,
    turnId: input.turnId,
    text: input.text,
  }));
  return scheduleSlackThreadStatusProjection(
    input.client,
    input.channel,
    input.threadTs,
    input.user,
  );
}

function scheduleDurableNotice(key: string, run: () => Promise<void>) {
  return runKeyedDurableTask(key, run);
}

function scheduleSteeringFailureNotice(client: any, steeringMessageId: number, user?: string | null) {
  return scheduleDurableNotice(`steering:${steeringMessageId}`, async () => {
    const outcome = await runDurableNoticeWorker({
      load: () => {
        const row = getSteeringFailureNotice(steeringMessageId);
        return row && {
          ...row,
          noticeStatus: row.notice_status,
          attempts: row.notice_attempts,
          nextAttemptMs: row.notice_next_attempt_ms,
        };
      },
      claim: (nowMs) => {
        const row = claimSteeringFailureNotice(steeringMessageId, nowMs);
        return row && {
          ...row,
          noticeStatus: row.notice_status,
          attempts: row.notice_attempts,
          nextAttemptMs: row.notice_next_attempt_ms,
        };
      },
      deliver: async (claimed) => {
        await slackCall(client, "chat.postMessage", {
          channel: claimed.slack_channel_id,
          thread_ts: claimed.slack_thread_ts,
          text: steeringFailureNoticeText(claimed),
          client_msg_id: deterministicSlackClientMessageId(
            `slack-concierge:steering-failure-notice:${claimed.id}`,
          ),
        }, { channel: claimed.slack_channel_id, user: user || undefined });
      },
      markDelivered: () => markSteeringFailureNoticeDelivered(steeringMessageId),
      markRetry: (error, nextAttemptMs) => markSteeringFailureNoticeFailed(
        steeringMessageId,
        error,
        nextAttemptMs,
      ),
      markParked: (error) => parkSteeringFailureNotice(steeringMessageId, error),
      isRetryable: isTransientSlackError,
      shouldStop: () => draining,
      wait: waitForNoticeRetry,
    });
    if (outcome !== "delivered") {
      log(outcome === "permanent_failure" ? "error" : "warn", "turn_steering_failure_notice_stopped", {
        steering_message_id: steeringMessageId,
        outcome,
      });
    }
  });
}

function scheduleSlackInputRecoveryNotice(client: any, channel: string, userMessageTs: string) {
  return scheduleDurableNotice(`input:${channel}:${userMessageTs}`, async () => {
    const normalize = (row: SlackInputRecoveryNoticeRow | null) => row && ({
      ...row,
      noticeStatus: row.recovery_notice_status,
      attempts: row.recovery_notice_attempts,
      nextAttemptMs: row.recovery_notice_next_attempt_ms,
    });
    const outcome = await runDurableNoticeWorker({
      load: () => normalize(getSlackInputRecoveryNotice(channel, userMessageTs)),
      claim: (nowMs) => normalize(claimSlackInputRecoveryNotice(channel, userMessageTs, nowMs)),
      deliver: async (claimed) => {
        await slackCall(client, "chat.postMessage", {
          channel: claimed.slack_channel_id,
          thread_ts: claimed.slack_thread_ts,
          text: claimed.kind === "draining"
            ? "Concierge is draining for a deployment. Please resend this message after it comes back online."
            : "Concierge stopped before it could safely process this message. Please resend it.",
          client_msg_id: deterministicSlackClientMessageId(
            `slack-concierge:input-recovery-notice:${claimed.slack_channel_id}:${claimed.slack_user_msg_ts}`,
          ),
        }, { channel: claimed.slack_channel_id, user: claimed.user_id || undefined });
      },
      markDelivered: () => markSlackInputRecoveryNoticeDelivered(channel, userMessageTs),
      markRetry: (error, nextAttemptMs) => markSlackInputRecoveryNoticeRetry(
        channel,
        userMessageTs,
        error,
        nextAttemptMs,
      ),
      markParked: (error) => parkSlackInputRecoveryNotice(channel, userMessageTs, error),
      isRetryable: isTransientSlackError,
      shouldStop: () => draining,
      wait: waitForNoticeRetry,
    });
    if (outcome !== "delivered") {
      log(outcome === "permanent_failure" ? "error" : "warn", "slack_input_recovery_notice_stopped", {
        channel,
        slack_user_msg_ts: userMessageTs,
        outcome,
      });
    }
  });
}

function scheduleChannelListAccessRepair(
  client: any,
  channel: NonNullable<ReturnType<typeof getChannel>>,
) {
  return scheduleDurableNotice(`list-access:${channel.slack_channel_id}`, async () => {
    let retryDelayMs = 1_000;
    while (!draining) {
      try {
        await ensureChannelList({
          client,
          channel: getChannel(channel.slack_channel_id) || channel,
          identitySecret: cfg.signing_secret,
          identityOwnerId: myBotUserId || "",
        });
        return;
      } catch (error) {
        if (!isTransientSlackError(error)) {
          log("error", "list_access_repair_failed", {
            ...errorFields(error),
            channel: channel.slack_channel_id,
            list_id: channel.list_id,
          });
          return;
        }
        log("warn", "list_access_repair_retry", {
          ...errorFields(error),
          channel: channel.slack_channel_id,
          list_id: channel.list_id,
          retry_delay_ms: retryDelayMs,
        });
        await waitForNoticeRetry(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  });
}

function scheduleInlineCaptureConfirmation(client: any, channel: string, userMessageTs: string) {
  return scheduleDurableNotice(`capture-confirmation:${channel}:${userMessageTs}`, async () => {
    const normalize = (row: InlineCaptureConfirmationRow | null) => row && ({
      ...row,
      noticeStatus: row.capture_confirmation_status,
      attempts: row.capture_confirmation_attempts,
      nextAttemptMs: row.capture_confirmation_next_attempt_ms,
    });
    const outcome = await runDurableNoticeWorker({
      load: () => normalize(getInlineCaptureConfirmation(channel, userMessageTs)),
      claim: (nowMs) => normalize(claimInlineCaptureConfirmation(channel, userMessageTs, nowMs)),
      deliver: async (claimed) => {
        const capturedTodo = /^[!/](?:todo)\s+/i.test(claimed.user_text || "");
        await slackCall(client, "chat.postMessage", {
          channel: claimed.slack_channel_id,
          thread_ts: claimed.slack_thread_ts,
          text: capturedTodo ? "todo captured" : "note captured",
          client_msg_id: deterministicSlackClientMessageId(
            `slack-concierge:inline-capture-confirmation:${claimed.slack_channel_id}:${claimed.slack_user_msg_ts}`,
          ),
        }, { channel: claimed.slack_channel_id, user: claimed.user_id || undefined });
      },
      markDelivered: () => markInlineCaptureConfirmationDelivered(channel, userMessageTs),
      markRetry: (error, nextAttemptMs) => markInlineCaptureConfirmationRetry(
        channel,
        userMessageTs,
        error,
        nextAttemptMs,
      ),
      markParked: (error) => parkInlineCaptureConfirmation(channel, userMessageTs, error),
      isRetryable: isTransientSlackError,
      shouldStop: () => draining,
      wait: waitForNoticeRetry,
    });
    if (outcome !== "delivered") {
      log(outcome === "permanent_failure" ? "error" : "warn", "inline_capture_confirmation_stopped", {
        channel,
        slack_user_msg_ts: userMessageTs,
        outcome,
      });
    }
  });
}

function isSqliteContention(error: unknown) {
  return /database (?:is )?(?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i.test(String(error));
}

async function persistSteeringTransition(label: string, callback: () => void) {
  let delayMs = 50;
  while (true) {
    try {
      callback();
      return;
    } catch (error) {
      if (!isSqliteContention(error)) throw error;
      log("warn", "turn_steering_persistence_retry", { label, delay_ms: delayMs, ...errorFields(error) });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 1_000);
    }
  }
}

function runHostCommand(input: { command: string; cwd: string; timeoutMs: number }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const proc = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, input.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

async function ensureChannelFromCommand(command: any) {
  const existing = getChannel(command.channel_id);
  if (existing) return existing;
  return ensureChannelProject(command.channel_id, commandChannelName(command));
}

app.command("/concierge-status", async ({ ack, respond }) => {
  await ack();
  await respond({
    text: `pong - concierge alive at ${new Date().toISOString()} - uptime ${formatDuration(Date.now() - startedAt)}`,
    response_type: "ephemeral",
  });
});

async function createProjectFromSlash(input: { respond: any; command: any; client: any }) {
  const { respond, command, client } = input;
  const name = command.text.trim();
  if (!name) {
    await respond({ text: "usage: /new <name>", response_type: "ephemeral" });
    return;
  }
  const slug = slugifySlackChannelName(name);
  if (slug !== name) {
    log("info", "new_channel_name_slugified", {
      requested_name: name,
      slack_channel_name: slug,
      channel: command.channel_id,
      user: command.user_id,
    });
  }

  try {
    const created: any = await slackCall(client, "conversations.create", { name: slug, is_private: false }, {
      channel: command.channel_id,
      user: command.user_id,
    });
    const chan = created.channel!;
    try {
      await slackCall(client, "conversations.join", { channel: chan.id }, { channel: chan.id, user: command.user_id });
    } catch {}
    try {
      await slackCall(client, "conversations.invite", { channel: chan.id, users: command.user_id }, {
        channel: chan.id,
        user: command.user_id,
      });
    } catch {}

    const paths = newProject(chan.id, chan.name);
    const channelRow = getChannel(chan.id);
    if (channelRow) await ensureChannelSurfaces(client, channelRow, command.user_id, "new_channel");
    await respond({ text: `created <#${chan.id}> - vault: ${paths.vault} - code: ${paths.code}`, response_type: "ephemeral" });
    await slackCall(client, "chat.postMessage", {
      channel: chan.id,
      text: `Concierge ready. Vault: ${paths.vault}\nCode: ${paths.code}`,
    });
  } catch (err) {
    log("error", "new_command_failed", errorFields(err));
    await respond({ text: `could not create project: ${(err as Error).message}`, response_type: "ephemeral" });
  }
}

app.command("/create-channel", async ({ ack, respond, command, client }) => {
  await ack();
  await createProjectFromSlash({ respond, command, client });
});

app.command("/add-dir", async ({ ack, respond, command }) => {
  await ack();
  const path = command.text.trim();
  if (!path) return respond({ text: "usage: /add-dir <path>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const paths = addDir(channel, path);
  await respond({ text: `additional dirs: ${paths.join(", ") || "(none)"}`, response_type: "ephemeral" });
});

app.command("/remove-dir", async ({ ack, respond, command }) => {
  await ack();
  const path = command.text.trim();
  if (!path) return respond({ text: "usage: /remove-dir <path>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const paths = removeDir(channel, path);
  await respond({ text: `additional dirs: ${paths.join(", ") || "(none)"}`, response_type: "ephemeral" });
});

app.command("/mode", async ({ ack, respond, command }) => {
  await ack();
  const mode = command.text.trim() as ChannelMode;
  if (!["agent-auto", "agent-tag", "silent"].includes(mode)) {
    return respond({ text: "usage: /mode <agent-auto|agent-tag|silent>", response_type: "ephemeral" });
  }
  const channel = await ensureChannelFromCommand(command);
  updateChannelMode(channel.slack_channel_id, mode);
  await respond({ text: `mode set to ${mode}`, response_type: "ephemeral" });
});

app.command("/switch-provider", async ({ ack, respond, command }) => {
  await ack();
  const alias = normalizeProviderAliasKey(command.text);
  if (!alias) {
    return respond({ text: "usage: /switch-provider <cx|cx-fast|cx-medium|cc|cc-fast|cc-medium|cc-fable>", response_type: "ephemeral" });
  }
  const providerDefault = resolveProviderAlias(alias);
  const channel = await ensureChannelFromCommand(command);
  updateChannelProvider(channel.slack_channel_id, alias);
  await respond({
    text: `default agent set to @${alias} (${comparisonTargetLabel(providerDefault.provider, providerDefault.model)}). Existing threads keep their original provider and model.`,
    response_type: "ephemeral",
  });
});

app.command("/todo", async ({ ack, respond, command, client }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /todo <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendTodo(channel, text, `/todo by ${command.user_name || command.user_id}`);
  let listText = "";
  try {
    const itemId = await appendListItem({
      client,
      channel,
      text,
      source: "todo",
      user: command.user_id,
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    await refreshListMirror({
      client,
      channel,
      user: command.user_id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    listText = itemId ? `; Slack List row ${itemId}` : "; Slack List write skipped";
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
    listText = `; Slack List write failed: ${slackErrorCode(err)}`;
  }
  await respond({ text: `todo appended to ${file}${listText}`, response_type: "ephemeral" });
});

app.command("/note", async ({ ack, respond, command, client }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /note <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendInbox(channel, text, `/note by ${command.user_name || command.user_id}`);
  let listText = "";
  try {
    const itemId = await appendListItem({
      client,
      channel,
      text,
      source: "note",
      user: command.user_id,
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    await refreshListMirror({
      client,
      channel,
      user: command.user_id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    listText = itemId ? `; Slack List row ${itemId}` : "; Slack List write skipped";
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
    listText = `; Slack List write failed: ${slackErrorCode(err)}`;
  }
  await respond({ text: `note appended to ${file}${listText}`, response_type: "ephemeral" });
});

app.command("/auth-refresh", async ({ ack, respond, command }) => {
  await ack();
  const provider = command.text.trim() || "codex";
  if (!["codex", "claude-code"].includes(provider)) {
    return respond({ text: "usage: /auth-refresh <codex|claude-code>", response_type: "ephemeral" });
  }
  const refreshCommand =
    provider === "codex"
      ? cfg.codex_auth_refresh_command || "codex login"
      : cfg.claude_code_auth_refresh_command || "claude login";
  const cwd = homedir();
  log("info", "auth_refresh_started", { provider, command: refreshCommand, user: command.user_id });
  await respond({ text: `starting ${provider} auth refresh on this host...`, response_type: "ephemeral" });
  const result = await runHostCommand({ command: refreshCommand, cwd, timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  log(result.code === 0 ? "info" : "warn", "auth_refresh_finished", {
    provider,
    exit_code: result.code,
    timed_out: result.timedOut,
    output_chars: output.length,
  });
  const url = output.match(/https?:\/\/\S+/)?.[0];
  await respond({
    text: result.code === 0 || url
      ? [`${provider} auth refresh output:`, url || output.slice(0, 1800) || "(no output)"].join("\n")
      : `${provider} auth refresh did not complete on this host. Output:\n${output.slice(0, 1600) || "(no output)"}`,
    response_type: "ephemeral",
  });
});

app.command("/review-inbox", async ({ ack, respond, command }) => {
  await ack();
  const channel = await ensureChannelFromCommand(command);
  const cwd = channel.code_path || channel.vault_path;
  log("info", "review_command_started", { channel: command.channel_id, user: command.user_id, cwd });
  await respond({ text: `starting review in ${cwd}...`, response_type: "ephemeral" });
  const result = await runHostCommand({ command: "journalmaxx-review", cwd, timeoutMs: 120_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.code === 127 || /not found/i.test(output)) {
    log("warn", "review_pipeline_missing", { channel: command.channel_id, cwd, exit_code: result.code });
    await respond({
      text: "review pipeline not yet installed on this host, see systemd/README.md",
      response_type: "ephemeral",
    });
    return;
  }
  log(result.code === 0 ? "info" : "error", "review_command_finished", {
    channel: command.channel_id,
    cwd,
    exit_code: result.code,
    timed_out: result.timedOut,
    output_chars: output.length,
  });
  await respond({
    text: result.code === 0
      ? `review complete:\n${output.slice(0, 1800) || "(no output)"}`
      : `review failed:\n${output.slice(0, 1800) || "(no output)"}`,
    response_type: "ephemeral",
  });
});

app.command("/fork", async ({ ack, respond, command, client }) => {
  await ack();
  try {
    const channel = await ensureChannelFromCommand(command);
    const requestedTs = command.text.trim();
    const parent = resolveForkParentSession(command.channel_id, requestedTs);
    log("info", "fork_parent_resolved", {
      channel: command.channel_id,
      requested_ts: requestedTs || null,
      parent_session_id: parent?.id || null,
      parent_thread_ts: parent?.slack_thread_ts || null,
    });
    if (!parent?.agent_session_uuid) {
      await respond({
        text: unavailableForkSourceMessage(
          command.channel_id,
          requestedTs,
          "No persisted parent session found to fork in this channel.",
        ),
        response_type: "ephemeral",
      });
      return;
    }
    const boundary = requestedTs
      ? getProviderTurnBoundaryForSlackMessage(command.channel_id, requestedTs)
      : null;
    const cwd = channel.code_path || channel.vault_path;
    const lastProviderTurnId = await resolveExactForkTurnId({
      parent: {
        provider_id: parent.provider_id as ProviderId,
        agent_session_uuid: parent.agent_session_uuid,
      },
      boundary,
      cwd,
      requireBoundary: Boolean(requestedTs),
    });
    const claim = claimForkRequest({
      requestId: command.trigger_id,
      channelId: command.channel_id,
      requestedBy: command.user_id,
      sourceSessionId: parent.id,
      sourceMessageTs: requestedTs || null,
      providerId: parent.provider_id as ProviderId,
      sourceProviderSessionUUID: parent.agent_session_uuid,
      lastProviderTurnId,
      cwd,
      additionalDirs: parseAdditionalPaths(channel),
    });
    const request = await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId,
      shouldStop: () => draining,
    });
    await respond({
      text: forkRequestResultMessage(request),
      response_type: "ephemeral",
    });
  } catch (err) {
    await respond({ text: `fork failed: ${(err as Error).message}`, response_type: "ephemeral" });
  }
});

async function handleInlineCapture(input: {
  text: string;
  channel: any;
  user: string;
  client: any;
  threadTs: string;
  userMsgTs: string;
  claimToken: string;
}) {
  const todo = input.text.match(/^[!/](?:todo)\s+([\s\S]+)/i);
  const note = input.text.match(/^[!/](?:note)\s+([\s\S]+)/i);
  if (!todo && !note) return false;
  const captureKey = `${input.channel.slack_channel_id}:${input.userMsgTs}`;
  let claim = getSlackUserInputClaim(input.channel.slack_channel_id, input.userMsgTs);
  if (!claim || claim.claim_token !== input.claimToken || !claim.inline_capture) {
    throw new Error("Inline capture lost its durable input ownership.");
  }
  if (claim.kind === "capture") {
    void scheduleInlineCaptureConfirmation(input.client, input.channel.slack_channel_id, input.userMsgTs);
    return true;
  }
  if (claim.kind !== "pending") throw new Error(`Inline capture cannot continue from input kind ${claim.kind}.`);

  if (claim.capture_vault_status !== "done") {
    if (todo) appendTodo(input.channel, todo[1], `inline by ${input.user}`, captureKey, cfg.signing_secret);
    if (note) appendInbox(input.channel, note[1], `inline by ${input.user}`, captureKey, cfg.signing_secret);
    const persistedVault = await retryTransientDatabaseOperation({
      operation: () => markInlineCaptureVaultDone(
        input.channel.slack_channel_id,
        input.userMsgTs,
        input.claimToken,
      ),
    });
    if (persistedVault.stopped || !persistedVault.value) {
      throw new Error("Inline capture vault completion could not be persisted.");
    }
  }

  claim = getSlackUserInputClaim(input.channel.slack_channel_id, input.userMsgTs);
  if (claim?.capture_list_status === "pending") {
    try {
      const itemId = await appendListItem({
        client: input.client,
        channel: input.channel,
        text: todo ? todo[1] : note![1],
        source: todo ? "todo" : "note",
        user: input.user,
        sourceMessage: {
          channel: input.channel.slack_channel_id,
          ts: input.userMsgTs,
          teamId: cfg.team_id,
        },
        identitySecret: cfg.signing_secret,
        identityOwnerId: myBotUserId || "",
      });
      const persistedList = await retryTransientDatabaseOperation({
        operation: () => itemId
          ? markInlineCaptureListDone(
              input.channel.slack_channel_id,
              input.userMsgTs,
              input.claimToken,
              itemId,
            )
          : markInlineCaptureListSkipped(
              input.channel.slack_channel_id,
              input.userMsgTs,
              input.claimToken,
              "Slack Lists are unavailable or the required scope is missing.",
            ),
      });
      if (persistedList.stopped || !persistedList.value) {
        throw new Error("Inline capture List completion could not be persisted.");
      }
    } catch (error) {
      if (isTransientSlackError(error) || isTransientDatabaseError(error)) throw error;
      if (isPaidPlanListError(error)) {
        await maybeReportListFailure(input.client, input.channel, error);
      } else {
        log("error", "inline_capture_list_permanent_failure", {
          ...errorFields(error),
          channel: input.channel.slack_channel_id,
          slack_user_msg_ts: input.userMsgTs,
        });
      }
      const skippedList = await retryTransientDatabaseOperation({
        operation: () => markInlineCaptureListSkipped(
          input.channel.slack_channel_id,
          input.userMsgTs,
          input.claimToken,
          `Slack List capture was skipped: ${slackErrorCode(error)}`,
        ),
      });
      if (skippedList.stopped || !skippedList.value) {
        throw new Error("Inline capture List skip state could not be persisted.");
      }
    }
  }

  claim = getSlackUserInputClaim(input.channel.slack_channel_id, input.userMsgTs);
  if (claim?.capture_list_status === "done") {
    await refreshListMirror({
      client: input.client,
      channel: input.channel,
      user: input.user,
      onPaidPlanError: (err) => postListPaidPlanError(input.client, input.channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
  }

  const finished = await retryTransientDatabaseOperation({
    operation: () => finishInlineCapture(
      input.channel.slack_channel_id,
      input.userMsgTs,
      input.claimToken,
    ),
  });
  if (finished.stopped || !finished.value) {
    throw new Error("Inline capture sinks were not durably complete.");
  }
  void scheduleInlineCaptureConfirmation(input.client, input.channel.slack_channel_id, input.userMsgTs);
  return true;
}

function scheduleInlineCaptureRecovery(client: any, channelId: string, userMessageTs: string) {
  return scheduleDurableNotice(`capture-sinks:${channelId}:${userMessageTs}`, async () => {
    let retryDelayMs = 1_000;
    while (!draining) {
      const loaded = await retryTransientDatabaseOperation({
        operation: () => getSlackUserInputClaim(channelId, userMessageTs),
        shouldStop: () => draining,
        wait: waitForNoticeRetry,
      });
      if (loaded.stopped) return;
      const claim = loaded.value;
      if (!claim || !claim.inline_capture) return;
      if (claim.kind === "capture") {
        void scheduleInlineCaptureConfirmation(client, channelId, userMessageTs);
        return;
      }
      if (claim.kind !== "pending" || !claim.user_text || !claim.user_id) return;
      try {
        let channel = getChannel(channelId);
        if (!channel) {
          const info: any = await slackCall(client, "conversations.info", { channel: channelId }, {
            channel: channelId,
            user: claim.user_id,
          });
          channel = ensureChannelProject(channelId, info.channel?.name || channelId);
        }
        await handleInlineCapture({
          text: claim.user_text,
          channel,
          user: claim.user_id,
          client,
          threadTs: claim.reply_thread_ts || claim.slack_user_msg_ts,
          userMsgTs: claim.slack_user_msg_ts,
          claimToken: claim.claim_token,
        });
        return;
      } catch (error) {
        log("warn", "inline_capture_recovery_retry", {
          ...errorFields(error),
          channel: channelId,
          slack_user_msg_ts: userMessageTs,
          delay_ms: retryDelayMs,
        });
        await waitForNoticeRetry(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  });
}

async function syncCanvasIfAgentsChanged(
  client: any,
  channel: ReturnType<typeof getChannel>,
  user: string | null,
  before: string | null,
  reason: string,
) {
  if (!channel) return;
  const after = agentsFingerprint(channel);
  if (!after || after === before) return;
  const fresh = getChannel(channel.slack_channel_id) || channel;
  await syncAgentsCanvas({ client, channel: fresh, user, reason });
}

async function maybeReportListFailure(client: any, channel: ReturnType<typeof getChannel>, err: unknown) {
  if (!channel) return;
  if (isPaidPlanListError(err)) await postListPaidPlanError(client, channel, err);
}

async function ensureChannelSurfaces(
  client: any,
  channel: NonNullable<ReturnType<typeof getChannel>>,
  user: string | null,
  reason: string,
) {
  await syncAgentsCanvas({ client, channel, user, reason });
  try {
    await refreshListMirror({
      client,
      channel,
      user,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
}

type TurnRunOutcome =
  | { status: "delivered"; turnId: number }
  | { status: "draining" | "duplicate" | "busy" | "ignored" | "steered" | "delivery_stopped" | "delivery_parked"; turnId?: number }
  | { status: "error"; turnId?: number; error: string };

async function handleUserMessage(opts: {
  channel: string;
  channelName?: string;
  threadTs: string;
  userMsgTs: string;
  user: string;
  text: string;
  files?: SlackMessageFile[];
  client: any;
  providerOverride?: ProviderId;
  modelOverride?: string | null;
  reasoningEffortOverride?: string | null;
  forceNewSession?: boolean;
  prebuiltPrompt?: boolean;
  onTurnAcquired?: (turnId: number) => void;
}): Promise<TurnRunOutcome> {
  activeInputHandlerCount += 1;
  try {
  const inputClaimToken = randomUUID();
  const inputPolicy = turnInputPolicy(opts.prebuiltPrompt === true);
  const inlineCaptureRequested = inputPolicy.handleInlineCapture && /^[!/](?:todo|note)\s+[\s\S]+/i.test(opts.text);
  let inlineCaptureClaimed = false;
  const claimedInput = await retryTransientDatabaseOperation({
    operation: () => claimSlackUserInput(
      opts.channel,
      opts.userMsgTs,
      inputClaimToken,
      instanceId,
      {
        replyThreadTs: opts.threadTs,
        userId: opts.user,
        userText: opts.text,
        files: opts.files || [],
      },
    ),
  });
  if (claimedInput.stopped) throw new Error("Slack input ownership stopped before it became durable.");
  const inputClaim = claimedInput.value;
  if (!inputClaim.claimed) {
    const existingInputClaim = inputClaim.row;
    log("info", "duplicate_slack_input_skipped", {
      turn_id: existingInputClaim.turn_id,
      input_kind: existingInputClaim.kind,
      slack_user_msg_ts: opts.userMsgTs,
    });
    if (existingInputClaim.kind === "steering") {
      const steeringMessage = getSteeringMessageForSlackMessage(opts.channel, opts.userMsgTs);
      if (steeringMessage?.notice_status === "pending") {
        void scheduleSteeringFailureNotice(opts.client, steeringMessage.id, opts.user);
      }
    } else if (existingInputClaim.kind === "pending" && existingInputClaim.inline_capture) {
      void scheduleInlineCaptureRecovery(opts.client, opts.channel, opts.userMsgTs);
    } else if (existingInputClaim.kind === "capture" && existingInputClaim.capture_confirmation_status === "pending") {
      void scheduleInlineCaptureConfirmation(opts.client, opts.channel, opts.userMsgTs);
    } else if (existingInputClaim.recovery_notice_status === "pending") {
      void scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs);
    }
    return { status: "duplicate", turnId: existingInputClaim.turn_id || undefined };
  }

  try {
  const steeringKey = steeringTargetKey(opts.channel, opts.threadTs);
  const activeSteeringTarget = activeSteeringTargets.get(steeringKey);
  if (activeSteeringTarget) {
    const steeringFiles = opts.files || [];
    const steeringPrompt = stripBotMentions(opts.text);
    if (!steeringPrompt && steeringFiles.length === 0) {
      classifySlackUserInput(opts.channel, opts.userMsgTs, inputClaimToken, "ignored");
      return { status: "ignored" };
    }
    const steeringMessage = createTurnSteeringMessage(
      activeSteeringTarget.turnId,
      opts.userMsgTs,
      opts.text,
      steeringPrompt,
      inputClaimToken,
      opts.threadTs,
    );
    if (steeringMessage.duplicate) {
      log("info", "duplicate_steering_message_skipped", {
        turn_id: activeSteeringTarget.turnId,
        slack_user_msg_ts: opts.userMsgTs,
      });
      return { status: "duplicate", turnId: activeSteeringTarget.turnId };
    }
    if (steeringFiles.length > 0) {
      await persistSteeringTransition(
        `attachments-failed:${steeringMessage.row.id}`,
        () => markTurnSteeringMessageFailed(steeringMessage.row.id, "Steering attachments are unsupported."),
      );
      void scheduleSteeringFailureNotice(opts.client, steeringMessage.row.id, opts.user);
      return { status: "error", turnId: activeSteeringTarget.turnId, error: "Steering attachments are unsupported." };
    }

    const accepted = activeSteeringTarget.controller.enqueue({
      clientMessageId: `slack:${opts.channel}:${opts.userMsgTs}`,
      text: steeringPrompt,
      prepareText: async () => {
        const linkedThreadContext = opts.prebuiltPrompt ? "" : await slackPermalinkPrompt({
          text: opts.text,
          client: opts.client,
          user: opts.user,
        });
        const replayText = [steeringPrompt, linkedThreadContext].filter(Boolean).join("\n\n");
        updateTurnSteeringReplayText(steeringMessage.row.id, replayText);
        return replayText;
      },
      onSending: () => persistSteeringTransition(
        `sending:${steeringMessage.row.id}`,
        () => markTurnSteeringMessageSending(steeringMessage.row.id),
      ),
      onSent: async () => {
        await persistSteeringTransition(
          `sent:${steeringMessage.row.id}`,
          () => markTurnSteeringMessageSent(steeringMessage.row.id),
        );
        log("info", "turn_steering_sent", {
          turn_id: activeSteeringTarget.turnId,
          steering_message_id: steeringMessage.row.id,
          slack_user_msg_ts: opts.userMsgTs,
        });
      },
      onError: async (error) => {
        await persistSteeringTransition(
          `failed:${steeringMessage.row.id}`,
          () => markTurnSteeringMessageFailed(steeringMessage.row.id, error.message),
        );
        log("warn", "turn_steering_failed", {
          ...errorFields(error),
          turn_id: activeSteeringTarget.turnId,
          steering_message_id: steeringMessage.row.id,
          slack_user_msg_ts: opts.userMsgTs,
        });
        void scheduleSteeringFailureNotice(opts.client, steeringMessage.row.id, opts.user);
      },
      onAmbiguous: async (error) => {
        await persistSteeringTransition(
          `ambiguous:${steeringMessage.row.id}`,
          () => markTurnSteeringMessageAmbiguous(steeringMessage.row.id, error.message),
        );
        log("warn", "turn_steering_acknowledgement_ambiguous", {
          ...errorFields(error),
          turn_id: activeSteeringTarget.turnId,
          steering_message_id: steeringMessage.row.id,
          slack_user_msg_ts: opts.userMsgTs,
        });
      },
      onAmbiguousFinalized: async () => {
        let noticeReady = false;
        await persistSteeringTransition(
          `ambiguity-finalized:${steeringMessage.row.id}`,
          () => { noticeReady = finalizeTurnSteeringMessageAmbiguity(steeringMessage.row.id); },
        );
        if (noticeReady) void scheduleSteeringFailureNotice(opts.client, steeringMessage.row.id, opts.user);
      },
    });
    if (!accepted) {
      await persistSteeringTransition(
        `closed-failed:${steeringMessage.row.id}`,
        () => markTurnSteeringMessageFailed(steeringMessage.row.id, "The provider turn already ended."),
      );
      void scheduleSteeringFailureNotice(opts.client, steeringMessage.row.id, opts.user);
      return { status: "error", turnId: activeSteeringTarget.turnId, error: "Provider turn already ended." };
    }

    await slackCall(opts.client, "chat.postMessage", {
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: "↪ Steering received for the active agent turn.",
    }, { channel: opts.channel, user: opts.user });
    return { status: "steered", turnId: activeSteeringTarget.turnId };
  }

  if (draining) {
    const drainClassification = await retryTransientDatabaseOperation({
      operation: () => classifySlackUserInput(opts.channel, opts.userMsgTs, inputClaimToken, "draining"),
    });
    if (drainClassification.stopped || !drainClassification.value) {
      throw new Error("Deployment drain rejection could not be persisted.");
    }
    void scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs);
    return { status: "draining" };
  }
  if (inlineCaptureRequested) {
    const captureClaim = await retryTransientDatabaseOperation({
      operation: () => beginInlineCapture(opts.channel, opts.userMsgTs, inputClaimToken),
    });
    if (captureClaim.stopped || !captureClaim.value) {
      throw new Error("Inline capture routing could not be persisted.");
    }
    inlineCaptureClaimed = true;
    await scheduleInlineCaptureRecovery(opts.client, opts.channel, opts.userMsgTs);
    return { status: "ignored" };
  }
  let channel = getChannel(opts.channel);
  let channelName = opts.channelName;
  if (!channel && !channelName) {
    try {
      const info: any = await slackCall(opts.client, "conversations.info", { channel: opts.channel }, {
        channel: opts.channel,
        user: opts.user,
      });
      channelName = info.channel?.name;
    } catch (err) {
      log("warn", "channel_info_failed", { ...errorFields(err), channel: opts.channel });
    }
  }
  channel = channel || ensureChannelProject(opts.channel, channelName || opts.channel);
  await waitForForkBinding({
    channelId: opts.channel,
    threadTs: opts.threadTs,
    shouldStop: () => draining,
  });
  const mentionedConcierge = myBotUserId ? opts.text.includes(`<@${myBotUserId}>`) : false;
  const topLevelMessage = opts.threadTs === opts.userMsgTs;

  // A session explicitly bound to this visible thread (for example a fork or
  // comparison) takes precedence over the channel-wide persistent session.
  // Otherwise reuse the persistent anchor for context while leaving the
  // visible Slack reply destination untouched.
  const visibleThreadSession = getSessionForThread(opts.channel, opts.threadTs);
  const effectiveSessionMode = effectiveSessionModeForMessage({
    channelSessionMode: channel.session_mode,
    forceNewSession: opts.forceNewSession,
    hasVisibleThreadSession: Boolean(visibleThreadSession),
  });
  let anchorThreadTs: string | null = null;
  if (effectiveSessionMode === "single-persistent") {
    const anchorUuid = channel.default_session_uuid;
    if (anchorUuid) {
      const anchorSession = getSessionByUuid(opts.channel, anchorUuid);
      if (anchorSession) {
        anchorThreadTs = anchorSession.slack_thread_ts;
        const routing = resolveMessageRouting({
          replyThreadTs: opts.threadTs,
          sessionMode: channel.session_mode,
          anchorThreadTs,
        });
        log("info", "single_persistent_session_reused", {
          channel: opts.channel,
          session_thread_ts: routing.sessionThreadTs,
          reply_thread_ts: routing.replyThreadTs,
          anchor_uuid: anchorUuid,
        });
      }
    } else {
      anchorThreadTs = persistentSessionThreadTs(opts.channel);
      log("info", "single_persistent_session_reserved", {
        channel: opts.channel,
        session_thread_ts: anchorThreadTs,
        reply_thread_ts: opts.threadTs,
      });
    }
  }
  const { sessionThreadTs } = resolveMessageRouting({
    replyThreadTs: opts.threadTs,
    sessionMode: effectiveSessionMode,
    anchorThreadTs,
  });
  const mentionedProviderAlias = !!providerAliasFromText(opts.text, {
    topLevel: true,
    claudeCodeBotUserId,
  });
  const skill = inputPolicy.selectSkill ? selectSkill(opts.text) : undefined;
  if (!opts.providerOverride && channel.mode === "silent") {
    classifySlackUserInput(opts.channel, opts.userMsgTs, inputClaimToken, "ignored");
    return { status: "ignored" };
  }
  if (!opts.providerOverride && channel.mode === "agent-tag" && !mentionedConcierge && !mentionedProviderAlias && !skill) {
    classifySlackUserInput(opts.channel, opts.userMsgTs, inputClaimToken, "ignored");
    return { status: "ignored" };
  }

  let existingThreadSession = sessionThreadTs === opts.threadTs
    ? visibleThreadSession
    : getSessionForThread(opts.channel, sessionThreadTs);
  let turnSelection = selectProviderForTurn({
    text: opts.text,
    channelDefault: channel.provider_default,
    topLevel: topLevelMessage,
    existingProvider: existingThreadSession?.provider_id as ProviderId | undefined,
    providerOverride: opts.providerOverride,
    modelOverride: opts.modelOverride,
    reasoningEffortOverride: opts.reasoningEffortOverride,
    claudeCodeBotUserId,
  });
  let reservedSession: ReturnType<typeof reserveSessionForThread> | null = null;
  if (effectiveSessionMode === "single-persistent") {
    reservedSession = reserveSessionForThread(
      opts.channel,
      sessionThreadTs,
      turnSelection.selectedProvider,
    );
    if (!reservedSession.created) {
      existingThreadSession = reservedSession.session;
      turnSelection = selectProviderForTurn({
        text: opts.text,
        channelDefault: channel.provider_default,
        topLevel: topLevelMessage,
        existingProvider: reservedSession.session.provider_id,
        providerOverride: opts.providerOverride,
        modelOverride: opts.modelOverride,
        reasoningEffortOverride: opts.reasoningEffortOverride,
        claudeCodeBotUserId,
      });
    }
  }
  const {
    requestedSelection,
    ignoredSelection,
    selectedProvider,
    selectedModel,
    selectedReasoningEffort,
  } = turnSelection;
  const providerLabel = comparisonTargetLabel(selectedProvider, selectedModel);
  if (existingThreadSession && ignoredSelection) {
    log("info", "provider_switch_ignored_for_bound_thread", {
      channel: opts.channel,
      session_thread_ts: sessionThreadTs,
      reply_thread_ts: opts.threadTs,
      bound_provider: selectedProvider,
      requested_provider: ignoredSelection.provider,
      requested_model: ignoredSelection.model || null,
      requested_reasoning_effort: ignoredSelection.reasoning_effort || null,
    });
  }
  if (!existingThreadSession) {
    log("info", "provider_alias_resolved", {
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      alias: "alias" in requestedSelection ? requestedSelection.alias : null,
      source: requestedSelection.source,
      provider: selectedProvider,
      model: selectedModel || null,
      reasoning_effort: selectedReasoningEffort || null,
    });
  }
  const provider = providers[selectedProvider];
  const incomingFiles = opts.files || [];
  let prompt = inputPolicy.stripMentions ? stripBotMentions(opts.text) : opts.text;
  if (!prompt && incomingFiles.length > 0) prompt = "Please respond to the attached content.";
  if (!prompt) {
    classifySlackUserInput(opts.channel, opts.userMsgTs, inputClaimToken, "ignored");
    return { status: "ignored" };
  }

  const session = reservedSession?.session || createOrGetSession(opts.channel, sessionThreadTs, selectedProvider);
  const turn = acquireSessionTurn(
    session.id,
    opts.userMsgTs,
    opts.text,
    instanceId,
    inputClaimToken,
    opts.threadTs,
  );
  if ("draining" in turn && turn.draining) {
    void scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs);
    return { status: "draining", turnId: turn.id };
  }
  if (turn.duplicate) {
    log("info", "duplicate_turn_skipped", { session_id: session.id, slack_user_msg_ts: opts.userMsgTs });
    return { status: "duplicate", turnId: turn.id };
  }
  if (turn.busy) {
    log("warn", "session_turn_busy_rejected", {
      session_id: session.id,
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      provider: selectedProvider,
      model: selectedModel || null,
    });
    await slackCall(opts.client, "chat.postMessage", {
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: "Concierge is already running a turn for this thread. Send this again after the current turn finishes.",
    }, { channel: opts.channel, user: opts.user });
    return { status: "busy", turnId: turn.id };
  }
  try {
    opts.onTurnAcquired?.(turn.id);
  } catch (error) {
    finishTurn(turn.id, "error", String(error));
    setSessionStatus(session.id, "error");
    return { status: "error", turnId: turn.id, error: String(error) };
  }
  log("info", "session_turn_lock_acquired", {
    session_id: session.id,
    channel: opts.channel,
    thread_ts: opts.threadTs,
    slack_user_msg_ts: opts.userMsgTs,
    provider: selectedProvider,
    model: selectedModel || null,
  });
  activeTurnCount += 1;
  const steeringController = new TurnSteeringController();
  const steeringTarget = { turnId: turn.id, controller: steeringController };
  activeSteeringTargets.set(steeringKey, steeringTarget);
  let steeringClosed = false;
  const closeSteering = (reason?: Error) => {
    if (steeringClosed) return;
    steeringClosed = true;
    if (activeSteeringTargets.get(steeringKey) === steeringTarget) activeSteeringTargets.delete(steeringKey);
    steeringController.close(reason);
  };
  const turnListEffects = new TurnListEffects({
    signingSecret: cfg.signing_secret,
    botUserId: myBotUserId || "",
    reportFailure: maybeReportListFailure,
    reportPaidPlanError: postListPaidPlanError,
  });

  try {
    return await executeAgentTurn({
      turnId: turn.id,
      session,
      channel,
      channelId: opts.channel,
      threadTs: opts.threadTs,
      userMsgTs: opts.userMsgTs,
      user: opts.user,
      text: opts.text,
      prompt,
      files: incomingFiles,
      client: opts.client,
      provider,
      providerId: selectedProvider,
      providerLabel,
      model: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      sessionThreadTs,
      sessionMode: effectiveSessionMode,
      hydrateSlackLinks: inputPolicy.hydrateSlackLinks,
      baseSystemPrompt: skillPrompt(skill),
      cwd: channel.code_path || channel.vault_path,
      additionalDirs: parseAdditionalPaths(channel),
      botToken: cfg.bot_token,
      ownerInstanceId: instanceId,
      steeringController,
      closeSteering,
      services: {
        hydrateLegacyThreadOwnership: hydrateLegacySlackThreadOwnership,
        deliverOutcome: deliverTurnOutcome,
        projectTurnStatus: projectSlackTurnStatus,
        projectThreadSummary: projectSlackThreadSummary,
        scheduleWorkingReactionCleanup: (client, turnId) => scheduleTurnReactionCleanup(
          client,
          turnId,
          { shouldStop: () => draining, wait: waitForNoticeRetry },
        ),
        loadListContext: (client, projectChannel, user) => turnListEffects.loadContext(
          client,
          projectChannel,
          user,
        ),
        applyListOperations: (listInput) => turnListEffects.apply(listInput),
        syncCanvasIfChanged: syncCanvasIfAgentsChanged,
      },
    });
  } finally {
    activeTurnCount -= 1;
    resolveDrainIfIdle();
  }
  } finally {
    if (inlineCaptureClaimed) {
      void scheduleInlineCaptureRecovery(opts.client, opts.channel, opts.userMsgTs);
    } else {
      const failedPendingInputResult = await retryTransientDatabaseOperation({
        operation: () => failPendingSlackUserInput(
          opts.channel,
          opts.userMsgTs,
          inputClaimToken,
          "Concierge stopped before this message was durably classified.",
        ),
      });
      const failedPendingInput = !failedPendingInputResult.stopped && failedPendingInputResult.value;
      if (failedPendingInput) {
        void scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs);
      }
    }
  }
  } finally {
    activeInputHandlerCount -= 1;
    resolveDrainIfIdle();
  }
}

// Subtypes that are still real user content and must trigger a turn.
// `undefined` = plain text; thread_broadcast = reply-and-send-to-channel;
// file_share = user attached files (screenshots, PDFs, etc.).
// Everything else (channel_join, message_changed, bot_message, …) is skipped.
const ROUTABLE_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

app.message(async ({ message, client }) => {
  const m = message as any;
  if (!ROUTABLE_SUBTYPES.has(m.subtype)) return;
  if (myBotUserId && m.user === myBotUserId) return;
  if (myBotId && m.bot_id === myBotId) return;
  await handleUserMessage({
    channel: m.channel,
    channelName: m.channel_name,
    threadTs: m.thread_ts || m.ts,
    userMsgTs: m.ts,
    user: m.user,
    text: m.text || "",
    files: Array.isArray(m.files) ? m.files : [],
    client,
  });
});

app.event("app_mention", async () => {});

app.event("channel_created", async ({ event, client }) => {
  const channel = (event as any).channel;
  if (!channel?.id || !channel?.name) return;
  let joined = true;
  let joinErrorMsg: string | null = null;
  try {
    await slackCall(client, "conversations.join", { channel: channel.id });
  } catch (err) {
    joined = false;
    joinErrorMsg = (err as any)?.data?.error || (err as Error).message;
    log("warn", "channel_join_failed", { ...errorFields(err), channel: channel.id });
  }
  const migrated = attachMigratedProjectChannel(channel.id, channel.name);
  if (migrated.status === "missing") {
    newProject(channel.id, channel.name);
  } else if (migrated.status === "claimed") {
    log("warn", "channel_created_code_path_already_claimed", {
      channel: channel.id,
      name: channel.name,
      code_path: migrated.paths.code,
      existing_channel: migrated.channel?.slack_channel_id || null,
    });
    return;
  } else {
    log("info", "channel_created_migrated_project_attached", {
      channel: channel.id,
      name: channel.name,
      code_path: migrated.paths.code,
    });
  }
  const channelRow = getChannel(channel.id);
  if (channelRow && joined) await ensureChannelSurfaces(client, channelRow, null, "channel_created");
  log("info", "channel_created_project_ready", { channel: channel.id, name: channel.name, joined });
  // If we could not auto-join, tell the user in-channel via chat:write.public.
  // Without this, the channel appears dead to a user who created it via the Slack UI.
  if (!joined) {
    try {
      await slackCall(client, "chat.postMessage", {
        channel: channel.id,
        text: `⚠️ Concierge auto-scaffolded this project but couldn't join the channel (\`${joinErrorMsg || "unknown"}\`). Two ways to fix:\n1. Type \`/invite @Concierge\` in this channel (one-time).\n2. Reinstall the app manifest in admin to grant the \`channels:join\` scope; future channels will auto-join.\n\nUntil then, this channel won't receive agent responses.`,
      });
    } catch (postErr) {
      log("warn", "channel_join_failure_notice_failed", { ...errorFields(postErr), channel: channel.id });
    }
  }
});

app.shortcut("send_to_inbox", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const file = appendInbox(channel, s.message.text || "", `shortcut by ${s.user.id}`);
  try {
    await appendListItem({
      client,
      channel,
      text: s.message.text || "",
      source: "note",
      user: s.user.id,
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    await refreshListMirror({
      client,
      channel,
      user: s.user.id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
  await slackCall(client, "chat.postEphemeral", {
    channel: s.channel.id,
    user: s.user.id,
    text: `sent to inbox: ${file}`,
  });
});

app.shortcut("turn_into_todo", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const file = appendTodo(channel, s.message.text || "", `shortcut by ${s.user.id}`);
  try {
    await appendListItem({
      client,
      channel,
      text: s.message.text || "",
      source: "todo",
      user: s.user.id,
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    await refreshListMirror({
      client,
      channel,
      user: s.user.id,
      onPaidPlanError: (err) => postListPaidPlanError(client, channel, err),
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
  } catch (err) {
    await maybeReportListFailure(client, channel, err);
  }
  await slackCall(client, "chat.postEphemeral", {
    channel: s.channel.id,
    user: s.user.id,
    text: `todo created: ${file}`,
  });
});

app.shortcut(COMPARISON_SHORTCUT_ID, async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const selectedThreadTs = s.message.thread_ts || s.message.ts;
  const sourceSession = resolveComparisonSourceSession(s.channel.id, s.message.ts);
  if (!sourceSession) {
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: "No persisted agent session was found for this message.",
    });
    return;
  }

  try {
    await openComparisonModal(
      client,
      s.trigger_id,
      buildComparisonModal({
        sourceProvider: sourceSession.provider_id,
        metadata: {
          channelId: s.channel.id,
          channelName: s.channel.name || s.channel.id,
          sourceSessionId: sourceSession.id,
          sourceMessageTs: s.message.ts,
          sourceThreadTs: selectedThreadTs,
        },
      }),
    );
  } catch (err) {
    log("error", "comparison_modal_open_failed", {
      ...errorFields(err),
      channel: s.channel.id,
      source_session_id: sourceSession.id,
    });
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: `Could not open the comparison dialog: ${(err as Error).message}`,
    });
  }
});

app.view(COMPARISON_VIEW_ID, async ({ ack, body, view, client }) => {
  let request: ReturnType<typeof parseComparisonRequest>;
  try {
    request = parseComparisonRequest(view);
  } catch (err) {
    await ack({
      response_action: "errors",
      errors: { comparison_provider: (err as Error).message },
    });
    return;
  }
  await ack();

  const userId = (body as any).user.id;
  const requestId = String((view as any).id || "");
  let claimedRequest = false;
  try {
    if (!requestId) throw new Error("Slack did not provide a stable comparison request id.");
    const sourceSession = getSessionById(request.sourceSessionId);
    if (!sourceSession || sourceSession.slack_channel_id !== request.channelId) {
      throw new Error("The source session no longer exists. Open the message action again.");
    }
    const resolvedSource = resolveComparisonSourceSession(
      request.channelId,
      request.sourceMessageTs,
    );
    if (resolvedSource?.id !== sourceSession.id) {
      throw new Error("The selected message no longer resolves to the original source session. Open the message action again.");
    }
    const prompts = listSessionUserPrompts(sourceSession.id, request.sourceMessageTs);
    const replayablePrompts = replayableComparisonPrompts(prompts);
    const comparisonPrompt = buildUserOnlyComparisonPrompt(replayablePrompts);
    const channel = getChannel(request.channelId) ||
      ensureChannelProject(request.channelId, request.channelName || request.channelId);
    const targetLabel = comparisonTargetLabel(request.provider, request.model);
    const claim = claimComparisonRequest({
      requestId,
      channelId: request.channelId,
      requestedBy: userId,
      sourceSessionId: sourceSession.id,
      sourceMessageTs: request.sourceMessageTs,
      targetProvider: request.provider,
      targetModel: request.model,
    });
    if (!claim.claimed) {
      try {
        await slackCall(client, "chat.postEphemeral", {
          channel: request.channelId,
          user: userId,
          text: claim.row.comparison_thread_ts
            ? `This comparison already started at ${claim.row.comparison_thread_ts}.`
            : "This comparison is already starting.",
        });
      } catch (err) {
        log("warn", "comparison_duplicate_notice_failed", { ...errorFields(err), request_id: requestId });
      }
      return;
    }
    claimedRequest = true;
    const selectedPrompt = replayablePrompts.at(-1)!;
    const anchorMessage = buildComparisonAnchorMessage({
      sourceProvider: sourceSession.provider_id as ProviderId,
      targetLabel,
      promptCount: replayablePrompts.length,
      sourceText: comparisonAnchorSourceText(selectedPrompt),
    });
    const anchor: any = await slackCall(client, "chat.postMessage", {
      channel: request.channelId,
      ...anchorMessage,
      client_msg_id: comparisonClientMessageId(requestId),
    }, { channel: request.channelId, user: userId });
    attachComparisonThread(requestId, anchor.ts);
    try {
      await slackCall(client, "chat.postEphemeral", {
        channel: request.channelId,
        user: userId,
        text: `Comparison started with ${targetLabel} at ${anchor.ts}.`,
      });
    } catch (err) {
      log("warn", "comparison_started_notice_failed", { ...errorFields(err), request_id: requestId });
    }
    log("info", "comparison_started", {
      channel: request.channelId,
      source_session_id: sourceSession.id,
      source_provider: sourceSession.provider_id,
      target_provider: request.provider,
      target_model: request.model,
      prompt_count: replayablePrompts.length,
      source_message_ts: request.sourceMessageTs,
      comparison_thread_ts: anchor.ts,
    });
    const comparisonOutcome = await handleUserMessage({
      channel: request.channelId,
      channelName: channel.slack_channel_name,
      threadTs: anchor.ts,
      userMsgTs: anchor.ts,
      user: userId,
      text: comparisonPrompt,
      client,
      providerOverride: request.provider,
      modelOverride: request.model,
      forceNewSession: true,
      prebuiltPrompt: true,
      onTurnAcquired: (turnId) => attachComparisonTurn(requestId, turnId),
    });
    const recordedOutcome = finishComparisonFromTurnOutcome(requestId, comparisonOutcome);
    if (recordedOutcome.status === "error") throw new Error(recordedOutcome.error);
  } catch (err) {
    if (claimedRequest) finishComparisonRequest(requestId, "error", String(err));
    log("error", "comparison_failed", {
      ...errorFields(err),
      channel: request.channelId,
      source_session_id: request.sourceSessionId,
      target_provider: request.provider,
      target_model: request.model,
    });
    try {
      await slackCall(client, "chat.postEphemeral", {
        channel: request.channelId,
        user: userId,
        text: `Comparison failed: ${(err as Error).message}`,
      });
    } catch (noticeErr) {
      log("warn", "comparison_failure_notice_failed", { ...errorFields(noticeErr), request_id: requestId });
    }
  }
});

app.shortcut("fork_from_here", async ({ ack, shortcut, client }) => {
  await ack();
  const s: any = shortcut;
  const channel = ensureChannelProject(s.channel.id, s.channel.name || s.channel.id);
  const selectedThreadTs = s.message.thread_ts || s.message.ts;
  const selectedMessageTs = s.message.ts;
  const parent = resolveForkParentSession(s.channel.id, selectedMessageTs);
  log("info", "fork_shortcut_parent_resolved", {
    channel: s.channel.id,
    selected_thread_ts: selectedThreadTs,
    selected_message_ts: selectedMessageTs || null,
    parent_session_id: parent?.id || null,
    parent_thread_ts: parent?.slack_thread_ts || null,
  });
  if (!parent?.agent_session_uuid) {
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: unavailableForkSourceMessage(
        s.channel.id,
        selectedMessageTs,
        "No persisted session found to fork.",
      ),
    });
    return;
  }
  try {
    const boundary = getProviderTurnBoundaryForSlackMessage(s.channel.id, selectedMessageTs);
    const cwd = channel.code_path || channel.vault_path;
    const lastProviderTurnId = await resolveExactForkTurnId({
      parent: {
        provider_id: parent.provider_id as ProviderId,
        agent_session_uuid: parent.agent_session_uuid,
      },
      boundary,
      cwd,
      requireBoundary: true,
    });
    const claim = claimForkRequest({
      requestId: s.trigger_id,
      channelId: s.channel.id,
      requestedBy: s.user.id,
      sourceSessionId: parent.id,
      sourceMessageTs: selectedMessageTs,
      providerId: parent.provider_id as ProviderId,
      sourceProviderSessionUUID: parent.agent_session_uuid,
      lastProviderTurnId,
      cwd,
      additionalDirs: parseAdditionalPaths(channel),
    });
    const request = await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId,
      shouldStop: () => draining,
    });
    if (request.status !== "delivered") {
      await slackCall(client, "chat.postEphemeral", {
        channel: s.channel.id,
        user: s.user.id,
        text: forkRequestResultMessage(request),
      });
    }
  } catch (err) {
    await slackCall(client, "chat.postEphemeral", {
      channel: s.channel.id,
      user: s.user.id,
      text: `fork failed: ${(err as Error).message}`,
    });
  }
});

// Note: the #bot-status channel + hourly heartbeat feature was removed per
// design decision — silence (no reply to a message) is the down signal, and
// `/concierge-status` reports uptime on demand. If Slack List creation fails
// because Lists aren't enabled on the workspace, we log-and-continue-in-channel
// rather than fanning out to a health channel.
async function postListPaidPlanError(_client: any, channel: NonNullable<ReturnType<typeof getChannel>>, err: unknown) {
  const code = slackErrorCode(err);
  log("error", "list_paid_plan_failure", {
    channel: channel.slack_channel_id,
    list_id: channel.list_id,
    error: code,
  });
}

async function rerenderAllCanvases(reason: "startup" | "interval", requireSuccess = false) {
  const result = await syncAllAgentsCanvases({
    channels: getSlackChannels(),
    requireSuccess,
    sync: async (channel) => await syncAgentsCanvas({
      client: app.client,
      channel,
      user: null,
      reason: `scheduled_${reason}`,
    }),
  });
  log("info", "scheduled_canvas_refresh_complete", {
    reason,
    refreshed: result.refreshed,
    failures: result.failures,
    required: requireSuccess,
  });
}

setInterval(() => {
  void rerenderAllCanvases("interval").catch((error) => {
    log("error", "scheduled_canvas_refresh_failed", errorFields(error));
  });
}, 6 * 60 * 60 * 1000);

async function reconcileOrphanedSlackInputs() {
  const orphanedInputs = listOrphanedSlackInputClaims(isProcessIdentityAlive);
  for (const input of orphanedInputs) {
    if (!input.inline_capture || !input.user_text || !input.user_id) continue;
    void scheduleInlineCaptureRecovery(app.client, input.slack_channel_id, input.slack_user_msg_ts);
  }
  const releasedInputClaims = releaseOrphanedSlackInputClaims(isProcessIdentityAlive);
  if (releasedInputClaims > 0) {
    log("warn", "orphaned_slack_input_claims_recovered", { count: releasedInputClaims });
  }
}

async function reconcilePriorInstanceTurns() {
  await reconcileOrphanedSlackInputs();
  const recoveredStatusClaims = recoverSlackThreadStatusProjectionClaims();
  if (recoveredStatusClaims > 0) {
    log("warn", "slack_thread_status_projections_recovered", { count: recoveredStatusClaims });
  }
  const recoveredTurnStatusClaims = recoverTurnStatusProjectionClaims();
  if (recoveredTurnStatusClaims > 0) {
    log("warn", "turn_status_projections_recovered", { count: recoveredTurnStatusClaims });
  }
  const recoveredReactionCleanupClaims = recoverTurnReactionCleanupClaims();
  if (recoveredReactionCleanupClaims > 0) {
    log("warn", "turn_reaction_cleanups_recovered", { count: recoveredReactionCleanupClaims });
  }
  const recoveredSteering = recoverUnsettledSteeringMessages(isProcessIdentityAlive);
  if (recoveredSteering.failed > 0 || recoveredSteering.ambiguous > 0) {
    log("warn", "unsettled_steering_recovered", recoveredSteering);
  }
  const recoveryOutcome = await reconcileRecoverableTurns({
    client: app.client,
    instanceId,
    isOwnerAlive: isProcessIdentityAlive,
    services: {
      deliverOutcome: deliverTurnOutcome,
      projectTurnStatus: projectSlackTurnStatus,
      projectThreadSummary: projectSlackThreadSummary,
      scheduleWorkingReactionCleanup: (client, turnId) => scheduleTurnReactionCleanup(
        client,
        turnId,
        { shouldStop: () => draining, wait: waitForNoticeRetry },
      ),
    },
  });
  if (recoveryOutcome === "stopped") return;
  recoverSteeringFailureNoticeClaims();
  recoverDeferredSteeringFailureNotices(isProcessIdentityAlive);
  recoverSlackInputRecoveryNoticeClaims();
  recoverInlineCaptureConfirmationClaims();
  for (const status of listPendingSlackThreadStatusProjections()) {
    void scheduleSlackThreadStatusProjection(
      app.client,
      status.slack_channel_id,
      status.slack_thread_ts,
    );
  }
  for (const status of listPendingTurnStatusProjections()) {
    void scheduleSlackTurnStatusProjection(app.client, status.turn_id);
  }
  for (const cleanup of listPendingTurnReactionCleanups()) {
    void scheduleTurnReactionCleanup(app.client, cleanup.turn_id, {
      shouldStop: () => draining,
      wait: waitForNoticeRetry,
    }).catch((error) => {
      log("error", "turn_reaction_cleanup_worker_failed", {
        ...errorFields(error),
        turn_id: cleanup.turn_id,
      });
    });
  }
  for (const notice of listPendingSteeringFailureNotices()) {
    void scheduleSteeringFailureNotice(app.client, notice.id);
  }
  for (const notice of listPendingSlackInputRecoveryNotices()) {
    void scheduleSlackInputRecoveryNotice(
      app.client,
      notice.slack_channel_id,
      notice.slack_user_msg_ts,
    );
  }
  for (const confirmation of listPendingInlineCaptureConfirmations()) {
    void scheduleInlineCaptureConfirmation(
      app.client,
      confirmation.slack_channel_id,
      confirmation.slack_user_msg_ts,
    );
  }
  for (const channel of getSlackChannels()) {
    if (!channel.list_id || !channel.list_title_column_id) continue;
    void scheduleChannelListAccessRepair(app.client, channel);
  }
  const forkRecovery = await reconcileForkRequests({
    client: app.client,
    instanceId,
    isOwnerAlive: isProcessIdentityAlive,
    shouldStop: () => draining,
  });
  log("info", "fork_requests_reconciled", forkRecovery);
  const comparisonRecovery = reconcileComparisonRequests();
  log("info", "comparison_requests_reconciled", comparisonRecovery);
}

let periodicForkRecovery: Promise<unknown> | null = null;
setInterval(() => {
  if (draining || periodicForkRecovery) return;
  const recovery = reconcileForkRequests({
    client: app.client,
    instanceId,
    isOwnerAlive: isProcessIdentityAlive,
    shouldStop: () => draining,
  })
    .catch((error) => {
      log("error", "scheduled_fork_request_recovery_failed", errorFields(error));
    })
    .finally(() => {
      if (periodicForkRecovery === recovery) periodicForkRecovery = null;
    });
  periodicForkRecovery = recovery;
}, 60_000);

async function drainAndStop(signal: string) {
  if (draining) return;
  draining = true;
  log("info", "service_drain_started", {
    signal,
    active_turns: activeTurnCount,
    active_input_handlers: activeInputHandlerCount,
    instance_id: instanceId,
  });
  if (captureDeliveryWorker) await captureDeliveryWorker.stop();
  await app.stop();
  if (activeTurnCount > 0 || activeInputHandlerCount > 0) {
    await new Promise<void>((resolve) => { resolveDrained = resolve; });
  }
  stopProcessInstance(instanceId);
  log("info", "service_drain_complete", { signal, instance_id: instanceId });
  process.exit(0);
}

process.on("SIGTERM", () => { void drainAndStop("SIGTERM"); });
process.on("SIGINT", () => { void drainAndStop("SIGINT"); });

(async () => {
  try {
    captureDeliveryWorker = new CaptureDeliveryWorker({
      queueUrl: process.env.CONCIERGE_CAPTURE_QUEUE_URL || "http://127.0.0.1:8081",
      queueToken: loadCaptureQueueToken(),
      slackUserToken: String(cfg.user_token || ""),
      owner: processIdentity,
      onFatal(error) {
        process.exitCode = 1;
        log("error", "capture_delivery_requires_restart", errorFields(error));
        void drainAndStop("capture-worker-fatal");
      },
    });
    await captureDeliveryWorker.prepare();
    const auth: any = await app.client.auth.test();
    myBotUserId = auth.user_id as string;
    myBotId = (auth.bot_id as string) || null;
    await reconcilePriorInstanceTurns();
    const requireCanvasRefresh = projectCutoverStartup.requireCanvasRefresh;
    await rerenderAllCanvases("startup", requireCanvasRefresh);
    await app.start();
    await captureDeliveryWorker.start();
    log("info", "concierge_bot_online", {
      bot_user_id: myBotUserId,
      bot_id: myBotId,
      token_suffix: String(cfg.bot_token || "").slice(-4),
    });
    log("warn", "canvas_bidirectional_sync_not_supported", {
      reason: "Slack Canvas Web API exposes create/edit and section lookup, but no deterministic raw document read path; Concierge re-renders AGENTS.md to Canvas instead.",
    });
  } catch (err) {
    log("error", "concierge_startup_failed", errorFields(err));
    process.exit(1);
  }
})();
