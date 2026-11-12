import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";

/**
 * Paced starts on a machine (docs/plans/2026-11-12-mac-held-work-pacing.md).
 *
 * Invariant: on a paced machine, new provider-process starts are admitted at a bounded rate, whatever
 * released them. The gate sits where a queued turn is claimed, not in each release path, so a new
 * release path cannot bring a burst back. A machine without the setting is not paced and nothing
 * here runs.
 *
 * This module holds no ledger connection of its own: every function takes the database, so the
 * claim in state.ts can call it inside its own transaction without an import cycle.
 */

export const START_PACE_HOLD_PREFIX = "start_pace";
export const START_MEMORY_HOLD = "start_memory";
/** macOS kern.memorystatus_vm_pressure_level values. */
export const MEMORY_WARNING = 2;
export const MEMORY_CRITICAL = 4;

export type StartPaceConfig = { budget: number; windowMs: number; jitterMs: number; agentOrderTimeoutMs: number };

/** Unset (or not a positive budget) means unpaced: the server's behavior, unchanged. */
export function startPaceConfig(env: Record<string, string | undefined> = process.env): StartPaceConfig | null {
  const budget = Number(env.CONCIERGE_START_PACE_BUDGET);
  if (!Number.isInteger(budget) || budget < 1) return null;
  const windowMs = Number(env.CONCIERGE_START_PACE_WINDOW_MS ?? 120_000);
  const jitterMs = Number(env.CONCIERGE_START_PACE_JITTER_MS ?? 30_000);
  return {
    budget,
    windowMs: Number.isFinite(windowMs) && windowMs >= 1_000 ? windowMs : 120_000,
    jitterMs: Number.isFinite(jitterMs) && jitterMs >= 0 ? jitterMs : 30_000,
  };
}

export function holdIsStartPace(hold: string | null | undefined): boolean {
  return typeof hold === "string" && (hold === START_PACE_HOLD_PREFIX || hold.startsWith(`${START_PACE_HOLD_PREFIX}:`) || hold === START_MEMORY_HOLD);
}
/** The place in line carried in the hold itself, so the status needs no second lookup. */
export function startPacePlace(hold: string | null | undefined): number | null {
  const match = typeof hold === "string" ? hold.match(/^start_pace:(\d+)$/) : null;
  return match ? Number(match[1]) : null;
}

let memoryReading: { atMs: number; level: number } | null = null;
/**
 * macOS's own memory-pressure level: 1 normal, 2 warning, 4 critical. Swap fullness is not the
 * signal: this Mac sits near 92 % swap with no agent running, so a swap threshold would hold
 * everything forever. Read at most every five seconds; anything that cannot be read is normal.
 */
export function memoryPressureLevel(nowMs = Date.now(), read: () => number | null = readMacMemoryPressure): number {
  if (memoryReading && nowMs - memoryReading.atMs < 5_000) return memoryReading.level;
  const level = read() ?? 1;
  memoryReading = { atMs: nowMs, level };
  return level;
}
export function resetMemoryPressureCacheForTests() { memoryReading = null; }
export function readMacMemoryPressure(): number | null {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8", timeout: 2_000 });
  const level = Number(String(result.stdout ?? "").trim());
  return result.status === 0 && Number.isInteger(level) ? level : null;
}

export type StartCandidate = { turnId: number; exempt: boolean };
export type StartDecision = { admit: true } | { admit: false; hold: string; nextMs: number };

export function ensureStartPaceTables(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS start_pace_starts (turn_id INTEGER PRIMARY KEY, started_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS start_pace_starts_at ON start_pace_starts(started_ms);
    `);
}

/** A direct human message (he is waiting) and the Inbox router are never held for the budget; a chat window is no new process. */
export function startIsExempt(db: Database, turnId: number): boolean {
  const row = db.query(`SELECT input.origin AS origin, session.provider_id AS provider,
      json_extract(session.native_metadata_json,'$.inboxRole') AS role
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    LEFT JOIN session_inputs input ON input.id=turn.accepted_input_id WHERE turn.id=?`).get(turnId) as
    { origin: string | null; provider: string; role: string | null } | null;
  return !row || row.provider === "chatgpt" || row.origin === "human" || row.role === "project-router";
}

function startsInWindow(db: Database, nowMs: number, windowMs: number): number[] {
  db.query("DELETE FROM start_pace_starts WHERE started_ms<=?").run(nowMs - 24 * 3_600_000);
  return (db.query("SELECT started_ms FROM start_pace_starts WHERE started_ms>? ORDER BY started_ms").all(nowMs - windowMs) as { started_ms: number }[])
    .map(row => row.started_ms);
}

/** The instant the budget next has room, or null when it has room now. */
export function budgetFreeAtMs(db: Database, nowMs: number, config: StartPaceConfig): number | null {
  const starts = startsInWindow(db, nowMs, config.windowMs);
  return starts.length < config.budget ? null : starts[starts.length - config.budget]! + config.windowMs;
}

export function jitter(config: StartPaceConfig, random: () => number = Math.random): number {
  return config.jitterMs <= 1_000 ? config.jitterMs : 1_000 + Math.floor(random() * (config.jitterMs - 1_000));
}

/**
 * Decide one start. Critical memory pressure holds every start, the human's too; warning holds
 * paced ones by one slot (a fifth of nothing is still a wait, so the slot is the window split by the
 * budget) and the next claim re-checks. Otherwise the start is admitted while the window has room.
 */
export function decideStart(db: Database, candidate: StartCandidate, nowMs: number, config: StartPaceConfig,
  level: number = memoryPressureLevel(nowMs), random: () => number = Math.random): StartDecision {
  const slotMs = Math.ceil(config.windowMs / config.budget);
  if (level >= MEMORY_CRITICAL || (level >= MEMORY_WARNING && !candidate.exempt))
    return { admit: false, hold: START_MEMORY_HOLD, nextMs: nowMs + slotMs + jitter(config, random) };
  if (candidate.exempt) return { admit: true };
  const freeAt = budgetFreeAtMs(db, nowMs, config);
  return freeAt === null ? { admit: true } : { admit: false, hold: START_PACE_HOLD_PREFIX, nextMs: freeAt };
}

export function recordStart(db: Database, turnId: number, nowMs: number) {
  db.query("INSERT OR REPLACE INTO start_pace_starts(turn_id,started_ms) VALUES(?,?)").run(turnId, nowMs);
}

export function deferStart(db: Database, turnId: number, decision: Extract<StartDecision, { admit: false }>) {
  db.query(`UPDATE turns SET dispatch_failure_class='backoff', dispatch_hold=?, dispatch_next_attempt_ms=?
    WHERE id=? AND status='queued'`).run(decision.hold, decision.nextMs, turnId);
}

/** Tejas-originated work first, then work some open Inbox request waits on, then the rest. */
const FALLBACK_TIER_SQL = `CASE
  WHEN (SELECT origin FROM session_inputs WHERE id=turn.accepted_input_id)='human' THEN 0
  WHEN EXISTS (SELECT 1 FROM session_communication_requests request
      JOIN inbox_requests inbox ON inbox.state='open'
      JOIN json_each(inbox.dispatches_json) dispatch ON json_extract(dispatch.value,'$.requestId')=request.request_id
      WHERE request.target_session_id=turn.session_id AND request.outcome IS NULL) THEN 1
  ELSE 2 END`;

/** The fixed order of the line, also the order the claim picks among starts due at once. */
export const START_ORDER_SQL = `${FALLBACK_TIER_SQL}, turn.id`;

export type WaitingStart = { turnId: number; sessionId: number; tier: number };

export function waitingStarts(db: Database): WaitingStart[] {
  return (db.query(`SELECT turn.id AS turnId, turn.session_id AS sessionId, ${FALLBACK_TIER_SQL} AS tier
    FROM turns turn
    WHERE turn.status='queued' AND (turn.dispatch_hold='${START_PACE_HOLD_PREFIX}' OR turn.dispatch_hold LIKE '${START_PACE_HOLD_PREFIX}:%')
    ORDER BY ${START_ORDER_SQL}`).all() as WaitingStart[]);
}

/**
 * Give every waiting start its place and its time. Groups of `budget` starts share an instant, and each
 * group follows the one before by a full window plus jitter, so a group never finds the window still
 * holding its predecessor and wakes do not align. The jitter is added per group, never per turn,
 * so the agent's order is the order they start in.
 */
export function slotWaitingStarts(db: Database, nowMs: number, config: StartPaceConfig,
  random: () => number = Math.random): { place: number; turnId: number; atMs: number }[] {
  const waiting = waitingStarts(db);
  if (!waiting.length) return [];
  let at = Math.max(nowMs, budgetFreeAtMs(db, nowMs, config) ?? nowMs) + jitter(config, random);
  const update = db.query("UPDATE turns SET dispatch_hold=?, dispatch_next_attempt_ms=? WHERE id=? AND status='queued'");
  return waiting.map((turn, index) => {
    if (index > 0 && index % config.budget === 0) at += config.windowMs + jitter(config, random);
    update.run(`${START_PACE_HOLD_PREFIX}:${index + 1}`, at, turn.turnId);
    return { place: index + 1, turnId: turn.turnId, atMs: at };
  });
}

/** After a start leaves the line, the others keep their times and move up in place. */
export function renumberWaitingStarts(db: Database): number {
  const update = db.query("UPDATE turns SET dispatch_hold=? WHERE id=? AND status='queued'");
  const waiting = waitingStarts(db);
  waiting.forEach((turn, index) => update.run(`${START_PACE_HOLD_PREFIX}:${index + 1}`, turn.turnId));
  return waiting.length;
}

export function ordinal(place: number): string {
  const tail = place % 100, suffix = tail >= 11 && tail <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[place % 10] ?? "th";
  return `${place}${suffix}`;
}

/** What the session shows while its start waits; the place and the time are the whole point. */
export function startPaceStatus(hold: string | null | undefined, when: string | null, who: string): string | null {
  if (hold === START_MEMORY_HOLD) return `Waiting: this machine’s memory is under pressure. ${who} starts as soon as it eases${when ? `, checked again about ${when}` : ""}.`;
  if (!holdIsStartPace(hold)) return null;
  const place = startPacePlace(hold);
  return `Waiting its turn: ${place ? `${ordinal(place)}, ` : ""}${when ? `starts about ${when}` : "starting now"}. This machine starts a few sessions at a time so it is not swamped.`;
}
