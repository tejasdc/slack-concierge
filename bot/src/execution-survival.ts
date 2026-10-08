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

export function provenRunKinds(database: Database): Set<string> {
  // A run already in a host continues whether or not this process could start new ones (the Mac's
  // updater shell has no agent-host launcher), so proof is read from the record alone.
  if (!hasExecutions(database)) return new Set();
  if (!database.query("SELECT 1 FROM pragma_table_info('executions') WHERE name='adopted_live'").get()) return new Set();
  return new Set((database.query(`SELECT DISTINCT provider || '/' || supervisor AS kind FROM executions
    WHERE adopted_live=1 AND state='released'`).all() as { kind: string }[]).map(row => row.kind)
    .filter(kind => kind !== "codex/codex-daemon" || managedHooksFollowRuns()));
}
// A shared Codex turn's hooks run from the machine-wide wrappers with the daemon's environment. They
// follow the turn only when the installed wrappers look up its filed helper folder (hook-pins.ts);
// until then (an older wrapper, the Mac before its password step) an update waits for these turns
// however well they survive a restart (step-6 review, 2026-10-07).

/** What may start while an update installs: only kinds proven to carry on through its restart. */
export function survivableRunKinds(database: Database) {
  const proven = provenRunKinds(database);
  // New runs survive only if they will start in a host of a proven kind on this machine.
  const hosted = executionHostsEnabled();
  return { claude: hosted && proven.has(`claude-code/${HOST_SUPERVISOR}`), codexShared: proven.has("codex/codex-daemon"),
    codexPrivate: hosted && proven.has(`codex/${HOST_SUPERVISOR}`) };
}

/** A running turn the next coordinator will take back: its execution is proven and adoptable. */
export function turnContinuesThroughRestart(database: Database, turnId: number, proven = provenRunKinds(database)): boolean {
  if (!proven.size) return false;
  return (database.query(`SELECT e.provider, e.supervisor, e.host_protocol
    FROM executions e JOIN turns t ON t.id=e.turn_id AND t.dispatch_attempt=e.dispatch_attempt
    WHERE e.turn_id=? AND e.state IN ('intended','live','exited')`).all(turnId) as { provider: string; supervisor: string; host_protocol: number }[])
    .some(execution => proven.has(`${execution.provider}/${execution.supervisor}`) && ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol));
}
