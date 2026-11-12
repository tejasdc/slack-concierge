/**
 * `router-actions.sh messages`: an agent on the Mac reads Tejas's texts, received and sent. Texts
 * that look like a login code, reset or sign-in link (bot/src/text-code-withholding.ts) are shown
 * only when thnkr.ing's rule allows them — ordinary sites and his allow list — and hidden for his
 * money and identity accounts and his hide list [decision: codes-hidden-only-for-money-and-identity].
 * Agents may not open the Messages database themselves (bot/src/messages-database-policy.ts), so
 * this is their way in. A hidden text is listed by sender, time and kind, never its words, and every
 * completed read is recorded (bot/src/messages-read-log.ts).
 *
 *   router-actions.sh messages [--with <number, address or chat name>] [--q <words>] [--days <n>] [--limit <n>]
 *   router-actions.sh messages --chat-guid <exact conversation GUID> --from YYYY-MM-DD --before YYYY-MM-DD [--q <words>] [--limit <n>]
 *   router-actions.sh messages --attachment <attachment id from a read> --to <folder>
 *
 * Shown texts list their attachments; the second form copies one out (bot/src/messages-attachments.ts).
 *
 * It runs only on the Mac, where the texts are; the server answers that it has none.
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { textWithholding } from '../src/text-code-withholding';
import { recordMessagesRead } from '../src/messages-read-log';
import { attachmentRefusal, exportAttachment, listAttachments, messageWords } from '../src/messages-attachments';

const usage = 'usage: router-actions.sh messages [--with <number, address or chat name>] [--q <words>] [--days <n, default 7, max 365>] [--limit <n, default 50, max 500>]'
  + ' | --chat-guid <exact conversation GUID> --from YYYY-MM-DD --before YYYY-MM-DD [--q <words>] [--limit <n, max 500>]'
  + ' | --attachment <attachment id from a read> --to <folder>. Historical windows are at most 45 days; before is exclusive.';

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (process.platform !== 'darwin') {
  console.log(JSON.stringify({ error: 'MESSAGES_NOT_ON_THIS_MACHINE', message: 'His texts live only on the Mac. Ask a Mac session, or read his own sent texts through thnkr.ing.' }));
  process.exit(2);
}
const attachmentToExport = option(args, '--attachment');
if (args.includes('--attachment')) {
  const folder = option(args, '--to');
  if (!attachmentToExport || !folder) { console.error(JSON.stringify({ error: 'INVALID_ATTACHMENT_EXPORT', usage })); process.exit(2); }
  const result = exportAttachment(attachmentToExport, folder);
  try { recordMessagesRead({ event: 'error' in result ? 'messages_attachment_refused' : 'messages_attachment_exported', cwd: process.cwd(),
    attachment: attachmentToExport, to: 'exported' in result ? result.exported.path : folder, error: 'error' in result ? result.error : undefined }); }
  catch (error) { console.error(JSON.stringify({ event: 'messages_attachment_log_failed', error: String(error) })); }
  console.log(JSON.stringify(result, null, 1));
  process.exit('error' in result ? 2 : 0);
}
function bounded(raw: string | undefined, fallback: number, max: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), max) : fallback;
}
const days = bounded(option(args, '--days'), 7, 365);
const limit = bounded(option(args, '--limit'), 50, 500);
const withWhom = option(args, '--with')?.toLowerCase().trim() || null;
const query = option(args, '--q')?.toLowerCase().trim() || null;
const selectedChatGuid = option(args, '--chat-guid')?.trim() || null;
const from = option(args, '--from');
const before = option(args, '--before');
const historical = selectedChatGuid !== null || from !== undefined || before !== undefined;
function dateStart(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time / 1000 : null;
}
const fromTime = dateStart(from);
const beforeTime = dateStart(before);
if (historical && (!selectedChatGuid || fromTime === null || beforeTime === null
    || beforeTime <= fromTime || beforeTime - fromTime > 45 * 86_400
    || withWhom || args.includes('--days'))) {
  console.error(JSON.stringify({ error: 'INVALID_HISTORICAL_MESSAGES_WINDOW', usage }));
  process.exit(2);
}

// Message dates count nanoseconds (older rows: seconds) from 2001-01-01.
const APPLE_EPOCH = 978_307_200;
const since = (historical ? fromTime! : Date.now() / 1000 - days * 86_400) - APPLE_EPOCH;
const until = (historical ? beforeTime! : Date.now() / 1000) - APPLE_EPOCH;
const database = new Database(join(homedir(), 'Library', 'Messages', 'chat.db'), { readonly: true });
const selectedChat = historical ? database.query(`
  SELECT c.ROWID AS id FROM chat c
  WHERE c.guid = ?
`).get(selectedChatGuid) as { id: number } | null : null;
if (historical && !selectedChat) {
  database.close();
  console.error(JSON.stringify({ error: 'CHAT_NOT_FOUND', message: 'Use the exact chatGuid from an approved Messages read of this conversation.' }));
  process.exit(2);
}
const rows = database.query(`
  SELECT m.ROWID AS id, m.guid AS messageGuid, m.is_from_me AS mine, h.id AS handle,
         c.ROWID AS chatRowId, c.guid AS chatGuid, c.display_name AS chat, c.chat_identifier AS chatId,
         (CASE WHEN m.date > 1000000000000 THEN m.date / 1000000000 ELSE m.date END) + ${APPLE_EPOCH} AS at,
         m.text AS text, m.attributedBody AS body
  FROM message m
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  LEFT JOIN chat c ON c.ROWID = cmj.chat_id
  WHERE ((m.date > 1000000000000 AND m.date >= ? AND m.date < ?)
     OR (m.date <= 1000000000000 AND m.date >= ? AND m.date < ?))
    AND m.associated_message_type = 0
    AND (? IS NULL OR c.ROWID = ?)
  ORDER BY m.date DESC, m.ROWID DESC`).all(since * 1e9, until * 1e9, since, until, selectedChat?.id ?? null, selectedChat?.id ?? null) as {
    id: number; messageGuid: string | null; mine: number; handle: string | null; chatRowId: number | null;
    chatGuid: string | null; chat: string | null; chatId: string | null; at: number; text: string | null; body: Uint8Array | null
  }[];
// `--limit` counts the texts shown. Withheld texts are counted across the same stretch of time and
// listed up to WITHHELD_LISTED, so a search is never cut short by codes and never silently.
const WITHHELD_LISTED = 200;
const shown: unknown[] = [];
const shownChats = new Map<number, { chatGuid: string | null; chatId: string | null; chat: string | null }>();
const withheld: unknown[] = [];
const counts: Record<string, number> = {};
const codesShown: Record<string, number> = {};
let withheldTotal = 0;
let truncatedAt: string | null = null;
const withAttachments = new Map<number, Record<string, unknown>>();

// Which of the code-looking texts an agent may see is not decided here: thnkr.ing holds the one
// rule and his allow and hide lists (its code-policy.ts), so this asks it over the same SSH every
// Mac agent uses to reach the server, in batches, and hides every one it cannot get an answer for.
type CodeDecision = { key: boolean; withhold: boolean; category: string | null; rule: string | null; service: string | null };
const candidates = new Map<number, { from: string | null; text: string }>();
const scanned = rows.filter(row => !withWhom || [row.handle, row.chat, row.chatId].filter(Boolean).join(' ').toLowerCase().includes(withWhom)).map(row => {
  const words = messageWords(row.text, row.body);
  const sender = row.mine ? null : row.handle;
  const kind = textWithholding(words, sender ?? row.chatId);
  if (kind && words && candidates.size < 1000) candidates.set(row.id, { from: sender ?? row.chatId, text: words.slice(0, 20_000) });
  return { row, words, kind };
});
const decisions = new Map<number, CodeDecision>();
let codeRuleUnavailable: string | null = null;
const ids = [...candidates.keys()];
for (let at = 0; at < ids.length && !codeRuleUnavailable; at += 200) {
  const batch = ids.slice(at, at + 200);
  const body = JSON.stringify({ items: batch.map(id => ({ channel: 'text', from: candidates.get(id)!.from, text: candidates.get(id)!.text })) });
  const answer = Bun.spawnSync(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'remote-box',
    'curl -s --max-time 20 --unix-socket /run/thinkering/session-capabilities.sock -H content-type:application/json --data-binary @- http://x/codes/decide'],
  { stdin: Buffer.from(body), stdout: 'pipe', stderr: 'ignore', timeout: 30_000 });
  try {
    const parsed = JSON.parse(answer.stdout.toString()) as { decisions?: CodeDecision[] };
    if (!Array.isArray(parsed.decisions) || parsed.decisions.length !== batch.length) throw new Error('no decisions');
    batch.forEach((id, index) => decisions.set(id, parsed.decisions![index]!));
  } catch {
    codeRuleUnavailable = 'thnkr.ing could not be asked which codes agents may see, so every code-looking text is hidden this time.';
  }
}

for (const { row, words, kind } of scanned) {
  if (shown.length >= limit) { truncatedAt = new Date(row.at * 1000).toISOString(); break; }
  const when = new Date(row.at * 1000).toISOString();
  const decision = kind ? decisions.get(row.id) : undefined;
  // Shown only when thnkr.ing explicitly allowed it; no answer, or "not a key" for a text that looks
  // like one here, keeps it hidden.
  if (kind && decision?.key && !decision.withhold) {
    if (query && !(words ?? '').toLowerCase().includes(query)) continue;
    const label = decision.service ?? 'unknown site';
    codesShown[label] = (codesShown[label] ?? 0) + 1;
    shown.push({ id: row.messageGuid, at: when, from: row.mine ? 'Tejas' : row.handle, chat: row.chat || null,
      chatGuid: row.chatGuid, text: words,
      codeShown: { category: decision.category, service: decision.service, rule: decision.rule } });
    if (row.chatRowId !== null) shownChats.set(row.chatRowId, { chatGuid: row.chatGuid, chatId: row.chatId, chat: row.chat || null });
    continue;
  }
  if (kind) {
    // Listed whatever was searched for and never matched against the search: answering whether a
    // code contains "12" would let a search spell the code out one digit at a time.
    if (withheld.length < WITHHELD_LISTED) withheld.push({ at: when, from: row.mine ? 'Tejas' : row.handle, chat: row.chat || null, kind });
    counts[kind] = (counts[kind] ?? 0) + 1;
    withheldTotal++;
    continue;
  }
  if (query && !(words ?? '').toLowerCase().includes(query)) continue;
  shown.push({ id: row.messageGuid, at: when, from: row.mine ? 'Tejas' : row.handle, chat: row.chat || null,
    chatGuid: row.chatGuid, text: words });
  if (row.chatRowId !== null) shownChats.set(row.chatRowId, { chatGuid: row.chatGuid, chatId: row.chatId, chat: row.chat || null });
  if (!attachmentRefusal({ mine: !!row.mine, handle: row.handle, chatId: row.chatId, words })) withAttachments.set(row.id, shown.at(-1) as Record<string, unknown>);
}
// Only ordinary texts carry attachments; code texts, even shown ones, and automated senders never do.
const attachments = listAttachments([...withAttachments.keys()]);
for (const [id, entry] of withAttachments) if (attachments.has(id)) entry.attachments = attachments.get(id);
const chats = [...shownChats].map(([id, chat]) => {
  const handles = database.query(`SELECT h.id AS address FROM chat_handle_join chj
    JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ? ORDER BY h.id`).all(id) as { address: string }[];
  return { ...chat, participants: handles.map(handle => handle.address) };
});
database.close();

{
  // Record even a no-match historical read. The log contains the scope and counts, never text.
  try { recordMessagesRead({ event: withheldTotal || Object.keys(codesShown).length ? 'messages_withheld' : 'messages_read',
    cwd: process.cwd(), with: withWhom, chatGuid: selectedChatGuid, q: query,
    from: historical ? from : null, before: historical ? before : null, days: historical ? null : days,
    limit, shown: shown.length, withheld: counts, codesShown, codeRuleUnavailable: !!codeRuleUnavailable }); }
  catch (error) { console.error(JSON.stringify({ event: 'messages_read_log_failed', error: String(error) })); }
}
console.log(JSON.stringify({
  messages: shown,
  chats,
  withheld,
  withheldCount: withheldTotal,
  withheldByKind: counts,
  withheldNote: withheldTotal
    ? 'Codes, reset texts and sign-in links for his money and identity accounts (and any site on his hide list) are never shown to agents. Only their sender, time and kind are listed'
      + (withheldTotal > withheld.length ? `, the newest ${withheld.length} of ${withheldTotal}.` : '.')
    : undefined,
  codesShownNote: Object.keys(codesShown).length
    ? 'Login codes from ordinary sites, or sites on his allow list, are shown so agents can sign in for him; each carries codeShown with the site and rule.'
    : undefined,
  codeRuleUnavailable: codeRuleUnavailable ?? undefined,
  window: { days: historical ? null : days, from: historical ? from : null, before: historical ? before : null,
    limit, newestFirst: true, truncated: truncatedAt !== null, olderThanThisNotRead: truncatedAt },
}, null, 1));
