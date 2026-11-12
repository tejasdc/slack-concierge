import { db } from "./state-database";
import { log } from "./log";
import { ensureTable, recordRepairNotice } from "./repair-notices";

/**
 * An account whose sign-in on this server has expired, Claude or Codex, is renewed by the Mac's
 * browser agent, not by Tejas (2026-10-08, capture c7274372: "you should just use my laptop, my
 * MacBook, to log in and paste the code because that just works. All of my accounts are already
 * logged in for Claude Code on my laptop, on my Chrome sessions."; extended to Codex the same
 * morning, capture f48861f1). The Mac session drives his real Chrome through thnkr.ing's own
 * Accounts sign-in, so the link and the one-time code pass from page to page and never enter a
 * message, the ledger or a log. It proved this live for Claude's tejas@chann.app that day.
 *
 * This module only decides that a renewal is owed and records it once. The owner hands it to the
 * repair agent with the request to the Mac (`SessionOwner.deliverRepairNotices`), so the Mac's
 * answer, including the one case only he can fix (the browser's own sign-in to that provider
 * expired), comes back to the agent that may reach him. Running out of usage is not this: work
 * moves to another account by the existing switch, and a login is never renewed for room.
 */
export type RenewableProvider = "claude-code" | "codex";
export const SIGNIN_RENEWAL_KINDS: Readonly<Record<RenewableProvider, string>> =
  { "claude-code": "claude_signin_expired", codex: "codex_signin_expired" };
/** The Mac session that runs his Chrome for this, chosen by that session itself (request b0ae7ffd). */
export const SIGNIN_WORKER = { peer: "mac", address: "session:WzIsMTAwLDFd" } as const;
const PREFIX: Readonly<Record<RenewableProvider, string>> = { "claude-code": "claude-signin:", codex: "codex-signin:" };
const NAME: Readonly<Record<RenewableProvider, string>> = { "claude-code": "Claude", codex: "Codex" };
/** Where he is signed in, in the browser, for each provider. */
const SITE: Readonly<Record<RenewableProvider, string>> = { "claude-code": "claude.ai", codex: "chatgpt.com (OpenAI)" };
/** A renewal not yet handed over, or handed over this recently, is the same episode. */
const SAME_EPISODE_MS = 30 * 60_000;
/**
 * After the Mac's agent began a renewal but could not finish it, the next one waits this long. On 2026-11-03 Claude
 * refused the approval with "Couldn't verify your browser" and a new request went out 30 minutes
 * later; each attempt switches the claude.ai account in his own Chrome, and repeated automated
 * approvals can only make that check stricter. A browser check or an expired saved login does not
 * clear in minutes, so a few hours is the shortest retry that can find it changed.
 */
const AFTER_UNFINISHED_MS = 6 * 60 * 60_000;
/** One browser-control failure before any sign-in action gets one prompt retry. */
const PREAUTH_RETRY_MS = 2 * 60_000;
/** A spent account is signed in this close to its weekly reset, so it is ready when room returns. */
const BEFORE_RESET_MS = 60 * 60_000;

/**
 * When the last stored reading says this account's weekly allowance is used up and resets later than
 * `BEFORE_RESET_MS` from now. A sign-in gives such an account no room, so renewing it early only spends
 * a browser approval (tejastej.dc@gmail.com on 2026-11-03, at 100% until Claude's weekly reset). Usage
 * cannot fall before its reset, so an old reading still proves this; the reset time ends it.
 */
function spentUntil(provider: RenewableProvider, account: string): number | null {
  // Codex keeps working past 100% on credits and can spend a banked reset, so only Claude's week is final.
  if (provider !== "claude-code") return null;
  const row = db.query(`SELECT usage_json FROM provider_account_usage WHERE provider=?`).get(provider) as { usage_json: string } | null;
  if (!row) return null;
  try {
    const usage = JSON.parse(row.usage_json) as { accounts?: { label?: string; windows?: { name?: string; usedPercent?: number; resetsAt?: string | null }[] }[] };
    const weekly = usage.accounts?.find(each => each.label === account)?.windows?.find(window => window.name === "Weekly");
    const resets = weekly?.resetsAt ? Date.parse(weekly.resetsAt) : NaN;
    return (weekly?.usedPercent ?? 0) >= 100 && resets - Date.now() > BEFORE_RESET_MS ? resets : null;
  } catch { return null; }
}

/**
 * Classifies a renewal answered failed within `AFTER_UNFINISHED_MS`. A sleeping Mac can answer days
 * after the request was sent, so a failure is dated from its final answer's own record, never from
 * when the request was created; that date is stamped once and the hold runs from it. Every failed
 * renewal for the account is found by its action name, with no creation cutoff: on 2026-11-12 a
 * request created November 9 failed after three days queued, a two-day creation filter hid it, and
 * two more renewals reached his Mac within ten minutes (docs/incidents/2026-11-12-queued-renewal-failure-hidden-from-hold.md).
 * A worker-attested failure before any browser sign-in action permits one short retry;
 * any other failure, including a provider browser-verification rejection, holds for hours.
 * needs_decision asks him to fix Chrome's own sign-in, after which a renewal should follow at once.
 */
type RenewalFailureKind = "preauth_browser_unavailable" | "preauth_entrance_blocked" | "other";
type RenewalFailure = { actionId: string; kind: RenewalFailureKind; seenAtMs: number };

function renewalFailureKind(resultJson: string | null): RenewalFailureKind {
  if (!resultJson) return "other";
  try {
    const result = JSON.parse(resultJson) as { replyBody?: unknown };
    const body = typeof result.replyBody === "string" ? result.replyBody : "";
    if (body.startsWith("PREAUTH_BROWSER_UNAVAILABLE:")
      // The first live failure predates the typed worker instruction. Its complete no-effect
      // attestation is retained under the same request result, so it may receive this one retry.
      || (body.includes("No task tab was created") && body.includes("no account was switched")
        && body.includes("no sign-in link or code was accessed"))) return "preauth_browser_unavailable";
    if (body.startsWith("PREAUTH_ENTRANCE_BLOCKED:")
      || (body.includes("Journal to open today") && body.includes("Accounts was not accessible")
        && body.includes("no provider sign-in was started") && body.includes("no link or code was obtained")))
      return "preauth_entrance_blocked";
    return "other";
  } catch { return "other"; }
}

/** Action names after this prefix sort below it plus "~", the highest character an action name can hold. */
const actionRange = (prefix: string): [string, string] => [prefix, `${prefix}~`];

/** Failed renewals under `prefix` answered within `windowMs`, newest first. */
function recentFailures(prefix: string, windowMs: number): RenewalFailure[] {
  db.run(`CREATE TABLE IF NOT EXISTS signin_renewal_failures (action_id TEXT PRIMARY KEY, seen_at_ms INTEGER NOT NULL)`);
  const now = Date.now();
  const [from, to] = actionRange(prefix);
  // Range comparisons, not LIKE, so the failed-by-action index (and the external requests'
  // unique key) bound the read to renewals instead of every request ever made.
  const failed = db.query(`SELECT r.action_id,r.result_json,
      (SELECT max(e.created_at_ms) FROM session_peer_events e WHERE e.request_id=r.request_id AND e.kind='final') AS answered_at_ms
    FROM session_peer_requests r WHERE r.outcome='failed' AND r.action_id>=? AND r.action_id<?
    UNION ALL SELECT r.action_id,r.result_json,
      (SELECT max(x.created_at_ms) FROM session_external_replies x WHERE x.request_id=r.request_id AND x.final=1)
    FROM session_external_requests r WHERE r.agent_name='signin-renewal' AND r.outcome='failed' AND r.action_id>=? AND r.action_id<?`)
    .all(from, to, from, to) as { action_id: string; result_json: string | null; answered_at_ms: number | null }[];
  for (const { action_id, answered_at_ms } of failed)
    db.run(`INSERT OR IGNORE INTO signin_renewal_failures (action_id, seen_at_ms) VALUES (?, ?)`, [action_id, Math.min(answered_at_ms ?? now, now)]);
  const recentRows = db.query(`SELECT action_id,seen_at_ms FROM signin_renewal_failures WHERE action_id>=? AND action_id<? AND seen_at_ms>? ORDER BY seen_at_ms DESC`)
    .all(from, to, now - windowMs) as { action_id: string; seen_at_ms: number }[];
  return recentRows.map(row => ({ actionId: row.action_id, seenAtMs: row.seen_at_ms,
    kind: renewalFailureKind(failed.find(item => item.action_id === row.action_id)?.result_json ?? null) }));
}

/** Every renewal the Mac's browser agent is asked to do, whatever the provider or account. */
const WORKER_NOTICE_PATTERNS = Object.values(PREFIX).map(prefix => `${prefix}%`);
const WORKER_ACTION_PREFIXES = Object.values(PREFIX).map(prefix => signInWorkerActionId(prefix));

/** Whether a renewal was answered after `sinceMs` as completed or as needing him: the worker got past the Mac. Undelivered or cancelled outcomes prove nothing. */
function answeredPastObstacleAfter(sinceMs: number, failures: RenewalFailure[]): boolean {
  if (failures.some(failure => failure.kind === "other" && failure.seenAtMs > sinceMs)) return true;
  return WORKER_ACTION_PREFIXES.some(prefix => {
    const [from, to] = actionRange(prefix);
    return !!db.query(`SELECT 1 FROM session_peer_requests r WHERE r.action_id>=? AND r.action_id<? AND r.outcome IN ('answered','decision_needed')
        AND EXISTS(SELECT 1 FROM session_peer_events e WHERE e.request_id=r.request_id AND e.kind='final' AND e.created_at_ms>?)
      UNION ALL SELECT 1 FROM session_external_requests r WHERE r.agent_name='signin-renewal' AND r.action_id>=? AND r.action_id<? AND r.outcome IN ('answered','decision_needed')
        AND EXISTS(SELECT 1 FROM session_external_replies x WHERE x.request_id=r.request_id AND x.final=1 AND x.created_at_ms>?) LIMIT 1`)
      .get(from, to, sinceMs, from, to, sinceMs);
  });
}

/**
 * Why the Mac's browser agent must not be asked to renew `actionPrefix`'s account now, or null.
 * A pre-sign-in obstacle (Chrome control failing, the Accounts window blocked or the page
 * changing under it while he uses the Mac) belongs to the Mac, not to an account: on 2026-11-12,
 * after two such failures for one Claude account, renewals for two other accounts reached the
 * Mac within six minutes. So those failures count across every account: one short retry after
 * two minutes per distinct obstacle, then six hours from the second, unless a renewal answered
 * past the obstacle in between. A provider refusal stays with its account. One renewal is with
 * the Mac at a time, so two sign-ins never run together in his Chrome.
 */
function workerHold(actionPrefix: string): { hold: string | null; retry: boolean } {
  const now = Date.now();
  const held = (hold: string) => ({ hold, retry: false });
  // Two windows back, so a pair of failures straddling the window's edge still holds six hours from the second.
  const failures = WORKER_ACTION_PREFIXES.flatMap(prefix => recentFailures(prefix, 2 * AFTER_UNFINISHED_MS))
    .sort((a, b) => b.seenAtMs - a.seenAtMs);
  if (failures.some(failure => failure.actionId.startsWith(actionPrefix) && failure.kind === "other"
    && now - failure.seenAtMs < AFTER_UNFINISHED_MS)) return held("account_failed");
  const obstacles = failures.filter(failure => failure.kind !== "other" && !answeredPastObstacleAfter(failure.seenAtMs, failures));
  const latest = obstacles[0] && now - obstacles[0].seenAtMs < AFTER_UNFINISHED_MS ? obstacles[0] : undefined;
  if (latest) {
    if (obstacles.filter(failure => failure.kind === latest.kind && latest.seenAtMs - failure.seenAtMs < AFTER_UNFINISHED_MS).length >= 2)
      return held("mac_obstacle_repeated");
    if (now - latest.seenAtMs < PREAUTH_RETRY_MS) return held("mac_obstacle_retry_wait");
    const retried = WORKER_NOTICE_PATTERNS.some(pattern =>
      db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND created_at_ms>? LIMIT 1`).get(pattern, latest.seenAtMs));
    if (retried) return held("mac_obstacle_retried");
  }
  const pending = WORKER_NOTICE_PATTERNS.some(pattern =>
    db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND delivered_input_id IS NULL AND resolved_at_ms IS NULL LIMIT 1`).get(pattern));
  if (pending) return held("notice_pending");
  // A delivered notice's request is created asynchronously; until its row exists (or the episode
  // window passes after a send that failed), it is still the one renewal with the Mac.
  const unsent = WORKER_NOTICE_PATTERNS.some(pattern =>
    (db.query(`SELECT key FROM repair_notices WHERE key LIKE ? AND created_at_ms>? AND resolved_at_ms IS NULL`).all(pattern, now - SAME_EPISODE_MS) as { key: string }[])
      .some(({ key }) => {
        const actionId = signInWorkerActionId(key);
        return !db.query(`SELECT 1 FROM session_peer_requests WHERE action_id=?
          UNION ALL SELECT 1 FROM session_external_requests WHERE agent_name='signin-renewal' AND action_id=? LIMIT 1`).get(actionId, actionId);
      }));
  if (unsent) return held("notice_unsent");
  for (const prefix of WORKER_ACTION_PREFIXES) {
    const [from, to] = actionRange(prefix);
    const open = db.query(`SELECT 1 FROM session_peer_requests WHERE outcome IS NULL AND action_id>=? AND action_id<?
      UNION ALL SELECT 1 FROM session_external_requests WHERE agent_name='signin-renewal' AND outcome IS NULL AND action_id>=? AND action_id<? LIMIT 1`)
      .get(from, to, from, to);
    if (open) return held("renewal_open");
  }
  return { hold: null, retry: !!latest };
}

export function signInRenewalOf(notice: { key: string; kind: string }): { provider: RenewableProvider; account: string } | null {
  const provider = (Object.keys(SIGNIN_RENEWAL_KINDS) as RenewableProvider[]).find(each => SIGNIN_RENEWAL_KINDS[each] === notice.kind);
  if (!provider || !notice.key.startsWith(PREFIX[provider])) return null;
  const rest = notice.key.slice(PREFIX[provider].length), end = rest.lastIndexOf(":");
  return end > 0 ? { provider, account: rest.slice(0, end) } : null;
}
export function signInWorkerActionId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100);
}

/**
 * Records that `account`'s sign-in here was refused, once per episode: while an earlier renewal for
 * it is waiting to be handed over, was handed over recently, or is still unanswered by
 * the Mac (asleep, or working), nothing new is started, so two sign-ins never race. A failed
 * browser-control preflight may retry once after two minutes; other failed renewals wait six hours.
 * Nothing is started while a Claude
 * account's week is spent until well after now; the background check asks again on its next pass.
 */
export function needSignInRenewal(provider: RenewableProvider, account: string | null, why: string): boolean {
  if (!account) return false;
  const name = NAME[provider];
  try {
    ensureTable(db);
    const like = `${PREFIX[provider]}${account}:%`;
    const { hold, retry } = workerHold(signInWorkerActionId(`${PREFIX[provider]}${account}:`));
    if (hold) return false;
    const recent = db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND created_at_ms>? LIMIT 1`)
      .get(like, Date.now() - (retry ? PREAUTH_RETRY_MS : SAME_EPISODE_MS));
    if (recent) return false;
    if (spentUntil(provider, account) !== null) return false;
    const onWorkerMachine = process.platform === "darwin";
    const recorded = recordRepairNotice(db, { key: `${PREFIX[provider]}${account}:${Date.now()}`, kind: SIGNIN_RENEWAL_KINDS[provider],
      text: `The ${name} account ${account} is not ready on ${onWorkerMachine ? 'the Mac' : 'the server'} (${why}). Concierge sent the Mac's browser agent `
        + `(mac/${SIGNIN_WORKER.address}) a request to sign it in through thnkr.ing Accounts in his Chrome`
        + (onWorkerMachine
          ? `; it runs on this same Mac, so its answer stays with the request and it tells Tejas itself if only he can act. Check Accounts later shows ${account} signed in; nothing else is yours. `
          : `; its answer comes back to you. When it answers completed, check Accounts shows ${account} signed in and end done. If it answers needs_decision because Chrome's own `
            + `${SITE[provider]} sign-in for that account has expired, that is the one thing only he can do: declare needs_you --summary "<one line: what to sign in to, as whom>" --only-he-can sign-in, `
            + `telling him to sign in to ${SITE[provider]} as ${account} in Chrome on his Mac, nothing else. `)
        + `Do not start another sign-in yourself.` });
    if (recorded) log("warn", "signin_renewal_needed", { provider, account, why });
    return recorded;
  } catch (error) {
    log("error", "signin_renewal_record_failed", { provider, account, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
/** The Claude entry point every existing caller uses. */
export function needClaudeSignInRenewal(account: string | null, why: string): boolean {
  return needSignInRenewal("claude-code", account, why);
}

/**
 * What the Mac's browser agent is asked to do. No link or code is in it, and none may come back. `local` means the refused login is this Mac's own: the request then
 * names the Mac, never the server. It said "the server's" for both until 2026-11-02, so the agent renewed
 * the server's healthy tejas@chann.app login, reported success, and the Mac's stayed signed out all evening.
 */
export function signInWorkerText(provider: RenewableProvider, account: string, local = false): string {
  const name = NAME[provider], site = SITE[provider];
  const machine = local ? "this Mac" : "the server";
  const approve = provider === "codex"
    ? `Accounts shows a code and a link: open the link in Chrome, sign in to OpenAI as ${account} (switch account first if another one is showing), and enter the code there`
    : `approve it on claude.ai as ${account} (switch claude.ai's account first if another one is showing), and enter the one-time code into the waiting Accounts form`;
  return `Make ${machine}'s ${name} account ${account} ready for agent work. In Chrome on this Mac, open thnkr.ing `
    + `Accounts, start ${account}'s ${name} sign-in for ${machine}${local ? " (the Mac's row in Accounts, not the server's)" : ""}, ${approve}. Keep the link and the code out of every message, `
    + `file and reply. Before you switch ${site}'s account, note which account Chrome was signed in to there; when you finish or give up, `
    + `switch ${site} back to that account, because it is his own browser. If ${site} says it couldn't verify your browser, do not approve again: `
    + `switch back and reply failed with its exact words, and Concierge waits hours before asking again. `
    + `Reply completed once Accounts shows ${account} signed in on ${machine}. Reply needs_decision --only-he-can sign-in only `
    + `if Chrome's own ${site} sign-in for ${account} has expired and needs him`
    + (local ? `, and because this request comes from this Mac's own Concierge with nobody reading its answer, then also declare `
      + `sessions outcome needs_you --summary "<one line>" --only-he-can sign-in telling him to sign in to ${site} as ${account} in Chrome on his Mac` : ``)
    + `. Do not start a second sign-in while one is waiting. If browser control fails before any task tab, link, code, `
    + `or account switch, reply failed and begin the body with PREAUTH_BROWSER_UNAVAILABLE: followed by what failed. `
    + `If Chrome opens thnkr.ing but Journal to open today covers Settings, open the command palette with Command-Shift-K and choose Provider Accounts. `
    + `The Accounts window opens above the journal hold; do not use his emergency opening, alter the journal, or unlock his workspace. `
    + `If Accounts remains inaccessible before any provider sign-in action, link, code or account switch, reply failed beginning PREAUTH_ENTRANCE_BLOCKED: and describe the obstruction. `
    + `Use either pre-auth prefix only when no sign-in action occurred; Concierge permits one short retry per distinct pre-auth obstruction, then waits hours if it fails again.`;
}
