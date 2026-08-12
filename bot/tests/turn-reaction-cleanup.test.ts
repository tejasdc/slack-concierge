import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scheduleTurnReactionCleanup } from "../src/turn-reaction-cleanup";
import { slackBucket } from "../src/rate-limit";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  createOrGetSession,
  db,
  finishTurn,
  getTurnReactionCleanup,
  recoverTurnReactionCleanupClaims,
  claimTurnReactionCleanup,
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

describe("turn working-reaction cleanup", () => {
  test("keeps retrying transient Slack failures beyond the old three-attempt limit", async () => {
    const session = createOrGetSession("C1", "900.000001", "codex");
    const turn = acquireSessionTurn(
      session.id,
      "900.000010",
      "request",
      "runtime-1",
      undefined,
      "900.000001",
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
      slack_channel_id: "C1",
      slack_user_msg_ts: "900.000010",
    });
  });

  test("reclaims an interrupted cleanup lease on startup", () => {
    const session = createOrGetSession("C1", "901.000001", "codex");
    const turn = acquireSessionTurn(session.id, "901.000010", "request", "runtime-1");
    finishTurn(turn.id, "error", "provider failed");

    expect(claimTurnReactionCleanup(turn.id, 0)?.cleanup_status).toBe("sending");
    expect(recoverTurnReactionCleanupClaims()).toBe(1);
    expect(getTurnReactionCleanup(turn.id)).toMatchObject({
      cleanup_status: "pending",
      cleanup_next_attempt_ms: 0,
    });
  });
});
