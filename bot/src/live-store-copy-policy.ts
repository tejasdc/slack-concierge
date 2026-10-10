/**
 * No agent copies a live Concierge database with a raw command. On 2026-10-10 an agent's
 * `sqlite3 state.db ".backup …"` of the live ledger kept restarting under constant writes, was
 * orphaned when the agent's own `pkill -f` killed its shell, and wrote 52.8 GB to a deleted file
 * at about 30 MB/s. Host IO pressure reached 72.5% and his pages failed until a recovery agent
 * stopped it (docs/incidents/2026-10-10-page-load-diagnostic-copy.md). A `VACUUM INTO` copy of
 * the presentation store ran in the same window. The bounded entrance,
 * scripts/diagnostic-sqlite-snapshot.py, pins one snapshot and bounds time and bytes, so it is
 * the one way a copy is made.
 *
 * It matches the copy commands that name a live store: SQLite's own copy commands (`.backup`,
 * `.clone`, `.save`, `.dump`, `VACUUM INTO`) and file copies (`cp`, `rsync`, `dd`, `tar`, `install`,
 * `scp`). Read-only queries stay allowed. Like the Messages refusal, it matches places, not
 * intent: a path built at runtime gets through, and the snapshot entrance's size and time limits
 * remain the backstop for copies made through it.
 */
const LIVE_STORE = /(?:\.local\/state\/concierge|\$\{?CONCIERGE_STATE_DIR\}?)\/[\w.-]*\.db\b/;
// A bare file name counts only when the command runs in the state directory itself.
const BARE_STORE = /\b[\w.-]+\.db\b/;
const STATE_DIR = /\/\.local\/state\/concierge\/?$/;
const SQLITE_COPY = /\.(?:backup|clone|save|dump)\b|\bVACUUM\s+INTO\b/i;
const FILE_COPY = /(?:^|[\s;&|(])(?:cp|rsync|dd|tar|install|scp)\s/;
const ENTRANCE = /diagnostic-sqlite-snapshot\.py/;

export const LIVE_STORE_COPY_REFUSAL = 'Refused: this would copy a live Concierge database with a raw command. On 2026-10-10 a raw '
  + '`.backup` of the live ledger restarted under writes, wrote 52.8 GB and stalled his pages. Copy one database through '
  + 'the bounded entrance: `python3 /root/workspace/slack-concierge/scripts/diagnostic-sqlite-snapshot.py <source.db> '
  + '<private/new-path.db>` (docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md), or read it with read-only queries.';

export function liveStoreCopyRefusal(command: string | null, cwd = ''): string | null {
  if (!command || ENTRANCE.test(command)) return null;
  if (!LIVE_STORE.test(command) && !(STATE_DIR.test(cwd) && BARE_STORE.test(command))) return null;
  return SQLITE_COPY.test(command) || FILE_COPY.test(command) ? LIVE_STORE_COPY_REFUSAL : null;
}
