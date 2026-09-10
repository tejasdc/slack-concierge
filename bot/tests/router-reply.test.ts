import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDatabaseTestLock } from "./db-lock";
import { routerReplyChannelId } from "../src/router-reply";
import { postLongReply } from "../src/slack-post";
import { finalReplyChunks } from "../src/final-reply-blocks";
import { toMrkdwn } from "../src/mrkdwn";
import { AgentProgressController } from "../src/agent-progress";
import { beginAgentProgressMessages, projectAgentProgressMessages, queueAgentProgressMessages } from "../src/agent-progress-messages";
import { slackBucket, resetAgentProgressSlackBucketsForTests } from "../src/rate-limit";
import {
  acquireSessionTurn, createOrGetSession, db, deliveredChunkIndexes, finishDeliveredTurn,
  getTurnProgressStream, markDeliveryChunkDelivered, markTurnDelivering, markTurnProgressStreamStopped,
  markTurnResponseDelivered, prepareTurnReplyReplacement, recordDeliveryAttempt, requestTurnProgressStreamStop,
} from "../src/state";

const routerChannel = "D0BMWUJ3RD5";
let release: (() => void) | undefined;
beforeEach(async () => { release = await acquireDatabaseTestLock(); slackBucket.reset(); resetAgentProgressSlackBucketsForTests(); });
afterEach(() => release?.());

function fixture(channel = routerChannel, sessionId?: number) {
  const root = `${Date.now()}.${Math.floor(Math.random() * 999999)}`;
  const session = sessionId ? { id: sessionId } : createOrGetSession(channel, root, "claude-code");
  const turn = acquireSessionTurn(session.id, root, "route this", "router-test", undefined, root, { projectionMode: "agent", userId: "U1" });
  const calls: Array<{ method: string; args: any }> = [];
  const client = { apiCall: async (method: string, args: any) => {
    calls.push({ method, args: structuredClone(args) });
    return { ok: true, ts: args.ts || `${turn.id}.${calls.length}` };
  } };
  const write = async (chunks: any[], terminal = false) => {
    queueAgentProgressMessages(turn.id, chunks, terminal);
    await projectAgentProgressMessages(client, turn.id);
  };
  const controller = new AgentProgressController({ flushDelayMs: 60_000,
    start: async chunks => { beginAgentProgressMessages(turn.id, chunks); await projectAgentProgressMessages(client, turn.id); return getTurnProgressStream(turn.id)!.progress_stream_ts!; },
    append: async (_, chunks) => write(chunks),
    stop: async (_, chunks) => { requestTurnProgressStreamStop(turn.id); await write(chunks, true); markTurnProgressStreamStopped(turn.id); },
  });
  return { turn, session, controller, calls, client, root, channel };
}

test("production enables only the exact router DM; sandbox needs its explicitly selected lane fixture", () => {
  expect(routerReplyChannelId({ CONCIERGE_SANDBOX_ROUTER_REPLY_MODE: "1" })).toBe(routerChannel);
  expect(routerReplyChannelId({ CONCIERGE_RUNTIME_PROFILE: "sandbox" })).toBeNull();
  const file = join(mkdtempSync(join(tmpdir(), "router-reply-")), "fixtures.json");
  writeFileSync(file, JSON.stringify({ lane_id: "lane-2", dm_channel_id: "DSANDBOX2" }));
  const environment = { CONCIERGE_RUNTIME_PROFILE: "sandbox", CONCIERGE_SANDBOX_ROUTER_REPLY_MODE: "1", CONCIERGE_SANDBOX_LANE: "2", CONCIERGE_SANDBOX_FIXTURES: file };
  expect(routerReplyChannelId(environment)).toBe("DSANDBOX2");
  expect(() => routerReplyChannelId({ ...environment, CONCIERGE_SANDBOX_LANE: "3" })).toThrow("exact DM fixture");
});

test("handoff waits for stopped progress, persists update intent, and retries the same timestamp after lost acknowledgement", async () => {
  const f = fixture();
  await f.controller.start();
  const text = "TL;DR: Routed the note.\n\n[Open destination](https://example.com/route)\n\n_model: claude-test - cwd: /tmp/router_";
  markTurnDelivering(f.turn.id, text, text, 1, "Routed the note.");
  expect(() => prepareTurnReplyReplacement(f.turn.id, f.channel, routerChannel)).toThrow("finalized progress");
  await f.controller.finish("complete", 1000);
  const replacement = prepareTurnReplyReplacement(f.turn.id, f.channel, routerChannel);
  expect(replacement).toBe(getTurnProgressStream(f.turn.id)!.progress_stream_ts);
  expect(db.query("SELECT replace_message_ts, slack_ts, delivered_at FROM turn_delivery_chunks WHERE turn_id=?").get(f.turn.id))
    .toEqual({ replace_message_ts: replacement, slack_ts: null, delivered_at: null });
  recordDeliveryAttempt(f.turn.id, null);
  const pending = { client: f.client, channel: f.channel, threadTs: f.root, text, replaceFirstMessageTs: replacement, idempotencyKey: `turn:${f.turn.id}:outcome` };
  await postLongReply(pending);
  // Slack accepted the update, but the process died before recording its receipt.
  const recovered = prepareTurnReplyReplacement(f.turn.id, f.channel, routerChannel);
  expect(recovered).toBe(replacement);
  await postLongReply({ ...pending, replaceFirstMessageTs: recovered,
    onChunkPosted: (index, ts) => markDeliveryChunkDelivered(f.turn.id, index, ts) });
  expect(f.calls.filter(c => c.method === "chat.postMessage")).toHaveLength(1);
  expect(f.calls.slice(-2).map(c => ({ method: c.method, ts: c.args.ts, text: c.args.text })))
    .toEqual(Array.from({ length: 2 }, () => ({ method: "chat.update", ts: replacement, text: toMrkdwn(finalReplyChunks(text)[0]!.text) })));
  expect(f.calls.at(-1)!.args.blocks.every((block: any) => block.type !== "task_card")).toBeTrue();
  expect(f.calls.at(-1)!.args).not.toHaveProperty("client_msg_id");
  expect(deliveredChunkIndexes(f.turn.id)).toEqual(new Set([0]));
  markTurnResponseDelivered(f.turn.id);
  finishDeliveredTurn(f.turn.id);
  const firstCallCount = f.calls.length;
  const later = fixture(routerChannel, f.session.id);
  await later.controller.start();
  later.controller.recordProgress({ type: "commentary", text: "Processing the next note" });
  await later.controller.flush(true);
  f.controller.recordProgress({ type: "commentary", text: "stale heartbeat" });
  await f.controller.flush(true);
  await projectAgentProgressMessages(f.client, f.turn.id);
  expect(f.calls).toHaveLength(firstCallCount);
  expect(db.query("SELECT response_tldr, delivery_status FROM turns WHERE id=?").get(f.turn.id))
    .toEqual({ response_tldr: "Routed the note.", delivery_status: "delivered" });
  await later.controller.finish("cancelled");
});

test("steered replies replace the latest owned page, and other channels retain separate final replies", async () => {
  for (const channel of [routerChannel, "DOTHERDM", "COTHERCHANNEL"]) {
    const f = fixture(channel);
    await f.controller.start();
    queueAgentProgressMessages(f.turn.id, [{ type: "steering_boundary", id: "guidance" }, { type: "markdown_text", text: "Following guidance" }]);
    await projectAgentProgressMessages(f.client, f.turn.id);
    markTurnDelivering(f.turn.id, "TL;DR: Complete.");
    await f.controller.finish("complete");
    const replacement = prepareTurnReplyReplacement(f.turn.id, channel, routerChannel);
    const pages = db.query("SELECT message_ts FROM agent_progress_messages WHERE turn_id=? ORDER BY page_number").all(f.turn.id) as any[];
    expect(pages).toHaveLength(2);
    expect(replacement).toBe(channel === routerChannel ? pages[1].message_ts : null);
    await postLongReply({ client: f.client, channel, threadTs: f.root, text: "TL;DR: Complete.", replaceFirstMessageTs: replacement });
    expect(f.calls.at(-1)!.method).toBe(channel === routerChannel ? "chat.update" : "chat.postMessage");
  }
});

test("long answers reuse their first message and retain durable continuation delivery", async () => {
  const calls: Array<{ method: string; args: any }> = [];
  const client = { apiCall: async (method: string, args: any) => { calls.push({ method, args }); return { ts: args.ts || "continuation" }; } };
  const text = "TL;DR: Detailed reply.\n\n" + "A complete paragraph.\n\n".repeat(200);
  const input = { client, channel: routerChannel, threadTs: "root", text, replaceFirstMessageTs: "progress", idempotencyKey: "router-long" };
  await postLongReply(input);
  expect(calls[0]!.method).toBe("chat.update");
  expect(calls.length).toBeGreaterThan(1);
  expect(calls.slice(1).every(c => c.method === "chat.postMessage" && c.args.client_msg_id && c.args.thread_ts === "root")).toBeTrue();
  const continuationIds = calls.slice(1).map(c => c.args.client_msg_id);
  calls.length = 0;
  await postLongReply({ ...input, skipChunkIndexes: new Set([0]) });
  expect(calls.map(c => c.args.client_msg_id)).toEqual(continuationIds);
  const failureClient = { apiCall: async () => { throw Object.assign(new Error("message_not_found"), { data: { error: "message_not_found" } }); } };
  await expect(postLongReply({ ...input, client: failureClient })).rejects.toThrow("message_not_found");
});
