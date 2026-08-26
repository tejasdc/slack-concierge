import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveSessionModeForMessage, persistentSessionThreadTs } from "../src/routing";
import {
  ActiveTurnDispatchRegistry,
  dispatchComparisonTurn,
  type UserTurnDispatchOptions,
} from "../src/turn-dispatch-seams";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimComparisonRequest,
  claimSlackUserInput,
  createOrGetSession,
  createTurnSteeringMessage,
  db,
  getSlackUserInputClaim,
  upsertChannel,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_root_summary_projections").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM comparison_requests").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
  projectDir = mkdtempSync(join(tmpdir(), "concierge-turn-dispatch-"));
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

function installPersistentChannel() {
  upsertChannel({
    slack_channel_id: "C1",
    slack_channel_name: "slack-inbox",
    group_name: null,
    name: "Slack Inbox",
    vault_path: projectDir,
    code_path: projectDir,
    provider_default: "claude-code",
  });
  db.query("UPDATE channels SET session_mode='single-persistent' WHERE slack_channel_id='C1'").run();
}

describe("production turn dispatch seams", () => {
  test("routes a same-visible-thread input into the live controller without creating a queued turn", async () => {
    installPersistentChannel();
    const threadTs = "300.000001";
    const session = createOrGetSession("C1", persistentSessionThreadTs("C1"), "claude-code");
    claimSlackUserInput("C1", threadTs, "first-claim", "runtime-1", {
      replyThreadTs: threadTs,
      userId: "U1",
      userText: "Start a long turn",
    });
    const first = acquireSessionTurn(
      session.id,
      threadTs,
      "Start a long turn",
      "runtime-1",
      "first-claim",
      threadTs,
    );
    expect(first.acquired).toBeTrue();

    const lifecycle: string[] = [];
    const steeringInputs: string[] = [];
    let providerReady!: () => void;
    const providerReadyPromise = new Promise<void>((resolve) => { providerReady = resolve; });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const registry = new ActiveTurnDispatchRegistry({
      onStarted: () => lifecycle.push("started"),
      onSettled: (turnId) => lifecycle.push(`settled:${turnId}`),
    });
    const liveTurn = registry.run({ turnId: first.id, channelId: "C1", threadTs }, async (controller) => {
      controller.registerSender(async ({ text }) => { steeringInputs.push(text); });
      providerReady();
      await providerRelease;
      return "complete";
    });
    await providerReadyPromise;

    const steeringTs = "300.000002";
    claimSlackUserInput("C1", steeringTs, "steering-claim", "runtime-1", {
      replyThreadTs: threadTs,
      userId: "U1",
      userText: "Use the patio instead",
    });
    let steeringSent!: () => void;
    const steeringSentPromise = new Promise<void>((resolve) => { steeringSent = resolve; });
    const routed = registry.dispatchSteering("C1", threadTs, (target) => {
      const message = createTurnSteeringMessage(
        target.turnId,
        steeringTs,
        "Use the patio instead",
        "Use the patio instead",
        "steering-claim",
        threadTs,
      );
      if (message.duplicate) throw new Error("Expected a new steering message");
      const accepted = target.controller.enqueue({
        clientMessageId: "steering-1",
        text: "Use the patio instead",
        onSent: () => { steeringSent(); },
        onError: (error) => { throw error; },
      });
      return { accepted, turnId: target.turnId };
    });

    expect(routed).toEqual({ matched: true, value: { accepted: true, turnId: first.id } });
    await steeringSentPromise;
    expect(steeringInputs).toEqual(["Use the patio instead"]);
    expect(getSlackUserInputClaim("C1", steeringTs)).toMatchObject({
      kind: "steering",
      turn_id: first.id,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 1 });

    releaseProvider();
    expect(await liveTurn).toBe("complete");
    expect(lifecycle).toEqual(["started", `settled:${first.id}`]);
    expect(registry.dispatchSteering("C1", threadTs, () => true)).toEqual({ matched: false });
  });

  test("delivers an early Stop request once the exact turn registers cancellation", async () => {
    let registerCancellation!: (cancel: () => Promise<void>) => void;
    let releaseTurn!: () => void;
    const turnRelease = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let cancelCalls = 0;
    const registry = new ActiveTurnDispatchRegistry({ onStarted: () => {}, onSettled: () => {} });
    const liveTurn = registry.run(
      { turnId: 42, channelId: "C1", threadTs: "stop-thread" },
      async (_steering, _close, cancellation) => {
        registerCancellation = (cancel) => cancellation.register(cancel);
        await turnRelease;
      },
    );

    const wrongTurn = registry.requestCancellation("C1", "stop-thread", 41);
    expect(wrongTurn).toEqual({ matched: false });
    const stop = registry.requestCancellation("C1", "stop-thread", 42);
    expect(stop.matched).toBeTrue();
    let cancellationFinished = false;
    if (stop.matched) void stop.completion.then(() => { cancellationFinished = true; });
    await Promise.resolve();
    expect(cancellationFinished).toBeFalse();
    registerCancellation(async () => { cancelCalls += 1; });
    if (stop.matched) await stop.completion;
    expect(cancelCalls).toBe(1);

    releaseTurn();
    await liveTurn;
  });

  test("dispatches a comparison into a forced-fresh session while the persistent session is busy", async () => {
    installPersistentChannel();
    const shared = createOrGetSession("C1", persistentSessionThreadTs("C1"), "claude-code");
    const first = acquireSessionTurn(shared.id, "400.000001", "shared turn", "runtime-1");
    expect(first.acquired).toBeTrue();

    claimComparisonRequest({
      requestId: "comparison-request",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: shared.id,
      sourceMessageTs: "400.000001",
      targetProvider: "codex",
      targetModel: "gpt-5.6",
    });
    const outcome = dispatchComparisonTurn({
      requestId: "comparison-request",
      channelId: "C1",
      channelName: "slack-inbox",
      threadTs: "400.000002",
      userId: "U1",
      text: "Compare this answer",
      client: {},
      provider: "codex",
      model: "gpt-5.6",
    }, {
      dispatch: (options: UserTurnDispatchOptions) => {
        const mode = effectiveSessionModeForMessage({
          channelSessionMode: "single-persistent",
          forceNewSession: options.forceNewSession,
          hasIsolatedThreadSession: false,
        });
        expect(mode).toBe("per-thread");
        expect(options.prebuiltPrompt).toBeTrue();
        expect(options.comparisonRequestId).toBe("comparison-request");
        const claimToken = "comparison-claim";
        claimSlackUserInput("C1", options.userMsgTs, claimToken, "runtime-1", {
          replyThreadTs: options.threadTs,
          userId: options.user,
          userText: options.text,
        });
        const comparisonSession = createOrGetSession("C1", options.threadTs, options.providerOverride!);
        const turn = acquireSessionTurn(
          comparisonSession.id,
          options.userMsgTs,
          options.text,
          "runtime-1",
          claimToken,
          options.threadTs,
          {
            providerModel: options.modelOverride,
            turnKind: "comparison",
            comparisonRequestId: options.comparisonRequestId,
          },
        );
        return { turn, sessionId: comparisonSession.id };
      },
    });

    expect(outcome.turn.acquired).toBeTrue();
    expect(outcome.turn.queued).toBeFalse();
    expect(outcome.sessionId).not.toBe(shared.id);
    expect(db.query("SELECT turn_id, status FROM comparison_requests WHERE request_id='comparison-request'").get())
      .toEqual({ turn_id: outcome.turn.id, status: "running" });
    expect(db.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 2 });
    expect(db.query("SELECT COUNT(*) AS count FROM turns WHERE status='queued'").get()).toEqual({ count: 0 });
  });

  test("rolls back turn admission when its comparison association cannot be persisted", () => {
    installPersistentChannel();
    const session = createOrGetSession("C1", "500.000001", "codex");
    claimSlackUserInput("C1", "500.000001", "comparison-claim", "runtime-1", {
      replyThreadTs: "500.000001",
      userId: "U1",
      userText: "Compare this answer",
    });

    expect(() => acquireSessionTurn(
      session.id,
      "500.000001",
      "Compare this answer",
      "runtime-1",
      "comparison-claim",
      "500.000001",
      { turnKind: "comparison", comparisonRequestId: "missing-request" },
    )).toThrow("could not be durably attached");

    expect(db.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 0 });
    expect(getSlackUserInputClaim("C1", "500.000001")).toMatchObject({
      kind: "pending",
      turn_id: null,
    });
  });
});
