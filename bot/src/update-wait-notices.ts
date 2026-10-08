import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./state-database";
import { log } from "./log";
import { nativeRunId } from "./session-inputs";
import { provenRunKinds, turnContinuesThroughRestart } from "./execution-survival";
import { STILL_WAITING_AFTER_MS } from "./request-liveness";

/**
 * While a Concierge update waits on an agent, that agent hears about it.
 *
 * An update installs only when nothing running would be cut off by the restart, and that wait has no
 * end of its own. Before this, only a Claude agent's background job was told; on 2026-10-08 an update
 * waited 55 minutes on a Codex turn and the agent heard nothing. So once an update has waited
 * `STILL_WAITING_AFTER_MS` (15 minutes [decision: still-waiting-after-15-minutes]), each run it waits
 * for gets one service notice steered into that exact live run, and a second at an hour.
 *
 * Tejas is not told here: thnkr.ing's update line already shows the wait, how long, and for which
 * conversations. An Inbox notice on top of it was built and removed the same morning ("I don't need
 * another inbox notification … Why are we building duplicate notification systems here?").
 * Nothing here holds, ends or hurries anything.
 *
 * Where the wait comes from: on the server it is the deployment run that is draining; on the Mac it
 * is the marker `update-mac.sh` writes when it finds work that would not survive the restart and
 * removes when it installs.
 */

const AGENT_MARKS_MINUTES = [STILL_WAITING_AFTER_MS / 60_000, 60];
const TICK_MS = 60_000;

type Admission = {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string;
  sourceRunId: string; requestId: string; text: string; delivery: "steer";
};
type UpdateWait = { key: string; since: number };

export type UpdateWaitWatchOptions = { admit: (input: Admission) => unknown; stateDir: string };

/** The marker the Mac's updater keeps while its update waits on running work. */
export const MAC_UPDATE_WAITING_FILE = "update-waiting.json";

const told = new Set<string>();

function currentWait(stateDir: string): UpdateWait | null {
  const run = db.query(`SELECT id,created_at FROM deployment_runs WHERE target='concierge'
    AND status IN ('prepared','draining') ORDER BY created_at DESC LIMIT 1`).get() as { id: string; created_at: string } | null;
  if (run) {
    const since = (db.query(`SELECT MIN(created_at) AS at FROM deployment_run_events WHERE run_id=?
      AND event IN ('prepared','draining')`).get(run.id) as { at: string | null } | null)?.at ?? run.created_at;
    return { key: run.id, since: Date.parse(since.endsWith("Z") ? since : `${since.replace(" ", "T")}Z`) };
  }
  const marker = join(stateDir, MAC_UPDATE_WAITING_FILE);
  if (!existsSync(marker)) return null;
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { since?: unknown };
    return typeof value.since === "number" ? { key: `mac-${value.since}`, since: value.since * 1000 } : null;
  } catch { return null; }
}

/** The running turns an update waits for: everything that would not carry on through its restart. */
function blockers(): { turnId: number; sessionId: number }[] {
  const running = db.query(`SELECT id, session_id FROM turns
    WHERE status IN ('running','delivering') AND session_id IS NOT NULL ORDER BY id`).all() as { id: number; session_id: number }[];
  const proven = provenRunKinds(db);
  return running.filter(turn => !turnContinuesThroughRestart(db, turn.id, proven))
    .map(turn => ({ turnId: turn.id, sessionId: turn.session_id }));
}

export function startUpdateWaitWatch(options: UpdateWaitWatchOptions): () => void {
  const tick = () => {
    try {
      const wait = currentWait(options.stateDir);
      if (!wait) { told.clear(); return; }
      const waited = Date.now() - wait.since;
      if (!(waited >= STILL_WAITING_AFTER_MS)) return;
      for (const run of blockers()) for (const mark of AGENT_MARKS_MINUTES) {
        if (waited < mark * 60_000) continue;
        const id = `update-wait:${wait.key}:${nativeRunId(run.turnId)}:${mark}`;
        if (told.has(id)) continue;
        told.add(id);
        try {
          options.admit({ sessionId: run.sessionId, inputId: id, origin: "service", sourceInputId: id,
            sourceRunId: nativeRunId(run.turnId), requestId: id, delivery: "steer",
            text: `A Concierge update has been waiting ${Math.floor(waited / 60_000)} minutes for this run to finish. It installs on its own once nothing running would be cut off by the restart; nothing will interrupt you, so carry on with real work. If this turn is only waiting (a sleep, a poll, a job you no longer need), end the turn instead and register a watch with router-actions.sh sessions watch, which wakes you when the thing happens and never holds an update. This is a service notice, not a request; no reply is owed.` });
          log("info", "update_wait_agent_notice_sent", { wait: wait.key, turn_id: run.turnId, mark });
        } catch (error) {
          // The exact run may have ended between reading it and steering into it; nothing to tell then.
          log("info", "update_wait_agent_notice_skipped", { wait: wait.key, turn_id: run.turnId, mark,
            reason: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      log("warn", "update_wait_notice_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
