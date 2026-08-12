import { ARTIFACT_SCAN_GRACE_MS, findNewArtifacts } from "./artifacts";
import {
  attachmentPrompt,
  cleanupAttachmentBundle,
  downloadSlackFiles,
  type AttachmentBundle,
  type SlackMessageFile,
} from "./attachments";
import { agentsFingerprint } from "./canvas";
import { errorFields, log } from "./log";
import { buildListPromptContext, parseAgentListOps } from "./lists";
import type { AgentProvider } from "./providers";
import { slackCall } from "./rate-limit";
import { uploadArtifacts } from "./slack-post";
import {
  ensureSlackThreadStatusMessage,
  findLegacySlackThreadStatusMessage,
  finishDeliveredTurn,
  finishTurn,
  getSlackThreadStatus,
  getTurnStatusProjection,
  listSlackThreadResponses,
  markTurnDeliveryFailed,
  markTurnDelivering,
  markTurnProviderStarted,
  markTurnResponseDelivered,
  parkSlackThreadStatusProjectionAfterFailure,
  parkTurnDelivery,
  parkTurnStatusProjectionAfterFailure,
  relinquishTurnDelivery,
  setSessionStatus,
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
import { buildSlackThreadSummaryContract, priorSlackThreadTldrs } from "./thread-summary";
import { TurnStatusController } from "./turn-status-controller";
import { isAudioFile, transcribeAudioAttachments, transcriptionPrompt } from "./transcription";
import { slackPermalinkPrompt } from "./slack-links";

export type TurnExecutionOutcome =
  | { status: "delivered" | "delivery_stopped" | "delivery_parked"; turnId: number }
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
  loadListContext(client: any, channel: ChannelRow, user: string): Promise<string>;
  applyListOperations(input: {
    client: any;
    channel: ChannelRow;
    user: string;
    adds: string[];
    completes: string[];
  }): Promise<void>;
  syncCanvasIfChanged(
    client: any,
    channel: ChannelRow,
    user: string | null,
    before: string | null,
    reason: string,
  ): Promise<void>;
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
  steeringController: TurnSteeringController;
  closeSteering(reason?: Error): void;
  services: TurnExecutionServices;
  statusIntervalMs?: number;
}

export async function executeAgentTurn(input: TurnExecutionInput): Promise<TurnExecutionOutcome> {
  const turnStart = Date.now();
  let agentsBefore: string | null = null;
  let attachmentBundle: AttachmentBundle = { dir: null, files: [] };
  let deliveryStarted = false;
  let responseDeliveryConfirmed = false;
  let deliveryCompleted = false;
  let statusController: TurnStatusController | null = null;
  let statusMessageTs = "";

  try {
    agentsBefore = agentsFingerprint(input.channel);
    await addWorkingReaction(input);
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

    const listContext = await input.services.loadListContext(input.client, input.channel, input.user);
    const previousThreadTldrs = await loadThreadSummaryContext(input, statusMessageTs);
    const preparedTurn = await prepareProviderTurn(input, listContext, previousThreadTldrs);
    attachmentBundle = preparedTurn.attachmentBundle;
    let providerStarted = false;
    const recordProviderStarted = () => {
      if (providerStarted) return;
      providerStarted = true;
      markTurnProviderStarted(input.turnId);
    };
    const result = await input.provider.run({
      prompt: preparedTurn.prompt,
      cwd: input.cwd,
      additionalDirs: preparedTurn.additionalDirs,
      sessionUUID: input.session.agent_session_uuid,
      systemPrompt: preparedTurn.systemPrompt,
      model: input.model,
      reasoning_effort: input.reasoningEffort,
      onProgress: (event) => {
        statusController?.recordProgress(event);
        if (event.type === "started") recordProviderStarted();
      },
      onSteeringReady: (sender) => input.steeringController.registerSender(sender),
      onProviderTerminal: () => input.closeSteering(new Error("The provider turn completed.")),
    });
    input.closeSteering();
    recordProviderStarted();
    recordProviderSession(input, result.sessionUUID);

    const rawAgentText = result.text || "(no output)";
    const listOps = parseAgentListOps(rawAgentText);
    const replyText = ensureTldr(listOps.text || "(no output)");
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
    await input.services.applyListOperations({
      client: input.client,
      channel: input.channel,
      user: input.user,
      adds: listOps.adds,
      completes: listOps.completes,
    });

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
    await publishPostDeliveryEffects(input, turnStart, agentsBefore);
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
      finishTurn(input.turnId, "error", String(error));
      setSessionStatus(input.session.id, "error");
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
    await input.services.syncCanvasIfChanged(
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
    void input.services.scheduleWorkingReactionCleanup?.(input.client, input.turnId).catch((error) => {
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
  }
}

async function loadThreadSummaryContext(input: TurnExecutionInput, statusMessageTs: string) {
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
  listContext: string,
  previousThreadTldrs: ReturnType<typeof priorSlackThreadTldrs>,
) {
  const attachmentBundle = await downloadSlackFiles({
    files: input.files,
    botToken: input.botToken,
    channel: input.channelId,
    messageTs: input.userMsgTs,
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
        input.baseSystemPrompt,
        buildListPromptContext(listContext),
        buildSlackThreadSummaryContract(previousThreadTldrs),
      ].filter(Boolean).join("\n\n"),
    };
  } catch (error) {
    await cleanupAttachmentBundle(attachmentBundle);
    throw error;
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

function recordProviderSession(input: TurnExecutionInput, sessionUUID: string | null) {
  upsertSession(input.channelId, input.sessionThreadTs, input.providerId, sessionUUID, { status: "running" });
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

async function publishPostDeliveryEffects(
  input: TurnExecutionInput,
  turnStart: number,
  agentsBefore: string | null,
) {
  const artifacts = findNewArtifacts(input.cwd, turnStart);
  log("info", "artifact_scan", {
    cwd: input.cwd,
    turnStart,
    scan_floor_ms: turnStart - ARTIFACT_SCAN_GRACE_MS,
    artifact_scan_grace_ms: ARTIFACT_SCAN_GRACE_MS,
    artifact_count: artifacts.length,
    artifact_names: artifacts.map((artifact) => artifact.filename),
  });
  if (artifacts.length > 0) {
    await uploadArtifacts({
      client: input.client,
      channel: input.channelId,
      threadTs: input.threadTs,
      artifacts,
      user: input.user,
    });
    log("info", "artifact_upload_done", { count: artifacts.length });
  }
  await input.services.syncCanvasIfChanged(
    input.client,
    input.channel,
    input.user,
    agentsBefore,
    "turn_done",
  );
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
