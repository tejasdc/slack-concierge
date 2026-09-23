/**
 * Runs before every tool call of every Concierge agent, Claude and Codex alike, and refuses one
 * that touches what keeps Tejas signed in or connected unless he has said yes to that exact
 * change. Usage: protected-change-guard.ts <state-db-path>.
 *
 * On 2026-09-23 an agent rewrote thnkr.ing's sign-in secret and the key that keeps him signed in,
 * without asking. Every screen he had open was signed out for eight hours and he found out by
 * coming in to a broken system. A written rule to ask first already existed; this makes asking
 * the only way through.
 *
 * Both providers run PreToolUse hooks with the tool's input on stdin and take
 * `hookSpecificOutput.permissionDecision: "deny"` with a reason the agent reads
 * (https://code.claude.com/docs/en/hooks#pretooluse, https://learn.chatgpt.com/docs/hooks).
 * Claude gets this with --settings on every run (claude-code.ts); Codex gets it as a managed hook
 * from /etc/codex/requirements.toml (scripts/install-codex-stop-hook.sh).
 *
 * His OK is a message he sends himself: "approve <code>", recorded by the owner as his (origin
 * human, no author correction), after the refusal that issued the code. It covers the targets
 * that refusal named, for an hour. Anything unexpected here refuses a protected call and lets
 * every other call through; a guard must not stop unrelated work.
 */
import { Database } from 'bun:sqlite';
import { randomInt } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Changing any of these can sign him out, stop a device of his posting, or swap an account he uses.
const PROTECTED: { name: string; pattern: RegExp }[] = [
  { name: "thnkr.ing's sign-in and session keys (/etc/thinkering)", pattern: /\/etc\/thinkering\/|THINKERING_(?:SESSION_KEY|LOGIN_SECRET)/ },
  { name: "thnkr.ing's passkeys and device keys", pattern: /\/authentication\/(?:passkeys|devices|push-devices)\.sqlite|\/api\/session\/(?:devices|passkeys)/ },
  { name: 'capture, device and machine-link keys (/etc/concierge, /etc/agent-inbox.token)', pattern: /\/etc\/concierge\/[\w.-]+\.token|\/etc\/agent-inbox\.token|peer\.token\b/ },
  { name: 'a device key file on the Mac (~/.config/thinkering)', pattern: /\.config\/thinkering\// },
  { name: 'his Slack connection', pattern: /\.config\/concierge\/slack\.toml|auth\.revoke/ },
  { name: 'his Codex and Claude sign-ins', pattern: /\.codex\/auth\.json|\.codex-accounts\/|\.claude\/\.credentials\.json/ },
];
const APPROVAL_WINDOW_MS = 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const stateDb = process.argv[2];
let hook: any = {};
try { hook = JSON.parse((await Bun.stdin.text()) || '{}'); } catch { process.exit(0); }
const input = hook.tool_input ?? {};
const path = [input.file_path, input.path, input.notebook_path].find(value => typeof value === 'string');
// A file tool is judged by the file it writes; a command by its text. A git command never touches
// these files, and its message may name them.
const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
const subject = path ?? (command !== null && /^\s*git\s/.test(command) ? '' : command ?? JSON.stringify(input));
const touched = PROTECTED.filter(item => item.pattern.test(subject)).map(item => item.name);
if (!touched.length) process.exit(0);
if (!stateDb) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refused: this touches what keeps Tejas signed in, and his approvals cannot be read here. Tell him what you need.' } }) + '\n');
  process.exit(0);
}

const requests = join(dirname(stateDb), 'protected-change-requests');
const deny = (reason: string) => {
  console.error(JSON.stringify({ event: 'protected_change_refused', targets: touched, provider_session: hook.session_id ?? null }));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
  process.exit(0);
};

type Request = { code: string; targets: string[]; createdAt: string };
function approved(): Request | null {
  let names: string[] = [];
  try { names = readdirSync(requests).filter(name => name.endsWith('.json')); } catch { return null; }
  const candidates = names.map(name => { try { return JSON.parse(readFileSync(join(requests, name), 'utf8')) as Request; } catch { return null; } })
    .filter((request): request is Request => !!request && touched.every(target => request.targets.includes(target)));
  if (!candidates.length) return null;
  const db = new Database(stateDb, { readonly: true });
  try {
    for (const request of candidates) {
      const answer = db.query(`SELECT created_at FROM session_inputs WHERE origin='human'
          AND id NOT IN (SELECT input_id FROM session_input_author_corrections)
          AND created_at >= datetime(?) AND upper(coalesce(json_extract(payload_json,'$.text'),json_extract(payload_json,'$.firstInput.text'),'')) LIKE ?
        ORDER BY created_at DESC LIMIT 1`).get(request.createdAt, `%APPROVE ${request.code}%`) as { created_at: string } | null;
      if (answer && Date.now() - Date.parse(answer.created_at.replace(' ', 'T') + 'Z') < APPROVAL_WINDOW_MS) return request;
    }
    return null;
  } finally { db.close(); }
}

try { if (approved()) process.exit(0); } catch { /* an approval that cannot be read is not an approval */ }

const code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
try {
  mkdirSync(requests, { recursive: true, mode: 0o700 });
  writeFileSync(join(requests, `${code}.json`), JSON.stringify({ code, targets: touched, createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19), subject: subject.slice(0, 500) }), { mode: 0o600 });
} catch { deny(`Refused: this touches ${touched.join('; ')}, which keeps Tejas signed in and connected, and the approval record could not be written. Do not work around this; tell him what you need.`); }
deny([
  `Refused: this touches ${touched.join('; ')}. Changing it can sign Tejas out or break his devices, so it needs his explicit OK first.`,
  `Stop and ask him. End your turn with a needs_you question that says in plain words what you want to change, what it will do to his sign-ins or devices, and how he recovers, and ask him to reply "approve ${code}".`,
  `After he replies with exactly that, the same kind of change is allowed for an hour. Do not work around this guard by other commands, files or machines: that is the same act without his OK.`,
].join('\n'));
