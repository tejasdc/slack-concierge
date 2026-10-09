/**
 * Which running work carries on through a coordinator restart, decided in one place for the queue
 * (what may start while an update installs), the update gate (what it waits for) and the update
 * line (what it says continues). Design 2026-10-07 §9 step 7; docs/architecture/EXECUTION-HOST.md.
 *
 * A kind of run (provider and supervisor) counts only once this machine has seen one survive: an
 * execution of that kind whose provider was still running when a later coordinator took it over
 * (`adopted_live`), and that then settled and was released. A run settled from a finished record or
 * merely claimed proves nothing. Until then the update waits for it exactly as before, so a host
 * never proven here cannot cut work off.
 * Takes the database as a parameter so the deployment scripts, which open the ledger themselves,
 * use the same rule.
 */
import type { Database } from "bun:sqlite";
import { ADOPTABLE_HOST_PROTOCOLS, HOST_SUPERVISOR, executionHostsEnabled } from "./execution-host-client";
import { managedHooksFollowRuns } from "./hook-pins";


function hasExecutions(database: Database) {
  return !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'").get();
}

/**
 * A ChatGPT run never lived in a process here: Thinkering's capability sends the message and keeps
 * ChatGPT's answer under the run id recorded before the send, and Concierge only watches. The next
 * coordinator asks for that run by id (session-capability-client.ts `follow`), so it carries on
 * through a restart by construction and needs no observed survival first. Waiting for one to be
 * observed would never happen: every update waited for these runs, so none was ever taken over
 * (two ChatGPT Pro reviews held an update on 2026-10-09 while 12 other runs carried on).
 */
export const CHATGPT_RUN_KIND = "chatgpt/capability-host";

export function provenRunKinds(database: Database): Set<string> {
  // A run already in a host continues whether or not this process could start new ones (the Mac's
  // updater shell has no agent-host launcher), so proof is read from the record alone.
  if (!hasExecutions(database)) return new Set();
  if (!database.query("SELECT 1 FROM pragma_table_info('executions') WHERE name='adopted_live'").get()) return new Set();
  return new Set([CHATGPT_RUN_KIND, ...(database.query(`SELECT DISTINCT provider || '/' || supervisor AS kind FROM executions
    WHERE adopted_live=1 AND state='released'`).all() as { kind: string }[]).map(row => row.kind)
    .filter(kind => kind !== "codex/codex-daemon" || managedHooksFollowRuns())]);
}
// A shared Codex turn's hooks run from the machine-wide wrappers with the daemon's environment. They
// follow the turn only when the installed wrappers look up its filed helper folder (hook-pins.ts);
// until then (an older wrapper, the Mac before its password step) an update waits for these turns
// however well they survive a restart (step-6 review, 2026-10-07).

/** What may start while an update installs: only kinds proven to carry on through its restart. */
export function survivableRunKinds(database: Database) {
  const proven = provenRunKinds(database);
  // Claude needs a proven host; Codex uses the proven shared daemon directly.
  const hosted = executionHostsEnabled();
  return { claude: hosted && proven.has(`claude-code/${HOST_SUPERVISOR}`), codexShared: proven.has("codex/codex-daemon") };
}

/** A running turn the next coordinator will take back: its execution is proven and adoptable. */
export function turnContinuesThroughRestart(database: Database, turnId: number, proven = provenRunKinds(database)): boolean {
  if (!proven.size) return false;
  return (database.query(`SELECT e.provider, e.supervisor, e.host_protocol
    FROM executions e JOIN turns t ON t.id=e.turn_id AND t.dispatch_attempt=e.dispatch_attempt
    WHERE e.turn_id=? AND e.state IN ('intended','live','exited')`).all(turnId) as { provider: string; supervisor: string; host_protocol: number }[])
    .some(execution => proven.has(`${execution.provider}/${execution.supervisor}`) && ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol));
}

/**
 * Why the update waits for this running turn, in words for the update line. Every answer is the
 * one fact the rule above found missing, so it says what would let the run carry on instead.
 */
export function whyTurnHoldsUpdate(database: Database, turnId: number, proven = provenRunKinds(database)): string {
  const turn = database.query("SELECT t.status, s.provider_id FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=?")
    .get(turnId) as { status: string; provider_id: string } | null;
  if (turn?.status === "delivering") return "Its answer is being saved; that takes a moment.";
  const execution = hasExecutions(database) ? database.query(`SELECT e.provider, e.supervisor, e.host_protocol FROM executions e
      JOIN turns t ON t.id=e.turn_id AND t.dispatch_attempt=e.dispatch_attempt
      WHERE e.turn_id=? AND e.state IN ('intended','live','exited') ORDER BY e.created_at_ms DESC LIMIT 1`)
    .get(turnId) as { provider: string; supervisor: string; host_protocol: number } | null : null;
  if (!execution) return turn?.provider_id === "chatgpt"
    ? "This ChatGPT request was sent before Concierge could pick a ChatGPT run back up after a restart."
    : "This run is inside Concierge's own process, so restarting Concierge would cut it off.";
  if (!ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol))
    return "It runs on an older agent runner that the new version cannot take over.";
  if (!proven.has(`${execution.provider}/${execution.supervisor}`))
    return execution.supervisor === "codex-daemon" && !managedHooksFollowRuns()
      ? "Codex's helper commands on this machine do not yet follow a run through a restart."
      : "This machine has not yet seen this kind of run carry on through a restart.";
  return "It cannot be taken over after a restart.";
}
