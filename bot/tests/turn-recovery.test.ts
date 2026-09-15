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
import { attachSessionSteering, bindSessionProvider, createNativeSession, enqueueSessionInput, getAcceptedSessionInput, nativeRunId, retainSessionInput, sessionMetadata } from "../src/session-inputs";
import { SessionExecutionHost } from "../src/session-execution-host";
import { ActiveTurnDispatchRegistry } from "../src/turn-dispatch-seams";
import type { RunResult } from "../src/codex";

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
  db.query("DELETE FROM session_owner_events").run();
  db.query("DELETE FROM session_inputs").run();
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

describe("native turn restart recovery", () => {
  const slackCalls: string[] = [];
  const forbidSlack = async () => { slackCalls.push("unexpected Slack call"); throw new Error("Slack is absent."); };
  const services: TurnRecoveryServices = {
    deliverOutcome: forbidSlack, projectTurnStatus: forbidSlack, projectThreadSummary: forbidSlack,
    projectRootSummary: forbidSlack, stopAgentProgress: forbidSlack, setAgentSessionStatus: forbidSlack,
    scheduleWorkingReactionCleanup: forbidSlack,
  };
  const host = () => new SessionExecutionHost({ instanceId: "replacement-runtime", providers: {}, defaultCwd: "/tmp",
    registry: new ActiveTurnDispatchRegistry({ onStarted: () => {}, onSettled: () => {} }), wake: () => {} });
  const recover = (overrides: Partial<TurnRecoveryServices> = {}, extra: Record<string, unknown> = {}) => reconcileRecoverableTurns({
    client: null, nativeOnly: true, instanceId: "replacement-runtime", isOwnerAlive: () => false,
    services: { ...services, ...overrides }, ...extra,
  });
  function accept(sessionId: number, text = "Exact native request\n  preserved.") {
    const accepted = retainSessionInput({ sessionId, scope: "surface:thinkering", actionId: randomUUID(), kind: "input", origin: "human", payload: { text } }).input;
    return enqueueSessionInput(accepted.id);
  }
  function running(slackBorn = false) {
    const session = slackBorn ? createOrGetSession("C-retained-provenance", "900.000001", "codex")
      : createNativeSession("codex", { cwd: "/tmp", interactionPolicy: "consultation-only" });
    bindSessionProvider(session.id, "codex", randomUUID());
    const accepted = accept(session.id);
    state.registerProcessInstance("dead-runtime", 4321, "old-boot", "5678");
    const claim = claimNextQueuedTurn("dead-runtime")!;
    expect(claim.turn_id).toBe(accepted.turn_id);
    return { session: state.getSessionById(session.id)!, accepted, turnId: claim.turn_id };
  }
  function saved(text: string, slackBorn = false) {
    const fixture = running(slackBorn);
    const result: RunResult = { text, sessionUUID: fixture.session.agent_session_uuid, providerTurnId: randomUUID(), model: "reported-model", toolsUsed: [], durationMs: 0 };
    markTurnProviderAdmissionIntended(fixture.turnId, "dead-runtime", 1);
    state.markTurnProviderStarted(fixture.turnId);
    state.recordTurnProviderTurnId(fixture.turnId, result.providerTurnId);
    expect(markTurnDelivering(fixture.turnId, text, JSON.stringify({ version: 1, result }), 0, null, result.durationMs)).toBeTrue();
    return { ...fixture, result };
  }
  test.each([false,true])('fork control owner death preserves exact accepted intent and only requeues before effect intent (%s)',async intended=>{
    const session=createNativeSession('codex',{cwd:'/tmp'});bindSessionProvider(session.id,'codex','exact-original-parent');
    const operation=retainSessionInput({sessionId:session.id,scope:'surface:thinkering',actionId:randomUUID(),kind:'fork',origin:'human',payload:{boundary:'exact-native-cutoff'}}).input;
    const pin={provider:'codex',parentSessionUUID:'exact-original-parent',bindingGeneration:1,boundary:'exact-native-cutoff',cwd:'/tmp',threadSource:`concierge-native-fork:${operation.id}`};
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({fork:pin}),operation.id);
    const accepted=enqueueSessionInput(operation.id);
    state.registerProcessInstance('dead-runtime',4321,'old-boot','5678');const claim=claimNextQueuedTurn('dead-runtime');
    expect(claim.turn_id).toBe(accepted.turn_id);
    if(intended)markTurnProviderAdmissionIntended(claim.turn_id,'dead-runtime',claim.dispatch_attempt);
    await recover();
    expect(db.query('SELECT status FROM turns WHERE id=?').get(claim.turn_id)).toEqual({status:intended?'interrupted':'queued'});
    expect(JSON.parse(getAcceptedSessionInput(operation.id)!.receipt_json!)).toEqual({fork:pin});
    expect(state.getSessionById(session.id).agent_session_uuid).toBe('exact-original-parent');
    expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({n:1});
    if(intended)expect(claimNextQueuedTurn('replacement-runtime')).toBeNull();
    else expect(claimNextQueuedTurn('replacement-runtime').turn_id).toBe(claim.turn_id);
  });
  beforeEach(() => { slackCalls.length = 0; });
  afterEach(() => { expect(slackCalls).toEqual([]); });

  test.each(["", "Exact output\n  trailing space \n"])("delivers saved native output %j before releasing FIFO, with no Slack identities", async text => {
    const fixture = saved(text);
    const successor = accept(fixture.session.id, "next request");
    const runtime = host();
    const observations: unknown[] = [];
    expect(await recover({ deliverNativeResult: async result => {
      observations.push(result);
      expect(claimNextQueuedTurn("replacement-runtime")).toBeNull();
      expect(db.query("SELECT agent_text, outbound_text, delivery_status FROM turns WHERE id=?").get(fixture.turnId))
        .toEqual({ agent_text: text, outbound_text: JSON.stringify({ version: 1, result: fixture.result }), delivery_status: "pending" });
      return runtime.deliverResult(result);
    } })).toBe("done");
    expect(observations).toEqual([{ ...fixture.result, turnId: fixture.turnId, sessionId: fixture.session.id, inputId: fixture.accepted.id }]);
    expect(db.query("SELECT status, delivery_status, slack_user_msg_ts, slack_bot_msg_ts, slack_reply_thread_ts, provider_duration_ms FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "done", delivery_status: "delivered", slack_user_msg_ts: null, slack_bot_msg_ts: null, slack_reply_thread_ts: null, provider_duration_ms: 0 });
    expect(db.query("SELECT payload_json FROM session_owner_events WHERE event_id=?").get(`result:${fixture.turnId}`))
      .toEqual({ payload_json: JSON.stringify({ ...fixture.result, turnId: fixture.turnId, sessionId: fixture.session.id, inputId: fixture.accepted.id, runId: nativeRunId(fixture.turnId) }) });
    expect(db.query("SELECT 1 FROM turn_delivery_chunks WHERE turn_id=?").get(fixture.turnId)).toBeNull();
    expect(db.query("SELECT 1 FROM turn_reaction_cleanups WHERE turn_id=?").get(fixture.turnId)).toBeNull();
    expect(runtime.owner.receipt(getAcceptedSessionInput(fixture.accepted.id)!)).toMatchObject({ state: "completed", result: text });
    expect(claimNextQueuedTurn("replacement-runtime")?.turn_id).toBe(successor.turn_id);
    expect(await recover({}, { isOwnerAlive: () => true })).toBe("done");
    expect(db.query("SELECT delivery_status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ delivery_status: "delivered" });
  });

  test("retries the identical durable native event after callback acknowledgement is lost", async () => {
    const fixture = saved("");
    const runtime = host();
    await expect(recover({ deliverNativeResult: async result => {
      await runtime.deliverResult(result);
      throw new Error("lost result acknowledgement");
    } })).rejects.toThrow("lost result acknowledgement");
    expect(db.query("SELECT status,owner_instance_id,delivery_status FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "delivering", owner_instance_id: null, delivery_status: "pending" });
    expect(await recover({ deliverNativeResult: result => runtime.deliverResult(result) })).toBe("done");
    expect(db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").all(`result:${fixture.turnId}`)).toHaveLength(1);
    expect(sessionMetadata(state.getSessionById(fixture.session.id)).generation).toBe(1);
  });

  test("finishes confirmed delivery after restart without repeating its result callback", async () => {
    const fixture = saved("delivered already");
    await host().deliverResult({ ...fixture.result, turnId: fixture.turnId, sessionId: fixture.session.id, inputId: fixture.accepted.id });
    markTurnResponseDelivered(fixture.turnId);
    expect(await recover({ deliverNativeResult: async () => { throw new Error("must not redeliver"); } })).toBe("done");
    expect(db.query("SELECT status,delivery_status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ status: "done", delivery_status: "delivered" });
  });

  test("never downgrades a confirmed result when terminal accounting fails", async () => {
    const fixture = saved("delivered before accounting");
    db.exec(`CREATE TEMP TRIGGER native_recovery_accounting_failure BEFORE UPDATE ON turns
      WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT, 'accounting unavailable'); END;`);
    try {
      await expect(recover({ deliverNativeResult: result => host().deliverResult(result) })).rejects.toThrow("accounting unavailable");
    } finally {
      db.exec("DROP TRIGGER native_recovery_accounting_failure");
    }
    expect(db.query("SELECT status,delivery_status,owner_instance_id FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "delivering", delivery_status: "delivered", owner_instance_id: null });
    expect(await recover({ deliverNativeResult: async () => { throw new Error("must not repeat confirmed result"); } })).toBe("done");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ status: "done" });
  });

  test("parks retained native output explicitly when its delivery adapter is absent", async () => {
    const fixture = saved("preserved result");
    expect(await recover()).toBe("done");
    expect(db.query("SELECT status,agent_text,delivery_error FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "delivery_parked", agent_text: "preserved result", delivery_error: "Native result delivery adapter is unavailable." });
  });

  test.each(["running", "delivering"])("leaves a proven live owner and its %s work untouched", async status => {
    const fixture = status === "running" ? running() : saved("live result");
    const before = db.query("SELECT * FROM turns WHERE id=?").get(fixture.turnId);
    const observed: unknown[] = [];
    expect(await recover({}, { isOwnerAlive: (identity: unknown) => { observed.push(identity); return true; } })).toBe("done");
    expect(observed).toEqual([{ pid: 4321, bootId: "old-boot", startTicks: "5678" }]);
    expect(db.query("SELECT * FROM turns WHERE id=?").get(fixture.turnId)).toEqual(before);
  });

  test("a concurrent recovery cannot claim another replacement's native delivery", async () => {
    const fixture = saved("one result");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = recover({ deliverNativeResult: async result => { entered(); await blocked; return host().deliverResult(result); } });
    await started;
    expect(await recover({ deliverNativeResult: async () => { throw new Error("second owner must not publish"); } }, {
      instanceId: "third-runtime", isOwnerAlive: () => true,
    })).toBe("done");
    release();
    await first;
    expect(db.query("SELECT status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ status: "done" });
  });

  test.each(["stopped", "permanent_failure"] as const)("retains saved output when native delivery returns %s", async outcome => {
    const fixture = saved("retained output");
    expect(await recover({ deliverNativeResult: async () => outcome })).toBe(outcome === "stopped" ? "stopped" : "done");
    expect(db.query("SELECT status,owner_instance_id,agent_text,delivery_status FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: outcome === "stopped" ? "delivering" : "delivery_parked", owner_instance_id: null,
        agent_text: "retained output", delivery_status: outcome === "stopped" ? "pending" : "parked" });
  });

  test.each(["missing", "json", "version", "text", "provider", "provider_turn", "tools", "input_turn", "input_session", "input_steering"])("parks invalid native %s evidence without blocking other recovery", async fault => {
    const fixture = saved("keep these bytes");
    const envelope = { version: 1, result: { ...fixture.result } } as any;
    if (fault === "missing") db.query("UPDATE turns SET outbound_text=NULL WHERE id=?").run(fixture.turnId);
    else if (fault === "json") db.query("UPDATE turns SET outbound_text='not json' WHERE id=?").run(fixture.turnId);
    else if (fault.startsWith("input_")) {
      if (fault === "input_turn") db.query("UPDATE session_inputs SET turn_id=NULL WHERE id=?").run(fixture.accepted.id);
      if (fault === "input_session") db.query("UPDATE session_inputs SET session_id=? WHERE id=?").run(createNativeSession("codex", {}).id, fixture.accepted.id);
      if (fault === "input_steering") {
        const steering = db.query("INSERT INTO turn_steering_messages(turn_id,slack_user_msg_ts,user_text,replay_text) VALUES(?,NULL,'steer','steer')").run(fixture.turnId);
        db.query("UPDATE session_inputs SET steering_id=? WHERE id=?").run(Number(steering.lastInsertRowid), fixture.accepted.id);
      }
    } else {
      if (fault === "version") envelope.version = 2;
      if (fault === "text") envelope.result.text = "wrong result";
      if (fault === "provider") envelope.result.sessionUUID = randomUUID();
      if (fault === "provider_turn") envelope.result.providerTurnId = randomUUID();
      if (fault === "tools") delete envelope.result.toolsUsed;
      db.query("UPDATE turns SET outbound_text=? WHERE id=?").run(JSON.stringify(envelope), fixture.turnId);
    }
    const next = saved("healthy other session");
    const results: number[] = [];
    expect(await recover({ deliverNativeResult: async result => { results.push(result.turnId); return host().deliverResult(result); } })).toBe("done");
    expect(results).toEqual([next.turnId]);
    expect(db.query("SELECT status,agent_text,delivery_status FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "delivery_parked", agent_text: "keep these bytes", delivery_status: "parked" });
    expect(state.getSessionById(fixture.session.id).status).toBe("idle");
  });

  test("requeues only unattempted native input with its policy and same turn/input/run identities", async () => {
    const fixture = running();
    const runId = nativeRunId(fixture.turnId);
    const original = getAcceptedSessionInput(fixture.accepted.id)!;
    expect(await recover()).toBe("done");
    expect(getAcceptedSessionInput(fixture.accepted.id)).toEqual(original);
    const retried = claimNextQueuedTurn("replacement-runtime");
    expect(retried).toMatchObject({ turn_id: fixture.turnId, session_id: fixture.session.id, accepted_input_id: fixture.accepted.id, dispatch_attempt: 2, slack_user_msg_ts: null });
    expect(nativeRunId(fixture.turnId)).toBe(runId);
    expect(sessionMetadata(state.getSessionById(fixture.session.id)).interactionPolicy).toBe("consultation-only");
  });

  test.each(["admission", "started", "turn_id", "acknowledged", "steering"])("preserves native uncertainty from %s evidence despite a retained Stop", async evidence => {
    const fixture = running();
    if (evidence === "admission") markTurnProviderAdmissionIntended(fixture.turnId, "dead-runtime", 1);
    if (evidence === "started") state.markTurnProviderStarted(fixture.turnId);
    if (evidence === "turn_id") state.recordTurnProviderTurnId(fixture.turnId, "observed-turn");
    if (evidence === "acknowledged") state.acknowledgeTurnProviderInput(fixture.turnId, "dead-runtime", 1, []);
    if (evidence === "steering") {
      const input = retainSessionInput({ sessionId: fixture.session.id, scope: "surface:thinkering", actionId: randomUUID(), kind: "input", origin: "human", payload: { text: "steer" } }).input;
      const steering = attachSessionSteering(input.id, fixture.turnId);
      state.markTurnSteeringMessageSending(steering.steering_id);
    }
    db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(fixture.turnId);
    const next = accept(fixture.session.id, "new question");
    expect(await recover()).toBe("done");
    expect(db.query("SELECT status,replay_text FROM turns WHERE id=?").get(fixture.turnId))
      .toEqual({ status: "interrupted", replay_text: "Exact native request\n  preserved." });
    expect(host().owner.receipt(getAcceptedSessionInput(fixture.accepted.id)!)).toMatchObject({ state: "uncertain" });
    expect(claimNextQueuedTurn("replacement-runtime")?.turn_id).toBe(next.turn_id);
    if (evidence === "steering") expect(db.query("SELECT status,notice_status FROM turn_steering_messages WHERE turn_id=?").get(fixture.turnId))
      .toEqual({ status: "ambiguous", notice_status: "not_needed" });
  });

  test("settles native Stop before admission without invoking any provider", async () => {
    const fixture = running();
    db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(fixture.turnId);
    expect(await recover()).toBe("done");
    expect(host().owner.receipt(getAcceptedSessionInput(fixture.accepted.id)!)).toMatchObject({ state: "canceled" });
    expect(claimNextQueuedTurn("replacement-runtime")).toBeNull();
  });

  test("settles an unattempted old Slack artifact batch when Stop survives its owner", async () => {
    const session = createOrGetSession("C-stopped-artifact", "909.000001", "codex");
    const turn = acquireSessionTurn(session.id, "909.000002", "request", "dead-runtime", undefined, "909.000001");
    const token = randomUUID();
    const directory = prepareArtifactDirectory(projectDir, turn.id, token);
    createTurnArtifactBatch(turn.id, token, directory);
    db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(turn.id);
    expect(await recover()).toBe("done");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toEqual({ status: "cancelled" });
    expect(getTurnArtifactBatch(turn.id).status).toBe("abandoned");
    expect(existsSync(directory)).toBeTrue();
  });

  test("does not replay native work whose provider start survived without its admission marker", async () => {
    const fixture = running();
    state.markTurnProviderStarted(fixture.turnId);
    expect(await recover()).toBe("done");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ status: "interrupted" });
    expect(claimNextQueuedTurn("replacement-runtime")).toBeNull();
  });

  test("native delivery bypasses Slack services even when the Slack runtime is enabled", async () => {
    const fixture = saved("native surface result", true);
    expect(await recover({ deliverNativeResult: result => host().deliverResult(result) }, { nativeOnly: false })).toBe("done");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(fixture.turnId)).toEqual({ status: "done" });
  });

  test("recovers native delivery on an originally Slack-born session with Slack absent", async () => {
    const fixture = saved("same provider conversation", true);
    const original = { ...fixture.session };
    expect(await recover({ deliverNativeResult: result => host().deliverResult(result) })).toBe("done");
    expect(state.getSessionById(fixture.session.id)).toMatchObject({ id: original.id, slack_channel_id: original.slack_channel_id,
      slack_thread_ts: original.slack_thread_ts, agent_session_uuid: original.agent_session_uuid });
    const next = accept(fixture.session.id);
    expect(claimNextQueuedTurn("replacement-runtime")).toMatchObject({ turn_id: next.turn_id, session_id: original.id, agent_session_uuid: original.agent_session_uuid });
  });

  test.each(["pre_admission", "running", "delivering", "delivered"])("settles an old Slack %s turn without Slack, preserving its session and result", async phase => {
    const session = createOrGetSession("C-old-slack", "910.000001", "codex");
    bindSessionProvider(session.id, "codex", "retained-slack-provider-session");
    const old = acquireSessionTurn(session.id, "910.000002", "old input", "dead-runtime", undefined, "910.000001");
    state.setTurnReplayInput(old.id, "Exact old prepared input.", 0);
    if (phase !== "pre_admission") markTurnProviderAdmissionIntended(old.id, "dead-runtime", 1);
    if (phase === "delivering" || phase === "delivered") markTurnDelivering(old.id, "", "Exact saved Slack output.", 1);
    if (phase === "delivered") markTurnResponseDelivered(old.id);
    const next = accept(session.id, "new native input");
    expect(await recover()).toBe("done");
    const statuses = { pre_admission: "queued", running: "interrupted", delivering: "delivery_parked", delivered: "done" };
    expect(db.query("SELECT status,turn_kind,replay_text FROM turns WHERE id=?").get(old.id))
      .toEqual({ status: statuses[phase], turn_kind: "slack_user", replay_text: "Exact old prepared input." });
    if (phase === "delivering" || phase === "delivered") expect(db.query("SELECT agent_text,outbound_text,delivery_status FROM turns WHERE id=?").get(old.id))
      .toEqual({ agent_text: "", outbound_text: "Exact saved Slack output.", delivery_status: phase === "delivered" ? "delivered" : "parked" });
    expect(db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(`result:${old.id}`)).toBeNull();
    expect(claimNextQueuedTurn("replacement-runtime")).toMatchObject({ turn_id: phase === "pre_admission" ? old.id : next.turn_id,
      session_id: session.id, agent_session_uuid: "retained-slack-provider-session" });
  });

  test("parks old Slack artifact publication without deleting its evidence or blocking native continuation", async () => {
    const session = createOrGetSession("C-old-artifact", "920.000001", "codex");
    const old = acquireSessionTurn(session.id, "920.000002", "old request", "dead-runtime", undefined, "920.000001");
    const token = randomUUID();
    const directory = artifactDirectoryForTurn(projectDir, old.id, token);
    prepareArtifactDirectory(projectDir, old.id, token);
    createTurnArtifactBatch(old.id, token, directory);
    writeFileSync(join(directory, "saved.txt"), "retain this evidence");
    const { findTurnArtifacts } = await import("../src/artifacts");
    state.registerTurnArtifactIntents(old.id, findTurnArtifacts(directory));
    markTurnDelivering(old.id, "provider result", "Slack output", 1);
    const next = accept(session.id);
    expect(await recover()).toBe("done");
    expect(db.query("SELECT status FROM turn_artifact_deliveries WHERE turn_id=?").get(old.id)).toEqual({ status: "parked" });
    expect(existsSync(join(directory, "saved.txt"))).toBeTrue();
    expect(claimNextQueuedTurn("replacement-runtime")?.turn_id).toBe(next.turn_id);
  });
});

describe("turn restart recovery", () => {
  test.each([false, true])("recovers persisted Stop without replay and retains receipt evidence, acknowledged=%s", async acknowledged => {
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
    const saved = "Exact audio transcript saved before crash\n  Preserve these bytes.\n";
    state.setTurnReplayInput(turn.id, saved, 0);
    markTurnProviderAdmissionIntended(turn.id, "dead-runtime", 1);
    if (acknowledged) state.acknowledgeTurnProviderInput(turn.id, "dead-runtime", 1, []);
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
    const next = acquireSessionTurn(session.id, "771.000001", "resume", "replacement-runtime", undefined, threadTs);
    expect(next.acquired).toBeTrue();
    expect(state.getTurnReplayInput(turn.id)).toBe(saved);
    expect(state.listInterruptedInputContext(next.id).map((input: any) => input.turn_id)).toEqual(acknowledged ? [] : [turn.id]);
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
    db.exec(`CREATE TEMP TRIGGER fail_agent_progress_insert
      BEFORE INSERT ON agent_progress_messages BEGIN
        SELECT RAISE(ABORT, 'forced progress insert failure');
      END;`);
    try {
      expect(() => beginAgentProgressMessages(turn.id, [
        { type: "task_update", id: "start", title: "Working", status: "in_progress" },
      ])).toThrow("forced progress insert failure");
    } finally {
      db.exec("DROP TRIGGER fail_agent_progress_insert");
    }
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
