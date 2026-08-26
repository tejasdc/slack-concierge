import { afterEach, beforeEach, describe, expect, test, spyOn, mock } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { paginateProgress, progressBlocks, splitRejectedProgressPage, type ProgressChunk } from "../src/agent-progress-pages";
import { createProgressMessageClient, projectAgentProgressMessages, queueAgentProgressMessages } from "../src/agent-progress-messages";
import { agentProgressSlackCall, resetAgentProgressSlackBucketsForTests } from "../src/rate-limit";
import { splitProgressMarkdown } from "../src/progress-markdown";
import { AgentProgressController, legacyProgressChunks } from "../src/agent-progress";
import { handleAgentSessionStop } from "../src/agent-session-stop";
import { ActiveTurnDispatchRegistry } from "../src/turn-dispatch-seams";
import { acquireSessionTurn, beginTurnProgressStream, cancelRunningTurnAndReleaseSession, createOrGetSession, db, getTurnProgressStream, markTurnDelivering, recordTurnProgressStreamStarted, requestTurnProgressStreamStop, upsertChannel } from "../src/state";

const task = (id = "activity", title = "Thinking", status = "in_progress"): ProgressChunk => ({ type: "task_update", id, title, status: status as any });
const markdown = (text: string): ProgressChunk => ({ type: "markdown_text", text });
const boundary = (id: string): ProgressChunk => ({ type: "steering_boundary", id });
const textOf = (chunks: ProgressChunk[]) => chunks.filter((c) => c.type === "markdown_text").map((c) => c.text).join("");
const commentary = (id: string, text: string): ProgressChunk => ({ type: "markdown_text", commentaryId: id, text });
const historyText = (blocks: any[]) => blocks.find(b => b.type === "container")?.child_blocks[0].elements
  .map((section: any) => section.elements.map((element: any) => element.text).join("")).join("\n\n") ?? "";
const activityCard = (blocks: any[]) => blocks.find(b => b.type === "task_card" && b.task_id !== "plan-progress");

describe("native progress pagination", () => {
  test("keeps provider commentary visible when compaction adds a system marker", async () => {
    let page: ProgressChunk[] = [];
    const append = async (_ts: string, chunks: ProgressChunk[]) => { page = paginateProgress(page, chunks)[0]!; };
    const controller = new AgentProgressController({ flushDelayMs: 60_000,
      start: async chunks => { page = chunks; return "1787700000.000001"; }, append, stop: append });
    await controller.start();
    controller.recordProgress({ type: "commentary", text: "Latest provider update.\nSecond line." });
    controller.recordProgress({ type: "compaction" });
    await controller.flush();
    expect(progressBlocks(page, 1_787_700_000)[0]).toEqual({ type: "markdown", text: "Latest provider update.\nSecond line." });
    expect(historyText(progressBlocks(page, 1_787_700_000))).toBe("");
    const marker = page.find(c => c.type === "markdown_text" && c.isCompaction)!;
    expect(legacyProgressChunks([marker])).toEqual([{ type: "markdown_text", text: "_Context compacted; continuing._" }]);
    await controller.finish("complete", 5_000);
    expect(progressBlocks(page)[0]).toEqual({ type: "markdown", text: "Latest provider update.\nSecond line." });
  });

  test("puts whole-turn elapsed time inside the active card without a separate date block", () => {
    const startedAt = 1_787_700_000;
    const activity = { ...task("run", "Running checks"), details: "Recent activity\n• Reading tests.ts\n• Running checks" };
    const chunks = [commentary("latest", "Verifying the change."), activity, task("plan-progress", "Step 2/2")];
    const blocks = progressBlocks(chunks, startedAt, (startedAt + 192) * 1000);
    expect(blocks.map(b => b.type)).toEqual(["markdown", "task_card", "task_card"]);
    expect(blocks.filter(b => b.type === "task_card").map(b => b.task_id)).toEqual(["run", "plan-progress"]);
    expect(blocks[1]).toEqual({
      type: "task_card", task_id: "run", title: "Running checks · 3m 12s elapsed", status: "in_progress",
      details: { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: activity.details }] }] },
    });
    const thinking = progressBlocks([task()], startedAt, (startedAt + 200) * 1000);
    expect(thinking).toEqual([{ type: "task_card", task_id: "activity", title: "Thinking · 3m 20s elapsed", status: "in_progress" }]);
    expect(blocks.at(-1)?.title).toBe("Step 2/2");
  });

  test("shows only the latest commentary with one collapsed history and the current activity and plan", () => {
    const first = "First paragraph.\nSecond line.\n\nA second paragraph with **Markdown**.";
    const earlierActivity = { ...task("read", "Reading files", "complete"), details: "Recent activity\n• Reading test.ts" };
    const currentActivity = { ...task("test", "Running tests"), details: "Recent activity\n• Running checks" };
    const chunks = [earlierActivity, commentary("first", first), task("plan-progress", "Step 1/2"),
      commentary("second", "Latest update.\nStill multiline."), currentActivity];
    const before = structuredClone(chunks);
    const blocks = progressBlocks(chunks);
    expect(blocks.map(b => b.type)).toEqual(["markdown", "container", "task_card", "task_card"]);
    expect(blocks[0]).toEqual({ type: "markdown", text: "Latest update.\nStill multiline." });
    expect(blocks[1]).toMatchObject({ title: { text: "Earlier progress" }, is_collapsible: true, default_collapsed: true });
    expect((blocks[1] as any).child_blocks).toHaveLength(1);
    expect(historyText(blocks)).toBe(first);
    expect(historyText(blocks)).not.toContain("Latest update");
    expect(blocks[2]).toMatchObject({ task_id: "test", title: "Running tests" });
    expect(blocks[3]).toMatchObject({ task_id: "plan-progress" });
    expect(chunks).toEqual(before);
  });

  test("preserves consecutive commentary boundaries while joining fragments of the same update", () => {
    let page = paginateProgress([], [commentary("first", "Old"), commentary("second", "Latest\n"), commentary("second", "paragraph")])[0]!;
    expect(progressBlocks(page)[0]).toEqual({ type: "markdown", text: "Latest\nparagraph" });
    expect(historyText(progressBlocks(page))).toBe("Old");
    page = paginateProgress(page, [commentary("third", "Newest")])[0]!;
    expect(progressBlocks(page)[0]).toEqual({ type: "markdown", text: "Newest" });
    expect(historyText(progressBlocks(page))).toBe("Old\n\nLatest\nparagraph");
    page = paginateProgress(page, [task("running", "Running checks"), task("plan-progress", "Step 2/3")])[0]!;
    expect(progressBlocks(page)[0]).toEqual({ type: "markdown", text: "Newest" });
    expect(historyText(progressBlocks(page))).toBe("Old\n\nLatest\nparagraph");
  });

  test("does not add empty history or commentary when a turn only thinks and completes", () => {
    const page = paginateProgress([task()], [task("activity", "Work complete · 4s", "complete")], true)[0]!;
    expect(progressBlocks(page)).toEqual([{ type: "task_card", task_id: "activity", title: "Work complete · 4s", status: "complete" }]);
  });

  test("does not create Earlier progress for Thinking snapshots separated by only one commentary", () => {
    const blocks = progressBlocks([task("old", "Thinking", "complete"), commentary("only", "Checking the fix."), task("active")]);
    expect(blocks.map(b => b.type)).toEqual(["markdown", "task_card"]);
    expect(historyText(blocks)).toBe("");
    expect(blocks.at(-1)).toMatchObject({ task_id: "active", status: "in_progress" });
  });

  test("keeps elapsed titles bounded and never shows a negative duration", () => {
    const blocks = progressBlocks([task("long", "🌱".repeat(240))], 100, 292_000);
    expect(Array.from(String(blocks[0]!.title))).toHaveLength(240);
    expect(String(blocks[0]!.title)).toEndWith("… · 3m 12s elapsed");
    expect(progressBlocks([task()], 100, 99_000)[0]!.title).toBe("Thinking · 0s elapsed");
  });

  test("retains Thinking and elapsed time when long commentary continues onto a text-only page", async () => {
    let pages: ProgressChunk[][] = [];
    const write = async (_ts: string, chunks: ProgressChunk[], terminal = false) => {
      const current = pages.pop() ?? [];
      pages.push(...paginateProgress(current, chunks, terminal));
    };
    const controller = new AgentProgressController({ flushDelayMs: 60_000,
      start: async chunks => { pages = [chunks]; return "100.000001"; },
      append: write, stop: (ts, chunks) => write(ts, chunks, true),
    });
    try {
      await controller.start();
      controller.recordProgress({ type: "commentary", text: "x".repeat(12_001) });
      await controller.flush();
      expect(pages).toHaveLength(2);
      const blocks = progressBlocks(pages.at(-1)!, 100, 292_000);
      expect(blocks.map(b => b.type)).toEqual(["markdown", "task_card"]);
      expect(activityCard(blocks)).toMatchObject({ title: "Thinking · 3m 12s elapsed", status: "in_progress" });
      expect(progressBlocks(pages[0]!).every(b => !String(b.title).includes("elapsed"))).toBeTrue();
      await controller.finish("complete", 193_000);
      expect(activityCard(progressBlocks(pages.at(-1)!))).toMatchObject({ title: "Work complete · 3m 13s", status: "complete" });
    } finally {
      await controller.finish("cancelled");
    }
  });

  test("counts archived activity text and hidden commentary toward the existing page budget", () => {
    const details = "🌱".repeat(6_000);
    const first = { ...task("old", "Reading", "complete"), details };
    const pages = paginateProgress([first, commentary("first", "a".repeat(6_000))], [task("new"), commentary("latest", "Visible")]);
    expect(pages).toHaveLength(2);
    expect(pages.flat().some(c => c.type === "task_update" && c.details === details)).toBeTrue();
    expect(pages.map(textOf).join("")).toBe("a".repeat(6_000) + "Visible");
    const hidden = paginateProgress([commentary("old", "a".repeat(11_999))], [commentary("latest", "xx")]);
    expect(hidden).toHaveLength(2);
    expect(hidden.map(textOf).join("")).toBe("a".repeat(11_999) + "xx");
  });

  test("renders native expandable details and carries the latest plan through overflow", () => {
    const plan = { ...task("plan-progress", "Step 1/2"), details: "→ Inspect\n○ Verify" };
    const activity = { ...task("reading", "Reading AGENTS.md"), details: "Recent activity\n• Reading AGENTS.md" };
    const pages = paginateProgress([plan, activity, markdown("a".repeat(12_000))], [markdown("Next"), { ...plan, title: "Step 2/2", details: "✓ Inspect\n→ Verify" }]);
    expect(pages).toHaveLength(2);
    expect(progressBlocks(pages[1]!).at(-1)).toMatchObject({
      type: "task_card", task_id: "plan-progress", title: "Step 2/2",
      details: { type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "✓ Inspect\n→ Verify" }] }] },
    });
    const finished = paginateProgress(pages[1]!, [task("reading", "Work complete", "complete")], true);
    expect(finished[0]!.find(c => c.type === "task_update" && c.id === "reading"))
      .toMatchObject({ status: "complete", details: activity.details });
  });

  test("keeps the expandable plan last after every new text and activity update", () => {
    const plan = { ...task("plan-progress", "Step 1/2"), details: "→ Inspect\n○ Verify" };
    let page = paginateProgress([], [plan, markdown("First"), task()])[0]!;
    page = paginateProgress(page, [markdown("Second"), task("next")])[0]!;
    expect(progressBlocks(page).at(-1)).toMatchObject({ task_id: "plan-progress", details: expect.any(Object) });
    page = paginateProgress(page, [{ ...plan, title: "Step 2/2", details: "✓ Inspect\n→ Verify" }], true)[0]!;
    expect(progressBlocks(page).at(-1)).toMatchObject({ task_id: "plan-progress", title: "Step 2/2", status: "complete" });
  });

  test("freezes earlier output at a steering boundary and carries the plan to a new page", () => {
    const plan = { ...task("plan-progress", "Step 1/2"), details: "→ Inspect\n○ Verify" };
    const pages = paginateProgress([markdown("Before"), plan, task()], [boundary("steer-1"), markdown("After"), task("new"), { ...plan, title: "Step 2/2" }]);
    expect(pages.map(textOf)).toEqual(["Before", "After"]);
    expect(progressBlocks(pages[0]!).at(-1)).toMatchObject({ title: "Step 1/2 · continued below", status: "complete" });
    expect(progressBlocks(pages[1]!).at(-1)).toMatchObject({ title: "Step 2/2", details: expect.any(Object) });
    expect(progressBlocks(pages[1]!).some(b => b.type === "steering_boundary")).toBeFalse();
    const overflow = paginateProgress(pages[1]!, [markdown("x".repeat(12_000))]);
    expect(overflow).toHaveLength(2);
    expect(paginateProgress(overflow[1]!, [boundary("steer-1")])).toHaveLength(1);
    const split = splitRejectedProgressPage(overflow[1]!);
    expect(paginateProgress(split.at(-1)!, [boundary("steer-1")])).toHaveLength(1);
  });

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
    expect(progressBlocks(pages[0]!).at(-1)).toMatchObject({ type: "task_card", task_id: "plan-progress", title: "Step 2/5" });
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
    expect(Array.from((progressBlocks(pages[0]!).at(-1) as any).title)).toHaveLength(240);
    expect((progressBlocks(pages[0]!).at(-1) as any).title.endsWith(" · continued below")).toBeTrue();
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

  test("splits the visible commentary on translated-block rejection rather than unrelated hidden history", () => {
    const old = commentary("old", "Archived paragraph. ".repeat(30));
    const latest = commentary("latest", "Visible paragraph.\n\n".repeat(60));
    const pages = splitRejectedProgressPage([old, task("plan-progress"), latest]);
    expect(pages).toHaveLength(2);
    expect(pages[0]![0]).toEqual(old);
    expect(pages[1]!.some(c => c.type === "markdown_text" && c.commentaryId === "old")).toBeFalse();
    expect(pages.map(textOf).join("")).toBe(textOf([old, latest]));
    expect(pages.flat().filter(c => c.type === "markdown_text" && c.commentaryId === "latest")).toHaveLength(2);
  });
});

let release: (() => void) | undefined;
beforeEach(async () => {
  release = await acquireDatabaseTestLock();
  resetAgentProgressSlackBucketsForTests();
});
afterEach(() => { mock.restore(); release?.(); });

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
  test("projects compact history at one timestamp through updates, terminal retry, and a later turn", async () => {
    const { turnId } = createTurn();
    const { client, calls } = fakeSlack();
    const write = async (chunks: ProgressChunk[], terminal = false) => {
      queueAgentProgressMessages(turnId, chunks, terminal);
      await projectAgentProgressMessages(client, turnId);
    };
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async chunks => { await write(chunks); return getTurnProgressStream(turnId)!.progress_stream_ts!; },
      append: async (_, chunks) => write(chunks),
      stop: async (_, chunks) => { requestTurnProgressStreamStop(turnId); await write(chunks, true); },
    });
    await controller.start();
    controller.recordProgress({ type: "commentary", text: "Old paragraph.\nSecond line. password=hidden" });
    controller.recordProgress({ type: "commentary", text: "Current paragraph.\nSecond line." });
    controller.recordProgress({ type: "activity", itemId: "test", title: "Running checks", status: "in_progress" });
    controller.recordProgress({ type: "plan", title: "Step 2/2", details: "✓ Inspect\n→ Verify", status: "in_progress" });
    await controller.flush();
    const live = calls.at(-1)!.args.blocks;
    expect(live[0]).toEqual({ type: "markdown", text: "\n\nCurrent paragraph.\nSecond line." });
    expect(live.filter((b: any) => b.type === "task_card")).toHaveLength(2);
    expect(activityCard(live)).toMatchObject({ title: expect.stringMatching(/^Running checks · .* elapsed$/), status: "in_progress" });
    expect(live.some((b: any) => b.type === "rich_text")).toBeFalse();
    expect(historyText(live)).toContain("Old paragraph.\nSecond line. password=[REDACTED]");
    expect(JSON.stringify(live)).not.toContain("hidden");
    await controller.finish("complete", 12_000);
    expect(calls.filter(c => c.method === "chat.postMessage")).toHaveLength(1);
    const firstTs = getTurnProgressStream(turnId)!.progress_stream_ts;
    expect(calls.filter(c => c.method === "chat.update").every(c => c.args.ts === firstTs)).toBeTrue();
    const terminal = structuredClone(calls.at(-1)!.args.blocks);
    expect(activityCard(terminal)?.title).not.toContain("elapsed");
    expect(terminal[2]).toMatchObject({ title: "Work complete · 12s", status: "complete" });
    expect(terminal.at(-1)).toMatchObject({ task_id: "plan-progress", status: "complete" });
    db.query("UPDATE agent_progress_messages SET dirty=1 WHERE turn_id=?").run(turnId);
    queueAgentProgressMessages(turnId, [commentary("late", "Must not replace final progress")]);
    await projectAgentProgressMessages(client, turnId);
    expect(calls.at(-1)!.args.blocks).toEqual(terminal);
    const next = createTurn();
    queueAgentProgressMessages(next.turnId, [commentary("next", "Different turn"), task("next-activity")]);
    await projectAgentProgressMessages(client, next.turnId);
    expect(calls.at(-1)!.args.blocks).not.toContainEqual(terminal[1]);
    expect(getTurnProgressStream(turnId)!.progress_stream_ts).toBe(firstTs);
  });

  test("keeps the first progress timestamp across steps, steering, replay, and capacity rollover", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(100_000);
    const { turnId } = createTurn();
    const { client, calls } = fakeSlack();
    // Queue time is not running time; the first progress post is the anchor.
    db.query("UPDATE turns SET started_at='2000-01-01 00:00:00' WHERE id=?").run(turnId);
    queueAgentProgressMessages(turnId, [task()]);
    await projectAgentProgressMessages(client, turnId);
    expect(activityCard(calls[0]!.args.blocks)?.title).toBe("Thinking · 0s elapsed");
    const startedAt = Math.floor(Number(getTurnProgressStream(turnId)!.progress_stream_ts));
    clock.mockReturnValue((startedAt + 192) * 1000);
    for (const additions of [
      [commentary("one", "Checking."), task("check", "Running checks")],
      [boundary("steered"), task("new-step", "Reading files")],
      [commentary("long", "x".repeat(12_001))],
    ]) {
      queueAgentProgressMessages(turnId, additions);
      await projectAgentProgressMessages(client, turnId);
      expect(activityCard(calls.at(-1)!.args.blocks)?.title).toEndWith(" · 3m 12s elapsed");
      expect(calls.at(-1)!.args.blocks.some((b: any) => b.type === "task_card" && b.status === "in_progress")).toBeTrue();
    }
    db.query("UPDATE agent_progress_messages SET dirty=1 WHERE turn_id=?").run(turnId);
    const replayStart = calls.length;
    await projectAgentProgressMessages(client, turnId);
    expect(calls.slice(replayStart, -1).every(c => !activityCard(c.args.blocks)?.title.includes("elapsed"))).toBeTrue();
    expect(activityCard(calls.at(-1)!.args.blocks)?.title).toEndWith(" · 3m 12s elapsed");
    queueAgentProgressMessages(turnId, [task("new-step", "Stopped", "complete")], true);
    await projectAgentProgressMessages(client, turnId);
    expect(activityCard(calls.at(-1)!.args.blocks)?.title).not.toContain("elapsed");
    expect(calls.at(-1)!.args.blocks.at(-1)).toMatchObject({ title: "Stopped", status: "complete" });
  });

  test("refreshes elapsed time on the same message without new commentary or history", async () => {
    const clock = spyOn(Date, "now").mockReturnValue(100_000);
    const { turnId } = createTurn();
    const { client, calls } = fakeSlack();
    queueAgentProgressMessages(turnId, [task()]);
    await projectAgentProgressMessages(client, turnId);
    const chunks = db.query("SELECT chunks_json FROM agent_progress_messages WHERE turn_id=?").get(turnId);
    clock.mockReturnValue(130_000);
    queueAgentProgressMessages(turnId, []);
    await projectAgentProgressMessages(client, turnId);
    expect(calls.map(c => c.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(calls[1]!.args.ts).toBe(getTurnProgressStream(turnId)!.progress_stream_ts);
    expect(calls[1]!.args.blocks).toEqual([{ type: "task_card", task_id: "activity", title: "Thinking · 30s elapsed", status: "in_progress" }]);
    expect(db.query("SELECT chunks_json FROM agent_progress_messages WHERE turn_id=?").get(turnId)).toEqual(chunks);
    queueAgentProgressMessages(turnId, [task("activity", "Work complete · 31s", "complete")], true);
    await projectAgentProgressMessages(client, turnId);
    const terminalCalls = calls.length;
    queueAgentProgressMessages(turnId, []);
    await projectAgentProgressMessages(client, turnId);
    expect(calls).toHaveLength(terminalCalls);
  });

  test("posts once after steering, then edits only that new reply and preserves its durable identity", async () => {
    const turn = createTurn();
    const { calls, client } = fakeSlack();
    queueAgentProgressMessages(turn.turnId, [markdown("Before guidance"), task(), task("plan-progress")]);
    await projectAgentProgressMessages(client, turn.turnId);
    const firstTs = calls[0]!.args.ts ?? getTurnProgressStream(turn.turnId)!.progress_stream_ts;
    queueAgentProgressMessages(turn.turnId, [boundary("accepted-guidance"), markdown("After guidance"), task("new")]);
    await projectAgentProgressMessages(client, turn.turnId);
    expect(calls.map(c => c.method)).toEqual(["chat.postMessage", "chat.update", "chat.postMessage"]);
    expect(calls[1]!.args.ts).toBe(firstTs);
    expect(calls[1]!.args.blocks.filter((b: any) => b.type === "markdown")).toEqual([{ type: "markdown", text: "Before guidance" }]);
    expect(calls[2]!.args.thread_ts).toBe(turn.threadTs);
    const newIdentity = calls[2]!.args.client_msg_id;
    queueAgentProgressMessages(turn.turnId, [boundary("accepted-guidance"), markdown(" More"), task("plan-progress", "Step 2/2")]);
    await projectAgentProgressMessages(client, turn.turnId);
    expect(calls.map(c => c.method)).toEqual(["chat.postMessage", "chat.update", "chat.postMessage", "chat.update"]);
    expect(calls[3]!.args.ts).not.toBe(firstTs);
    expect(calls[3]!.args.blocks.at(-1)).toMatchObject({ task_id: "plan-progress", title: "Step 2/2" });
    expect(calls[3]!.args.blocks.filter((b: any) => b.type === "markdown")).toEqual([{ type: "markdown", text: " More" }]);
    expect(historyText(calls[3]!.args.blocks)).toContain("After guidance");
    expect(newIdentity).toBeTruthy();
  });
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
