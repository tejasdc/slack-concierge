/**
 * The files that hold the keys keeping Tejas signed in and connected, and a fingerprint of each
 * key that never carries its value. The key-change notice (bot/scripts/key-change-notice.ts)
 * tells him when one changes; nothing here blocks or holds a change (2026-09-23: agents keep full
 * control of the machine, and a notice is what he asked to keep).
 */
import { createHash } from 'node:crypto';

export type KeyFile = Readonly<{ path: string; format: 'env' | 'whole'; service: string; unit?: string }>;
export const KEY_FILES: readonly KeyFile[] = [
  { path: '/etc/thinkering/server.env', format: 'env', service: 'thnkr.ing', unit: 'thinkering.service' },
  { path: '/etc/concierge/pebble-index.token', format: 'whole', service: 'the Pebble capture key', unit: 'agent-inbox.service' },
  { path: '/etc/agent-inbox.token', format: 'whole', service: 'the Watch audio capture key', unit: 'agent-inbox.service' },
  { path: '/etc/concierge/thinkering.token', format: 'whole', service: "thnkr.ing's capture key", unit: 'agent-inbox.service' },
  { path: '/etc/concierge/capture-queue.token', format: 'whole', service: 'the capture queue key', unit: 'agent-inbox.service' },
  { path: '/etc/concierge/peer.token', format: 'whole', service: 'the Mac link key', unit: 'concierge-bot.service' },
  { path: '/root/.config/concierge/slack.toml', format: 'env', service: 'the Slack connection', unit: 'concierge-bot.service' },
];

/** Key name → SHA-256 of its value; never the value. A whole-file secret is one key, `(file)`. */
export function keyFingerprints(content: string | null, format: KeyFile['format']): Record<string, string> {
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
