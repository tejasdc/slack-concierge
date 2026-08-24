import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  artifactDirectoryForTurn,
  buildArtifactPromptContext,
  cleanupArtifactDirectoryIfEmpty,
  findTurnArtifacts,
  prepareArtifactDirectory,
  removeArtifactStagingTree,
} from "./artifacts";
import { providerBrokerEnabled, providerProjectScratchPath } from "./provider-broker-client";
import { cleanExpiredArtifactStaging, scheduleTurnArtifactDelivery } from "./artifact-delivery-worker";
import {
  attachmentPrompt,
  cleanupAttachmentBundle,
  downloadSlackFiles,
  type AttachmentBundle,
  type SlackMessageFile,
} from "./attachments";
import { agentsFingerprint } from "./canvas";
import { errorFields, log } from "./log";
import { providerDispatchError, providerRetryDelayMs } from "./provider-failures";
import type { AgentProvider } from "./providers";
import { slackCall } from "./rate-limit";
import { CONCIERGE_SESSION_RESPONSE_CONTRACT } from "./response-contract";
import {
  abandonTurnArtifactBatch,
  createTurnArtifactBatch,
  ensureSlackThreadStatusMessage,
  failRunningTurnAndReleaseSession,
  findLegacySlackThreadStatusMessage,
  finishDeliveredTurn,
  getRunningTurnDispatchBoundary,
  getSlackThreadStatus,
  getRunningTurnDispatchAttempt,
  getTurnArtifactBatch,
  getTurnStatusProjection,
  listTurnArtifactDeliveries,
  listSlackThreadResponses,
  markTurnDeliveryFailed,
  markTurnDelivering,
  markTurnProviderStarted,
  markTurnProviderAdmissionIntended,
  parkRunningTurnAfterProviderFailure,
  retryRunningTurnAfterProviderFailure,
  recordTurnProviderTurnId,
  registerTurnArtifactIntents,
  markTurnResponseDelivered,
  parkSlackThreadStatusProjectionAfterFailure,
  parkTurnDelivery,
  parkTurnStatusProjectionAfterFailure,
  relinquishTurnDelivery,
  setTurnReplayInput,
  bindChannelDefaultSessionUuid,
  upsertSession,
  type ChannelRow,
  type ProviderId,
  type SessionMode,
  type SessionRow,
} from "./state";
import type { TurnSteeringController } from "./steering";
import { ensureTldr, extractTldr, formatTurnStatusMessage, splitSlackText } from "./text";
import { buildSlackThreadSummaryContext, priorSlackThreadTldrs } from "./thread-summary";
import { TurnStatusController } from "./turn-status-controller";
import { isAudioFile, transcribeAudioAttachments, transcriptionPrompt } from "./transcription";
import { slackPermalinkPrompt } from "./slack-links";

export type TurnExecutionOutcome =
  | { status: "delivered" | "delivery_stopped" | "delivery_parked"; turnId: number }
  | { status: "retry_queued" | "provider_parked"; turnId: number }
  | { status: "error"; turnId: number; error: string };

export interface TurnExecutionServices {
  hydrateLegacyThreadOwnership(input: {
    client: any;
    channel: string;
    threadTs: string;
    user?: string;
  }): Promise<number>;
  deliverOutcome(input: {
    turnId: number;
    client: any;
    channel: string;
    threadTs: string;
    text: string;
    user?: string;
  }): Promise<"delivered" | "stopped" | "permanent_failure">;
  projectTurnStatus(input: {
    client: any;
    turnId: number;
    text: string;
    user?: string | null;
  }): Promise<"delivered" | "stopped" | "permanent_failure">;
  projectThreadSummary(input: {
    client: any;
    channel: string;
    threadTs: string;
    turnId: number;
    text: string;
    user?: string | null;
  }): Promise<"delivered" | "stopped" | "permanent_failure">;
  scheduleWorkingReactionCleanup?(client: any, turnId: number): Promise<unknown>;
  scheduleTurnStatusProjection?(client: any, turnId: number, user?: string | null): Promise<unknown>;
  scheduleCanvasRefreshIfChanged(
    client: any,
    channel: ChannelRow,
    user: string | null,
    before: string | null,
    reason: string,
  ): void;
}

export interface TurnExecutionInput {
  turnId: number;
  session: SessionRow;
  channel: ChannelRow;
  channelId: string;
  threadTs: string;
  userMsgTs: string;
  user: string;
  text: string;
  prompt: string;
  files: SlackMessageFile[];
  client: any;
  provider: AgentProvider;
  providerId: ProviderId;
  providerLabel: string;
  model?: string;
  reasoningEffort?: string;
  sessionThreadTs: string;
  sessionMode: SessionMode;
  hydrateSlackLinks: boolean;
  baseSystemPrompt?: string;
  cwd: string;
  additionalDirs: string[];
  botToken: string;
  ownerInstanceId: string;
  turnKind?: "slack_user" | "comparison" | "deployment_verification";
  dispatchAttempt?: number;
  providerEnvironment?: Record<string, string>;
  beforeProviderAdmission?: () => void;
  steeringController: TurnSteeringController;
  closeSteering(reason?: Error): void;
  services: TurnExecutionServices;
  statusIntervalMs?: number;
}

export async function executeAgentTurn(input: TurnExecutionInput): Promise<TurnExecutionOutcome> {
  const turnStart = Date.now();
  const dispatchAttempt = input.dispatchAttempt
    ?? getRunningTurnDispatchAttempt(input.turnId, input.ownerInstanceId)
    ?? 0;
  let agentsBefore: string | null = null;
  let attachmentBundle: AttachmentBundle = { dir: null, files: [] };
  let deliveryStarted = false;
  let responseDeliveryConfirmed = false;
  let deliveryCompleted = false;
  let statusController: TurnStatusController | null = null;
  let statusMessageTs = "";
  let artifactDirectory: string | null = null;
  let artifactBatchCreated = false;
  let providerStarted = false;
  let observedToolCount = 0;
  let preserveWorkingReaction = false;

  try {
    agentsBefore = snapshotAgentsFingerprint(input);
    if (input.turnKind !== "deployment_verification") await addWorkingReaction(input);
    const initialStatusOutcome = await input.services.projectTurnStatus({
      client: input.client,
      turnId: input.turnId,
      text: formatTurnStatusMessage({
        state: "working",
        elapsedMs: 0,
        lastUpdateAgeMs: 0,
        toolCount: 0,
      }),
      user: input.user,
    });
    if (initialStatusOutcome !== "delivered") {
      throw new Error(`Initial turn status projection ${initialStatusOutcome.replaceAll("_", " ")}.`);
    }
    statusMessageTs = getTurnStatusProjection(input.turnId)?.slack_status_msg_ts || "";
    if (!statusMessageTs) throw new Error("Slack did not return a timestamp for the turn status message.");

    statusController = new TurnStatusController({
      startedAt: turnStart,
      intervalMs: input.statusIntervalMs,
      updateHeartbeat: async ({ text }) => {
        await slackCall(input.client, "chat.update", {
          channel: input.channelId,
          ts: statusMessageTs,
          text,
        }, { channel: input.channelId, user: input.user });
      },
      projectTerminal: ({ text }) => input.services.projectTurnStatus({
        client: input.client,
        turnId: input.turnId,
        text,
        user: input.user,
      }),
      onError: (error, phase) => {
        log("warn", "turn_status_update_failed", {
          ...errorFields(error),
          channel: input.channelId,
          turn_id: input.turnId,
          phase,
        });
      },
    });
    statusController.start();

    const artifactOwnershipToken = randomUUID();
    artifactDirectory = artifactDirectoryForTurn(input.cwd, input.turnId, artifactOwnershipToken);
    createTurnArtifactBatch(input.turnId, artifactOwnershipToken, artifactDirectory);
    artifactBatchCreated = true;
    prepareArtifactDirectory(input.cwd, input.turnId, artifactOwnershipToken);

    const previousThreadTldrs = await hydrateThreadOwnership(input, statusMessageTs);
    const preparedTurn = await prepareProviderTurn(input, artifactDirectory, previousThreadTldrs);
    attachmentBundle = preparedTurn.attachmentBundle;
    const recordProviderStarted = () => {
      if (providerStarted) return;
      providerStarted = true;
      markTurnProviderStarted(input.turnId);
    };
    if (input.beforeProviderAdmission) {
      input.beforeProviderAdmission();
    } else if (!markTurnProviderAdmissionIntended(
      input.turnId,
      input.ownerInstanceId,
      dispatchAttempt,
    )) {
      throw new Error("Provider admission intent could not be persisted for the current turn attempt.");
    }
    const result = await input.provider.run({
      prompt: preparedTurn.prompt,
      cwd: input.cwd,
      additionalDirs: preparedTurn.additionalDirs,
      sessionUUID: input.session.agent_session_uuid,
      sessionBindingToken: input.session.provider_binding_token,
      systemPrompt: preparedTurn.systemPrompt,
      model: input.model,
      reasoning_effort: input.reasoningEffort,
      clientUserMessageId: `slack-concierge:turn:${input.turnId}:attempt:${dispatchAttempt}`,
      environment: {
        ...input.providerEnvironment,
        CONCIERGE_TURN_ID: String(input.turnId),
        CONCIERGE_SESSION_ID: String(input.session.id),
        CONCIERGE_TURN_KIND: input.turnKind || "slack_user",
        CONCIERGE_OWNER_INSTANCE_ID: input.ownerInstanceId,
        CONCIERGE_SLACK_CHANNEL_ID: input.channelId,
        CONCIERGE_SLACK_THREAD_TS: input.threadTs,
      },
      onProviderThreadStarted: (providerThreadId, providerBindingToken) => {
        recordProviderSession(input, providerThreadId, providerBindingToken);
      },
      onProviderTurnStarted: (providerTurnId) => recordTurnProviderTurnId(input.turnId, providerTurnId),
      onProgress: (event) => {
        statusController?.recordProgress(event);
        if (event.type === "started") recordProviderStarted();
        if (event.type === "tool_use") observedToolCount += 1;
      },
      onSteeringReady: (sender) => input.steeringController.registerSender(sender),
      onProviderTerminal: () => input.closeSteering(new Error("The provider turn completed.")),
    });
    input.closeSteering();
    recordProviderStarted();
    recordTurnProviderTurnId(input.turnId, result.providerTurnId);
    recordProviderSession(input, result.sessionUUID, result.providerBindingToken);

    const artifacts = findTurnArtifacts(artifactDirectory);
    registerTurnArtifactIntents(input.turnId, artifacts);
    log("info", "artifact_intents_registered", {
      turn_id: input.turnId,
      artifact_directory: artifactDirectory,
      artifact_count: artifacts.length,
      artifact_names: artifacts.map((artifact) => artifact.filename),
    });
    if (artifacts.length === 0) removeArtifactStagingTree(artifactDirectory);

    const rawAgentText = result.text || "(no output)";
    const replyText = ensureTldr(rawAgentText);
    const responseTldr = extractTldr(replyText) || "No output.";
    const outboundText = `${replyText}\n\n_provider: ${input.providerLabel} - cwd: ${input.cwd}_`;
    markTurnDelivering(
      input.turnId,
      rawAgentText,
      outboundText,
      splitSlackText(outboundText).length,
      responseTldr,
    );
    deliveryStarted = true;

    const deliveryOutcome = await input.services.deliverOutcome({
      turnId: input.turnId,
      client: input.client,
      channel: input.channelId,
      threadTs: input.threadTs,
      text: outboundText,
      user: input.user,
    });
    if (deliveryOutcome === "stopped") {
      relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
      log("info", "turn_delivery_relinquished", {
        turn_id: input.turnId,
        instance_id: input.ownerInstanceId,
      });
      return { status: "delivery_stopped", turnId: input.turnId };
    }
    if (deliveryOutcome === "permanent_failure") {
      abandonTurnArtifactBatch(input.turnId, "Response delivery was permanently parked before artifact delivery.");
      cleanExpiredArtifactStaging();
      removeArtifactStagingTreeAfterAbandon(input.turnId, artifactDirectory);
      const parkedStatusDetail = "Status: error - response delivery was permanently parked";
      const parkedStatusText = formatTurnStatusMessage({
        state: "error",
        detail: parkedStatusDetail,
      });
      if (!parkTurnDelivery(input.turnId, input.ownerInstanceId, parkedStatusText)) {
        throw new Error("Permanent response delivery failure could not be durably parked.");
      }
      log("error", "turn_delivery_parked", {
        turn_id: input.turnId,
        instance_id: input.ownerInstanceId,
      });
      let terminalOutcome: "delivered" | "stopped" | "permanent_failure";
      try {
        terminalOutcome = await statusController.fail(parkedStatusDetail);
      } catch (projectionError) {
        parkTurnStatusProjectionAfterFailure(
          input.turnId,
          parkedStatusText,
          `Permanent-delivery status projection failed: ${String(projectionError)}`,
        );
        terminalOutcome = "permanent_failure";
        log("error", "parked_delivery_status_projection_failed", {
          ...errorFields(projectionError),
          turn_id: input.turnId,
          channel: input.channelId,
        });
      }
      if (terminalOutcome !== "delivered") {
        log(terminalOutcome === "stopped" ? "warn" : "error", "parked_delivery_status_projection_incomplete", {
          turn_id: input.turnId,
          channel: input.channelId,
          outcome: terminalOutcome,
        });
      }
      return { status: "delivery_parked", turnId: input.turnId };
    }

    responseDeliveryConfirmed = true;
    await statusController.stop();
    const completedThreadStatus = markTurnResponseDelivered(input.turnId);
    const completionStatusText = formatTurnStatusMessage({
      state: "done",
      elapsedMs: Date.now() - turnStart,
      toolCount: result.toolsUsed.length,
      provider: input.providerLabel,
      tldr: responseTldr,
    });
    let terminalOutcome: "delivered" | "stopped" | "permanent_failure";
    try {
      terminalOutcome = await statusController.complete({
        elapsedMs: Date.now() - turnStart,
        toolCount: result.toolsUsed.length,
        provider: input.providerLabel,
        tldr: responseTldr,
      });
    } catch (projectionError) {
      parkTurnStatusProjectionAfterFailure(
        input.turnId,
        completionStatusText,
        `Terminal turn status projection failed after response delivery: ${String(projectionError)}`,
      );
      terminalOutcome = "permanent_failure";
      log("error", "turn_status_projection_failed_after_response_delivery", {
        ...errorFields(projectionError),
        turn_id: input.turnId,
        channel: input.channelId,
      });
    }
    if (terminalOutcome === "stopped") {
      relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
      return { status: "delivery_stopped", turnId: input.turnId };
    }
    if (terminalOutcome === "permanent_failure") {
      log("error", "turn_status_projection_parked", {
        turn_id: input.turnId,
        channel: input.channelId,
      });
    }
    const summaryStatusText = formatTurnStatusMessage({
      state: "done",
      elapsedMs: Date.now() - turnStart,
      toolCount: result.toolsUsed.length,
      provider: input.providerLabel,
      tldr: completedThreadStatus?.thread_tldr || responseTldr,
    });
    let summaryOutcome: "delivered" | "stopped" | "permanent_failure";
    try {
      summaryOutcome = await input.services.projectThreadSummary({
        client: input.client,
        channel: input.channelId,
        threadTs: input.threadTs,
        turnId: input.turnId,
        text: summaryStatusText,
        user: input.user,
      });
    } catch (projectionError) {
      parkSlackThreadStatusProjectionAfterFailure({
        channel: input.channelId,
        threadTs: input.threadTs,
        turnId: input.turnId,
        text: summaryStatusText,
        error: `Cumulative thread status projection failed after response delivery: ${String(projectionError)}`,
      });
      summaryOutcome = "permanent_failure";
      log("error", "thread_status_projection_failed_after_response_delivery", {
        ...errorFields(projectionError),
        turn_id: input.turnId,
        channel: input.channelId,
        thread_ts: input.threadTs,
      });
    }
    if (summaryOutcome === "stopped") {
      relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
      log("info", "turn_status_projection_relinquished", {
        turn_id: input.turnId,
        instance_id: input.ownerInstanceId,
      });
      return { status: "delivery_stopped", turnId: input.turnId };
    }
    if (summaryOutcome === "permanent_failure") {
      log("error", "completion_status_projection_parked", {
        turn_id: input.turnId,
        channel: input.channelId,
      });
    }
    if (!finishDeliveredTurn(input.turnId)) {
      throw new Error("Delivered turn could not release its session lock.");
    }
    deliveryCompleted = true;
    log("info", "session_turn_lock_released", {
      session_id: input.session.id,
      channel: input.channelId,
      thread_ts: input.threadTs,
      slack_user_msg_ts: input.userMsgTs,
      provider: input.providerId,
      model: input.model || null,
      reasoning_effort: input.reasoningEffort || null,
      status: "idle",
    });
    await settleTurnArtifacts(input);
    schedulePostDeliveryCanvasRefresh(input, agentsBefore);
    return { status: "delivered", turnId: input.turnId };
  } catch (error) {
    input.closeSteering(error instanceof Error ? error : new Error(String(error)));
    if (deliveryCompleted) {
      log("error", "post_delivery_followup_failed", {
        ...errorFields(error),
        turn_id: input.turnId,
        channel: input.channelId,
      });
      return { status: "delivered", turnId: input.turnId };
    }
    if (responseDeliveryConfirmed) {
      await statusController?.stop();
      relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
      log("error", "post_response_completion_deferred", {
        ...errorFields(error),
        turn_id: input.turnId,
        channel: input.channelId,
      });
      return { status: "delivery_stopped", turnId: input.turnId };
    }
    const structuredFailure = providerDispatchError(error);
    const providerIdentityCompatible = !structuredFailure?.providerSessionId
      || !input.session.agent_session_uuid
      || structuredFailure.providerSessionId === input.session.agent_session_uuid;
    const artifactActivity = Boolean(
      artifactDirectory
      && existsSync(artifactDirectory)
      && findTurnArtifacts(artifactDirectory).length > 0
    );
    const dispatchBoundary = getRunningTurnDispatchBoundary(
      input.turnId,
      input.ownerInstanceId,
      dispatchAttempt,
    );
    const preserveDispatchFailure = !deliveryStarted
      && (input.turnKind === "slack_user" || input.turnKind === "comparison")
      && observedToolCount === 0
      && (structuredFailure?.toolsUsed.length || 0) === 0
      && !artifactActivity
      && dispatchBoundary !== null
      && !dispatchBoundary.durableArtifactActivity;
    if (preserveDispatchFailure) {
      await statusController?.stop();
      if (structuredFailure?.providerSessionId && providerIdentityCompatible) {
        recordProviderSession(input, structuredFailure.providerSessionId);
      }
      if (structuredFailure?.providerTurnId) recordTurnProviderTurnId(input.turnId, structuredFailure.providerTurnId);
      const message = String(error);
      const replaySafe = !dispatchBoundary.unsafeSteering
        && (!dispatchBoundary.admissionIntended
          || Boolean(structuredFailure?.terminalConfirmed && providerIdentityCompatible));
      const retryable = replaySafe
        && structuredFailure?.failureClass === "retryable";
      const ambiguous = !replaySafe;
      const preserved = retryable
        ? retryRunningTurnAfterProviderFailure({
            turnId: input.turnId,
            ownerInstanceId: input.ownerInstanceId,
            dispatchAttempt,
            error: message,
            nextAttemptMs: Date.now() + providerRetryDelayMs(dispatchAttempt),
          })
        : parkRunningTurnAfterProviderFailure({
            turnId: input.turnId,
            ownerInstanceId: input.ownerInstanceId,
            dispatchAttempt,
            failureClass: ambiguous
              ? "parked_ambiguous"
              : structuredFailure?.failureClass === "parked_access"
              ? "parked_access"
              : "parked_terminal",
            error: message,
            statusText: ambiguous
              ? `Status: parked - provider outcome is ambiguous; input preserved as turn ${input.turnId}, but replay is blocked until reconciled`
              : structuredFailure?.failureClass === "parked_access"
              ? undefined
              : `Status: parked - provider dispatch failed; input preserved as turn ${input.turnId} until resumed`,
          });
      if (!preserved) throw new Error("Provider dispatch failure could not be durably preserved.");
      preserveWorkingReaction = retryable;
      await input.services.scheduleTurnStatusProjection?.(input.client, input.turnId, input.user);
      log(retryable ? "warn" : "error", retryable ? "provider_turn_retry_queued" : "provider_turn_parked", {
        ...errorFields(error),
        turn_id: input.turnId,
        session_id: input.session.id,
        dispatch_attempt: dispatchAttempt,
        failure_class: retryable
          ? "retryable"
          : ambiguous
          ? "parked_ambiguous"
          : structuredFailure?.failureClass || "parked_terminal",
      });
      return {
        status: retryable ? "retry_queued" : "provider_parked",
        turnId: input.turnId,
      };
    }
    const errorStatusText = `Status: error - ${String(error).slice(0, 1200)}`;
    const terminalStatusText = formatTurnStatusMessage({ state: "error", detail: errorStatusText });
    let terminalOutcome: "delivered" | "stopped" | "permanent_failure";
    try {
      terminalOutcome = statusController
        ? await statusController.fail(errorStatusText)
        : await input.services.projectTurnStatus({
            client: input.client,
            turnId: input.turnId,
            text: terminalStatusText,
            user: input.user,
          });
    } catch (projectionError) {
      log("error", "turn_error_status_projection_failed", {
        ...errorFields(projectionError),
        turn_id: input.turnId,
        channel: input.channelId,
      });
      parkTurnStatusProjectionAfterFailure(
        input.turnId,
        terminalStatusText,
        `Terminal status projection failed: ${String(projectionError)}`,
      );
      terminalOutcome = "permanent_failure";
    }
    if (terminalOutcome === "stopped") {
      if (deliveryStarted) relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
      return { status: "delivery_stopped", turnId: input.turnId };
    }
    if (terminalOutcome === "permanent_failure") {
      log("error", "turn_error_status_projection_parked", {
        turn_id: input.turnId,
        channel: input.channelId,
      });
    }
    if (deliveryStarted) {
      markTurnDeliveryFailed(input.turnId, String(error));
      relinquishTurnDelivery(input.turnId, input.ownerInstanceId);
    } else {
      if (artifactBatchCreated) abandonFailedArtifactBatch(input, artifactDirectory, error);
      if (!failRunningTurnAndReleaseSession(input.turnId, input.ownerInstanceId, String(error))) {
        throw new Error("Failed turn could not atomically release its session lock.");
      }
    }
    log("info", deliveryStarted ? "turn_delivery_relinquished" : "session_turn_lock_released", {
      session_id: input.session.id,
      turn_id: input.turnId,
      channel: input.channelId,
      thread_ts: input.threadTs,
      slack_user_msg_ts: input.userMsgTs,
      provider: input.providerId,
      model: input.model || null,
      reasoning_effort: input.reasoningEffort || null,
      status: deliveryStarted ? "delivering" : "error",
    });
    log("error", "turn_failed", {
      ...errorFields(error),
      channel: input.channelId,
      thread_ts: input.threadTs,
    });
    input.services.scheduleCanvasRefreshIfChanged(
      input.client,
      input.channel,
      input.user,
      agentsBefore,
      "turn_error",
    );
    return deliveryStarted
      ? { status: "delivery_stopped", turnId: input.turnId }
      : { status: "error", turnId: input.turnId, error: String(error) };
  } finally {
    input.closeSteering();
    await statusController?.stop();
    if (input.turnKind !== "deployment_verification" && !preserveWorkingReaction) void input.services.scheduleWorkingReactionCleanup?.(input.client, input.turnId).catch((error) => {
      log("error", "turn_reaction_cleanup_worker_failed", {
        ...errorFields(error),
        turn_id: input.turnId,
        channel: input.channelId,
      });
    });
    try {
      await cleanupAttachmentBundle(attachmentBundle);
    } catch (error) {
      log("warn", "slack_attachment_temp_cleanup_failed", {
        dir: attachmentBundle.dir,
        ...errorFields(error),
      });
    }
    try {
      if (artifactDirectory) cleanupArtifactDirectoryIfEmpty(artifactDirectory);
    } catch (error) {
      log("warn", "turn_artifact_empty_directory_cleanup_failed", {
        turn_id: input.turnId,
        artifact_directory: artifactDirectory,
        ...errorFields(error),
      });
    }
  }
}

function abandonFailedArtifactBatch(
  input: TurnExecutionInput,
  artifactDirectory: string | null,
  error: unknown,
) {
  try {
    if (artifactDirectory && getTurnArtifactBatch(input.turnId)?.status === "collecting") {
      registerTurnArtifactIntents(input.turnId, findTurnArtifacts(artifactDirectory));
    }
  } catch (registrationError) {
    log("warn", "failed_turn_artifact_registration_failed", {
      turn_id: input.turnId,
      artifact_directory: artifactDirectory,
      ...errorFields(registrationError),
    });
  }
  abandonTurnArtifactBatch(input.turnId, `Agent turn failed before delivery: ${String(error)}`);
  cleanExpiredArtifactStaging();
  removeArtifactStagingTreeAfterAbandon(input.turnId, artifactDirectory);
}

function removeArtifactStagingTreeAfterAbandon(turnId: number, artifactDirectory: string | null) {
  if (!artifactDirectory) return;
  try {
    removeArtifactStagingTree(artifactDirectory);
  } catch (error) {
    log("warn", "abandoned_artifact_staging_cleanup_failed", {
      turn_id: turnId,
      artifact_directory: artifactDirectory,
      ...errorFields(error),
    });
  }
}

async function hydrateThreadOwnership(input: TurnExecutionInput, statusMessageTs: string) {
  try {
    const associatedTurns = await input.services.hydrateLegacyThreadOwnership({
      client: input.client,
      channel: input.channelId,
      threadTs: input.threadTs,
      user: input.user,
    });
    if (associatedTurns > 0) {
      log("info", "legacy_slack_thread_ownership_hydrated", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        associated_turn_count: associatedTurns,
      });
    }
  } catch (error) {
    log("warn", "legacy_slack_thread_ownership_hydration_failed", {
      ...errorFields(error),
      channel: input.channelId,
      thread_ts: input.threadTs,
    });
  }

  const existingStatus = getSlackThreadStatus(input.channelId, input.threadTs);
  const threadStatus = ensureSlackThreadStatusMessage(
    input.channelId,
    input.threadTs,
    existingStatus?.slack_status_msg_ts ||
      findLegacySlackThreadStatusMessage(input.channelId, input.threadTs) ||
      statusMessageTs,
  );
  return priorSlackThreadTldrs(
    threadStatus,
    listSlackThreadResponses(input.channelId, input.threadTs),
  );
}

async function prepareProviderTurn(
  input: TurnExecutionInput,
  artifactDirectory: string,
  previousThreadTldrs: string[],
) {
  const attachmentBundle = await downloadSlackFiles({
    files: input.files,
    botToken: input.botToken,
    channel: input.channelId,
    messageTs: input.userMsgTs,
    baseDirectory: providerBrokerEnabled()
      ? join(providerProjectScratchPath(input.cwd), "attachments")
      : undefined,
  });
  try {
    const transcripts = await transcribeAudioAttachments({
      slackFiles: input.files,
      downloadedFiles: attachmentBundle.files,
    });
    const linkedThreadContext = input.hydrateSlackLinks
      ? await slackPermalinkPrompt({ text: input.text, client: input.client, user: input.user })
      : "";
    const replayText = [input.prompt, linkedThreadContext, transcriptionPrompt(transcripts)]
      .filter(Boolean)
      .join("\n\n");
    setTurnReplayInput(
      input.turnId,
      replayText,
      input.files.filter((file) => !isAudioFile(file)).length,
    );
    logPreparedAttachments(input, attachmentBundle, transcripts.length);
    return {
      attachmentBundle,
      prompt: [replayText, attachmentPrompt(attachmentBundle.files)].filter(Boolean).join("\n\n"),
      additionalDirs: [
        ...input.additionalDirs,
        ...(attachmentBundle.dir ? [attachmentBundle.dir] : []),
      ],
      systemPrompt: [
        ...(projectAgentsOwnResponseContract(input.channel) ? [] : [CONCIERGE_SESSION_RESPONSE_CONTRACT]),
        input.baseSystemPrompt,
        buildArtifactPromptContext(artifactDirectory),
        buildSlackThreadSummaryContext(previousThreadTldrs),
      ].filter(Boolean).join("\n\n") || undefined,
    };
  } catch (error) {
    await cleanupAttachmentBundle(attachmentBundle);
    throw error;
  }
}

function projectAgentsOwnResponseContract(channel: ChannelRow) {
  const projectRoot = channel.code_path || channel.vault_path;
  const agentsPath = join(projectRoot, "AGENTS.md");
  if (!existsSync(agentsPath)) return false;
  try {
    const instructions = readFileSync(agentsPath, "utf8");
    return instructions.includes("`TL;DR:`")
      && /cumulative summary/i.test(instructions)
      && /(Slack|Concierge)/i.test(instructions);
  } catch {
    return false;
  }
}

async function addWorkingReaction(input: TurnExecutionInput) {
  try {
    await slackCall(input.client, "reactions.add", {
      channel: input.channelId,
      timestamp: input.userMsgTs,
      name: "hourglass_flowing_sand",
    }, { channel: input.channelId, user: input.user });
  } catch {}
}

function recordProviderSession(
  input: TurnExecutionInput,
  sessionUUID: string | null,
  providerBindingToken?: string | null,
) {
  upsertSession(input.channelId, input.sessionThreadTs, input.providerId, sessionUUID, {
    providerBindingToken,
    status: "running",
  });
  if (input.sessionMode !== "single-persistent" || input.channel.default_session_uuid || !sessionUUID) return;
  const boundUuid = bindChannelDefaultSessionUuid(input.channelId, sessionUUID);
  log(boundUuid === sessionUUID ? "info" : "warn", "single_persistent_anchor_bound", {
    channel: input.channelId,
    requested_anchor_uuid: sessionUUID,
    bound_anchor_uuid: boundUuid,
    anchor_session_thread_ts: input.sessionThreadTs,
    reply_thread_ts: input.threadTs,
  });
}

async function settleTurnArtifacts(input: TurnExecutionInput) {
  const artifactDeliveries = listTurnArtifactDeliveries(input.turnId);
  for (const artifact of artifactDeliveries) {
    const outcome = await scheduleTurnArtifactDelivery(
      input.client,
      artifact.artifact_id,
      input.ownerInstanceId,
      input.user,
      {
        projectFailure: async (turnId) => {
          await input.services.scheduleTurnStatusProjection?.(input.client, turnId, input.user);
        },
      },
    );
    log(outcome === "delivered" ? "info" : "warn", "artifact_delivery_settled", {
      turn_id: input.turnId,
      artifact_id: artifact.artifact_id,
      filename: artifact.filename,
      outcome,
    });
  }
}

function schedulePostDeliveryCanvasRefresh(input: TurnExecutionInput, agentsBefore: string | null) {
  input.services.scheduleCanvasRefreshIfChanged(
    input.client,
    input.channel,
    input.user,
    agentsBefore,
    "turn_done",
  );
}

function snapshotAgentsFingerprint(input: Pick<TurnExecutionInput, "channel" | "turnId">) {
  try {
    return agentsFingerprint(input.channel);
  } catch (error) {
    log("warn", "turn_canvas_fingerprint_failed", {
      phase: "before",
      turn_id: input.turnId,
      channel: input.channel.slack_channel_id,
      ...errorFields(error),
    });
    return null;
  }
}

function logPreparedAttachments(
  input: TurnExecutionInput,
  attachmentBundle: AttachmentBundle,
  transcriptCount: number,
) {
  if (attachmentBundle.files.length === 0) return;
  log("info", "agent_turn_attachments_ready", {
    channel: input.channelId,
    thread_ts: input.threadTs,
    user_msg_ts: input.userMsgTs,
    provider: input.providerId,
    model: input.model || null,
    reasoning_effort: input.reasoningEffort || null,
    attachment_dir: attachmentBundle.dir,
    attachment_paths: attachmentBundle.files.map((file) => file.path),
    audio_transcript_count: transcriptCount,
  });
}
