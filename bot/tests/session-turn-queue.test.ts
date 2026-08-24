import { describe, expect, test } from "bun:test";
import {
  admitSessionTurnUnlessDraining,
  SessionTurnQueueCoordinator,
} from "../src/session-turn-queue";

describe("SessionTurnQueueCoordinator", () => {
  test("hands a completed claim to execution synchronously", () => {
    const claims = [{ turn_id: 1 }];
    const started: number[] = [];
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => claims.shift() || null,
      run: async (claim) => {
        started.push(claim.turn_id);
      },
      shouldStop: () => false,
      onError: () => {},
    });

    coordinator.wake();

    expect(started).toEqual([1]);
  });

  test("local drain leaves a queued successor unclaimed after its predecessor completes", async () => {
    let predecessorRunning = true;
    let claimAttempts = 0;
    const started: number[] = [];
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => {
        claimAttempts += 1;
        return predecessorRunning ? null : { turn_id: 2 };
      },
      run: async (claim) => {
        started.push(claim.turn_id);
      },
      shouldStop: () => false,
      onError: () => {},
    });

    coordinator.wake();
    expect(claimAttempts).toBe(1);
    coordinator.stop();
    predecessorRunning = false;
    coordinator.wake();
    await Promise.resolve();

    expect(claimAttempts).toBe(1);
    expect(started).toEqual([]);
  });

  test("process-local draining rejects wakeups even before stop is called", () => {
    let draining = false;
    let claimAttempts = 0;
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => {
        claimAttempts += 1;
        return null;
      },
      run: async () => {},
      shouldStop: () => draining,
      onError: () => {},
    });

    draining = true;
    coordinator.wake();

    expect(claimAttempts).toBe(0);
  });

  test("rechecks local drain at the final synchronous handler admission seam", async () => {
    let draining = false;
    let acquired = false;
    let classified = false;

    await Promise.resolve().then(() => {
      draining = true;
    });
    const admission = admitSessionTurnUnlessDraining({
      shouldStop: () => draining,
      classifyDraining: () => {
        classified = true;
        return true;
      },
      acquire: () => {
        acquired = true;
        return { id: 1 };
      },
    });

    expect(admission).toEqual({ draining: true });
    expect(classified).toBeTrue();
    expect(acquired).toBeFalse();
  });

  test("keeps the drain check, durable classification, and acquisition in one synchronous call", () => {
    const events: string[] = [];
    const admission = admitSessionTurnUnlessDraining({
      shouldStop: () => {
        events.push("drain-checked");
        return false;
      },
      classifyDraining: () => {
        events.push("classified");
        return true;
      },
      acquire: () => {
        events.push("acquired");
        return { id: 2 };
      },
    });

    expect(admission).toEqual({ draining: false, turn: { id: 2 } });
    expect(events).toEqual(["drain-checked", "acquired"]);
  });

});
