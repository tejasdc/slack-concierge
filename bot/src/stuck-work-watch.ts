import { db } from "./state-database";
import { log } from "./log";
import { claimableNotClaimed } from "./state";
import { undeliveredReturnRows } from "./session-return-audit";
import { updateDraining } from "./request-liveness";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";

/**
 * Concierge watches its own queues for work that should be moving and is not, so nobody wakes up
 * to find every agent stuck while Concierge itself looks healthy (Tejas, 2026-10-08).
 *
 * Two things should never sit still for ten minutes: a queued turn the queue itself would start
 * right now (its own claim rule, which already lets an update hold work), and a finished answer
 * that has not gone back to the session that asked. When either appears, Concierge first wakes its
 * own queues once, because a missed wake is the cheapest cause. If the same work is still waiting
 * five minutes after that, one provider-free Inbox notice says so; it closes itself once nothing is
 * waiting. The outside supervisor in remote-box does not repeat this: it only revives Concierge
 * when Concierge is down or frozen, which is the one thing Concierge cannot do for itself.
 */
const EVERY_MS = 60_000;
const WAITING_AT_LEAST_MS = 10 * 60_000;
const NOTICE_AFTER_WAKE_MS = 5 * 60_000;
const NOTICE_PREFIX = "stuck-work:";

type Waiting = { turns: number[]; answers: string[] };

let timer: ReturnType<typeof setInterval> | null = null;
let woken: { at: number; turns: Set<number>; answers: Set<string> } | null = null;
let noticeOpen = false;

export function startStuckWorkWatch(wake: () => string[], activeSessionIds: () => readonly number[]): void {
  if (timer) return;
  noticeOpen = openNoticeExists();
  timer = setInterval(() => {
    try { evaluate(Date.now(), wake, activeSessionIds); }
    catch (error) { log("error", "stuck_work_watch_failed", { error: String(error) }); }
  }, EVERY_MS);
  timer.unref?.();
  log("info", "stuck_work_watch_started", { every_ms: EVERY_MS, waiting_at_least_ms: WAITING_AT_LEAST_MS, open_notice: noticeOpen });
}

function waitingNow(now: number, activeSessionIds: readonly number[]): Waiting {
  return {
    turns: claimableNotClaimed(now, activeSessionIds, WAITING_AT_LEAST_MS, 30).map(row => row.turnId),
    // The queue rule above already knows what an update holds; answers are not judged while one
    // drains, the same rule the overdue-request check uses.
    answers: updateDraining() ? [] : undeliveredReturnRows(now, 30).map(row => row.event_id),
  };
}

function evaluate(now: number, wake: () => string[], activeSessionIds: () => readonly number[]): void {
  const waiting = waitingNow(now, activeSessionIds());
  if (!waiting.turns.length && !waiting.answers.length) {
    woken = null;
    if (noticeOpen) closeNotices(now);
    return;
  }
  // Only work that was already waiting when the queues were woken can be reported: anything that
  // started waiting since gets its own wake and its own five minutes first.
  const stillWaiting: Waiting = woken
    ? { turns: waiting.turns.filter(id => woken!.turns.has(id)), answers: waiting.answers.filter(id => woken!.answers.has(id)) }
    : { turns: [], answers: [] };
  if (!stillWaiting.turns.length && !stillWaiting.answers.length) {
    woken = { at: now, turns: new Set(waiting.turns), answers: new Set(waiting.answers) };
    log("warn", "stuck_work_woken", { turns: waiting.turns, answers: waiting.answers, woken: wake() });
    return;
  }
  if (noticeOpen || now - woken!.at < NOTICE_AFTER_WAKE_MS) return;
  openNotice(now, woken!.at, stillWaiting);
}

function openNotice(now: number, wokenAt: number, waiting: Waiting): void {
  const turns = waiting.turns.length, answers = waiting.answers.length;
  const parts = [
    turns ? (turns === 1 ? "one piece of work you asked agents for hasn't started"
      : `${turns} pieces of work you asked agents for haven't started`) : "",
    answers ? (answers === 1 ? "an agent is still waiting for an answer that another agent has already finished"
      : `${answers} agents are still waiting for answers that other agents have already finished`) : "",
  ].filter(Boolean).join(", and ");
  const text = `Work you asked agents for hasn't moved in over ten minutes, as of ${noticeTime(db, now)}: ${parts}.`
    + " Reply here if you want an agent to investigate.";
  log("error", "stuck_work", { turns: waiting.turns, answers: waiting.answers });
  try {
    if (publishProviderFreeNotice(db, { key: `${NOTICE_PREFIX}${wokenAt}`, kind: "stuck_work", text,
      payload: { turnIds: waiting.turns, answerEventIds: waiting.answers } })) fileServiceNotices();
    noticeOpen = true;
  } catch (error) {
    log("error", "stuck_work_notice_failed", { error: String(error) });
  }
}

/** Every open stuck-work notice, including one a previous process opened before a restart. */
function closeNotices(now: number): void {
  const rows = db.query(`SELECT id FROM session_inputs WHERE scope=? AND id LIKE ?`)
    .all(SERVICE_NOTICE_SCOPE, `service:service-notice:${NOTICE_PREFIX}%`) as { id: string }[];
  let failed = false;
  for (const row of rows) {
    try { settleServiceNotice({ inputId: row.id, text: `The stuck agent work started moving again as of ${noticeTime(db, now)}.` }); }
    catch (error) { failed = true; log("error", "stuck_work_settle_failed", { input_id: row.id, error: String(error) }); }
  }
  if (!failed) noticeOpen = false;
}

function openNoticeExists(): boolean {
  return !!db.query(`SELECT 1 FROM session_inputs input WHERE input.scope=? AND input.id LIKE ?
    AND NOT EXISTS (SELECT 1 FROM session_owner_events event WHERE event.event_id='post:service-resolved:'||input.id) LIMIT 1`)
    .get(SERVICE_NOTICE_SCOPE, `service:service-notice:${NOTICE_PREFIX}%`);
}
