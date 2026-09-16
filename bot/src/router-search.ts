import type { Database } from "bun:sqlite";
import type { ChannelRow } from "./state";
import { ROUTER_SEARCH_VERSION, slackTimestampUs, type RouterSearchSourceKind } from "./router-search-index";
import { resolveReplySession } from "./slack-thread-identity";

export class RouterSearchError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) { super(message); }
}

export type RouterSearchRequest = {
  channel?: string;
  beforeTs: string;
  excludeChannel?: string;
  excludeRootTs?: string;
  limit?: number;
  concepts: string[];
};

export type RouterThreadContextRequest = {
  channel: string;
  rootTs: string;
  beforeTs: string;
  limit?: number;
};

const searchUsage = "threads search [<channel>] --before-ts <message-ts> [--exclude-channel <channel> --exclude-root-ts <root>] [--limit <1..10>] -- <concept...>";
const contextUsage = "threads context <channel> <root-ts> --before-ts <message-ts> [--limit <1..20>]";

function invalid(message: string): never { throw new RouterSearchError("invalid_search", message, 2); }

function validateChannelArgument(channel: unknown, required: boolean) {
  if (channel === undefined && !required) return;
  if (typeof channel !== "string" || !channel.trim() || channel.length > 100) invalid(required ? "A channel is required" : "Invalid channel filter");
}

export function normalizeRouterSearch(request: RouterSearchRequest) {
  validateChannelArgument(request.channel, false);
  validateChannelArgument(request.excludeChannel, false);
  const beforeUs = slackTimestampUs(request.beforeTs);
  if (beforeUs === null) invalid("--before-ts requires the exact triggering message_ts as a Slack timestamp string");
  if (request.excludeRootTs !== undefined && slackTimestampUs(request.excludeRootTs) === null) invalid("Invalid --exclude-root-ts");
  if (request.excludeChannel !== undefined && request.excludeRootTs === undefined) invalid("--exclude-channel requires --exclude-root-ts");
  if (request.excludeRootTs !== undefined && request.channel === undefined && request.excludeChannel === undefined) {
    invalid("Global search requires --exclude-channel with --exclude-root-ts");
  }
  const limit = request.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) invalid("--limit must be 1..10");
  if (!Array.isArray(request.concepts) || request.concepts.length < 1 || request.concepts.length > 8) invalid("Supply 1..8 concepts after --");
  const concepts = request.concepts.map((concept) => {
    if (typeof concept !== "string" || concept.length > 200 || /[\x00-\x1f\x7f]/.test(concept)) invalid("Each concept must be at most 200 characters with no control characters");
    const tokens = concept.normalize("NFKC").match(/[\p{L}\p{N}\p{M}]+/gu) || [];
    if (!tokens.length || tokens.length > 16) invalid("Each concept must contain 1..16 Unicode word tokens");
    return { text: concept.trim(), expression: `(${tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ")})` };
  });
  return { beforeUs, limit, concepts, expression: concepts.map((concept) => concept.expression).join(" OR ") };
}

export function normalizeRouterThreadContext(request: RouterThreadContextRequest) {
  validateChannelArgument(request.channel, true);
  const rootUs = slackTimestampUs(request.rootTs);
  if (rootUs === null) invalid("context requires an exact Slack root timestamp string");
  const beforeUs = slackTimestampUs(request.beforeTs);
  if (beforeUs === null) invalid("--before-ts requires the exact triggering message_ts as a Slack timestamp string");
  if (rootUs >= beforeUs) invalid("Candidate root must strictly predate --before-ts");
  const limit = request.limit ?? 8;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) invalid("--limit must be 1..20");
  return { rootUs, beforeUs, limit };
}

export function parseRouterSearchArgs(argv: string[]): RouterSearchRequest {
  const args = [...argv];
  const channel = args[0] && args[0] !== "--" && !args[0]!.startsWith("--") ? args.shift() : undefined;
  const request: RouterSearchRequest = { channel, beforeTs: "", concepts: [] };
  const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") { request.concepts = args; break; }
    if (!["--before-ts", "--exclude-channel", "--exclude-root-ts", "--limit"].includes(arg) || seen.has(arg)) invalid(`Unknown or repeated search option; usage: ${searchUsage}`);
    seen.add(arg);
    const value = args.shift();
    if (!value || value.startsWith("--")) invalid("Search option is missing its value");
    if (arg === "--before-ts") request.beforeTs = value;
    if (arg === "--exclude-channel") request.excludeChannel = value;
    if (arg === "--exclude-root-ts") request.excludeRootTs = value;
    if (arg === "--limit") {
      if (!/^\d+$/.test(value)) invalid("--limit must be 1..10");
      request.limit = Number(value);
    }
  }
  normalizeRouterSearch(request);
  return request;
}

export function parseRouterThreadContextArgs(argv: string[]): RouterThreadContextRequest {
  const [channel, rootTs, ...args] = argv;
  if (!channel || channel.startsWith("--") || !rootTs || rootTs.startsWith("--")) invalid(contextUsage);
  const request: RouterThreadContextRequest = { channel, rootTs, beforeTs: "" };
  const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (!["--before-ts", "--limit"].includes(arg) || seen.has(arg)) invalid(`Unknown or repeated context option; usage: ${contextUsage}`);
    seen.add(arg);
    const value = args.shift();
    if (!value || value.startsWith("--")) invalid("Context option is missing its value");
    if (arg === "--before-ts") request.beforeTs = value;
    if (arg === "--limit") {
      if (!/^\d+$/.test(value)) invalid("--limit must be 1..20");
      request.limit = Number(value);
    }
  }
  normalizeRouterThreadContext(request);
  return request;
}

function resolveChannel(database: Database, target: string): ChannelRow {
  const name = target.replace(/^#/, "");
  const byId = /^[CGD][A-Z0-9]+$/.test(target);
  const channels = database.query(`SELECT * FROM channels WHERE ${byId ? "slack_channel_id" : "slack_channel_name"}=?`).all(name) as ChannelRow[];
  if (channels.length !== 1 || !/^[CGD][A-Z0-9]+$/.test(channels[0]?.slack_channel_id ?? "")) {
    throw new RouterSearchError("unknown_channel", "Channel is unknown or ambiguous", 2);
  }
  return channels[0]!;
}

function requireIndex(database: Database) {
  const state = database.query("SELECT version FROM router_search_index_state WHERE singleton=1").get() as { version: number } | null;
  if (state?.version !== ROUTER_SEARCH_VERSION) throw new RouterSearchError("search_incomplete", "Search projection has not completed its current backfill");
}

type ResolvedScope = {
  channelId: string | null;
  rootTs: string | null;
  beforeUs: number;
  excludeChannelId: string | null;
  excludeRootTs: string | null;
};

function scopeParameters(scope: ResolvedScope) {
  return [scope.beforeUs, scope.beforeUs, scope.channelId, scope.channelId, scope.rootTs, scope.rootTs,
    scope.excludeRootTs, scope.excludeChannelId, scope.excludeRootTs];
}

const eligibleScope = `source.slack_message_ts_us<? AND source.slack_thread_ts_us<?
  AND (? IS NULL OR source.slack_channel_id=?) AND (? IS NULL OR source.slack_thread_ts=?)
  AND (? IS NULL OR source.slack_channel_id<>? OR source.slack_thread_ts<>?)`;

const completeScope = `(source.slack_message_ts_us IS NULL OR source.slack_message_ts_us<?)
  AND (source.slack_thread_ts_us IS NULL OR source.slack_thread_ts_us<?)
  AND (? IS NULL OR source.slack_channel_id=?) AND (? IS NULL OR source.slack_thread_ts=?)
  AND (? IS NULL OR source.slack_channel_id<>? OR source.slack_thread_ts<>?)`;

// Compare eligibility to the ledger in the same read snapshot as retrieval. This
// catches missing/invalid historical identities without turning a partial index
// into a convincing empty result. It does not scan text for lexical matches.
function requireCompleteScope(database: Database, scope: ResolvedScope) {
  const missing = database.query(`SELECT 1 FROM router_search_sources source
    LEFT JOIN router_search_documents document ON document.source_kind=source.source_kind AND document.source_id=source.source_id
    LEFT JOIN router_search_fts_docsize fts_size ON fts_size.id=document.id
    WHERE ${completeScope}
      AND (source.slack_message_ts_us IS NULL OR source.slack_thread_ts_us IS NULL
        OR document.id IS NULL OR fts_size.id IS NULL OR document.slack_message_ts_us IS NOT source.slack_message_ts_us
        OR document.slack_channel_id IS NOT source.slack_channel_id
        OR document.slack_thread_ts IS NOT source.slack_thread_ts OR document.slack_message_ts IS NOT source.slack_message_ts
        OR document.content IS NOT source.content OR source.slack_thread_ts_us>source.slack_message_ts_us)
    LIMIT 1`).get(...scopeParameters(scope));
  if (missing) throw new RouterSearchError("search_incomplete", "Eligible ledger sources have missing or invalid search projection/Slack identity; clarify the resume target");
}

type RankedHit = {
  slack_channel_id: string;
  slack_thread_ts: string;
  source_kind: RouterSearchSourceKind;
  slack_message_ts: string;
  excerpt: string;
  score: number;
  user_evidence: number;
  last_activity_us: number;
};

export type RouterSearchResult = {
  channel_id: string;
  channel_name: string;
  root_ts: string;
  date: string;
  last_activity_at: string;
  title: string;
  snippet: string;
  matched_concepts: string[];
  matched_source: RouterSearchSourceKind;
  matched_message_ts: string;
  score_components: { bm25: number; user_input_evidence: boolean };
  resumable: boolean;
  provider: string | null;
  session_status: string | null;
};

function sourceDate(timestamp: string) {
  return new Date(Math.floor(slackTimestampUs(timestamp)! / 1000)).toISOString();
}

function currentReplyMetadata(database: Database, channel: ChannelRow, rootTs: string) {
  const { session } = resolveReplySession(database, channel, rootTs);
  return {
    resumable: channel.mode === "agent-auto" && Boolean(session?.agent_session_uuid) && session?.status !== "archived",
    provider: session?.provider_id ?? null,
    session_status: session?.status ?? null,
  };
}

export function searchRouterThreads(database: Database, request: RouterSearchRequest) {
  const started = performance.now();
  const normalized = normalizeRouterSearch(request);
  return database.transaction(() => {
    requireIndex(database);
    const channel = request.channel ? resolveChannel(database, request.channel) : null;
    const explicitExcludeChannel = request.excludeChannel ? resolveChannel(database, request.excludeChannel) : null;
    if (channel && explicitExcludeChannel && channel.slack_channel_id !== explicitExcludeChannel.slack_channel_id) {
      invalid("--exclude-channel must match the filtered channel");
    }
    const excludeChannel = request.excludeRootTs ? explicitExcludeChannel ?? channel : null;
    const scope: ResolvedScope = { channelId: channel?.slack_channel_id ?? null, rootTs: null, beforeUs: normalized.beforeUs,
      excludeChannelId: excludeChannel?.slack_channel_id ?? null, excludeRootTs: request.excludeRootTs ?? null };
    const parameters = scopeParameters(scope);
    requireCompleteScope(database, scope);
    const hits = database.query(`WITH hits AS MATERIALIZED (
      SELECT document.slack_channel_id, document.slack_thread_ts, document.source_kind, document.slack_message_ts,
        snippet(router_search_fts, 0, '', '', ' … ', 40) AS excerpt, bm25(router_search_fts) AS score,
        document.source_kind<>'delivered_tldr' AS user_evidence, document.slack_message_ts_us
      FROM router_search_fts JOIN router_search_documents document ON document.id=router_search_fts.rowid
      JOIN router_search_sources source ON source.source_kind=document.source_kind AND source.source_id=document.source_id
      WHERE router_search_fts MATCH ? AND ${eligibleScope}
        AND document.slack_channel_id=source.slack_channel_id AND document.slack_thread_ts=source.slack_thread_ts
        AND document.slack_message_ts=source.slack_message_ts AND document.content=source.content
    ), ranked AS (
      SELECT *, row_number() OVER(PARTITION BY slack_channel_id, slack_thread_ts ORDER BY score, user_evidence DESC, slack_message_ts_us DESC, source_kind, slack_message_ts) AS position,
        max(user_evidence) OVER(PARTITION BY slack_channel_id, slack_thread_ts) AS root_user_evidence,
        max(slack_message_ts_us) OVER(PARTITION BY slack_channel_id, slack_thread_ts) AS last_activity_us
      FROM hits
    ) SELECT slack_channel_id, slack_thread_ts, source_kind, slack_message_ts, excerpt, score,
        root_user_evidence AS user_evidence, last_activity_us
      FROM ranked WHERE position=1
      ORDER BY score, root_user_evidence DESC, last_activity_us DESC, slack_channel_id, slack_thread_ts LIMIT ?`)
      .all(normalized.expression, ...parameters, normalized.limit + 1) as RankedHit[];
    const omissions: string[] = [];
    const results: RouterSearchResult[] = hits.slice(0, normalized.limit).flatMap((hit) => {
      let candidateChannel: ChannelRow;
      try { candidateChannel = resolveChannel(database, hit.slack_channel_id); }
      catch (error) {
        if (!(error instanceof RouterSearchError) || error.code !== "unknown_channel") throw error;
        const omission = `Historical routing evidence omitted for unavailable channel ${hit.slack_channel_id}.`;
        if (!omissions.includes(omission)) omissions.push(omission);
        return [];
      }
      const matchedConcepts = normalized.concepts.filter((concept) => Boolean(database.query(`
        SELECT 1 FROM router_search_fts JOIN router_search_documents document ON document.id=router_search_fts.rowid
        JOIN router_search_sources source ON source.source_kind=document.source_kind AND source.source_id=document.source_id
        WHERE router_search_fts MATCH ? AND ${eligibleScope}
          AND source.slack_channel_id=? AND source.slack_thread_ts=?
          AND document.slack_channel_id=source.slack_channel_id AND document.slack_thread_ts=source.slack_thread_ts
          AND document.slack_message_ts=source.slack_message_ts AND document.content=source.content LIMIT 1`)
        .get(concept.expression, ...parameters, hit.slack_channel_id, hit.slack_thread_ts))).map((concept) => concept.text);
      const title = database.query(`SELECT content FROM router_search_sources
        WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<? AND source_kind='turn_input'
        ORDER BY slack_message_ts_us, source_id LIMIT 1`).get(hit.slack_channel_id, hit.slack_thread_ts, normalized.beforeUs) as { content: string } | null;
      const activity = database.query(`SELECT max(slack_message_ts_us) AS latest FROM router_search_sources
        WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<?`)
        .get(hit.slack_channel_id, hit.slack_thread_ts, normalized.beforeUs) as { latest: number };
      return [{
        channel_id: hit.slack_channel_id, channel_name: candidateChannel.slack_channel_name,
        root_ts: hit.slack_thread_ts, date: sourceDate(hit.slack_thread_ts),
        last_activity_at: new Date(Math.floor(activity.latest / 1000)).toISOString(),
        title: (title?.content ?? "").replace(/\s+/g, " ").slice(0, 160),
        snippet: hit.excerpt.slice(0, 600), matched_concepts: matchedConcepts,
        matched_source: hit.source_kind, matched_message_ts: hit.slack_message_ts,
        score_components: { bm25: hit.score, user_input_evidence: Boolean(hit.user_evidence) },
        ...currentReplyMetadata(database, candidateChannel, hit.slack_thread_ts),
      }];
    });
    const targetChannel = channel ? { id: channel.slack_channel_id, name: channel.slack_channel_name } : null;
    const excludedRoot = excludeChannel && request.excludeRootTs
      ? { channel_id: excludeChannel.slack_channel_id, root_ts: request.excludeRootTs }
      : null;
    return { concepts: normalized.concepts.map((concept) => concept.text),
      scope: channel ? "channel" : "all_channels", target_channel: targetChannel,
      before_ts: request.beforeTs, exclude_root: excludedRoot, exclude_root_ts: request.excludeRootTs ?? null,
      complete: omissions.length === 0, omissions, has_more: hits.length > normalized.limit, results,
      query_ms: Math.round((performance.now() - started) * 1000) / 1000 };
  })();
}

type ContextSource = {
  source_kind: RouterSearchSourceKind;
  source_id: number;
  slack_message_ts: string;
  slack_message_ts_us: number;
  content: string;
};

function contextSourceKey(source: ContextSource) { return `${source.source_kind}:${source.source_id}`; }

export function getRouterThreadContext(database: Database, request: RouterThreadContextRequest) {
  const started = performance.now();
  const normalized = normalizeRouterThreadContext(request);
  return database.transaction(() => {
    requireIndex(database);
    const channel = resolveChannel(database, request.channel);
    const scope: ResolvedScope = { channelId: channel.slack_channel_id, rootTs: request.rootTs,
      beforeUs: normalized.beforeUs, excludeChannelId: null, excludeRootTs: null };
    requireCompleteScope(database, scope);
    const parameters = scopeParameters(scope);
    const sourceSelect = `SELECT source.source_kind, source.source_id, source.slack_message_ts,
        source.slack_message_ts_us, source.content
      FROM router_search_documents document
      JOIN router_search_sources source ON source.source_kind=document.source_kind AND source.source_id=document.source_id
      WHERE ${eligibleScope}
        AND document.slack_channel_id=source.slack_channel_id AND document.slack_thread_ts=source.slack_thread_ts
        AND document.slack_message_ts=source.slack_message_ts AND document.content=source.content`;
    const count = database.query(`SELECT count(*) AS count FROM (${sourceSelect})`).get(...parameters) as { count: number };
    if (!count.count) throw new RouterSearchError("unknown_thread", "Candidate thread is unknown at this cutoff", 2);
    const first = database.query(`${sourceSelect} ORDER BY source.slack_message_ts_us, source.source_kind, source.source_id LIMIT 1`)
      .get(...parameters) as ContextSource;
    const recent = database.query(`${sourceSelect} ORDER BY source.slack_message_ts_us DESC, source.source_kind DESC, source.source_id DESC LIMIT ?`)
      .all(...parameters, normalized.limit) as ContextSource[];
    let selected = recent;
    if (!recent.some((source) => contextSourceKey(source) === contextSourceKey(first))) {
      selected = [...recent.slice(0, Math.max(0, normalized.limit - 1)), first];
    }
    selected.sort((left, right) => left.slack_message_ts_us - right.slack_message_ts_us
      || left.source_kind.localeCompare(right.source_kind) || left.source_id - right.source_id);
    const title = database.query(`SELECT content FROM router_search_sources
      WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<? AND source_kind='turn_input'
      ORDER BY slack_message_ts_us, source_id LIMIT 1`).get(channel.slack_channel_id, request.rootTs, normalized.beforeUs) as { content: string } | null;
    const latestActivity = database.query(`SELECT max(slack_message_ts_us) AS latest FROM router_search_sources
      WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<?`)
      .get(channel.slack_channel_id, request.rootTs, normalized.beforeUs) as { latest: number };
    return {
      channel: { id: channel.slack_channel_id, name: channel.slack_channel_name }, root_ts: request.rootTs,
      date: sourceDate(request.rootTs), last_activity_at: new Date(Math.floor(latestActivity.latest / 1000)).toISOString(),
      title: (title?.content ?? "").replace(/\s+/g, " ").slice(0, 160), before_ts: request.beforeTs,
      corpus: "routing_evidence", complete: true, fragment_count: count.count,
      returned_fragment_count: selected.length, has_more: count.count > selected.length,
      fragments: selected.map((source) => {
        const text = source.content.replace(/\s+/g, " ").trim();
        return { source: source.source_kind, message_ts: source.slack_message_ts,
          date: sourceDate(source.slack_message_ts), text: text.slice(0, 1200), truncated: text.length > 1200 };
      }),
      ...currentReplyMetadata(database, channel, request.rootTs),
      query_ms: Math.round((performance.now() - started) * 1000) / 1000,
    };
  })();
}

export function routerSearchStats(database: Database) {
  return database.transaction(() => {
    requireIndex(database);
    const counts = database.query(`SELECT count(*) AS document_count, min(occurred_at) AS oldest_source_at,
      max(occurred_at) AS newest_source_at FROM router_search_documents`).get();
    const size = database.query(`SELECT
      (SELECT page_count FROM pragma_page_count)*(SELECT page_size FROM pragma_page_size) AS database_bytes,
      (SELECT COALESCE(sum(length(block)),0) FROM router_search_fts_data)
        + (SELECT COALESCE(sum(length(term)),0) FROM router_search_fts_idx)
        + (SELECT COALESCE(sum(length(sz)),0) FROM router_search_fts_docsize) AS fts_payload_bytes`).get();
    return { version: ROUTER_SEARCH_VERSION, ...counts as object, ...size as object };
  })();
}
