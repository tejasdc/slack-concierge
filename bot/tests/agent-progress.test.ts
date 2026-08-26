import { describe, expect, test } from "bun:test";
import { AgentProgressController, progressActivityIdAfterChunks, type SlackAgentProgressChunk } from "../src/agent-progress";

type TaskChunk = Extract<SlackAgentProgressChunk, { type: "task_update" }>;

function progressHarness(streamTs = "progress-layout", resume?: { streamTs: string; activityId: string | null }) {
  const chunks: SlackAgentProgressChunk[] = [];
  const controller = new AgentProgressController({
    resume,
    flushDelayMs: 60_000,
    start: async (batch) => { chunks.push(...batch); return streamTs; },
    append: async (_ts, batch) => { chunks.push(...batch); },
    stop: async (_ts, batch) => { chunks.push(...batch); },
  });
  const timeline = () => {
    const rendered: SlackAgentProgressChunk[] = [];
    for (const chunk of chunks) {
      const index = chunk.type === "task_update"
        ? rendered.findIndex((prior) => prior.type === "task_update" && prior.id === chunk.id)
        : -1;
      if (index < 0) rendered.push(chunk);
      else rendered[index] = chunk;
    }
    return rendered;
  };
  return { controller, chunks, timeline };
}

describe("AgentProgressController", () => {
  test("flushes progress accumulated behind an in-flight write before pausing for retry", async () => {
    let releaseWrite!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const batches: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "100.1",
      append: async (_, chunks) => { batches.push(chunks); if (batches.length === 1) await blocked; },
      stop: async () => {},
    });
    await controller.start();
    controller.recordProgress({ type: "commentary", text: "First" });
    const first = controller.flush();
    await Promise.resolve();
    controller.recordProgress({ type: "commentary", text: "Second" });
    const pausing = controller.pauseForRetry();
    releaseWrite();
    await Promise.all([first, pausing]);
    expect(batches.flat().filter((c) => c.type === "markdown_text").map((c) => c.text)).toEqual(["First", "\n\nSecond"]);
  });

  test("reuses one card for Thinking, Thinking, and Work complete without intervening text", async () => {
    const { controller, timeline } = progressHarness();
    await controller.start();
    controller.recordProgress({ type: "started" });
    await controller.flush();
    controller.recordProgress({ type: "activity", itemId: "reasoning-1", title: "Thinking", status: "in_progress" });
    await controller.flush();
    controller.recordProgress({ type: "activity", itemId: "reasoning-1", title: "Thinking", status: "complete" });
    await controller.flush();
    await controller.finish("complete");

    expect(timeline()).toEqual([
      expect.objectContaining({ type: "task_update", title: "Work complete", status: "complete" }),
    ]);
  });

  test("reuses the activity card after commentary while plan updates remain independent", async () => {
    const starts: SlackAgentProgressChunk[][] = [];
    const appends: SlackAgentProgressChunk[][] = [];
    const stops: SlackAgentProgressChunk[][] = [];
    const targetedStreamTimestamps: string[] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async (chunks) => {
        starts.push(chunks);
        return "progress-1";
      },
      append: async (streamTs, chunks) => {
        targetedStreamTimestamps.push(streamTs);
        appends.push(chunks);
      },
      stop: async (streamTs, chunks) => {
        targetedStreamTimestamps.push(streamTs);
        stops.push(chunks);
      },
    });

    await controller.start();
    controller.recordProgress({ type: "commentary", text: "I found the lifecycle owner." });
    controller.recordProgress({
      type: "activity",
      itemId: "item-1",
      title: "Reading turn-execution.ts",
      status: "in_progress",
    });
    controller.recordProgress({
      type: "plan",
      planTitle: "Implementation plan",
      title: "Step 2/4 · Wire Slack streaming",
      status: "in_progress",
    });
    await controller.flush();
    controller.recordProgress({
      type: "activity",
      itemId: "item-1",
      title: "Reading turn-execution.ts",
      status: "complete",
    });
    controller.recordProgress({
      type: "activity",
      itemId: "item-2",
      title: "Running focused tests",
      status: "in_progress",
    });
    await controller.flush();
    await controller.finish("complete");

    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual([expect.objectContaining({
      type: "task_update",
      title: "Starting agent",
      status: "in_progress",
    })]);
    expect((starts[0][0] as any).id).not.toBe("current-activity");
    expect(appends[0]).toContainEqual({ type: "markdown_text", text: "I found the lifecycle owner." });
    const operationUpdates = [...appends.flat(), ...stops.flat()]
      .filter((chunk): chunk is Extract<SlackAgentProgressChunk, { type: "task_update" }> => (
        chunk.type === "task_update" && chunk.id.startsWith("operation-")
      ));
    const readingUpdates = operationUpdates.filter((chunk) => chunk.title === "Reading turn-execution.ts");
    const testingUpdates = operationUpdates.filter((chunk) => chunk.title === "Running focused tests");
    expect(readingUpdates.map(({ status }) => status)).toEqual(["in_progress"]);
    expect(testingUpdates.map(({ status }) => status)).toEqual(["in_progress"]);
    expect(new Set(readingUpdates.map(({ id }) => id)).size).toBe(1);
    expect(new Set(testingUpdates.map(({ id }) => id)).size).toBe(1);
    expect(readingUpdates[0].id).toBe(testingUpdates[0].id);
    expect(operationUpdates.at(-1)?.id).toBe(testingUpdates[0].id);
    expect(readingUpdates[0].id).not.toBe((starts[0][0] as TaskChunk).id);
    expect(appends.flat().filter((chunk: any) => chunk.id === "plan-progress"))
      .toEqual([
        { type: "task_update", id: "plan-progress", title: "Step 2/4 · Wire Slack streaming", status: "in_progress" },
      ]);
    expect(stops.flat()).toContainEqual(expect.objectContaining({
      type: "task_update",
      title: "Work complete",
      status: "complete",
    }));
    expect(targetedStreamTimestamps.every((streamTs) => streamTs === "progress-1")).toBe(true);
  });

  for (const flushBetweenEvents of [false, true]) {
    test(`appends activity below intervening text with flushBetweenEvents=${flushBetweenEvents}`, async () => {
      const { controller, timeline } = progressHarness();
      await controller.start();
      controller.recordProgress({ type: "started" });
      controller.recordProgress({ type: "commentary", text: "Reading the implementation." });
      if (flushBetweenEvents) await controller.flush();
      controller.recordProgress({ type: "activity", itemId: "read", title: "Reading files", status: "in_progress" });
      if (flushBetweenEvents) await controller.flush();
      controller.recordProgress({ type: "commentary", text: "Testing the correction." });
      controller.recordProgress({ type: "activity", itemId: "test", title: "Running tests", status: "in_progress" });
      if (flushBetweenEvents) await controller.flush();
      await controller.finish("complete", 1_122_000);

      expect(timeline()).toEqual([
        expect.objectContaining({ type: "task_update", title: "Thinking", status: "complete" }),
        { type: "markdown_text", text: "Reading the implementation." },
        expect.objectContaining({ type: "task_update", title: "Reading files", status: "complete" }),
        { type: "markdown_text", text: "\n\nTesting the correction." },
        expect.objectContaining({ type: "task_update", title: "Work complete · 18m 42s", status: "complete" }),
      ]);
    });
  }

  test("blank or excluded text and plan-only updates do not create activity cards", async () => {
    const { controller, timeline } = progressHarness();
    await controller.start();
    controller.recordProgress({ type: "started" });
    controller.recordProgress({ type: "commentary", text: " \n " });
    controller.recordProgress({ type: "narration", text: "not visible in progress" });
    controller.recordProgress({ type: "done", text: "separate final reply" });
    controller.recordProgress({ type: "plan", title: "Step 1/2", status: "in_progress" });
    await controller.flush();
    controller.recordProgress({ type: "tool_use", toolName: "read" });
    await controller.flush();
    controller.recordProgress({ type: "activity", itemId: "read", title: "Reading files", status: "complete" });
    await controller.finish("complete");
    expect(timeline().filter((chunk) => chunk.type === "task_update" && chunk.id !== "plan-progress"))
      .toEqual([expect.objectContaining({ title: "Work complete" })]);
  });

  test("compaction text permits one new card, including when completion follows directly", async () => {
    const { controller, timeline } = progressHarness();
    await controller.start();
    controller.recordProgress({ type: "compaction" });
    await controller.finish("complete");
    expect(timeline()).toEqual([
      expect.objectContaining({ type: "task_update", status: "complete" }),
      { type: "markdown_text", text: "_Context compacted; continuing._" },
      expect.objectContaining({ type: "task_update", title: "Work complete", status: "complete" }),
    ]);
  });

  test("older operation completion does not replace the current active operation", async () => {
    const { controller, timeline } = progressHarness();
    await controller.start();
    controller.recordProgress({ type: "activity", itemId: "old", title: "Reading files", status: "in_progress" });
    controller.recordProgress({ type: "activity", itemId: "new", title: "Running tests", status: "in_progress" });
    controller.recordProgress({ type: "activity", itemId: "old", title: "Reading files", status: "complete" });
    await controller.flush();
    expect(timeline()).toEqual([expect.objectContaining({ title: "Running tests", status: "in_progress" })]);
    await controller.finish("complete");
  });

  for (const [outcome, title, status] of [
    ["error", "Work stopped with an error", "error"],
    ["cancelled", "Stopped", "complete"],
  ] as const) {
    test(`${outcome} reuses the current card and ignores late progress`, async () => {
      const { controller, timeline, chunks } = progressHarness();
      await controller.start();
      controller.recordProgress({ type: "started" });
      await controller.finish(outcome);
      const count = chunks.length;
      controller.recordProgress({ type: "commentary", text: "late" });
      controller.recordProgress({ type: "activity", itemId: "late", title: "Thinking", status: "in_progress" });
      await controller.finish("complete");
      await controller.flush();
      expect(chunks).toHaveLength(count);
      expect(timeline()).toEqual([expect.objectContaining({ title, status })]);
    });
  }

  for (const [durationMs, title] of [
    [0, "Work complete · 0s"],
    [1_122_000, "Work complete · 18m 42s"],
    [undefined, "Work complete"],
    [null, "Work complete"],
    [-1, "Work complete"],
    [NaN, "Work complete"],
    [Infinity, "Work complete"],
  ] as const) {
    test(`completion duration ${durationMs} updates the existing card`, async () => {
      const { controller, timeline } = progressHarness();
      await controller.start();
      await controller.finish("complete", durationMs);
      expect(timeline()).toEqual([expect.objectContaining({ title, status: "complete" })]);
    });
  }

  test("concurrent turns and later turns keep separate cards and duration", async () => {
    const first = progressHarness("first");
    const second = progressHarness("second");
    await first.controller.start();
    await second.controller.start();
    first.controller.recordProgress({ type: "commentary", text: "First thread only." });
    await first.controller.finish("complete", 2_000);
    second.controller.recordProgress({ type: "started" });
    await second.controller.finish("complete", 4_000);
    first.controller.recordProgress({ type: "started" });
    const firstIds = first.chunks.filter((c): c is TaskChunk => c.type === "task_update").map(c => c.id);
    expect(second.timeline()).toEqual([expect.objectContaining({ title: "Work complete · 4s" })]);
    expect(first.timeline().at(-1)).toMatchObject({ title: "Work complete · 2s" });
    expect(second.chunks.filter((c): c is TaskChunk => c.type === "task_update").every(c => !firstIds.includes(c.id))).toBe(true);
  });

  test("does not stream narration or final-answer events as commentary", async () => {
    const appends: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "progress-2",
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async () => {},
    });
    await controller.start();
    controller.recordProgress({ type: "narration", text: "cumulative provider output" });
    controller.recordProgress({ type: "done", text: "TL;DR: final" });
    await controller.flush();
    expect(appends).toEqual([]);
  });

  test("separates commentary emitted in different streaming updates", async () => {
    const appends: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "progress-commentary-spacing",
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async () => {},
    });

    await controller.start();
    controller.recordProgress({ type: "commentary", text: "First update." });
    await controller.flush();
    controller.recordProgress({ type: "commentary", text: "Second update." });
    await controller.flush();

    const streamedCommentary = appends
      .flat()
      .filter((chunk): chunk is Extract<SlackAgentProgressChunk, { type: "markdown_text" }> => (
        chunk.type === "markdown_text"
      ))
      .map((chunk) => chunk.text)
      .join("");
    expect(streamedCommentary).toBe("First update.\n\nSecond update.");
  });

  test("splits oversized commentary without dropping text or Unicode characters", async () => {
    const appends: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "progress-commentary-chunks",
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async () => {},
    });
    const oversizedCommentary = `${"a".repeat(11_999)}😀tail`;

    await controller.start();
    controller.recordProgress({ type: "commentary", text: oversizedCommentary });
    await controller.flush();
    controller.recordProgress({ type: "commentary", text: "Next update." });
    await controller.flush();

    const streamedCommentary = appends
      .flat()
      .filter((chunk): chunk is Extract<SlackAgentProgressChunk, { type: "markdown_text" }> => (
        chunk.type === "markdown_text"
      ));
    expect(streamedCommentary.every((chunk) => Array.from(chunk.text).length <= 12_000)).toBe(true);
    expect(streamedCommentary.map((chunk) => chunk.text).join(""))
      .toBe(`${oversizedCommentary}\n\nNext update.`);
  });

  test("keeps compaction markers outside commentary spacing", async () => {
    const appends: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "progress-compaction-spacing",
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async () => {},
    });

    await controller.start();
    controller.recordProgress({ type: "commentary", text: "First update." });
    await controller.flush();
    controller.recordProgress({ type: "compaction" });
    await controller.flush();
    controller.recordProgress({ type: "commentary", text: "Second update." });
    await controller.flush();

    const streamedText = appends
      .flat()
      .filter((chunk): chunk is Extract<SlackAgentProgressChunk, { type: "markdown_text" }> => (
        chunk.type === "markdown_text"
      ))
      .map((chunk) => chunk.text);
    expect(streamedText).toEqual([
      "First update.",
      "_Context compacted; continuing._",
      "\n\nSecond update.",
    ]);
  });

  test("redacts secret-shaped values from every outbound progress chunk", async () => {
    const appends: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async () => "progress-redaction",
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async () => {},
    });
    await controller.start();
    controller.recordProgress({
      type: "commentary",
      text: [
        "Using API_TOKEN=super-secret and Bearer abc.def.ghi",
        "Authorization: Basic dXNlcjpwYXNz",
        "Webhook https://hooks.slack.com/services/T000/B000/SECRET123",
        "AWS access AKIAIOSFODNN7EXAMPLE",
      ].join("\n"),
    });
    controller.recordProgress({
      type: "plan",
      planTitle: "Deploy with password=hunter2",
      title: "Call service with sk-1234567890abcdefghijklmnop",
      status: "in_progress",
    });
    controller.recordProgress({
      type: "activity",
      itemId: "secret-tool",
      title: "Using token=do-not-send",
      status: "in_progress",
    });
    await controller.flush();

    const serialized = JSON.stringify(appends);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("1234567890abcdefghijklmnop");
    expect(serialized).not.toContain("do-not-send");
    expect(serialized).not.toContain("dXNlcjpwYXNz");
    expect(serialized).not.toContain("hooks.slack.com/services");
    expect(serialized).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(serialized).toContain("[REDACTED");
  });

  test("keeps the existing stream open across an automatic provider retry", async () => {
    let stops = 0;
    const controller = new AgentProgressController({
      start: async () => "progress-retry",
      append: async () => {},
      stop: async () => { stops += 1; },
    });
    await controller.start();
    controller.recordProgress({ type: "started" });
    await controller.pauseForRetry();
    expect(stops).toBe(0);
  });

  for (const textBeforeRetry of [false, true]) {
    test(`retry restores the previous card identity with textBeforeRetry=${textBeforeRetry}`, async () => {
      const first = progressHarness("retry-stream");
      await first.controller.start();
      first.controller.recordProgress({ type: "started" });
      if (textBeforeRetry) first.controller.recordProgress({ type: "commentary", text: "Still working." });
      await first.controller.pauseForRetry();
      const activityId = progressActivityIdAfterChunks(first.chunks);
      const second = progressHarness("retry-stream", { streamTs: "retry-stream", activityId });
      expect(await second.controller.start()).toBe("retry-stream");
      expect(second.chunks).toEqual([]);
      second.controller.recordProgress({ type: "started" });
      await second.controller.finish("complete", 2_000);
      first.chunks.push(...second.chunks);
      expect(first.timeline()).toEqual(textBeforeRetry ? [
        expect.objectContaining({ title: "Thinking", status: "complete" }),
        { type: "markdown_text", text: "Still working." },
        expect.objectContaining({ title: "Work complete · 2s", status: "complete" }),
      ] : [expect.objectContaining({ title: "Work complete · 2s", status: "complete" })]);
    });
  }

  test("plan-only updates preserve the saved activity identity while text clears it", () => {
    expect(progressActivityIdAfterChunks([
      { type: "plan_update", title: "Plan" },
      { type: "task_update", id: "plan-progress", title: "Step 1", status: "in_progress" },
    ], "existing")).toBe("existing");
    expect(progressActivityIdAfterChunks([{ type: "markdown_text", text: "Next step" }], "existing")).toBeNull();
    expect(progressActivityIdAfterChunks([{ type: "markdown_text", text: " " }], "existing")).toBe("existing");
  });

  test("propagates a terminal stream-stop failure instead of allowing final delivery", async () => {
    const controller = new AgentProgressController({
      start: async () => "progress-stop-failure",
      append: async () => {},
      stop: async () => { throw new Error("Slack could not stop the stream"); },
    });
    await controller.start();
    await expect(controller.finish("complete")).rejects.toThrow("could not stop");
  });

  test("renews long-running session lifecycle without creating progress content", async () => {
    let renewals = 0;
    const controller = new AgentProgressController({
      heartbeatIntervalMs: 5,
      start: async () => "progress-3",
      append: async () => {},
      stop: async () => {},
      renew: async () => { renewals += 1; },
    });
    await controller.start();
    await Bun.sleep(18);
    await controller.finish("complete");
    const terminalRenewals = renewals;
    await Bun.sleep(12);

    expect(terminalRenewals).toBeGreaterThan(0);
    expect(renewals).toBe(terminalRenewals);
  });

  test("waits for an in-flight lifecycle renewal before stopping the stream", async () => {
    let releaseRenewal!: () => void;
    const renewalBlocked = new Promise<void>((resolve) => { releaseRenewal = resolve; });
    let renewalStarted!: () => void;
    const started = new Promise<void>((resolve) => { renewalStarted = resolve; });
    const effects: string[] = [];
    const controller = new AgentProgressController({
      heartbeatIntervalMs: 5,
      start: async () => "progress-renewal-race",
      append: async () => {},
      renew: async () => {
        effects.push("renew-start");
        renewalStarted();
        await renewalBlocked;
        effects.push("renew-end");
      },
      stop: async () => { effects.push("stop"); },
    });
    await controller.start();
    await started;
    const finishing = controller.finish("complete");
    await Promise.resolve();
    expect(effects).toEqual(["renew-start"]);
    releaseRenewal();
    await finishing;
    expect(effects).toEqual(["renew-start", "renew-end", "stop"]);
  });
});
