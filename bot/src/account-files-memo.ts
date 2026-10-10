/**
 * What the account folders hold, read at most once per short window. Account usage is read many
 * times a second (every queue claim, budget brief and session view), and each read listed every
 * kept login, read its credential and address, and checked about thirty entries of ~/.claude per
 * account. Those file lookups run on the owner's event loop and waited on the filesystem journal
 * under agent disk load: 188 full rescans in 15 s and 177 of 982 blocked samples on 2026-10-10.
 *
 * Changes Concierge makes itself (sign-in, switch, preparing a home, moving a Codex login) call
 * `forgetAccountFiles()` so they are seen at once; a change made outside Concierge (a terminal
 * sign-in, Claude renewing a token) is seen within FRESH_FOR_MS.
 */
const FRESH_FOR_MS = 2_000;
const entries = new Map<string, { at: number; value: unknown }>();

export function accountFilesView<T>(key: string, read: () => T): T {
  const now = Date.now();
  const held = entries.get(key);
  if (held && now - held.at < FRESH_FOR_MS) return held.value as T;
  const value = read();
  entries.set(key, { at: now, value });
  return value;
}

export function forgetAccountFiles(): void {
  entries.clear();
}
