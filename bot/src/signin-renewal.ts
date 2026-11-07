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
 * Classifies a renewal answered failed within `AFTER_UNFINISHED_MS`. Neither request
 * table records when an answer arrived, and a sleeping Mac can answer hours after the request was sent,
 * so the first time a failed answer is seen here is stamped and the hold runs from that. The check
 * that calls this runs every few minutes for a signed-out account, so the stamp is that close to the
 * answer. A worker-attested failure before any browser sign-in action permits one short retry;
 * any other failure, including a provider browser-verification rejection, holds for hours.
 * needs_decision asks him to fix Chrome's own sign-in, after which a renewal should follow at once.
 */
type RenewalFailure = { kind: "preauth_browser_unavailable" | "other"; seenAtMs: number; preauthAttempts: number };

function preauthBrowserFailure(resultJson: string | null): boolean {
  if (!resultJson) return false;
  try {
    const result = JSON.parse(resultJson) as { replyBody?: unknown };
    const body = typeof result.replyBody === "string" ? result.replyBody : "";
    return body.startsWith("PREAUTH_BROWSER_UNAVAILABLE:")
      // The first live failure predates the typed worker instruction. Its complete no-effect
      // attestation is retained under the same request result, so it may receive this one retry.
      || (body.includes("No task tab was created") && body.includes("no account was switched")
        && body.includes("no sign-in link or code was accessed"));
  } catch { return false; }
}

function recentFailure(sent: string): RenewalFailure | null {
  db.run(`CREATE TABLE IF NOT EXISTS signin_renewal_failures (action_id TEXT PRIMARY KEY, seen_at_ms INTEGER NOT NULL)`);
  const now = Date.now();
  const failed = db.query(`SELECT action_id,result_json FROM session_peer_requests WHERE action_id LIKE ? AND outcome='failed' AND created_at_ms>?
    UNION ALL SELECT action_id,result_json FROM session_external_requests WHERE action_id LIKE ? AND outcome='failed' AND created_at_ms>?`)
    .all(sent, now - 2 * 86_400_000, sent, now - 2 * 86_400_000) as { action_id: string; result_json: string | null }[];
  for (const { action_id } of failed)
    db.run(`INSERT OR IGNORE INTO signin_renewal_failures (action_id, seen_at_ms) VALUES (?, ?)`, [action_id, now]);
  const recentRows = db.query(`SELECT action_id,seen_at_ms FROM signin_renewal_failures WHERE action_id LIKE ? AND seen_at_ms>? ORDER BY seen_at_ms DESC`)
    .all(sent, now - AFTER_UNFINISHED_MS) as { action_id: string; seen_at_ms: number }[];
  const recent = recentRows[0] ?? null;
  if (!recent) return null;
  const preauthAttempts = recentRows.filter(row => preauthBrowserFailure(failed.find(item => item.action_id === row.action_id)?.result_json ?? null)).length;
  const result = failed.find(row => row.action_id === recent.action_id);
  return { kind: preauthBrowserFailure(result?.result_json ?? null) ? "preauth_browser_unavailable" : "other",
    seenAtMs: recent.seen_at_ms, preauthAttempts };
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
    const sent = `${signInWorkerActionId(`${PREFIX[provider]}${account}:`)}%`;
    const failure = recentFailure(sent);
    const retriedAfterFailure = failure && !!db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND created_at_ms>? LIMIT 1`)
      .get(like, failure.seenAtMs);
    const retryPreauth = failure?.kind === "preauth_browser_unavailable" && failure.preauthAttempts === 1
      && !retriedAfterFailure && Date.now() - failure.seenAtMs >= PREAUTH_RETRY_MS;
    const recent = db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND (delivered_input_id IS NULL OR created_at_ms>?) LIMIT 1`)
      .get(like, retryPreauth ? Date.now() - PREAUTH_RETRY_MS : Date.now() - SAME_EPISODE_MS);
    if (recent) return false;
    const open = db.query(`SELECT 1 FROM session_peer_requests WHERE action_id LIKE ? AND outcome IS NULL
      UNION ALL SELECT 1 FROM session_external_requests WHERE action_id LIKE ? AND outcome IS NULL LIMIT 1`).get(sent, sent);
    if (open) return false;
    if (failure && !retryPreauth) return false;
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
    + `Use that prefix only when no sign-in action occurred; Concierge permits one short retry, then waits hours if it fails again.`;
}
