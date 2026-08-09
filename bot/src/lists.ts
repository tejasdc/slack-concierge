import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import {
  beginChannelListCreationIntent,
  ChannelListCreationIntent,
  ChannelRow,
  clearChannelListState,
  getChannel,
  updateChannelListState,
} from "./state";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import {
  isPaidPlanListError,
  isTransientSlackError,
  missingScopes,
  notifyMissingScope,
  slackErrorCode,
} from "./slack-errors";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";

export interface ListState {
  listId: string;
  titleColumnId: string;
  completedColumnId: string | null;
}

interface ListIdentityInput {
  identitySecret: string;
  identityOwnerId: string;
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

export function slackMessageSourceUrl(channel: string, messageTs: string, teamId?: string) {
  const compactTs = messageTs.replace(/\D/g, "");
  return teamId
    ? `https://app.slack.com/client/${teamId}/${channel}/thread-${channel}-${compactTs}`
    : `https://slack.com/archives/${channel}/p${compactTs}`;
}

function sourcedRichText(text: string, authenticatedSourceUrl: string) {
  return [{
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [
        { type: "text", text },
        { type: "text", text: " " },
        { type: "link", url: authenticatedSourceUrl, text: "↗" },
      ],
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

function listName(channel: ChannelRow) {
  return `#${channel.slack_channel_name} todos`;
}

function listIdentityMarker(
  channel: ChannelRow,
  listId: string,
  intentId: string,
  identitySecret: string,
) {
  if (!identitySecret) throw new Error("Slack List reconciliation requires an authentication secret.");
  const signature = createHmac("sha256", identitySecret)
    .update(JSON.stringify(["slack-concierge:list:v3", channel.slack_channel_id, listId, intentId]))
    .digest("hex");
  return `Concierge channel list v3: ${channel.slack_channel_id}:${listId}:${intentId}:${signature}`;
}

function pendingListIdentityMarker(
  channel: ChannelRow,
  intentId: string,
  identitySecret: string,
) {
  if (!identitySecret) throw new Error("Slack List reconciliation requires an authentication secret.");
  const signature = createHmac("sha256", identitySecret)
    .update(JSON.stringify(["slack-concierge:list-pending:v3", channel.slack_channel_id, intentId]))
    .digest("hex");
  return `Concierge channel list pending v3: ${channel.slack_channel_id}:${intentId}:${signature}`;
}

function listDescription(channel: ChannelRow, listId: string, intentId: string, identitySecret: string) {
  return `${listIdentityMarker(channel, listId, intentId, identitySecret)}\nStructured Concierge todos mirrored from ${channel.vault_path}/TODOS.md and notes/inbox.md.`;
}

function pendingListDescription(channel: ChannelRow, intentId: string, identitySecret: string) {
  return `${pendingListIdentityMarker(channel, intentId, identitySecret)}\nConcierge is initializing the structured todo mirror for #${channel.slack_channel_name}.`;
}

function authenticatedListItemSourceUrl(input: {
  channel: ChannelRow;
  listId: string;
  source: "todo" | "note" | "agent";
  title: string;
  sourceUrl: string;
  identitySecret: string;
  }) {
  if (!input.identitySecret) throw new Error("Slack List item reconciliation requires an authentication secret.");
  const signature = createHmac("sha256", input.identitySecret)
    .update(JSON.stringify([
      "slack-concierge:list-item:v1",
      input.channel.slack_channel_id,
      input.listId,
      input.source,
      input.sourceUrl,
      input.title,
    ]))
    .digest("hex");
  return `${input.sourceUrl}#concierge-v1-${signature}`;
}

function richTextPlainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richTextPlainText).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return `${richTextPlainText(record.text)}${richTextPlainText(record.elements)}`;
}

function containsExactLink(value: unknown, expectedUrl: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsExactLink(entry, expectedUrl));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "link" && record.url === expectedUrl) return true;
  return Object.values(record).some((entry) => containsExactLink(entry, expectedUrl));
}

function isAuthenticatedListItem(input: {
  item: any;
  state: ListState;
  title: string;
  authenticatedSourceUrl: string;
  identityOwnerId: string;
}) {
  if (input.item?.created_by !== input.identityOwnerId) return false;
  const fields = Array.isArray(input.item?.fields) ? input.item.fields : [];
  return fields.some((field: any) => {
    const isTitleField = field?.column_id === input.state.titleColumnId || field?.key === "title";
    if (!isTitleField || !containsExactLink(field?.rich_text, input.authenticatedSourceUrl)) return false;
    return richTextPlainText(field?.rich_text).startsWith(input.title);
  });
}

function discoveredListState(file: any): ListState | null {
  const listId = typeof file?.id === "string" ? file.id : "";
  const titleColumnId = columnId(file?.list_metadata, "title");
  if (!listId || !titleColumnId) return null;
  return {
    listId,
    titleColumnId,
    completedColumnId: columnId(file?.list_metadata, "todo_completed"),
  };
}

interface DiscoveredList {
  state: ListState;
  intentId: string;
  finalized: boolean;
}

function creationIntent(channel: ChannelRow): ChannelListCreationIntent | null {
  return channel.list_creation_intent_id && channel.list_creation_started_at_ms
    ? { id: channel.list_creation_intent_id, startedAtMs: channel.list_creation_started_at_ms }
    : null;
}

function finalizedListIntent(input: {
  descriptionLines: string[];
  channel: ChannelRow;
  listId: string;
  identitySecret: string;
}): string | null {
  const prefix = `Concierge channel list v3: ${input.channel.slack_channel_id}:${input.listId}:`;
  for (const line of input.descriptionLines) {
    if (!line.startsWith(prefix)) continue;
    const suffix = line.slice(prefix.length);
    const separator = suffix.lastIndexOf(":");
    if (separator <= 0) continue;
    const intentId = suffix.slice(0, separator);
    if (line === listIdentityMarker(input.channel, input.listId, intentId, input.identitySecret)) return intentId;
  }
  return null;
}

function listHasVisibleShares(file: any) {
  const channelCollections = [file?.channels, file?.groups, file?.ims];
  if (channelCollections.some((collection) => Array.isArray(collection) && collection.length > 0)) return true;
  const shares = file?.shares;
  if (!shares || typeof shares !== "object") return false;
  return Object.values(shares).some((collection) => (
    collection && typeof collection === "object" && Object.keys(collection as object).length > 0
  ));
}

async function discoverChannelList(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
  intent: ChannelListCreationIntent | null;
} & ListIdentityInput): Promise<DiscoveredList | null> {
  if (!input.identityOwnerId) throw new Error("Slack List reconciliation requires the authenticated bot owner ID.");
  const candidates: Array<{ file: any; discovered: DiscoveredList }> = [];
  let page = 1;
  let pages = 1;
  do {
    const listed: any = await slackCall(input.client, "files.list", {
      count: 100,
      page,
      types: "all",
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    for (const file of Array.isArray(listed.files) ? listed.files : []) {
      if (file?.filetype !== "list" && file?.mimetype !== "application/vnd.slack-list") continue;
      if (file?.user !== input.identityOwnerId) continue;
      const state = discoveredListState(file);
      if (!state) continue;
      const descriptionLines = richTextPlainText(file?.list_metadata?.description_blocks).split(/\r?\n/);
      const finalizedIntentId = finalizedListIntent({
        descriptionLines,
        channel: input.channel,
        listId: state.listId,
        identitySecret: input.identitySecret,
      });
      if (finalizedIntentId && (!input.intent || finalizedIntentId === input.intent.id)) {
        candidates.push({ file, discovered: { state, intentId: finalizedIntentId, finalized: true } });
        continue;
      }
      if (!input.intent) continue;
      const createdAtMs = Number(file?.created || 0) * 1_000;
      const createdAfterIntent = createdAtMs >= input.intent.startedAtMs - 1_000;
      const pendingMarker = pendingListIdentityMarker(input.channel, input.intent.id, input.identitySecret);
      if (createdAfterIntent && !listHasVisibleShares(file) && descriptionLines.includes(pendingMarker)) {
        candidates.push({
          file,
          discovered: { state, intentId: input.intent.id, finalized: false },
        });
      }
    }
    pages = Math.max(1, Number(listed.paging?.pages) || 1);
    page += 1;
  } while (page <= pages);

  candidates.sort((left, right) => {
    const createdDelta = Number(left.file?.created || 0) - Number(right.file?.created || 0);
    return createdDelta || String(left.file?.id || "").localeCompare(String(right.file?.id || ""));
  });
  return candidates.length ? candidates[0].discovered : null;
}

async function persistChannelListState(channelId: string, state: ListState) {
  const persisted = await retryTransientDatabaseOperation({
    operation: () => updateChannelListState(channelId, {
      listId: state.listId,
      titleColumnId: state.titleColumnId,
      completedColumnId: state.completedColumnId,
    }),
  });
  if (persisted.stopped) throw new Error("Slack List state persistence stopped.");
}

async function shareChannelList(input: {
  client: any;
  channel: ChannelRow;
  state: ListState;
  user?: string | null;
}) {
  try {
    await slackCall(input.client, "slackLists.access.set", {
      list_id: input.state.listId,
      access_level: "write",
      channel_ids: [input.channel.slack_channel_id],
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    log("info", "list_access_set_done", {
      channel: input.channel.slack_channel_id,
      list_id: input.state.listId,
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
        list_id: input.state.listId,
        ...errorFields(err),
      });
    }
    if (isTransientSlackError(err)) throw err;
  }
}

const pendingChannelListEnsures = new Map<string, Promise<ListState | null>>();

export async function ensureChannelList(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
} & ListIdentityInput): Promise<ListState | null> {
  const channelId = input.channel.slack_channel_id;
  const pending = pendingChannelListEnsures.get(channelId);
  if (pending) return pending;
  const task = ensureChannelListOnce(input).finally(() => {
    if (pendingChannelListEnsures.get(channelId) === task) pendingChannelListEnsures.delete(channelId);
  });
  pendingChannelListEnsures.set(channelId, task);
  return task;
}

async function reconcileDiscoveredChannelList(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
  discovered: DiscoveredList;
} & ListIdentityInput) {
  if (!input.discovered.finalized) {
    await slackCall(input.client, "slackLists.update", {
      id: input.discovered.state.listId,
      description_blocks: richText(listDescription(
        input.channel,
        input.discovered.state.listId,
        input.discovered.intentId,
        input.identitySecret,
      )),
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
  }
  await persistChannelListState(input.channel.slack_channel_id, input.discovered.state);
  log("info", "list_reconciled", {
    channel: input.channel.slack_channel_id,
    list_id: input.discovered.state.listId,
    title_column_id: input.discovered.state.titleColumnId,
    completed_column_id: input.discovered.state.completedColumnId,
  });
  await shareChannelList({ ...input, state: input.discovered.state });
  return input.discovered.state;
}

async function ensureChannelListOnce(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
} & ListIdentityInput): Promise<ListState | null> {
  const persistedChannel = getChannel(input.channel.slack_channel_id) || input.channel;
  const current = existingListState(persistedChannel);
  if (current) {
    await shareChannelList({ ...input, channel: persistedChannel, state: current });
    return current;
  }

  if (persistedChannel.list_id && !persistedChannel.list_title_column_id) {
    log("warn", "list_column_metadata_missing", {
      channel: persistedChannel.slack_channel_id,
      list_id: persistedChannel.list_id,
    });
  }

  try {
    let intent = creationIntent(persistedChannel);
    let discovered = await discoverChannelList({ ...input, channel: persistedChannel, intent });
    if (discovered) {
      return await reconcileDiscoveredChannelList({ ...input, channel: persistedChannel, discovered });
    }
    if (!intent) {
      const started = await retryTransientDatabaseOperation({
        operation: () => beginChannelListCreationIntent(persistedChannel.slack_channel_id),
      });
      if (started.stopped || !started.value) {
        const concurrentlyPersisted = existingListState(getChannel(persistedChannel.slack_channel_id) || persistedChannel);
        if (concurrentlyPersisted) return concurrentlyPersisted;
        throw new Error("Slack List creation intent could not be persisted.");
      }
      intent = started.value;
      const intentChannel = getChannel(persistedChannel.slack_channel_id) || persistedChannel;
      discovered = await discoverChannelList({ ...input, channel: intentChannel, intent });
      if (discovered) {
        return await reconcileDiscoveredChannelList({ ...input, channel: intentChannel, discovered });
      }
    }
    const created: any = await slackCall(input.client, "slackLists.create", {
      name: listName(persistedChannel),
      todo_mode: true,
      schema: conciergeListSchema(),
      description_blocks: richText(pendingListDescription(persistedChannel, intent.id, input.identitySecret)),
    }, { channel: persistedChannel.slack_channel_id, user: input.user || undefined });
    const listId = String(created.list_id || "");
    const titleColumnId = columnId(created.list_metadata, "title");
    const completedColumnId = columnId(created.list_metadata, "todo_completed");
    if (!listId || !titleColumnId) throw new Error("slackLists.create did not return list_id/title column metadata");
    const state = { listId, titleColumnId, completedColumnId };
    await slackCall(input.client, "slackLists.update", {
      id: listId,
      description_blocks: richText(listDescription(persistedChannel, listId, intent.id, input.identitySecret)),
    }, { channel: persistedChannel.slack_channel_id, user: input.user || undefined });
    await persistChannelListState(persistedChannel.slack_channel_id, state);
    log("info", "list_create_done", {
      channel: persistedChannel.slack_channel_id,
      list_id: listId,
      title_column_id: titleColumnId,
      completed_column_id: completedColumnId,
    });
    await shareChannelList({ ...input, channel: persistedChannel, state });
    return state;
  } catch (err) {
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "files.list/slackLists.create",
        err,
      });
      return null;
    }
    log("error", "list_create_failed", {
      channel: persistedChannel.slack_channel_id,
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
  sourceMessage?: { channel: string; ts: string; teamId?: string };
} & ListIdentityInput): Promise<string | null> {
  const sourceUrl = input.sourceMessage
    ? slackMessageSourceUrl(input.sourceMessage.channel, input.sourceMessage.ts, input.sourceMessage.teamId)
    : null;
  if (!sourceUrl) return appendListItemOnce(input, null, false);
  const key = `${input.channel.slack_channel_id}:${sourceUrl}`;
  const pending = pendingListItemAppends.get(key);
  if (pending) return pending;
  const task = appendListItemOnce(input, sourceUrl, false).finally(() => {
    if (pendingListItemAppends.get(key) === task) pendingListItemAppends.delete(key);
  });
  pendingListItemAppends.set(key, task);
  return task;
}

const pendingListItemAppends = new Map<string, Promise<string | null>>();

function isStaleListStateError(error: unknown) {
  return ["list_not_found", "invalid_column_id"].includes(slackErrorCode(error));
}

async function appendListItemOnce(
  input: {
    client: any;
    channel: ChannelRow;
    text: string;
    source: "todo" | "note" | "agent";
    user?: string | null;
  } & ListIdentityInput,
  sourceUrl: string | null,
  reconciledStaleState: boolean,
): Promise<string | null> {
  const state = await ensureChannelList(input);
  if (!state) return null;
  const title = input.source === "todo" ? input.text.trim() : `[${input.source}] ${input.text.trim()}`;
  const authenticatedSourceUrl = sourceUrl
    ? authenticatedListItemSourceUrl({
        channel: input.channel,
        listId: state.listId,
        source: input.source,
        title,
        sourceUrl,
        identitySecret: input.identitySecret,
      })
    : null;
  try {
    if (authenticatedSourceUrl) {
      let cursor: string | undefined;
      do {
        const listed: any = await slackCall(input.client, "slackLists.items.list", {
          list_id: state.listId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
        const existing = (Array.isArray(listed.items) ? listed.items : [])
          .find((item: any) => isAuthenticatedListItem({
            item,
            state,
            title,
            authenticatedSourceUrl,
            identityOwnerId: input.identityOwnerId,
          }));
        if (existing?.id) return String(existing.id);
        cursor = String(listed.response_metadata?.next_cursor || "") || undefined;
      } while (cursor);
    }
    const created: any = await slackCall(input.client, "slackLists.items.create", {
      list_id: state.listId,
      initial_fields: [{
        column_id: state.titleColumnId,
        rich_text: authenticatedSourceUrl ? sourcedRichText(title, authenticatedSourceUrl) : richText(title),
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
    if (!reconciledStaleState && isStaleListStateError(err)) {
      const cleared = await retryTransientDatabaseOperation({
        operation: () => clearChannelListState(input.channel.slack_channel_id, state.listId),
      });
      if (cleared.stopped) throw new Error("Slack List stale-state reconciliation stopped.");
      return appendListItemOnce(input, sourceUrl, true);
    }
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
} & ListIdentityInput): Promise<boolean> {
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
        if (leaf?.type === "link" && leaf?.text === "↗" && /(?:\/archives\/[^/]+\/p|\/thread-[^-]+-)\d+/.test(leaf?.url || "")) {
          continue;
        }
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
} & ListIdentityInput): Promise<Array<{ id: string; title: string; completed: boolean }>> {
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
} & ListIdentityInput): Promise<string | null> {
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
