/**
 * No agent reads the Mac's Messages database, or Notification Center's store (whose banners carry
 * the same texted codes), directly, and no agent photographs the Messages app by name. Those hold
 * every login code texted to Tejas, and every agent on the Mac runs with the disk access and screen
 * recording that open them; whether agents keep that access is his decision, still open (security
 * review, 2026-10-07). Until then this is the boundary: the refusal runs before every Claude and
 * Codex call on both machines (the server reaches the Mac over SSH too), and agents read texts
 * through `router-actions.sh messages`, which withholds codes and reset texts and says how many it
 * withheld (bot/scripts/messages-read.ts).
 *
 * Any command that names these places is refused, wherever the name sits. An earlier version let a
 * commit message or a session message mention them, and review showed every such exemption opens
 * a read: `sessions ask --file …/chat.db` attaches the whole database to another session, and
 * `git commit -F <(sqlite3 …)` runs a query. Words about these places go in a file instead
 * (`--text-file`, `git commit -F`), whose contents this never inspects.
 *
 * It matches places, not intent, so a command that builds the path at runtime (a glob such as
 * `Mess*`, a recursive search of all of ~/Library), a screenshot of a window by its number, or a
 * whole-screen capture gets through; only removing the disk access and screen recording closes
 * that, which is why that decision stays in front of him.
 */
const PROTECTED_PLACES: readonly RegExp[] = [
  /Library\/Messages(?:\/|\b)/i,
  /\bchat\.db\b/i,
  /group\.com\.apple\.usernoted/i,
  /com\.apple\.notificationcenter\//i,
  /\bmac-screenshot\s+app\s+["']?Messages\b/i,
];

export const MESSAGES_DATABASE_REFUSAL = 'Refused: agents do not read the Messages or Notification Center databases '
  + 'or photograph the Messages app, because they hold the login codes texted to Tejas (his 2026-10-07 security '
  + 'request). Read texts with `router-actions.sh messages [--with <number, address or chat name>] [--q <words>] '
  + '[--days <n>] [--limit <n>]` on the Mac: it shows everything except one-time codes, reset texts and sign-in links, '
  + 'and lists those as withheld. A command that only writes about these paths (a commit message, a message to a '
  + 'session) is refused too: put that text in a file and pass it with `git commit -F` or `--text-file`. To read code '
  + 'that mentions them, use your Read tool on that file rather than a shell search.';

function mentionsProtectedPlace(value: unknown): boolean {
  return typeof value === 'string' && PROTECTED_PLACES.some(place => place.test(value));
}

/** The refusal for a tool call that names those databases or a Messages screenshot, or null. */
export function messagesDatabaseRefusal(command: string | null, input: Record<string, unknown>): string | null {
  if (mentionsProtectedPlace(command)) return MESSAGES_DATABASE_REFUSAL;
  for (const field of ['file_path', 'path', 'notebook_path']) {
    if (mentionsProtectedPlace(input[field])) return MESSAGES_DATABASE_REFUSAL;
  }
  return null;
}
