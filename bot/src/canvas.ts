import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelRow, getChannel, type SlackChannelRow, updateChannelCanvasId } from "./state";
import { errorFields, log } from "./log";
import { canvasSlackCall } from "./rate-limit";
import { missingScopes, notifyMissingScope, slackErrorCode, slackErrorData } from "./slack-errors";

const MAX_CANVAS_MARKDOWN = 1_048_576;
export const MAX_CANVAS_SLACK_DETAIL = 2_000;

type ListContext = { indent: number; kind: "bullet" | "number" };

function isEscaped(text: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function protectInlineCodeSpans(markdown: string) {
  const spans: string[] = [];
  let protectedMarkdown = "";
  let copyFrom = 0;
  let cursor = 0;

  while (cursor < markdown.length) {
    if (markdown[cursor] !== "`" || isEscaped(markdown, cursor)) {
      cursor += 1;
      continue;
    }

    let openingEnd = cursor;
    while (markdown[openingEnd] === "`") openingEnd += 1;
    const openingLength = openingEnd - cursor;
    let closingStart = openingEnd;
    let closingEnd = -1;
    while (closingStart < markdown.length) {
      if (markdown[closingStart] !== "`") {
        closingStart += 1;
        continue;
      }
      let runEnd = closingStart;
      while (markdown[runEnd] === "`") runEnd += 1;
      if (runEnd - closingStart === openingLength) {
        closingEnd = runEnd;
        break;
      }
      // A different-length run makes this an unproven span shape. Leave the
      // opener untouched instead of letting it capture unrelated later lines.
      break;
    }
    if (closingEnd < 0) {
      cursor = openingEnd;
      continue;
    }

    const token = `\u0000CANVAS_CODE_${spans.length}\u0000`;
    protectedMarkdown += markdown.slice(copyFrom, cursor) + token;
    spans.push(markdown.slice(cursor, closingEnd));
    copyFrom = closingEnd;
    cursor = closingEnd;
  }

  protectedMarkdown += markdown.slice(copyFrom);
  return {
    text: protectedMarkdown,
    restore: (text: string) => spans.reduce(
      (restored, span, index) => restored.replaceAll(
        `\u0000CANVAS_CODE_${index}\u0000`,
        () => span,
      ),
      text,
    ),
  };
}

function inlineCodeLabelText(label: string) {
  const match = label.match(/^(`+)([\s\S]*?)\1$/);
  return match?.[2] ?? label;
}

function isRepositoryRelativeLinkTarget(target: string) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return false;
  if (target.startsWith("/") || target.startsWith("#") || target.includes("`")) return false;
  return target === "url"
    || target.startsWith("./")
    || target.startsWith("../")
    || target.includes("/")
    || target.endsWith(".md");
}

function normalizeRelativeLinks(line: string, restoreInlineCode: (text: string) => string) {
  return line.replace(
    /\[([^\]\n]+)\]\(([^()\s<>]+)\)/g,
    (link, protectedLabel: string, target: string, offset: number, completeLine: string) => {
      if (completeLine[offset - 1] === "!" || isEscaped(completeLine, offset)) return link;
      if (!isRepositoryRelativeLinkTarget(target)) return link;
      const label = restoreInlineCode(protectedLabel);
      return inlineCodeLabelText(label) === target ? label : `${label} — \`${target}\``;
    },
  );
}

function fenceMarker(line: string): { marker: "`" | "~"; length: number; trailing: string } | null {
  const match = line.match(/(`{3,}|~{3,})/);
  if (!match) return null;
  let prefix = line.slice(0, match.index);
  while (prefix.length > 0) {
    const whitespace = prefix.match(/^[ \t]+/);
    if (whitespace) {
      prefix = prefix.slice(whitespace[0].length);
      continue;
    }
    const quote = prefix.match(/^>[ \t]?/);
    if (quote) {
      prefix = prefix.slice(quote[0].length);
      continue;
    }
    const listItem = prefix.match(/^(?:\d+[.)]|[-+*])[ \t]+/);
    if (listItem) {
      prefix = prefix.slice(listItem[0].length);
      continue;
    }
    return null;
  }
  return {
    marker: match[1][0] as "`" | "~",
    length: match[1].length,
    trailing: line.slice((match.index || 0) + match[1].length),
  };
}

function protectFencedCodeBlocks(markdown: string) {
  const lines = markdown.split("\n");
  const spans: string[] = [];
  const protectedLines: string[] = [];
  let cursor = 0;

  while (cursor < lines.length) {
    const opening = fenceMarker(lines[cursor]);
    if (!opening) {
      protectedLines.push(lines[cursor]);
      cursor += 1;
      continue;
    }

    let closing = cursor + 1;
    while (closing < lines.length) {
      const candidate = fenceMarker(lines[closing]);
      if (candidate
        && candidate.marker === opening.marker
        && candidate.length >= opening.length
        && candidate.trailing.trim() === "") break;
      closing += 1;
    }
    if (closing >= lines.length) closing = lines.length - 1;

    const token = `\u0000CANVAS_FENCE_${spans.length}\u0000`;
    spans.push(lines.slice(cursor, closing + 1).join("\n"));
    protectedLines.push(token);
    cursor = closing + 1;
  }

  return {
    text: protectedLines.join("\n"),
    restore: (text: string) => spans.reduce(
      (restored, span, index) => restored.replaceAll(
        `\u0000CANVAS_FENCE_${index}\u0000`,
        () => span,
      ),
      text,
    ),
  };
}

export function normalizeCanvasMarkdown(markdown: string) {
  const protectedFences = protectFencedCodeBlocks(markdown);
  const protectedInlineCode = protectInlineCodeSpans(protectedFences.text);
  const listStack: ListContext[] = [];
  let projectedQuoteIndent: number | null = null;

  const normalized = protectedInlineCode.text.split("\n").map((line) => {
    const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
    if (line.trim() && leadingSpaces >= 4 && listStack.length === 0) {
      projectedQuoteIndent = null;
      return line;
    }

    const listItem = line.match(/^( *)(\d+[.)]|[-+*])([ \t]+)(.*)$/);
    if (listItem) {
      projectedQuoteIndent = null;
      const indent = listItem[1].length;
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
      const kind = /^\d/.test(listItem[2]) ? "number" : "bullet";
      const parent = listStack[listStack.length - 1];
      const projected = kind === "bullet" && parent?.kind === "number"
        ? `${listItem[1]}• ${listItem[4]}`
        : line;
      listStack.push({ indent, kind });
      return normalizeRelativeLinks(projected, protectedInlineCode.restore);
    }

    const projectedQuote = line.match(/^( *)↳(?:[ \t]?)(.*)$/);
    if (projectedQuote) {
      const indent = projectedQuote[1].length;
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
      if (listStack.length) {
        projectedQuoteIndent = indent;
        return normalizeRelativeLinks(line, protectedInlineCode.restore);
      }
    }

    const quote = line.match(/^( *)>(?:[ \t]?)(.*)$/);
    if (quote) {
      const indent = quote[1].length;
      if (projectedQuoteIndent !== null && indent > projectedQuoteIndent) return line;
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop();
      if (listStack.length) {
        projectedQuoteIndent = indent;
        return normalizeRelativeLinks(`${quote[1]}↳ ${quote[2]}`, protectedInlineCode.restore);
      }
      projectedQuoteIndent = null;
      return normalizeRelativeLinks(line, protectedInlineCode.restore);
    }

    projectedQuoteIndent = null;
    if (line.trim()) {
      while (listStack.length && listStack[listStack.length - 1].indent >= leadingSpaces) listStack.pop();
    }
    return normalizeRelativeLinks(line, protectedInlineCode.restore);
  }).join("\n");
  return protectedFences.restore(protectedInlineCode.restore(normalized));
}

export function canvasSlackErrorFields(err: unknown) {
  const detail = slackErrorData(err).detail;
  return typeof detail === "string" && detail.length > 0
    ? { slack_detail: detail.slice(0, MAX_CANVAS_SLACK_DETAIL) }
    : {};
}

export function agentsPath(channel: Pick<ChannelRow, "code_path" | "vault_path">) {
  return join(channel.code_path || channel.vault_path, "AGENTS.md");
}

export function agentsFingerprint(channel: Pick<ChannelRow, "code_path" | "vault_path">): string | null {
  const path = agentsPath(channel);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  return createHash("sha256").update(path).update("\0").update(text).digest("hex");
}

export function buildAgentsCanvasMarkdown(input: {
  channelName: string;
  sourcePath?: string | null;
  agentsText: string;
}) {
  // Slack Canvas is a compatibility projection of canonical AGENTS.md.
  // The title is already visible in Slack, so the only wrapper is a footer.
  const source = input.agentsText.trim() || "_AGENTS.md is empty. Edit the canonical file on disk to populate it._";
  const body = normalizeCanvasMarkdown(source);
  const footer = `\n\n---\n_Synced from ${input.sourcePath || "AGENTS.md"} at ${new Date().toISOString()}_\n`;
  const markdown = `${body}${footer}`;
  return markdown.length <= MAX_CANVAS_MARKDOWN
    ? markdown
    : `${markdown.slice(0, MAX_CANVAS_MARKDOWN - 80)}\n\n_Trimmed by Concierge: Canvas API document_content limit reached._\n`;
}

export function buildAgentsCanvasPayload(channel: Pick<ChannelRow, "slack_channel_name" | "code_path" | "vault_path">) {
  const path = agentsPath(channel);
  const agentsText = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return {
    // Title = file name (parity with source-of-truth on disk).
    title: `AGENTS.md`,
    document_content: {
      type: "markdown",
      markdown: buildAgentsCanvasMarkdown({
        channelName: channel.slack_channel_name,
        sourcePath: path,
        agentsText,
      }),
    },
  };
}

type CanvasSyncResult =
  | { ok: true; canvasId: string; operation: "create" | "update" }
  | { ok: false; error: string };

const canvasSyncTails = new Map<string, Promise<void>>();

async function serializeCanvasSync<T>(channelId: string, sync: () => Promise<T>): Promise<T> {
  const prior = canvasSyncTails.get(channelId) || Promise.resolve();
  const result = prior.catch(() => {}).then(sync);
  const tail = result.then(() => {}, () => {});
  canvasSyncTails.set(channelId, tail);
  try {
    return await result;
  } finally {
    if (canvasSyncTails.get(channelId) === tail) canvasSyncTails.delete(channelId);
  }
}

export async function syncAgentsCanvas(input: {
  client: any;
  channel: SlackChannelRow;
  user?: string | null;
  reason: string;
}): Promise<CanvasSyncResult> {
  const channelId = input.channel.slack_channel_id;
  return await serializeCanvasSync(channelId, async () => await performCanvasSync({
    ...input,
    channel: getChannel(channelId) || input.channel,
  }));
}

export function scheduleAgentsCanvasRefreshIfChanged(input: {
  client: any;
  channel: ChannelRow | null;
  user: string | null;
  before: string | null;
  reason: string;
  fingerprint?: typeof agentsFingerprint;
  sync?: typeof syncAgentsCanvas;
}) {
  if (!input.channel) return;
  const channel = input.channel;
  const reportFailure = (error: unknown) => {
    log("error", "turn_canvas_refresh_schedule_failed", {
      channel: channel.slack_channel_id,
      reason: input.reason,
      ...errorFields(error),
      ...canvasSlackErrorFields(error),
    });
  };

  try {
    const after = (input.fingerprint || agentsFingerprint)(channel);
    if (!after || after === input.before) return;
    const fresh = getChannel(channel.slack_channel_id) || channel;
    const refresh = (input.sync || syncAgentsCanvas)({
      client: input.client,
      channel: fresh,
      user: input.user,
      reason: input.reason,
    });
    void refresh.catch(reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

async function performCanvasSync(input: {
  client: any;
  channel: SlackChannelRow;
  user?: string | null;
  reason: string;
}): Promise<CanvasSyncResult> {
  const payload = buildAgentsCanvasPayload(input.channel);
  const context = { channel: input.channel.slack_channel_id, user: input.user || undefined };
  log("info", "canvas_sync_started", {
    channel: input.channel.slack_channel_id,
    canvas_id: input.channel.canvas_id,
    reason: input.reason,
    markdown_chars: payload.document_content.markdown.length,
  });

  // Idempotency guard: before creating, check if the channel already has a
  // canvas tab pinned (from a prior run whose state.db was reset, or a
  // manual create). If so, adopt that canvas_id instead of creating a
  // duplicate. Fixes the "3 canvases per channel" bug after any state.db
  // canvas_id reset + restart cycle.
  if (!input.channel.canvas_id) {
    try {
      const info: any = await canvasSlackCall(input.client, "conversations.info", {
        channel: input.channel.slack_channel_id,
      }, context);
      const tabs = info?.channel?.properties?.tabs || [];
      const canvasTabs = tabs.filter((t: any) => t?.type === "canvas");
      if (canvasTabs.length > 0) {
        // Adopt the first canvas tab as ours
        const adopted = canvasTabs[0].data?.file_id;
        if (adopted) {
          updateChannelCanvasId(input.channel.slack_channel_id, adopted);
          (input.channel as any).canvas_id = adopted;
          log("info", "canvas_adopted_existing_tab", {
            channel: input.channel.slack_channel_id,
            canvas_id: adopted,
            existing_tab_count: canvasTabs.length,
          });
        }
        // If there are additional tabs, they're duplicates — delete them so
        // there's exactly one canvas per channel.
        for (const extra of canvasTabs.slice(1)) {
          const fid = extra.data?.file_id;
          if (fid) {
            try {
              await canvasSlackCall(input.client, "canvases.delete", { canvas_id: fid }, context);
              log("info", "canvas_duplicate_deleted", {
                channel: input.channel.slack_channel_id,
                deleted_canvas_id: fid,
              });
            } catch {}
          }
        }
      }
    } catch {}
  }

  if (input.channel.canvas_id) {
    try {
      await canvasSlackCall(input.client, "canvases.edit", {
        canvas_id: input.channel.canvas_id,
        changes: [{
          operation: "replace",
          document_content: payload.document_content,
        }],
      }, context);
      log("info", "canvas_update_done", {
        channel: input.channel.slack_channel_id,
        canvas_id: input.channel.canvas_id,
        reason: input.reason,
      });
      return { ok: true, canvasId: input.channel.canvas_id, operation: "update" };
    } catch (err) {
      if (missingScopes(err).length) {
        await notifyMissingScope({
          client: input.client,
          channel: input.channel.slack_channel_id,
          user: input.user,
          method: "canvases.edit",
          err,
        });
        return { ok: false, error: slackErrorCode(err) };
      }
      const code = slackErrorCode(err);
      if (!["canvas_not_found", "canvas_deleted"].includes(code)) {
        log("error", "canvas_update_failed", {
          channel: input.channel.slack_channel_id,
          canvas_id: input.channel.canvas_id,
          reason: input.reason,
          ...errorFields(err),
          ...canvasSlackErrorFields(err),
        });
        return { ok: false, error: code };
      }
      updateChannelCanvasId(input.channel.slack_channel_id, null);
      log("warn", "canvas_stale_id_recreating", {
        channel: input.channel.slack_channel_id,
        canvas_id: input.channel.canvas_id,
        reason: input.reason,
        error: code,
      });
    }
  }

  try {
    const created: any = await canvasSlackCall(input.client, "conversations.canvases.create", {
      channel_id: input.channel.slack_channel_id,
      title: payload.title,
      document_content: payload.document_content,
    }, context);
    const canvasId = String(created.canvas_id || "");
    if (!canvasId) throw new Error("conversations.canvases.create did not return canvas_id");
    updateChannelCanvasId(input.channel.slack_channel_id, canvasId);
    log("info", "canvas_create_done", {
      channel: input.channel.slack_channel_id,
      canvas_id: canvasId,
      reason: input.reason,
    });
    return { ok: true, canvasId, operation: "create" };
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "conversations.canvases.create",
        err,
      });
      return { ok: false, error: slackErrorCode(err) };
    }
    log("error", "canvas_create_failed", {
      channel: input.channel.slack_channel_id,
      reason: input.reason,
      ...errorFields(err),
      ...canvasSlackErrorFields(err),
    });
    return { ok: false, error: slackErrorCode(err) };
  }
}

export async function lookupCanvasSections(input: { client: any; canvasId: string; containsText: string }) {
  return await canvasSlackCall(input.client, "canvases.sections.lookup", {
    canvas_id: input.canvasId,
    criteria: { contains_text: input.containsText },
  });
}

export async function syncAllAgentsCanvases(input: {
  channels: SlackChannelRow[];
  requireSuccess: boolean;
  sync: (channel: SlackChannelRow) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const failures: Array<{ channel: string; error: string }> = [];
  for (const channel of input.channels) {
    const result = await input.sync(channel);
    if (!result.ok) failures.push({ channel: channel.slack_channel_id, error: result.error });
  }
  if (input.requireSuccess && failures.length > 0) {
    throw new Error(`Required Canvas refresh failed: ${JSON.stringify(failures)}`);
  }
  return { refreshed: input.channels.length - failures.length, failures };
}

export async function startRuntimeWithCanvasRefresh(input: {
  requireCanvasRefresh: boolean;
  refreshCanvases: () => Promise<void>;
  startRuntime: () => Promise<void>;
  reportBackgroundRefreshError: (error: unknown) => void;
}) {
  if (input.requireCanvasRefresh) {
    await input.refreshCanvases();
    await input.startRuntime();
    return;
  }

  await input.startRuntime();
  void input.refreshCanvases().catch(input.reportBackgroundRefreshError);
}
