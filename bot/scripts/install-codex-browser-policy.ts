/** Install the Codex shell policy inherited by spawned agents, without restarting App Server. */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import toml from '@iarna/toml';

const path = process.argv[2];
if (!path) throw new Error('Expected the Codex system config path.');

const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
const config = before ? toml.parse(before) as Record<string, any> : {};
const policy = config.shell_environment_policy ??= {};
const set = policy.set ??= {};
const idleMs = '1200000';
if (set.AGENT_BROWSER_IDLE_TIMEOUT_MS === idleMs) process.exit(0);
set.AGENT_BROWSER_IDLE_TIMEOUT_MS = idleMs;

// Appending preserves unrelated settings and comments when no shell policy exists.
const next = !before.includes('[shell_environment_policy')
  ? `${before.trimEnd()}\n\n[shell_environment_policy.set]\nAGENT_BROWSER_IDLE_TIMEOUT_MS = "${idleMs}"\n`
  : toml.stringify(config);
const parsed = toml.parse(next) as Record<string, any>;
if (parsed.shell_environment_policy?.set?.AGENT_BROWSER_IDLE_TIMEOUT_MS !== idleMs) {
  throw new Error('Codex browser policy did not survive TOML serialization.');
}
mkdirSync(dirname(path), { recursive: true });
const temporary = `${path}.${process.pid}.tmp`;
try {
  writeFileSync(temporary, next, { mode: existsSync(path) ? statSync(path).mode : 0o644, flag: 'wx' });
  chmodSync(temporary, existsSync(path) ? statSync(path).mode : 0o644);
  renameSync(temporary, path);
} finally {
  if (existsSync(temporary)) unlinkSync(temporary);
}
