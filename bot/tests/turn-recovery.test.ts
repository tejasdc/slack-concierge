import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDirectoryForTurn, prepareArtifactDirectory } from "../src/artifacts";
import { slackBucket } from "../src/rate-limit";
import { runSlackThreadStatusProjection } from "../src/thread-status";
import { scheduleTurnReactionCleanup } from "../src/turn-reaction-cleanup";
import { reconcileRecoverableTurns, type TurnRecoveryServices } from "../src/turn-recovery";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimTurnStatusProjection,
  createOrGetSession,
  createTurnArtifactBatch,
  db,
  finishDeliveredTurn,
  finishTurn,
  getSession,
  getTurnArtifactBatch,
  getTurnReactionCleanup,
  getTurnStatusProjection,
  claimTurnReactionCleanup,
  listPendingTurnStatusProjections,
  markTurnDelivering,
  markTurnProviderAdmissionIntended,
  markTurnResponseDelivered,
  markTurnStatusProjectionDelivered,
  parkTurnDelivery,
  recordTurnStatusMessage,
  recoverTurnReactionCleanupClaims,
  requestTurnStatusProjection,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

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
  projectDir = mkdtempSync(join(tmpdir(), "concierge-turn-recovery-artifacts-"));
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe("turn restart recovery", () => {
  test("abandons and cleans a dead provider's regular-file staging copies", async () => {
    const session = createOrGetSession("C1", "790.000001", "codex");
    const turn = acquireSessionTurn(
      session.id,
      "790.000010",
      "request",
      "dead-runtime",
      undefined,
      "790.000001",
    );
    const token = randomUUID();
    const directory = artifactDirectoryForTurn(projectDir, turn.id, token);
    createTurnArtifactBatch(turn.id, token, directory);
    prepareArtifactDirectory(projectDir, turn.id, token);
    const stagedFile = join(directory, "interrupted.txt");
    writeFileSync(stagedFile, "temporary");
    requestTurnStatusProjection(turn.id, "working");

    const services: TurnRecoveryServices = {
      deliverOutcome: async () => "delivered",
      projectTurnStatus: async ({ turnId, text }) => {
        requestTurnStatusProjection(turnId, text);
        return "delivered";
      },
      projectThreadSummary: async () => "delivered",
    };

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services,
    })).toBe("done");

    expect(getTurnArtifactBatch(turn.id)).toMatchObject({ status: "abandoned" });
    expect(existsSync(stagedFile)).toBeFalse();
    expect(existsSync(directory)).toBeFalse();
  });

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
    expect(markTurnProviderAdmissionIntended(turn.id, "dead-runtime", turn.dispatchAttempt)).toBeTrue();
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
      scheduleWorkingReactionCleanup: async (slackClient) => {
        await slackClient.reactions.remove({ timestamp: userMessageTs });
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
    expect(markTurnProviderAdmissionIntended(turn.id, "dead-runtime", turn.dispatchAttempt)).toBeTrue();
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
      scheduleWorkingReactionCleanup: async (slackClient) => {
        await slackClient.reactions.remove({ timestamp: "810.000010" });
      },
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

  test("parks recovered permanent delivery before terminal projection can stop", async () => {
    const rootThreadTs = "830.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      "830.000010",
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    requestTurnStatusProjection(turn.id, "working");
    const initialClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, initialClaim.message_generation, "status-4");
    markTurnStatusProjectionDelivered(turn.id, initialClaim.desired_revision);
    markTurnDelivering(turn.id, "answer", "answer", 1, "Delivery failed permanently.");

    let statusObservedByTerminalProjection: string | null = null;
    let durableTerminalProjection: any = null;
    const services: TurnRecoveryServices = {
      deliverOutcome: async () => "permanent_failure",
      projectTurnStatus: async ({ turnId }) => {
        statusObservedByTerminalProjection = (db.query("SELECT status FROM turns WHERE id=?")
          .get(turnId) as { status: string }).status;
        durableTerminalProjection = getTurnStatusProjection(turnId);
        return "stopped";
      },
      projectThreadSummary: async () => "delivered",
    };

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services,
    })).toBe("done");

    expect(statusObservedByTerminalProjection).toBe("delivery_parked");
    expect(durableTerminalProjection).toMatchObject({
      projection_status: "pending",
      desired_revision: 2,
    });
    expect(durableTerminalProjection.desired_text).toContain(
      "Status: error - response delivery was permanently parked after restart",
    );
    expect(db.query(`
      SELECT status, delivery_status, owner_instance_id FROM turns WHERE id=?
    `).get(turn.id)).toMatchObject({
      status: "delivery_parked",
      delivery_status: "parked",
      owner_instance_id: null,
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("projects the terminal status after a crash immediately following delivery parking", async () => {
    const rootThreadTs = "835.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      "835.000010",
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    requestTurnStatusProjection(turn.id, "working");
    const workingClaim = claimTurnStatusProjection(turn.id, 0)!;
    recordTurnStatusMessage(turn.id, workingClaim.message_generation, "status-crash-window");
    markTurnStatusProjectionDelivered(turn.id, workingClaim.desired_revision);
    markTurnDelivering(turn.id, "answer", "answer", 1, "Delivery failed permanently.");

    const parkedStatusText = "Status: error - response delivery was permanently parked";
    expect(parkTurnDelivery(turn.id, "dead-runtime", parkedStatusText)).toBeTrue();

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        deliverOutcome: async () => { throw new Error("parked delivery must not replay"); },
        projectTurnStatus: async () => { throw new Error("parked delivery uses the projection queue"); },
        projectThreadSummary: async () => { throw new Error("parked delivery has no cumulative summary"); },
      },
    })).toBe("done");

    const pending = listPendingTurnStatusProjections();
    expect(pending.map((status) => status.turn_id)).toEqual([turn.id]);
    const statusUpdates: string[] = [];
    for (const status of pending) {
      expect(await runSlackThreadStatusProjection({
        load: () => getTurnStatusProjection(status.turn_id),
        claim: (nowMs) => claimTurnStatusProjection(status.turn_id, nowMs),
        update: async (claimed) => { statusUpdates.push(claimed.desired_text || ""); },
        post: async () => { throw new Error("existing status should be updated"); },
        recordMessage: () => { throw new Error("existing status should not be replaced"); },
        replaceMissingMessage: () => { throw new Error("existing status is present"); },
        markDelivered: (claimed) => {
          markTurnStatusProjectionDelivered(status.turn_id, claimed.desired_revision);
        },
        markRetry: () => { throw new Error("projection should not retry"); },
        markParked: () => { throw new Error("projection should not park"); },
        isMissingUpdateError: () => false,
        isMissingDuplicateError: () => false,
        isRetryable: () => false,
      })).toBe("delivered");
    }

    expect(statusUpdates).toEqual([parkedStatusText]);
    expect(getTurnStatusProjection(turn.id)).toMatchObject({
      desired_text: parkedStatusText,
      desired_revision: 2,
      projected_revision: 2,
      projection_status: "delivered",
    });
    expect(listPendingTurnStatusProjections()).toEqual([]);
  });

  test("recovers reaction cleanup after a crash beyond delivered-turn recovery", async () => {
    const rootThreadTs = "840.000001";
    const userMessageTs = "840.000010";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      userMessageTs,
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
    );
    markTurnDelivering(turn.id, "answer", "answer", 1, "Delivered.");
    markTurnResponseDelivered(turn.id);
    expect(finishDeliveredTurn(turn.id)).toBeTrue();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "done" });
    expect(getTurnReactionCleanup(turn.id)).toMatchObject({ cleanup_status: "pending" });

    expect(claimTurnReactionCleanup(turn.id, 0)?.cleanup_status).toBe("sending");
    expect(recoverTurnReactionCleanupClaims()).toBe(1);
    let removedTimestamp: string | null = null;
    const client = {
      reactions: {
        remove: async (args: any) => {
          removedTimestamp = args.timestamp;
          return { ok: true };
        },
      },
    };

    expect(await scheduleTurnReactionCleanup(client, turn.id)).toBe("delivered");
    expect(removedTimestamp).toBe(userMessageTs);
    expect(getTurnReactionCleanup(turn.id)).toMatchObject({ cleanup_status: "delivered" });
  });

  test("retries transient reaction cleanup failures until Slack accepts removal", async () => {
    const session = createOrGetSession("C1", "850.000001", "codex");
    const turn = acquireSessionTurn(
      session.id,
      "850.000010",
      "request",
      "runtime-1",
      undefined,
      "850.000001",
    );
    finishTurn(turn.id, "error", "provider failed");

    let attempts = 0;
    let now = 0;
    const client = {
      reactions: {
        remove: async () => {
          attempts += 1;
          if (attempts <= 4) {
            throw Object.assign(new Error("temporary Slack outage"), {
              code: "slack_webapi_request_error",
            });
          }
          return { ok: true };
        },
      },
    };

    expect(await scheduleTurnReactionCleanup(client, turn.id, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
      initialDelayMs: 1,
      maximumDelayMs: 4,
    })).toBe("delivered");
    expect(attempts).toBe(5);
    expect(getTurnReactionCleanup(turn.id)).toMatchObject({
      cleanup_status: "delivered",
      cleanup_attempts: 5,
    });
  });
});
