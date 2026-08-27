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
  ensureChannelList,
  listItems,
  updateListItem,
} from "./lists";
import { log } from "./log";
import {
  commitTodoSyncState,
  getChannel,
  getTodoSyncState,
  type ChannelRow,
} from "./state";
import {
  normalizeTodoBody,
  parseTodoMetadata,
  renderTodoItemContents,
  todoContinuationContent,
} from "./todo-markdown";

export interface TodoRow {
  id: string;
  title: string;
  completed: boolean;
}

export interface TodoProjection {
  rows: TodoRow[];
  deleteSlackIds: string[];
}

interface TodoSyncIdentity {
  identitySecret: string;
  identityOwnerId: string;
}

interface TodoSyncOptions {
  afterTodoFileSnapshotCheck?(path: string): void;
  afterTodoFileExchange?(path: string): void;
}

interface ParsedTodoLine {
  lineIndex: number;
  endLineIndex: number;
  indent: string;
  captureMarker?: string;
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
  const lines = markdownLines(markdown);
  let localIndex = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let htmlBlock: "comment" | "raw" | "blank" | null = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].content;
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
    const inlineMarker = match[3].match(/\s*<!--\s*(Rec[A-Za-z0-9]+)\s*-->\s*$/);
    let rowId = inlineMarker?.[1];
    let captureMarker = match[3].match(/<!--\s*concierge-capture-v1:[a-f0-9]{64}\s*-->/i)?.[0];
    const firstParagraph = match[3]
      .replace(/\s*<!--\s*Rec[A-Za-z0-9]+\s*-->\s*$/, "")
      .replace(/\s*<!--\s*concierge-capture-v1:[^>]+-->\s*$/, "");
    const bodyParts = [firstParagraph];
    let endLineIndex = lineIndex;
    let cursor = lineIndex + 1;
    const metadata = cursor < lines.length ? parseTodoMetadata(lines[cursor].content) : null;
    if (metadata) {
      rowId ||= metadata.rowId;
      captureMarker ||= metadata.captureMarker;
      endLineIndex = cursor;
      cursor += 1;
    }
    while (cursor < lines.length) {
      const continuation = todoContinuationContent(lines[cursor].content);
      if (continuation !== null) {
        bodyParts.push(continuation);
        endLineIndex = cursor;
        cursor += 1;
        continue;
      }
      if (lines[cursor].content !== "") break;
      let continuationIndex = cursor + 1;
      while (continuationIndex < lines.length && lines[continuationIndex].content === "") {
        continuationIndex += 1;
      }
      if (
        continuationIndex >= lines.length
        || todoContinuationContent(lines[continuationIndex].content) === null
      ) break;
      bodyParts.push("");
      endLineIndex = continuationIndex - 1;
      cursor = continuationIndex;
    }
    const title = normalizeTodoBody(bodyParts.join("\n"));
    if (!title) continue;
    rows.push({
      lineIndex,
      endLineIndex,
      indent: match[1],
      captureMarker,
      row: {
        id: rowId || `local:${localIndex++}`,
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

function renderTodoRow(row: TodoRow, indent = "", captureMarker?: string) {
  return renderTodoItemContents({
    title: row.title,
    completed: row.completed,
    rowId: row.id,
    captureMarker,
  }).map((line) => `${indent}${line}`);
}

export function renderTodosMarkdown(channel: ChannelRow, rows: TodoRow[], existingMarkdown = "") {
  if (!existingMarkdown) {
    return [
      `# #${channel.slack_channel_name} todos`,
      "",
      ...rows.flatMap((row) => renderTodoRow(row)),
      "",
    ].join("\n");
  }

  const lines = markdownLines(existingMarkdown);
  const parsedLines = parseTodoLines(existingMarkdown);
  const desiredById = new Map(rows.map((row) => [row.id, row]));
  const consumedIds = new Set<string>();

  const replacements: Array<{ start: number; end: number; contents: string[] }> = [];
  for (const parsed of parsedLines) {
    let desired = parsed.row.id.startsWith("local:") ? undefined : desiredById.get(parsed.row.id);
    if (!desired) {
      desired = rows.find((candidate) => (
        !consumedIds.has(candidate.id)
        && normalizeTitle(candidate.title).toLowerCase() === normalizeTitle(parsed.row.title).toLowerCase()
      ));
    }
    if (!desired) {
      replacements.push({ start: parsed.lineIndex, end: parsed.endLineIndex, contents: [] });
      continue;
    }
    consumedIds.add(desired.id);
    replacements.push({
      start: parsed.lineIndex,
      end: parsed.endLineIndex,
      contents: renderTodoRow(desired, parsed.indent, parsed.captureMarker),
    });
  }

  const preferredEnding = lines.find((line) => line.ending)?.ending || "\n";
  for (const replacement of replacements.reverse()) {
    const finalEnding = lines[replacement.end]?.ending || "";
    const replacementLines = replacement.contents.map((content, index) => ({
      content,
      ending: index === replacement.contents.length - 1 ? finalEnding : preferredEnding,
    }));
    lines.splice(replacement.start, replacement.end - replacement.start + 1, ...replacementLines);
  }

  const additions = rows
    .filter((row) => !consumedIds.has(row.id))
    .flatMap((row) => renderTodoRow(row));
  if (additions.length > 0) {
    if (lines.length && !lines.at(-1)!.ending) lines.at(-1)!.ending = preferredEnding;
    if (lines.length && lines.at(-1)!.content !== "") {
      lines.push({ content: "", ending: preferredEnding });
    }
    for (const addition of additions) lines.push({ content: addition, ending: preferredEnding });
  }
  return lines.map((line) => `${line.content}${line.ending}`).join("");
}

export function projectTodoRows(fileRows: TodoRow[], slackRows: TodoRow[]): TodoProjection {
  const desiredIds = new Set(fileRows.map((row) => row.id));
  return {
    rows: fileRows,
    deleteSlackIds: slackRows
      .filter((row) => !desiredIds.has(row.id))
      .map((row) => row.id),
  };
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

export class TodoProjectionManager {
  private readonly pendingByChannel = new Map<string, Promise<string | null>>();

  constructor(
    private readonly identity: TodoSyncIdentity,
    private readonly options: TodoSyncOptions = {},
  ) {}

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
    const syncState = getTodoSyncState(input.channel.slack_channel_id);
    const baseRows = parseBase(input.channel.slack_channel_id);
    let fileRows = parseTodosMarkdown(fileSnapshot.markdown);
    const ignoredSlackItemIds = parseIgnoredSlackItemIds(input.channel.slack_channel_id);
    const currentChannel = getChannel(input.channel.slack_channel_id) || input.channel;
    const fileMatchesProjection = fileRows.length === baseRows.length
      && fileRows.every((row, index) => sameRow(row, baseRows[index]) && row.id === baseRows[index]?.id);

    if (fileMatchesProjection && syncState?.historical_migration_complete) {
      if (renderTodosMarkdown(currentChannel, fileRows, fileSnapshot.markdown) !== fileSnapshot.markdown) {
        const migratedPath = writeFileRows(
          input.channel,
          fileRows,
          fileSnapshot,
          this.options.afterTodoFileSnapshotCheck,
          this.options.afterTodoFileExchange,
        );
        if (!migratedPath) return null;
        log("info", "todo_projection_markdown_migrated", {
          channel: input.channel.slack_channel_id,
          item_count: fileRows.length,
        });
        return migratedPath;
      }
      if (!currentChannel.list_id || currentChannel.list_access_level !== "read") {
        await ensureChannelList({
          ...input,
          channel: currentChannel,
          ...this.identity,
        });
      }
      log("info", "todo_projection_unchanged", {
        channel: input.channel.slack_channel_id,
        item_count: fileRows.length,
      });
      return todoPath(input.channel);
    }

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
    for (const row of fileRows) {
      if (!row.id.startsWith("local:")) ignoredSlackItemIds.delete(row.id);
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

    const projection = projectTodoRows(fileRows, slackRows);
    for (const itemId of projection.deleteSlackIds) {
      await deleteListItem({ ...input, ...this.identity, itemId });
    }

    const slackById = new Map(slackRows.map((row) => [row.id, row]));
    const synchronizedRows: TodoRow[] = [];
    for (const row of projection.rows) {
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
      conflictSignature: null,
      historicalMigrationComplete: true,
      ignoredSlackItemIds: [...ignoredSlackItemIds].sort(),
    });
    log("info", "todo_projection_complete", {
      channel: input.channel.slack_channel_id,
      path,
      item_count: synchronizedRows.length,
    });
    return path;
  }
}
