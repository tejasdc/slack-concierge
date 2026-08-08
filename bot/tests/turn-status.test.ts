import { describe, expect, test } from "bun:test";
import { TurnStatusHeartbeat } from "../src/turn-status";

describe("TurnStatusHeartbeat", () => {
  test("starts periodic refreshes and stops scheduling them", async () => {
    let firstUpdate: (() => void) | null = null;
    const sawFirstUpdate = new Promise<void>((resolve) => { firstUpdate = resolve; });
    let updateCount = 0;
    const heartbeat = new TurnStatusHeartbeat({
      intervalMs: 1,
      update: async () => {
        updateCount += 1;
        firstUpdate?.();
      },
    });

    heartbeat.start();
    await sawFirstUpdate;
    await heartbeat.stop();
    const stoppedAtCount = updateCount;
    await Bun.sleep(5);

    expect(stoppedAtCount).toBeGreaterThan(0);
    expect(updateCount).toBe(stoppedAtCount);
  });

  test("reports elapsed time, provider activity, and tool use", async () => {
    let now = 1_000;
    const snapshots: Array<{ elapsedMs: number; lastUpdateAgeMs: number; toolCount: number }> = [];
    const heartbeat = new TurnStatusHeartbeat({
      now: () => now,
      update: async (snapshot) => { snapshots.push(snapshot); },
    });

    now = 1_500;
    heartbeat.recordProgress({ type: "tool_use", toolName: "exec" });
    now = 3_000;
    await heartbeat.refresh();
    await heartbeat.stop();

    expect(snapshots).toEqual([{
      elapsedMs: 2_000,
      lastUpdateAgeMs: 1_500,
      toolCount: 1,
    }]);
  });

  test("waits for an in-flight heartbeat before allowing terminal status", async () => {
    let releaseUpdate: (() => void) | null = null;
    let updateCount = 0;
    const heartbeat = new TurnStatusHeartbeat({
      update: async () => {
        updateCount += 1;
        await new Promise<void>((resolve) => { releaseUpdate = resolve; });
      },
    });

    const refresh = heartbeat.refresh();
    await Promise.resolve();
    const stop = heartbeat.stop();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Promise.resolve();

    expect(stopped).toBe(false);
    releaseUpdate?.();
    await refresh;
    await stop;
    await heartbeat.refresh();

    expect(stopped).toBe(true);
    expect(updateCount).toBe(1);
  });

  test("reports update failures without stopping later heartbeats", async () => {
    const errors: unknown[] = [];
    let updateCount = 0;
    const heartbeat = new TurnStatusHeartbeat({
      update: async () => {
        updateCount += 1;
        if (updateCount === 1) throw new Error("temporary Slack failure");
      },
      onError: (error) => { errors.push(error); },
    });

    await heartbeat.refresh();
    await heartbeat.refresh();
    await heartbeat.stop();

    expect(updateCount).toBe(2);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("temporary Slack failure");
  });
});
