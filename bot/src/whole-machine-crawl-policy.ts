/**
 * No agent runs a recursive search over the whole machine. At 00:49 ET on 2026-11-05 a Codex
 * agent looking for a process ran `rg -n '…' /proc/[0-9]*\/cwd /proc/[0-9]*\/cmdline`. Each
 * /proc/<pid>/cwd is a link to that process's working folder, and ripgrep follows links named on
 * its command line, so it searched `/` and the workspace once per process. It ran for 4.5 minutes
 * at about 493% CPU and pushed load from 20 to 38 while Concierge, thnkr.ing and every other agent
 * waited.
 *
 * It refuses a recursive search (rg, grep -r, find, fd, ag, ack, ls -R, tree, and Claude's Grep
 * and Glob tools) whose starting point is `/`, `/proc`, or a process's `/proc/<pid>/cwd`,
 * `/proc/<pid>/root` or `/proc/<pid>/fd`. Searching a named folder, reading `/proc/<pid>/cmdline`,
 * `pgrep -af`, `ps` and `find / -maxdepth 2` stay allowed. It matches the places written in the
 * command, not intent: a path built at run time gets through.
 */
import { parseShell } from './history-rewrite-policy';

const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'stdbuf', 'command', 'exec', 'time', 'ionice', 'setsid', 'xargs', 'chrt', 'taskset']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
// A search tool whose first positional word is the pattern, not a path.
const PATTERN_FIRST = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'fdfind']);
const PATTERN_GIVEN = /^(?:-e|-f|--regexp(?:=.*)?|--file(?:=.*)?|--files)$|^-[A-Za-z]*[ef]$/;
// Options that take the next word as their value, so it is not a path.
const VALUE_OPTIONS: Record<string, Set<string>> = {
  rg: new Set(['-g', '--glob', '-t', '--type', '-T', '--type-not', '-m', '--max-count', '-A', '-B', '-C', '--context', '--max-depth', '-d', '-j', '--threads', '-M', '--max-columns', '--max-filesize', '-E', '--encoding', '--iglob', '-r', '--replace', '--sort', '--sortr', '--type-add', '--ignore-file', '--pre', '--color', '--colors']),
  grep: new Set(['-m', '--max-count', '-A', '-B', '-C', '--include', '--exclude', '--exclude-dir', '-d', '-D', '--color']),
  fd: new Set(['-e', '--extension', '-t', '--type', '-d', '--max-depth', '--min-depth', '--exact-depth', '-E', '--exclude', '-x', '--exec', '-X', '--exec-batch', '-j', '--threads', '-S', '--size', '--changed-within', '--changed-before', '-o', '--owner', '--base-directory', '--search-path', '--color']),
};
VALUE_OPTIONS.egrep = VALUE_OPTIONS.grep!; VALUE_OPTIONS.fgrep = VALUE_OPTIONS.grep!; VALUE_OPTIONS.fdfind = VALUE_OPTIONS.fd!;

/** A starting point that covers the whole machine or every process's files. */
export function wholeMachineRoot(path: string): boolean {
  const clean = path.replace(/\/+/g, '/').replace(/(?:\/\.)+$/, '').replace(/(.)\/$/, '$1') || '/';
  if (clean === '/' || clean === '/*' || clean === '/proc' || clean === '/proc/*') return true;
  // One process's whole working folder or root; a named file or folder inside it is fine.
  return /^\/proc\/[^/]+\/(?:cwd|root|fd)(?:\/\*)?$/.test(clean) && !/^\/proc\/(?:self|thread-self)\//.test(clean);
}

// The last depth option wins for every tool here, so read from the end.
function depthBound(words: string[], options: string[]): number | null {
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i]!;
    for (const option of options) {
      if (word === option) return Number(words[i + 1]);
      if (word.startsWith(option + '=')) return Number(word.slice(option.length + 1));
      if (option.length === 2 && word.startsWith(option) && /^\d+$/.test(word.slice(2))) return Number(word.slice(2));
    }
  }
  return null;
}

function resolveDir(base: string, target: string): string {
  const parts = base.split('/').filter(Boolean);
  for (const part of target.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return '/' + parts.join('/');
}

const bounded = (depth: number | null) => depth !== null && Number.isFinite(depth) && depth <= 2;

/** The whole-machine root a recursive search starts from, or null. `words` start at the program. */
function crawlRoot(words: string[], dir: string | null): string | null {
  const name = words[0]!.split('/').pop()!;
  const args = words.slice(1);
  let paths: string[];
  if (name === 'find') {
    if (bounded(depthBound(args, ['-maxdepth']))) return null;
    paths = [];
    for (const word of args) { if (/^[-(!]/.test(word) && !['-H', '-L', '-P'].includes(word)) break; if (!word.startsWith('-')) paths.push(word); }
  } else if (name === 'ls') {
    if (!args.some(word => /^-[A-Za-z]*R/.test(word) || word === '--recursive')) return null;
    paths = args.filter(word => !word.startsWith('-'));
  } else if (name === 'tree') {
    if (bounded(depthBound(args, ['-L']))) return null;
    paths = args.filter(word => !word.startsWith('-'));
  } else if (PATTERN_FIRST.has(name)) {
    if (['grep', 'egrep', 'fgrep'].includes(name)
      && !args.some(word => /^-[A-Za-z]*[rR]/.test(word) || word === '--recursive' || word === '--dereference-recursive' || /^--directories=recurse$/.test(word) || word === 'recurse')) return null;
    if (name === 'rg' && bounded(depthBound(args, ['--max-depth', '-d', '--maxdepth']))) return null;
    if ((name === 'fd' || name === 'fdfind') && bounded(depthBound(args, ['--max-depth', '-d']))) return null;
    const values = VALUE_OPTIONS[name] ?? new Set<string>();
    const positional: string[] = [];
    let patternGiven = false, endOfOptions = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i]!;
      if (!endOfOptions && word === '--') { endOfOptions = true; continue; }
      if (!endOfOptions && word.startsWith('-') && word !== '-') {
        if (name !== 'fd' && name !== 'fdfind' && PATTERN_GIVEN.test(word)) { patternGiven = true; if (!word.includes('=') && word !== '--files') i++; continue; }
        if (values.has(word)) i++;
        continue;
      }
      positional.push(word);
    }
    paths = patternGiven ? positional : positional.slice(1);
  } else return null;
  // No path means the tools search the working folder; relative paths start there too.
  if (!paths.length) paths = ['.'];
  const absolute = paths.map(path => path.startsWith('/') ? path : dir === null ? null : resolveDir(dir, path));
  return absolute.find(path => path !== null && wholeMachineRoot(path)) ?? null;
}

/**
 * A read of the whole system journal over days. At 14:17 ET on 2026-11-12 three Thinkering agents
 * ran `journalctl --since 2026-11-05 -o cat` and week-long scans of every Thinkering unit at once;
 * load reached 58 on 12 cores while Concierge and thnkr.ing waited. A read is scoped when it names
 * a unit, identifier, kernel ring or field match, caps its lines, follows live output, only asks
 * about the journal itself, or starts within the last six hours. `--grep` does not scope: journalctl
 * still reads every entry to test it.
 */
const JOURNAL_SCOPES = /^(?:-u|--unit(?:=.*)?|--user-unit(?:=.*)?|-t|--identifier(?:=.*)?|-k|--dmesg|-n\d*|--lines(?:=.*)?|-f|--follow|-F|--field(?:=.*)?|-N|--fields|--list-boots|--disk-usage|--vacuum-\w+(?:=.*)?|--verify|--flush|--rotate|--sync|--header|--list-catalog|--update-catalog|--cursor-file(?:=.*)?|--after-cursor(?:=.*)?|--cursor(?:=.*)?|-[A-Za-z]*[ukfn][A-Za-z]*)$/;
function recentSince(value: string | undefined): boolean {
  if (!value) return false;
  const match = /^-(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hours?)$/.exec(value.trim());
  if (!match) return false;
  const amount = Number(match[1]);
  const unit = match[2]!;
  const minutes = unit.startsWith('h') ? amount * 60 : unit.startsWith('s') ? amount / 60 : amount;
  return minutes <= 6 * 60;
}
function wholeJournalScan(args: string[]): boolean {
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (JOURNAL_SCOPES.test(word)) return false;
    if (/^[A-Z_][A-Z0-9_]*=/.test(word)) return false;
    if (word === '-S' || word === '--since') since = args[++i];
    else if (word.startsWith('--since=')) since = word.slice('--since='.length);
    else if (/^-S./.test(word)) since = word.slice(2);
  }
  return !recentSince(since);
}
const journalRefusal = () => 'Refused: this reads the whole system journal over a long window. '
  + 'On 2026-11-12 three agents running week-long journal scans at once took the server to load 58 while Concierge and thnkr.ing waited. '
  + 'Name the unit (`-u <unit>`), cap the lines (`-n 2000`), or use a window of six hours or less (`--since -2h`); `--grep` alone still reads every entry.';

const refusal = (root: string) => `Refused: this recursive search starts at ${root}, which covers the whole machine `
  + '(each /proc/<pid>/cwd and /proc/<pid>/root leads back to a whole folder tree, once per process). '
  + 'On 2026-11-05 one such search ran at about 5 CPUs for 4.5 minutes and stalled Concierge and thnkr.ing. '
  + 'To find a process, use `pgrep -af <words>`, `ps -eo pid,args` or `/proc/<pid>/cmdline`; '
  + 'to find which folder a process is in, `readlink /proc/<pid>/cwd`. Then search that folder by name, '
  + 'or bound a look at the top of the filesystem with `find / -maxdepth 2` or `rg --max-depth 2`.';

/** Why one agent tool call would crawl the whole machine, or null. */
export function wholeMachineCrawlRefusal(command: string | null, toolName = '', toolInput: Record<string, any> = {}, cwd: string | null = null, depth = 0): string | null {
  if ((toolName === 'Grep' || toolName === 'Glob') && typeof toolInput.path === 'string' && wholeMachineRoot(toolInput.path)) return refusal(toolInput.path);
  if (toolName === 'Glob' && typeof toolInput.pattern === 'string' && toolInput.pattern.startsWith('/')) {
    const fixed = toolInput.pattern.split('/**')[0]!;
    if (toolInput.pattern.includes('**') && wholeMachineRoot(fixed || '/')) return refusal(fixed || '/');
  }
  if (!command || depth > 4) return null;
  let dir = cwd;
  for (const simple of parseShell(command)) {
    for (const inner of simple.substitutions) {
      const found = wholeMachineCrawlRefusal(inner, '', {}, dir, depth + 1);
      if (found) return found;
    }
    let words = simple.words.map(word => word.text);
    for (;;) {
      while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
      const head = words[0]?.split('/').pop() ?? '';
      if (WRAPPERS.has(head)) {
        words = words.slice(1);
        while (words.length && (words[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || /^\d+$/.test(words[0]!))) words = words.slice(1);
        continue;
      }
      if (head === 'timeout') { words = words.slice(1); while (words.length && (words[0]!.startsWith('-') || /^\d/.test(words[0]!))) words = words.slice(1); continue; }
      break;
    }
    if (!words.length) continue;
    const name = words[0]!.split('/').pop()!;
    if (name === 'cd') { const target = words[1] && !words[1].startsWith('-') ? words[1] : '~'; dir = target.startsWith('/') ? target : dir === null || target.startsWith('~') ? null : resolveDir(dir, target); continue; }
    if (SHELLS.has(name)) {
      const flag = words.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word));
      for (const script of flag >= 0 ? [words[flag + 1] ?? ''] : simple.bodies) {
        const found = wholeMachineCrawlRefusal(script, '', {}, dir, depth + 1);
        if (found) return found;
      }
      continue;
    }
    if (name === 'journalctl' && wholeJournalScan(words.slice(1))) return journalRefusal();
    const root = crawlRoot(words, dir);
    if (root) return refusal(root);
  }
  return null;
}
