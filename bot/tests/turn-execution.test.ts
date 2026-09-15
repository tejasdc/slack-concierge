import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/providers";
import { runClaudeCodeTurn } from "../src/claude-code";
import { runCodexTurn } from "../src/codex";
import { CodexAppServerClientError, type CodexAppServerClientLike } from "../src/codex-app-server-client";
import { slackBucket } from "../src/rate-limit";
import { TurnSteeringController } from "../src/steering";
import * as attachments from "../src/attachments";
import { prepareProviderInput } from "../src/provider-input";
import { CONCIERGE_SESSION_RESPONSE_CONTRACT } from "../src/response-contract";
import { SessionTurnQueueCoordinator } from "../src/session-turn-queue";
import { ActiveTurnDispatchRegistry } from "../src/turn-dispatch-seams";
import { handleAgentSessionStop } from "../src/agent-session-stop";
import { queueAgentProgressMessages, projectAgentProgressMessages } from "../src/agent-progress-messages";
import { ProviderDispatchError, ProviderTurnCancelledError } from "../src/provider-failures";
import { executeAgentTurn, type NativeTurnExecutionInput, type TurnExecutionServices } from "../src/turn-execution";
import { bindSessionProvider, createNativeSession, enqueueSessionInput, recordSessionEvent, retainSessionInput } from "../src/session-inputs";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  beginTurnProgressStream,
  claimSlackThreadStatusProjection,
  claimNextQueuedTurn,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  getChannel,
  getTurnArtifactBatch,
  getSession,
  getSlackThreadStatus,
  getTurnStatusProjection,
  listRecoverableTurns,
  markDeliveryChunkDelivered,
  parkSlackRootSummaryProjection,
  markSlackThreadStatusProjectionDelivered,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  recordTurnProgressStreamStarted,
  requestSlackRootSummaryProjection,
  claimSlackRootSummaryProjection,
  requestSlackThreadStatusProjection,
  requestTurnStatusProjection,
  upsertChannel,
  upsertSession,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM session_owner_events").run();
  db.query("DELETE FROM session_inputs").run();
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
  projectDir = mkdtempSync(join(tmpdir(), "concierge-turn-execution-"));
});

afterEach(() => {
  db.query("DELETE FROM session_owner_events").run();
  db.query("DELETE FROM session_inputs").run();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

async function projectTurnStatus(client: any, turnId: number, text: string) {
  requestTurnStatusProjection(turnId, text);
  const claimed = claimTurnStatusProjection(turnId, Date.now());
  if (!claimed) return "permanent_failure" as const;
  if (claimed.slack_status_msg_ts) {
    await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
  } else {
    const posted = await client.chat.postMessage({
      thread_ts: claimed.slack_thread_ts,
      text: claimed.desired_text,
    });
    recordTurnStatusMessage(turnId, claimed.message_generation, posted.ts);
  }
  markTurnStatusProjectionDelivered(turnId, claimed.desired_revision);
  return "delivered" as const;
}

async function projectThreadSummary(channel: string, threadTs: string, turnId: number, text: string) {
  requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
  const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
  if (!claimed) return "permanent_failure" as const;
  markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
  return "delivered" as const;
}

function nativeExecutionFixture(slackBorn = false): NativeTurnExecutionInput {
  const session = slackBorn ? createOrGetSession("CPRIOR", "100.1", "codex")
    : createNativeSession("codex", { cwd: projectDir });
  if (slackBorn) bindSessionProvider(session.id, "codex", "prior-provider-branch");
  const accepted = retainSessionInput({ sessionId: session.id, scope: "native-test", actionId: "resume",
    kind: "input", origin: "human", payload: { text: "Continue this exact conversation." } }).input;
  enqueueSessionInput(accepted.id);
  const claim = claimNextQueuedTurn("native-owner");
  if (!claim || claim.session_id !== session.id) throw new Error("Native input must acquire the existing turn queue.");
  const steering = new TurnSteeringController();
  return {
    presentation: "native", inputId: accepted.id, turnKind: "native", turnId: claim.turn_id,
    session: state.getSessionById(session.id), text: claim.turn_user_text, prompt: claim.turn_user_text,
    providerId: "codex", providerLabel: "Codex", ownerInstanceId: "native-owner",
    cwd: projectDir, additionalDirs: [], dispatchAttempt: claim.dispatch_attempt,
    steeringController: steering, closeSteering: reason => steering.close(reason),
    provider: { id: "codex", async run() { throw new Error("A test must provide its provider boundary."); },
      async fork() { throw new Error("A native resume must never fork."); } },
    services: { bindProviderSession: bindSessionProvider, async deliverResult(result) {
      expect(db.query("SELECT status,agent_text FROM turns WHERE id=?").get(result.turnId))
        .toEqual({ status: "delivering", agent_text: result.text });
      const saved = db.query("SELECT outbound_text FROM turns WHERE id=?").get(result.turnId);
      const { turnId, sessionId, inputId, ...providerResult } = result;
      expect(JSON.parse(saved.outbound_text)).toEqual({ version: 1, result: providerResult });
      recordSessionEvent({ eventId: `result:${result.turnId}`, sessionId: result.sessionId,
        inputId: result.inputId, turnId: result.turnId, kind: "result", payload: result });
      return "delivered";
    } },
  };
}

describe("executeAgentTurn", () => {
  test.each([false, true])("executes a native input with no Slack dependencies; Slack-born session=%s", async (slackBorn) => {
    const input = nativeExecutionFixture(slackBorn);
    const originalBinding = { channel: input.session.slack_channel_id, root: input.session.slack_thread_ts };
    const observed: Parameters<AgentProvider["run"]>[0][] = [];
    let attachmentRoot = "";
    input.services.onProgress = () => { throw new Error("Transient observer disconnected."); };
    input.provider.run = async request => {
      observed.push(request);
      expect(db.query("SELECT provider_admission_intended_at FROM turns WHERE id=?").get(input.turnId).provider_admission_intended_at).not.toBeNull();
      expect(request.sessionUUID).toBe(slackBorn ? "prior-provider-branch" : null);
      expect(request.prompt).toBe(input.prompt);
      expect(request.systemPrompt).toBeUndefined();
      expect(request.environment?.CONCIERGE_ACCEPTED_INPUT_ID).toBe(input.inputId);
      expect(request.environment).not.toHaveProperty("CONCIERGE_SLACK_CHANNEL_ID");
      expect(request.environment).not.toHaveProperty("CONCIERGE_SLACK_THREAD_TS");
      attachmentRoot = request.additionalDirs.at(-1)!;
      expect(existsSync(attachmentRoot)).toBeTrue();
      request.onProviderThreadStarted?.(request.sessionUUID ?? "new-provider-branch");
      request.onProviderTurnStarted?.("provider-turn-1");
      request.onInputAcknowledged?.();
      request.onProgress?.({ type: "commentary", text: "Current native progress." });
      return { text: "  Exact native result\n\nNo Slack formatting.  ", model: "reported-model",
        sessionUUID: request.sessionUUID ?? "new-provider-branch", providerTurnId: "provider-turn-1", toolsUsed: [], durationMs: 321 };
    };
    const network = spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Native input attempted a network/Slack request outside its provider."); });
    try {
      expect(await executeAgentTurn(input)).toEqual({ status: "delivered", turnId: input.turnId });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
    expect(observed).toHaveLength(1);
    const row = db.query("SELECT * FROM turns WHERE id=?").get(input.turnId);
    expect(row).toMatchObject({ status: "done", slack_user_msg_ts: null, slack_bot_msg_ts: null,
      agent_text: "  Exact native result\n\nNo Slack formatting.  ",
      provider_duration_ms: 321, provider_turn_id: "provider-turn-1", delivery_status: "delivered" });
    expect(JSON.parse(row.outbound_text)).toMatchObject({ version: 1, result: {
      text: row.agent_text, model: "reported-model", providerTurnId: "provider-turn-1", durationMs: 321,
    } });
    expect(row.provider_input_acknowledged_at).not.toBeNull();
    expect(row.status_projection_status).toBe("not_needed");
    expect(state.getSessionById(input.session.id)).toMatchObject({ id: input.session.id, status: "idle",
      slack_channel_id: originalBinding.channel, slack_thread_ts: originalBinding.root,
      agent_session_uuid: slackBorn ? "prior-provider-branch" : "new-provider-branch" });
    expect(db.query("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 1 });
    expect(db.query("SELECT count(*) AS count FROM turn_delivery_chunks").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM turn_reaction_cleanups").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM slack_user_input_claims").get()).toEqual({ count: 0 });
    expect(db.query("SELECT count(*) AS count FROM session_owner_events WHERE kind='result'").get()).toEqual({ count: 1 });
    expect(existsSync(join(projectDir, ".artifacts"))).toBeFalse();
    expect(existsSync(attachmentRoot)).toBeFalse();
  });

  test("a native delivery interruption keeps saved provider output under the same turn", async () => {
    const input = nativeExecutionFixture(true);
    let calls = 0;
    input.provider.run = async request => {
      calls += 1;
      request.onInputAcknowledged?.();
      return { text: "retained native result", model: "reported-model", sessionUUID: "prior-provider-branch",
        providerTurnId: "provider-complete", toolsUsed: ["Read"], durationMs: 123 };
    };
    input.services.deliverResult = async () => { throw new Error("result consumer disconnected"); };
    expect(await executeAgentTurn(input)).toEqual({ status: "delivery_stopped", turnId: input.turnId });
    expect(calls).toBe(1);
    const saved = db.query("SELECT status,agent_text,outbound_text,owner_instance_id,delivery_status FROM turns WHERE id=?").get(input.turnId);
    expect(saved).toMatchObject({ status: "delivering", agent_text: "retained native result", owner_instance_id: null, delivery_status: "pending" });
    expect(JSON.parse(saved.outbound_text)).toEqual({ version: 1, result: {
      text: "retained native result", model: "reported-model", sessionUUID: "prior-provider-branch",
      providerTurnId: "provider-complete", toolsUsed: ["Read"], durationMs: 123,
    } });
    expect(state.getSessionById(input.session.id).status).toBe("running");
    expect(claimNextQueuedTurn("different-owner")).toBeNull();
  });

  test("an empty native result remains exact output and still settles its delivery", async () => {
    const input = nativeExecutionFixture();
    input.provider.run = async request => {
      request.onInputAcknowledged?.();
      return { text: "", sessionUUID: "empty-result-branch", toolsUsed: [] };
    };
    expect(await executeAgentTurn(input)).toEqual({ status: "delivered", turnId: input.turnId });
    const saved = db.query("SELECT status,agent_text,outbound_text,delivery_status FROM turns WHERE id=?").get(input.turnId);
    expect(saved).toMatchObject({ status: "done", agent_text: "", delivery_status: "delivered" });
    expect(JSON.parse(saved.outbound_text)).toEqual({ version: 1, result: { text: "", sessionUUID: "empty-result-branch", toolsUsed: [] } });
    const event = db.query("SELECT payload_json FROM session_owner_events WHERE kind='result'").get();
    expect(JSON.parse(event.payload_json).text).toBe("");
  });

  test("permanently rejected native result delivery retains raw output and releases the session", async () => {
    const input = nativeExecutionFixture(true);
    input.provider.run = async request => {
      request.onInputAcknowledged?.();
      return { text: "saved despite consumer rejection", sessionUUID: "prior-provider-branch", toolsUsed: [] };
    };
    input.services.deliverResult = async () => "permanent_failure";
    expect(await executeAgentTurn(input)).toEqual({ status: "delivery_parked", turnId: input.turnId });
    expect(db.query("SELECT status,agent_text,delivery_status,status_projection_status FROM turns WHERE id=?").get(input.turnId))
      .toEqual({ status: "delivery_parked", agent_text: "saved despite consumer rejection", delivery_status: "parked", status_projection_status: "not_needed" });
    expect(state.getSessionById(input.session.id).status).toBe("idle");
    expect(db.query("SELECT count(*) AS count FROM turn_reaction_cleanups").get()).toEqual({ count: 0 });
  });

  test.each([true, false])("native provider failures retain existing retry/ambiguity decisions; terminal confirmed=%s", async terminalConfirmed => {
    const input = nativeExecutionFixture();
    let calls = 0;
    input.provider.run = async () => {
      calls += 1;
      throw new ProviderDispatchError({ message: "temporarily unavailable", failureClass: "retryable", terminalConfirmed });
    };
    expect(await executeAgentTurn(input)).toEqual({ status: terminalConfirmed ? "retry_queued" : "provider_parked", turnId: input.turnId });
    expect(calls).toBe(1);
    expect(db.query("SELECT status,dispatch_failure_class,owner_instance_id FROM turns WHERE id=?").get(input.turnId))
      .toEqual({ status: terminalConfirmed ? "queued" : "parked", dispatch_failure_class: terminalConfirmed ? "retryable" : "parked_ambiguous", owner_instance_id: null });
    expect(db.query("SELECT count(*) AS count FROM turn_delivery_chunks").get()).toEqual({ count: 0 });
  });

  test.each(['parked_terminal','parked_access'] as const)('confirmed native provider refusal settles as failure without a retry: %s',async failureClass=>{
    const input=nativeExecutionFixture();let calls=0;
    input.provider.run=async()=>{calls++;throw new ProviderDispatchError({message:'Provider refused this input',failureClass,terminalConfirmed:true});};
    expect(await executeAgentTurn(input)).toMatchObject({status:'error',turnId:input.turnId});
    expect(db.query('SELECT status,owner_instance_id,agent_text FROM turns WHERE id=?').get(input.turnId)).toMatchObject({status:'error',owner_instance_id:null,agent_text:expect.stringContaining('Provider refused this input')});
    expect(calls).toBe(1);
    expect(state.getSessionById(input.session.id).status).toBe('error');
    const next=retainSessionInput({sessionId:input.session.id,scope:'native-test',actionId:'after-refusal',kind:'input',origin:'human',payload:{text:'New authorized input'}}).input;
    enqueueSessionInput(next.id);
    expect(claimNextQueuedTurn('next-owner')?.accepted_input_id).toBe(next.id);
  });

  test("native Stop before admission preserves input and cancels without invoking a provider", async () => {
    const input = nativeExecutionFixture();
    db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(input.turnId);
    let calls = 0;
    input.provider.run = async () => { calls += 1; throw new Error("Stopped input must not be submitted."); };
    expect(await executeAgentTurn(input)).toEqual({ status: "cancelled", turnId: input.turnId });
    expect(calls).toBe(0);
    expect(db.query("SELECT status,replay_text,provider_admission_intended_at FROM turns WHERE id=?").get(input.turnId))
      .toEqual({ status: "cancelled", replay_text: input.prompt, provider_admission_intended_at: null });
    expect(state.getSessionById(input.session.id).status).toBe("idle");
  });

  test("canonical Stop cancels a native provider through the executor's existing cancellation boundary", async () => {
    const input = nativeExecutionFixture(true);
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let rejectProvider!: (error: Error) => void;
    const providerResult = new Promise<never>((_resolve, reject) => { rejectProvider = reject; });
    let cancels = 0;
    input.provider.run = async request => {
      request.onInputAcknowledged?.();
      request.onCancellationReady?.(async () => { cancels += 1; rejectProvider(new ProviderTurnCancelledError("Stopped from native session.")); });
      ready();
      return providerResult;
    };
    const execution = registry.run({ sessionId: input.session.id, turnId: input.turnId }, (controller, close, cancellation) => executeAgentTurn({
      ...input, steeringController: controller, closeSteering: close, cancellationController: cancellation,
    }));
    await started;
    db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(input.turnId);
    const stop = registry.requestSessionCancellation(input.session.id, input.turnId);
    if (!stop.matched) throw new Error("Native Stop did not find its exact turn.");
    await stop.completion;
    expect(await execution).toEqual({ status: "cancelled", turnId: input.turnId });
    expect(cancels).toBe(1);
    expect(db.query("SELECT status,owner_instance_id FROM turns WHERE id=?").get(input.turnId)).toEqual({ status: "cancelled", owner_instance_id: null });
    expect(state.getSessionById(input.session.id).status).toBe("idle");
    expect(db.query("SELECT count(*) AS count FROM session_owner_events WHERE kind='result'").get()).toEqual({ count: 0 });
  });

  test("unacknowledged Codex Stop parks the exact native input and blocks its FIFO successor", async () => {
    const input = nativeExecutionFixture(true);
    input.interactionPolicy = "consultation-only";
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    let submitted!: () => void, release!: () => void, submissions = 0;
    const entered = new Promise<void>(resolve => { submitted = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const client: CodexAppServerClientLike = {
      async connect() { return 1; },
      async request(method, params: any) {
        if (method === "config/read") return { config: { mcp_servers: {} } };
        if (method === "thread/resume") return { thread: { id: params.threadId }, approvalPolicy: "never",
          activePermissionProfile: { id: "concierge-consultation" }, sandbox: { type: "readOnly", networkAccess: false } };
        if (method === "turn/start") {
          submissions += 1; submitted(); await pending;
          throw new CodexAppServerClientError("late unconfirmed start failure", "ambiguous");
        }
        throw new Error(`Unexpected provider effect: ${method}`);
      },
      async notify() {}, onNotification() { return () => true; }, onDisconnect() { return () => true; },
      async waitForDisconnect() {},
    };
    input.provider.run = request => runCodexTurn({ ...request, appServerClient: client });
    const execution = registry.run({ sessionId: input.session.id, turnId: input.turnId }, (controller, close, cancellation) => executeAgentTurn({
      ...input, steeringController: controller, closeSteering: close, cancellationController: cancellation,
    }));
    try {
      await entered;
      db.query("UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?").run(input.turnId);
      const stop = registry.requestSessionCancellation(input.session.id, input.turnId);
      if (!stop.matched) throw new Error("Native Stop did not find its exact turn.");
      await expect(stop.completion).rejects.toMatchObject({ terminalConfirmed: false, providerSessionId: "prior-provider-branch", providerTurnId: null });
      expect(await execution).toEqual({ status: "provider_parked", turnId: input.turnId });
      const saved = db.query("SELECT status,dispatch_failure_class,owner_instance_id,accepted_input_id,replay_text,provider_turn_id,provider_input_acknowledged_at,stop_requested_at,agent_text FROM turns WHERE id=?").get(input.turnId);
      expect(saved).toMatchObject({ status: "parked", dispatch_failure_class: "parked_ambiguous", owner_instance_id: null,
        accepted_input_id: input.inputId, replay_text: input.prompt, provider_turn_id: null, provider_input_acknowledged_at: null });
      expect(saved.stop_requested_at).not.toBeNull();
      expect(saved.agent_text).toContain("cancellation is not confirmed");
      expect(state.getSessionById(input.session.id).agent_session_uuid).toBe("prior-provider-branch");
      const successor = retainSessionInput({ sessionId: input.session.id, scope: "native-test", actionId: "after-uncertain-stop",
        kind: "input", origin: "human", payload: { text: "Wait behind the exact unresolved predecessor." } }).input;
      enqueueSessionInput(successor.id);
      expect(claimNextQueuedTurn("successor-owner")).toBeNull();
      expect(submissions).toBe(1);
      expect(db.query("SELECT count(*) AS count FROM session_owner_events WHERE kind='result'").get()).toEqual({ count: 0 });
      expect(db.query("SELECT count(*) AS count FROM turn_delivery_chunks").get()).toEqual({ count: 0 });
    } finally {
      release();
      await execution;
      await new Promise(resolve => setImmediate(resolve));
    }
  });

  test.each([["cancelled", true], ["interrupted", true], ["error", true], ["cancelled", false]] as const)("preserves unacknowledged input after %s, prepared=%s, once receipt is proven", async (status, prepared) => {
    upsertChannel({ slack_channel_id: "CGAP", slack_channel_name: "gap", group_name: null, name: "Gap", vault_path: projectDir, code_path: projectDir });
    const session = createOrGetSession("CGAP", "100.1", "codex");
    const original = "Original typed request before attachment preparation\nKeep this exact text.";
    const first = acquireSessionTurn(session.id, "100.1", original, "old-owner");
    const transcript = "Exact saved audio\n\n  Keep spacing 🗣️ and this action: send the report.  ";
    if (prepared) state.setTurnReplayInput(first.id, transcript, 0);
    state.markTurnProviderAdmissionIntended(first.id, "old-owner", 1);
    db.query("UPDATE turns SET status=?, owner_instance_id=NULL WHERE id=?").run(status, first.id);
    db.query("UPDATE sessions SET status='idle' WHERE id=?").run(session.id);
    const prompts: string[] = [];
    for (const messageTs of ["101.1", "102.1", "103.1"]) {
      const turn = acquireSessionTurn(session.id, messageTs, "resume", "new-owner", undefined, "100.1", { userId: "U1", projectionMode: "agent" });
      const steering = new TurnSteeringController();
      const outcome = await executeAgentTurn({
        turnId: turn.id, session, channel: getChannel("CGAP"), channelId: "CGAP", threadTs: "100.1",
        userMsgTs: messageTs, user: "U1", text: "resume", prompt: "resume", files: [], client: {},
        provider: { id: "codex", async run(input) {
          prompts.push(input.prompt);
          if (messageTs !== "101.1") input.onInputAcknowledged?.();
          throw new ProviderTurnCancelledError();
        }, async fork() { throw new Error("unused"); } },
        providerId: "codex", providerLabel: "Codex", sessionThreadTs: "100.1", sessionMode: "per-thread",
        hydrateSlackLinks: false, cwd: projectDir, additionalDirs: [], botToken: "test", ownerInstanceId: "new-owner",
        projectionMode: "agent", recipientTeamId: "T1", steeringController: steering, closeSteering: () => steering.close(),
        services: {
          hydrateLegacyThreadOwnership: async () => 0, deliverOutcome: async () => { throw new Error("must not deliver a stopped turn"); },
          projectTurnStatus: async () => "delivered", projectThreadSummary: async () => "delivered",
          startAgentProgress: async () => messageTs, appendAgentProgress: async () => {}, stopAgentProgress: async () => {},
          projectRootSummary: async () => "delivered",
        },
      });
      expect(outcome.status).toBe("cancelled");
    }
    for (const prompt of prompts.slice(0, 2)) {
      expect(prompt).toContain(JSON.stringify(prepared ? transcript : original));
      expect(prompt).toContain("execution is unknown");
      expect(prompt).toContain("do not repeat its actions automatically");
      expect(prompt).toEndWith("resume");
    }
    expect(prompts[2]).not.toContain("preserved conversation history");
    expect(prompts[2]).not.toContain("Exact saved audio");
    expect(state.getTurnReplayInput(first.id)).toBe(prepared ? transcript : null);
  });

  test("Stop during audio preparation saves the transcript without submitting, then supplies it on an explicit resume", async () => {
    upsertChannel({ slack_channel_id: "CAUDIOSTOP", slack_channel_name: "audio-stop", group_name: null, name: "Audio", vault_path: projectDir, code_path: projectDir });
    const session = createOrGetSession("CAUDIOSTOP", "110.1", "codex");
    const first = acquireSessionTurn(session.id, "110.1", "", "owner", undefined, "110.1", { userId: "U1", projectionMode: "agent" });
    let releaseDownload!: () => void;
    let downloading!: () => void;
    const started = new Promise<void>(resolve => { downloading = resolve; });
    const gate = new Promise<void>(resolve => { releaseDownload = resolve; });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { downloading(); await gate; return new Response("audio bytes"); }) as typeof fetch;
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    let calls = 0;
    const run = (turn: { id: number }, text: string, files: any[]) => registry.run({ turnId: turn.id, channelId: "CAUDIOSTOP", threadTs: "110.1" }, (steering, closeSteering, cancellation) => executeAgentTurn({
      turnId: turn.id, session, channel: getChannel("CAUDIOSTOP"), channelId: "CAUDIOSTOP", threadTs: "110.1",
      userMsgTs: text ? "111.1" : "110.1", user: "U1", text, prompt: text, files, client: {},
      provider: { id: "codex", async run(input) {
        calls++;
        expect(input.prompt).toContain("Preserve the exact dictated request.");
        expect(input.prompt).toContain('"admission_intended":0');
        expect(input.prompt).toEndWith("resume");
        input.onInputAcknowledged?.();
        throw new ProviderTurnCancelledError();
      }, async fork() { throw new Error("unused"); } },
      providerId: "codex", providerLabel: "Codex", sessionThreadTs: "110.1", sessionMode: "per-thread",
      hydrateSlackLinks: false, cwd: projectDir, additionalDirs: [], botToken: "test", ownerInstanceId: "owner",
      projectionMode: "agent", recipientTeamId: "T1", steeringController: steering, cancellationController: cancellation, closeSteering,
      services: {
        hydrateLegacyThreadOwnership: async () => 0, deliverOutcome: async () => { throw new Error("must not execute after Stop"); },
        projectTurnStatus: async () => "delivered", projectThreadSummary: async () => "delivered",
        startAgentProgress: async ({ turnId }) => {
          beginTurnProgressStream(turnId);
          recordTurnProgressStreamStarted(turnId, "110.2");
          return "110.2";
        }, appendAgentProgress: async () => {}, stopAgentProgress: async () => {},
        projectRootSummary: async () => "delivered",
      },
    }));
    try {
      const execution = run(first, "", [{ id: "FAUDIO", name: "voice.m4a", mimetype: "audio/mp4", url_private: "https://files.slack.test/audio", transcription: { text: "Preserve the exact dictated request." } }]);
      await started;
      const stop = handleAgentSessionStop({ event: { channel: "CAUDIOSTOP", thread_ts: "110.1", event_ts: "110.3" }, teamId: "T1", expectedTeamId: "T1", registry });
      releaseDownload();
      expect(await stop).toBe("cancelled");
      expect((await execution).status).toBe("cancelled");
      expect(calls).toBe(0);
      const saved = state.getTurnReplayInput(first.id);
      expect(saved).toContain("Preserve the exact dictated request.");
      const second = acquireSessionTurn(session.id, "111.1", "resume", "owner", undefined, "110.1", { userId: "U1", projectionMode: "agent" });
      await run(second, "resume", []);
      expect(calls).toBe(1);
      expect(state.getTurnReplayInput(first.id)).toBe(saved);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("preferred Claude model is owned, write-once per turn, and bounded by the current turn", () => {
    upsertChannel({ slack_channel_id: "CMODEL", slack_channel_name: "model", group_name: null, name: "Model", vault_path: projectDir, code_path: projectDir });
    const session = createOrGetSession("CMODEL", "1.000001", "claude-code");
    const turn = acquireSessionTurn(session.id, "1.000001", "first", "owner");
    expect(state.getClaudePreferredModel(session.id, turn.id)).toBeUndefined();
    expect(() => state.recordTurnPreferredModel(turn.id, "other-owner", "claude-opus-5")).toThrow("ownership");
    state.recordTurnPreferredModel(turn.id, "owner", "claude-fable-5-1");
    state.recordTurnPreferredModel(turn.id, "owner", "claude-opus-5");
    expect(state.getClaudePreferredModel(session.id, turn.id)).toBe("claude-fable-5-1");
    expect(state.getClaudePreferredModel(session.id, turn.id - 1)).toBeUndefined();
    db.query("UPDATE turns SET status='done' WHERE id=?").run(turn.id);
    expect(() => state.recordTurnPreferredModel(turn.id, "owner", "claude-sonnet-5")).toThrow("ownership");
    expect(state.getClaudePreferredModel(session.id, turn.id + 1)).toBe("claude-fable-5-1");
  });
  test.each([
    ["codex", false], ["codex", true], ["claude-code", false], ["claude-code", true],
  ] as const)("uses one Agent progress stream, a separate final reply, and a terminal root summary (%s, resuming=%s)", async (providerId, resuming) => {
    upsertChannel({
      slack_channel_id: "CAGENT",
      slack_channel_name: "agent",
      group_name: null,
      name: "Agent",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "850.000001";
    const session = createOrGetSession("CAGENT", rootThreadTs, providerId);
    const acquired = acquireSessionTurn(
      session.id,
      rootThreadTs,
      "Build the Agent experience",
      "runtime-agent",
      undefined,
      rootThreadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    if (resuming) {
      beginTurnProgressStream(acquired.id);
      recordTurnProgressStreamStarted(acquired.id, "progress-1", "activity-before-retry");
    }
    const startedChunks: any[][] = [];
    const expectedModel = resuming ? undefined : providerId === "codex" ? "gpt-6-astra" : "claude-fable-5";
    const stoppedChunks: any[][] = [];
    const rootSummaries: string[] = [];
    let finalDeliveries = 0;
    let legacyStatusCalls = 0;
    let reactionCalls = 0;
    const agentSessionStatuses: Array<{ status: string; initialTitle?: string }> = [];
    const startupEffects: string[] = [];
    const client = {
      reactions: { add: async () => { reactionCalls += 1; return { ok: true }; } },
    };
    const provider: AgentProvider = {
      id: providerId,
      async run(input) {
        startupEffects.push("provider.run");
        input.onProgress?.({ type: "started" });
        if (!resuming) input.onProgress?.({ type: "commentary", text: "Mapped the current lifecycle." });
        input.onProgress?.({
          type: "activity",
          itemId: "item-1",
          title: "Editing turn lifecycle",
          status: "in_progress",
        });
        input.onProgress?.({
          type: "plan",
          planTitle: "Implementation",
          title: "Step 2/3 · Add focused tests",
          status: "in_progress",
        });
        if (providerId === "claude-code") {
          return runClaudeCodeTurn({
            ...input,
            transport: {
              async run(transportInput) {
                transportInput.onStdout(`${JSON.stringify({ type: "system", subtype: "init", model: expectedModel })}\n`);
                transportInput.onProtocolActivityReady?.(() => {});
                transportInput.onStdinReady?.(async () => {}, () => {});
                transportInput.onStdout(`${JSON.stringify({
                  type: "user", isReplay: true,
                  message: { content: [{ type: "text", text: input.prompt }] },
                })}\n`);
                transportInput.onStdout(`${JSON.stringify({
                  type: "result", subtype: "success", is_error: false,
                  session_id: "c0f2ec4e-5099-4dd2-9960-03b102478f80",
                  result: "TL;DR: Agent streaming is implemented.\n\nFull result.",
                  duration_ms: 1_122_000, duration_api_ms: 12,
                })}\n`);
                return { code: 0, signal: null };
              },
            },
          });
        }
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Agent streaming is implemented.\n\nFull result.",
          sessionUUID: "provider-agent",
          providerTurnId: "provider-turn-agent",
          model: expectedModel,
          durationMs: 1_122_000,
          toolsUsed: ["edit"],
        };
      },
      async fork() { throw new Error("not used"); },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId, text }) => {
        expect(text).toEndWith(`_model: ${expectedModel || "unknown"} - cwd: ${projectDir}_`);
        expect(text).not.toContain("_provider:");
        expect(db.query("SELECT outbound_text FROM turns WHERE id=?").get(turnId)).toEqual({ outbound_text: text });
        finalDeliveries += 1;
        markDeliveryChunkDelivered(turnId, 0, "final-1");
        return "delivered";
      },
      projectTurnStatus: async () => {
        legacyStatusCalls += 1;
        return "delivered";
      },
      projectThreadSummary: async () => {
        legacyStatusCalls += 1;
        return "delivered";
      },
      startAgentProgress: async ({ chunks }) => {
        startedChunks.push(chunks);
        startupEffects.push("progress.persisted");
        return "progress-1";
      },
      appendAgentProgress: async () => {},
      stopAgentProgress: async ({ chunks, turnId }) => {
        expect(db.query("SELECT provider_duration_ms FROM turns WHERE id=?").get(turnId))
          .toMatchObject({ provider_duration_ms: 1_122_000 });
        expect(finalDeliveries).toBe(0);
        stoppedChunks.push(chunks);
      },
      setAgentSessionStatus: async ({ status, initialTitle }) => {
        agentSessionStatuses.push({ status, initialTitle });
        startupEffects.push(`session.${status}`);
      },
      projectRootSummary: async ({ text }) => {
        rootSummaries.push(text);
        return "delivered";
      },
    };
    const controller = new TurnSteeringController();
    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("CAGENT"),
      channelId: "CAGENT",
      threadTs: rootThreadTs,
      userMsgTs: rootThreadTs,
      user: "U1",
      text: "Build the Agent experience",
      prompt: "Build the Agent experience",
      files: [],
      client,
      provider,
      providerId,
      providerLabel: providerId === "codex" ? "Codex" : "Claude Code",
      model: "requested-alias-is-not-actual-model",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-agent",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
      statusIntervalMs: 1,
    });

    expect(outcome).toEqual({ status: "delivered", turnId: acquired.id });
    expect(startedChunks).toHaveLength(resuming ? 0 : 1);
    expect(stoppedChunks).toHaveLength(1);
    if (!resuming) expect(stoppedChunks[0]).toContainEqual(expect.objectContaining({ type: "markdown_text", text: "Mapped the current lifecycle." }));
    expect(stoppedChunks[0]).toContainEqual(expect.objectContaining({
      type: "task_update",
      title: "Work complete · 18m 42s",
      status: "complete",
      ...(resuming ? { id: "activity-before-retry" } : {}),
    }));
    expect(agentSessionStatuses).toEqual([
      { status: "active", initialTitle: "Build the Agent experience" },
      { status: "processing", initialTitle: "Build the Agent experience" },
      { status: "active", initialTitle: "Build the Agent experience" },
    ]);
    expect(startupEffects).toEqual([
      "session.active",
      ...(resuming ? [] : ["progress.persisted"]),
      "session.processing",
      "provider.run",
      "session.active",
    ]);
    expect(finalDeliveries).toBe(1);
    expect(rootSummaries).toEqual([
      [
        "Build the Agent experience",
        "",
        "━━━━━━━━━━━━━━━━━━━━",
        "*Concierge TL;DR*",
        "Agent streaming is implemented.",
      ].join("\n"),
    ]);
    expect(legacyStatusCalls).toBe(0);
    expect(reactionCalls).toBe(0);
  });

  test("reports a parked root-summary error before terminally clearing Agent work", async () => {
    const channelId = "CROOTFAIL";
    const threadTs = "855.000001";
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "root-failure",
      group_name: null,
      name: "Root failure",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const session = createOrGetSession(channelId, threadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      threadTs,
      "Summarize the thread",
      "runtime-root-failure",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    const effects: string[] = [];
    const notices: string[] = [];
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Final response delivered.\n\nDetails.",
          sessionUUID: "provider-root-failure",
          providerTurnId: "provider-turn-root-failure",
          durationMs: 1_000,
          toolsUsed: [],
        };
      },
      async fork() { throw new Error("not used"); },
    };
    const controller = new TurnSteeringController();
    let activeStatusCalls = 0;

    const outcome = await executeAgentTurn({
      turnId: turn.id,
      session,
      channel: getChannel(channelId),
      channelId,
      threadTs,
      userMsgTs: threadTs,
      user: "U1",
      text: "Summarize the thread",
      prompt: "Summarize the thread",
      files: [],
      client: {},
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-root-failure",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services: {
        hydrateLegacyThreadOwnership: async () => 0,
        deliverOutcome: async ({ turnId }) => {
          effects.push("deliver");
          markDeliveryChunkDelivered(turnId, 0, "final-root-failure");
          return "delivered";
        },
        projectTurnStatus: async ({ text }) => {
          effects.push("notice");
          notices.push(text);
          return "delivered";
        },
        projectThreadSummary: async () => { throw new Error("legacy summary is not used"); },
        startAgentProgress: async () => {
          effects.push("progress-start");
          return "progress-root-failure";
        },
        appendAgentProgress: async () => {},
        stopAgentProgress: async () => { effects.push("progress-stop"); },
        setAgentSessionStatus: async ({ status }) => {
          effects.push(`status:${status}`);
          if (status === "active" && ++activeStatusCalls === 2) {
            throw new Error("Agent session status active projection permanent failure.");
          }
        },
        projectRootSummary: async ({ channel, threadTs, turnId, text }) => {
          effects.push("root-summary");
          requestSlackRootSummaryProjection({ channel, threadTs, turnId, text });
          const claimed = claimSlackRootSummaryProjection(channel, threadTs, Date.now())!;
          parkSlackRootSummaryProjection(
            channel,
            threadTs,
            claimed.desired_revision,
            "Error: An API error occurred: msg_too_long",
          );
          return "permanent_failure";
        },
      },
    });

    expect(outcome).toEqual({ status: "delivered", turnId: turn.id });
    expect(effects).toEqual([
      "status:active",
      "progress-start",
      "status:processing",
      "progress-stop",
      "deliver",
      "root-summary",
      "status:active",
      "notice",
    ]);
    expect(notices).toEqual([expect.stringContaining(":warning: *Concierge sync error — Slack display out of date*")]);
    expect(notices[0]).toContain("msg_too_long");
    expect(notices[0]).toContain("The agent is no longer working.");
    expect(notices[0]).toContain("could not update this thread's root TL;DR or clear Slack's working indicator");
    expect(notices[0]).toContain("active projection permanent failure");
  });

  test("relinquishes a completed Agent turn when drain stops the root summary before terminal active", async () => {
    const channelId = "CROOTSTOP";
    const threadTs = "857.000001";
    upsertChannel({
      slack_channel_id: channelId,
      slack_channel_name: "root-stop",
      group_name: null,
      name: "Root stop",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const session = createOrGetSession(channelId, threadTs, "codex");
    const turn = acquireSessionTurn(
      session.id,
      threadTs,
      "Summarize before clearing",
      "runtime-root-stop",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    const statuses: string[] = [];
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Final response delivered.",
          sessionUUID: "provider-root-stop",
          providerTurnId: "provider-turn-root-stop",
          durationMs: 1_000,
          toolsUsed: [],
        };
      },
      async fork() { throw new Error("not used"); },
    };
    const steering = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: turn.id,
      session,
      channel: getChannel(channelId),
      channelId,
      threadTs,
      userMsgTs: threadTs,
      user: "U1",
      text: "Summarize before clearing",
      prompt: "Summarize before clearing",
      files: [],
      client: {},
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-root-stop",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: steering,
      closeSteering: (reason) => steering.close(reason),
      services: {
        hydrateLegacyThreadOwnership: async () => 0,
        deliverOutcome: async ({ turnId }) => {
          markDeliveryChunkDelivered(turnId, 0, "final-root-stop");
          return "delivered";
        },
        projectTurnStatus: async () => "delivered",
        projectThreadSummary: async () => "delivered",
        startAgentProgress: async () => "progress-root-stop",
        appendAgentProgress: async () => {},
        stopAgentProgress: async () => {},
        setAgentSessionStatus: async ({ status }) => { statuses.push(status); },
        projectRootSummary: async () => "stopped",
      },
    });

    expect(outcome).toEqual({ status: "delivery_stopped", turnId: turn.id });
    expect(statuses).toEqual(["active", "processing"]);
    expect(db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(turn.id))
      .toEqual({ status: "delivering", owner_instance_id: null });
    expect(getSession(channelId, threadTs, "codex").status).toBe("running");
  });

  test("native Stop without streams cancels the provider, finalizes the same progress message, and releases its turn", async () => {
    upsertChannel({
      slack_channel_id: "CSTOP",
      slack_channel_name: "stop",
      group_name: null,
      name: "Stop",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "860.000001";
    const session = createOrGetSession("CSTOP", threadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      threadTs,
      "Long request",
      "runtime-stop",
      undefined,
      threadTs,
      { userId: "U1", projectionMode: "agent" },
    );
    let cancellationReady!: () => void;
    const ready = new Promise<void>((resolve) => { cancellationReady = resolve; });
    const provider: AgentProvider = {
      id: "codex",
      run: (input) => new Promise((_resolve, reject) => {
        input.onCancellationReady?.(async () => {
          reject(new ProviderTurnCancelledError());
        });
        cancellationReady();
      }),
      async fork() { throw new Error("not used"); },
    };
    const stoppedChunks: any[][] = [];
    const slackWrites: any[] = [];
    const client = { apiCall: async (method: string, args: any) => {
      slackWrites.push({ method, args });
      return { ok: true, ts: args.ts ?? "860.000010" };
    } };
    let finalDeliveries = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => { finalDeliveries += 1; return "delivered"; },
      projectTurnStatus: async () => "delivered",
      projectThreadSummary: async () => "delivered",
      startAgentProgress: async ({ chunks, turnId }) => {
        beginTurnProgressStream(turnId);
        queueAgentProgressMessages(turnId, chunks);
        await projectAgentProgressMessages(client, turnId);
        return "860.000010";
      },
      appendAgentProgress: async ({ chunks, turnId }) => {
        queueAgentProgressMessages(turnId, chunks);
        await projectAgentProgressMessages(client, turnId);
      },
      stopAgentProgress: async ({ chunks, turnId }) => {
        stoppedChunks.push(chunks);
        queueAgentProgressMessages(turnId, chunks, true);
        await projectAgentProgressMessages(client, turnId);
      },
      projectRootSummary: async () => "delivered",
    };
    const registry = new ActiveTurnDispatchRegistry({ onStarted() {}, onSettled() {} });
    const execution = registry.run({ turnId: acquired.id, channelId: "CSTOP", threadTs }, (steering, closeSteering, cancellation) => executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("CSTOP"),
      channelId: "CSTOP",
      threadTs,
      userMsgTs: threadTs,
      user: "U1",
      text: "Long request",
      prompt: "Long request",
      files: [],
      client: {},
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-stop",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: steering,
      cancellationController: cancellation,
      closeSteering,
      services,
    }));
    await ready;
    expect(await handleAgentSessionStop({ event: { channel: "CSTOP", thread_ts: threadTs, event_ts: "860.000020", streaming_message_ts: [] }, teamId: "T1", expectedTeamId: "T1", registry })).toBe("cancelled");
    expect(await execution).toEqual({ status: "cancelled", turnId: acquired.id });
    expect(stoppedChunks.flat()).toContainEqual(expect.objectContaining({
      type: "task_update",
      title: "Stopped",
      status: "complete",
    }));
    expect(finalDeliveries).toBe(0);
    expect(slackWrites.map((write) => write.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(slackWrites[1].args.ts).toBe("860.000010");
    expect(slackWrites[1].args.blocks).toContainEqual(expect.objectContaining({ type: "task_card", title: "Stopped", status: "complete" }));
    expect(getSession("CSTOP", threadTs, "codex").status).toBe("idle");
  });

  test("suspends the Agent session and tags the requester only for a terminal failure", async () => {
    upsertChannel({
      slack_channel_id: "CAGENTFAILURE",
      slack_channel_name: "agent-failure",
      group_name: null,
      name: "Agent failure",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "870.000001";
    const session = createOrGetSession("CAGENTFAILURE", threadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      threadTs,
      "Fail after admission",
      "runtime-agent-failure",
      undefined,
      threadTs,
      { userId: "U-requester", projectionMode: "agent" },
    );
    const sessionStatuses: string[] = [];
    const projectedStatuses: string[] = [];
    let reactionCalls = 0;
    let finalDeliveries = 0;
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "activity", itemId: "item-failure", title: "Running provider", status: "in_progress" });
        throw new Error("provider terminated unexpectedly");
      },
      async fork() { throw new Error("not used"); },
    };
    const steering = new TurnSteeringController();
    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("CAGENTFAILURE"),
      channelId: "CAGENTFAILURE",
      threadTs,
      userMsgTs: threadTs,
      user: "U-requester",
      text: "Fail after admission",
      prompt: "Fail after admission",
      files: [],
      client: { reactions: { add: async () => { reactionCalls += 1; return { ok: true }; } } },
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: threadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-agent-failure",
      projectionMode: "agent",
      recipientTeamId: "T1",
      steeringController: steering,
      closeSteering: (reason) => steering.close(reason),
      services: {
        hydrateLegacyThreadOwnership: async () => 0,
        deliverOutcome: async () => { finalDeliveries += 1; return "delivered"; },
        projectTurnStatus: async ({ text }) => { projectedStatuses.push(text); return "delivered"; },
        projectThreadSummary: async () => "delivered",
        startAgentProgress: async () => "progress-failure",
        appendAgentProgress: async () => {},
        stopAgentProgress: async () => {},
        setAgentSessionStatus: async ({ status }) => {
          sessionStatuses.push(status);
          if (status === "suspended") throw new Error("terminal suspended projection failed");
        },
        projectRootSummary: async () => "delivered",
      },
    });

    expect(outcome.status).toBe("error");
    expect(sessionStatuses).toEqual(["active", "processing", "suspended"]);
    expect(projectedStatuses).toHaveLength(1);
    expect(projectedStatuses[0]).toStartWith("<@U-requester>");
    expect(projectedStatuses[0]).toContain("Agent-session status projection: `terminal suspended projection failed`");
    expect(finalDeliveries).toBe(0);
    expect(reactionCalls).toBe(0);
  });

  test("delivers the provider turn without reading the channel AGENTS.md", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    mkdirSync(join(projectDir, "AGENTS.md"));
    const rootThreadTs = "900.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "900.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let providerCalled = false;
    let closeSteeringCalls = 0;
    const providerSessionBindings: string[] = [];
    const statusTexts: string[] = [];
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true, ts: "status-error" };
        },
        update: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        providerCalled = true;
        input.onProgress?.({ type: "started" });
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Provider work completed.\n\nResponse body.",
          sessionUUID: "provider-session",
          providerTurnId: "provider-turn",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-1");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: ({ channel, threadTs, turnId, text }) => projectThreadSummary(
        channel,
        threadTs,
        turnId,
        text,
      ),
      providerSessionBound: async (providerThreadUuid) => {
        providerSessionBindings.push(providerThreadUuid);
      },
    };
    const controller = new TurnSteeringController();
    const outcome = await executeAgentTurn({
        turnId: acquired.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs: "900.000010",
        user: "U1",
        text: "request",
        prompt: "request",
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => {
          closeSteeringCalls += 1;
          controller.close(reason);
        },
        services,
    });

    expect(outcome!.status).toBe("delivered");
    expect(providerCalled).toBeTrue();
    expect(providerSessionBindings).toEqual(["provider-session"]);
    expect(closeSteeringCalls).toBeGreaterThan(0);
    expect(statusTexts.some((text) => text.includes("Status: done"))).toBeTrue();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({ status: "done" });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("explicitly parks terminal status state when its projection throws", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    mkdirSync(join(projectDir, "AGENTS.md"));
    const rootThreadTs = "925.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "925.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-projection-error" }),
        update: async () => ({ ok: true }),
      },
    };
    let projectionCallCount = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "delivered",
      projectTurnStatus: ({ turnId, text }) => {
        projectionCallCount += 1;
        if (projectionCallCount > 1) throw new Error("status worker crashed");
        return projectTurnStatus(client, turnId, text);
      },
      projectThreadSummary: async () => "delivered",
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        const stagingDirectory = getTurnArtifactBatch(acquired.id).directory_path;
        writeFileSync(join(stagingDirectory, "failed-turn.txt"), "temporary");
        throw new Error("provider failed");
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "925.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("error");
    expect(outcome).toMatchObject({ error: "Error: provider failed" });
    expect(db.query(`
      SELECT status, status_projection_status, status_desired_text, status_projection_error
      FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "error",
      status_projection_status: "parked",
    });
    expect(String((db.query("SELECT status_desired_text FROM turns WHERE id=?")
      .get(acquired.id) as any).status_desired_text)).toContain("Status: error");
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("error");
    expect(getTurnArtifactBatch(acquired.id)).toMatchObject({ status: "abandoned" });
    expect(existsSync(getTurnArtifactBatch(acquired.id).directory_path)).toBeFalse();
  });

  test("cleans downloaded attachments when provider preparation fails", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "940.000001";
    const userMsgTs = "940.000010";
    const createAttachmentRoot = spyOn(attachments, "createTurnAttachmentRoot");
    let attachmentDir = "";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      userMsgTs,
      "transcribe this",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let providerCalled = false;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-attachment-error" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run() {
        providerCalled = true;
        throw new Error("provider must not run");
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "delivered",
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();
    const originalFetch = globalThis.fetch;
    let outcome: Awaited<ReturnType<typeof executeAgentTurn>> | undefined;
    try {
      globalThis.fetch = (async () => new Response("not audio")) as typeof fetch;
      outcome = await executeAgentTurn({
        turnId: acquired.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs,
        user: "U1",
        text: "transcribe this",
        prompt: "transcribe this",
        files: [{
          name: "clip.wav",
          mimetype: "audio/wav",
          url_private_download: "https://files.slack.test/clip.wav",
        }],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
      });
    } finally {
      globalThis.fetch = originalFetch;
      attachmentDir = await createAttachmentRoot.mock.results[0]!.value;
      createAttachmentRoot.mockRestore();
    }

    expect(outcome?.status).toBe("error");
    expect(providerCalled).toBeFalse();
    expect(existsSync(attachmentDir)).toBeFalse();
  });

  test("relinquishes recoverable delivery when execution fails after delivery begins", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "950.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "950.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const statusTexts: string[] = [];
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true, ts: "status-delivery-error" };
        },
        update: async (args: any) => {
          statusTexts.push(args.text);
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Prepared the response.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => {
        throw new Error("delivery failed after durable delivery intent");
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "950.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_stopped");
    expect(db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({
      status: "delivering",
      delivery_status: "pending",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("running");
    expect(listRecoverableTurns().map((turn: any) => turn.id)).toContain(acquired.id);
    expect(statusTexts.some((text) => text.includes("Status: error"))).toBeTrue();
  });

  test("keeps the hourglass while response delivery remains recoverable", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "960.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "960.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    let removedReactions = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => {
          removedReactions += 1;
          return { ok: true };
        },
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-delivery-stopped" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Delivery is pending.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "stopped",
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "960.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_stopped");
    expect(removedReactions).toBe(0);
    expect(db.query("SELECT turn_id FROM turn_reaction_cleanups WHERE turn_id=?")
      .get(acquired.id)).toBeNull();
    expect(db.query("SELECT status, delivery_status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({
      status: "delivering",
      delivery_status: "pending",
    });
  });

  test("parks explicit permanent delivery failure before terminal projection can stop", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "970.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "970.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-permanent-delivery" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Slack rejected delivery.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let statusProjectionCalls = 0;
    let statusObservedByTerminalProjection: string | null = null;
    let durableTerminalProjection: any = null;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "permanent_failure",
      projectTurnStatus: async ({ turnId, text }) => {
        statusProjectionCalls += 1;
        if (statusProjectionCalls === 1) return projectTurnStatus(client, turnId, text);
        statusObservedByTerminalProjection = (db.query("SELECT status FROM turns WHERE id=?")
          .get(turnId) as { status: string }).status;
        durableTerminalProjection = getTurnStatusProjection(turnId);
        return "stopped";
      },
      projectThreadSummary: async () => "delivered",
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "970.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivery_parked");
    expect(statusObservedByTerminalProjection).toBe("delivery_parked");
    expect(durableTerminalProjection).toMatchObject({
      projection_status: "pending",
      desired_revision: 2,
    });
    expect(durableTerminalProjection.desired_text).toContain(
      "Status: error - response delivery was permanently parked",
    );
    expect(db.query(`
      SELECT status, delivery_status, owner_instance_id FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "delivery_parked",
      delivery_status: "parked",
      owner_instance_id: null,
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
  });

  test("keeps a delivered response complete when terminal projections throw", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "975.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const acquired = acquireSessionTurn(
      session.id,
      "975.000010",
      "request",
      "runtime-1",
      undefined,
      rootThreadTs,
    );
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-projection-failure" }),
        update: async () => ({ ok: true }),
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        return {
          text: "TL;DR: Delivered safely.\n\nResponse body.",
          sessionUUID: "provider-session",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let turnProjectionCalls = 0;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-delivered");
        return "delivered";
      },
      projectTurnStatus: async ({ turnId, text }) => {
        turnProjectionCalls += 1;
        if (turnProjectionCalls > 1) throw new Error("terminal turn projection crashed");
        return projectTurnStatus(client, turnId, text);
      },
      projectThreadSummary: async () => {
        throw new Error("cumulative summary projection crashed");
      },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: acquired.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "975.000010",
      user: "U1",
      text: "request",
      prompt: "request",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-1",
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
    });

    expect(outcome.status).toBe("delivered");
    expect(db.query(`
      SELECT status, delivery_status, status_projection_status FROM turns WHERE id=?
    `).get(acquired.id)).toMatchObject({
      status: "done",
      delivery_status: "delivered",
      status_projection_status: "parked",
    });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
    expect(getSlackThreadStatus("C1", rootThreadTs)).toMatchObject({
      projection_status: "parked",
      summary_through_turn_id: acquired.id,
    });
  });

  test.each(["codex", "claude-code"] as const)("gives steered follow-ups their own attachments and heartbeat while retaining one cumulative thread summary (%s)", async (providerId) => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: null,
    });
    const rootThreadTs = "1000.000001";
    const session = createOrGetSession("C1", rootThreadTs, providerId);
    const slackEvents: Array<{ kind: string; ts?: string; text?: string; threadTs?: string }> = [];
    const providerSystemPrompts: Array<string | undefined> = [];
    const providerMessagePrompts: string[] = [];
    const attachmentRoots: string[] = [];
    const attachmentPaths: string[] = [];
    const acknowledgedGuidance: Promise<void>[] = [];
    const heartbeatResolvers: Array<() => void> = [];
    const heartbeatPromises = [0, 1].map((index) => new Promise<void>((resolve) => {
      heartbeatResolvers[index] = resolve;
    }));
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          const ts = `status-${++statusCount}`;
          slackEvents.push({ kind: "status-created", ts, text: args.text, threadTs: args.thread_ts });
          return { ok: true, ts };
        },
        update: async (args: any) => {
          slackEvents.push({ kind: "status-updated", ts: args.ts, text: args.text });
          if (String(args.text).includes("Status: working")) {
            heartbeatResolvers[Number(String(args.ts).split("-")[1]) - 1]?.();
          }
          return { ok: true };
        },
      },
    };
    let providerTurn = 0;
    const provider: AgentProvider = {
      id: providerId,
      async run(input) {
        const index = providerTurn++;
        const root = input.additionalDirs.at(-1)!;
        attachmentRoots.push(root);
        expect(existsSync(root)).toBeTrue();
        if (index > 0) expect(existsSync(attachmentRoots[index - 1]!)).toBeFalse();
        providerSystemPrompts.push(input.systemPrompt);
        expect(input.systemPrompt).toContain('"human" means an authenticated human user instruction');
        expect(input.systemPrompt).toContain('Apply the origin of each current message separately');
        providerMessagePrompts.push(input.prompt);
        input.onProgress?.({ type: "started" });
        input.onSteeringReady?.(async ({ text }) => {
          providerMessagePrompts.push(text);
          const path = text.match(/local_path: (.+)/)?.[1];
          expect(path).toStartWith(`${root}/`);
          expect(readFileSync(path!, "utf8")).toBe("screenshot bytes");
          attachmentPaths.push(path!);
          expect(text).toContain("Inspect each attached file");
          if (index === 0) expect(text).toContain("Also check the planning bar");
        });
        await acknowledgedGuidance[index];
        input.onProgress?.({ type: "tool_use", toolName: "exec" });
        await Promise.race([
          heartbeatPromises[index],
          new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not arrive")), 1_000)),
        ]);
        expect(existsSync(attachmentPaths.at(-1)!)).toBeTrue();
        input.onProviderTerminal?.();
        return {
          text: index === 0
            ? "TL;DR: Completed the first request.\n\nFirst response."
            : "TL;DR: Completed the first request and its follow-up.\n\nSecond response.",
          sessionUUID: "provider-session",
          toolsUsed: ["exec"],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        slackEvents.push({ kind: "response-delivered" });
        markDeliveryChunkDelivered(turnId, 0, `response-${turnId}`);
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async ({ channel, threadTs, turnId, text }) => {
        requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
        const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
        if (!claimed) return "permanent_failure";
        await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
        markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
        return "delivered";
      },
    };

    const runTurn = async (userMsgTs: string, text: string) => {
      const currentSession = getSession("C1", rootThreadTs, providerId);
      const acquired = acquireSessionTurn(
        currentSession.id,
        userMsgTs,
        text,
        "runtime-1",
        undefined,
        rootThreadTs,
      );
      expect(acquired.acquired).toBeTrue();
      const controller = new TurnSteeringController();
      const caption = acknowledgedGuidance.length === 0 ? "Also check the planning bar" : "";
      const steeringAcknowledgements = [1, 2, 3].map(offset => {
        const steeringTs = `${userMsgTs.slice(0, -1)}${offset}`;
        const message = state.createTurnSteeringMessage(acquired.id, steeringTs, caption, caption, undefined, rootThreadTs);
        return new Promise<void>((resolve, reject) => {
          controller.enqueue({
            clientMessageId: `slack:${steeringTs}`, text: caption,
            prepareText: async (attachmentRoot) => {
              const prepared = await prepareProviderInput({
                prompt: caption, text: caption, channel: "C1", messageTs: steeringTs, threadTs: rootThreadTs, user: "U1", client,
                files: [{ id: "F1", name: "screenshot.png", mimetype: "image/png", url_private: "https://files.slack.test/screenshot" }],
                botToken: "test-token", hydrateSlackLinks: false, attachmentRoot: attachmentRoot!,
              });
              state.updateTurnSteeringReplayText(message.row.id, prepared.replayText, prepared.unreplayableAttachmentCount);
              return prepared.prompt;
            },
            onSending: () => state.markTurnSteeringMessageSending(message.row.id),
            onSent: () => { state.markTurnSteeringMessageSent(message.row.id); resolve(); },
            onError: reject,
          });
        });
      });
      const acknowledged = Promise.all(steeringAcknowledgements).then(() => {});
      // A provider assertion may fail before it starts awaiting queued steering.
      void acknowledged.catch(() => {});
      acknowledgedGuidance.push(acknowledged);
      return executeAgentTurn({
        turnId: acquired.id,
        session: currentSession,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs: rootThreadTs,
        userMsgTs,
        user: "U1",
        text,
        prompt: text,
        files: [],
        client,
        provider,
        providerId,
        providerLabel: "Codex",
        sessionThreadTs: rootThreadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
        statusIntervalMs: 5,
      });
    };

    const originalFetch = globalThis.fetch;
    let firstTurnEventCount = 0;
    const rateBudget = spyOn(slackBucket, "take").mockResolvedValue(undefined);
    try {
      globalThis.fetch = (async () => new Response("screenshot bytes")) as typeof fetch;
      expect((await runTurn("1000.000010", "First request")).status).toBe("delivered");
      firstTurnEventCount = slackEvents.length;
      expect((await runTurn("1000.000020", "Follow-up request")).status).toBe("delivered");
    } finally {
      await Promise.allSettled(acknowledgedGuidance);
      globalThis.fetch = originalFetch;
      rateBudget.mockRestore();
    }
    expect(new Set(attachmentRoots).size).toBe(2);
    expect(attachmentRoots.every((root) => !existsSync(root))).toBeTrue();
    const history = state.listSessionUserPrompts(session.id);
    expect(history.map((entry: any) => entry.unreplayable_attachment_count)).toEqual([0, 1, 1, 1, 0, 1, 1, 1]);
    expect(history.every((entry: any) => entry.replay_ready === 1)).toBeTrue();
    const messageTimestamps = ["1000.000010", "1000.000011", "1000.000012", "1000.000013", "1000.000020", "1000.000021", "1000.000022", "1000.000023"];
    expect(providerMessagePrompts).toHaveLength(messageTimestamps.length);
    for (const [index, messageTs] of messageTimestamps.entries()) {
      const context = `<slack-message-context>\n${JSON.stringify({ channel_id: "C1", message_ts: messageTs, thread_ts: rootThreadTs })}\n</slack-message-context>`;
      expect(providerMessagePrompts[index]).toContain(context);
      expect(providerMessagePrompts[index].match(/<slack-message-context>/g)).toHaveLength(1);
      expect(history[index].user_text).toContain(context);
    }

    const creations = slackEvents.filter((event) => event.kind === "status-created");
    expect(creations.map((event) => event.ts)).toEqual(["status-1", "status-2"]);
    expect(creations.every((event) => event.threadTs === rootThreadTs)).toBeTrue();
    for (const statusTs of ["status-1", "status-2"]) {
      expect(slackEvents.some((event) =>
        event.kind === "status-updated" && event.ts === statusTs && event.text?.includes("Status: working")
      )).toBeTrue();
    }
    const secondTurnEvents = slackEvents.slice(firstTurnEventCount);
    expect(secondTurnEvents.some((event) =>
      event.kind === "status-updated" && event.ts === "status-1" && event.text?.includes("Status: working")
    )).toBeFalse();

    const threadStatus = getSlackThreadStatus("C1", rootThreadTs);
    expect(threadStatus.slack_status_msg_ts).toBe("status-1");
    expect(threadStatus.thread_tldr).toBe("Completed the first request and its follow-up.");
    expect(slackEvents.some((event) =>
      event.kind === "status-updated" &&
      event.ts === "status-1" &&
      event.text?.includes("Completed the first request and its follow-up.")
    )).toBeTrue();
    expect(slackEvents.some((event) =>
      event.kind === "status-updated" &&
      event.ts === "status-2" &&
      event.text?.includes("Completed the first request and its follow-up.")
    )).toBeTrue();
    const turnStatuses = db.query(`
      SELECT slack_bot_msg_ts, status_projection_status, status_desired_text
      FROM turns ORDER BY id
    `).all();
    expect(turnStatuses.map((row: any) => row.slack_bot_msg_ts)).toEqual(["status-1", "status-2"]);
    expect(turnStatuses.every((row: any) => row.status_projection_status === "delivered")).toBeTrue();
    expect(turnStatuses.every((row: any) => row.status_desired_text.includes("Status: done"))).toBeTrue();
    expect(providerSystemPrompts[0]).toContain(CONCIERGE_SESSION_RESPONSE_CONTRACT);
    expect(providerSystemPrompts[1]).toContain(CONCIERGE_SESSION_RESPONSE_CONTRACT);
    expect(providerSystemPrompts[0]).not.toContain("Prior delivered summaries for this visible Slack thread");
    expect(providerSystemPrompts[1]).toContain("Prior delivered summaries for this visible Slack thread");
    expect(providerSystemPrompts[1]).toContain("Completed the first request.");
    expect(providerSystemPrompts.every((prompt) => prompt?.includes("Slack artifact delivery for this turn:"))).toBeTrue();
    expect(providerSystemPrompts.every((prompt) => !prompt?.includes("Slack List context"))).toBeTrue();
  });

  test("awaits durable artifacts before settling and promoting a queued successor", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const threadTs = "1050.000001";
    const session = createOrGetSession("C1", threadTs, "codex");
    const first = acquireSessionTurn(
      session.id,
      "1050.000010",
      "produce an artifact",
      "runtime-1",
      undefined,
      threadTs,
    );
    const second = acquireSessionTurn(
      session.id,
      "1050.000020",
      "queued successor",
      "runtime-1",
      undefined,
      threadTs,
    );
    expect(first.acquired).toBeTrue();
    expect(second.queued).toBeTrue();

    let uploadStarted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => { uploadStarted = resolve; });
    let finishUpload!: () => void;
    const uploadMayFinish = new Promise<void>((resolve) => { finishUpload = resolve; });
    let successorStarted!: () => void;
    const successorStartedPromise = new Promise<void>((resolve) => { successorStarted = resolve; });
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: `status-${++statusCount}` }),
        update: async () => ({ ok: true }),
      },
      files: {
        uploadV2: async (args: any) => {
          for await (const _chunk of args.file) {}
          uploadStarted();
          await uploadMayFinish;
          return { ok: true, files: [{ id: "F_ARTIFACT" }] };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        const artifactDirectory = getTurnArtifactBatch(first.id).directory_path;
        writeFileSync(join(artifactDirectory, "result.txt"), "durable result");
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Produced the requested artifact.\n\nResponse body.",
          sessionUUID: "provider-session",
          providerTurnId: "provider-turn",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "response-first");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: ({ channel, threadTs, turnId, text }) => projectThreadSummary(
        channel,
        threadTs,
        turnId,
        text,
      ),
    };
    let firstSettled = false;
    let successorWasStarted = false;
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => claimNextQueuedTurn("runtime-1"),
      run: async () => {
        successorWasStarted = true;
        successorStarted();
      },
      shouldStop: () => false,
      onError: (_claim, error) => { throw error; },
    });
    const registry = new ActiveTurnDispatchRegistry({
      onStarted: () => {},
      onSettled: () => coordinator.wake(),
    });
    const firstExecution = registry.run(
      { turnId: first.id, channelId: "C1", threadTs },
      (steeringController, closeSteering) => executeAgentTurn({
        turnId: first.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs,
        userMsgTs: "1050.000010",
        user: "U1",
        text: "produce an artifact",
        prompt: "produce an artifact",
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: threadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController,
        closeSteering,
        services,
      }),
    ).then((outcome) => {
      firstSettled = true;
      return outcome;
    });

    await uploadStartedPromise;
    const arrivingDuringUpload = acquireSessionTurn(
      session.id,
      "1050.000030",
      "arrives during artifact upload",
      "runtime-1",
      undefined,
      threadTs,
    );
    expect(arrivingDuringUpload.queued).toBeTrue();
    coordinator.wake();
    await Promise.resolve();
    expect(firstSettled).toBeFalse();
    expect(successorWasStarted).toBeFalse();
    finishUpload();
    expect((await firstExecution).status).toBe("delivered");
    await successorStartedPromise;
    expect(successorWasStarted).toBeTrue();
  });

  test("routes two overlapping turns' artifacts symmetrically when they finish in opposite order", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const unrelatedThreadTs = "1100.000001";
    const producingThreadTs = "1200.000001";
    const unrelatedSession = createOrGetSession("C1", unrelatedThreadTs, "codex");
    const producingSession = createOrGetSession("C1", producingThreadTs, "codex");
    const unrelatedTurn = acquireSessionTurn(
      unrelatedSession.id,
      "1100.000010",
      "unrelated long turn",
      "runtime-1",
      undefined,
      unrelatedThreadTs,
    );
    const producingTurn = acquireSessionTurn(
      producingSession.id,
      "1200.000010",
      "produce manifest",
      "runtime-1",
      undefined,
      producingThreadTs,
    );
    expect(unrelatedTurn.acquired).toBeTrue();
    expect(producingTurn.acquired).toBeTrue();

    let releaseUnrelatedProvider: () => void = () => {};
    const unrelatedProviderReleased = new Promise<void>((resolve) => {
      releaseUnrelatedProvider = resolve;
    });
    let markUnrelatedProviderStarted: () => void = () => {};
    const unrelatedProviderStarted = new Promise<void>((resolve) => {
      markUnrelatedProviderStarted = resolve;
    });
    const uploads: Array<{ threadTs: string; filename: string }> = [];
    let statusCount = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: `status-${++statusCount}` }),
        update: async () => ({ ok: true }),
      },
      files: {
        uploadV2: async (args: any) => {
          for await (const _chunk of args.file) {}
          uploads.push({ threadTs: args.thread_ts, filename: args.filename });
          return { ok: true, files: [{ id: `file-${uploads.length}` }] };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
        if (input.prompt.endsWith("unrelated long turn")) {
          const unrelatedDirectory = getTurnArtifactBatch(unrelatedTurn.id).directory_path;
          expect(input.systemPrompt).toContain(JSON.stringify(unrelatedDirectory));
          writeFileSync(join(unrelatedDirectory, "unrelated.txt"), "unrelated");
          markUnrelatedProviderStarted();
          await unrelatedProviderReleased;
        } else {
          const producingDirectory = getTurnArtifactBatch(producingTurn.id).directory_path;
          expect(input.systemPrompt).toContain(JSON.stringify(producingDirectory));
          writeFileSync(join(producingDirectory, "slack-app-manifest.json"), "{}");
          writeFileSync(join(projectDir, ".artifacts", "legacy-shared-root.txt"), "must be ignored");
        }
        return {
          text: `TL;DR: Completed ${input.prompt}.\n\nResponse body.`,
          sessionUUID: `provider-${input.prompt}`,
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, `response-${turnId}`);
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const execute = (
      turn: typeof unrelatedTurn,
      session: typeof unrelatedSession,
      threadTs: string,
      userMsgTs: string,
      prompt: string,
    ) => {
      const controller = new TurnSteeringController();
      return executeAgentTurn({
        turnId: turn.id,
        session,
        channel: getChannel("C1"),
        channelId: "C1",
        threadTs,
        userMsgTs,
        user: "U1",
        text: prompt,
        prompt,
        files: [],
        client,
        provider,
        providerId: "codex",
        providerLabel: "Codex",
        sessionThreadTs: threadTs,
        sessionMode: "per-thread",
        hydrateSlackLinks: false,
        cwd: projectDir,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId: "runtime-1",
        steeringController: controller,
        closeSteering: (reason) => controller.close(reason),
        services,
      });
    };

    const unrelatedOutcome = execute(
      unrelatedTurn,
      unrelatedSession,
      unrelatedThreadTs,
      "1100.000010",
      "unrelated long turn",
    );
    await unrelatedProviderStarted;
    const producingOutcome = await execute(
      producingTurn,
      producingSession,
      producingThreadTs,
      "1200.000010",
      "produce manifest",
    );
    releaseUnrelatedProvider();

    expect(producingOutcome.status).toBe("delivered");
    expect((await unrelatedOutcome).status).toBe("delivered");
    expect(uploads).toEqual([
      { threadTs: producingThreadTs, filename: "slack-app-manifest.json" },
      { threadTs: unrelatedThreadTs, filename: "unrelated.txt" },
    ]);
  });

  test("runs a deployment wake as a reaction-free turn with native deployment context", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "1300.000001";
    upsertSession("C1", rootThreadTs, "codex", "provider-existing", { status: "running" });
    const session = getSession("C1", rootThreadTs, "codex");
    const priorTurn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_bot_msg_ts, slack_reply_thread_ts,
      user_text, agent_text, response_tldr, status, delivery_status
    ) VALUES (?, '1300.000010', 'status-prior', ?, 'implement wake',
      'TL;DR: Implemented the deployment wake.', 'Implemented the deployment wake.',
      'done', 'delivered') RETURNING id`).get(session.id, rootThreadTs) as { id: number };
    const interruptedInput = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, user_text, replay_text, status, turn_kind
    ) VALUES (?, '1300.000011', 'preserve this user request', 'preserve this user request',
      'cancelled', 'slack_user') RETURNING id`).get(session.id) as { id: number };
    db.query(`INSERT INTO slack_thread_statuses (
      slack_channel_id, slack_thread_ts, slack_status_msg_ts, anchor_turn_id,
      thread_tldr, summary_through_turn_id
    ) VALUES ('C1', ?, 'status-prior', ?, 'Implemented the deployment wake.', ?)`)
      .run(rootThreadTs, priorTurn.id, priorTurn.id);
    const turn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status,
      owner_instance_id, turn_kind, trigger_key
    ) VALUES (?, 'deployment:wake-1', ?, 'verify live deployment', 'running',
      'runtime-verifier', 'deployment_verification', 'wake-1') RETURNING id`)
      .get(session.id, rootThreadTs) as { id: number };
    let reactionCalls = 0;
    let cleanupCalls = 0;
    let admissionIntentCalls = 0;
    let providerInput: any = null;
    const statusUpdates: Array<{ ts: string; text: string }> = [];
    let releaseHeartbeat: () => void = () => {};
    const heartbeat = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
    const client = {
      reactions: {
        add: async () => { reactionCalls += 1; return { ok: true }; },
        remove: async () => { reactionCalls += 1; return { ok: true }; },
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: "status-deployment" }),
        update: async (args: any) => {
          statusUpdates.push({ ts: args.ts, text: args.text });
          if (args.ts === "status-deployment" && String(args.text).includes("Status: working")) {
            releaseHeartbeat();
          }
          return { ok: true };
        },
      },
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        providerInput = input;
        input.onInputAcknowledged?.();
        input.onProgress?.({ type: "started" });
        input.onProgress?.({ type: "tool_use", toolName: "exec" });
        await Promise.race([
          heartbeat,
          new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not arrive")), 1_000)),
        ]);
        return {
          text: "TL;DR: Implemented the deployment wake and verified it live.\n\nVerified against the running service.",
          sessionUUID: "provider-existing",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ turnId }) => {
        markDeliveryChunkDelivered(turnId, 0, "verification-response");
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async ({ channel, threadTs, turnId, text }) => {
        requestSlackThreadStatusProjection({ channel, threadTs, turnId, text });
        const claimed = claimSlackThreadStatusProjection(channel, threadTs, Date.now());
        if (!claimed) return "permanent_failure";
        await client.chat.update({ ts: claimed.slack_status_msg_ts, text: claimed.desired_text });
        markSlackThreadStatusProjectionDelivered(channel, threadTs, claimed.desired_revision);
        return "delivered";
      },
      scheduleWorkingReactionCleanup: async () => { cleanupCalls += 1; },
    };
    const controller = new TurnSteeringController();

    const outcome = await executeAgentTurn({
      turnId: turn.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: rootThreadTs,
      userMsgTs: "deployment:wake-1",
      user: "U1",
      text: "verify live deployment",
      prompt: "verify live deployment",
      files: [],
      client,
      provider,
      providerId: "codex",
      providerLabel: "Codex",
      sessionThreadTs: rootThreadTs,
      sessionMode: "per-thread",
      hydrateSlackLinks: false,
      cwd: projectDir,
      additionalDirs: [],
      botToken: "test-token",
      ownerInstanceId: "runtime-verifier",
      turnKind: "deployment_verification",
      providerEnvironment: {
        CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
        CONCIERGE_DEPLOYMENT_WAKE_ID: "wake-1",
      },
      beforeProviderAdmission: () => { admissionIntentCalls += 1; },
      steeringController: controller,
      closeSteering: (reason) => controller.close(reason),
      services,
      statusIntervalMs: 5,
    });

    expect(outcome.status).toBe("delivered");
    expect(reactionCalls).toBe(0);
    expect(cleanupCalls).toBe(0);
    expect(admissionIntentCalls).toBe(1);
    expect(providerInput.sessionUUID).toBe("provider-existing");
    expect(providerInput.prompt).not.toContain("<slack-message-context>");
    expect(providerInput.prompt).not.toContain("preserve this user request");
    expect(providerInput.prompt).not.toContain("preserved conversation history");
    expect(db.query("SELECT input_context_received_by_turn_id FROM turns WHERE id=?")
      .get(interruptedInput.id)).toMatchObject({ input_context_received_by_turn_id: null });
    expect(providerInput.environment).toMatchObject({
      CONCIERGE_TURN_ID: String(turn.id),
      CONCIERGE_SESSION_ID: String(session.id),
      CONCIERGE_TURN_KIND: "deployment_verification",
      CONCIERGE_OWNER_INSTANCE_ID: "runtime-verifier",
      CONCIERGE_SLACK_CHANNEL_ID: "C1",
      CONCIERGE_SLACK_THREAD_TS: rootThreadTs,
      CONCIERGE_COMMIT_PROVENANCE: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      ),
      CONCIERGE_DEPLOYMENT_RUN_ID: "run-1",
      CONCIERGE_DEPLOYMENT_WAKE_ID: "wake-1",
    });
    expect(db.query("SELECT status FROM turns WHERE id=?").get(turn.id)).toMatchObject({ status: "done" });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("idle");
    expect(getSlackThreadStatus("C1", rootThreadTs)).toMatchObject({
      slack_status_msg_ts: "status-prior",
      thread_tldr: "Implemented the deployment wake and verified it live.",
      summary_through_turn_id: turn.id,
    });
    expect(statusUpdates.some((update) =>
      update.ts === "status-deployment" && update.text.includes("Status: working")
    )).toBeTrue();
    expect(statusUpdates.some((update) =>
      update.ts === "status-prior" && update.text.includes("Status: working")
    )).toBeFalse();
  });
});
