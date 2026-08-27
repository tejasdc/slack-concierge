import { createHmac } from "node:crypto";
import {
  beginChannelListCreationIntent,
  ChannelListCreationIntent,
  ChannelRow,
  clearChannelListState,
  getChannel,
  updateChannelListState,
} from "./state";
import { errorFields, log } from "./log";
import { slackCall, slackListCall } from "./rate-limit";
import {
  isTransientSlackError,
  missingScopes,
  notifyMissingScope,
  slackErrorCode,
} from "./slack-errors";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";
import { slackMessageSourceUrl } from "./slack-links";

export { slackMessageSourceUrl } from "./slack-links";

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

function linkedTextElements(text: string) {
  const elements: Array<{ type: "text"; text: string } | { type: "link"; url: string; text: string }> = [];
  const urlPattern = /https?:\/\/[^\s<>()]+/g;
  let offset = 0;
  for (const match of text.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    if (index > offset) elements.push({ type: "text", text: text.slice(offset, index) });
    const matchedUrl = match[0];
    const url = matchedUrl.replace(/[.,;:!?]+$/, "");
    if (!url) {
      elements.push({ type: "text", text: matchedUrl });
    } else {
      elements.push({ type: "link", url, text: url });
      if (url.length < matchedUrl.length) {
        elements.push({ type: "text", text: matchedUrl.slice(url.length) });
      }
    }
    offset = index + matchedUrl.length;
  }
  if (offset < text.length) elements.push({ type: "text", text: text.slice(offset) });
  return elements.length ? elements : [{ type: "text" as const, text }];
}

export function linkedRichText(text: string) {
  return [{
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: linkedTextElements(text),
    }],
  }];
}

function sourcedRichText(text: string, authenticatedSourceUrl: string) {
  return [{
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: [
        ...linkedTextElements(text),
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
  return `${channel.slack_channel_id.startsWith("D") ? "" : "#"}${channel.slack_channel_name} todos`;
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
  return `${listIdentityMarker(channel, listId, intentId, identitySecret)}\nRead-only projection of ${channel.vault_path}/notes/TODOS.md. Use /todo or edit the file to make changes.`;
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
    const listed: any = await slackListCall(input.client, "files.list", {
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
      accessLevel: null,
    }),
  });
  if (persisted.stopped) throw new Error("Slack List state persistence stopped.");
}

async function makeChannelListReadOnly(input: {
  client: any;
  channel: ChannelRow;
  state: ListState;
  user?: string | null;
}) {
  try {
    const channelId = input.channel.slack_channel_id;
    let recipients: { channel_ids: string[] } | { user_ids: string[] } = { channel_ids: [channelId] };
    if (channelId.startsWith("D")) {
      const info: any = await slackListCall(input.client, "conversations.info", { channel: channelId });
      const conversation = info?.channel;
      if (conversation?.id !== channelId || conversation?.is_im !== true
        || typeof conversation.user !== "string" || !/^[UW][A-Z0-9]+$/.test(conversation.user)) {
        throw Object.assign(new Error("Slack did not return a verified DM participant for List access."), {
          data: { error: "invalid_dm_participant" },
        });
      }
      recipients = { user_ids: [conversation.user] };
    }
    await slackListCall(input.client, "slackLists.access.set", {
      list_id: input.state.listId,
      access_level: "read",
      ...recipients,
    }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
    log("info", "list_access_set_done", {
      channel: input.channel.slack_channel_id,
      list_id: input.state.listId,
      access_level: "read",
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
    throw err;
  }
  const persisted = await retryTransientDatabaseOperation({
    operation: () => updateChannelListState(input.channel.slack_channel_id, {
      listId: input.state.listId,
      titleColumnId: input.state.titleColumnId,
      completedColumnId: input.state.completedColumnId,
      accessLevel: "read",
    }),
  });
  if (persisted.stopped) throw new Error("Slack List read-access persistence stopped.");
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
    await slackListCall(input.client, "slackLists.update", {
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
  await makeChannelListReadOnly({ ...input, state: input.discovered.state });
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
    if (persistedChannel.list_access_level !== "read") {
      await makeChannelListReadOnly({ ...input, channel: persistedChannel, state: current });
    }
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
    const created: any = await slackListCall(input.client, "slackLists.create", {
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
    await slackListCall(input.client, "slackLists.update", {
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
    await makeChannelListReadOnly({ ...input, channel: persistedChannel, state });
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
        const listed: any = await slackListCall(input.client, "slackLists.items.list", {
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
    const created: any = await slackListCall(input.client, "slackLists.items.create", {
      list_id: state.listId,
      initial_fields: [{
        column_id: state.titleColumnId,
        rich_text: authenticatedSourceUrl
          ? sourcedRichText(title, authenticatedSourceUrl)
          : input.source === "todo" ? linkedRichText(title) : richText(title),
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
    await slackListCall(input.client, "slackLists.items.update", {
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

export function normalizeListItems(
  items: any[],
  schema?: Pick<ListState, "titleColumnId" | "completedColumnId">,
): Array<{ id: string; title: string; completed: boolean }> {
  return items.map((item, index) => {
    const id = typeof item?.id === "string" ? item.id : "";
    const fields = Array.isArray(item?.fields) ? item.fields : null;
    if (!id || !fields) throw new Error(`Slack List row ${index} is missing its ID or fields.`);
    const titleField = fields.find((field: any) => (
      field?.column_id === schema?.titleColumnId
      || (!field?.column_id && field?.key === "title")
    ));
    const completedField = fields.find((field: any) => (
      field?.column_id === schema?.completedColumnId
      || (!field?.column_id && field?.key === "todo_completed")
    ));
    const title = fieldText(titleField).trim();
    if (!titleField || !title) throw new Error(`Slack List row ${id} has no unambiguous title value.`);
    if (!schema?.completedColumnId || !completedField) {
      throw new Error(`Slack List row ${id} has no unambiguous completion value.`);
    }
    let completed: boolean;
    if (Array.isArray(completedField.checkbox) && typeof completedField.checkbox[0] === "boolean") {
      completed = completedField.checkbox[0];
    } else if (typeof completedField.checkbox === "boolean") {
      completed = completedField.checkbox;
    } else if (typeof completedField.value === "boolean") {
      completed = completedField.value;
    } else if (["completed", "open"].includes(completedField?.saved?.state)) {
      completed = completedField.saved.state === "completed";
    } else {
      throw new Error(`Slack List row ${id} has an unsupported completion value.`);
    }
    return { id, title, completed };
  });
}

export async function listItems(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
} & ListIdentityInput): Promise<Array<{ id: string; title: string; completed: boolean }>> {
  return listItemsOnce(input, false);
}

async function listItemsOnce(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
} & ListIdentityInput, reconciledStaleState: boolean): Promise<Array<{ id: string; title: string; completed: boolean }>> {
  try {
    const state = await ensureChannelList(input);
    if (!state) throw new Error("Slack List is unavailable; TODO projection stopped without changing the canonical file.");
    const items: Array<{ id: string; title: string; completed: boolean }> = [];
    let cursor: string | undefined;
    do {
      const listed: any = await slackListCall(input.client, "slackLists.items.list", {
        list_id: state.listId,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
      if (!listed || !Array.isArray(listed.items)) {
        throw new Error("slackLists.items.list returned a malformed response; TODO projection stopped.");
      }
      items.push(...normalizeListItems(listed.items, state));
      cursor = String(listed.next_cursor || listed.response_metadata?.next_cursor || "") || undefined;
    } while (cursor);
    log("info", "list_items_read_done", {
      channel: input.channel.slack_channel_id,
      list_id: state.listId,
      count: items.length,
    });
    return items;
  } catch (err) {
    if (!reconciledStaleState && isStaleListStateError(err)) {
      const current = getChannel(input.channel.slack_channel_id) || input.channel;
      if (current.list_id) {
        const cleared = await retryTransientDatabaseOperation({
          operation: () => clearChannelListState(input.channel.slack_channel_id, current.list_id!),
        });
        if (cleared.stopped) throw new Error("Slack List stale-state reconciliation stopped.");
        return listItemsOnce({ ...input, channel: getChannel(input.channel.slack_channel_id) || current }, true);
      }
    }
    if (missingScopes(err).length) {
      await notifyMissingScope({
        client: input.client,
        channel: input.channel.slack_channel_id,
        user: input.user,
        method: "slackLists.items.list",
        err,
      });
    }
    log("error", "list_items_read_failed", {
      channel: input.channel.slack_channel_id,
      list_id: input.channel.list_id,
      ...errorFields(err),
    });
    throw err;
  }
}

export async function updateListItem(input: {
  client: any;
  channel: ChannelRow;
  itemId: string;
  title?: string;
  completed?: boolean;
  user?: string | null;
  sourceMessage?: { channel: string; ts: string; teamId?: string };
} & ListIdentityInput): Promise<void> {
  const state = await ensureChannelList(input);
  if (!state) throw new Error("Slack List is unavailable.");
  const cells: any[] = [];
  if (input.title !== undefined) {
    const title = input.title.trim();
    const sourceUrl = input.sourceMessage
      ? slackMessageSourceUrl(input.sourceMessage.channel, input.sourceMessage.ts, input.sourceMessage.teamId)
      : null;
    const authenticatedSourceUrl = sourceUrl
      ? authenticatedListItemSourceUrl({
          channel: input.channel,
          listId: state.listId,
          source: "todo",
          title,
          sourceUrl,
          identitySecret: input.identitySecret,
        })
      : null;
    cells.push({
      row_id: input.itemId,
      column_id: state.titleColumnId,
      rich_text: authenticatedSourceUrl
        ? sourcedRichText(title, authenticatedSourceUrl)
        : linkedRichText(title),
    });
  }
  if (input.completed !== undefined) {
    if (!state.completedColumnId) throw new Error("Slack List is missing its completion column.");
    cells.push({
      row_id: input.itemId,
      column_id: state.completedColumnId,
      checkbox: input.completed,
    });
  }
  if (cells.length === 0) return;
  await slackListCall(input.client, "slackLists.items.update", {
    list_id: state.listId,
    cells,
  }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
}

export async function deleteListItem(input: {
  client: any;
  channel: ChannelRow;
  itemId: string;
  user?: string | null;
} & ListIdentityInput): Promise<void> {
  const state = await ensureChannelList(input);
  if (!state) throw new Error("Slack List is unavailable.");
  await slackListCall(input.client, "slackLists.items.delete", {
    list_id: state.listId,
    id: input.itemId,
  }, { channel: input.channel.slack_channel_id, user: input.user || undefined });
}
