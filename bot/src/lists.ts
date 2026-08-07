import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ChannelRow, getChannel, updateChannelListState } from "./state";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { isPaidPlanListError, missingScopes, notifyMissingScope, slackErrorCode } from "./slack-errors";

export interface ListState {
  listId: string;
  titleColumnId: string;
  completedColumnId: string | null;
}

export function richText(text: string) {
  return [{
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [{ type: "text", text }],
    }],
  }];
}

export function conciergeListSchema() {
  return [{
    key: "title",
    name: "Task",
    type: "text",
    is_primary_column: true,
  }];
}

function columnId(metadata: any, key: string): string | null {
  const schema = Array.isArray(metadata?.schema) ? metadata.schema : [];
  const column = schema.find((entry: any) => entry?.key === key);
  return typeof column?.id === "string" ? column.id : null;
}

function existingListState(channel: ChannelRow): ListState | null {
  if (!channel.list_id || !channel.list_title_column_id) return null;
  return {
    listId: channel.list_id,
    titleColumnId: channel.list_title_column_id,
    completedColumnId: channel.list_completed_column_id || null,
  };
}

export async function ensureChannelList(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
}): Promise<ListState | null> {
  const current = existingListState(input.channel);
  if (current) return current;

  if (input.channel.list_id && !input.channel.list_title_column_id) {
    log("warn", "list_column_metadata_missing", {
      channel: input.channel.slack_channel_id,
      list_id: input.channel.list_id,
    });
  }

  try {
    const created: any = await slackCall(input.client, "slackLists.create", {
      name: `#${input.channel.slack_channel_name} todos`,
      todo_mode: true,
      schema: conciergeListSchema(),
      description_blocks: richText(`Structured Concierge todos mirrored from ${input.channel.vault_path}/TODOS.md and notes/inbox.md.`),
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    const listId = String(created.list_id || "");
    const titleColumnId = columnId(created.list_metadata, "title");
    const completedColumnId = columnId(created.list_metadata, "todo_completed");
    if (!listId || !titleColumnId) throw new Error("slackLists.create did not return list_id/title column metadata");
    updateChannelListState(input.channel.slack_channel_id, { listId, titleColumnId, completedColumnId });
    log("info", "list_create_done", {
      channel: input.channel.slack_channel_id,
      list_id: listId,
      title_column_id: titleColumnId,
      completed_column_id: completedColumnId,
    });
    try {
      await slackCall(input.client, "slackLists.access.set", {
        list_id: listId,
        access_level: "write",
        channel_ids: [input.channel.slack_channel_id],
      }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
      log("info", "list_access_set_done", {
        channel: input.channel.slack_channel_id,
        list_id: listId,
        access_level: "write",
      });
    } catch (err) {
      if (missingScopes(err).length) {
        await notifyMissingScope({
          client: input.client,
          channel: input.channel.slack_channel_id,
          user: input.user,
          method: "slackLists.access.set",
          err,
        });
      } else {
        log("warn", "list_access_set_failed", {
          channel: input.channel.slack_channel_id,
          list_id: listId,
          ...errorFields(err),
        });
      }
    }
    return { listId, titleColumnId, completedColumnId };
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "slackLists.create",
        err,
      });
      return null;
    }
    log("error", "list_create_failed", {
      channel: input.channel.slack_channel_id,
      ...errorFields(err),
    });
    throw err;
  }
}

export async function appendListItem(input: {
  client: any;
  channel: ChannelRow;
  text: string;
  source: "todo" | "note" | "agent";
  user?: string | null;
}): Promise<string | null> {
  const state = await ensureChannelList(input);
  if (!state) return null;
  const title = input.source === "todo" ? input.text.trim() : `[${input.source}] ${input.text.trim()}`;
  try {
    const created: any = await slackCall(input.client, "slackLists.items.create", {
      list_id: state.listId,
      initial_fields: [{
        column_id: state.titleColumnId,
        rich_text: richText(title),
      }],
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    const itemId = String(created.item?.id || "");
    log("info", "list_item_create_done", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      item_id: itemId || null,
      source: input.source,
    });
    return itemId || null;
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "slackLists.items.create",
        err,
      });
      return null;
    }
    log("error", "list_item_create_failed", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      source: input.source,
      ...errorFields(err),
    });
    throw err;
  }
}

export async function completeListItem(input: {
  client: any;
  channel: ChannelRow;
  itemId: string;
  user?: string | null;
}): Promise<boolean> {
  const state = await ensureChannelList(input);
  if (!state?.completedColumnId) {
    log("error", "list_item_complete_failed", {
      channel: input.channel.slack_channel_id,
      list_id: state?.listId || input.channel.list_id,
      item_id: input.itemId,
      error: "missing_completed_column_id",
    });
    return false;
  }
  try {
    await slackCall(input.client, "slackLists.items.update", {
      list_id: state.listId,
      cells: [{
        row_id: input.itemId,
        column_id: state.completedColumnId,
        checkbox: true,
      }],
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    log("info", "list_item_complete_done", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      item_id: input.itemId,
    });
    return true;
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "slackLists.items.update",
        err,
      });
      return false;
    }
    log("error", "list_item_complete_failed", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      item_id: input.itemId,
      ...errorFields(err),
    });
    throw err;
  }
}

function fieldText(field: any): string {
  if (typeof field?.text === "string") return field.text;
  if (typeof field?.value === "string") return field.value;
  const rich = Array.isArray(field?.rich_text) ? field.rich_text : [];
  const chunks: string[] = [];
  for (const block of rich) {
    for (const element of block.elements || []) {
      for (const leaf of element.elements || []) {
        if (typeof leaf.text === "string") chunks.push(leaf.text);
      }
    }
  }
  return chunks.join("");
}

export function normalizeListItems(items: any[]): Array<{ id: string; title: string; completed: boolean }> {
  return items.map((item) => {
    const fields = Array.isArray(item?.fields) ? item.fields : [];
    const titleField = fields.find((field: any) => ["title", "name", "rich_text_notes"].includes(field?.key)) || fields[0];
    const completedField = fields.find((field: any) => field?.key === "todo_completed");
    return {
      id: String(item?.id || ""),
      title: fieldText(titleField).trim() || "(untitled)",
      completed: Boolean(completedField?.value === true || completedField?.checkbox === true || completedField?.checkbox?.[0] === true),
    };
  }).filter((item) => item.id);
}

export async function listItems(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
}): Promise<Array<{ id: string; title: string; completed: boolean }>> {
  const state = await ensureChannelList(input);
  if (!state) return [];
  try {
    const listed: any = await slackCall(input.client, "slackLists.items.list", {
      list_id: state.listId,
      limit: 100,
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    const items = normalizeListItems(Array.isArray(listed.items) ? listed.items : []);
    log("info", "list_items_read_done", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      count: items.length,
    });
    return items;
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "slackLists.items.list",
        err,
      });
      return [];
    }
    log("error", "list_items_read_failed", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      ...errorFields(err),
    });
    throw err;
  }
}

export function renderListMarkdown(input: {
  channel: ChannelRow;
  items: Array<{ id: string; title: string; completed: boolean }>;
}) {
  const lines = [
    `# #${input.channel.slack_channel_name} Slack List`,
    "",
    `List ID: ${input.channel.list_id || "(not created yet)"}`,
    `Updated: ${new Date().toISOString()}`,
    "",
  ];
  if (input.items.length === 0) {
    lines.push("_No open Slack List items were readable._");
  } else {
    for (const item of input.items) {
      lines.push(`- [${item.completed ? "x" : " "}] ${item.title} <!-- ${item.id} -->`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function writeListMirror(channel: ChannelRow, markdown: string) {
  const base = channel.code_path || channel.vault_path;
  const path = join(base, "notes", "list.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
  return path;
}

export async function refreshListMirror(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
  onPaidPlanError?: (err: unknown) => Promise<void>;
}): Promise<string | null> {
  try {
    const items = await listItems(input);
    const fresh = getChannel(input.channel.slack_channel_id) || input.channel;
    return writeListMirror(fresh, renderListMarkdown({ channel: fresh, items }));
  } catch (err) {
    if (isPaidPlanListError(err)) await input.onPaidPlanError?.(err);
    const fallback = join(input.channel.code_path || input.channel.vault_path, "notes", "list.md");
    if (!existsSync(fallback)) {
      writeListMirror(input.channel, [
        `# #${input.channel.slack_channel_name} Slack List`,
        "",
        `Slack List could not be read: ${slackErrorCode(err)}`,
        "",
      ].join("\n"));
    }
    return null;
  }
}

export function buildListPromptContext(markdown: string | null) {
  const body = markdown?.trim() || "Slack List context is not currently readable.";
  return [
    "Slack List context for this channel:",
    "",
    body,
    "",
    "To ask Concierge to update the Slack List after your turn, put one of these exact lines in your final response:",
    "CONCIERGE_LIST_ADD: <todo text>",
    "CONCIERGE_LIST_COMPLETE: <Slack List row id>",
    "",
    "Slack response format:",
    "Start every final response with `TL;DR:` followed by a concise summary.",
    "After the TL;DR, provide the full detailed response.",
  ].join("\n");
}

export function parseAgentListOps(text: string) {
  const adds: string[] = [];
  const completes: string[] = [];
  const visible: string[] = [];
  for (const line of text.split("\n")) {
    const add = line.match(/^CONCIERGE_LIST_ADD:\s*(.+)$/);
    const complete = line.match(/^CONCIERGE_LIST_COMPLETE:\s*(\S+)$/);
    if (add) adds.push(add[1].trim());
    else if (complete) completes.push(complete[1].trim());
    else visible.push(line);
  }
  return { adds, completes, text: visible.join("\n").trim() };
}
