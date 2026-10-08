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

export function signInRenewalOf(notice: { key: string; kind: string }): { provider: RenewableProvider; account: string } | null {
  const provider = (Object.keys(SIGNIN_RENEWAL_KINDS) as RenewableProvider[]).find(each => SIGNIN_RENEWAL_KINDS[each] === notice.kind);
  if (!provider || !notice.key.startsWith(PREFIX[provider])) return null;
  const rest = notice.key.slice(PREFIX[provider].length), end = rest.lastIndexOf(":");
  return end > 0 ? { provider, account: rest.slice(0, end) } : null;
}
export function signInWorkerActionId(key: string): string {
  return key.replace(/[^A-Za-z0-9_.@:-]/g, "-").slice(0, 120);
}

/**
 * Records that `account`'s sign-in here was refused, once per episode: while an earlier renewal for
 * it is waiting to be handed over, was handed over in the last half hour, or is still unanswered by
 * the Mac (asleep, or working), nothing new is started, so two sign-ins never race.
 */
export function needSignInRenewal(provider: RenewableProvider, account: string | null, why: string): boolean {
  if (!account || process.platform === "darwin") return false;
  const name = NAME[provider];
  try {
    ensureTable(db);
    const like = `${PREFIX[provider]}${account}:%`;
    const recent = db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND (delivered_input_id IS NULL OR created_at_ms>?) LIMIT 1`)
      .get(like, Date.now() - SAME_EPISODE_MS);
    if (recent) return false;
    const open = db.query(`SELECT 1 FROM session_peer_requests WHERE action_id LIKE ? AND outcome IS NULL LIMIT 1`).get(like);
    if (open) return false;
    const recorded = recordRepairNotice(db, { key: `${PREFIX[provider]}${account}:${Date.now()}`, kind: SIGNIN_RENEWAL_KINDS[provider],
      text: `The ${name} sign-in for ${account} on the server was refused (${why}). Concierge sent the Mac's browser agent `
        + `(mac/${SIGNIN_WORKER.address}) a request to renew it through thnkr.ing Accounts in his Chrome; its answer comes back to you. `
        + `When it answers completed, check Accounts shows ${account} signed in and end done. If it answers needs_decision because Chrome's own `
        + `${SITE[provider]} sign-in for that account has expired, that is the one thing only he can do: declare needs_you --only-he-can sign-in, `
        + `telling him to sign in to ${SITE[provider]} as ${account} in Chrome on his Mac, nothing else. Do not start another sign-in yourself.` });
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

/** What the Mac's browser agent is asked to do. No link or code is in it, and none may come back. */
export function signInWorkerText(provider: RenewableProvider, account: string): string {
  const name = NAME[provider], site = SITE[provider];
  const approve = provider === "codex"
    ? `Accounts shows a code and a link: open the link in Chrome, sign in to OpenAI as ${account} (switch account first if another one is showing), and enter the code there`
    : `approve it on claude.ai as ${account} (switch claude.ai's account first if another one is showing), and enter the one-time code into the waiting Accounts form`;
  return `Renew the server's ${name} sign-in for ${account}: the server's login for it was refused. In Chrome on this Mac, open thnkr.ing `
    + `Accounts, start ${account}'s ${name} sign-in for the server, ${approve}. Keep the link and the code out of every message, `
    + `file and reply. Reply completed once Accounts shows ${account} signed in on the server. Reply needs_decision --only-he-can sign-in only `
    + `if Chrome's own ${site} sign-in for ${account} has expired and needs him. Do not start a second sign-in while one is waiting.`;
}
