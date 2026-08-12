import { describe, expect, test } from "bun:test";
import { TurnStatusController, type TurnStatusUpdate } from "../src/turn-status-controller";

describe("TurnStatusController", () => {
  test("keeps live heartbeats on the current turn and terminates that status in place", async () => {
    let now = 1_000;
    const updates: TurnStatusUpdate[] = [];
    const controller = new TurnStatusController({
      startedAt: now,
      now: () => now,
      updateHeartbeat: async (update) => { updates.push(update); },
      projectTerminal: async (update) => { updates.push(update); return "delivered"; },
    });

    controller.start();
    now = 5_000;
    controller.recordProgress({ type: "tool_use", toolName: "exec" });
    now = 31_000;
    await controller.refresh();
    await controller.complete({
      elapsedMs: 32_000,
      toolCount: 1,
      provider: "codex",
      tldr: "Completed the current request",
    });

    expect(updates).toEqual([
      {
        phase: "heartbeat",
        text: "Status: working - 30s elapsed, last update 26s ago, 1 tool call",
      },
      {
        phase: "done",
        text: "TL;DR: Completed the current request.\n\nStatus: done - 32s elapsed, 1 tool call, provider codex",
      },
    ]);
  });

  test("never lets a late heartbeat overwrite a terminal status", async () => {
    let releaseHeartbeat!: () => void;
    const updates: TurnStatusUpdate[] = [];
    const controller = new TurnStatusController({
      updateHeartbeat: async (update) => {
        await new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
        updates.push(update);
      },
      projectTerminal: async (update) => { updates.push(update); return "delivered"; },
    });

    const heartbeat = controller.refresh();
    await Promise.resolve();
    const completion = controller.complete({
      elapsedMs: 1_000,
      toolCount: 0,
      provider: "codex",
      tldr: "Done",
    });
    await Promise.resolve();

    expect(updates).toEqual([]);
    releaseHeartbeat();
    await heartbeat;
    await completion;
    await controller.refresh();

    expect(updates.map((update) => update.phase)).toEqual(["heartbeat", "done"]);
  });

  test("reports an update failure without breaking later status transitions", async () => {
    const failures: string[] = [];
    const phases: string[] = [];
    const controller = new TurnStatusController({
      updateHeartbeat: async (update) => {
        phases.push(update.phase);
        throw new Error("temporary Slack failure");
      },
      projectTerminal: async (update) => { phases.push(update.phase); return "delivered"; },
      onError: (error, phase) => failures.push(`${phase}:${String(error)}`),
    });

    await controller.refresh();
    await controller.fail("Status: error - provider failed");

    expect(phases).toEqual(["heartbeat", "error"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("heartbeat:Error: temporary Slack failure");
  });

  test("returns terminal projection outcomes instead of swallowing them", async () => {
    const controller = new TurnStatusController({
      updateHeartbeat: async () => {},
      projectTerminal: async () => "stopped",
    });

    expect(await controller.complete({
      elapsedMs: 1,
      toolCount: 0,
      provider: "codex",
      tldr: "Done",
    })).toBe("stopped");
  });
});
