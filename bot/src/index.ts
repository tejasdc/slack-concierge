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
} from "./aliases";
import { providers } from "./providers";
import { findCodexTurnIdsByReplayText } from "./codex";
import {
  closeSharedCodexAppServerClient,
  verifySharedCodexAppServerReady,
} from "./codex-app-server-client";
import { CodexRemoteObserver } from "./codex-remote-observer";
import { assertProviderHistoryReplayable } from "./provider-replay";
import {
  associateLegacyTurnsWithSlackThread,
  attachComparisonThread,
  beginInlineCapture,
  claimSlackUserInput,
  claimInlineCaptureConfirmation,
  claimSlackInputRecoveryNotice,
  claimSteeringNotification,
  claimComparisonRequest,
  claimForkRequest,
  clearAbandonedDrain,
  ChannelMode,
  classifySlackUserInput,
  createOrGetSession,
  createTurnSteeringMessage,
  deliveredChunkIndexes,
  finishInlineCapture,
  finalizeTurnSteeringMessageAmbiguity,
  finishComparisonRequest,
  finishComparisonFromTurnOutcome,
  getSlackThreadStatus,
  getSlackRootSummaryProjection,
  getTurnProgressStream,
  heartbeatProcessInstance,
  getSlackInputRecoveryNotice,
  getInlineCaptureConfirmation,
  getSlackUserInputClaim,
  getSteeringNotification,
  listOrphanedSlackInputClaims,
  listPendingInlineCaptureConfirmations,
  listPendingSlackThreadStatusProjections,
  listPendingSlackRootSummaryProjections,
  listPendingTurnStatusProjections,
  listPendingTurnReactionCleanups,
  listPendingTurnArtifactDeliveries,
  listPendingSlackInputRecoveryNotices,
  listPendingSteeringNotifications,
  markSlackInputRecoveryNoticeDelivered,
  markSlackInputRecoveryNoticeRetry,
  markInlineCaptureConfirmationDelivered,
  markInlineCaptureConfirmationRetry,
  markInlineCaptureListSkipped,
  markInlineCaptureVaultDone,
  markSteeringNotificationDelivered,
  markSteeringNotificationRetry,
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
  claimSlackRootSummaryProjection,
  markSlackRootSummaryProjectionDelivered,
  markSlackRootSummaryProjectionRetry,
  parkSlackRootSummaryProjection,
  requestSlackRootSummaryProjection,
  recoverSlackRootSummaryProjectionClaims,
  claimSlackAgentSessionStatusProjection,
  getSlackAgentSessionStatusProjection,
  getSlackAgentSessionTitleProjection,
  getAgentSessionDashboardRowForUser,
  getAgentSessionDashboardUserForTurn,
  listAgentSessionDashboardRows,
  sessionOwnsCompletedProviderTurn,
  listPendingSlackAgentSessionStatusProjections,
  listPendingSlackAgentSessionTitleProjections,
  markSlackAgentSessionStatusProjectionDelivered,
  markSlackAgentSessionStatusProjectionRetry,
  parkSlackAgentSessionStatusProjection,
  recoverSlackAgentSessionStatusProjectionClaims,
  recoverSlackAgentSessionTitleProjectionClaims,
  requestSlackAgentSessionStatusProjection,
  requestSlackAgentSessionTitleProjection,
  requestAgentStopForSession,
  observeSlackAgentSessionTitle,
  claimSlackAgentSessionTitleProjection,
  markSlackAgentSessionTitleProjectionDelivered,
  markSlackAgentSessionTitleProjectionRetry,
  parkSlackAgentSessionTitleProjection,
  resumeParkedSessionTurn,
  parkInlineCaptureConfirmation,
  parkSlackInputRecoveryNotice,
  parkSteeringNotification,
  registerProcessInstance,
  recordDeliveryAttempt,
  reconcileComparisonRequests,
  recoverDeferredSteeringNotifications,
  recoverInlineCaptureConfirmationClaims,
  recoverSlackThreadStatusProjectionClaims,
  recoverSlackInputRecoveryNoticeClaims,
  recoverSteeringNotificationClaims,
  recoverUnsettledSteeringMessages,
  releaseOrphanedSlackInputClaims,
  replaceMissingSlackThreadStatusMessage,
  stopProcessInstance,
  getSlackChannels,
  getChannel,
  getForkSourceMessagePreview,
  getProviderTurnBoundaryForSlackMessage,
  getSessionById,
  getSessionByUuid,
  getSessionForThread,
  isIsolatedSessionThread,
  getSteeringMessageForSlackMessage,
  listSessionUserPrompts,
  parseAdditionalPaths,
  ProviderId,
  type SteeringNotificationRow,
  type InlineCaptureConfirmationRow,
  type SlackInputRecoveryNoticeRow,
  acquireSessionTurn,
  claimNextQueuedTurn,
  resolveForkParentSession,
  resolveComparisonSourceSession,
  requestSlackThreadStatusProjection,
  claimSlackThreadStatusProjection,
  claimTurnStatusProjection,
  getTurnStatusProjection,
  requestTurnStatusProjection,
  reserveSessionForThread,
  recordTurnStatusMessage,
  recordTurnProgressActivity,
  requestTurnProgressStreamStop,
  markTurnProgressStreamStopped,
  parkTurnProgressStream,
  recordTurnProviderTurnId,
  replaceMissingTurnStatusMessage,
  markTurnStatusProjectionDelivered,
  markTurnStatusProjectionRetry,
  parkTurnStatusProjection,
  recoverTurnStatusProjectionClaims,
  recoverTurnReactionCleanupClaims,
  recoverTurnArtifactDeliveryClaims,
  parkRunningTurnAfterProviderFailure,
  recordSlackThreadStatusMessage,
  updateChannelMode,
  updateChannelProvider,
  updateTurnSteeringReplayText,
  upsertSession,
  turnHasAcceptedSteering,
  type QueuedTurnClaimRow,
} from "./state";
import {
  executeForkRequest,
  forkSourceExcerpt,
  forkRequestResultMessage,
  isInlineForkAction,
  reconcileForkRequests,
  waitForForkBinding,
} from "./fork-requests";
import { currentProcessIdentity, isProcessIdentityAlive } from "./runtime-identity";
import { agentProgressSlackCall, slackCall } from "./rate-limit";
import { postLongReply } from "./slack-post";
import { scopeSlackIdempotencyKey } from "./slack-idempotency";
import { formatDuration, formatTurnStatusMessage } from "./text";
import { runSlackThreadStatusProjection } from "./thread-status";
import { postThreadStatusThroughAnchor, turnStatusClientMessageId } from "./turn-status-projection";
import { scheduleTurnReactionCleanup } from "./turn-reaction-cleanup";
import { cleanExpiredArtifactStaging, scheduleTurnArtifactDelivery } from "./artifact-delivery-worker";
import {
  startRuntimeWithRequiredCanvasRefresh,
  syncAgentsCanvas,
  syncAllAgentsCanvases,
} from "./canvas";
import {
  committedAgentsWatchTarget,
  syncCommittedAgentsCanvas,
} from "./canvas-git-projection";
import { type SlackMessageFile } from "./attachments";
import { prepareProviderInput } from "./provider-input";
import { executeAgentTurn } from "./turn-execution";
import { legacyProgressChunks, progressActivityIdAfterChunks, type SlackAgentProgressChunk } from "./agent-progress";
import { beginAgentProgressMessages, createProgressMessageClient, hasAgentProgressMessages, queueAgentProgressMessages, projectAgentProgressMessages } from "./agent-progress-messages";
import { handleAgentSessionStop } from "./agent-session-stop";
import { reconcileRecoverableTurns } from "./turn-recovery";
import {
  ensureChannelList,
} from "./lists";
import { TodoProjectionManager } from "./todo-sync";
import { TodoFileWatcher } from "./todo-file-watcher";
import { ProjectionWatcher } from "./projection-watcher";
import { isTransientSlackError, slackErrorCode } from "./slack-errors";
import { deliverInlineCaptureConfirmation } from "./inline-capture-confirmation";
import { startupCutoverDecision } from "./project-cutover-state";
import {
  effectiveSessionModeForMessage,
  persistentSessionThreadTs,
  resolveMessageRouting,
} from "./routing";
import { runDeliveryWorker } from "./delivery-worker";
import {
  createKeyedTaskScheduler,
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
import {
  APP_HOME_FORK_ACTION_ID,
  APP_HOME_REFRESH_ACTION_ID,
  APP_HOME_RENAME_ACTION_ID,
  APP_HOME_RENAME_VIEW_ID,
  APP_HOME_RETRY_ACTION_ID,
  APP_HOME_STOP_ACTION_ID,
  buildAgentSessionHomeView,
  buildRenameAgentSessionModal,
  parseAgentSessionActionTarget,
  parseRenameAgentSessionSubmission,
} from "./app-home";
import {
  CaptureDeliveryWorker,
  loadCaptureQueueToken,
  loadCaptureQueueTokenFromPath,
} from "./capture-delivery-worker";
import { createCoalescingEventRunner } from "./coalescing-event-runner";
import {
  getLatestDeploymentTurnReactionStateForSession,
  recoverDeadDeploymentRuns,
  recoverDeploymentNoticeClaims,
  wakeDeploymentRunnerWaitingForIdle,
  type DeploymentRunRow,
} from "./deployment-state";
import { acceptGitHubDeploymentPush } from "./deployment-push";
import { startDeploymentEventIngress } from "./deployment-event-ingress";
import { reconcileDeploymentWork, refreshActiveDeploymentReactionTargets } from "./deployment-worker";
import {
  SessionTurnQueueCoordinator,
} from "./session-turn-queue";
import {
  buildQueuedTurnInput,
  executePersistedQueuedTurn,
  stripBotMentions,
  type ClaimedTurnInput,
} from "./queued-turn-execution";
import {
  ActiveTurnDispatchRegistry,
  dispatchComparisonTurn,
  startRecoveredSessionTurnQueue,
  type UserTurnDispatchOptions,
} from "./turn-dispatch-seams";
import {
  assertAuthenticatedSlackIdentity,
  assertConfiguredSlackIdentity,
  clearSandboxReadyReceipt,
  resolveAuthenticatedSlackAppId,
  resolveRuntimeProfile,
  writeSandboxReadyReceipt,
} from "./runtime-profile";
import {
  SandboxSlackIdentityGate,
  sandboxSlackIdentityMiddleware,
} from "./sandbox-slack-identity";

const runtime = resolveRuntimeProfile();
const cfg: any = toml.parse(readFileSync(runtime.slackConfigPath, "utf-8"));
assertConfiguredSlackIdentity(runtime, cfg);
const claudeCodeBotUserId = cfg.claude_code_bot_user_id || process.env.CLAUDE_CODE_BOT_USER_ID || null;

const sandboxSlackIdentity = runtime.profile === "sandbox"
  ? new SandboxSlackIdentityGate(runtime, cfg.app_token)
  : null;
const app = new App(runtime.profile === "sandbox" ? {
  token: cfg.bot_token,
  signingSecret: cfg.signing_secret,
  receiver: sandboxSlackIdentity!.receiver,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
} : {
  token: cfg.bot_token,
  appToken: cfg.app_token,
  signingSecret: cfg.signing_secret,
  socketMode: true,
  logLevel: LogLevel.INFO,
  ignoreSelf: false,
});
if (sandboxSlackIdentity) {
  app.use(sandboxSlackIdentityMiddleware(sandboxSlackIdentity));
}
const progressMessageClient = createProgressMessageClient(cfg.bot_token);

let myBotUserId: string | null = null;
let myBotId: string | null = null;
let myTeamId: string | null = null;
let myWorkspaceUrl: string | null = null;
let todoProjectionManager: TodoProjectionManager | null = null;
let todoFileWatcher: TodoFileWatcher | null = null;
let canvasCommitWatcher: ProjectionWatcher<"startup" | "git-head"> | null = null;
let startedAt = Date.now();
const instanceId = randomUUID();
const processIdentity = currentProcessIdentity();
function detectedRuntimeGitSha() {
  const supplied = process.env.CONCIERGE_RUNTIME_GIT_SHA || "";
  if (/^[0-9a-f]{40}$/.test(supplied)) return supplied;
  const manifestPath = process.env.CONCIERGE_RELEASE_MANIFEST;
  if (manifestPath) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (/^[0-9a-f]{40}$/.test(String(manifest.git_commit || ""))) return String(manifest.git_commit);
    } catch {
      return "";
    }
  }
  return Buffer.from(Bun.spawnSync({
    cmd: ["git", "rev-parse", "HEAD"],
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "ignore",
  }).stdout).toString("utf8").trim();
}

const runtimeGitSha = detectedRuntimeGitSha();
let draining = false;
let serviceOnline = false;
let activeTurnCount = 0;
let activeInputHandlerCount = 0;
let resolveDrained: (() => void) | null = null;
let captureDeliveryWorker: CaptureDeliveryWorker | null = null;
let deploymentEventServer: ReturnType<typeof startDeploymentEventIngress> | null = null;
let codexRemoteObserver: CodexRemoteObserver | null = null;
let sessionTurnQueue: SessionTurnQueueCoordinator<QueuedTurnClaimRow> | null = null;
const activeTurnDispatch = new ActiveTurnDispatchRegistry({
  onStarted: () => { activeTurnCount += 1; },
  onSettled: (turnId) => {
    activeTurnCount -= 1;
    resolveDrainIfIdle();
    sessionTurnQueue?.wake();
    const dashboardUser = getAgentSessionDashboardUserForTurn(turnId);
    if (dashboardUser) scheduleAgentSessionsHomeRefresh(dashboardUser);
    if (runtime.ownership.deployment) {
      try {
        refreshActiveDeploymentReactionTargets(turnId);
      } catch (error) {
        log("error", "deployment_turn_reaction_refresh_failed", errorFields(error));
      }
      scheduleDeploymentWork("turn-settled");
      wakeDeploymentRunnerWaitingForIdle();
    }
  },
});
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
const activeAgentSessionTitleProjectionTasks = new Map<
  string,
  Promise<"delivered" | "stopped" | "permanent_failure">
>();
const openedAgentSessionsHomeUsers = new Set<string>();
const pendingAgentSessionsHomeNotices = new Map<string, string>();
const activeAgentSessionsHomeRefreshes = new Map<string, Promise<void>>();
const dirtyAgentSessionsHomeUsers = new Set<string>();
const activeRootSummaryProjectionTasks = new Map<
  string,
  Promise<"delivered" | "stopped" | "permanent_failure">
>();
const activeAgentSessionStatusProjectionTasks = new Map<
  string,
  Promise<"delivered" | "stopped" | "permanent_failure">
>();

function resolveDrainIfIdle() {
  if (activeTurnCount !== 0 || activeInputHandlerCount !== 0 || !resolveDrained) return;
  resolveDrained();
  resolveDrained = null;
}

const projectCutoverStartup = runtime.ownership.projectCutover
  ? startupCutoverDecision(process.env.CONCIERGE_STATE_DIR!)
  : { allowStartup: true, preserveDrain: false, requireCanvasRefresh: false };
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
  parent: { id: number; provider_id: ProviderId; agent_session_uuid: string };
  boundary: {
    turnId: number;
    providerTurnId: string | null;
    replayText: string | null;
    sourceKind: "user" | "outcome";
  } | null;
  cwd: string;
  requireBoundary: boolean;
}): Promise<string | null> {
  assertProviderHistoryReplayable(input.parent, "fork");
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

function steeringFailureNoticeText(message: Pick<SteeringNotificationRow, "status" | "error">) {
  return message.status === "ambiguous"
    ? "Concierge could not confirm whether that steering message reached the agent. It will not be used for replay or comparison; please restate it in your next message."
    : "That steering message was not applied to the agent turn. Please send it again as a new message.";
}

function deterministicSlackClientMessageId(key: string) {
  const hex = createHash("sha256")
    .update(scopeSlackIdempotencyKey(key))
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

function schedulePersistedArtifactDelivery(artifactId: string) {
  return scheduleTurnArtifactDelivery(app.client, artifactId, instanceId, undefined, {
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
    projectFailure: (turnId) => scheduleSlackTurnStatusProjection(app.client, turnId),
  }).catch((error) => {
    log("error", "turn_artifact_worker_failed", {
      artifact_id: artifactId,
      ...errorFields(error),
    });
    return "permanent_failure" as const;
  });
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

const agentJoinedChannels = new Set<string>();

async function ensureAgentChannelMembership(client: any, channel: string) {
  if (agentJoinedChannels.has(channel)) return;
  try {
    await slackCall(client, "conversations.join", { channel }, { channel });
    agentJoinedChannels.add(channel);
  } catch (error) {
    if (["already_in_channel", "method_not_supported_for_channel_type"].includes(slackErrorCode(error))) {
      agentJoinedChannels.add(channel);
      return;
    }
    throw error;
  }
}

async function startSlackAgentProgress(input: {
  client: any;
  turnId: number;
  channel: string;
  threadTs: string;
  recipientUserId: string;
  recipientTeamId: string;
  chunks: SlackAgentProgressChunk[];
}) {
  await ensureAgentChannelMembership(input.client, input.channel);
  const existing = getTurnProgressStream(input.turnId);
  if (existing?.progress_stream_state === "streaming" && existing.progress_stream_ts) {
    return existing.progress_stream_ts;
  }
  if (existing && existing.progress_stream_state !== "not_started") {
    throw new Error(
      `Turn ${input.turnId} cannot create another Agent stream from ${existing.progress_stream_state}.`,
    );
  }
  try {
    beginAgentProgressMessages(input.turnId, input.chunks);
    await projectAgentProgressMessages(progressMessageClient, input.turnId);
    return getTurnProgressStream(input.turnId)!.progress_stream_ts!;
  } catch (error) {
    parkTurnProgressStream(
      input.turnId,
      `Agent progress creation is ambiguous or failed: ${String(error)}`,
    );
    throw error;
  }
}

async function appendSlackAgentProgress(input: {
  client: any;
  turnId: number;
  channel: string;
  streamTs: string;
  chunks: SlackAgentProgressChunk[];
}) {
  const stream = getTurnProgressStream(input.turnId);
  if (!stream || stream.progress_stream_ts !== input.streamTs || stream.progress_stream_state !== "streaming") {
    throw new Error(`Turn ${input.turnId} no longer owns Agent stream ${input.streamTs}.`);
  }
  if (hasAgentProgressMessages(input.turnId)) {
    queueAgentProgressMessages(input.turnId, input.chunks);
    await projectAgentProgressMessages(progressMessageClient, input.turnId);
    return;
  }
  if (input.chunks.length === 0) return;
  const activityId = progressActivityIdAfterChunks(input.chunks, stream.progress_activity_id);
  await agentProgressSlackCall(input.client, "chat.appendStream", {
    channel: input.channel,
    ts: input.streamTs,
    chunks: legacyProgressChunks(input.chunks),
  }, { channel: input.channel });
  if (activityId !== stream.progress_activity_id) recordTurnProgressActivity(input.turnId, input.streamTs, activityId);
}

async function renewSlackAgentProgress(input: {
  client: any;
  channel: string;
  threadTs: string;
}) {
  await setSlackAgentSessionStatus({ ...input, status: "processing" });
}

async function callSlackAgentSessionStatus(input: {
  client: any;
  channel: string;
  threadTs: string;
  status: "active" | "processing" | "suspended";
  initiatorUserId?: string | null;
  initialTitle?: string | null;
}) {
  await agentProgressSlackCall(input.client, "agents.sessions.setStatus", {
    channel_id: input.channel,
    thread_ts: input.threadTs,
    status: input.status,
    initiator_user_id: input.initiatorUserId ?? undefined,
    title: input.initialTitle ?? undefined,
  }, { channel: input.channel });
}

function agentSessionStatusProjectionRow(
  row: NonNullable<ReturnType<typeof getSlackAgentSessionStatusProjection>>,
) {
  return {
    ...row,
    slack_status_msg_ts: `${row.slack_channel_id}:${row.slack_thread_ts}`,
    message_generation: 0,
    desired_text: row.desired_status,
  };
}

async function scheduleSlackAgentSessionStatusProjection(
  client: any,
  channel: string,
  threadTs: string,
): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const key = `${channel}:${threadTs}`;
  const existing = activeAgentSessionStatusProjectionTasks.get(key);
  if (existing) {
    await existing;
    const latest = getSlackAgentSessionStatusProjection(channel, threadTs);
    if (!draining && latest?.projection_status === "pending") {
      return scheduleSlackAgentSessionStatusProjection(client, channel, threadTs);
    }
    if (latest?.projection_status === "delivered") return "delivered";
    if (latest?.projection_status === "parked") return "permanent_failure";
    return "stopped";
  }

  const task = runSlackThreadStatusProjection({
    load: async () => {
      const row = await persistThreadStatusState(
        () => getSlackAgentSessionStatusProjection(channel, threadTs),
      );
      return row ? agentSessionStatusProjectionRow(row) : null;
    },
    claim: async (nowMs) => {
      const row = await persistThreadStatusState(
        () => claimSlackAgentSessionStatusProjection(channel, threadTs, nowMs),
      );
      return row ? agentSessionStatusProjectionRow(row) : null;
    },
    update: async (row) => callSlackAgentSessionStatus({
      client,
      channel,
      threadTs,
      status: row.desired_text as "active" | "processing" | "suspended",
      initiatorUserId: row.initiator_user_id,
      initialTitle: row.initial_title,
    }),
    post: async () => { throw new Error("Agent session status projections cannot create messages."); },
    recordMessage: async () => {},
    replaceMissingMessage: async () => {},
    markDelivered: (row) => persistThreadStatusState(
      () => markSlackAgentSessionStatusProjectionDelivered(channel, threadTs, row.desired_revision),
    ),
    markRetry: (row, error, nextAttemptMs) => persistThreadStatusState(
      () => markSlackAgentSessionStatusProjectionRetry(
        channel,
        threadTs,
        row.desired_revision,
        error,
        nextAttemptMs,
      ),
    ),
    markParked: (row, error) => persistThreadStatusState(
      () => parkSlackAgentSessionStatusProjection(channel, threadTs, row.desired_revision, error),
    ),
    isMissingUpdateError: () => false,
    isMissingDuplicateError: () => false,
    isRetryable: isTransientSlackError,
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
  }).finally(() => {
    if (activeAgentSessionStatusProjectionTasks.get(key) === task) {
      activeAgentSessionStatusProjectionTasks.delete(key);
    }
  });
  activeAgentSessionStatusProjectionTasks.set(key, task);
  return task;
}

async function setSlackAgentSessionStatus(input: {
  client: any;
  channel: string;
  threadTs: string;
  status: "active" | "processing" | "suspended";
  initiatorUserId?: string;
  initialTitle?: string;
}) {
  await persistThreadStatusState(() => requestSlackAgentSessionStatusProjection(input));
  const outcome = await scheduleSlackAgentSessionStatusProjection(
    input.client,
    input.channel,
    input.threadTs,
  );
  if (outcome !== "delivered") {
    throw new Error(`Agent session status ${input.status} projection ${outcome.replaceAll("_", " ")}.`);
  }
}

function agentSessionTitleProjectionRow(
  row: NonNullable<ReturnType<typeof getSlackAgentSessionTitleProjection>>,
) {
  return {
    ...row,
    slack_status_msg_ts: `${row.slack_channel_id}:${row.slack_thread_ts}`,
    message_generation: 0,
    desired_text: row.desired_title,
  };
}

async function scheduleSlackAgentSessionTitleProjection(
  client: any,
  channel: string,
  threadTs: string,
): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const key = `${channel}:${threadTs}`;
  const existing = activeAgentSessionTitleProjectionTasks.get(key);
  if (existing) {
    await existing;
    const latest = getSlackAgentSessionTitleProjection(channel, threadTs);
    if (!draining && latest?.projection_status === "pending") {
      return scheduleSlackAgentSessionTitleProjection(client, channel, threadTs);
    }
    if (latest?.projection_status === "delivered") return "delivered";
    if (latest?.projection_status === "parked") return "permanent_failure";
    return "stopped";
  }

  const task = runSlackThreadStatusProjection({
    load: async () => {
      const row = await persistThreadStatusState(
        () => getSlackAgentSessionTitleProjection(channel, threadTs),
      );
      return row ? agentSessionTitleProjectionRow(row) : null;
    },
    claim: async (nowMs) => {
      const row = await persistThreadStatusState(
        () => claimSlackAgentSessionTitleProjection(channel, threadTs, nowMs),
      );
      return row ? agentSessionTitleProjectionRow(row) : null;
    },
    update: async (row) => agentProgressSlackCall(client, "agents.sessions.rename", {
      channel_id: channel,
      thread_ts: threadTs,
      title: row.desired_text,
    }, { channel }),
    post: async () => { throw new Error("Agent session title projections cannot create messages."); },
    recordMessage: async () => {},
    replaceMissingMessage: async () => {},
    markDelivered: (row) => persistThreadStatusState(
      () => markSlackAgentSessionTitleProjectionDelivered(channel, threadTs, row.desired_revision),
    ),
    markRetry: (row, error, nextAttemptMs) => persistThreadStatusState(
      () => markSlackAgentSessionTitleProjectionRetry(
        channel,
        threadTs,
        row.desired_revision,
        error,
        nextAttemptMs,
      ),
    ),
    markParked: (row, error) => persistThreadStatusState(
      () => parkSlackAgentSessionTitleProjection(channel, threadTs, row.desired_revision, error),
    ),
    isMissingUpdateError: () => false,
    isMissingDuplicateError: () => false,
    isRetryable: isTransientSlackError,
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
  }).finally(() => {
    if (activeAgentSessionTitleProjectionTasks.get(key) === task) {
      activeAgentSessionTitleProjectionTasks.delete(key);
    }
  });
  activeAgentSessionTitleProjectionTasks.set(key, task);
  return task;
}

async function publishAgentSessionsHome(client: any, userId: string, notice?: string | null) {
  const rows = listAgentSessionDashboardRows(userId).map((row) => ({
    ...row,
    deployment_state: getLatestDeploymentTurnReactionStateForSession(row.session_id),
  }));
  await slackCall(client, "views.publish", {
    user_id: userId,
    view: buildAgentSessionHomeView({ rows, workspaceUrl: myWorkspaceUrl, teamId: myTeamId, notice }),
  }, { user: userId });
}

function scheduleAgentSessionsHomeRefresh(userId: string, notice?: string) {
  if (!userId || !openedAgentSessionsHomeUsers.has(userId) || draining) return;
  if (notice) pendingAgentSessionsHomeNotices.set(userId, notice);
  dirtyAgentSessionsHomeUsers.add(userId);
  if (activeAgentSessionsHomeRefreshes.has(userId)) return;
  const task = (async () => {
    while (!draining && dirtyAgentSessionsHomeUsers.delete(userId)) {
      const nextNotice = pendingAgentSessionsHomeNotices.get(userId) || null;
      pendingAgentSessionsHomeNotices.delete(userId);
      await publishAgentSessionsHome(app.client, userId, nextNotice);
    }
  })().catch((error) => {
    log("error", "agent_sessions_home_refresh_failed", { user_id: userId, ...errorFields(error) });
  }).finally(() => {
    activeAgentSessionsHomeRefreshes.delete(userId);
    if (dirtyAgentSessionsHomeUsers.has(userId) && !draining) scheduleAgentSessionsHomeRefresh(userId);
  });
  activeAgentSessionsHomeRefreshes.set(userId, task);
}

async function setSlackAgentSessionActive(client: any, channel: string, threadTs: string) {
  await setSlackAgentSessionStatus({ client, channel, threadTs, status: "active" });
}

async function stopSlackAgentProgress(input: {
  client: any;
  turnId: number;
  channel: string;
  streamTs: string;
  chunks: SlackAgentProgressChunk[];
}) {
  let retryDelayMs = 1_000;
  while (!draining) {
    const stream = requestTurnProgressStreamStop(input.turnId);
    if (!stream || stream.progress_stream_state === "stopped") return;
    if (stream.progress_stream_ts !== input.streamTs) {
      throw new Error(`Turn ${input.turnId} no longer owns Agent stream ${input.streamTs}.`);
    }
    try {
      if (hasAgentProgressMessages(input.turnId)) {
        // Replay any prior desired snapshot before adding terminal chunks. A
        // failed known-message update is safe to retry, an uncertain post isn't.
        await projectAgentProgressMessages(progressMessageClient, input.turnId);
        queueAgentProgressMessages(input.turnId, input.chunks, true);
        await projectAgentProgressMessages(progressMessageClient, input.turnId);
        await setSlackAgentSessionActive(input.client, input.channel, stream.slack_thread_ts);
        markTurnProgressStreamStopped(input.turnId);
        return;
      }
      await agentProgressSlackCall(input.client, "chat.stopStream", {
        channel: input.channel,
        ts: input.streamTs,
        chunks: legacyProgressChunks(input.chunks),
      }, { channel: input.channel });
      await setSlackAgentSessionActive(input.client, input.channel, stream.slack_thread_ts);
      markTurnProgressStreamStopped(input.turnId);
      return;
    } catch (error) {
      if (["message_not_in_streaming_state", "already_stopped", "stopped_by_user"].includes(slackErrorCode(error))) {
        await setSlackAgentSessionActive(input.client, input.channel, stream.slack_thread_ts);
        markTurnProgressStreamStopped(input.turnId);
        return;
      }
      parkTurnProgressStream(input.turnId, `Agent progress finalization failed: ${String(error)}`);
      if (!isTransientSlackError(error)) throw error;
      await waitForNoticeRetry(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  }
  throw new Error(`Agent progress finalization for turn ${input.turnId} was interrupted by service drain.`);
}

function rootSummaryProjectionRow(row: NonNullable<ReturnType<typeof getSlackRootSummaryProjection>>) {
  return {
    ...row,
    slack_status_msg_ts: row.root_message_ts,
    message_generation: 0,
  };
}

async function scheduleSlackRootSummaryProjection(
  client: any,
  channel: string,
  threadTs: string,
): Promise<"delivered" | "stopped" | "permanent_failure"> {
  const key = `${channel}:${threadTs}`;
  const existing = activeRootSummaryProjectionTasks.get(key);
  if (existing) {
    await existing;
    const latest = getSlackRootSummaryProjection(channel, threadTs);
    if (!draining && latest?.projection_status === "pending") {
      return scheduleSlackRootSummaryProjection(client, channel, threadTs);
    }
    if (latest?.projection_status === "delivered") return "delivered";
    if (latest?.projection_status === "parked") return "permanent_failure";
    return "stopped";
  }

  const task = runSlackThreadStatusProjection({
    load: async () => {
      const row = await persistThreadStatusState(() => getSlackRootSummaryProjection(channel, threadTs));
      return row ? rootSummaryProjectionRow(row) : null;
    },
    claim: async (nowMs) => {
      const row = await persistThreadStatusState(
        () => claimSlackRootSummaryProjection(channel, threadTs, nowMs),
      );
      return row ? rootSummaryProjectionRow(row) : null;
    },
    update: async (row) => {
      await slackCall(client, "chat.update", {
        token: cfg.user_token,
        channel,
        ts: row.slack_status_msg_ts,
        text: row.desired_text,
      }, { channel });
    },
    post: async () => {
      throw new Error("A root summary projection cannot create a replacement Slack message.");
    },
    recordMessage: async () => {},
    replaceMissingMessage: async () => {},
    markDelivered: (row) => persistThreadStatusState(
      () => markSlackRootSummaryProjectionDelivered(channel, threadTs, row.desired_revision),
    ),
    markRetry: (row, error, nextAttemptMs) => persistThreadStatusState(
      () => markSlackRootSummaryProjectionRetry(channel, threadTs, row.desired_revision, error, nextAttemptMs),
    ),
    markParked: (row, error) => persistThreadStatusState(
      () => parkSlackRootSummaryProjection(channel, threadTs, row.desired_revision, error),
    ),
    isMissingUpdateError: () => false,
    isMissingDuplicateError: () => false,
    isRetryable: isTransientSlackError,
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
  }).finally(() => {
    if (activeRootSummaryProjectionTasks.get(key) === task) {
      activeRootSummaryProjectionTasks.delete(key);
    }
  });
  activeRootSummaryProjectionTasks.set(key, task);
  return task;
}

async function projectSlackRootSummary(input: {
  client: any;
  channel: string;
  threadTs: string;
  turnId: number;
  text: string;
}) {
  await persistThreadStatusState(() => requestSlackRootSummaryProjection(input));
  return scheduleSlackRootSummaryProjection(input.client, input.channel, input.threadTs);
}

function scheduleDurableNotice(key: string, run: () => Promise<void>) {
  return runKeyedDurableTask(key, run);
}

function scheduleSteeringNotification(client: any, steeringMessageId: number, user?: string | null) {
  return scheduleDurableNotice(`steering:${steeringMessageId}`, async () => {
    const outcome = await runDurableNoticeWorker({
      load: () => {
        const row = getSteeringNotification(steeringMessageId);
        return row && {
          ...row,
          noticeStatus: row.notice_status,
          attempts: row.notice_attempts,
          nextAttemptMs: row.notice_next_attempt_ms,
        };
      },
      claim: (nowMs) => {
        const row = claimSteeringNotification(steeringMessageId, nowMs);
        return row && {
          ...row,
          noticeStatus: row.notice_status,
          attempts: row.notice_attempts,
          nextAttemptMs: row.notice_next_attempt_ms,
        };
      },
      deliver: async (claimed) => {
        if (claimed.status === "sent") {
          try {
            await slackCall(client, "reactions.add", {
              channel: claimed.slack_channel_id,
              timestamp: claimed.slack_user_msg_ts,
              name: "arrow_right_hook",
            }, { channel: claimed.slack_channel_id, user: user || undefined });
          } catch (error) {
            if (slackErrorCode(error) !== "already_reacted") throw error;
          }
          return;
        }
        await slackCall(client, "chat.postMessage", {
          channel: claimed.slack_channel_id,
          thread_ts: claimed.slack_thread_ts,
          text: steeringFailureNoticeText(claimed),
          client_msg_id: deterministicSlackClientMessageId(
            `slack-concierge:steering-failure-notice:${claimed.id}`,
          ),
        }, { channel: claimed.slack_channel_id, user: user || undefined });
      },
      markDelivered: () => markSteeringNotificationDelivered(steeringMessageId),
      markRetry: (error, nextAttemptMs) => markSteeringNotificationRetry(
        steeringMessageId,
        error,
        nextAttemptMs,
      ),
      markParked: (error) => parkSteeringNotification(steeringMessageId, error),
      isRetryable: isTransientSlackError,
      shouldStop: () => draining,
      wait: waitForNoticeRetry,
    });
    if (outcome !== "delivered") {
      log(outcome === "permanent_failure" ? "error" : "warn", "turn_steering_notification_stopped", {
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
            ? "Concierge preserved this message during an interrupted deployment handoff. It is awaiting recovery; you do not need to resend it."
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
        await deliverInlineCaptureConfirmation({
          client,
          channel: claimed.slack_channel_id,
          threadTs: claimed.slack_thread_ts,
          userMessageTs: claimed.slack_user_msg_ts,
          userText: claimed.user_text || "",
          userId: claimed.user_id,
          messageClientId: deterministicSlackClientMessageId(
            `slack-concierge:inline-capture-confirmation:${claimed.slack_channel_id}:${claimed.slack_user_msg_ts}`,
          ),
        });
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

app.command("/todo", async ({ ack, respond, command }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /todo <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  appendTodo(channel, text, `/todo by ${command.user_name || command.user_id}`);
  todoFileWatcher?.schedule(channel, "capture");
  await respond({ text: `Todo added: ${text}`, response_type: "ephemeral" });
});

app.command("/note", async ({ ack, respond, command, client }) => {
  await ack();
  const text = command.text.trim();
  if (!text) return respond({ text: "usage: /note <text>", response_type: "ephemeral" });
  const channel = await ensureChannelFromCommand(command);
  const file = appendInbox(channel, text, `/note by ${command.user_name || command.user_id}`);
  await respond({ text: `note appended to ${file}`, response_type: "ephemeral" });
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
        id: parent.id,
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
      sourceMessageExcerpt: forkSourceExcerpt(
        requestedTs ? getForkSourceMessagePreview(command.channel_id, requestedTs) : null,
      ),
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

async function handleInlineFork(input: {
  channelId: string;
  channelName?: string;
  user: string;
  client: any;
  threadTs: string;
  userMsgTs: string;
  claimToken: string;
}) {
  let inputClassified = false;
  let notice: string | null = null;
  const classifyAction = async () => {
    if (inputClassified) return;
    const classified = await retryTransientDatabaseOperation({
      operation: () => classifySlackUserInput(
        input.channelId,
        input.userMsgTs,
        input.claimToken,
        "ignored",
      ),
    });
    if (classified.stopped || !classified.value) {
      throw new Error("Inline fork action could not be durably classified.");
    }
    inputClassified = true;
  };

  try {
    await waitForForkBinding({
      channelId: input.channelId,
      threadTs: input.threadTs,
      shouldStop: () => draining,
    });
    const channel = getChannel(input.channelId)
      || ensureChannelProject(input.channelId, input.channelName || input.channelId);
    const parent = resolveForkParentSession(input.channelId, input.threadTs);
    log("info", "inline_fork_parent_resolved", {
      channel: input.channelId,
      source_thread_ts: input.threadTs,
      parent_session_id: parent?.id || null,
      parent_thread_ts: parent?.slack_thread_ts || null,
    });
    if (!parent?.agent_session_uuid) {
      notice = unavailableForkSourceMessage(
        input.channelId,
        input.threadTs,
        "No complete persisted session found to fork in this thread.",
      );
    } else {
      const cwd = channel.code_path || channel.vault_path;
      const lastProviderTurnId = await resolveExactForkTurnId({
        parent: {
          id: parent.id,
          provider_id: parent.provider_id as ProviderId,
          agent_session_uuid: parent.agent_session_uuid,
        },
        boundary: null,
        cwd,
        requireBoundary: false,
      });
      const claim = claimForkRequest({
        requestId: `slack-inline-fork:${input.channelId}:${input.userMsgTs}`,
        channelId: input.channelId,
        requestedBy: input.user,
        sourceSessionId: parent.id,
        providerId: parent.provider_id as ProviderId,
        sourceProviderSessionUUID: parent.agent_session_uuid,
        lastProviderTurnId,
        cwd,
        additionalDirs: parseAdditionalPaths(channel),
      });
      await classifyAction();
      const request = await executeForkRequest({
        requestId: claim.row.request_id,
        client: input.client,
        instanceId,
        shouldStop: () => draining,
      });
      if (request.status !== "delivered") notice = forkRequestResultMessage(request);
    }
  } catch (error) {
    log("error", "inline_fork_failed", {
      ...errorFields(error),
      channel: input.channelId,
      source_thread_ts: input.threadTs,
      slack_user_msg_ts: input.userMsgTs,
    });
    notice = `fork failed: ${(error as Error).message}`;
  } finally {
    await classifyAction();
  }

  if (notice) {
    await slackCall(input.client, "chat.postEphemeral", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      user: input.user,
      text: notice,
    }, { channel: input.channelId, user: input.user });
  }
}

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
    if (todo) {
      appendTodo(
        input.channel,
        todo[1],
        `inline by ${input.user}`,
        captureKey,
        cfg.signing_secret,
        { channel: input.channel.slack_channel_id, ts: input.userMsgTs },
      );
    }
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
    if (todo) todoFileWatcher?.schedule(input.channel, "capture");
    const skippedList = await retryTransientDatabaseOperation({
      operation: () => markInlineCaptureListSkipped(
        input.channel.slack_channel_id,
        input.userMsgTs,
        input.claimToken,
        todo
          ? "Slack List projection is owned asynchronously by the canonical TODO file watcher."
          : "Inbox notes are not TODOs and are not projected to Slack Lists.",
      ),
    });
    if (skippedList.stopped || !skippedList.value) {
      throw new Error("Inline capture List skip state could not be persisted.");
    }
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

async function projectTodos(
  client: any,
  channel: NonNullable<ReturnType<typeof getChannel>>,
  user: string | null,
) {
  if (!todoProjectionManager) throw new Error("TODO projection is not initialized.");
  return todoProjectionManager.reconcile({ client, channel, user });
}

async function ensureChannelSurfaces(
  client: any,
  channel: NonNullable<ReturnType<typeof getChannel>>,
  user: string | null,
  reason: string,
) {
  const canvas = await syncCommittedAgentsCanvas({ client, channel, user, reason, force: true });
  if (canvas.status === "ignored") await syncAgentsCanvas({ client, channel, user, reason });
  canvasCommitWatcher?.watchChannel(channel);
  todoFileWatcher?.watchChannel(channel);
  todoFileWatcher?.schedule(channel, "channel-created");
}

type TurnRunOutcome =
  | { status: "delivered"; turnId: number }
  | { status: "queued" | "retry_queued" | "provider_parked" | "draining" | "duplicate" | "ignored" | "steered" | "delivery_stopped" | "delivery_parked"; turnId?: number }
  | { status: "error"; turnId?: number; error: string };

function scheduleFailedTurnCleanup(turnId: number) {
  void scheduleSlackTurnStatusProjection(app.client, turnId);
  schedulePersistedTurnReactionCleanup(turnId);
}

function schedulePersistedTurnReactionCleanup(turnId: number) {
  void scheduleTurnReactionCleanup(app.client, turnId, {
    shouldStop: () => draining,
    wait: waitForNoticeRetry,
  }).catch((error) => {
    log("error", "turn_reaction_cleanup_worker_failed", {
      ...errorFields(error),
      turn_id: turnId,
    });
  });
}

function settleClaimedTurnSetupFailure(claim: Pick<QueuedTurnClaimRow, "turn_id" | "session_id" | "slack_channel_id" | "dispatch_attempt">, error: unknown) {
  const message = String(error);
  if (parkRunningTurnAfterProviderFailure({
    turnId: claim.turn_id,
    ownerInstanceId: instanceId,
    dispatchAttempt: claim.dispatch_attempt,
    failureClass: "parked_terminal",
    error: message,
    statusText: `Status: parked - dispatch setup failed; input preserved as turn ${claim.turn_id} until resumed`,
  })) {
    scheduleFailedTurnCleanup(claim.turn_id);
  }
  log("error", "queued_turn_setup_failed", {
    ...errorFields(error),
    turn_id: claim.turn_id,
    session_id: claim.session_id,
    channel: claim.slack_channel_id,
  });
}

async function runClaimedTurn(input: ClaimedTurnInput): Promise<TurnRunOutcome> {
  log("info", "session_turn_lock_acquired", {
    session_id: input.session.id,
    channel: input.channelId,
    thread_ts: input.threadTs,
    slack_user_msg_ts: input.userMsgTs,
    provider: input.providerId,
    model: input.model || null,
  });
  return activeTurnDispatch.run(input, async (steeringController, closeSteering, cancellationController) => (
    executeAgentTurn({
      turnId: input.turnId,
      session: input.session,
      channel: input.channel,
      channelId: input.channelId,
      threadTs: input.threadTs,
      userMsgTs: input.userMsgTs,
      user: input.user,
      text: input.text,
      prompt: input.prompt,
      files: input.files,
      client: input.client,
      provider: providers[input.providerId],
      providerId: input.providerId,
      providerLabel: input.providerLabel,
      model: input.model || undefined,
      reasoningEffort: input.reasoningEffort || undefined,
      sessionThreadTs: input.sessionThreadTs,
      sessionMode: input.sessionMode,
      hydrateSlackLinks: input.hydrateSlackLinks,
      baseSystemPrompt: input.baseSystemPrompt,
      cwd: input.channel.code_path || input.channel.vault_path,
      additionalDirs: parseAdditionalPaths(input.channel),
      botToken: cfg.bot_token,
      ownerInstanceId: instanceId,
      projectionMode: input.projectionMode,
      recipientTeamId: input.projectionMode === "agent" ? myTeamId || undefined : undefined,
      dispatchAttempt: input.dispatchAttempt,
      turnKind: input.turnKind,
      providerEnvironment: input.providerEnvironment,
      beforeProviderAdmission: input.beforeProviderAdmission,
      steeringController,
      cancellationController,
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
        scheduleTurnStatusProjection: scheduleSlackTurnStatusProjection,
        providerSessionBound: (providerThreadUuid) => (
          codexRemoteObserver?.providerSessionBound(providerThreadUuid) ?? Promise.resolve()
        ),
        startAgentProgress: startSlackAgentProgress,
        appendAgentProgress: appendSlackAgentProgress,
        stopAgentProgress: stopSlackAgentProgress,
        renewAgentProgress: renewSlackAgentProgress,
        setAgentSessionStatus: setSlackAgentSessionStatus,
        projectRootSummary: projectSlackRootSummary,
      },
    })
  ));
}

async function runPersistedQueuedTurn(claim: QueuedTurnClaimRow) {
  return executePersistedQueuedTurn(claim, {
    buildInput: (queuedClaim) => buildQueuedTurnInput(queuedClaim, {
      client: app.client,
      getSessionById,
      getChannel,
      baseSystemPromptForText: (text) => skillPrompt(selectSkill(text)),
    }),
    run: runClaimedTurn,
    fail: (queuedClaim, error) => {
      settleClaimedTurnSetupFailure(queuedClaim, error);
      return { status: "provider_parked", turnId: queuedClaim.turn_id } as TurnRunOutcome;
    },
  });
}

function startSessionTurnQueue() {
  if (sessionTurnQueue) return;
  sessionTurnQueue = new SessionTurnQueueCoordinator({
    claim: () => claimNextQueuedTurn(instanceId),
    run: runPersistedQueuedTurn,
    shouldStop: () => draining,
    onError: (claim, error) => settleClaimedTurnSetupFailure(claim, error),
  });
  sessionTurnQueue.wake();
}

async function handleUserMessage(opts: UserTurnDispatchOptions): Promise<TurnRunOutcome> {
  activeInputHandlerCount += 1;
  try {
  const inputClaimToken = randomUUID();
  const inputPolicy = turnInputPolicy(opts.prebuiltPrompt === true);
  const inlineForkRequested = inputPolicy.handleInlineCapture
    && opts.threadTs !== opts.userMsgTs
    && isInlineForkAction(opts.text);
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
        void scheduleSteeringNotification(opts.client, steeringMessage.id, opts.user);
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
  const steeringDispatch = activeTurnDispatch.dispatchSteering(
    opts.channel,
    opts.threadTs,
    async (activeSteeringTarget): Promise<TurnRunOutcome> => {
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
    const accepted = activeSteeringTarget.controller.enqueue({
      clientMessageId: `slack-concierge:steer:${opts.channel}:${opts.userMsgTs}`,
      text: steeringPrompt,
      prepareText: async (attachmentRoot) => {
        if (!attachmentRoot) throw new Error("The active turn has no attachment directory.");
        const prepared = await prepareProviderInput({
          prompt: steeringPrompt,
          text: opts.text,
          files: steeringFiles,
          botToken: cfg.bot_token,
          channel: opts.channel,
          messageTs: opts.userMsgTs,
          threadTs: opts.threadTs,
          client: opts.client,
          user: opts.user,
          hydrateSlackLinks: !opts.prebuiltPrompt,
          attachmentRoot,
        });
        updateTurnSteeringReplayText(steeringMessage.row.id, prepared.replayText, prepared.unreplayableAttachmentCount);
        return prepared.prompt;
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
        void scheduleSteeringNotification(opts.client, steeringMessage.row.id, opts.user);
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
        void scheduleSteeringNotification(opts.client, steeringMessage.row.id, opts.user);
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
        if (noticeReady) void scheduleSteeringNotification(opts.client, steeringMessage.row.id, opts.user);
      },
    });
    if (!accepted) {
      await persistSteeringTransition(
        `closed-failed:${steeringMessage.row.id}`,
        () => markTurnSteeringMessageFailed(steeringMessage.row.id, "The provider turn already ended."),
      );
      void scheduleSteeringNotification(opts.client, steeringMessage.row.id, opts.user);
      return { status: "error", turnId: activeSteeringTarget.turnId, error: "Provider turn already ended." };
    }

    return { status: "steered", turnId: activeSteeringTarget.turnId };
    },
  );
  if (steeringDispatch.matched) {
    return await steeringDispatch.value;
  }

  if (inlineForkRequested) {
    await handleInlineFork({
      channelId: opts.channel,
      channelName: opts.channelName,
      user: opts.user,
      client: opts.client,
      threadTs: opts.threadTs,
      userMsgTs: opts.userMsgTs,
      claimToken: inputClaimToken,
    });
    return { status: "ignored" };
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

  // Ordinary historical rows retain their identity without overriding the
  // channel's current mode. Only deliberate forks/comparisons stay isolated.
  const visibleThreadSession = getSessionForThread(opts.channel, opts.threadTs);
  const effectiveSessionMode = effectiveSessionModeForMessage({
    channelSessionMode: channel.session_mode,
    forceNewSession: opts.forceNewSession,
    hasIsolatedThreadSession: channel.session_mode === "single-persistent"
      && isIsolatedSessionThread(opts.channel, opts.threadTs),
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
    {
      userId: opts.user,
      providerModel: selectedModel,
      reasoningEffort: selectedReasoningEffort,
      turnKind: opts.prebuiltPrompt ? "comparison" : "slack_user",
      comparisonRequestId: opts.comparisonRequestId,
      projectionMode: "agent",
      deferProvider: draining,
    },
  );
  scheduleAgentSessionsHomeRefresh(opts.user);
  if (turn.duplicate) {
    log("info", "duplicate_turn_skipped", { session_id: session.id, slack_user_msg_ts: opts.userMsgTs });
    return { status: "duplicate", turnId: turn.id };
  }
  if (turn.queued) {
    log("info", "session_turn_queued", {
      session_id: session.id,
      turn_id: turn.id,
      channel: opts.channel,
      thread_ts: opts.threadTs,
      slack_user_msg_ts: opts.userMsgTs,
      provider: selectedProvider,
      model: selectedModel || null,
    });
    sessionTurnQueue?.wake();
    return { status: "queued", turnId: turn.id };
  }
  return runClaimedTurn({
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
    providerId: selectedProvider,
    providerLabel,
    model: selectedModel,
    reasoningEffort: selectedReasoningEffort,
    sessionThreadTs,
    sessionMode: effectiveSessionMode,
    hydrateSlackLinks: inputPolicy.hydrateSlackLinks,
    baseSystemPrompt: skillPrompt(skill),
    turnKind: opts.prebuiltPrompt ? "comparison" : "slack_user",
    dispatchAttempt: turn.dispatchAttempt,
    projectionMode: "agent",
  });
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

app.event("app_home_opened", async ({ event, client }: any) => {
  if (event.tab && event.tab !== "home") return;
  openedAgentSessionsHomeUsers.add(event.user);
  try {
    await publishAgentSessionsHome(client, event.user);
  } catch (error) {
    log("error", "agent_sessions_home_publish_failed", { user_id: event.user, ...errorFields(error) });
  }
});

app.event("agent_session_title_changed" as any, async ({ event, body }: any) => {
  if (!myTeamId || body.team_id !== myTeamId || !event.channel || !event.thread_ts || !event.title) return;
  try {
    observeSlackAgentSessionTitle({
      channel: event.channel,
      threadTs: event.thread_ts,
      title: event.title,
    });
    if (event.user) scheduleAgentSessionsHomeRefresh(event.user, "Session name updated in Slack.");
  } catch (error) {
    log("error", "agent_session_title_change_failed", {
      channel: event.channel,
      thread_ts: event.thread_ts,
      ...errorFields(error),
    });
  }
});

app.action(APP_HOME_REFRESH_ACTION_ID, async ({ ack, body, client }: any) => {
  await ack();
  const userId = body.user?.id;
  if (!userId) return;
  openedAgentSessionsHomeUsers.add(userId);
  try {
    await publishAgentSessionsHome(client, userId, "Dashboard refreshed.");
  } catch (error) {
    log("error", "agent_sessions_home_manual_refresh_failed", { user_id: userId, ...errorFields(error) });
  }
});

app.action(APP_HOME_STOP_ACTION_ID, async ({ ack, body, action }: any) => {
  await ack();
  const userId = body.user?.id;
  const target = parseAgentSessionActionTarget(action.value);
  const row = userId && target ? getAgentSessionDashboardRowForUser(userId, target.sessionId) : null;
  log("info", "agent_sessions_home_stop_received", {
    user_id: userId || null,
    session_id: target?.sessionId || null,
    target_turn_id: target?.turnId || null,
    current_turn_id: row?.turn_id || null,
    current_turn_status: row?.turn_status || null,
    has_action_ts: Boolean(body.action_ts || action.action_ts),
  });
  if (!userId || !target || !row || row.slack_channel_id !== target.channel
    || row.slack_thread_ts !== target.threadTs || row.turn_id !== target.turnId) {
    log("warn", "agent_sessions_home_stop_stale", {
      user_id: userId || null,
      session_id: target?.sessionId || null,
      target_turn_id: target?.turnId || null,
    });
    if (userId) scheduleAgentSessionsHomeRefresh(userId, "That session changed. The dashboard has been refreshed.");
    return;
  }
  const eventTs = String(body.action_ts || action.action_ts || "");
  const dispatched = activeTurnDispatch.dispatchSteering(target.channel, target.threadTs, (activeTarget) => {
    if (activeTarget.turnId !== target.turnId || !requestAgentStopForSession({
      turnId: activeTarget.turnId,
      channel: target.channel,
      threadTs: target.threadTs,
      eventTs,
    })) return null;
    return activeTarget.cancellation.request();
  });
  if (!dispatched.matched || !dispatched.value) {
    log("warn", "agent_sessions_home_stop_not_running", {
      session_id: target.sessionId,
      turn_id: target.turnId,
      matched_active_dispatch: dispatched.matched,
    });
    scheduleAgentSessionsHomeRefresh(userId, "That turn is no longer running.");
    return;
  }
  log("info", "agent_sessions_home_stop_requested", {
    session_id: target.sessionId,
    turn_id: target.turnId,
  });
  scheduleAgentSessionsHomeRefresh(userId, "Stop requested. Concierge is closing the provider turn safely.");
  void dispatched.value.catch((error) => {
    log("warn", "agent_sessions_home_stop_failed", { turn_id: target.turnId, ...errorFields(error) });
    scheduleAgentSessionsHomeRefresh(userId, "Concierge could not confirm the stop request. Open the thread to check its state.");
  });
});

app.action(APP_HOME_RENAME_ACTION_ID, async ({ ack, body, action, client }: any) => {
  await ack();
  const userId = body.user?.id;
  const target = parseAgentSessionActionTarget(action.value);
  const row = userId && target ? getAgentSessionDashboardRowForUser(userId, target.sessionId) : null;
  log("info", "agent_sessions_home_rename_received", {
    user_id: userId || null,
    session_id: target?.sessionId || null,
    has_trigger_id: Boolean(body.trigger_id),
  });
  if (!userId || !target || !row || row.slack_channel_id !== target.channel
    || row.slack_thread_ts !== target.threadTs) {
    if (userId) scheduleAgentSessionsHomeRefresh(userId, "That session changed. The dashboard has been refreshed.");
    return;
  }
  try {
    await slackCall(client, "views.open", {
      trigger_id: body.trigger_id,
      view: buildRenameAgentSessionModal(row),
    }, { user: userId });
  } catch (error) {
    log("error", "agent_sessions_home_rename_modal_failed", {
      session_id: row.session_id,
      ...errorFields(error),
    });
    scheduleAgentSessionsHomeRefresh(userId, "The rename dialog could not be opened. Please try again.");
  }
});

app.view(APP_HOME_RENAME_VIEW_ID, async ({ ack, body, view, client }: any) => {
  const submission = parseRenameAgentSessionSubmission(view);
  const userId = body.user?.id;
  const row = userId && submission
    ? getAgentSessionDashboardRowForUser(userId, submission.target.sessionId)
    : null;
  if (!submission || !row || row.slack_channel_id !== submission.target.channel
    || row.slack_thread_ts !== submission.target.threadTs) {
    await ack();
    if (userId) scheduleAgentSessionsHomeRefresh(userId, "That session changed before it was renamed.");
    return;
  }
  requestSlackAgentSessionTitleProjection({
    channel: row.slack_channel_id,
    threadTs: row.slack_thread_ts,
    title: submission.title,
  });
  await ack();
  scheduleAgentSessionsHomeRefresh(userId, `Renaming session to “${submission.title}”…`);
  void scheduleSlackAgentSessionTitleProjection(client, row.slack_channel_id, row.slack_thread_ts)
    .then((outcome) => scheduleAgentSessionsHomeRefresh(
      userId,
      outcome === "delivered" ? "Session renamed." : "Slack could not apply that session name.",
    ));
});

app.action(APP_HOME_RETRY_ACTION_ID, async ({ ack, body, action }: any) => {
  await ack();
  const userId = body.user?.id;
  const target = parseAgentSessionActionTarget(action.value);
  const row = userId && target ? getAgentSessionDashboardRowForUser(userId, target.sessionId) : null;
  if (!userId || !target || !row || row.slack_channel_id !== target.channel
    || row.slack_thread_ts !== target.threadTs || row.turn_id !== target.turnId || !row.retryable) {
    if (userId) scheduleAgentSessionsHomeRefresh(userId, "That turn is no longer safe to retry.");
    return;
  }
  const outcome = resumeParkedSessionTurn(target.turnId!);
  if (outcome === "resumed" || outcome === "already_queued") sessionTurnQueue?.wake();
  scheduleAgentSessionsHomeRefresh(userId, outcome === "resumed" || outcome === "already_queued"
    ? "Turn queued for retry."
    : "That turn is no longer safe to retry.");
});

app.action(APP_HOME_FORK_ACTION_ID, async ({ ack, body, action, client }: any) => {
  await ack();
  const userId = body.user?.id;
  const target = parseAgentSessionActionTarget(action.value);
  const row = userId && target ? getAgentSessionDashboardRowForUser(userId, target.sessionId) : null;
  if (!userId || !target || !row || row.slack_channel_id !== target.channel
    || row.slack_thread_ts !== target.threadTs || row.turn_id !== target.turnId) {
    if (userId) scheduleAgentSessionsHomeRefresh(userId, "That session changed. The dashboard has been refreshed.");
    return;
  }
  try {
    const parent = getSessionById(row.session_id);
    if (!parent || parent.slack_channel_id !== row.slack_channel_id
      || parent.slack_thread_ts !== row.slack_thread_ts || !parent.agent_session_uuid) {
      throw new Error("This session no longer has a stable provider boundary to fork.");
    }
    let lastProviderTurnId: string | null = null;
    if (parent.provider_id === "codex") {
      if (!target.forkProviderTurnId
        || !sessionOwnsCompletedProviderTurn(parent.id, target.forkProviderTurnId)) {
        throw new Error("This session does not yet have a completed Codex turn to fork.");
      }
      lastProviderTurnId = target.forkProviderTurnId;
    } else {
      const settledParent = resolveForkParentSession(row.slack_channel_id, row.slack_thread_ts);
      if (!settledParent || settledParent.id !== parent.id) {
        throw new Error("Claude Code can be forked only after its active turn settles.");
      }
    }
    const channel = getChannel(row.slack_channel_id);
    if (!channel) throw new Error("This session's channel is no longer registered.");
    const claim = claimForkRequest({
      requestId: body.trigger_id,
      channelId: row.slack_channel_id,
      requestedBy: userId,
      sourceSessionId: parent.id,
      sourceMessageTs: null,
      sourceMessageExcerpt: forkSourceExcerpt(row.user_text),
      providerId: parent.provider_id,
      sourceProviderSessionUUID: parent.agent_session_uuid,
      lastProviderTurnId,
      cwd: channel.code_path || channel.vault_path,
      additionalDirs: parseAdditionalPaths(channel),
    });
    scheduleAgentSessionsHomeRefresh(userId, "Creating a fork from the latest complete provider history…");
    const request = await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId,
      shouldStop: () => draining,
    });
    scheduleAgentSessionsHomeRefresh(userId, forkRequestResultMessage(request));
  } catch (error) {
    log("error", "agent_sessions_home_fork_failed", {
      session_id: row.session_id,
      ...errorFields(error),
    });
    scheduleAgentSessionsHomeRefresh(userId, `Fork failed: ${(error as Error).message}`);
  }
});

app.event("agent_session_stopped" as any, async ({ event, body }: any) => {
  try {
    const outcome = await handleAgentSessionStop({
      event, teamId: body.team_id, expectedTeamId: myTeamId, registry: activeTurnDispatch,
    });
    log("info", `agent_session_stop_${outcome}`, { channel: event.channel, thread_ts: event.thread_ts });
  } catch (error) {
    log("error", "agent_session_stop_dispatch_failed", {
      ...errorFields(error),
      channel: event.channel,
      thread_ts: event.thread_ts,
    });
  }
});

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
  const file = appendTodo(
    channel,
    s.message.text || "",
    `shortcut by ${s.user.id}`,
    undefined,
    undefined,
    { channel: s.channel.id, ts: s.message.ts },
  );
  todoFileWatcher?.schedule(channel, "capture");
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
    assertProviderHistoryReplayable(sourceSession, "comparison");
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
    const comparisonOutcome = await dispatchComparisonTurn({
      requestId,
      channelId: request.channelId,
      channelName: channel.slack_channel_name,
      threadTs: anchor.ts,
      userId,
      text: comparisonPrompt,
      client,
      provider: request.provider,
      model: request.model,
    }, { dispatch: handleUserMessage });
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
        id: parent.id,
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
      sourceMessageExcerpt: forkSourceExcerpt(s.message.text)
        || forkSourceExcerpt(getForkSourceMessagePreview(s.channel.id, selectedMessageTs)),
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
// `/concierge-status` reports uptime on demand.

async function refreshRequiredCanvases() {
  const result = await syncAllAgentsCanvases({
    channels: getSlackChannels(),
    requireSuccess: true,
    sync: async (channel) => {
      const result = await syncCommittedAgentsCanvas({
        client: app.client,
        channel,
        user: null,
        reason: "required_startup",
        force: true,
      });
      return result.status === "ignored"
        ? await syncAgentsCanvas({ client: app.client, channel, user: null, reason: "required_startup" })
        : result;
    },
  });
  log("info", "required_canvas_refresh_complete", {
    refreshed: result.refreshed,
    failures: result.failures,
  });
}

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

async function launchPreparedDeploymentRun(run: DeploymentRunRow) {
  const command = [
    "systemd-run",
    "--unit", run.unit_name,
    "--collect",
    "--no-block",
    "--property=Type=exec",
    "--property=Restart=on-failure",
    "--property=RestartSec=10",
    `--setenv=HOME=${process.env.HOME || "/root"}`,
    `--setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS=${process.env.CONCIERGE_DRAIN_INTERVAL_SECONDS || "2"}`,
    "--setenv=CONCIERGE_DEPLOY_DETACHED=1",
    `--setenv=CONCIERGE_DEPLOY_RUN_ID=${run.id}`,
    "/usr/local/lib/slack-concierge-deployment/control",
    "deploy",
  ];
  const launched = Bun.spawnSync({ cmd: command, stdout: "pipe", stderr: "pipe" });
  if (launched.exitCode === 0) return;
  const loadState = Buffer.from(Bun.spawnSync({
    cmd: ["systemctl", "show", `${run.unit_name}.service`, "--property=LoadState", "--value"],
    stdout: "pipe",
    stderr: "ignore",
  }).stdout).toString("utf8").trim();
  if (loadState && loadState !== "not-found") return;
  throw new Error(Buffer.from(launched.stderr).toString("utf8").trim() || `systemd-run exited ${launched.exitCode}`);
}

async function launchDeploymentRepair(incidentId: string) {
  const unit = `concierge-deployment-repair@${incidentId}.service`;
  const launched = Bun.spawnSync({
    cmd: ["systemctl", "start", unit],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (launched.exitCode !== 0) {
    throw new Error(Buffer.from(launched.stderr).toString("utf8").trim() || `systemctl start ${unit} failed`);
  }
}

const deploymentRepositoryRoot = process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge";
type DeploymentWorkReason = "startup" | "github-push" | "turn-settled" | "state-change";
const deploymentWorkRunner = createCoalescingEventRunner<DeploymentWorkReason>({
  shouldStop: () => draining,
  run: async (reason) => {
    try {
      const result = await reconcileDeploymentWork({
        client: app.client,
        ownerInstanceId: instanceId,
        isOwnerAlive: isProcessIdentityAlive,
        shouldStop: () => draining,
        onTurnReactionSettled: (turnId) => {
          const dashboardUser = getAgentSessionDashboardUserForTurn(turnId);
          if (dashboardUser) scheduleAgentSessionsHomeRefresh(dashboardUser);
        },
        services: {
          launchRun: launchPreparedDeploymentRun,
          launchRepair: launchDeploymentRepair,
        },
      });
      if (result.deadRuns || result.recoveredNotices || result.recoveredReactions
        || result.automaticDeploymentPrepared || result.launched || result.repairsLaunched
        || result.reactionsStarted) {
        log("info", "deployment_work_reconciled", { reason, ...result });
      }
    } catch (error) {
      log("error", "deployment_work_reconciliation_failed", { reason, ...errorFields(error) });
    }
  },
});

function scheduleDeploymentWork(reason: DeploymentWorkReason) {
  if (!runtime.ownership.deployment || !serviceOnline || draining) return;
  void deploymentWorkRunner.request(reason);
}

async function reconcilePriorInstanceTurns() {
  if (runtime.ownership.deployment) {
    const deploymentNoticesRecovered = recoverDeploymentNoticeClaims(isProcessIdentityAlive);
    const deadDeploymentRuns = recoverDeadDeploymentRuns(isProcessIdentityAlive);
    if (deploymentNoticesRecovered || deadDeploymentRuns) {
      log("warn", "deployment_state_recovered", {
        notices_recovered: deploymentNoticesRecovered,
        dead_runs: deadDeploymentRuns,
      });
    }
  }
  await reconcileOrphanedSlackInputs();
  const recoveredStatusClaims = recoverSlackThreadStatusProjectionClaims();
  if (recoveredStatusClaims > 0) {
    log("warn", "slack_thread_status_projections_recovered", { count: recoveredStatusClaims });
  }
  const recoveredTurnStatusClaims = recoverTurnStatusProjectionClaims();
  if (recoveredTurnStatusClaims > 0) {
    log("warn", "turn_status_projections_recovered", { count: recoveredTurnStatusClaims });
  }
  const recoveredRootSummaryClaims = recoverSlackRootSummaryProjectionClaims();
  if (recoveredRootSummaryClaims > 0) {
    log("warn", "slack_root_summary_projections_recovered", { count: recoveredRootSummaryClaims });
  }
  const recoveredAgentSessionStatusClaims = recoverSlackAgentSessionStatusProjectionClaims();
  if (recoveredAgentSessionStatusClaims > 0) {
    log("warn", "agent_session_status_projections_recovered", {
      count: recoveredAgentSessionStatusClaims,
    });
  }
  const recoveredAgentSessionTitleClaims = recoverSlackAgentSessionTitleProjectionClaims();
  if (recoveredAgentSessionTitleClaims > 0) {
    log("warn", "agent_session_title_projections_recovered", {
      count: recoveredAgentSessionTitleClaims,
    });
  }
  const recoveredReactionCleanupClaims = recoverTurnReactionCleanupClaims();
  if (recoveredReactionCleanupClaims > 0) {
    log("warn", "turn_reaction_cleanups_recovered", { count: recoveredReactionCleanupClaims });
  }
  const recoveredArtifactClaims = recoverTurnArtifactDeliveryClaims(isProcessIdentityAlive);
  if (recoveredArtifactClaims > 0) {
    log("warn", "turn_artifact_uploads_recovered_as_ambiguous", { count: recoveredArtifactClaims });
  }
  cleanExpiredArtifactStaging();
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
      stopAgentProgress: stopSlackAgentProgress,
      setAgentSessionStatus: setSlackAgentSessionStatus,
      projectRootSummary: projectSlackRootSummary,
      scheduleWorkingReactionCleanup: (client, turnId) => scheduleTurnReactionCleanup(
        client,
        turnId,
        { shouldStop: () => draining, wait: waitForNoticeRetry },
      ),
    },
  });
  if (recoveryOutcome === "stopped") return;
  recoverSteeringNotificationClaims();
  recoverDeferredSteeringNotifications(isProcessIdentityAlive);
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
  for (const summary of listPendingSlackRootSummaryProjections()) {
    void scheduleSlackRootSummaryProjection(
      app.client,
      summary.slack_channel_id,
      summary.slack_thread_ts,
    );
  }
  for (const status of listPendingSlackAgentSessionStatusProjections()) {
    void scheduleSlackAgentSessionStatusProjection(
      app.client,
      status.slack_channel_id,
      status.slack_thread_ts,
    );
  }
  for (const title of listPendingSlackAgentSessionTitleProjections()) {
    void scheduleSlackAgentSessionTitleProjection(
      app.client,
      title.slack_channel_id,
      title.slack_thread_ts,
    );
  }
  for (const cleanup of listPendingTurnReactionCleanups()) {
    schedulePersistedTurnReactionCleanup(cleanup.turn_id);
  }
  for (const artifact of listPendingTurnArtifactDeliveries()) {
    void schedulePersistedArtifactDelivery(artifact.artifact_id);
  }
  for (const notice of listPendingSteeringNotifications()) {
    void scheduleSteeringNotification(app.client, notice.id);
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

setInterval(() => {
  if (draining) return;
  sessionTurnQueue?.wake();
  for (const artifact of listPendingTurnArtifactDeliveries()) {
    void schedulePersistedArtifactDelivery(artifact.artifact_id);
  }
  for (const status of listPendingTurnStatusProjections()) {
    void scheduleSlackTurnStatusProjection(app.client, status.turn_id);
  }
  for (const summary of listPendingSlackRootSummaryProjections()) {
    void scheduleSlackRootSummaryProjection(
      app.client,
      summary.slack_channel_id,
      summary.slack_thread_ts,
    );
  }
  for (const status of listPendingSlackAgentSessionStatusProjections()) {
    void scheduleSlackAgentSessionStatusProjection(
      app.client,
      status.slack_channel_id,
      status.slack_thread_ts,
    );
  }
  for (const title of listPendingSlackAgentSessionTitleProjections()) {
    void scheduleSlackAgentSessionTitleProjection(
      app.client,
      title.slack_channel_id,
      title.slack_thread_ts,
    );
  }
  for (const cleanup of listPendingTurnReactionCleanups()) {
    schedulePersistedTurnReactionCleanup(cleanup.turn_id);
  }
  cleanExpiredArtifactStaging();
}, 60_000);

async function drainAndStop(signal: string) {
  if (draining) return;
  draining = true;
  serviceOnline = false;
  try {
    clearSandboxReadyReceipt(runtime);
  } catch (error) {
    log("error", "sandbox_readiness_cleanup_failed", errorFields(error));
  }
  sessionTurnQueue?.stop();
  log("info", "service_drain_started", {
    signal,
    active_turns: activeTurnCount,
    active_input_handlers: activeInputHandlerCount,
    instance_id: instanceId,
  });
  if (deploymentEventServer) {
    const server = deploymentEventServer;
    deploymentEventServer = null;
    await server.stop(false);
  }
  if (captureDeliveryWorker) await captureDeliveryWorker.stop();
  if (codexRemoteObserver) await codexRemoteObserver.stop();
  await app.stop();
  if (activeTurnCount > 0 || activeInputHandlerCount > 0) {
    await new Promise<void>((resolve) => { resolveDrained = resolve; });
  }
  const activeDeploymentWork = deploymentWorkRunner.active();
  if (activeDeploymentWork) await activeDeploymentWork;
  canvasCommitWatcher?.close();
  todoFileWatcher?.close();
  await todoProjectionManager?.drain();
  await closeSharedCodexAppServerClient();
  stopProcessInstance(instanceId);
  log("info", "service_drain_complete", { signal, instance_id: instanceId });
  process.exit(0);
}

process.on("SIGTERM", () => { void drainAndStop("SIGTERM"); });
process.on("SIGINT", () => { void drainAndStop("SIGINT"); });
if (runtime.ownership.deployment) {
  process.on("SIGUSR2", () => { scheduleDeploymentWork("state-change"); });
}
sandboxSlackIdentity?.setFailureHandler((error) => {
  log("error", "sandbox_socket_identity_failed", errorFields(error));
  void drainAndStop("sandbox-socket-identity-failed");
});

(async () => {
  try {
    clearSandboxReadyReceipt(runtime);
    let captureQueueToken: string | null = null;
    if (runtime.ownership.captureDelivery) {
      captureQueueToken = runtime.profile === "sandbox"
        ? loadCaptureQueueTokenFromPath(runtime.captureQueueTokenPath!, runtime.stateDir)
        : loadCaptureQueueToken();
      captureDeliveryWorker = new CaptureDeliveryWorker({
        queueUrl: runtime.profile === "sandbox"
          ? runtime.captureQueueUrl!
          : process.env.CONCIERGE_CAPTURE_QUEUE_URL || "http://127.0.0.1:8081",
        queueToken: captureQueueToken,
        slackUserToken: String(cfg.user_token || ""),
        expectedSlackTeamId: runtime.profile === "sandbox" ? runtime.expectedSlackTeamId! : undefined,
        owner: processIdentity,
        onFatal(error) {
          process.exitCode = 1;
          log("error", "capture_delivery_requires_restart", errorFields(error));
          void drainAndStop("capture-worker-fatal");
        },
      });
      await captureDeliveryWorker.prepare();
    }
    const auth: any = await app.client.auth.test();
    const authenticatedAppId = await resolveAuthenticatedSlackAppId(runtime, auth, async (botId) => {
      const botInfo: any = await app.client.bots.info({ bot: botId });
      return botInfo.bot?.app_id;
    });
    assertAuthenticatedSlackIdentity(runtime, { ...auth, app_id: authenticatedAppId });
    myBotUserId = auth.user_id as string;
    myBotId = (auth.bot_id as string) || null;
    myTeamId = (auth.team_id as string) || null;
    if (!myTeamId) throw new Error("Slack auth.test did not return the team id required for Agent streams.");
    myWorkspaceUrl = typeof auth.url === "string" ? auth.url : null;
    if (!myWorkspaceUrl) {
      try {
        const teamInfo: any = await app.client.team.info();
        myWorkspaceUrl = typeof teamInfo.team?.url === "string" ? teamInfo.team.url : null;
      } catch (error) {
        log("warn", "slack_workspace_url_unavailable", errorFields(error));
      }
    }
    todoProjectionManager = new TodoProjectionManager({
      identitySecret: cfg.signing_secret,
      identityOwnerId: myBotUserId || "",
    });
    todoFileWatcher = new TodoFileWatcher(async (channel) => {
      if (draining) return;
      await projectTodos(app.client, getChannel(channel.slack_channel_id) || channel, null);
    });
    canvasCommitWatcher = new ProjectionWatcher({
      name: "canvas_commit",
      startupReason: "startup",
      changedReason: "git-head",
      resolveTarget: committedAgentsWatchTarget,
      project: async (channel, reason) => {
        if (draining) return;
        const result = await syncCommittedAgentsCanvas({
          client: app.client,
          channel,
          user: null,
          reason,
        });
        if (!result.ok) throw new Error(result.error);
      },
      retryMs: null,
    });
    const requireCanvasRefresh = projectCutoverStartup.requireCanvasRefresh;
    await startRecoveredSessionTurnQueue({
      recoverPriorTurns: async () => { await reconcilePriorInstanceTurns(); },
      startRuntime: async () => {
        await startRuntimeWithRequiredCanvasRefresh({
          requireCanvasRefresh,
          refreshCanvases: refreshRequiredCanvases,
          startRuntime: async () => {
            await app.start();
            sandboxSlackIdentity?.assertConnected();
            await captureDeliveryWorker?.start();
            if (runtime.ownership.codexRemote) {
              codexRemoteObserver = new CodexRemoteObserver(
                app.client,
                (channel, threadTs) => scheduleSlackThreadStatusProjection(app.client, channel, threadTs),
              );
            }
          },
        });
      },
      verifyProviderReady: async () => { await verifySharedCodexAppServerReady(); },
      startQueue: () => {
        startSessionTurnQueue();
        codexRemoteObserver?.start();
        const reportOnline = () => log("info", "concierge_bot_online", {
          bot_user_id: myBotUserId,
          bot_id: myBotId,
          token_suffix: String(cfg.bot_token || "").slice(-4),
          git_sha: runtimeGitSha || null,
          ...(runtime.profile === "sandbox" ? { runtime_profile: "sandbox" } : {}),
        });
        if (runtime.profile === "production") reportOnline();
        serviceOnline = true;
        if (runtime.ownership.deployment) {
          if (!captureQueueToken) throw new Error("Deployment ingress requires the production capture credential.");
          deploymentEventServer = startDeploymentEventIngress({
            token: captureQueueToken,
            accept: async (push) => {
              const result = await acceptGitHubDeploymentPush(push, deploymentRepositoryRoot);
              log("info", "github_deployment_push_accepted", {
                delivery_id: push.deliveryId,
                event_commit: result.event_commit,
                desired_commit: result.desired_commit,
                observation: result.observation,
              });
              scheduleDeploymentWork("github-push");
              return result;
            },
          });
          log("info", "deployment_event_ingress_online", {
            hostname: deploymentEventServer.hostname,
            port: deploymentEventServer.port,
          });
          scheduleDeploymentWork("startup");
        }
        const channels = getSlackChannels();
        todoFileWatcher.start(channels);
        canvasCommitWatcher.start(channels);
        log("warn", "canvas_bidirectional_sync_not_supported", {
          reason: "Slack Canvas Web API exposes create/edit and section lookup, but no deterministic raw document read path; Concierge re-renders AGENTS.md to Canvas instead.",
        });
        if (runtime.profile === "sandbox") {
          writeSandboxReadyReceipt(runtime, {
            teamId: myTeamId!,
            botUserId: myBotUserId!,
            botId: myBotId!,
            appId: runtime.expectedSlackAppId!,
          });
          reportOnline();
        }
      },
    });
  } catch (err) {
    try {
      clearSandboxReadyReceipt(runtime);
    } catch (error) {
      log("error", "sandbox_readiness_cleanup_failed", errorFields(error));
    }
    log("error", "concierge_startup_failed", errorFields(err));
    process.exit(1);
  }
})();
