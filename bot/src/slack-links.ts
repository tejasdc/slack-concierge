import { slackCall } from "./rate-limit";

const SLACK_PERMALINK_RE = /https:\/\/[^\s<>|]+\/archives\/[A-Z0-9]+\/p\d{10,}(?:\?[^\s<>|]+)?/g;
const MAX_LINKS = 3;
const MAX_THREAD_MESSAGES = 50;
const MAX_MESSAGE_TEXT = 1500;

export function slackMessageSourceUrl(channel: string, messageTs: string, teamId?: string) {
  const compactTs = messageTs.replace(/\D/g, "");
  return teamId
    ? `https://app.slack.com/client/${teamId}/${channel}/thread-${channel}-${compactTs}`
    : `https://slack.com/archives/${channel}/p${compactTs}`;
}

export interface SlackPermalink {
  url: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
}

type SlackCallFn = (
  client: any,
  method: string,
  args: Record<string, unknown>,
  context?: { channel?: string; user?: string },
) => Promise<any>;

export function parseSlackPermalinks(text: string): SlackPermalink[] {
  const seen = new Set<string>();
  const links: SlackPermalink[] = [];
  for (const match of text.matchAll(SLACK_PERMALINK_RE)) {
    const parsed = parseSlackPermalink(match[0]);
    if (!parsed) continue;
    const key = `${parsed.channelId}:${parsed.messageTs}:${parsed.threadTs || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(parsed);
  }
  return links;
}

export function parseSlackPermalink(rawUrl: string): SlackPermalink | null {
  let url: URL;
  const cleaned = rawUrl.replace(/&amp;/g, "&");
  try {
    url = new URL(cleaned);
  } catch {
    return null;
  }

  if (!url.hostname.endsWith(".slack.com")) return null;
  const match = url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10,})$/);
  if (!match) return null;
  const messageTs = slackTimestampFromPermalink(match[2]);
  if (!messageTs) return null;
  return {
    url: cleaned,
    channelId: url.searchParams.get("cid") || match[1],
    messageTs,
    threadTs: url.searchParams.get("thread_ts"),
  };
}

export async function slackPermalinkPrompt(input: {
  text: string;
  client: any;
  user?: string;
  call?: SlackCallFn;
}): Promise<string> {
  const links = parseSlackPermalinks(input.text).slice(0, MAX_LINKS);
  if (links.length === 0) return "";
  const call = input.call || slackCall;
  const sections: string[] = [];
  for (const link of links) {
    sections.push(await linkedThreadSection({ link, client: input.client, user: input.user, call }));
  }
  return [
    "Slack thread links referenced in this user message were resolved before the agent turn.",
    "Use this linked-thread context when answering; do not ask the user to paste the same thread again.",
    "",
    ...sections,
  ].join("\n");
}

async function linkedThreadSection(input: {
  link: SlackPermalink;
  client: any;
  user?: string;
  call: SlackCallFn;
}) {
  try {
    const thread = await fetchLinkedThread(input);
    return formatLinkedThread(input.link, thread);
  } catch (err) {
    return [
      `Linked Slack thread: ${input.link.url}`,
      `channel=${input.link.channelId}, message_ts=${input.link.messageTs}`,
      `Unable to read linked thread: ${errorMessage(err)}`,
    ].join("\n");
  }
}

async function fetchLinkedThread(input: {
  link: SlackPermalink;
  client: any;
  user?: string;
  call: SlackCallFn;
}) {
  const context = { channel: input.link.channelId, user: input.user };
  if (input.link.threadTs) {
    return await fetchReplies({ ...input, threadTs: input.link.threadTs, context });
  }

  const firstPage = await input.call(input.client, "conversations.replies", {
    channel: input.link.channelId,
    ts: input.link.messageTs,
    limit: MAX_THREAD_MESSAGES,
  }, context);
  const firstMessage = firstPage.messages?.[0];
  const parentTs = firstMessage?.thread_ts || input.link.messageTs;
  if (parentTs === input.link.messageTs) return firstPage;
  return await fetchReplies({ ...input, threadTs: parentTs, context });
}

async function fetchReplies(input: {
  link: SlackPermalink;
  client: any;
  user?: string;
  call: SlackCallFn;
  threadTs: string;
  context: { channel?: string; user?: string };
}) {
  const messages: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await input.call(input.client, "conversations.replies", {
      channel: input.link.channelId,
      ts: input.threadTs,
      limit: Math.min(200, MAX_THREAD_MESSAGES - messages.length),
      ...(cursor ? { cursor } : {}),
    }, input.context);
    messages.push(...(page.messages || []));
    cursor = page.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < MAX_THREAD_MESSAGES);
  return { messages, response_metadata: cursor ? { next_cursor: cursor } : undefined };
}

function formatLinkedThread(link: SlackPermalink, thread: any) {
  const messages = thread.messages || [];
  const parentTs = messages[0]?.thread_ts || messages[0]?.ts || link.threadTs || link.messageTs;
  const rows = messages.slice(0, MAX_THREAD_MESSAGES).map((message: any, index: number) => {
    const author = message.user ? `<@${message.user}>` : message.bot_id ? `bot:${message.bot_id}` : "unknown";
    const text = truncate((message.text || "").trim() || "(no text)");
    const files = (message.files || []).map((file: any) => {
      const label = file.title || file.name || file.id || "file";
      const meta = [file.mimetype, file.media_display_type].filter(Boolean).join(", ");
      return meta ? `${label} (${meta})` : label;
    });
    return [
      `${index + 1}. ts=${message.ts} author=${author}`,
      `   text: ${text}`,
      files.length ? `   files: ${files.join("; ")}` : null,
    ].filter(Boolean).join("\n");
  });

  const omitted = thread.response_metadata?.next_cursor ? "\n(messages omitted after resolver limit)" : "";
  return [
    `Linked Slack thread: ${link.url}`,
    `channel=${link.channelId}, parent_thread_ts=${parentTs}, message_count=${messages.length}`,
    ...rows,
    omitted,
  ].filter(Boolean).join("\n");
}

function slackTimestampFromPermalink(value: string) {
  if (value.length <= 6) return null;
  const seconds = value.slice(0, -6);
  const micros = value.slice(-6);
  return `${seconds}.${micros}`;
}

function truncate(text: string) {
  if (text.length <= MAX_MESSAGE_TEXT) return text;
  return `${text.slice(0, MAX_MESSAGE_TEXT - 20)}... [truncated]`;
}

function errorMessage(err: unknown) {
  if (err instanceof Error) return err.message;
  return String(err);
}
