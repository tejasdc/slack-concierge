import { stripProviderAliases } from "./aliases";
import { parseSlackMessageFilesJson, type SlackMessageFile } from "./attachments";
import { comparisonTargetLabel, turnInputPolicy } from "./comparison";
import { ARCHIVED_QUEUED_TURN_ERROR } from "./text";
import type {
  ChannelRow,
  ProviderId,
  QueuedTurnClaimRow,
  SessionMode,
  SessionRow,
  TurnProjectionMode,
} from "./state";

export interface ClaimedTurnInput {
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
  providerId: ProviderId;
  providerLabel: string;
  model?: string | null;
  reasoningEffort?: string | null;
  sessionThreadTs: string;
  sessionMode: SessionMode;
  hydrateSlackLinks: boolean;
  baseSystemPrompt?: string;
  turnKind?: "slack_user" | "comparison" | "deployment_verification";
  dispatchAttempt: number;
  providerEnvironment?: Record<string, string>;
  beforeProviderAdmission?: () => void;
  projectionMode?: TurnProjectionMode;
}

export interface QueuedTurnInputDependencies {
  client: any;
  getSessionById(sessionId: number): SessionRow | null;
  getChannel(channelId: string): ChannelRow | null;
  baseSystemPromptForText(text: string): string | undefined;
}

export function stripBotMentions(text: string) {
  return stripProviderAliases(
    text.replace(/<@[A-Z0-9]+>\s*/g, "").replace(/@substack-editor/gi, ""),
  );
}

export function buildQueuedTurnInput(
  claim: QueuedTurnClaimRow,
  dependencies: QueuedTurnInputDependencies,
): ClaimedTurnInput {
  if (claim.claim_kind !== "turn" || claim.claim_turn_id !== claim.turn_id) {
    throw new Error("Queued turn is missing its durable Slack input claim.");
  }
  if (!claim.user_id) throw new Error("Queued turn is missing its Slack user identity.");
  if (claim.claim_user_text === null || claim.claim_user_text !== claim.turn_user_text) {
    throw new Error("Queued turn text does not match its durable Slack input claim.");
  }
  if (claim.files_json === null) throw new Error("Queued turn is missing its Slack file metadata.");
  const parsedFiles = parseSlackMessageFilesJson(claim.files_json);
  if (!parsedFiles.ok) throw new Error(`Queued turn file metadata is invalid: ${parsedFiles.error}.`);

  const session = dependencies.getSessionById(claim.session_id);
  if (!session || session.slack_channel_id !== claim.slack_channel_id || session.provider_id !== claim.provider_id) {
    throw new Error("Queued turn session authority changed before execution.");
  }
  if (session.status === "archived") throw new Error(ARCHIVED_QUEUED_TURN_ERROR);
  const channel = dependencies.getChannel(claim.slack_channel_id);
  if (!channel) throw new Error("Queued turn channel no longer exists.");

  const inputPolicy = turnInputPolicy(claim.turn_kind === "comparison");
  let prompt = inputPolicy.stripMentions ? stripBotMentions(claim.turn_user_text) : claim.turn_user_text;
  if (!prompt && parsedFiles.files.length > 0) prompt = "Please respond to the attached content.";
  if (!prompt) throw new Error("Queued turn has no executable text or attachments.");
  const sessionMode: SessionMode = channel.session_mode === "single-persistent"
      && session.slack_thread_ts !== claim.reply_thread_ts
    ? "single-persistent"
    : "per-thread";

  return {
    turnId: claim.turn_id,
    session,
    channel,
    channelId: claim.slack_channel_id,
    threadTs: claim.reply_thread_ts,
    userMsgTs: claim.slack_user_msg_ts,
    user: claim.user_id,
    text: claim.turn_user_text,
    prompt,
    files: parsedFiles.files,
    client: dependencies.client,
    providerId: session.provider_id,
    providerLabel: comparisonTargetLabel(session.provider_id, claim.provider_model),
    model: claim.provider_model,
    reasoningEffort: claim.reasoning_effort,
    sessionThreadTs: session.slack_thread_ts,
    sessionMode,
    hydrateSlackLinks: inputPolicy.hydrateSlackLinks,
    baseSystemPrompt: dependencies.baseSystemPromptForText(claim.turn_user_text),
    turnKind: claim.turn_kind,
    dispatchAttempt: claim.dispatch_attempt,
    projectionMode: claim.projection_mode,
  };
}

export async function executePersistedQueuedTurn<TOutcome>(
  claim: QueuedTurnClaimRow,
  dependencies: {
    buildInput(claim: QueuedTurnClaimRow): ClaimedTurnInput;
    run(input: ClaimedTurnInput): Promise<TOutcome>;
    fail(claim: QueuedTurnClaimRow, error: unknown): TOutcome | Promise<TOutcome>;
  },
): Promise<TOutcome> {
  try {
    return await dependencies.run(dependencies.buildInput(claim));
  } catch (error) {
    return await dependencies.fail(claim, error);
  }
}
