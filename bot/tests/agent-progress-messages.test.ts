import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { paginateProgress, progressBlocks, splitRejectedProgressPage, type ProgressChunk } from "../src/agent-progress-pages";
import { createProgressMessageClient, projectAgentProgressMessages, queueAgentProgressMessages } from "../src/agent-progress-messages";
import { agentProgressSlackCall, resetAgentProgressSlackBucketsForTests } from "../src/rate-limit";
import { splitProgressMarkdown } from "../src/progress-markdown";
import { handleAgentSessionStop } from "../src/agent-session-stop";
import { ActiveTurnDispatchRegistry } from "../src/turn-dispatch-seams";
import { acquireSessionTurn, beginTurnProgressStream, cancelRunningTurnAndReleaseSession, createOrGetSession, db, getTurnProgressStream, markTurnDelivering, recordTurnProgressStreamStarted, requestTurnProgressStreamStop, upsertChannel } from "../src/state";

const task = (id = "activity", title = "Thinking", status = "in_progress"): ProgressChunk => ({ type: "task_update", id, title, status: status as any });
const markdown = (text: string): ProgressChunk => ({ type: "markdown_text", text });
const textOf = (chunks: ProgressChunk[]) => chunks.filter((c) => c.type === "markdown_text").map((c) => c.text).join("");

describe("native progress pagination", () => {
  test("keeps long fenced code formatted across message boundaries", () => {
    const code = "const plant = '🌱';\n".repeat(1_000);
    const text = "```typescript\n" + code + "```";
    const chars = Array.from(text);
    const streamed = [markdown(chars.slice(0, 12_000).join("")), markdown(chars.slice(12_000).join(""))];
    const pages = paginateProgress([], streamed);
    const pieces = pages.map(textOf);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.startsWith("```typescript\n") && p.endsWith("```") && Array.from(p).length <= 12_000)).toBeTrue();
    expect(pieces.map((p) => p.replace(/^```typescript\n/, "").replace(/```$/, "")).join("")).toBe(code);
  });

  test("repeats table headers at continuation boundaries", () => {
    const header = "| A | B |\n| --- | --- |\n";
    const rows = "| one | two |\n".repeat(100);
    const parts = splitProgressMarkdown(header + rows, 200);
    expect(parts.every((p) => p.startsWith(header) && p.length <= 200)).toBeTrue();
    expect(parts.map((p) => p.slice(header.length)).join("")).toBe(rows);
  });
  test("updates activity and planning cards in place, below intervening text", () => {
    const pages = paginateProgress([task(), markdown("Preview"), task("after-text"), task("plan-progress", "Step 1/5")], [task("after-text", "Using tool"), task("plan-progress", "Step 2/5")]);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual([task(), markdown("Preview"), task("after-text", "Using tool"), task("plan-progress", "Step 2/5")]);
    expect(progressBlocks(pages[0]!)[3]).toMatchObject({ type: "task_card", task_id: "plan-progress", title: "Step 2/5" });
  });

  test("rolls over at the cumulative Markdown limit and carries the plan", () => {
    const first = "🌱".repeat(12_000);
    const pages = paginateProgress([task("plan-progress", "Step 1/5"), markdown(first)], [markdown("\n\nMore"), task("plan-progress", "Step 2/5"), task("latest")]);
    expect(pages).toHaveLength(2);
    expect(pages.map(textOf).join("")).toBe(first + "\n\nMore");
    expect(pages[0]![0]).toMatchObject({ status: "complete", title: "Step 1/5 · continued below" });
    expect(pages[1]![0]).toEqual(task("plan-progress", "Step 2/5"));
    const terminal = paginateProgress(pages[1]!, [task("latest", "Work complete · 10m", "complete")], true);
    expect(terminal[0]!.filter((c) => c.type === "task_update").every((c: any) => c.status === "complete")).toBeTrue();
  });

  test("continuation labels stay inside the existing task-title limit", () => {
    const pages = paginateProgress([task("plan-progress", "🌱".repeat(240)), markdown("a".repeat(12_000))], [markdown("next")]);
    expect(Array.from((progressBlocks(pages[0]!)[0] as any).title)).toHaveLength(240);
    expect((progressBlocks(pages[0]!)[0] as any).title.endsWith(" · continued below")).toBeTrue();
  });

  test("rolls over at 50 blocks and finishes without a stranded spinner", () => {
    const current = Array.from({ length: 49 }, (_, i) => task(String(i), "Done", "complete"));
    current.push(task("plan-progress", "Step 4/5"));
    const pages = paginateProgress(current, [markdown("Last preview"), task("done", "Work complete", "complete")], true);
    expect(pages).toHaveLength(2);
    expect(pages.every((page) => progressBlocks(page).length <= 50)).toBeTrue();
    expect(pages.flat().filter((c) => c.type === "task_update" && c.status === "in_progress")).toHaveLength(0);
  });

  test("repartitions translated-block overflow with strictly smaller text and intact Unicode", () => {
    const text = "🌱\n\n---\n\n".repeat(100);
    const pages = splitRejectedProgressPage([task("plan-progress"), markdown(text)]);
    expect(pages.map(textOf).join("")).toBe(text);
    expect(pages.every((page) => textOf(page).length < text.length)).toBeTrue();
    expect(pages[1]![0]).toEqual(task("plan-progress"));
  });
});

let release: (() => void) | undefined;
beforeEach(async () => {
  release = await acquireDatabaseTestLock();
  resetAgentProgressSlackBucketsForTests();
});
afterEach(() => { release?.(); });

function createTurn() {
  const unique = crypto.randomUUID();
  const channel = `C-progress-${unique}`;
  upsertChannel({ slack_channel_id: channel, slack_channel_name: unique, group_name: null, name: unique, vault_path: "/tmp/progress", code_path: "/tmp/progress" });
  const session = createOrGetSession(channel, "100.000001", "codex");
  const turn = acquireSessionTurn(session.id, "100.000001", "test", "runtime", undefined, "100.000001", { userId: "U1", projectionMode: "agent" });
  beginTurnProgressStream(turn.id);
  return { turnId: turn.id, sessionId: session.id, channel, threadTs: "100.000001" };
}

function fakeSlack() {
  const calls: { method: string; args: any }[] = [];
  const client = { apiCall: async (method: string, args: any) => {
    calls.push({ method, args: structuredClone(args) });
    return { ok: true, ts: args.ts ?? `100.${String(calls.length + 10).padStart(6, "0")}` };
  } };
  return { calls, client };
}

describe("durable progress messages", () => {
  test("the production Slack client makes one attempt on server failure, without hidden SDK reposts", async () => {
    let requests = 0;
    const client = createProgressMessageClient("test-token", { adapter: async (config) => {
      requests++;
      return { status: 500, statusText: "Internal Server Error", data: "failed", headers: { "retry-after": "1" }, config };
    } });
    await expect(agentProgressSlackCall(client, "chat.postMessage", { channel: "C1", text: "test" })).rejects.toThrow();
    expect(requests).toBe(1);
  });

  test("only explicit rate-limit rejection permits a progress post retry", async () => {
    let requests = 0;
    const client = { apiCall: async () => {
      requests++;
      return requests === 1 ? { ok: false, error: "ratelimited", retry_after: 0.001 } : { ok: true, ts: "1.0" };
    } };
    expect(await agentProgressSlackCall(client, "chat.postMessage", { channel: "C1", text: "test" })).toMatchObject({ ok: true });
    expect(requests).toBe(2);
  });

  test("keeps updating the same message, then continues with the plan in the same thread", async () => {
    const turn = createTurn();
    const { calls, client } = fakeSlack();
    queueAgentProgressMessages(turn.turnId, [task(), task("plan-progress", "Step 1/5")]);
    await projectAgentProgressMessages(client, turn.turnId);
    const firstTs = getTurnProgressStream(turn.turnId)!.progress_stream_ts;
    queueAgentProgressMessages(turn.turnId, [task("plan-progress", "Step 2/5"), markdown("a".repeat(12_000))]);
    await projectAgentProgressMessages(client, turn.turnId);
    expect(calls[1]!.method).toBe("chat.update");
    expect(calls[1]!.args.ts).toBe(firstTs);
    queueAgentProgressMessages(turn.turnId, [markdown("More"), task("plan-progress", "Step 3/5")]);
    await projectAgentProgressMessages(client, turn.turnId);
    expect(calls.map((c) => c.method)).toEqual(["chat.postMessage", "chat.update", "chat.update", "chat.postMessage"]);
    expect(calls.at(-1)!.args.thread_ts).toBe(turn.threadTs);
    expect(calls.at(-1)!.args.blocks).toContainEqual(expect.objectContaining({ task_id: "plan-progress", title: "Step 3/5", status: "in_progress" }));
    expect(getTurnProgressStream(turn.turnId)!.progress_stream_ts).toBe(firstTs);
  });

  test("persists desired terminal content, replays known-message edits, and never duplicates commentary", async () => {
    const { turnId } = createTurn();
    const { client, calls } = fakeSlack();
    queueAgentProgressMessages(turnId, [task()]);
    await projectAgentProgressMessages(client, turnId);
    requestTurnProgressStreamStop(turnId);
    const terminal = [markdown("Final preview"), task("result", "Work complete · 12m", "complete")];
    queueAgentProgressMessages(turnId, terminal, true);
    await expect(projectAgentProgressMessages({ apiCall: async () => { throw new Error("network"); } }, turnId)).rejects.toThrow("network");
    queueAgentProgressMessages(turnId, terminal, true);
    queueAgentProgressMessages(turnId, [task("late")]);
    await projectAgentProgressMessages(client, turnId);
    expect(calls.at(-1)!.args.blocks.filter((b: any) => b.type === "markdown")).toEqual([{ type: "markdown", text: "Final preview" }]);
    expect(calls.at(-1)!.args.blocks.some((b: any) => b.task_id === "late")).toBeFalse();
  });

  test("does not repeat a post after an ambiguous outcome, including during terminal recovery", async () => {
    const { turnId } = createTurn();
    let posts = 0;
    const client = { apiCall: async () => { posts++; throw new Error("connection lost after send"); } };
    queueAgentProgressMessages(turnId, [task()]);
    await expect(projectAgentProgressMessages(client, turnId)).rejects.toThrow("connection lost");
    await expect(projectAgentProgressMessages(client, turnId)).rejects.toThrow("ambiguous");
    expect(posts).toBe(1);
  });

  test("repartitions only Slack's explicit rendered-block overflow", async () => {
    const { turnId } = createTurn();
    const calls: any[] = [];
    const client = { apiCall: async (method: string, args: any) => {
      calls.push({ method, args });
      if (calls.length === 1) return { ok: false, error: "invalid_blocks", response_metadata: { messages: ["[ERROR] no more than 50 items allowed [json-pointer:/blocks]"] } };
      return { ok: true, ts: `100.${String(100 + calls.length).padStart(6, "0")}` };
    } };
    queueAgentProgressMessages(turnId, [task("plan-progress"), markdown("First\n\nSecond")]);
    await projectAgentProgressMessages(client, turnId);
    expect(calls).toHaveLength(3);
    expect(calls.slice(1).flatMap((c) => c.args.blocks).filter((b: any) => b.type === "markdown").map((b: any) => b.text).join("")).toBe("First\n\nSecond");
  });

  test("native Stop accepts empty streams, rejects wrong/stale identity, and wins before delivery", async () => {
    const turn = createTurn();
    const { client } = fakeSlack();
    queueAgentProgressMessages(turn.turnId, [task()]);
    await projectAgentProgressMessages(client, turn.turnId);
    let cancellations = 0;
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    const event = { channel: turn.channel, thread_ts: turn.threadTs, event_ts: "100.900000", streaming_message_ts: [] };
    await registry.run({ turnId: turn.turnId, channelId: turn.channel, threadTs: turn.threadTs }, async (_, __, cancellation) => {
      cancellation.register(async () => { cancellations++; });
      const stop = (overrides: any = {}) => handleAgentSessionStop({ event, teamId: "T1", expectedTeamId: "T1", registry, ...overrides });
      expect(await stop({ teamId: "wrong" })).toBe("ignored");
      expect(await stop({ event: { ...event, event_ts: "100.000002" } })).toBe("ignored");
      expect(await stop({ event: { ...event, thread_ts: "200.0" } })).toBe("ignored");
      expect(await stop()).toBe("cancelled");
      expect(await stop()).toBe("cancelled");
      expect(cancellations).toBe(1);
      expect(markTurnDelivering(turn.turnId, "final", "final", 1, "final")).toBeFalse();
    });
  });

  test("a delayed Stop cannot cancel a successor or a different live thread", async () => {
    const prior = createTurn();
    recordTurnProgressStreamStarted(prior.turnId, "100.100000");
    cancelRunningTurnAndReleaseSession(prior.turnId, "runtime", "test complete");
    const next = acquireSessionTurn(prior.sessionId, "100.200000", "next", "runtime", undefined, prior.threadTs, { userId: "U1", projectionMode: "agent" });
    beginTurnProgressStream(next.id);
    recordTurnProgressStreamStarted(next.id, "100.800000");
    const other = createTurn();
    recordTurnProgressStreamStarted(other.turnId, "100.100000");
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    let nextCancelled = 0;
    let otherCancelled = 0;
    await registry.run({ turnId: next.id, channelId: prior.channel, threadTs: prior.threadTs }, async (_, __, cancellation) => {
      cancellation.register(async () => { nextCancelled++; });
      await registry.run({ turnId: other.turnId, channelId: other.channel, threadTs: other.threadTs }, async (_, __, otherCancellation) => {
        otherCancellation.register(async () => { otherCancelled++; });
        const send = (event_ts: string) => handleAgentSessionStop({ event: { channel: prior.channel, thread_ts: prior.threadTs, event_ts, streaming_message_ts: [] }, teamId: "T1", expectedTeamId: "T1", registry });
        expect(await send("100.700000")).toBe("ignored");
        expect(nextCancelled).toBe(0);
        expect(await send("100.900000")).toBe("cancelled");
        expect(nextCancelled).toBe(1);
        expect(otherCancelled).toBe(0);
      });
    });
  });

  test("Stop survives rollover and early admission, but cannot take ownership after delivery", async () => {
    const turn = createTurn();
    const { client } = fakeSlack();
    queueAgentProgressMessages(turn.turnId, [markdown("a".repeat(12_000))]);
    await projectAgentProgressMessages(client, turn.turnId);
    queueAgentProgressMessages(turn.turnId, [markdown("next page")]);
    await projectAgentProgressMessages(client, turn.turnId);
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    await registry.run({ turnId: turn.turnId, channelId: turn.channel, threadTs: turn.threadTs }, async (_, __, cancellation) => {
      const stopped = handleAgentSessionStop({ event: { channel: turn.channel, thread_ts: turn.threadTs, event_ts: "100.900000", streaming_message_ts: [] }, teamId: "T1", expectedTeamId: "T1", registry });
      let cancelled = false;
      cancellation.register(async () => { cancelled = true; });
      expect(await stopped).toBe("cancelled");
      expect(cancelled).toBeTrue();
    });
    const delivered = createTurn();
    recordTurnProgressStreamStarted(delivered.turnId, "100.100000");
    expect(markTurnDelivering(delivered.turnId, "final", "final", 1, "final")).toBeTrue();
    await registry.run({ turnId: delivered.turnId, channelId: delivered.channel, threadTs: delivered.threadTs }, async () => {
      expect(await handleAgentSessionStop({ event: { channel: delivered.channel, thread_ts: delivered.threadTs, event_ts: "100.900000" }, teamId: "T1", expectedTeamId: "T1", registry })).toBe("ignored");
    });
  });
});
