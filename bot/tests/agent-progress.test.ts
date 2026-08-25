import { describe, expect, test } from "bun:test";
import { AgentProgressController, type SlackAgentProgressChunk } from "../src/agent-progress";

describe("AgentProgressController", () => {
  test("keeps commentary and replaces two stable task cards", async () => {
    const starts: SlackAgentProgressChunk[][] = [];
    const appends: SlackAgentProgressChunk[][] = [];
    const stops: SlackAgentProgressChunk[][] = [];
    const controller = new AgentProgressController({
      flushDelayMs: 60_000,
      start: async (chunks) => {
        starts.push(chunks);
        return "progress-1";
      },
      append: async (_streamTs, chunks) => { appends.push(chunks); },
      stop: async (_streamTs, chunks) => { stops.push(chunks); },
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

    expect(starts).toEqual([[
      { type: "task_update", id: "current-activity", title: "Starting agent", status: "in_progress" },
    ]]);
    expect(appends[0]).toContainEqual({ type: "markdown_text", text: "I found the lifecycle owner." });
    expect(appends.flat().filter((chunk: any) => chunk.id === "current-activity"))
      .toEqual([
        { type: "task_update", id: "current-activity", title: "Reading turn-execution.ts", status: "in_progress" },
        { type: "task_update", id: "current-activity", title: "Running focused tests", status: "in_progress" },
      ]);
    expect(appends.flat().filter((chunk: any) => chunk.id === "plan-progress"))
      .toEqual([
        { type: "task_update", id: "plan-progress", title: "Step 2/4 · Wire Slack streaming", status: "in_progress" },
      ]);
    expect(stops).toEqual([[
      { type: "task_update", id: "current-activity", title: "Work complete", status: "complete" },
    ]]);
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
