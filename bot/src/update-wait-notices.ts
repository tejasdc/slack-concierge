import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "./state-database";
import { log } from "./log";
import { nativeRunId } from "./session-inputs";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";
import { provenRunKinds, turnContinuesThroughRestart } from "./execution-survival";
import { STILL_WAITING_AFTER_MS } from "./request-liveness";
import type { PeerClient } from "./session-peers";

/**
 * While a Concierge update waits on agents, Tejas and each of those agents hear about it.
 *
 * An update installs only when no running work would be cut off by the restart. That wait has no
 * end of its own: on 2026-10-08 one waited 55 minutes on a Codex turn and nobody was told, not him
 * and not the agent ("I thought like we had like a 15 minute warning … if there are some certain
 * sections that we wait for, we still need the system, right?"). His rule: as long as an update can
 * wait on an agent, he and that agent must hear about it. So once an update has waited
 * `STILL_WAITING_AFTER_MS` (15 minutes, the same mark as every other "still waiting" notice
 * [decision: still-waiting-after-15-minutes]):
 *   - each run it is waiting for gets one service notice steered into that exact live run, and a
 *     second at an hour, saying the update waits for it, that nothing will be cut off, and that a
 *     turn that is only waiting should end and register a watch instead;
 *   - Tejas gets one provider-free Inbox notice naming those conversations, which closes itself
 *     with what happened once the update stops waiting.
 * Nothing here holds, ends or speeds anything up: he ruled out bounding an update's wait
 * (2026-10-08, "We don't have to make sure an update has happened in a boundary time").
 *
 * Where the wait comes from: on the server it is the deployment run that is draining; on the Mac it
 * is the marker `update-mac.sh` writes when it finds work that would not survive the restart and
 * removes when it installs. A machine without the Inbox (the Mac) sends his notice to the server's
 * Inbox over the peer channel, the way project set-up notices travel.
 */

const AGENT_MARKS_MINUTES = [STILL_WAITING_AFTER_MS / 60_000, 60];
const NOTICE_PREFIX = "update-waiting:";
const TICK_MS = 60_000;

type Admission = {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string;
  sourceRunId: string; requestId: string; text: string; delivery: "steer";
};
type UpdateWait = { key: string; since: number; machine: string };
type Blocker = { turnId: number; sessionId: number; title: string };
type OpenNotice = { key: string; delivered: boolean; text: string };

export type UpdateWaitWatchOptions = {
  admit: (input: Admission) => unknown;
  stateDir: string;
  /** This instance's peer name, and the server's client when this machine has no Inbox. */
  self: string;
  cloud: () => PeerClient | null;
};

/** The marker the Mac's updater keeps while its update waits on running work. */
export const MAC_UPDATE_WAITING_FILE = "update-waiting.json";

const told = new Set<string>();

function hasInbox(): boolean {
  return !!db.query("SELECT 1 FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 LIMIT 1").get();
}

function currentWait(stateDir: string, self: string): UpdateWait | null {
  const run = db.query(`SELECT id,created_at FROM deployment_runs WHERE target='concierge'
    AND status IN ('prepared','draining') ORDER BY created_at DESC LIMIT 1`).get() as { id: string; created_at: string } | null;
  if (run) {
    const since = (db.query(`SELECT MIN(created_at) AS at FROM deployment_run_events WHERE run_id=?
      AND event IN ('prepared','draining')`).get(run.id) as { at: string | null } | null)?.at ?? run.created_at;
    return { key: run.id, since: Date.parse(since.endsWith("Z") ? since : `${since.replace(" ", "T")}Z`), machine: self };
  }
  const marker = join(stateDir, MAC_UPDATE_WAITING_FILE);
  if (!existsSync(marker)) return null;
  try {
    const value = JSON.parse(readFileSync(marker, "utf8")) as { candidate?: unknown; since?: unknown };
    if (typeof value.candidate !== "string" || typeof value.since !== "number") return null;
    return { key: `mac-${value.since}`, since: value.since * 1000, machine: self };
  } catch { return null; }
}

/** The running turns an update waits for: everything that would not carry on through its restart. */
function blockers(): Blocker[] {
  const running = db.query(`SELECT t.id, t.session_id, json_extract(s.native_metadata_json,'$.title') AS title
    FROM turns t JOIN sessions s ON s.id=t.session_id
    WHERE t.status IN ('running','delivering') AND t.session_id IS NOT NULL ORDER BY t.id`)
    .all() as { id: number; session_id: number; title: string | null }[];
  const proven = provenRunKinds(db);
  return running.filter(turn => !turnContinuesThroughRestart(db, turn.id, proven))
    .map(turn => ({ turnId: turn.id, sessionId: turn.session_id, title: turn.title?.trim() || `conversation ${turn.session_id}` }));
}

function machineName(self: string) { return self === "mac" ? "your Mac" : "the server"; }

function tellAgents(options: UpdateWaitWatchOptions, wait: UpdateWait, waited: number, runs: Blocker[]) {
  for (const run of runs) for (const mark of AGENT_MARKS_MINUTES) {
    if (waited < mark * 60_000) continue;
    const id = `update-wait:${wait.key}:${nativeRunId(run.turnId)}:${mark}`;
    if (told.has(id)) continue;
    told.add(id);
    try {
      options.admit({ sessionId: run.sessionId, inputId: id, origin: "service", sourceInputId: id,
        sourceRunId: nativeRunId(run.turnId), requestId: id, delivery: "steer",
        text: `A Concierge update has been waiting ${Math.floor(waited / 60_000)} minutes for this run to finish. It installs on its own once nothing running would be cut off by the restart; nothing will interrupt you, so carry on with real work. If this turn is only waiting (a sleep, a poll, a job you no longer need), end the turn instead and register a watch with router-actions.sh sessions watch, which wakes you when the thing happens and never holds an update. Tejas has been told the update is waiting. This is a service notice, not a request; no reply is owed.` });
      log("info", "update_wait_agent_notice_sent", { wait: wait.key, turn_id: run.turnId, mark });
    } catch (error) {
      // The exact run may have ended between reading it and steering into it; nothing to tell then.
      log("info", "update_wait_agent_notice_skipped", { wait: wait.key, turn_id: run.turnId, mark,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
}

function openNoticeFile(stateDir: string) { return join(stateDir, "update-wait-notice.json"); }
function readOpen(stateDir: string): OpenNotice | null {
  try { return JSON.parse(readFileSync(openNoticeFile(stateDir), "utf8")) as OpenNotice; } catch { return null; }
}
function writeOpen(stateDir: string, value: OpenNotice | null) {
  const path = openNoticeFile(stateDir);
  if (!value) { if (existsSync(path)) renameSync(path, `${path}.closed`); return; }
  writeFileSync(`${path}.tmp`, JSON.stringify(value)); renameSync(`${path}.tmp`, path);
}

/** Records his notice here, or on the server's Inbox when this machine has none. */
async function deliver(options: UpdateWaitWatchOptions, key: string, text: string, settle: boolean): Promise<void> {
  if (hasInbox()) {
    acceptUpdateWaitNotice({ sourcePeer: options.self, key, text, settle });
    return;
  }
  const cloud = options.cloud();
  if (!cloud) throw new Error("No Inbox on this machine and no server peer to carry the update notice.");
  await cloud.request("POST", "/sessions/v1/peers/update-wait-notices", { sourcePeer: options.self, key, text, settle });
}

/** The Inbox side, for this machine's own wait or one a peer sent. Repeating either is harmless. */
export function acceptUpdateWaitNotice(value: unknown): { recorded: boolean } {
  const data = value as { sourcePeer?: unknown; key?: unknown; text?: unknown; settle?: unknown };
  if (typeof data?.sourcePeer !== "string" || !/^[\w-]{1,40}$/.test(data.sourcePeer) || typeof data.key !== "string"
    || !/^[\w:-]{1,80}$/.test(data.key) || typeof data.text !== "string" || data.text.length > 4000 || typeof data.settle !== "boolean")
    throw new Error("Invalid update-wait notice.");
  const noticeKey = `${NOTICE_PREFIX}${data.sourcePeer}:${data.key}`;
  if (data.settle) {
    const row = db.query("SELECT id FROM session_inputs WHERE scope=? AND id=?")
      .get(SERVICE_NOTICE_SCOPE, `service:service-notice:${noticeKey}`) as { id: string } | null;
    return { recorded: row ? settleServiceNotice({ inputId: row.id, text: data.text }) : false };
  }
  const recorded = publishProviderFreeNotice(db, { key: noticeKey, kind: "update_waiting_on_agents", text: data.text,
    payload: { machine: data.sourcePeer, wait: data.key } });
  if (recorded) fileServiceNotices();
  return { recorded };
}

function settlementText(key: string, now: number): string {
  const run = db.query("SELECT status FROM deployment_runs WHERE id=?").get(key) as { status: string } | null;
  const when = noticeTime(db, now);
  if (run && run.status !== "succeeded") return `The update stopped waiting at ${when} without installing; the update line in thnkr.ing says why. Nothing waits on you.`;
  return `The update is installed as of ${when}. Nothing waits on you.`;
}

export function startUpdateWaitWatch(options: UpdateWaitWatchOptions): () => void {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      const wait = currentWait(options.stateDir, options.self);
      const open = readOpen(options.stateDir);
      if (open && open.key !== wait?.key) {
        // The wait it described is over. A notice never delivered needs no closing.
        if (open.delivered) await deliver(options, open.key, settlementText(open.key, now), true);
        log("info", "update_wait_notice_closed", { wait: open.key, delivered: open.delivered });
        writeOpen(options.stateDir, null);
      }
      if (!wait) { told.clear(); return; }
      const waited = now - wait.since;
      if (!(waited >= STILL_WAITING_AFTER_MS)) return;
      const runs = blockers();
      if (!runs.length) return;
      tellAgents(options, wait, waited, runs);
      const current = readOpen(options.stateDir);
      if (current?.key === wait.key && current.delivered) return;
      const names = runs.map(run => `“${run.title}”`);
      const text = current?.key === wait.key ? current.text
        : `A Concierge update on ${machineName(wait.machine)} has been waiting since ${noticeTime(db, wait.since)} for ${runs.length === 1 ? "one conversation" : `${runs.length} conversations`} still working: ${names.join(", ")}.`
          + " It installs on its own the moment they finish; nothing is cut off, and each of those agents has been told."
          + " You don't need to do anything. This closes by itself when the update is in.";
      writeOpen(options.stateDir, { key: wait.key, delivered: false, text });
      await deliver(options, wait.key, text, false);
      writeOpen(options.stateDir, { key: wait.key, delivered: true, text });
      log("info", "update_wait_notice_sent", { wait: wait.key, waiting_on: runs.length, waited_ms: waited });
    } catch (error) {
      log("warn", "update_wait_notice_waiting", { error: error instanceof Error ? error.message : String(error) });
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
