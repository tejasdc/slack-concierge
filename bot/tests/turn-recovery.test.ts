import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { slackBucket } from "../src/rate-limit";
import { reconcileRecoverableTurns, type TurnRecoveryServices } from "../src/turn-recovery";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  getSession,
  getTurnStatusProjection,
  markTurnDelivering,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  requestTurnStatusProjection,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
  slackBucket.reset();
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

describe("turn restart recovery", () => {
  test("projects an interrupted terminal status before releasing an orphaned session lock", async () => {
    const rootThreadTs = "800.000001";
    const userMessageTs = "800.000010";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      userMessageTs,
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    requestTurnStatusProjection(turn.id, "working");
    const initialClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialClaim.message_generation, "status-1");
    markTurnStatusProjectionDelivered(turn.id, initialClaim.desired_revision);

    const statusUpdates: string[] = [];
    const removedReactions: string[] = [];
    const client = {
      chat: {
        update: async (args: any) => {
          statusUpdates.push(args.text);
          return { ok: true };
        },
      },
      reactions: {
        remove: async (args: any) => {
          removedReactions.push(args.timestamp);
          return { ok: true };
        },
      },
    };
    const services: TurnRecoveryServices = {
      deliverOutcome: async () => {
        throw new Error("delivery recovery must not run for an active-provider orphan");
      },
      projectTurnStatus: async ({ turnId, text }) => {
        expect(getSession("C1", rootThreadTs, "codex").status).toBe("running");
        requestTurnStatusProjection(turnId, text);
        const claimed = claimTurnStatusProjection(turnId, Date.now())!;
        await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
        markTurnStatusProjectionDelivered(turnId, claimed.desired_revision);
        return "delivered";
      },
      projectThreadSummary: async () => {
        throw new Error("thread summary recovery must not run for an interrupted provider");
      },
    };

    expect(await reconcileRecoverableTurns({
      client,
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services,
    })).toBe("done");

    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({
      status: "interrupted",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
    expect(getTurnStatusProjection(turn.id)).toMatchObject({
      slack_status_msg_ts: "status-1",
      projection_status: "delivered",
    });
    expect(statusUpdates.some((text) => text.includes("Status: interrupted"))).toBeTrue();
    expect(removedReactions).toEqual([userMessageTs]);
  });

  test("does not let reaction cleanup delay an interrupted lifecycle transition", async () => {
    const rootThreadTs = "810.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      "810.000010",
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    requestTurnStatusProjection(turn.id, "working");
    const initialClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialClaim.message_generation, "status-2");
    markTurnStatusProjectionDelivered(turn.id, initialClaim.desired_revision);
    const client = {
      reactions: {
        remove: () => new Promise(() => {}),
      },
    };
    const services: TurnRecoveryServices = {
      deliverOutcome: async () => "delivered",
      projectTurnStatus: async ({ turnId, text }) => {
        requestTurnStatusProjection(turnId, text);
        const claimed = claimTurnStatusProjection(turnId, Date.now())!;
        markTurnStatusProjectionDelivered(turnId, claimed.desired_revision);
        return "delivered";
      },
      projectThreadSummary: async () => "delivered",
    };

    expect(await Promise.race([
      reconcileRecoverableTurns({
        client,
        instanceId: "replacement-runtime",
        isOwnerAlive: () => false,
        services,
      }),
      new Promise((resolve) => setTimeout(() => resolve("timed_out"), 50)),
    ])).toBe("done");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({
      status: "interrupted",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("never regresses confirmed delivery when a later status projection fails", async () => {
    const rootThreadTs = "820.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      "820.000010",
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    requestTurnStatusProjection(turn.id, "working");
    const initialClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialClaim.message_generation, "status-3");
    markTurnStatusProjectionDelivered(turn.id, initialClaim.desired_revision);
    markTurnDelivering(turn.id, "answer", "answer", 1, "Completed the request.");
    const services: TurnRecoveryServices = {
      deliverOutcome: async () => "delivered",
      projectTurnStatus: async () => {
        throw new Error("status projection unavailable");
      },
      projectThreadSummary: async () => "delivered",
    };

    await expect(reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services,
    })).rejects.toThrow("status projection unavailable");

    expect(db.query(`
      SELECT status, delivery_status, owner_instance_id FROM turns WHERE id=?
    `).get(turn.id)).toMatchObject({
      status: "delivering",
      delivery_status: "delivered",
      owner_instance_id: null,
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("running");
  });
});
