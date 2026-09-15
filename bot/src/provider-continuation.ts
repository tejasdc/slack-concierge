import { REASONING_EFFORTS, normalizeProviderAliasKey, normalizeReasoningEffort, resolveProviderAlias,
  type ProviderAliasResolution, type ReasoningEffort } from "./aliases";
import { assertProviderHistoryReplayable } from "./provider-replay";
import { db, getSessionById, type ChannelRow } from "./state";
import { resolveReplySession } from "./slack-thread-identity";
import { slackTimestampUs, slackTimestampUsSql } from "./router-search-index";

export type RoutedProviderSelection = ProviderAliasResolution & {
  forceNewSession: boolean;
  continuation?: {
    sessionId: number;
    providerSessionUUID: string | null;
    rootTs: string;
    turnIds: number[];
    waitForTurnIds: number[];
    history?: string;
  };
};

export function routedProviderAlias(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("--provider requires a provider alias, such as cc or cx.");
  const alias = normalizeProviderAliasKey(value);
  if (!alias) {
    throw new Error("Unknown provider alias. Aliases choose a model: cc, cc-fable, cc-opus, cc-sonnet, "
      + "cc-haiku, cc-fast, cc-medium, cx, cx-astra, cx-sol, cx-terra, cx-luna, cx-fast, cx-medium.");
  }
  return alias;
}

export function routedReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("--effort requires a reasoning effort level.");
  const effort = normalizeReasoningEffort(value);
  if (!effort) throw new Error(`Unknown reasoning effort. Use ${REASONING_EFFORTS.join(", ")}.`);
  return effort;
}

export function planRoutedProviderSelection(channel: ChannelRow, rootTs: string | null, beforeTs: string,
  alias: string, effort?: ReasoningEffort): RoutedProviderSelection {
  const target = resolveProviderAlias(routedProviderAlias(alias)!, effort);
  const source = rootTs ? resolveReplySession(db, channel, rootTs).session : null;
  const selection: RoutedProviderSelection = { ...target, forceNewSession: !source || source.provider_id !== target.provider };
  if (!source || source.provider_id === target.provider) return selection;
  if (source.agent_session_uuid) assertProviderHistoryReplayable({ ...source, agent_session_uuid: source.agent_session_uuid }, "fork");
  const turns = db.query(`SELECT id, status, dispatch_failure_class FROM turns WHERE session_id=? AND ${slackTimestampUsSql("slack_user_msg_ts")}<? ORDER BY id`)
    .all(source.id, slackTimestampUs(beforeTs)) as Array<{ id: number; status: string; dispatch_failure_class: string | null }>;
  if (!turns.length) throw new Error("The source session has no recorded conversation to continue.");
  if (turns.some(turn => turn.status === 'interrupted')) {
    throw new Error("The source conversation was interrupted and its outcome is unproven. Supply an explicit continuation brief instead.");
  }
  selection.continuation = { sessionId: source.id, providerSessionUUID: source.agent_session_uuid, rootTs: rootTs!,
    turnIds: turns.map(turn => turn.id), waitForTurnIds: turns.filter(turn => !knownRejectedTurn(turn)).map(turn => turn.id) };
  // Reject known gaps before publication; an in-flight boundary is checked again after its queue dependency settles.
  selection.continuation.history = continuationHistory(selection.continuation, true);
  return selection;
}

function knownRejectedTurn(turn: { status: string; dispatch_failure_class: string | null }) {
  return turn.status === "parked" && ["parked_terminal", "parked_access"].includes(turn.dispatch_failure_class || "");
}

function continuationHistory(source: NonNullable<RoutedProviderSelection["continuation"]>, preflight = false): string | undefined {
  const session = getSessionById(source.sessionId);
  if (!session || session.status === "archived" || (source.providerSessionUUID && session.agent_session_uuid !== source.providerSessionUUID)) {
    throw new Error("The continuation source changed or was archived. Resolve the source again.");
  }
  if (session.agent_session_uuid) assertProviderHistoryReplayable({ ...session, agent_session_uuid: session.agent_session_uuid }, "fork");
  if (session.parent_session_id && !db.query(`SELECT 1 FROM routed_requests request JOIN turns turn ON turn.id=request.turn_id
    WHERE turn.session_id=? AND json_extract(request.payload_json, '$.provider_selection.continuation') IS NOT NULL`).get(session.id)) {
    throw new Error("This native fork has inherited provider history Concierge cannot replay. Supply an explicit continuation brief instead.");
  }
  const history: Array<Record<string, unknown>> = [];
  let complete = true;
  for (const id of source.turnIds) {
    const turn = db.query(`SELECT id, session_id, status, replay_text, provider_started_at, unreplayable_attachment_count,
      agent_text, dispatch_failure_class FROM turns WHERE id=?`).get(id) as any;
    if (!turn || turn.session_id !== source.sessionId) throw new Error("The recorded continuation source is incomplete.");
    if (["queued", "running", "delivering", "parked", "interrupted"].includes(turn.status) && !knownRejectedTurn(turn)) {
      if (preflight) { complete = false; continue; }
      throw new Error("The source turn has not settled; the provider continuation cannot start yet.");
    }
    if (turn.status === "cancelled") {
      throw new Error("The source contains stopped input whose native history cannot be transferred safely. Continue in the original session or supply an explicit continuation brief.");
    }
    const inputs = [{ text: turn.replay_text, ready: turn.provider_started_at || knownRejectedTurn(turn), attachments: turn.unreplayable_attachment_count }];
    const steering = db.query(`SELECT replay_text, status, provider_sent_at, unreplayable_attachment_count
      FROM turn_steering_messages WHERE turn_id=? ORDER BY id`).all(id) as any[];
    for (const input of steering) {
      if (input.status === "failed") continue;
      if (input.status !== "sent") throw new Error("The source contains steering with unproven provider acknowledgement.");
      inputs.push({ text: input.replay_text, ready: input.provider_sent_at, attachments: input.unreplayable_attachment_count });
    }
    for (const input of inputs) {
      if (!input.ready || input.text === null) throw new Error("The source lacks canonical provider input. Supply an explicit continuation brief instead.");
      if (input.attachments) throw new Error("The source contains attachments Concierge cannot replay. Supply the needed files and an explicit continuation brief instead.");
      history.push({ role: "user", turn_id: id, text: input.text });
    }
    if (turn.status === "done" && turn.agent_text === null) throw new Error("The source is missing its recorded agent answer.");
    history.push({ role: "assistant", turn_id: id, outcome: knownRejectedTurn(turn) ? "request rejected before tool activity" : turn.status, text: turn.agent_text });
  }
  return complete ? JSON.stringify(history) : undefined;
}

export function routedContinuationPrompt(turnId: number, prompt: string): string {
  const row = db.query("SELECT request_id, payload_json FROM routed_requests WHERE turn_id=? AND json_extract(payload_json, '$.provider_selection.continuation') IS NOT NULL")
    .get(turnId) as { request_id: string; payload_json: string } | null;
  if (!row) return prompt;
  const payload = JSON.parse(row.payload_json);
  const selection = payload.provider_selection as RoutedProviderSelection | undefined;
  if (!selection?.continuation) return prompt;
  const source = selection.continuation;
  if (source.history === undefined) {
    db.transaction(() => {
      source.history = continuationHistory(source);
      db.query("UPDATE routed_requests SET payload_json=? WHERE request_id=?").run(JSON.stringify(payload), row.request_id);
    })();
  }
  return [
    "Continue the work in this new provider session using the recorded conversation below. Earlier requests and answers are context; only the current request is active. Native tool state was not transferred. Inspect project files when needed.",
    `Source Slack thread: ${source.rootTs}. Recorded conversation (JSON):`,
    source.history,
    "Current request:",
    prompt,
  ].join("\n\n");
}
