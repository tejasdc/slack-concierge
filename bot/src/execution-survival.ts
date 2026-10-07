/**
 * Which running work carries on through a coordinator restart, decided in one place for the queue
 * (what may start while an update installs), the update gate (what it waits for) and the update
 * line (what it says continues). Design 2026-10-07 §9 step 7; docs/architecture/EXECUTION-HOST.md.
 *
 * A kind of run (provider and supervisor) counts only once this machine has seen one survive: an
 * execution of that kind that a later coordinator took back and then settled and released. Until
 * then the update waits for it exactly as before, so a host never proven here cannot cut work off.
 * Takes the database as a parameter so the deployment scripts, which open the ledger themselves,
 * use the same rule.
 */
import type { Database } from "bun:sqlite";
import { ADOPTABLE_HOST_PROTOCOLS } from "./execution-host-client";

function hostsEnabled() {
  return process.platform === "linux" && process.env.CONCIERGE_EXECUTION_HOSTS !== "0";
}

function hasExecutions(database: Database) {
  return !!database.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executions'").get();
}

export function provenRunKinds(database: Database): Set<string> {
  if (!hostsEnabled() || !hasExecutions(database)) return new Set();
  return new Set((database.query(`SELECT DISTINCT provider || '/' || supervisor AS kind FROM executions
    WHERE adoptions>0 AND state='released'`).all() as { kind: string }[]).map(row => row.kind));
}

/** What may start while an update installs: only kinds proven to carry on through its restart. */
export function survivableRunKinds(database: Database) {
  const proven = provenRunKinds(database);
  return { claude: proven.has("claude-code/systemd"), codexShared: proven.has("codex/codex-daemon"), codexPrivate: proven.has("codex/systemd") };
}

/** A running turn the next coordinator will take back: its execution is proven and adoptable. */
export function turnContinuesThroughRestart(database: Database, turnId: number, proven = provenRunKinds(database)): boolean {
  if (!proven.size) return false;
  return (database.query(`SELECT e.provider, e.supervisor, e.host_protocol
    FROM executions e JOIN turns t ON t.id=e.turn_id AND t.dispatch_attempt=e.dispatch_attempt
    WHERE e.turn_id=? AND e.state IN ('intended','live','exited')`).all(turnId) as { provider: string; supervisor: string; host_protocol: number }[])
    .some(execution => proven.has(`${execution.provider}/${execution.supervisor}`) && ADOPTABLE_HOST_PROTOCOLS.includes(execution.host_protocol));
}
