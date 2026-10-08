import { db } from "./state-database";
import { log } from "./log";
import { ensureTable, recordRepairNotice } from "./repair-notices";

/**
 * A Claude account whose sign-in on this server has expired is renewed by the Mac's browser
 * agent, not by Tejas (2026-10-08, capture c7274372: "you should just use my laptop, my MacBook,
 * to log in and paste the code because that just works. All of my accounts are already logged in
 * for Claude Code on my laptop, on my Chrome sessions."). The Mac session drives his real Chrome
 * through thnkr.ing's own Accounts sign-in, so the link and the one-time code pass from page to
 * page and never enter a message, the ledger or a log. It proved this live for tejas@chann.app
 * at 10:2x UTC that day.
 *
 * This module only decides that a renewal is owed and records it once. The owner hands it to the
 * repair agent with the request to the Mac (`SessionOwner.deliverRepairNotices`), so the Mac's
 * answer, including the one case only he can fix (Chrome's own claude.ai sign-in expired), comes
 * back to the agent that may reach him. Running out of usage is not this: work moves to another
 * account by the existing switch, and a login is never renewed for room.
 */
export const CLAUDE_SIGNIN_RENEWAL_KIND = "claude_signin_expired";
/** The Mac session that runs his Chrome for this, chosen by that session itself (request b0ae7ffd). */
export const CLAUDE_SIGNIN_WORKER = { peer: "mac", address: "session:WzIsMTAwLDFd" } as const;
const KEY_PREFIX = "claude-signin:";
/** A renewal not yet handed over, or handed over this recently, is the same episode. */
const SAME_EPISODE_MS = 30 * 60_000;

export function claudeSignInRenewalKey(account: string, atMs: number): string {
  return `${KEY_PREFIX}${account}:${atMs}`;
}
export function claudeSignInRenewalAccount(key: string): string | null {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const rest = key.slice(KEY_PREFIX.length), end = rest.lastIndexOf(":");
  return end > 0 ? rest.slice(0, end) : null;
}
export function claudeSignInWorkerActionId(key: string): string {
  return key.replace(/[^A-Za-z0-9_.@:-]/g, "-").slice(0, 120);
}

/**
 * Records that `account`'s sign-in here was refused, once per episode: while an earlier renewal for
 * it is waiting to be handed over, was handed over in the last half hour, or is still unanswered by
 * the Mac (asleep, or working), nothing new is started, so two sign-ins never race.
 */
export function needClaudeSignInRenewal(account: string | null, why: string): boolean {
  if (!account || process.platform === "darwin") return false;
  try {
    ensureTable(db);
    const like = `${KEY_PREFIX}${account}:%`;
    const recent = db.query(`SELECT 1 FROM repair_notices WHERE key LIKE ? AND (delivered_input_id IS NULL OR created_at_ms>?) LIMIT 1`)
      .get(like, Date.now() - SAME_EPISODE_MS);
    if (recent) return false;
    const open = db.query(`SELECT 1 FROM session_peer_requests WHERE action_id LIKE ? AND outcome IS NULL LIMIT 1`).get(like);
    if (open) return false;
    const recorded = recordRepairNotice(db, { key: claudeSignInRenewalKey(account, Date.now()), kind: CLAUDE_SIGNIN_RENEWAL_KIND,
      text: `The Claude sign-in for ${account} on the server was refused (${why}). Concierge sent the Mac's browser agent `
        + `(mac/${CLAUDE_SIGNIN_WORKER.address}) a request to renew it through thnkr.ing Accounts in his Chrome; its answer comes back to you. `
        + `When it answers completed, check Accounts shows ${account} signed in and end done. If it answers needs_decision because Chrome's own `
        + `claude.ai sign-in for that account has expired, that is the one thing only he can do: declare needs_you --only-he-can sign-in, `
        + `telling him to sign in to claude.ai as ${account} in Chrome on his Mac, nothing else. Do not start another sign-in yourself.` });
    if (recorded) log("warn", "claude_signin_renewal_needed", { account, why });
    return recorded;
  } catch (error) {
    log("error", "claude_signin_renewal_record_failed", { account, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/** What the Mac's browser agent is asked to do. No link or code is in it, and none may come back. */
export function claudeSignInWorkerText(account: string): string {
  return `Renew the server's Claude sign-in for ${account}: the server's login for it was refused. In Chrome on this Mac, open thnkr.ing `
    + `Accounts, start ${account}'s Claude sign-in for the server, approve it on claude.ai as ${account} (switch claude.ai's account first if `
    + `another one is showing), and enter the one-time code into the waiting Accounts form. Keep the link and the code out of every message, `
    + `file and reply. Reply completed once Accounts shows ${account} signed in on the server. Reply needs_decision --only-he-can sign-in only `
    + `if Chrome's own claude.ai sign-in for ${account} has expired and needs him. Do not start a second sign-in while one is waiting.`;
}
