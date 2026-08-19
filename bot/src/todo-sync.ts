import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  appendListItem,
  deleteListItem,
  listItems,
  updateListItem,
} from "./lists";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { isTransientSlackError } from "./slack-errors";
import {
  claimTodoSyncConflictNotice,
  commitTodoSyncState,
  getTodoSyncState,
  markTodoSyncConflictNoticeDelivered,
  parkTodoSyncConflictNotice,
  prepareTodoSyncConflictNotice,
  recoverTodoSyncConflictNoticeClaims,
  retryTodoSyncConflictNotice,
  type ChannelRow,
} from "./state";

export interface TodoRow {
  id: string;
  title: string;
  completed: boolean;
}

export interface TodoMergeResult {
  rows: TodoRow[];
  deleteSlackIds: string[];
  conflicts: string[];
}

interface TodoSyncIdentity {
  identitySecret: string;
  identityOwnerId: string;
}

interface TodoSyncOptions {
  afterTodoFileSnapshotCheck?(path: string): void;
  afterTodoFileExchange?(path: string): void;
  markConflictNoticeDelivered?: typeof markTodoSyncConflictNoticeDelivered;
  waitBeforeLocalRetry?(milliseconds: number): Promise<void>;
  ownerInstanceId?: string;
  isOwnerAlive?(identity: { pid: number; bootId: string; startTicks: string }): boolean;
}

interface ParsedTodoLine {
  lineIndex: number;
  indent: string;
  row: TodoRow;
}

interface MarkdownLine {
  content: string;
  ending: string;
}

function normalizeTitle(title: string) {
  return title.replace(/\s+/g, " ").trim();
}

function comparable(row: TodoRow | undefined) {
  return row ? { title: row.title, completed: row.completed } : null;
}

function sameRow(left: TodoRow | undefined, right: TodoRow | undefined) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function markdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  while (pattern.lastIndex < markdown.length) {
    const match = pattern.exec(markdown);
    if (!match) break;
    lines.push({ content: match[1], ending: match[2] });
  }
  if (!lines.length && markdown === "") return [];
  return lines;
}

function parseTodoLines(markdown: string): ParsedTodoLine[] {
  const rows: ParsedTodoLine[] = [];
  let localIndex = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let htmlBlock: "comment" | "raw" | "blank" | null = null;
  for (const [lineIndex, { content: line }] of markdownLines(markdown).entries()) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (htmlBlock === "blank") {
      if (line.trim() === "") htmlBlock = null;
      continue;
    }
    if (htmlBlock) {
      if (
        (htmlBlock === "comment" && /-->\s*$/.test(line))
        || (htmlBlock === "raw" && /<\/(?:script|pre|style|textarea)>\s*$/i.test(line))
      ) htmlBlock = null;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      if (!/-->\s*$/.test(line)) htmlBlock = "comment";
      continue;
    }
    if (/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>)/i.test(line)) {
      if (!/<\/(?:script|pre|style|textarea)>\s*$/i.test(line)) htmlBlock = "raw";
      continue;
    }
    if (/^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>)/i.test(line)) {
      htmlBlock = "blank";
      continue;
    }
    const match = line.match(/^()-\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!match) continue;
    const marker = match[3].match(/\s*<!--\s*(Rec[A-Za-z0-9]+)\s*-->\s*$/);
    const title = normalizeTitle(match[3]
      .replace(/\s*<!--\s*Rec[A-Za-z0-9]+\s*-->\s*$/, "")
      .replace(/\s*<!--\s*concierge-capture-v1:[^>]+-->\s*$/, ""));
    if (!title) continue;
    rows.push({
      lineIndex,
      indent: match[1],
      row: {
        id: marker?.[1] || `local:${localIndex++}`,
        title,
        completed: match[2].toLowerCase() === "x",
      },
    });
  }
  return rows;
}

export function parseTodosMarkdown(markdown: string): TodoRow[] {
  return parseTodoLines(markdown).map(({ row }) => row);
}

function renderTodoRow(row: TodoRow, indent = "") {
  return `${indent}- [${row.completed ? "x" : " "}] ${row.title} <!-- ${row.id} -->`;
}

export function renderTodosMarkdown(channel: ChannelRow, rows: TodoRow[], existingMarkdown = "") {
  if (!existingMarkdown) {
    return [
      `# #${channel.slack_channel_name} todos`,
      "",
      ...rows.map((row) => renderTodoRow(row)),
      "",
    ].join("\n");
  }

  const lines = markdownLines(existingMarkdown);
  const parsedLines = parseTodoLines(existingMarkdown);
  const desiredById = new Map(rows.map((row) => [row.id, row]));
  const consumedIds = new Set<string>();

  for (const parsed of parsedLines) {
    let desired = parsed.row.id.startsWith("local:") ? undefined : desiredById.get(parsed.row.id);
    if (!desired) {
      desired = rows.find((candidate) => (
        !consumedIds.has(candidate.id)
        && normalizeTitle(candidate.title).toLowerCase() === normalizeTitle(parsed.row.title).toLowerCase()
      ));
    }
    if (!desired) {
      lines[parsed.lineIndex].content = "";
      continue;
    }
    consumedIds.add(desired.id);
    lines[parsed.lineIndex].content = renderTodoRow(desired, parsed.indent);
  }

  const additions = rows.filter((row) => !consumedIds.has(row.id)).map((row) => renderTodoRow(row));
  if (additions.length > 0) {
    const preferredEnding = lines.find((line) => line.ending)?.ending || "\n";
    if (lines.length && !lines.at(-1)!.ending) lines.at(-1)!.ending = preferredEnding;
    if (lines.length && lines.at(-1)!.content !== "") {
      lines.push({ content: "", ending: preferredEnding });
    }
    for (const addition of additions) lines.push({ content: addition, ending: preferredEnding });
  }
  return lines.map((line) => `${line.content}${line.ending}`).join("");
}

export function mergeTodoRows(baseRows: TodoRow[], fileRows: TodoRow[], slackRows: TodoRow[]): TodoMergeResult {
  const base = new Map(baseRows.map((row) => [row.id, row]));
  const file = new Map(fileRows.map((row) => [row.id, row]));
  const slack = new Map(slackRows.map((row) => [row.id, row]));
  const ids = [...new Set([
    ...baseRows.map((row) => row.id),
    ...fileRows.map((row) => row.id),
    ...slackRows.map((row) => row.id),
  ])];
  const rows: TodoRow[] = [];
  const deleteSlackIds: string[] = [];
  const conflicts: string[] = [];

  for (const id of ids) {
    const prior = base.get(id);
    const fileRow = file.get(id);
    const slackRow = slack.get(id);

    if (!prior) {
      if (fileRow) rows.push(fileRow);
      else if (slackRow) rows.push(slackRow);
      continue;
    }

    if (!fileRow) {
      if (slackRow) {
        deleteSlackIds.push(id);
        if (!sameRow(prior, slackRow)) conflicts.push(`${id}: file deletion won over a simultaneous Slack edit`);
      }
      continue;
    }

    if (!slackRow) {
      if (sameRow(prior, fileRow)) continue;
      conflicts.push(`${id}: file edit won over a simultaneous Slack deletion`);
      rows.push(fileRow);
      continue;
    }

    const fileTitleChanged = fileRow.title !== prior.title;
    const slackTitleChanged = slackRow.title !== prior.title;
    const fileCompletedChanged = fileRow.completed !== prior.completed;
    const slackCompletedChanged = slackRow.completed !== prior.completed;
    let title = fileTitleChanged ? fileRow.title : slackRow.title;
    let completed = fileCompletedChanged ? fileRow.completed : slackRow.completed;

    if (fileTitleChanged && slackTitleChanged && fileRow.title !== slackRow.title) {
      title = fileRow.title;
      conflicts.push(`${id}: file title won over a simultaneous Slack title edit`);
    }
    if (fileCompletedChanged && slackCompletedChanged && fileRow.completed !== slackRow.completed) {
      completed = fileRow.completed;
      conflicts.push(`${id}: file completion won over a simultaneous Slack completion edit`);
    }
    rows.push({ id, title, completed });
  }
  return { rows, deleteSlackIds, conflicts };
}

function todoPath(channel: ChannelRow) {
  return join(channel.vault_path, "notes", "TODOS.md");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function exchangePaths(path: string) {
  return {
    exchangePath: `${path}.concierge-exchange`,
    journalPath: `${path}.concierge-exchange.json`,
  };
}

function atomicExchange(left: string, right: string) {
  const helper = new URL("../scripts/rename-exchange.py", import.meta.url).pathname;
  const result = spawnSync("/usr/bin/python3", [helper, left, right], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Atomic TODO file exchange failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
}

function durableWrite(path: string, content: string) {
  writeFileSync(path, content, { flag: "wx" });
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function recoverTodoFileExchange(path: string) {
  const { exchangePath, journalPath } = exchangePaths(path);
  if (!existsSync(journalPath)) {
    if (existsSync(exchangePath)) {
      throw new Error(`Unowned TODO recovery file requires inspection: ${exchangePath}`);
    }
    return;
  }
  let journal: { expectedExists: boolean; expectedHash: string | null; generatedHash: string };
  try {
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  } catch (error) {
    throw new Error(`TODO exchange journal is unreadable and was preserved at ${journalPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(exchangePath)) {
    unlinkSync(journalPath);
    fsyncDirectory(dirname(path));
    return;
  }
  const exchangeHash = sha256(readFileSync(exchangePath, "utf8"));
  if (!existsSync(path)) {
    if (!journal.expectedExists && exchangeHash === journal.generatedHash) {
      unlinkSync(exchangePath);
      unlinkSync(journalPath);
      fsyncDirectory(dirname(path));
      return;
    }
    throw new Error(`Canonical TODO file is missing; recovery content was preserved at ${exchangePath}`);
  }
  const canonicalHash = sha256(readFileSync(path, "utf8"));
  if (exchangeHash === journal.generatedHash) {
    unlinkSync(exchangePath);
    unlinkSync(journalPath);
    fsyncDirectory(dirname(path));
    return;
  }
  if (journal.expectedExists && exchangeHash === journal.expectedHash) {
    unlinkSync(exchangePath);
    unlinkSync(journalPath);
    fsyncDirectory(dirname(path));
    return;
  }
  if (canonicalHash !== journal.generatedHash) {
    throw new Error(`Both TODO exchange sides changed; preserved canonical ${path} and recovery ${exchangePath}`);
  }
  atomicExchange(path, exchangePath);
  fsyncDirectory(dirname(path));
  unlinkSync(exchangePath);
  unlinkSync(journalPath);
  fsyncDirectory(dirname(path));
}

interface TodoFileSnapshot {
  exists: boolean;
  markdown: string;
}

function readFileSnapshot(channel: ChannelRow): TodoFileSnapshot {
  const legacyPath = join(channel.vault_path, "TODOS.md");
  if (existsSync(legacyPath)) {
    throw new Error(`Legacy TODO file requires scaffold migration before synchronization: ${legacyPath}`);
  }
  const path = todoPath(channel);
  recoverTodoFileExchange(path);
  return readRawFileSnapshot(path);
}

function readRawFileSnapshot(path: string): TodoFileSnapshot {
  return existsSync(path)
    ? { exists: true, markdown: readFileSync(path, "utf8") }
    : { exists: false, markdown: "" };
}

function sameFileSnapshot(left: TodoFileSnapshot, right: TodoFileSnapshot) {
  return left.exists === right.exists && left.markdown === right.markdown;
}

function isFilesystemRace(error: unknown, code: string) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as any).code === code);
}

function writeFileRows(
  channel: ChannelRow,
  rows: TodoRow[],
  expected: TodoFileSnapshot,
  afterSnapshotCheck?: (path: string) => void,
  afterExchange?: (path: string) => void,
) {
  const path = todoPath(channel);
  mkdirSync(dirname(path), { recursive: true });
  recoverTodoFileExchange(path);
  const { exchangePath, journalPath } = exchangePaths(path);
  const generatedMarkdown = renderTodosMarkdown(channel, rows, expected.markdown);
  durableWrite(journalPath, JSON.stringify({
    expectedExists: expected.exists,
    expectedHash: expected.exists ? sha256(expected.markdown) : null,
    generatedHash: sha256(generatedMarkdown),
  }));
  durableWrite(exchangePath, generatedMarkdown);
  if (!sameFileSnapshot(readRawFileSnapshot(path), expected)) {
    unlinkSync(exchangePath);
    unlinkSync(journalPath);
    return null;
  }
  afterSnapshotCheck?.(path);

  if (!expected.exists) {
    try {
      linkSync(exchangePath, path);
      unlinkSync(exchangePath);
      unlinkSync(journalPath);
      fsyncDirectory(dirname(path));
      return path;
    } catch (error) {
      unlinkSync(exchangePath);
      unlinkSync(journalPath);
      if (isFilesystemRace(error, "EEXIST")) return null;
      throw error;
    }
  }

  atomicExchange(path, exchangePath);
  fsyncDirectory(dirname(path));
  afterExchange?.(path);
  const displacedMarkdown = readFileSync(exchangePath, "utf8");
  const installedMarkdown = readFileSync(path, "utf8");
  if (displacedMarkdown !== expected.markdown) {
    if (installedMarkdown !== generatedMarkdown) {
      throw new Error(`Both TODO exchange sides changed; preserved canonical ${path} and recovery ${exchangePath}`);
    }
    atomicExchange(path, exchangePath);
    fsyncDirectory(dirname(path));
    unlinkSync(exchangePath);
    unlinkSync(journalPath);
    return null;
  }
  unlinkSync(exchangePath);
  unlinkSync(journalPath);
  fsyncDirectory(dirname(path));
  if (installedMarkdown !== generatedMarkdown) return null;
  return path;
}

function parseBase(channelId: string): TodoRow[] {
  const state = getTodoSyncState(channelId);
  if (!state) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.base_json);
  } catch (error) {
    throw new Error(`TODO sync base is corrupt for ${channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`TODO sync base is not an array for ${channelId}.`);
  const ids = new Set<string>();
  return parsed.map((row, index) => {
    if (
      !row
      || typeof row !== "object"
      || typeof row.id !== "string"
      || !row.id
      || typeof row.title !== "string"
      || typeof row.completed !== "boolean"
      || ids.has(row.id)
    ) {
      throw new Error(`TODO sync base row ${index} is invalid for ${channelId}.`);
    }
    ids.add(row.id);
    return { id: row.id, title: row.title, completed: row.completed };
  });
}

function parseIgnoredSlackItemIds(channelId: string): Set<string> {
  const state = getTodoSyncState(channelId);
  if (!state) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.ignored_slack_item_ids_json);
  } catch (error) {
    throw new Error(`TODO ignored-item provenance is corrupt for ${channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value)) {
    throw new Error(`TODO ignored-item provenance is invalid for ${channelId}.`);
  }
  return new Set(parsed);
}

function isHistoricalCaptureTitle(title: string) {
  return title.startsWith("[note] ") || title.startsWith("[agent] ");
}

function deterministicClientMessageId(signature: string) {
  const hex = createHash("sha256").update(signature).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function bindUnboundFileRows(fileRows: TodoRow[], slackRows: TodoRow[]) {
  const usedSlackIds = new Set(fileRows.filter((row) => !row.id.startsWith("local:")).map((row) => row.id));
  return fileRows.map((row) => {
    if (!row.id.startsWith("local:")) return row;
    const match = slackRows.find((candidate) => (
      !usedSlackIds.has(candidate.id)
      && normalizeTitle(candidate.title).toLowerCase() === normalizeTitle(row.title).toLowerCase()
    ));
    if (!match) return row;
    usedSlackIds.add(match.id);
    return { ...row, id: match.id };
  });
}

export class TodoSyncManager {
  private readonly pendingByChannel = new Map<string, Promise<string | null>>();

  constructor(
    private readonly identity: TodoSyncIdentity,
    private readonly options: TodoSyncOptions = {},
  ) {
    const recovered = recoverTodoSyncConflictNoticeClaims(this.options.isOwnerAlive);
    if (recovered) log("warn", "todo_sync_conflict_notice_claims_recovered", { count: recovered });
  }

  reconcile(input: { client: any; channel: ChannelRow; user?: string | null }) {
    const key = input.channel.slack_channel_id;
    const predecessor = this.pendingByChannel.get(key);
    const task = (predecessor ? predecessor.catch(() => null) : Promise.resolve(null))
      .then(() => this.reconcileUntilStable(input))
      .finally(() => {
      if (this.pendingByChannel.get(key) === task) this.pendingByChannel.delete(key);
    });
    this.pendingByChannel.set(key, task);
    return task;
  }

  async drain() {
    while (this.pendingByChannel.size > 0) {
      await Promise.allSettled([...this.pendingByChannel.values()]);
    }
  }

  private async reconcileUntilStable(input: { client: any; channel: ChannelRow; user?: string | null }) {
    while (true) {
      const path = await this.reconcileOnce(input);
      if (path) return path;
      log("info", "todo_sync_file_changed_during_reconcile", {
        channel: input.channel.slack_channel_id,
      });
    }
  }

  private async reconcileOnce(input: { client: any; channel: ChannelRow; user?: string | null }) {
    const fileSnapshot = readFileSnapshot(input.channel);
    await this.deliverConflictNotices(input);
    const syncState = getTodoSyncState(input.channel.slack_channel_id);
    const baseRows = parseBase(input.channel.slack_channel_id);
    let fileRows = parseTodosMarkdown(fileSnapshot.markdown);
    const ignoredSlackItemIds = parseIgnoredSlackItemIds(input.channel.slack_channel_id);
    const listedSlackRows = await listItems({ ...input, ...this.identity });
    if (!syncState?.historical_migration_complete) {
      const boundIds = new Set([
        ...baseRows.map((row) => row.id),
        ...fileRows.filter((row) => !row.id.startsWith("local:")).map((row) => row.id),
      ]);
      for (const row of listedSlackRows) {
        if (!boundIds.has(row.id) && isHistoricalCaptureTitle(row.title)) ignoredSlackItemIds.add(row.id);
      }
    }
    let slackRows = listedSlackRows.filter((row) => !ignoredSlackItemIds.has(row.id));
    fileRows = bindUnboundFileRows(fileRows, slackRows);

    for (const row of fileRows.filter((candidate) => candidate.id.startsWith("local:"))) {
      const itemId = await appendListItem({
        ...input,
        ...this.identity,
        text: row.title,
        source: "todo",
      });
      if (!itemId) throw new Error("Slack did not return an ID for a newly synchronized todo.");
      if (row.completed) {
        await updateListItem({ ...input, ...this.identity, itemId, completed: true });
      }
      fileRows = fileRows.map((candidate) => candidate.id === row.id ? { ...candidate, id: itemId } : candidate);
      slackRows.push({ ...row, id: itemId });
    }

    const merged = mergeTodoRows(baseRows, fileRows, slackRows);
    const conflictSignature = merged.conflicts.length
      ? createHash("sha256").update(JSON.stringify({ baseRows, fileRows, slackRows, conflicts: merged.conflicts })).digest("hex")
      : null;
    const conflictNotice = conflictSignature ? {
      slackChannelId: input.channel.slack_channel_id,
      conflictSignature,
      noticeText: `TODO sync detected ${merged.conflicts.length} simultaneous edit${merged.conflicts.length === 1 ? "" : "s"}. notes/TODOS.md is authoritative and its values will be projected: ${merged.conflicts.join("; ")}`,
      clientMsgId: deterministicClientMessageId(`todo-conflict:${input.channel.slack_channel_id}:${conflictSignature}`),
    } : undefined;
    if (conflictNotice) prepareTodoSyncConflictNotice(conflictNotice);
    for (const itemId of merged.deleteSlackIds) {
      await deleteListItem({ ...input, ...this.identity, itemId });
    }

    const slackById = new Map(slackRows.map((row) => [row.id, row]));
    const synchronizedRows: TodoRow[] = [];
    for (const row of merged.rows) {
      const slackRow = slackById.get(row.id);
      if (!slackRow) {
        const itemId = await appendListItem({
          ...input,
          ...this.identity,
          text: row.title,
          source: "todo",
        });
        if (!itemId) throw new Error("Slack did not return an ID while restoring a file-owned todo.");
        if (row.completed) await updateListItem({ ...input, ...this.identity, itemId, completed: true });
        synchronizedRows.push({ ...row, id: itemId });
        continue;
      }
      const title = slackRow.title === row.title ? undefined : row.title;
      const completed = slackRow.completed === row.completed ? undefined : row.completed;
      if (title !== undefined || completed !== undefined) {
        await updateListItem({ ...input, ...this.identity, itemId: row.id, title, completed });
      }
      synchronizedRows.push(row);
    }

    const path = writeFileRows(
      input.channel,
      synchronizedRows,
      fileSnapshot,
      this.options.afterTodoFileSnapshotCheck,
      this.options.afterTodoFileExchange,
    );
    if (!path) return null;
    commitTodoSyncState({
      slackChannelId: input.channel.slack_channel_id,
      baseJson: JSON.stringify(synchronizedRows),
      conflictSignature,
      historicalMigrationComplete: true,
      ignoredSlackItemIds: [...ignoredSlackItemIds].sort(),
      conflictNotice,
    });
    log("info", "todo_sync_complete", {
      channel: input.channel.slack_channel_id,
      path,
      item_count: synchronizedRows.length,
      conflict_count: merged.conflicts.length,
    });
    await this.deliverConflictNotices(input);
    return path;
  }

  private async deliverConflictNotices(input: { client: any; channel: ChannelRow; user?: string | null }) {
    while (true) {
      const notice = claimTodoSyncConflictNotice(
        input.channel.slack_channel_id,
        this.options.ownerInstanceId || `todo-sync:${process.pid}`,
      );
      if (!notice) return;
      try {
        const response: any = await slackCall(input.client, "chat.postMessage", {
          channel: notice.slack_channel_id,
          text: notice.notice_text,
          client_msg_id: notice.client_msg_id,
        }, { channel: notice.slack_channel_id, user: input.user || undefined });
        if (!response?.ts) throw new Error("Slack did not return a timestamp for the TODO conflict notice.");
        await this.persistConflictNoticeAcknowledgement(
          notice.slack_channel_id,
          notice.conflict_signature,
          String(response.ts),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (isTransientSlackError(error) && notice.attempts < 20) {
          const delay = Math.min(1_000 * 2 ** Math.min(notice.attempts, 6), 60_000);
          retryTodoSyncConflictNotice(
            notice.slack_channel_id,
            notice.conflict_signature,
            detail,
            Date.now() + delay,
            this.options.ownerInstanceId || `todo-sync:${process.pid}`,
          );
        } else {
          parkTodoSyncConflictNotice(
            notice.slack_channel_id,
            notice.conflict_signature,
            detail,
            this.options.ownerInstanceId || `todo-sync:${process.pid}`,
          );
          log("error", "todo_sync_conflict_notice_parked", {
            ...errorFields(error),
            channel: notice.slack_channel_id,
            conflict_signature: notice.conflict_signature,
          });
        }
        return;
      }
    }
  }

  private async persistConflictNoticeAcknowledgement(
    slackChannelId: string,
    conflictSignature: string,
    slackMessageTs: string,
  ) {
    const markDelivered = this.options.markConflictNoticeDelivered || markTodoSyncConflictNoticeDelivered;
    const wait = this.options.waitBeforeLocalRetry || ((milliseconds: number) => (
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
    ));
    let attempt = 0;
    while (true) {
      try {
        if (markDelivered(
          slackChannelId,
          conflictSignature,
          slackMessageTs,
          this.options.ownerInstanceId || `todo-sync:${process.pid}`,
        )) return;
        throw new Error("The TODO conflict notice acknowledgement was not committed.");
      } catch (error) {
        attempt += 1;
        log("error", "todo_sync_conflict_notice_ack_retry", {
          ...errorFields(error),
          channel: slackChannelId,
          conflict_signature: conflictSignature,
          attempt,
        });
        await wait(Math.min(100 * 2 ** Math.min(attempt, 6), 5_000));
      }
    }
  }
}
