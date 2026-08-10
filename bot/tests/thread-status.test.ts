import { describe, expect, test } from "bun:test";
import {
  runSlackThreadStatusProjection,
  threadStatusClientMessageId,
  type SlackThreadStatusProjection,
} from "../src/thread-status";

function pendingStatus(overrides: Partial<SlackThreadStatusProjection> = {}): SlackThreadStatusProjection {
  return {
    slack_channel_id: "C1",
    slack_thread_ts: "1.0",
    slack_status_msg_ts: "1.1",
    message_generation: 0,
    desired_text: "working",
    desired_revision: 1,
    projected_revision: 0,
    projection_status: "pending",
    projection_attempts: 0,
    projection_next_attempt_ms: 0,
    ...overrides,
  };
}

function stateCallbacks(status: SlackThreadStatusProjection) {
  return {
    load: () => ({ ...status }),
    claim: () => {
      if (status.projection_status !== "pending") return null;
      status.projection_status = "sending";
      status.projection_attempts += 1;
      return { ...status };
    },
    recordMessage: (row: SlackThreadStatusProjection, messageTs: string) => {
      if (status.message_generation === row.message_generation && !status.slack_status_msg_ts) {
        status.slack_status_msg_ts = messageTs;
      }
    },
    replaceMissingMessage: (row: SlackThreadStatusProjection) => {
      if (status.message_generation !== row.message_generation) return;
      status.slack_status_msg_ts = "";
      status.message_generation += 1;
      status.projection_status = "pending";
      status.projection_attempts = 0;
    },
    markDelivered: (row: SlackThreadStatusProjection) => {
      status.projected_revision = Math.max(status.projected_revision, row.desired_revision);
      status.projection_status = status.desired_revision === row.desired_revision ? "delivered" : "pending";
    },
    markRetry: (_row: SlackThreadStatusProjection) => { status.projection_status = "pending"; },
    markParked: (_row: SlackThreadStatusProjection) => { status.projection_status = "parked"; },
  };
}

describe("Slack thread status projection", () => {
  test("updates and reuses the thread's remembered status message", async () => {
    const status = pendingStatus();
    const updates: string[] = [];

    const outcome = await runSlackThreadStatusProjection({
      ...stateCallbacks(status),
      update: async (row) => { updates.push(`${row.slack_status_msg_ts}:${row.desired_text}`); },
      post: async () => { throw new Error("should not post"); },
      isMissingUpdateError: () => false,
      isMissingDuplicateError: () => false,
      isRetryable: () => false,
    });

    expect(outcome).toBe("delivered");
    expect(updates).toEqual(["1.1:working"]);
  });

  test("advances the creation generation after duplicate_message_not_found", async () => {
    const status = pendingStatus({ slack_status_msg_ts: "" });
    const clientMessageIds: string[] = [];

    const outcome = await runSlackThreadStatusProjection({
      ...stateCallbacks(status),
      update: async () => { throw new Error("should not update"); },
      post: async (_row, clientMessageId) => {
        clientMessageIds.push(clientMessageId);
        if (clientMessageIds.length === 1) {
          throw Object.assign(new Error("deleted duplicate"), { code: "duplicate_missing" });
        }
        return { ts: "replacement" };
      },
      isMissingUpdateError: () => false,
      isMissingDuplicateError: (error) => (error as any).code === "duplicate_missing",
      isRetryable: () => false,
    });

    expect(outcome).toBe("delivered");
    expect(status.slack_status_msg_ts).toBe("replacement");
    expect(status.message_generation).toBe(1);
    expect(clientMessageIds).toEqual([
      threadStatusClientMessageId("C1", "1.0", 0),
      threadStatusClientMessageId("C1", "1.0", 1),
    ]);
  });

  test("reuses one generation after create succeeds but persistence is uncertain", async () => {
    const status = pendingStatus({ slack_status_msg_ts: "" });
    const clientMessageIds: string[] = [];
    let recordAttempts = 0;

    const callbacks = stateCallbacks(status);
    const outcome = await runSlackThreadStatusProjection({
      ...callbacks,
      post: async (_row, clientMessageId) => {
        clientMessageIds.push(clientMessageId);
        return { ts: "created-once" };
      },
      update: async () => { throw new Error("should not update"); },
      recordMessage: (row, messageTs) => {
        recordAttempts += 1;
        if (recordAttempts === 1) throw new Error("database busy after Slack accepted the create");
        callbacks.recordMessage(row, messageTs);
      },
      isMissingUpdateError: () => false,
      isMissingDuplicateError: () => false,
      isRetryable: (error) => String(error).includes("database busy"),
      wait: async () => {},
      now: () => 0,
    });

    expect(outcome).toBe("delivered");
    expect(status.slack_status_msg_ts).toBe("created-once");
    expect(clientMessageIds).toHaveLength(2);
    expect(new Set(clientMessageIds).size).toBe(1);
  });

  test("retries an ambiguous update without creating a second status message", async () => {
    const status = pendingStatus();
    let updates = 0;
    let posts = 0;

    const outcome = await runSlackThreadStatusProjection({
      ...stateCallbacks(status),
      update: async () => {
        updates += 1;
        if (updates === 1) throw new Error("transport failed");
      },
      post: async () => { posts += 1; return { ts: "new" }; },
      isMissingUpdateError: () => false,
      isMissingDuplicateError: () => false,
      isRetryable: () => true,
      wait: async () => {},
      now: () => 0,
    });

    expect(outcome).toBe("delivered");
    expect(updates).toBe(2);
    expect(posts).toBe(0);
  });

  test("renders a newer desired revision after an older write finishes late", async () => {
    const status = pendingStatus({ desired_text: "old working state" });
    const updates: string[] = [];

    const outcome = await runSlackThreadStatusProjection({
      ...stateCallbacks(status),
      update: async (claimed) => {
        updates.push(claimed.desired_text || "");
        if (claimed.desired_revision === 1) {
          status.desired_text = "new done state";
          status.desired_revision = 2;
          status.projection_status = "pending";
        }
      },
      post: async () => { throw new Error("should not post"); },
      isMissingUpdateError: () => false,
      isMissingDuplicateError: () => false,
      isRetryable: () => false,
    });

    expect(outcome).toBe("delivered");
    expect(updates).toEqual(["old working state", "new done state"]);
    expect(status.projected_revision).toBe(2);
  });
});
