import { db } from "./state-database";
import { log } from "./log";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";

/**
 * Tells Tejas when the owner stops answering, on a path that does not depend on anyone reading
 * the journal.
 *
 * The owner answers every page, send and agent command from one event loop. `owner_event_loop_lag`
 * and `owner_request_slow` recorded every freeze, but nothing read them. On 2026-10-07/08 an
 * account check looped on itself (thousands of nested reads per Accounts open) and froze the owner
 * for 7–144 s at a time for about seven hours: about 1,000 lag lines an hour, no alert, no notice.
 * He found it from an update note. So freezes are counted here, as they happen, and a sustained one
 * becomes one provider-free Inbox notice. It needs no agent turn, so it still arrives when every
 * agent is stuck behind the same freeze. The notice names what the owner was doing in plain words,
 * from the requests that were slow at that time, and closes itself with "answering normally again"
 * once ten quiet minutes have passed.
 */
const WINDOW_MS = 5 * 60_000;
const BLOCKED_IN_WINDOW_MS = 60_000;      // a minute of freezing within five minutes
const SINGLE_FREEZE_MS = 30_000;          // or one freeze long enough to time out a page
const QUIET_TO_CLOSE_MS = 10 * 60_000;
const NOTICE_PREFIX = "owner-stuck:";

const stalls: { at: number; ms: number }[] = [];
const slow: { at: number; label: string; ms: number }[] = [];
let episodeStartedAt: number | null = null;
let lastBadAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** One late tick of the owner's 250 ms timer: the loop was held for `ms`. */
export function noteOwnerStall(ms: number): void {
  const now = Date.now();
  stalls.push({ at: now, ms });
  trim(now);
  // A long freeze ends with this tick; judge it now rather than a minute later.
  evaluate(now);
}

/** One owner request that took `ms`, so a notice can say what was slow. */
export function noteSlowOwnerRequest(label: string, ms: number): void {
  slow.push({ at: Date.now(), label, ms });
  trim(Date.now());
}

export function startOwnerResponsivenessWatch(): void {
  if (timer) return;
  // A freeze the previous process reported closes here only after this one has been quiet.
  lastBadAt = Date.now();
  episodeStartedAt = openNoticeExists() ? lastBadAt : null;
  log("info", "owner_responsiveness_watch_started", { window_ms: WINDOW_MS, blocked_in_window_ms: BLOCKED_IN_WINDOW_MS, single_freeze_ms: SINGLE_FREEZE_MS, open_notice: episodeStartedAt !== null });
  timer = setInterval(() => { try { evaluate(Date.now()); } catch (error) { log("error", "owner_responsiveness_failed", { error: String(error) }); } }, 60_000);
  timer.unref?.();
}

function trim(now: number): void {
  while (stalls.length && now - stalls[0]!.at > WINDOW_MS) stalls.shift();
  while (slow.length && now - slow[0]!.at > WINDOW_MS) slow.shift();
}

function evaluate(now: number): void {
  trim(now);
  const blocked = stalls.reduce((sum, stall) => sum + stall.ms, 0);
  const longest = stalls.reduce((max, stall) => Math.max(max, stall.ms), 0);
  const bad = blocked >= BLOCKED_IN_WINDOW_MS || longest >= SINGLE_FREEZE_MS;
  if (bad) {
    lastBadAt = now;
    if (episodeStartedAt === null) {
      episodeStartedAt = stalls[0]?.at ?? now;
      openNotice(now, blocked, longest);
    }
    return;
  }
  if (episodeStartedAt !== null && now - lastBadAt >= QUIET_TO_CLOSE_MS) {
    log("info", "owner_responsive_again", { episode_started_at: new Date(episodeStartedAt).toISOString() });
    episodeStartedAt = null;
    closeNotices(now);
  }
}

/** A route as he would name it on his screen. */
function plainRoute(label: string): string {
  const path = label.replace(/^[A-Z]+ /, "").split("?")[0]!;
  if (path.includes("/auth/")) return "the Accounts page";
  if (path.includes("/usage/")) return "Who used it";
  if (/\/history$/.test(path)) return "a conversation's history";
  if (path.includes("/inbox/topics")) return "Inbox threads";
  if (path.endsWith("/inbox")) return "the Inbox";
  if (path.endsWith("/search")) return "session search";
  if (/\/sessions\/[^/]+\/inputs$/.test(path)) return "sending a message";
  if (/\/sessions\/[^/]+$/.test(path)) return "opening a conversation";
  if (path.endsWith("/sessions")) return "the session list";
  if (path.includes("/projects")) return "the project list";
  return "another page";
}

function openNotice(now: number, blocked: number, longest: number): void {
  const byRoute = new Map<string, { count: number; ms: number }>();
  for (const request of slow) {
    const name = plainRoute(request.label);
    const entry = byRoute.get(name) ?? { count: 0, ms: 0 };
    entry.count += 1; entry.ms += request.ms; byRoute.set(name, entry);
  }
  const busiest = [...byRoute].sort((a, b) => b[1].ms - a[1].ms).slice(0, 3)
    .map(([name, entry]) => `${name} (${entry.count} slow, ${Math.round(entry.ms / 1000)} seconds in all)`);
  // Requests explain a freeze only when they account for a real share of it; otherwise the time
  // went to Concierge's own background work and naming a page would point the wrong way.
  const slowTotal = [...byRoute.values()].reduce((sum, entry) => sum + entry.ms, 0);
  const what = busiest.length && slowTotal >= blocked / 4
    ? `The slowest things it was doing: ${busiest.join("; ")}.`
    : "Pages were not the cause: most of that time went to Concierge's own background work, with nothing waiting on it.";
  const text = `Concierge stopped answering for ${Math.round(blocked / 1000)} seconds of the last five minutes`
    + ` (the longest single freeze was ${Math.round(longest / 1000)} seconds), from ${noticeTime(db, episodeStartedAt ?? now)}.`
    + ` Pages, messages and agents' commands all waited during that time. ${what}`
    + " This closes by itself once Concierge has answered normally for ten minutes.";
  log("error", "owner_unresponsive", { blocked_ms: blocked, longest_ms: longest, routes: busiest });
  try {
    if (publishProviderFreeNotice(db, { key: `${NOTICE_PREFIX}${episodeStartedAt}`, kind: "owner_unresponsive", text,
      payload: { blockedMs: blocked, longestMs: longest, startedAt: episodeStartedAt } })) fileServiceNotices();
  } catch (error) {
    log("error", "owner_unresponsive_notice_failed", { error: String(error) });
  }
}

/** Every open freeze notice, including one a previous process opened before it was restarted. */
function closeNotices(now: number): void {
  const rows = db.query(`SELECT id FROM session_inputs WHERE scope=? AND id LIKE ?`)
    .all(SERVICE_NOTICE_SCOPE, `service:service-notice:${NOTICE_PREFIX}%`) as { id: string }[];
  for (const row of rows) {
    try { settleServiceNotice({ inputId: row.id, text: `Concierge is answering normally again as of ${noticeTime(db, now)}. Nothing waits on you.` }); }
    catch (error) { log("error", "owner_unresponsive_settle_failed", { input_id: row.id, error: String(error) }); }
  }
}

function openNoticeExists(): boolean {
  return !!db.query(`SELECT 1 FROM session_inputs input WHERE input.scope=? AND input.id LIKE ?
    AND NOT EXISTS (SELECT 1 FROM session_owner_events event WHERE event.event_id='post:service-resolved:'||input.id) LIMIT 1`)
    .get(SERVICE_NOTICE_SCOPE, `service:service-notice:${NOTICE_PREFIX}%`);
}
