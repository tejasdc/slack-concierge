import type { Database } from "bun:sqlite";
import { cpus, loadavg } from "node:os";
import { MEMORY_WARNING, memoryPressureLevel } from "./start-pace";

/**
 * A crowded machine and what its agents are told about it (docs/plans/2026-11-12-mac-held-work-pacing.md,
 * "Agents snooze themselves"). Tejas, 2026-11-12: instead of another agent ordering the queue, tell the
 * agents the machine is crowded and let those whose work can wait snooze themselves; work he is
 * actively waiting on never waits. Per-machine configuration; the Mac turns it on, the server leaves it off.
 */
export type CrowdingConfig = { sessions: number; loadFactor: number };
export type Crowding = { crowded: boolean; reasons: string[]; running: number; memoryLevel: number; load: number; cores: number };

export function crowdingConfig(env: Record<string, string | undefined> = process.env): CrowdingConfig | null {
  const sessions = Number(env.CONCIERGE_CROWD_SESSIONS);
  if (!Number.isInteger(sessions) || sessions < 1) return null;
  const loadFactor = Number(env.CONCIERGE_CROWD_LOAD_FACTOR ?? 2);
  return { sessions, loadFactor: Number.isFinite(loadFactor) && loadFactor > 0 ? loadFactor : 2 };
}

export function readCrowding(db: Database, config: CrowdingConfig, nowMs = Date.now(),
  facts: { load?: number; cores?: number; memoryLevel?: number } = {}): Crowding {
  const running = (db.query("SELECT count(*) AS n FROM turns WHERE status='running'").get() as { n: number }).n;
  const memoryLevel = facts.memoryLevel ?? memoryPressureLevel(), load = facts.load ?? loadavg()[0]!, cores = facts.cores ?? cpus().length;
  const reasons: string[] = [];
  if (running > config.sessions) reasons.push(`${running} provider sessions are running here (more than ${config.sessions})`);
  if (memoryLevel >= MEMORY_WARNING) reasons.push(`macOS reports memory pressure (level ${memoryLevel}; 2 is warning, 4 is critical)`);
  if (load > config.loadFactor * cores) reasons.push(`the one-minute load average is ${load.toFixed(1)} on ${cores} processors (more than ${config.loadFactor}x)`);
  return { crowded: reasons.length > 0, reasons, running, memoryLevel, load, cores };
}

/** Whether this input's own work is something he is waiting on: his direct message, or the Inbox router. */
export function workIsHisToWaitOn(db: Database, turnId: number): boolean {
  const row = db.query(`SELECT input.origin AS origin, json_extract(session.native_metadata_json,'$.inboxRole') AS role
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    LEFT JOIN session_inputs input ON input.id=turn.accepted_input_id WHERE turn.id=?`).get(turnId) as { origin: string | null; role: string | null } | null;
  return !row || row.origin === "human" || row.role === "project-router";
}

export const MAX_SNOOZE_MS = 6 * 3_600_000;

/** Added to a started turn's context while crowded; never to his own direct message, never mid-turn. */
export function crowdingNotice(crowding: Crowding): string {
  return `This machine is crowded right now: ${crowding.reasons.join("; ")}. If your work is not needed right now, take a pass: `
    + `run \`router-actions.sh sessions snooze --until <ISO time, at most 6 hours away> --reason "<why this can wait>"\` with this input's `
    + `source pair and a stable action ID, then end your turn. You wake at that time with this session's context and every open request still open; `
    + `snooze again then if it is still crowded. Judge from the work itself: anything Tejas is actively waiting on, or anything that is part of `
    + `something he asked for just now, must not snooze. If in doubt, carry on.`;
}
