import type { Database } from "bun:sqlite";
import type { ChannelRow } from "./state";
import { ROUTER_SEARCH_VERSION, slackTimestampUs, type RouterSearchSourceKind } from "./router-search-index";
import { resolveReplySession } from "./slack-thread-identity";

export class RouterSearchError extends Error {
  constructor(readonly code: string, message: string, readonly exitCode = 1) { super(message); }
}

export type RouterSearchRequest = {
  channel: string;
  beforeTs: string;
  excludeRootTs?: string;
  limit?: number;
  concepts: string[];
};

function invalid(message: string): never { throw new RouterSearchError("invalid_search", message, 2); }

export function normalizeRouterSearch(request: RouterSearchRequest) {
  if (typeof request.channel !== "string" || !request.channel.trim() || request.channel.length > 100) invalid("A target channel is required");
  const beforeUs = slackTimestampUs(request.beforeTs);
  if (beforeUs === null) invalid("--before-ts requires the exact triggering message_ts as a Slack timestamp string");
  if (request.excludeRootTs !== undefined && slackTimestampUs(request.excludeRootTs) === null) invalid("Invalid --exclude-root-ts");
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

export function parseRouterSearchArgs(argv: string[]): RouterSearchRequest {
  const [channel, ...args] = argv;
  if (!channel || channel.startsWith("--")) invalid("threads search <channel> --before-ts <message-ts> [--exclude-root-ts <root>] [--limit <1..10>] -- <concept...>");
  const request: RouterSearchRequest = { channel, beforeTs: "", concepts: [] };
  const seen = new Set<string>();
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--") { request.concepts = args; break; }
    if (!["--before-ts", "--exclude-root-ts", "--limit"].includes(arg) || seen.has(arg)) invalid("Unknown or repeated search option");
    seen.add(arg);
    const value = args.shift();
    if (!value || value.startsWith("--")) invalid("Search option is missing its value");
    if (arg === "--before-ts") request.beforeTs = value;
    if (arg === "--exclude-root-ts") request.excludeRootTs = value;
    if (arg === "--limit") {
      if (!/^\d+$/.test(value)) invalid("--limit must be 1..10");
      request.limit = Number(value);
    }
  }
  normalizeRouterSearch(request);
  return request;
}

function resolveChannel(database: Database, target: string): ChannelRow {
  const name = target.replace(/^#/, "");
  const byId = /^[CGD][A-Z0-9]+$/.test(target);
  const channels = database.query(`SELECT * FROM channels WHERE ${byId ? "slack_channel_id" : "slack_channel_name"}=?`).all(name) as ChannelRow[];
  if (channels.length !== 1 || !/^[CGD][A-Z0-9]+$/.test(channels[0]?.slack_channel_id ?? "")) {
    throw new RouterSearchError("unknown_channel", "Target channel is unknown or ambiguous; search never expands to other channels", 2);
  }
  return channels[0]!;
}

function requireIndex(database: Database) {
  const state = database.query("SELECT version FROM router_search_index_state WHERE singleton=1").get() as { version: number } | null;
  if (state?.version !== ROUTER_SEARCH_VERSION) throw new RouterSearchError("search_incomplete", "Search projection has not completed its current backfill");
}

// Compare eligibility to the ledger in the same read snapshot as retrieval. This
// catches missing/invalid historical identities without turning a partial index
// into a convincing empty result. It does not scan text for lexical matches.
function requireCompleteScope(database: Database, channel: string, beforeUs: number, exclude: string | null) {
  const missing = database.query(`SELECT 1 FROM router_search_sources source
    LEFT JOIN router_search_documents document ON document.source_kind=source.source_kind AND document.source_id=source.source_id
    LEFT JOIN router_search_fts_docsize fts_size ON fts_size.id=document.id
    WHERE source.slack_channel_id=?
      AND (source.slack_message_ts_us IS NULL OR source.slack_message_ts_us<?)
      AND (source.slack_thread_ts_us IS NULL OR source.slack_thread_ts_us<?)
      AND (? IS NULL OR source.slack_thread_ts IS NOT ?)
      AND (source.slack_message_ts_us IS NULL OR source.slack_thread_ts_us IS NULL
        OR document.id IS NULL OR fts_size.id IS NULL OR document.slack_message_ts_us IS NOT source.slack_message_ts_us
        OR document.slack_channel_id IS NOT source.slack_channel_id
        OR document.slack_thread_ts IS NOT source.slack_thread_ts OR document.slack_message_ts IS NOT source.slack_message_ts
        OR document.content IS NOT source.content OR source.slack_thread_ts_us>source.slack_message_ts_us)
    LIMIT 1`).get(channel, beforeUs, beforeUs, exclude, exclude);
  if (missing) throw new RouterSearchError("search_incomplete", "Eligible ledger sources have missing or invalid search projection/Slack identity; clarify the resume target");
}

type RankedHit = {
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

const eligibility = `source.slack_channel_id=? AND source.slack_message_ts_us<?
  AND source.slack_thread_ts_us<? AND (? IS NULL OR source.slack_thread_ts<>?)
  AND document.slack_channel_id=source.slack_channel_id AND document.slack_thread_ts=source.slack_thread_ts
  AND document.slack_message_ts=source.slack_message_ts AND document.content=source.content`;

export function searchRouterThreads(database: Database, request: RouterSearchRequest) {
  const started = performance.now();
  const normalized = normalizeRouterSearch(request);
  return database.transaction(() => {
    requireIndex(database);
    const channel = resolveChannel(database, request.channel);
    const exclude = request.excludeRootTs ?? null;
    const scope = [channel.slack_channel_id, normalized.beforeUs, normalized.beforeUs, exclude, exclude];
    requireCompleteScope(database, channel.slack_channel_id, normalized.beforeUs, exclude);
    const hits = database.query(`WITH hits AS MATERIALIZED (
      SELECT document.slack_thread_ts, document.source_kind, document.slack_message_ts,
        snippet(router_search_fts, 0, '', '', ' … ', 40) AS excerpt, bm25(router_search_fts) AS score,
        document.source_kind<>'delivered_tldr' AS user_evidence, document.slack_message_ts_us
      FROM router_search_fts JOIN router_search_documents document ON document.id=router_search_fts.rowid
      JOIN router_search_sources source ON source.source_kind=document.source_kind AND source.source_id=document.source_id
      WHERE router_search_fts MATCH ? AND ${eligibility}
    ), ranked AS (
      SELECT *, row_number() OVER(PARTITION BY slack_thread_ts ORDER BY score, user_evidence DESC, slack_message_ts_us DESC, source_kind, slack_message_ts) AS position,
        max(user_evidence) OVER(PARTITION BY slack_thread_ts) AS root_user_evidence,
        max(slack_message_ts_us) OVER(PARTITION BY slack_thread_ts) AS last_activity_us
      FROM hits
    ) SELECT slack_thread_ts, source_kind, slack_message_ts, excerpt, score, root_user_evidence AS user_evidence, last_activity_us
      FROM ranked WHERE position=1 ORDER BY score, root_user_evidence DESC, last_activity_us DESC, slack_thread_ts LIMIT ?`)
      .all(normalized.expression, ...scope, normalized.limit + 1) as RankedHit[];
    const results: RouterSearchResult[] = hits.slice(0, normalized.limit).map((hit) => {
      const matchedConcepts = normalized.concepts.filter((concept) => Boolean(database.query(`
        SELECT 1 FROM router_search_fts JOIN router_search_documents document ON document.id=router_search_fts.rowid
        JOIN router_search_sources source ON source.source_kind=document.source_kind AND source.source_id=document.source_id
        WHERE router_search_fts MATCH ? AND ${eligibility} AND source.slack_thread_ts=? LIMIT 1`)
        .get(concept.expression, ...scope, hit.slack_thread_ts))).map((concept) => concept.text);
      const title = database.query(`SELECT content FROM router_search_sources
        WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<? AND source_kind='turn_input'
        ORDER BY slack_message_ts_us, source_id LIMIT 1`).get(channel.slack_channel_id, hit.slack_thread_ts, normalized.beforeUs) as { content: string } | null;
      const activity = database.query(`SELECT max(slack_message_ts_us) AS latest FROM router_search_sources
        WHERE slack_channel_id=? AND slack_thread_ts=? AND slack_message_ts_us<?`)
        .get(channel.slack_channel_id, hit.slack_thread_ts, normalized.beforeUs) as { latest: number };
      const { session } = resolveReplySession(database, channel, hit.slack_thread_ts);
      return {
        channel_id: channel.slack_channel_id, channel_name: channel.slack_channel_name,
        root_ts: hit.slack_thread_ts, date: new Date(Math.floor(slackTimestampUs(hit.slack_thread_ts)! / 1000)).toISOString(),
        last_activity_at: new Date(Math.floor(activity.latest / 1000)).toISOString(),
        title: (title?.content ?? "").replace(/\s+/g, " ").slice(0, 160),
        snippet: hit.excerpt.slice(0, 600), matched_concepts: matchedConcepts,
        matched_source: hit.source_kind, matched_message_ts: hit.slack_message_ts,
        score_components: { bm25: hit.score, user_input_evidence: Boolean(hit.user_evidence) },
        resumable: channel.mode === "agent-auto" && Boolean(session?.agent_session_uuid) && session?.status !== "archived",
        provider: session?.provider_id ?? null, session_status: session?.status ?? null,
      };
    });
    return { concepts: normalized.concepts.map((concept) => concept.text), target_channel: { id: channel.slack_channel_id, name: channel.slack_channel_name },
      before_ts: request.beforeTs, exclude_root_ts: exclude, complete: true, has_more: hits.length > normalized.limit,
      results, query_ms: Math.round((performance.now() - started) * 1000) / 1000 };
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
