/**
 * What an extra Claude account home keeps for itself versus links to the machine's one shared
 * set in `~/.claude`. Both the owner's local account homes and a runner's account homes read
 * these lists, so a new entry Claude starts writing is classified once for both.
 */

/**
 * Per-login state: its own login and what Claude stamps with the signed-in account and deletes at
 * logout (remote settings and policy limits), so one account never reads another's. It also covers
 * sign-in state and the locks Claude takes while it renews a login (`.storage-write`,
 * `.oauth_refresh.lock*`): linking a lock to the main folder's would tie this account's renewals to
 * whatever a terminal there is doing, and a lock that happened to exist during a switch would be
 * left dangling (GPT-6 Astra's stand-in review, 2026-10-07).
 */
export const CLAUDE_PER_LOGIN: ReadonlySet<string> = new Set(['.credentials.json', '.claude.json', '.claude.json.lock',
  '.account-email', 'backups', 'remote-settings.json', 'policy-limits.json', 'policy-limits.json.stamp.json',
  'hfi-auth.json', '.session_ingress_token', '.storage-write']);

/**
 * `.storage-write.lock` is Claude's lock beside `.storage-write`: a terminal sign-in in the main
 * folder left one there on 2026-11-02 and every extra home read as incomplete until it went away.
 */
export function isClaudePerLogin(name: string): boolean {
  return CLAUDE_PER_LOGIN.has(name) || /^\.(credentials|claude)\.json\./.test(name)
    || /^\.oauth_refresh\.lock/.test(name) || /^\.storage-write\./.test(name);
}

/**
 * Runtime scratch and caches Claude recreates per process. Shared when possible, but a private copy
 * is harmless and is never moved: a live process may be using it (one was, at the 19:40 repair on
 * 2026-10-07).
 *
 * `stats-cache.json` is Claude's cache of usage statistics derived from transcripts. Claude replaces
 * it by writing a new file, which turns a link into a private copy whenever Claude runs in that
 * home. Classed as shared settings it marked every Mac account home incomplete, one by one between
 * Nov 6 and Nov 10 2026, until no Claude session could start there and all were held as
 * "could not sign in" while every login still worked.
 */
export const CLAUDE_SCRATCH: ReadonlySet<string> = new Set(['sessions', 'session-env', 'shell-snapshots', 'cache',
  'statsig', 'paste-cache', '.last-cleanup', '.last-update-result.json', 'mcp-needs-auth-cache.json', 'stats-cache.json',
  'teams', 'jobs', 'daemon']);
