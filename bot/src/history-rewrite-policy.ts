/**
 * Which agent commands would rewrite history that has already been pushed. Pure apart from the
 * injected repository probe, so the harness guard (bot/scripts/history-guard.ts) can decide before
 * a command runs; git's own pre-push hook (scripts/git-hooks/refuse-history-rewrite) refuses the
 * push itself whatever ran it.
 *
 * On 2026-09-23 a session amended a commit 29 seconds after pushing it and force-pushed the copy
 * over main. The deployment had already recorded the original, which then existed on no branch, and
 * nine deployments restarted the service in eleven minutes chasing it. Tejas: "Why are we like, you
 * know, force pushing … We should always be … making sure we are … do good git practices and like,
 * you know, add changes and just, like, not remove changes." A pushed mistake is fixed by a new
 * commit. Rebasing, amending or resetting work that was never pushed stays allowed.
 *
 * A command is read as a shell reads it, so words about git in a message or a file are not git.
 */

type Word = { text: string; raw: string };
type Simple = { words: Word[]; bodies: string[]; substitutions: string[] };

/** Answers about the repository a git command runs in; null when it cannot say. */
export type RepositoryProbe = {
  /** Whether HEAD in `dir` is already on a remote-tracking branch. */
  headPushed(dir: string): boolean | null;
  /** Whether any commit a rebase of `branch` onto `upstream` would rewrite is on a remote-tracking branch. */
  rebaseRewritesPushed(dir: string, upstream: string | null, branch: string | null, root: boolean): boolean | null;
};

const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'stdbuf', 'command', 'exec', 'time', 'ionice', 'setsid', 'xargs']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PROTECTED_BRANCHES = /^(?:refs\/heads\/)?(?:main|master)$/;
// git options that take a separate value, before the subcommand.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

function parseShell(source: string): Simple[] {
  const commands: Simple[] = [];
  let current: Simple = { words: [], bodies: [], substitutions: [] };
  let pendingRedirect: string | null = null;
  const heredocs: { delimiter: string; strip: boolean; into: Simple }[] = [];
  const finish = () => { if (current.words.length || current.bodies.length) commands.push(current); current = { words: [], bodies: [], substitutions: [] }; };
  const pushWord = (word: Word) => {
    if (pendingRedirect === '<<' || pendingRedirect === '<<-') { heredocs.push({ delimiter: word.text, strip: pendingRedirect === '<<-', into: current }); pendingRedirect = null; return; }
    if (pendingRedirect === '<<<') { current.bodies.push(word.text); pendingRedirect = null; return; }
    if (pendingRedirect) { pendingRedirect = null; return; }
    current.words.push(word);
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') {
      finish();
      i++;
      for (const heredoc of heredocs.splice(0)) {
        const lines: string[] = [];
        while (i < source.length) {
          const end = source.indexOf('\n', i);
          const line = source.slice(i, end < 0 ? source.length : end);
          i = end < 0 ? source.length : end + 1;
          if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break;
          lines.push(line);
        }
        heredoc.into.bodies.push(lines.join('\n'));
      }
      continue;
    }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }
    const operator = /^(?:&>>|&>|>>|>\||<<<|<<-|<<|<>|\d?>&\d|\d?>>|\d?>|<|&&|\|\||;;|[;&|()])/.exec(source.slice(i));
    if (operator) {
      const op = operator[0];
      i += op.length;
      if (/^\d?>&\d$/.test(op)) continue;
      if (['<<', '<<-', '<<<', '<'].includes(op) || /^(?:&>>|&>|>>|>\||<>|\d?>>|\d?>)$/.test(op)) { pendingRedirect = op.replace(/^\d/, ''); continue; }
      finish();
      continue;
    }
    let text = '', raw = '';
    while (i < source.length && !/[\s;&|<>()]/.test(source[i]!)) {
      const ch = source[i]!;
      if (ch === "'") { const end = source.indexOf("'", i + 1); const stop = end < 0 ? source.length : end; text += source.slice(i + 1, stop); raw += source.slice(i, stop + 1); i = stop + 1; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < source.length && source[j] !== '"') { if (source[j] === '\\') j++; else if (source.startsWith('$(', j)) j = balanced(source, j + 1, current); j++; }
        text += source.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1'); raw += source.slice(i, j + 1); i = j + 1; continue;
      }
      if (ch === '$' && source[i + 1] === '(') { const end = balanced(source, i + 1, current); text += source.slice(i, end + 1); raw += source.slice(i, end + 1); i = end + 1; continue; }
      if (ch === '`') { const end = source.indexOf('`', i + 1); const stop = end < 0 ? source.length : end; current.substitutions.push(source.slice(i + 1, stop)); text += source.slice(i, stop + 1); raw += source.slice(i, stop + 1); i = stop + 1; continue; }
      if (ch === '\\' && i + 1 < source.length) { text += source[i + 1]; raw += source.slice(i, i + 2); i += 2; continue; }
      text += ch; raw += ch; i++;
    }
    if (raw === '{' || raw === '}') finish();
    else if (raw) pushWord({ text, raw });
  }
  finish();
  return commands;
}

function balanced(source: string, open: number, into: Simple): number {
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '(') depth++;
    else if (source[j] === ')' && --depth === 0) { into.substitutions.push(source.slice(open + 1, j)); return j; }
  }
  into.substitutions.push(source.slice(open + 1));
  return source.length - 1;
}

function resolveDir(base: string, target: string, home: string): string {
  const expanded = target === '~' ? home : target.startsWith('~/') ? home + target.slice(1) : target;
  if (expanded.startsWith('/')) return expanded;
  const parts = base.split('/').filter(Boolean);
  for (const part of expanded.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }
  return '/' + parts.join('/');
}

const REFUSAL_TAIL = ' Pushed history is never rewritten here: fix a pushed mistake with a new commit. Rebasing, amending or resetting work you have not pushed is fine.';

/** Why a git invocation would rewrite pushed history, or null. `args` follow the subcommand. */
function gitRefusal(sub: string, args: string[], dir: string, probe: RepositoryProbe): string | null {
  if (sub === 'push') {
    for (const arg of args) {
      if (/^--force(?:-with-lease(?:=.*)?|-if-includes)?$/.test(arg) || arg === '--mirror') return `Refused: \`git push ${arg}\` replaces what the remote already has.${REFUSAL_TAIL}`;
      if (/^-[A-Za-z]+$/.test(arg) && !arg.startsWith('--') && arg.slice(1).includes('f') && !/o/.test(arg.slice(1, arg.indexOf('f') + 1))) return `Refused: \`git push ${arg}\` forces the push, replacing what the remote already has.${REFUSAL_TAIL}`;
      if (arg.startsWith('+') && arg.length > 1) return `Refused: the refspec \`${arg}\` forces the push, replacing what the remote already has.${REFUSAL_TAIL}`;
      if (/^:/.test(arg) && PROTECTED_BRANCHES.test(arg.slice(1))) return `Refused: \`${arg}\` deletes ${arg.slice(1)} on the remote.${REFUSAL_TAIL}`;
    }
    if (args.some(arg => arg === '--delete' || arg === '-d') && args.some(arg => PROTECTED_BRANCHES.test(arg))) return `Refused: this deletes main on the remote.${REFUSAL_TAIL}`;
    return null;
  }
  if (sub === 'commit' && args.includes('--amend')) {
    return probe.headPushed(dir) ? `Refused: \`git commit --amend\` would rewrite a commit that is already pushed.${REFUSAL_TAIL}` : null;
  }
  if (sub === 'rebase') {
    if (args.some(arg => ['--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch'].includes(arg))) return null;
    // A rebase rewrites upstream..branch wherever it lands, so --onto's target does not matter.
    const positional: string[] = [];
    let root = false;
    for (let k = 0; k < args.length; k++) {
      const arg = args[k]!;
      if (['--onto', '-x', '--exec', '-s', '--strategy', '-X', '--strategy-option', '-C', '--whitespace'].includes(arg)) { k++; continue; }
      if (arg === '--root') { root = true; continue; }
      if (arg.startsWith('-')) continue;
      positional.push(arg);
    }
    const rewritesPushed = probe.rebaseRewritesPushed(dir, positional[0] ?? null, positional[1] ?? null, root);
    return rewritesPushed ? `Refused: this rebase would rewrite commits that are already pushed.${REFUSAL_TAIL}` : null;
  }
  return null;
}

/** Why a shell command would rewrite pushed history, or null. `cwd` is where it starts. */
export function historyRewriteRefusal(source: string, cwd: string, probe: RepositoryProbe, home = process.env.HOME ?? '/', depth = 0): string | null {
  if (depth > 4) return null;
  let dir = cwd;
  for (const command of parseShell(source)) {
    for (const inner of command.substitutions) {
      const found = historyRewriteRefusal(inner, dir, probe, home, depth + 1);
      if (found) return found;
    }
    let words = command.words.map(word => word.text);
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words = words.slice(1);
    while (words.length && WRAPPERS.has(words[0]!.split('/').pop()!)) {
      words = words.slice(1);
      while (words.length && (words[0]!.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) words = words.slice(1);
    }
    if (words[0] === 'timeout') { words = words.slice(1); while (words.length && (words[0]!.startsWith('-') || /^\d/.test(words[0]!))) words = words.slice(1); }
    if (!words.length) continue;
    const name = words[0]!.split('/').pop()!;
    if (name === 'cd') { if (words[1] && !words[1].startsWith('-')) dir = resolveDir(dir, words[1], home); else if (!words[1]) dir = home; continue; }
    if (SHELLS.has(name)) {
      const flag = words.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word));
      for (const script of flag >= 0 ? [words[flag + 1] ?? ''] : command.bodies) {
        const found = historyRewriteRefusal(script, dir, probe, home, depth + 1);
        if (found) return found;
      }
      continue;
    }
    if (name !== 'git') continue;
    let gitDir = dir;
    let k = 1;
    while (k < words.length && words[k]!.startsWith('-')) {
      const option = words[k]!;
      if (option === '-C') gitDir = resolveDir(gitDir, words[k + 1] ?? '.', home);
      k += GIT_VALUE_OPTIONS.has(option) ? 2 : 1;
    }
    const sub = words[k];
    if (!sub) continue;
    const found = gitRefusal(sub, words.slice(k + 1), gitDir, probe);
    if (found) return found;
  }
  return null;
}

/** The shell text of one agent tool call, for Claude's and Codex's tool inputs; null when it runs no command. */
export function toolCommand(input: Record<string, any>): string | null {
  if (Array.isArray(input.command)) {
    const argv = input.command.map(String);
    const shell = SHELLS.has(argv[0]?.split('/').pop() ?? '') ? argv.findIndex((word: string) => /^-[a-z]*c[a-z]*$/.test(word)) : -1;
    return shell >= 0 ? argv[shell + 1] ?? '' : argv.map((word: string) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
  }
  if (typeof input.command === 'string' && !/^\*\*\* Begin Patch/m.test(input.command)) return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  return null;
}
