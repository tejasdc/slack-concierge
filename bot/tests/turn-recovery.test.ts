import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDirectoryForTurn, prepareArtifactDirectory } from "../src/artifacts";
import { beginAgentProgressMessages, projectAgentProgressMessages } from "../src/agent-progress-messages";
import { slackBucket } from "../src/rate-limit";
import { runSlackThreadStatusProjection } from "../src/thread-status";
import { scheduleTurnReactionCleanup } from "../src/turn-reaction-cleanup";
import { reconcileRecoverableTurns, type TurnRecoveryServices } from "../src/turn-recovery";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  beginTurnProgressStream,
  claimNextQueuedTurn,
  claimSlackRootSummaryProjection,
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
  markSlackRootSummaryProjectionDelivered,
  markTurnStatusProjectionDelivered,
  parkTurnDelivery,
  recordTurnStatusMessage,
  recordTurnProgressStreamStarted,
  requestAgentStopForSession,
  requestSlackRootSummaryProjection,
  recoverTurnReactionCleanupClaims,
  requestTurnStatusProjection,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_root_summary_projections").run();
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
  test("recovers persisted native Stop as cancellation without a reply", async () => {
    const threadTs = "770.000001";
    const session = createOrGetSession("C-agent-stop-recovery", threadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      threadTs,
      "request",
      "dead-runtime",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    beginTurnProgressStream(turn.id);
    recordTurnProgressStreamStarted(turn.id, "770.000010");
    expect(requestAgentStopForSession({
      turnId: turn.id,
      channel: "C-agent-stop-recovery",
      threadTs,
      eventTs: "770.000010",
    })).toBeTrue();
    const statuses: string[] = [];
    const notices: string[] = [];
    let replies = 0;
    let deliveries = 0;

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        stopAgentProgress: async () => {},
        setAgentSessionStatus: async ({ status }) => {
          statuses.push(status);
          return "permanent_failure";
        },
        deliverOutcome: async () => { deliveries += 1; return "delivered"; },
        projectTurnStatus: async ({ text }) => {
          replies += 1;
          notices.push(text);
          return "delivered";
        },
        projectThreadSummary: async () => "delivered",
      },
    })).toBe("done");

    expect(statuses).toEqual(["active"]);
    expect(replies).toBe(1);
    expect(notices[0]).toContain("could not clear Slack's working indicator");
    expect(deliveries).toBe(0);
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "cancelled" });
    expect(getSession("C-agent-stop-recovery", threadTs, "codex").status).toBe("idle");
  });

  test.each(["not_started", "pending"])("requeues unattempted native progress (%s) with fresh progress and in-card elapsed time", async (phase) => {
    const threadTs = "774.000001";
    const channel = "C-agent-pending-recovery";
    const session = createOrGetSession(channel, threadTs, "codex");
    const turn = acquireSessionTurn(session.id, threadTs, "request", "dead-runtime", undefined, threadTs,
      { userId: "U1", projectionMode: "agent" });
    if (phase === "pending") beginAgentProgressMessages(turn.id, [
      { type: "task_update", id: "old-start", title: "Starting", status: "in_progress" },
    ]);

    expect(await reconcileRecoverableTurns({
      client: {}, instanceId: "replacement-runtime", isOwnerAlive: () => false,
      services: {
        deliverOutcome: async () => { throw new Error("unattempted work must requeue"); },
        projectTurnStatus: async () => { throw new Error("requeue must not add a notice"); },
        projectThreadSummary: async () => "delivered",
        setAgentSessionStatus: async () => { throw new Error("requeue must not suspend the session"); },
      },
    })).toBe("done");
    expect(db.query("SELECT status, progress_stream_state, progress_activity_id, progress_terminal_requested FROM turns WHERE id=?").get(turn.id))
      .toEqual({ status: "queued", progress_stream_state: "not_started", progress_activity_id: null, progress_terminal_requested: 0 });
    expect(db.query("SELECT * FROM agent_progress_messages WHERE turn_id=?").all(turn.id)).toHaveLength(0);
    expect(claimNextQueuedTurn("replacement-runtime")?.turn_id).toBe(turn.id);
    beginAgentProgressMessages(turn.id, [{ type: "task_update", id: "new-start", title: "Starting", status: "in_progress" }]);
    const posts: any[] = [];
    await projectAgentProgressMessages({ apiCall: async (_method: string, args: any) => {
      posts.push(args);
      return { ok: true, ts: "774.000010" };
    } }, turn.id);
    expect(posts).toHaveLength(1);
    expect(posts[0].blocks).toEqual([{ type: "task_card", task_id: "new-start", title: "Starting · 0s elapsed", status: "in_progress" }]);
    const page = db.query("SELECT chunks_json FROM agent_progress_messages WHERE turn_id=?").get(turn.id) as { chunks_json: string };
    expect(JSON.parse(page.chunks_json)).toEqual([{ type: "task_update", id: "new-start", title: "Starting", status: "in_progress" }]);
  });

  test("commits native transport identity atomically with the starting transition", () => {
    const threadTs = "774.000002";
    const session = createOrGetSession("C-agent-atomic-start", threadTs, "codex");
    const turn = acquireSessionTurn(session.id, threadTs, "request", "dead-runtime", undefined, threadTs,
      { userId: "U1", projectionMode: "agent" });
    const tooManyActiveTasks = Array.from({ length: 51 }, (_, i) => ({
      type: "task_update" as const, id: `task-${i}`, title: "Working", status: "in_progress" as const,
    }));
    expect(() => beginAgentProgressMessages(turn.id, tooManyActiveTasks)).toThrow();
    expect(db.query("SELECT progress_stream_state FROM turns WHERE id=?").get(turn.id)).toEqual({ progress_stream_state: "not_started" });
    expect(db.query("SELECT * FROM agent_progress_messages WHERE turn_id=?").all(turn.id)).toHaveLength(0);
  });

  test.each(["legacy_stream", "posting"])("parks ambiguous Agent creation (%s) instead of reposting", async (phase) => {
    const threadTs = "775.000001";
    const session = createOrGetSession("C-agent-start-recovery", threadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      threadTs,
      "request",
      "dead-runtime",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    if (phase === "legacy_stream") beginTurnProgressStream(turn.id);
    else {
      beginAgentProgressMessages(turn.id, [{ type: "task_update", id: "start", title: "Starting", status: "in_progress" }]);
      db.query("UPDATE agent_progress_messages SET creation_state='posting' WHERE turn_id=?").run(turn.id);
    }
    const statuses: string[] = [];
    const notices: string[] = [];

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        setAgentSessionStatus: async ({ status }) => {
          statuses.push(status);
          if (status === "suspended") throw new Error("recovered suspension failed");
        },
        deliverOutcome: async () => { throw new Error("ambiguous start must not deliver"); },
        projectTurnStatus: async ({ text }) => { notices.push(text); return "delivered"; },
        projectThreadSummary: async () => "delivered",
      },
    })).toBe("done");

    expect(statuses).toEqual(["suspended"]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toStartWith("<@U1>");
    expect(notices[0]).toContain("Agent-session status projection: `recovered suspension failed`");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "interrupted" });
  });

  test.each(["codex", "claude-code"] as const)("stops a recovered %s Agent stream before delivering its durable final reply", async (providerId) => {
    const rootThreadTs = "780.000001";
    const session = createOrGetSession("C-agent-recovery", rootThreadTs, providerId);
    const turn = acquireSessionTurn(
      session.id,
      rootThreadTs,
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    beginTurnProgressStream(turn.id);
    recordTurnProgressStreamStarted(turn.id, "780.000010", "activity-before-restart");
    expect(markTurnDelivering(
      turn.id,
      "TL;DR: Recovered result.\n\nDetails.",
      "TL;DR: Recovered result.\n\nDetails.",
      1,
      "Recovered result.",
      1_122_000,
    )).toBeTrue();
    const effects: string[] = [];
    const rootSummaries: string[] = [];

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        stopAgentProgress: async ({ chunks }) => {
          expect(chunks).toEqual([expect.objectContaining({ id: "activity-before-restart", title: "Work complete · 18m 42s", status: "complete" })]);
          effects.push("stop");
        },
        deliverOutcome: async () => { effects.push("deliver"); return "delivered"; },
        setAgentSessionStatus: async ({ status }) => { effects.push(`status:${status}`); },
        projectTurnStatus: async () => "delivered",
        projectThreadSummary: async () => "delivered",
        projectRootSummary: async ({ text }) => {
          effects.push("root");
          rootSummaries.push(text);
          return "delivered";
        },
      },
    })).toBe("done");

    expect(effects).toEqual(["stop", "deliver", "root", "status:active"]);
    expect(rootSummaries).toEqual([[
      "request",
      "",
      "━━━━━━━━━━━━━━━━━━━━",
      "*Concierge TL;DR*",
      "Recovered result.",
    ].join("\n")]);
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "done" });
  });

  test("keeps a recovered delivered turn unsettled when root projection stops before terminal active", async () => {
    const rootThreadTs = "782.000001";
    const channelId = "C-agent-recovery-stop";
    const session = createOrGetSession(channelId, rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      rootThreadTs,
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    beginTurnProgressStream(turn.id);
    recordTurnProgressStreamStarted(turn.id, "782.000010");
    expect(markTurnDelivering(
      turn.id,
      "TL;DR: Recovered result.",
      "TL;DR: Recovered result.",
      1,
      "Recovered result.",
    )).toBeTrue();
    const statuses: string[] = [];

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        stopAgentProgress: async () => {},
        deliverOutcome: async () => "delivered",
        projectTurnStatus: async () => "delivered",
        projectThreadSummary: async () => "delivered",
        projectRootSummary: async () => "stopped",
        setAgentSessionStatus: async ({ status }) => { statuses.push(status); },
      },
    })).toBe("stopped");

    expect(statuses).toEqual([]);
    expect(db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(turn.id))
      .toEqual({ status: "delivering", owner_instance_id: null });
    expect(getSession(channelId, rootThreadTs, "codex").status).toBe("running");
  });

  test("does not repeat a settled root edit when terminal active stops during recovery", async () => {
    const rootThreadTs = "783.000001";
    const channelId = "C-agent-status-recovery-stop";
    const session = createOrGetSession(channelId, rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      rootThreadTs,
      "request",
      "dead-runtime",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    beginTurnProgressStream(turn.id);
    recordTurnProgressStreamStarted(turn.id, "783.000010");
    expect(markTurnDelivering(
      turn.id,
      "TL;DR: Recovered result.",
      "TL;DR: Recovered result.",
      1,
      "Recovered result.",
    )).toBeTrue();
    let rootProjections = 0;
    const firstRecoveryServices: TurnRecoveryServices = {
      stopAgentProgress: async () => {},
      deliverOutcome: async () => "delivered",
      projectTurnStatus: async () => "delivered",
      projectThreadSummary: async () => "delivered",
      projectRootSummary: async ({ channel, threadTs, turnId, text }) => {
        rootProjections += 1;
        requestSlackRootSummaryProjection({ channel, threadTs, turnId, text });
        const claimed = claimSlackRootSummaryProjection(channel, threadTs, Date.now())!;
        markSlackRootSummaryProjectionDelivered(channel, threadTs, claimed.desired_revision);
        return "delivered";
      },
      setAgentSessionStatus: async () => "stopped",
    };

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "first-replacement-runtime",
      isOwnerAlive: () => false,
      services: firstRecoveryServices,
    })).toBe("stopped");

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "second-replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        ...firstRecoveryServices,
        projectRootSummary: async () => { throw new Error("settled root must not be projected twice"); },
        setAgentSessionStatus: async () => "delivered",
      },
    })).toBe("done");

    expect(rootProjections).toBe(1);
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toEqual({ status: "done" });
  });

  test("leaves an unstored Slack root unchanged when the first recovered Agent input was a reply", async () => {
    const rootThreadTs = "785.000001";
    const session = createOrGetSession("C-agent-reply-recovery", rootThreadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      "785.000010",
      "reply request",
      "dead-runtime",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    beginTurnProgressStream(turn.id);
    recordTurnProgressStreamStarted(turn.id, "785.000020");
    expect(markTurnDelivering(
      turn.id,
      "TL;DR: Recovered reply.\n\nDetails.",
      "TL;DR: Recovered reply.\n\nDetails.",
      1,
      "Recovered reply.",
    )).toBeTrue();
    let rootProjectionCalls = 0;

    expect(await reconcileRecoverableTurns({
      client: {},
      instanceId: "replacement-runtime",
      isOwnerAlive: () => false,
      services: {
        stopAgentProgress: async () => {},
        deliverOutcome: async () => "delivered",
        projectTurnStatus: async () => "delivered",
        projectThreadSummary: async () => "delivered",
        projectRootSummary: async () => {
          rootProjectionCalls += 1;
          return "delivered";
        },
      },
    })).toBe("done");

    expect(rootProjectionCalls).toBe(0);
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "done" });
  });

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
