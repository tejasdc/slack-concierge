import { createHash, randomUUID } from "node:crypto";
import { db, getSessionById, getUniqueCodexSessionBinding } from "./state";
import { recordSessionEvent, sessionMetadata, updateSessionMetadata } from "./session-inputs";
import { log } from "./log";

export type CodexSessionLifecycle = {
  version: 1;
  threadId: string;
  turnId: string | null;
  state: "running" | "completed" | "failed" | "canceled" | "uncertain" | "idle";
  startedAt: string | null;
  endedAt: string | null;
  workMs: number | null;
  observedAt: string;
};

const timestamp = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value)
  && value >= 0 && value < 8_640_000_000_000 ? new Date(value * 1000).toISOString() : null;

/** Observation never admits an input, owns an execution, or rewrites a turn receipt. */
export function observeCodexLifecycle(threadId: string, turn: any, source: string, threadStatus?: string) {
  const binding = getUniqueCodexSessionBinding(threadId);
  if (!binding) return;
  const states = { inProgress: "running", completed: "completed", failed: "failed", interrupted: "canceled" } as const;
  const turnState = states[turn?.status as keyof typeof states];
  const turnId = typeof turn?.id === "string" && turn.id ? turn.id : null;
  let state: CodexSessionLifecycle["state"] = turnState ?? "uncertain";
  if (threadStatus === "active" && state !== "running") state = "running";
  if (["notLoaded", "systemError", "disconnected"].includes(threadStatus ?? "")
    && (!turnState || turnState === "running")) state = "uncertain";
  if (threadStatus === "idle" && !turnId) state = "idle";
  if (threadStatus === "idle" && turnState === "running") state = "uncertain";
  const matchesTurn = state === turnState || state === "uncertain" && turnState === "running";
  const observation: CodexSessionLifecycle = {
    version: 1, threadId, turnId: matchesTurn ? turnId : null, state,
    startedAt: matchesTurn ? timestamp(turn?.startedAt) : null,
    endedAt: matchesTurn ? timestamp(turn?.completedAt) : null,
    workMs: matchesTurn && typeof turn?.durationMs === "number" && Number.isSafeInteger(turn.durationMs)
      && turn.durationMs >= 0 ? turn.durationMs : null,
    observedAt: new Date().toISOString(),
  };
  db.transaction(() => {
    const session = getSessionById(binding.session_id)!;
    const prior = sessionMetadata(session).codexLifecycle;
    if (turnId && turnState) {
      const evidence = { threadId, turnId, state: turnState, startedAt: timestamp(turn?.startedAt),
        endedAt: timestamp(turn?.completedAt), workMs: observation.workMs };
      const digest = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
      recordSessionEvent({ eventId: `provider-turn:${binding.session_id}:${digest}`, sessionId: binding.session_id,
        kind: "provider-turn", payload: evidence });
    }
    // A reconnect snapshot can precede already queued notifications from an older turn.
    // Keep that turn's evidence above without replacing a newer provider execution.
    if (source.startsWith("turn/") && prior?.threadId === threadId && prior.turnId !== turnId
      && prior.startedAt && observation.startedAt && observation.startedAt < prior.startedAt) return;
    // Snapshot recovery is authoritative; delayed duplicate starts cannot reopen a terminal turn.
    if (source === "turn/started" && prior?.threadId === threadId && prior.turnId === turnId
      && ["completed", "failed", "canceled"].includes(prior.state)) return;
    const { observedAt: _before, ...before } = prior ?? {};
    const { observedAt: _after, ...after } = observation;
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    updateSessionMetadata(binding.session_id, { codexLifecycle: observation });
    recordSessionEvent({ eventId: `provider-lifecycle:${randomUUID()}`, sessionId: binding.session_id,
      kind: "provider-lifecycle", payload: { source, ...observation } });
    log("info", "codex_session_lifecycle_observed", {
      session_id: binding.session_id, provider_thread_uuid: threadId,
      provider_turn_id: observation.turnId, state, source,
      previous_state: prior?.state ?? null,
    });
  }).immediate();
}

export function disconnectCodexLifecycle(threadId: string) {
  const binding = getUniqueCodexSessionBinding(threadId);
  if (!binding) return;
  const session = getSessionById(binding.session_id)!;
  const prior = sessionMetadata(session).codexLifecycle;
  if (prior?.threadId === threadId && prior.state === "running") {
    observeCodexLifecycle(threadId, { id: prior.turnId, status: "inProgress",
      startedAt: prior.startedAt ? Date.parse(prior.startedAt) / 1000 : null },
    "observer/disconnected", "disconnected");
  }
}
