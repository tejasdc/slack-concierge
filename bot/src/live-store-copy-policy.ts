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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const LIVE_STORE = /(?:\.local\/state\/concierge(?:[/'"\s]|$)|\$\{?CONCIERGE_STATE_(?:DIR|DB)\}?)/;
// A bare file name counts only when the command runs in the state directory itself.
const BARE_STORE = /\b[\w.-]+\.db\b/;
const STATE_DIR = /\/\.local\/state\/concierge\/?$/;
const SQLITE_COPY = /\.(?:backup|clone|save|dump)\b|\bVACUUM\s+INTO\b/i;
const FILE_COPY = /(?:^|[;&|\n(]\s*)(?:(?:env|command|then|do|else)\s+|(?:[A-Za-z_]\w*=\S+|timeout\s+\d+)\s+)*(?:[^\s;&|()]*\/)?(?:cp|rsync|dd|tar|install|scp)\s/;
const SUBSTITUTION_COPY = /(?:^|[\s;&|(])(?:cp|rsync|dd|tar|install|scp)\s/;
const SCRIPT = /(?:^|[\s;&|])(?:[^\s"']*\/)?(?:python[\d.]*|bun|node|bash|zsh|sh)\s+(?:run\s+)?(?:--?[\w-]+\s+)*["']?([^\s"';|&()]+\.(?:py|[cm]?[jt]s|sh))(?=$|\s|["'])/g;
const DIRECT_SCRIPT = /(?:^|[;&|]\s*)["']?((?:\/|\.\/|\.\.\/)[^\s"';|&()]+\.(?:py|[cm]?[jt]s|sh))(?=$|\s|["'])/g;
const SCRIPT_COPY = /\.backup\s*\(|\b(?:copyfile|copy2|copyFileSync|copyFile|copytree)\s*\(|\bVACUUM\s+INTO\b/i;
const REHEARSAL = /\b(?:migrate-deployment-repair|rehears\w*|.*fixture)\.[cm]?[jt]s\b|\b(?:BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;

/** A router call sends its quoted text to the owner; it does not execute that text. */
function standaloneRouterCall(command: string): boolean {
  if (!/^\s*(?:(?:[^\s]*\/)?(?:bash|zsh|sh)\s+)?(?:[^\s]*\/)?router-actions\.sh\s+sessions\s+/.test(command)
    || LIVE_STORE.test(command)) return false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; continue; }
    if (char === '\\' && quote !== "'") { i++; continue; }
    if (quote !== "'" && (char === '$' || char === '`')) return false;
    if (!quote && /[;&|<>\n\r()]/.test(char)) return false;
  }
  return quote === null;
}

/** Ignore quoted prose when identifying a command's executable. */
function executableText(command: string): string {
  let quote: "'" | '"' | null = null;
  let text = '';
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" && quote !== '"') { quote = quote === "'" ? null : "'"; text += ' '; continue; }
    if (char === '"' && quote !== "'") { quote = quote === '"' ? null : '"'; text += ' '; continue; }
    if (char === '\\' && quote !== "'") { text += ' '; i++; text += ' '; continue; }
    text += quote ? ' ' : char;
  }
  return text;
}

function mentionedScripts(command: string, cwd: string): string {
  let text = '';
  for (const match of [...command.matchAll(SCRIPT), ...command.matchAll(DIRECT_SCRIPT)]) {
    const path = resolve(cwd || '.', match[1]);
    // The reviewed snapshot entrance is allowed as an executable, never as a blanket token
    // that exempts a second command on the same line.
    if (/\/scripts\/diagnostic-sqlite-snapshot\.py$/.test(path)) continue;
    try {
      if (existsSync(path) && statSync(path).size <= 1024 * 1024) text += '\n' + readFileSync(path, 'utf8');
    } catch { /* Direct command inspection and the ledger's canonical entrance still apply. */ }
  }
  return text;
}

export const LIVE_STORE_COPY_REFUSAL = 'Refused: this would copy a live Concierge database with a raw command. On 2026-10-10 a raw '
  + '`.backup` of the live ledger restarted under writes, wrote 52.8 GB and stalled his pages. Copy one database through '
  + 'the bounded entrance: `python3 /root/workspace/slack-concierge/scripts/diagnostic-sqlite-snapshot.py <source.db> '
  + '<private/new-path.db>` (docs/runbooks/DIAGNOSTIC-SQLITE-SNAPSHOT.md), or read it with read-only queries.';

export function liveStoreCopyRefusal(command: string | null, cwd = ''): string | null {
  if (!command) return null;
  if (standaloneRouterCall(command)) return null;
  const inspected = command + mentionedScripts(command, cwd);
  let canonicalCwd = cwd;
  try { canonicalCwd = realpathSync(cwd); } catch {}
  if (!LIVE_STORE.test(inspected) && !(STATE_DIR.test(canonicalCwd) && BARE_STORE.test(inspected))) return null;
  return SQLITE_COPY.test(inspected) || FILE_COPY.test(executableText(command))
    || (/[`]|\$\(/.test(command) && SUBSTITUTION_COPY.test(command))
    || SCRIPT_COPY.test(inspected) || REHEARSAL.test(inspected)
    ? LIVE_STORE_COPY_REFUSAL : null;
}
