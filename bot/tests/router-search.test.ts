import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  db, upsertChannel, upsertSession, getSessionForThread, acquireSessionTurn, startTurn,
  createTurnSteeringMessage, markTurnSteeringMessageSending, markTurnSteeringMessageSent,
  markTurnSteeringMessageFailed, markTurnDelivering, markDeliveryChunkDelivered, markTurnResponseDelivered,
  finishDeliveredTurn, setTurnReplayInput, associateLegacyTurnsWithSlackThread, listSlackThreadResponses,
} from "../src/state";
import { initializeRouterSearchIndex, rebuildRouterSearchIndex, slackTimestampUs, slackTimestampUsSql } from "../src/router-search-index";
import { normalizeRouterSearch, parseRouterSearchArgs, routerSearchStats, searchRouterThreads } from "../src/router-search";
import incident from "./fixtures/router-search-incident.json";

let channel: string;
let sequence = 0;
const root = incident.historical_root_ts;
const before = incident.trigger_ts;
beforeEach(() => {
  channel = `CSEARCH${++sequence}`;
  upsertChannel({ slack_channel_id: channel, slack_channel_name: `search-${sequence}`, name: "Search", group_name: null, vault_path: "/tmp/search" });
});
afterEach(() => {
  const sessionIds = `SELECT id FROM sessions WHERE slack_channel_id='${channel}'`;
  const turnIds = `SELECT id FROM turns WHERE session_id IN (${sessionIds})`;
  for (const table of ["turn_steering_messages", "slack_user_input_claims", "turn_delivery_chunks", "turn_reaction_cleanups"]) {
    db.exec(`DELETE FROM ${table} WHERE turn_id IN (${turnIds})`);
  }
  db.exec(`DELETE FROM turns WHERE session_id IN (${sessionIds}); DELETE FROM sessions WHERE slack_channel_id='${channel}'; DELETE FROM channels WHERE slack_channel_id='${channel}'`);
});

function turn(text = incident.historical_input, messageTs = root, rootTs = root, sessionRoot = root) {
  upsertSession(channel, sessionRoot, "codex", `uuid-${sessionRoot}`);
  const session = getSessionForThread(channel, sessionRoot)!;
  const result = acquireSessionTurn(session.id, messageTs, text, null, undefined, rootTs);
  return { ...result, session };
}
function search(concepts = incident.concepts, options: Record<string, unknown> = {}) {
  return searchRouterThreads(db, { channel, beforeTs: before, concepts, ...options });
}
function deliver(id: number, text = "Outcome: mineral water", timestamp = "1786559000.000001") {
  expect(markTurnDelivering(id, `TL;DR: ${text}\n\nDO_NOT_INDEX_FULL_ASSISTANT`, "DO_NOT_INDEX_OUTBOUND", 1, text)).toBe(true);
  markDeliveryChunkDelivered(id, 0, timestamp);
  markTurnResponseDelivered(id);
  expect(finishDeliveredTurn(id)).toBe(true);
}

test("incident resolves the August root before the current router and later duplicate existed", () => {
  turn();
  turn(incident.trigger_text, before, before);
  turn(incident.historical_input, incident.duplicate_root_ts, incident.duplicate_root_ts);
  const result = search();
  expect(result.complete).toBe(true);
  expect(result.results.map((row) => row.root_ts)).toEqual([root]);
  expect(result.results[0]).toMatchObject({ channel_id: channel, matched_concepts: incident.concepts,
    matched_source: "turn_input", matched_message_ts: root, resumable: true, provider: "codex" });
  expect(JSON.stringify(result)).not.toContain("session_id");
});

test("turn creation and retry share one source document", () => {
  const initial = turn();
  const duplicate = acquireSessionTurn(initial.session.id, root, "MUST_NOT_REPLACE", null, undefined, root);
  expect(duplicate.duplicate).toBe(true);
  expect(search().results).toHaveLength(1);
  expect(db.query("SELECT count(*) AS n FROM router_search_documents WHERE turn_id=?").get(initial.id)).toEqual({ n: 1 });
});

test("legacy startTurn also maintains its initial source", () => {
  upsertSession(channel, root, "codex", "legacy");
  startTurn(getSessionForThread(channel, root)!.id, root, "starlight gardens");
  expect(search(["starlight"]).results[0]?.root_ts).toBe(root);
});

test("steering is searchable only after provider acknowledgement and keeps its own visible root", () => {
  const initial = turn("unrelated starting request");
  const steering = createTurnSteeringMessage(initial.id, "1786559001.000001", "shower filter", "DO_NOT_INDEX_REPLAY", undefined, "1786559000.000001").row!;
  expect(search(["shower"]).results).toEqual([]);
  markTurnSteeringMessageSending(steering.id);
  expect(search(["shower"]).results).toEqual([]);
  markTurnSteeringMessageSent(steering.id);
  markTurnSteeringMessageSent(steering.id);
  expect(search(["shower"]).results[0]).toMatchObject({ root_ts: "1786559000.000001", matched_source: "steering_input", matched_message_ts: "1786559001.000001" });
  expect(search(["DO_NOT_INDEX_REPLAY"]).results).toEqual([]);
});

test("failed steering and synthetic turns never enter the corpus", () => {
  const initial = turn("starting request");
  const steering = createTurnSteeringMessage(initial.id, "1786559001.000001", "failedguidance", "ignored").row!;
  markTurnSteeringMessageFailed(steering.id, "rejected");
  acquireSessionTurn(initial.session.id, "1786559002.000001", "syntheticcomparison", null, undefined, root, { turnKind: "comparison" });
  expect(search(["failedguidance", "syntheticcomparison"]).results).toEqual([]);
});

test.each(["comparison", "deployment_verification"] as const)("real steering and delivered summaries remain searchable on a %s turn", (turnKind) => {
  upsertSession(channel, root, "codex", "synthetic-owner");
  const session = getSessionForThread(channel, root)!;
  const initial = acquireSessionTurn(session.id, root, "syntheticwrapper", null, undefined, root, { turnKind });
  const steering = createTurnSteeringMessage(initial.id, "1786559001.000001", "moonflower irrigation", "replaywrapper", undefined, root).row!;
  markTurnSteeringMessageSending(steering.id);
  markTurnSteeringMessageSent(steering.id);
  deliver(initial.id, "gardenwatering", "1786559002.000001");
  expect(search(["syntheticwrapper", "replaywrapper"]).results).toEqual([]);
  expect(search(["moonflower"]).results[0]).toMatchObject({ root_ts: root, matched_source: "steering_input" });
  expect(search(["gardenwatering"]).results[0]).toMatchObject({ root_ts: root, matched_source: "delivered_tldr" });
  rebuildRouterSearchIndex(db);
  expect(search(["moonflower"]).results[0]?.root_ts).toBe(root);
  expect(search(["gardenwatering"]).results[0]?.root_ts).toBe(root);
});

test("delivered summary uses its final Slack chunk timestamp, not input or status-message time", () => {
  const initial = turn("ordinary request");
  markTurnDelivering(initial.id, "DO_NOT_INDEX_AGENT", "DO_NOT_INDEX_OUTBOUND", 2, "mineralwater");
  markDeliveryChunkDelivered(initial.id, 0, "1786559000.000001");
  expect(search(["mineralwater"]).results).toEqual([]);
  markDeliveryChunkDelivered(initial.id, 1, "1786559001.000001");
  markTurnResponseDelivered(initial.id);
  expect(search(["mineralwater"], { beforeTs: "1786559001.000001" }).results).toEqual([]);
  expect(search(["mineralwater"], { beforeTs: "1786559001.000002" }).results[0]).toMatchObject({ matched_source: "delivered_tldr", matched_message_ts: "1786559001.000001" });
  expect(search(["DO_NOT_INDEX_AGENT", "DO_NOT_INDEX_OUTBOUND"]).results).toEqual([]);
});

test("replay updates do not index provider wrappers", () => {
  const initial = turn("ordinary request");
  setTurnReplayInput(initial.id, "secretwrapper", 0);
  expect(search(["secretwrapper"]).results).toEqual([]);
});

test("source mutations and their projection roll back together", () => {
  upsertSession(channel, root, "codex", "atomic");
  db.exec(`CREATE TEMP TRIGGER fail_search_insert BEFORE INSERT ON router_search_documents BEGIN SELECT RAISE(ABORT, 'test projection failure'); END`);
  try {
    expect(() => startTurn(getSessionForThread(channel, root)!.id, root, "atomic")).toThrow("test projection failure");
    expect(db.query("SELECT 1 FROM turns WHERE session_id=?").get(getSessionForThread(channel, root)!.id)).toBeNull();
  } finally { db.exec("DROP TRIGGER fail_search_insert"); }
});

test("grouping preserves evidence from several sources without returning duplicate roots", () => {
  const initial = turn("hair loss");
  const steering = createTurnSteeringMessage(initial.id, "1786559001.000001", "shower filter", "wrapped").row!;
  markTurnSteeringMessageSending(steering.id); markTurnSteeringMessageSent(steering.id);
  deliver(initial.id);
  expect(search().results).toHaveLength(1);
  expect(search().results[0]?.matched_concepts).toEqual(incident.concepts);
});

test("channel, current root, and source-time constraints apply before root ranking", () => {
  turn();
  expect(search(incident.concepts, { excludeRootTs: root }).results).toEqual([]);
  expect(search(incident.concepts, { beforeTs: root }).results).toEqual([]);
  expect(() => search(incident.concepts, { channel: "CUNKNOWN" })).toThrow("unknown or ambiguous");
  expect(search(incident.concepts, { channel: `#search-${sequence}` }).results[0]?.channel_id).toBe(channel);
  const other = `COTHER${sequence}`;
  upsertChannel({ slack_channel_id: other, slack_channel_name: `search-${sequence}`, name: "Other", group_name: null, vault_path: "/tmp/other" });
  try {
    expect(searchRouterThreads(db, { channel: other, beforeTs: before, concepts: incident.concepts }).results).toEqual([]);
    expect(() => search(incident.concepts, { channel: `search-${sequence}` })).toThrow("ambiguous");
  } finally { db.query("DELETE FROM channels WHERE slack_channel_id=?").run(other); }
});

test("single-persistent roots remain separate while resumability follows the current channel owner", () => {
  const first = turn("hair loss");
  const secondRoot = "1786559900.000001";
  turn("shower filter", secondRoot, secondRoot);
  const anchor = "single-persistent:" + channel;
  upsertSession(channel, anchor, "claude-code", "shared-uuid");
  db.query("UPDATE channels SET session_mode='single-persistent', default_session_uuid='shared-uuid' WHERE slack_channel_id=?").run(channel);
  expect(search().results.map((row) => row.root_ts).sort()).toEqual([root, secondRoot]);
  expect(search().results.every((row) => row.provider === "claude-code" && row.resumable)).toBe(true);
  db.query("UPDATE sessions SET parent_session_id=? WHERE id=?").run(first.session.id, first.session.id);
  expect(search(["hair"]).results[0]?.provider).toBe("codex");
  db.query("UPDATE sessions SET status='archived' WHERE id=?").run(first.session.id);
  expect(search(["hair"]).results[0]?.resumable).toBe(false);
});

test("backfill shares visible-root rules and is idempotent; association repairs legacy roots", () => {
  const initial = turn(); deliver(initial.id);
  const reply = turn("orchid history", "1786559900.000001", root);
  deliver(reply.id, "orchid outcome", "1786559901.000001");
  db.query("UPDATE turns SET slack_reply_thread_ts=NULL WHERE id=?").run(reply.id);
  rebuildRouterSearchIndex(db);
  const first = search(["orchid"]);
  expect(first.results[0]?.root_ts).toBe(root);
  expect(listSlackThreadResponses(channel, root).map((row) => row.turn_id)).toContain(reply.id);
  rebuildRouterSearchIndex(db);
  expect(search(["orchid"]).results).toEqual(first.results);
  db.query("UPDATE channels SET session_mode='single-persistent' WHERE slack_channel_id=?").run(channel);
  rebuildRouterSearchIndex(db);
  expect(search(["orchid"]).results[0]?.root_ts).toBe("1786559900.000001");
  associateLegacyTurnsWithSlackThread(channel, root, ["1786559900.000001"]);
  expect(search(["orchid"]).results[0]?.root_ts).toBe(root);
});

test("startup does not rescan an already current projection; missing documents fail closed", () => {
  const initial = turn();
  db.query("DELETE FROM router_search_documents WHERE turn_id=?").run(initial.id);
  initializeRouterSearchIndex(db);
  expect(() => search()).toThrow("missing or invalid");
  rebuildRouterSearchIndex(db);
  expect(search().results[0]?.root_ts).toBe(root);
});

test("missing FTS rows fail closed and the ledger rebuild restores them atomically", () => {
  const initial = turn();
  const source = db.query("SELECT id, content FROM router_search_documents WHERE turn_id=?").get(initial.id) as { id: number; content: string };
  db.query("INSERT INTO router_search_fts(router_search_fts, rowid, content) VALUES('delete', ?, ?)").run(source.id, source.content);
  try {
    expect(() => search()).toThrow("missing or invalid");
    const ledger = db.query("SELECT * FROM turns WHERE id=?").get(initial.id);
    rebuildRouterSearchIndex(db);
    expect(search().results[0]?.root_ts).toBe(root);
    expect(db.query("SELECT * FROM turns WHERE id=?").get(initial.id)).toEqual(ledger);
  }
  finally { db.exec("INSERT INTO router_search_fts(router_search_fts) VALUES('rebuild')"); }
});

test("invalid stored identity is incomplete, never a fabricated nearby root", () => {
  const initial = turn();
  db.query("UPDATE turns SET slack_reply_thread_ts='not-a-timestamp' WHERE id=?").run(initial.id);
  expect(() => search()).toThrow("missing or invalid");
});

test("missing backfill marker fails closed and startup rebuilds from ledger", () => {
  turn();
  db.exec("DELETE FROM router_search_index_state");
  expect(() => search()).toThrow("backfill");
  initializeRouterSearchIndex(db);
  expect(search().results[0]?.root_ts).toBe(root);
});

test("bounded snippets retain matching text far from the beginning and do not expose full inputs", () => {
  turn("ordinary ".repeat(1000) + "shower filter " + "ordinary ".repeat(1000));
  const result = search(["shower filter"]).results[0]!;
  expect(result.snippet).toContain("shower filter");
  expect(result.snippet.length).toBeLessThanOrEqual(600);
  expect(result.title.length).toBeLessThanOrEqual(160);
});

test("concepts use AND word prefixes within each concept and OR between concepts", () => {
  turn("A shower-head filtration system and café 東京 gardens");
  expect(search(["shower filter"]).results).toEqual([]);
  expect(search(["shower filtr", "missing"]).results).toHaveLength(1);
  expect(search(["cafe", "東京"]).results[0]?.matched_concepts).toEqual(["cafe", "東京"]);
  expect(search(['\" OR * NOT (unknown)']).results).toEqual([]);
});

test("limits count roots rather than fragments and report additional candidates", () => {
  for (let index = 1; index <= 12; index++) turn("orchid", `1786559000.${String(index).padStart(6, "0")}`, `1786559000.${String(index).padStart(6, "0")}`);
  const result = search(["orchid"], { limit: 10 });
  expect(result.results).toHaveLength(10); expect(result.has_more).toBe(true);
  expect(new Set(result.results.map((row) => row.root_ts)).size).toBe(10);
});

test("timestamp ordering is exact integer microseconds and SQL/JS validation agree", () => {
  for (const value of ["1.2", "1786558965.762069", "9007199254.740991", "9007199254.740992", "99999999999.1", "1.0000001", "1.2.3", "-1.1", "1", "NaN", "1.e2", "", null, 1.2]) {
    const expected = slackTimestampUs(value);
    const actual = db.query(`SELECT ${slackTimestampUsSql("value")} AS result FROM (SELECT ? AS value)`).get(value) as { result: number | null };
    expect(actual.result).toBe(expected);
  }
  turn("microsecond", "1788420135.485138", "1788420135.485138");
  expect(search(["microsecond"]).results).toHaveLength(1);
  expect(search(["microsecond"], { beforeTs: "1788420135.485138" }).results).toEqual([]);
});

test.each([
  [], ["target"], ["target", "--before-ts", before], ["target", "--", "hair"],
  ["target", "--before-ts", "bad", "--", "hair"],
  ["target", "--before-ts", before, "--before-ts", before, "--", "hair"],
  ["target", "--before-ts", before, "--limit", "11", "--", "hair"],
  ["target", "--before-ts", before, "--exclude-root-ts", "bad", "--", "hair"],
  ["target", "--before-ts", before, "--", "*"],
  ["target", "--before-ts", before, "--", "x".repeat(201)],
  ["target", "--before-ts", before, "--", ...Array(9).fill("hair")],
].map((args) => [args]))("malformed search arguments fail safely: %j", (args) => {
  expect(() => parseRouterSearchArgs(args)).toThrow();
});

test("normalization rejects runtime values outside the structured contract", () => {
  expect(() => normalizeRouterSearch({ channel, beforeTs: before, concepts: ["x\u0000"] })).toThrow();
  expect(() => normalizeRouterSearch({ channel, beforeTs: before, concepts: ["x ".repeat(17)] })).toThrow();
});

test("real shell entrypoint is credential-free, read-only, structured, and fails closed", () => {
  turn();
  const wrapper = resolve(import.meta.dir, "../../systemd/router-actions.sh");
  const env = { ...process.env, CONCIERGE_ROUTER_BOT_DIR: resolve(import.meta.dir, ".."),
    CONCIERGE_STATE_DB: join(process.env.CONCIERGE_STATE_DIR!, "state.db"), CONCIERGE_SLACK_CONFIG: "/must-not-read-slack-config" };
  const beforeSnapshot = db.query("SELECT * FROM router_search_documents WHERE slack_channel_id=?").all(channel);
  const run = (...args: string[]) => Bun.spawnSync(["bash", wrapper, "threads", ...args], { env });
  const success = run("search", channel, "--before-ts", before, "--", "hair loss");
  expect(success.exitCode).toBe(0); expect(success.stderr.toString()).toBe("");
  expect(JSON.parse(success.stdout.toString()).results[0].root_ts).toBe(root);
  expect(db.query("SELECT * FROM router_search_documents WHERE slack_channel_id=?").all(channel)).toEqual(beforeSnapshot);
  const empty = run("search", channel, "--before-ts", before, "--", "nohitsatall");
  expect(JSON.parse(empty.stdout.toString())).toMatchObject({ complete: true, results: [] });
  const bad = run("search", channel, "--", "hair");
  expect(bad.exitCode).toBe(2); expect(bad.stdout.toString()).toBe("");
  expect(JSON.parse(bad.stderr.toString())).toMatchObject({ complete: false, code: "invalid_search" });
  const stats = run("stats"); expect(stats.exitCode).toBe(0);
  expect(JSON.parse(stats.stdout.toString()).fts_payload_bytes).toBeGreaterThan(0);
  const scratch = mkdtempSync(join(tmpdir(), "router-missing-"));
  try {
    const missing = Bun.spawnSync(["bash", wrapper, "threads", "search", channel, "--before-ts", before, "--", "hair"],
      { env: { ...env, CONCIERGE_STATE_DB: join(scratch, "absent.db") } });
    expect(missing.exitCode).toBe(1); expect(missing.stdout.toString()).toBe("");
    expect(JSON.parse(missing.stderr.toString()).code).toBe("search_unavailable");
  } finally { rmSync(scratch, { recursive: true }); }
});

test("read-only connections cannot rebuild or update search state", () => {
  const reader = new Database(join(process.env.CONCIERGE_STATE_DIR!, "state.db"), { readonly: true });
  try {
    expect(() => rebuildRouterSearchIndex(reader)).toThrow();
    expect(routerSearchStats(reader).version).toBe(1);
  } finally { reader.close(); }
});
