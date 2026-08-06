import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChannelRow, updateChannelCanvasId } from "./state";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { missingScopes, notifyMissingScope, slackErrorCode } from "./slack-errors";

const MAX_CANVAS_MARKDOWN = 1_048_576;

export function agentsPath(channel: Pick<ChannelRow, "vault_path">) {
  return join(channel.vault_path, "AGENTS.md");
}

export function agentsFingerprint(channel: Pick<ChannelRow, "vault_path">): string | null {
  const path = agentsPath(channel);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf-8");
  return createHash("sha256").update(text).digest("hex");
}

export function buildAgentsCanvasMarkdown(input: {
  channelName: string;
  codePath?: string | null;
  agentsText: string;
}) {
  const header = [
    `# #${input.channelName} instructions`,
    "",
    `Source: AGENTS.md`,
    input.codePath ? `Working directory: \`${input.codePath}\`` : null,
    `Rendered by Concierge at ${new Date().toISOString()}`,
    "",
    "---",
    "",
  ].filter(Boolean).join("\n");
  const markdown = `${header}${input.agentsText.trim() || "_AGENTS.md is empty._"}\n`;
  return markdown.length <= MAX_CANVAS_MARKDOWN
    ? markdown
    : `${markdown.slice(0, MAX_CANVAS_MARKDOWN - 80)}\n\n_Trimmed by Concierge: Canvas API document_content limit reached._\n`;
}

export function buildAgentsCanvasPayload(channel: Pick<ChannelRow, "slack_channel_name" | "code_path" | "vault_path">) {
  const path = agentsPath(channel);
  const agentsText = existsSync(path) ? readFileSync(path, "utf-8") : "";
  return {
    title: `#${channel.slack_channel_name} instructions`,
    document_content: {
      type: "markdown",
      markdown: buildAgentsCanvasMarkdown({
        channelName: channel.slack_channel_name,
        codePath: channel.code_path,
        agentsText,
      }),
    },
  };
}

export async function syncAgentsCanvas(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
  reason: string;
}): Promise<{ ok: true; canvasId: string; operation: "create" | "update" } | { ok: false; error: string }> {
  const payload = buildAgentsCanvasPayload(input.channel);
  const context = { channel: input.channel.slack_channel_id, user: input.user || undefined };
  log("info", "canvas_sync_started", {
    channel: input.channel.slack_channel_id,
    canvas_id: input.channel.canvas_id,
    reason: input.reason,
    markdown_chars: payload.document_content.markdown.length,
  });

  if (input.channel.canvas_id) {
    try {
      await slackCall(input.client, "canvases.edit", {
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
    const created: any = await slackCall(input.client, "conversations.canvases.create", {
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
    });
    return { ok: false, error: slackErrorCode(err) };
  }
}

export async function lookupCanvasSections(input: { client: any; canvasId: string; containsText: string }) {
  return await slackCall(input.client, "canvases.sections.lookup", {
    canvas_id: input.canvasId,
    criteria: { contains_text: input.containsText },
  });
}

