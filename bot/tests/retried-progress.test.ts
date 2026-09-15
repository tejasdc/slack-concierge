import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { beginAgentProgressMessages, projectAgentProgressMessages, queueAgentProgressMessages } from "../src/agent-progress-messages";
import { resetAgentProgressSlackBucketsForTests } from "../src/rate-limit";
import { reconcileRecoverableTurns } from "../src/turn-recovery";
import * as state from "../src/state";

let release: (() => void) | undefined;
beforeEach(async () => {
  release = await acquireDatabaseTestLock();
  state.db.query("DELETE FROM deployment_drain").run();
  state.db.query("DELETE FROM slack_root_summary_projections").run();
  state.db.query("DELETE FROM slack_thread_statuses").run();
  state.db.query("DELETE FROM slack_user_input_claims").run();
  state.db.query("DELETE FROM turn_steering_messages").run();
  state.db.query("DELETE FROM turn_delivery_chunks").run();
  state.db.query("DELETE FROM turns").run();
  state.db.query("DELETE FROM sessions").run();
  resetAgentProgressSlackBucketsForTests();
});
afterEach(() => release?.());

function fixture() {
  const channel = "DRETRY";
  const root = "1789424424.827159";
  const session = state.createOrGetSession(channel, root, "claude-code");
  const turn = state.acquireSessionTurn(session.id, root, "original request", "owner", undefined, root,
    { projectionMode: "agent", userId: "U1" });
  const calls: Array<{ method: string; args: any }> = [];
  const client = { apiCall: async (method: string, args: any) => {
    calls.push({ method, args: structuredClone(args) });
    return { ok: true, ts: args.ts || `${turn.id}.${calls.length}` };
  } };
  const task = (title: string, status = "in_progress") => [{ type: "task_update" as const, id: "activity", title, status: status as "in_progress" | "complete" | "error" }];
  const start = async () => {
    beginAgentProgressMessages(turn.id, task("Starting"));
    await projectAgentProgressMessages(client, turn.id);
  };
  const stop = async (title: string, status: "complete" | "error") => {
    state.requestTurnProgressStreamStop(turn.id);
    queueAgentProgressMessages(turn.id, task(title, status), true);
    await projectAgentProgressMessages(client, turn.id);
    state.markTurnProgressStreamStopped(turn.id);
  };
  return { channel, root, session, turn, calls, client, task, start, stop };
}

test("repeated parked attempts reuse native progress and release FIFO after final delivery", async () => {
  const f = fixture();
  await f.start();
  const ts = state.getTurnProgressStream(f.turn.id)!.progress_stream_ts;
  for (const attempt of [1, 2]) {
    await f.stop("Work stopped with an error", "error");
    expect(state.parkRunningTurnAfterProviderFailure({ turnId: f.turn.id, ownerInstanceId: "owner",
      dispatchAttempt: attempt, failureClass: "parked_terminal", error: "usage exhausted" })).toBeTrue();
    expect(state.resumeParkedSessionTurn(f.turn.id)).toBe("resumed");
    expect(state.claimNextQueuedTurn("owner")?.turn_id).toBe(f.turn.id);
    expect(state.getTurnProgressStream(f.turn.id)).toMatchObject({ progress_stream_state: "streaming", progress_stream_ts: ts });
    queueAgentProgressMessages(f.turn.id, f.task("Working again"));
    await projectAgentProgressMessages(f.client, f.turn.id);
    expect(JSON.stringify(f.calls.at(-1)!.args.blocks)).toContain("Working again");
  }
  const successor = state.acquireSessionTurn(f.session.id, "1789424667.458019", "next request", "owner");
  expect(successor.queued).toBeTrue();
  state.markTurnDelivering(f.turn.id, "TL;DR: Saved result");
  await f.stop("Work complete", "complete");
  expect(state.prepareTurnReplyReplacement(f.turn.id, f.channel, f.channel)).toBe(ts);
  state.markDeliveryChunkDelivered(f.turn.id, 0, ts);
  state.markTurnResponseDelivered(f.turn.id);
  state.finishDeliveredTurn(f.turn.id);
  expect(state.claimNextQueuedTurn("owner")?.turn_id).toBe(successor.id);
  const callsBefore = f.calls.length;
  expect(() => queueAgentProgressMessages(f.turn.id, f.task("stale heartbeat"))).toThrow();
  await projectAgentProgressMessages(f.client, f.turn.id);
  expect(f.calls).toHaveLength(callsBefore);
  expect(f.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
});

test("restart recovers the observed saved-result state without dispatching the provider or reposting progress", async () => {
  const f = fixture();
  await f.start();
  await f.stop("Work stopped with an error", "error");
  const ts = state.getTurnProgressStream(f.turn.id)!.progress_stream_ts;
  state.markTurnDelivering(f.turn.id, "TL;DR: Already completed on Opus");
  // Exact pre-fix incident: retry reset the stream fields but kept its posted
  // page and prior terminal fence; the provider result is already durable.
  state.db.query(`UPDATE turns SET progress_stream_state='starting', progress_stream_ts=NULL,
    progress_activity_id=NULL, dispatch_attempt=21, owner_instance_id=NULL WHERE id=?`).run(f.turn.id);
  const successor = state.acquireSessionTurn(f.session.id, "1789424667.458019", "next request", "owner");
  let deliveries = 0;
  expect(await reconcileRecoverableTurns({ client: f.client, instanceId: "recovery", isOwnerAlive: () => false,
    services: {
      stopAgentProgress: async ({ chunks }) => {
        state.requestTurnProgressStreamStop(f.turn.id);
        queueAgentProgressMessages(f.turn.id, chunks, true);
        await projectAgentProgressMessages(f.client, f.turn.id);
        state.markTurnProgressStreamStopped(f.turn.id);
      },
      deliverOutcome: async ({ text }) => {
        deliveries++;
        expect(text).toBe("TL;DR: Already completed on Opus");
        expect(state.prepareTurnReplyReplacement(f.turn.id, f.channel, f.channel)).toBe(ts);
        state.markDeliveryChunkDelivered(f.turn.id, 0, ts);
        return "delivered";
      },
      projectTurnStatus: async () => "delivered", projectThreadSummary: async () => "delivered",
      setAgentSessionStatus: async () => "delivered",
    },
  })).toBe("done");
  expect(deliveries).toBe(1);
  expect(state.db.query("SELECT status, dispatch_attempt FROM turns WHERE id=?").get(f.turn.id))
    .toEqual({ status: "done", dispatch_attempt: 21 });
  expect(state.claimNextQueuedTurn("owner")?.turn_id).toBe(successor.id);
  expect(f.calls.filter(call => call.method === "chat.postMessage")).toHaveLength(1);
  expect(JSON.stringify(f.calls.at(-1)!.args.blocks)).toContain("Work complete");
});

test("restoration requires the owned retry and a confirmed native message and preserves delivered replies", async () => {
  const f = fixture();
  await f.start();
  await f.stop("Error", "error");
  state.db.query(`UPDATE turns SET progress_stream_state='starting', progress_stream_ts=NULL,
    dispatch_attempt=2 WHERE id=?`).run(f.turn.id);
  state.restoreRetriedTurnProgressMessage(f.turn.id, "wrong-owner");
  expect(state.getTurnProgressStream(f.turn.id)!.progress_stream_state).toBe("starting");
  state.db.query("UPDATE agent_progress_messages SET creation_state='posting' WHERE turn_id=?").run(f.turn.id);
  state.restoreRetriedTurnProgressMessage(f.turn.id, "owner");
  expect(state.getTurnProgressStream(f.turn.id)!.progress_stream_state).toBe("starting");
  state.db.query("UPDATE agent_progress_messages SET creation_state='posted' WHERE turn_id=?").run(f.turn.id);
  state.db.query("UPDATE turns SET delivery_status='delivered' WHERE id=?").run(f.turn.id);
  state.restoreRetriedTurnProgressMessage(f.turn.id, "owner");
  expect(state.getTurnProgressStream(f.turn.id)!.progress_stream_state).toBe("starting");
});
