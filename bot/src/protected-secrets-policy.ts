/**
 * What keeps Tejas signed in and connected, and how to tell a tool call that changes it from one
 * that only talks about it. Pure: no ledger, no network. The pre-tool guard
 * (bot/scripts/protected-change-guard.ts) and the watcher (bot/scripts/protected-secrets-watch.ts)
 * share it, so one list decides both what an agent may not do unasked and what is announced when
 * it happens anyway (docs/incidents/2026-09-23-signed-out-without-asking.md).
 *
 * The first guard matched words anywhere in a command, so the Inbox was refused for sending a
 * message that named the settings file (2026-09-23). A command is now read as a shell reads it:
 * a protected target counts only where the command acts on it — as a write target, an operand of
 * a command that changes files, code run by an interpreter, a database write, or a key-changing
 * API call. Words handed to a command that only reads or carries text are just words.
 */
import { createHash } from 'node:crypto';

export type ProtectedTarget = Readonly<{ name: string; pattern: RegExp }>;
export const PROTECTED_TARGETS: readonly ProtectedTarget[] = [
  { name: "thnkr.ing's sign-in and session keys", pattern: /\/etc\/thinkering\/|THINKERING_(?:SESSION_KEY|LOGIN_SECRET)/ },
  { name: "thnkr.ing's passkeys and device keys", pattern: /\/authentication\/(?:passkeys|devices|push-devices)\.sqlite|\/api\/session\/(?:devices|passkeys)/ },
  { name: 'capture, device and machine-link keys', pattern: /\/etc\/concierge\/[\w.-]+\.token|\/etc\/agent-inbox\.token|peer\.token\b/ },
  { name: 'a device key file on the Mac', pattern: /\.config\/thinkering\// },
  { name: 'his Slack connection', pattern: /\.config\/concierge\/slack\.toml|auth\.revoke/ },
  { name: 'his Codex and Claude sign-ins', pattern: /\.codex\/auth\.json|\.codex-accounts\/|\.claude\/\.credentials\.json/ },
  // The guard and watcher themselves: their settings, the approvals and held keys they keep.
  { name: 'the approval guard and key watcher', pattern: /\/etc\/codex\/(?:requirements\.toml|hooks\/)|\/etc\/claude-code\/|\/protected-secrets\/|\/protected-change-requests\// },
];

/** A file whose change is announced and, where a service reads it at start, held until he approves. */
export type SecretFile = Readonly<{ path: string; target: string; format: 'env' | 'whole'; service: string; holdFile?: string }>;
export const SECRET_FILES: readonly SecretFile[] = [
  { path: '/etc/thinkering/server.env', target: PROTECTED_TARGETS[0]!.name, format: 'env', service: 'thnkr.ing (thinkering.service)', holdFile: 'thinkering-server.env' },
  { path: '/etc/concierge/pebble-index.token', target: PROTECTED_TARGETS[2]!.name, format: 'whole', service: 'the capture intake (agent-inbox.service)' },
  { path: '/etc/agent-inbox.token', target: PROTECTED_TARGETS[2]!.name, format: 'whole', service: 'the capture intake (agent-inbox.service)' },
  { path: '/etc/concierge/thinkering.token', target: PROTECTED_TARGETS[2]!.name, format: 'whole', service: 'the capture intake (agent-inbox.service)' },
  { path: '/etc/concierge/capture-queue.token', target: PROTECTED_TARGETS[2]!.name, format: 'whole', service: 'the capture intake and Concierge' },
  { path: '/etc/concierge/peer.token', target: PROTECTED_TARGETS[2]!.name, format: 'whole', service: 'the Mac link (concierge-bot.service)' },
  { path: '/root/.config/concierge/slack.toml', target: PROTECTED_TARGETS[4]!.name, format: 'env', service: 'Concierge (concierge-bot.service)' },
];

/** Which of his keys a text names. */
export function namedTargets(text: string): string[] {
  return PROTECTED_TARGETS.filter(target => target.pattern.test(text)).map(target => target.name);
}

/** Key name → SHA-256 of its value; never the value. A whole-file secret is one key, `(file)`. */
export function secretFingerprints(content: string | null, format: SecretFile['format']): Record<string, string> {
  if (content === null) return {};
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  if (format === 'whole') return { '(file)': digest(content.trim()) };
  const keys: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) keys[match[1]!] = digest(match[2]!.trim());
  }
  return keys;
}

type Word = { text: string; raw: string };
type Simple = { words: Word[]; redirects: { op: string; target: string }[]; bodies: string[]; substitutions: string[] };

// Commands that read or carry words and change no file by their operands.
const TALK = new Set(['echo', 'printf', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'stat',
  'lsattr', 'wc', 'diff', 'cmp', 'sha256sum', 'sha1sum', 'md5sum', 'file', 'journalctl', 'git', 'router-actions.sh', 'jq',
  'uniq', 'cut', 'tr', 'column', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false', 'strings',
  'hexdump', 'xxd', 'od', 'nl', 'fold', 'fmt', 'base64', 'sleep', 'date', 'id', 'whoami', 'pwd', 'cd', 'which', 'type']);
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'stdbuf', 'command', 'exec', 'time', 'ionice', 'setsid']);
const DESTINATION = new Set(['cp', 'install', 'rsync', 'ln', 'scp']);
const CHANGES = new Set(['mv', 'rm', 'trash', 'shred', 'unlink', 'truncate', 'touch', 'chmod', 'chown', 'chgrp', 'chattr',
  'setfacl', 'tee', 'sponge', 'crudini', 'vi', 'vim', 'nano', 'emacs', 'ed', 'patch', 'mkdir', 'rmdir']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bun', 'perl', 'ruby', 'deno', 'php', 'osascript']);
const WRITE_SQL = /\b(?:insert|update|delete|replace|drop|alter|create|attach|vacuum|pragma\s+\w+\s*=)\b|^\s*\.(?:import|restore|read|load)/im;
const KEY_API = /auth\.revoke|\/api\/session\/(?:devices|passkeys)/;

/** Reads a shell command into simple commands, keeping here-document bodies and $(...) with them. */
function parseShell(source: string): Simple[] {
  const commands: Simple[] = [];
  let current: Simple = { words: [], redirects: [], bodies: [], substitutions: [] };
  let pendingRedirect: string | null = null;
  const heredocs: { delimiter: string; strip: boolean; into: Simple }[] = [];
  const finish = () => { if (current.words.length || current.redirects.length || current.bodies.length) commands.push(current); current = { words: [], redirects: [], bodies: [], substitutions: [] }; };
  let i = 0;
  const pushWord = (word: Word) => {
    if (pendingRedirect === '<<' || pendingRedirect === '<<-') { heredocs.push({ delimiter: word.text, strip: pendingRedirect === '<<-', into: current }); pendingRedirect = null; return; }
    if (pendingRedirect === '<<<') { current.bodies.push(word.text); pendingRedirect = null; return; }
    if (pendingRedirect) { current.redirects.push({ op: pendingRedirect, target: word.text }); pendingRedirect = null; return; }
    current.words.push(word);
  };
  while (i < source.length) {
    const c = source[i]!;
    if (c === '\n') {
      finish();
      i++;
      // Here-document bodies start on the line after their operator.
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
    if (c === '#' ) { while (i < source.length && source[i] !== '\n') i++; continue; }
    const operator = /^(?:&>>|&>|>>|>\||<<<|<<-|<<|<>|\d?>&\d|\d?>>|\d?>|<|&&|\|\||;;|[;&|()])/.exec(source.slice(i));
    if (operator) {
      const op = operator[0];
      i += op.length;
      if (/^\d?>&\d$/.test(op)) continue;
      if (['<<', '<<-', '<<<', '<'].includes(op) || /^(?:&>>|&>|>>|>\||<>|\d?>>|\d?>)$/.test(op)) { pendingRedirect = op.replace(/^\d/, ''); continue; }
      finish();
      continue;
    }
    // One word, honouring quotes and $(...) substitutions.
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
    // A brace group's braces are separate words; ${...} inside a word stays part of it.
    if (raw === '{' || raw === '}') finish();
    else if (raw) pushWord({ text, raw });
  }
  finish();
  return commands;
}

/** Index of the parenthesis closing the one at `open`, recording its contents as a substitution. */
function balanced(source: string, open: number, into: Simple): number {
  let depth = 0;
  for (let j = open; j < source.length; j++) {
    if (source[j] === '(') depth++;
    else if (source[j] === ')' && --depth === 0) { into.substitutions.push(source.slice(open + 1, j)); return j; }
  }
  into.substitutions.push(source.slice(open + 1));
  return source.length - 1;
}

const operands = (words: Word[]) => words.slice(1).filter(word => !word.text.startsWith('-')).map(word => word.text);

/** The protected targets a shell command acts on (not merely names). */
export function shellActsOn(source: string, depth = 0): string[] {
  if (depth > 4) return namedTargets(source);
  const acted = new Set<string>();
  const add = (text: string) => { for (const name of namedTargets(text)) acted.add(name); };
  for (const command of parseShell(source)) {
    for (const inner of command.substitutions) for (const name of shellActsOn(inner, depth + 1)) acted.add(name);
    for (const redirect of command.redirects) if (redirect.op !== '<') add(redirect.target);
    let words = command.words;
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text)) words = words.slice(1);
    while (words.length && WRAPPERS.has(words[0]!.text.split('/').pop()!)) {
      words = words.slice(1);
      while (words.length && (words[0]!.text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.text))) words = words.slice(1);
    }
    if (words[0]?.text === 'timeout') { words = words.slice(1); while (words.length && (words[0]!.text.startsWith('-') || /^\d/.test(words[0]!.text))) words = words.slice(1); }
    if (!words.length) continue;
    const name = words[0]!.text.split('/').pop()!;
    const text = words.map(word => word.text);
    if (SHELLS.has(name)) {
      const flag = text.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word));
      const scripts = flag >= 0 ? [text[flag + 1] ?? ''] : operands(words).length ? [] : command.bodies;
      for (const script of scripts) for (const found of shellActsOn(script, depth + 1)) acted.add(found);
      continue;
    }
    if (name === 'ssh') {
      let k = 1;
      while (k < text.length && text[k]!.startsWith('-')) k += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(text[k]!) ? 2 : 1;
      for (const found of shellActsOn(text.slice(k + 1).join(' '), depth + 1)) acted.add(found);
      continue;
    }
    if (INTERPRETERS.has(name.replace(/\d+(?:\.\d+)*$/, ''))) {
      const flag = text.findIndex(word => ['-c', '-e', '-E', '--eval', '-p'].includes(word));
      const code = flag >= 0 ? text[flag + 1] ?? '' : command.bodies.join('\n');
      add(code);
      continue;
    }
    if (name === 'sqlite3') {
      if (text.slice(1).some(word => namedTargets(word).length)) {
        const sql = [...text.slice(2), ...command.bodies].join('\n');
        if (!sql.trim() || WRITE_SQL.test(sql)) add(text.slice(1).join(' '));
      }
      continue;
    }
    if (['curl', 'wget', 'http', 'https'].includes(name)) { if (KEY_API.test(text.join(' '))) add(text.join(' ')); continue; }
    if ((name === 'sed' || name === 'perl') && text.some(word => /^-[a-zA-Z]*i/.test(word))) { for (const operand of operands(words)) add(operand); continue; }
    if (name === 'dd') { for (const word of text) if (word.startsWith('of=')) add(word); continue; }
    if (DESTINATION.has(name)) { const list = operands(words); if (list.length) add(list[list.length - 1]!); continue; }
    if (CHANGES.has(name)) { for (const operand of operands(words)) add(operand); continue; }
    if (TALK.has(name) || name === 'sed' || name === 'awk' || name === 'sort' || name === 'find') {
      if (name === 'find' && text.some(word => ['-delete', '-exec', '-execdir', '-fprint'].includes(word))) add(text.join(' '));
      if (name === 'sort' && text.some(word => word === '-o' || word.startsWith('--output'))) add(text.join(' '));
      continue;
    }
    // Anything else that is handed a protected path is taken to act on it.
    for (const operand of text.slice(1)) add(operand);
  }
  return [...acted];
}

/** The protected targets one agent tool call acts on, for Claude's and Codex's tool inputs. */
export function toolActsOn(input: Record<string, any>): string[] {
  const path = [input.file_path, input.path, input.notebook_path].find(value => typeof value === 'string');
  if (path) return namedTargets(path);
  if (Array.isArray(input.command)) {
    const argv = input.command.map(String);
    const shell = SHELLS.has(argv[0]?.split('/').pop() ?? '') ? argv.findIndex((word: string) => /^-[a-z]*c[a-z]*$/.test(word)) : -1;
    return shellActsOn(shell >= 0 ? argv[shell + 1] ?? '' : argv.map((word: string) => `'${word.replace(/'/g, "'\\''")}'`).join(' '));
  }
  if (typeof input.command === 'string') {
    // Codex's patch tool carries its targets on "*** Update/Add/Delete File:" lines.
    const patched = [...input.command.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!);
    return patched.length ? namedTargets(patched.join('\n')) : shellActsOn(input.command);
  }
  if (typeof input.patch === 'string' || typeof input.input === 'string') {
    const patch = String(input.patch ?? input.input);
    return namedTargets([...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1]!).join('\n'));
  }
  return [];
}
