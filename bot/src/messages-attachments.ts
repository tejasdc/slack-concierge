/**
 * Pictures and files attached to his texts, for `router-actions.sh messages`. Agents may not open
 * the Messages folder (bot/src/messages-database-policy.ts), so the reader lists each shown text's
 * attachments and copies a chosen one into a folder the agent names, converting Apple's HEIC photos
 * to JPEG so any tool can open them.
 *
 * The reader's code rule decides which attachments exist for agents at all: a text whose words look
 * like a code, reset or sign-in link (bot/src/text-code-withholding.ts), or one from an automated or
 * short-code sender, never lists or exports its attachments, even when thnkr.ing would show the code
 * itself. A picture from a person's number or address, or one Tejas sent, is ordinary.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { isAutomatedSender, textWithholding } from './text-code-withholding';

export type MessageAttachment = { id: string; type: string | null; name: string | null; bytes: number | null; onThisMac: boolean };

export type AttachmentOwner = { mine: boolean; handle: string | null; chatId: string | null; words: string | null };

/** Why a message's attachments are kept from agents, or null when they may be listed and exported. */
export function attachmentRefusal(owner: AttachmentOwner): string | null {
  if (!owner.mine && isAutomatedSender(owner.handle)) return 'it came from an automated or short-code sender';
  if (textWithholding(owner.words, owner.mine ? owner.chatId : (owner.handle ?? owner.chatId))) {
    return 'its text looks like a code, reset or sign-in link, so the message is withheld';
  }
  return null;
}

function messagesFolder(): string { return join(homedir(), 'Library', 'Messages'); }

function openMessages(): Database {
  return new Database(join(messagesFolder(), 'chat.db'), { readonly: true });
}

/** Messages stores `~/Library/Messages/Attachments/…`; anything resolving elsewhere is not read. */
function attachmentFile(stored: string | null): string | null {
  if (!stored) return null;
  const path = stored.startsWith('~/') ? join(homedir(), stored.slice(2)) : stored;
  if (!isAbsolute(path)) return null;
  try {
    const real = realpathSync(path);
    const root = realpathSync(join(messagesFolder(), 'Attachments'));
    return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/** The path with symlinks resolved as far as it exists, so a link or letter case cannot disguise it. */
function resolvedAsFarAsExists(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { rest.unshift(basename(existing)); existing = dirname(existing); }
  return join(realpathSync(existing), ...rest);
}

type AttachmentRow = { guid: string; mime: string | null; uti: string | null; name: string | null; bytes: number | null; filename: string | null };
const ATTACHMENT_COLUMNS = 'a.guid AS guid, a.mime_type AS mime, a.uti AS uti, a.transfer_name AS name, a.total_bytes AS bytes, a.filename AS filename';

/** Attachments of the given message row IDs; the caller has already applied attachmentRefusal. */
export function listAttachments(messageIds: number[]): Map<number, MessageAttachment[]> {
  const found = new Map<number, MessageAttachment[]>();
  if (!messageIds.length) return found;
  const database = openMessages();
  try {
    const query = database.query(`SELECT maj.message_id AS messageId, ${ATTACHMENT_COLUMNS}
      FROM message_attachment_join maj JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = ? ORDER BY a.ROWID`);
    for (const id of messageIds) {
      const rows = query.all(id) as (AttachmentRow & { messageId: number })[];
      if (rows.length) found.set(id, rows.map(row => ({
        id: row.guid, type: row.mime ?? row.uti, name: row.name, bytes: row.bytes, onThisMac: attachmentFile(row.filename) !== null,
      })));
    }
  } finally { database.close(); }
  return found;
}

function isHeic(row: AttachmentRow): boolean {
  return /hei[cf]/i.test(row.mime ?? '') || /hei[cf]/i.test(row.uti ?? '') || /\.hei[cf]$/i.test(row.name ?? row.filename ?? '');
}

export type ExportResult =
  | { exported: { id: string; path: string; type: string | null; convertedFrom: string | null; bytes: number } }
  | { error: string; message: string };

/** Copies one attachment, by the id the reader listed, into `folder`; HEIC becomes JPEG. */
export function exportAttachment(id: string, folder: string): ExportResult {
  try { return exportOne(id, folder); }
  catch (error) { return { error: 'EXPORT_FAILED', message: String(error).slice(0, 300) }; }
}

function exportOne(id: string, folder: string): ExportResult {
  const database = openMessages();
  let rows: (AttachmentRow & { mine: number; handle: string | null; chatId: string | null; text: string | null; body: Uint8Array | null })[];
  try {
    rows = database.query(`SELECT ${ATTACHMENT_COLUMNS}, m.is_from_me AS mine, h.id AS handle, c.chat_identifier AS chatId,
        m.text AS text, m.attributedBody AS body
      FROM attachment a
      JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
      JOIN message m ON m.ROWID = maj.message_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE a.guid = ?`).all(id) as typeof rows;
  } finally { database.close(); }
  const row = rows[0];
  if (!row) return { error: 'ATTACHMENT_NOT_FOUND', message: 'Use an attachment id listed by a messages read on this Mac.' };
  // An attachment shared by several messages is exported only if every one of them may show it.
  for (const owner of rows) {
    const refusal = attachmentRefusal({ mine: !!owner.mine, handle: owner.handle, chatId: owner.chatId, words: messageWords(owner.text, owner.body) });
    if (refusal) return { error: 'ATTACHMENT_WITHHELD', message: `Not exported: ${refusal}.` };
  }
  const source = attachmentFile(row.filename);
  if (!source) return { error: 'ATTACHMENT_NOT_ON_THIS_MAC', message: 'Messages has not downloaded this attachment to the Mac (it may still be in iCloud).' };

  const target = resolvedAsFarAsExists(folder);
  const messages = realpathSync(messagesFolder()).toLowerCase();
  if (target.toLowerCase() === messages || target.toLowerCase().startsWith(messages + sep)) {
    return { error: 'INVALID_DESTINATION', message: 'Name a folder of your own, outside the Messages folder.' };
  }
  mkdirSync(target, { recursive: true });
  const original = (row.name ?? basename(source)).replace(/[^\w .()-]/g, '_') || 'attachment';
  // The whole id: attachments of one message share all but their leading index.
  const prefix = id.replace(/[^\w-]/g, '_');
  if (isHeic(row)) {
    const path = join(target, `${prefix}-${basename(original, extname(original))}.jpg`);
    const converted = Bun.spawnSync(['/usr/bin/sips', '-s', 'format', 'jpeg', source, '--out', path], { stdout: 'ignore', stderr: 'pipe' });
    if (converted.exitCode !== 0 || !existsSync(path)) {
      rmSync(path, { force: true });
      return { error: 'CONVERSION_FAILED', message: `sips could not convert the HEIC photo: ${converted.stderr.toString().trim().slice(0, 300)}` };
    }
    return { exported: { id, path, type: 'image/jpeg', convertedFrom: row.mime ?? 'image/heic', bytes: statSync(path).size } };
  }
  const path = join(target, `${prefix}-${original}`);
  copyFileSync(source, path);
  return { exported: { id, path, type: row.mime ?? row.uti, convertedFrom: null, bytes: statSync(path).size } };
}

/**
 * The words of a message. Newer macOS leaves `text` empty and keeps them in `attributedBody`, an
 * archived NSAttributedString whose string follows "NSString" as a length-prefixed run (the same
 * reading as the Mac's sent-texts sync).
 */
export function messageWords(text: string | null, body: Uint8Array | null): string | null {
  if (text && text.trim()) return text;
  if (!body) return null;
  const bytes = Buffer.from(body);
  const start = bytes.indexOf('NSString');
  if (start < 0) return null;
  const plus = bytes.indexOf('+', start + 8);
  if (plus < 0 || plus > start + 20) return null;
  let at = plus + 1;
  let length = bytes[at]!;
  at += 1;
  if (length === 0x81) { length = bytes.readUInt16LE(at); at += 2; }
  else if (length === 0x82) { length = bytes.readUInt32LE(at); at += 4; }
  return bytes.subarray(at, at + length).toString('utf8');
}
