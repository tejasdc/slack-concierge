import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SteeringNotSentError, steeringTargetKey, TurnSteeringController } from "../src/steering";

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("TurnSteeringController", () => {
  test("scopes live targets to the visible Slack thread", () => {
    expect(steeringTargetKey("C1", "thread-a")).not.toBe(steeringTargetKey("C1", "thread-b"));
    expect(steeringTargetKey("C1", "thread-a")).not.toBe(steeringTargetKey("C2", "thread-a"));
  });

  test("checks live steering before capture and channel admission", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const duplicateLookup = handler.indexOf("claimSlackUserInput(");
    const steeringLookup = handler.indexOf("activeTurnDispatch.dispatchSteering(");

    expect(duplicateLookup).toBeGreaterThan(0);
    expect(duplicateLookup).toBeLessThan(steeringLookup);
    expect(steeringLookup).toBeGreaterThan(0);
    expect(steeringLookup).toBeLessThan(handler.indexOf("if (inlineCaptureRequested)"));
    expect(handler.indexOf("if (inlineCaptureRequested)")).toBeLessThan(handler.indexOf("ensureChannelProject("));
    expect(handler).toContain("await scheduleInlineCaptureRecovery(opts.client, opts.channel, opts.userMsgTs)");
    expect(handler).not.toContain("await handleInlineCapture({");
    expect(steeringLookup).toBeLessThan(handler.indexOf('channel.mode === "agent-tag"'));
  });

  test("prepares attached replies inside the steering queue instead of rejecting their text and files", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    expect(handler).not.toContain("Steering attachments are unsupported.");
    const preparation = handler.slice(handler.indexOf("prepareText:"), handler.indexOf("onSending:"));
    expect(preparation).toContain("prepareProviderInput(");
    expect(preparation).toContain("files: steeringFiles");
    expect(preparation).toContain("attachmentRoot");
    expect(preparation).toContain("prepared.unreplayableAttachmentCount");
  });

  test("acknowledges successful steering with a reaction on the exact steering message", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const worker = source.slice(
      source.indexOf("function scheduleSteeringNotification"),
      source.indexOf("function scheduleSlackInputRecoveryNotice"),
    );
    const handler = source.slice(
      source.indexOf("async function handleUserMessage"),
      source.indexOf("const ROUTABLE_SUBTYPES"),
    );

    expect(worker).toContain('slackCall(client, "reactions.add"');
    expect(worker).toContain("timestamp: claimed.slack_user_msg_ts");
    expect(worker).toContain('name: "arrow_right_hook"');
    expect(worker).toContain('slackErrorCode(error) !== "already_reacted"');
    expect(handler).toContain("void scheduleSteeringNotification(opts.client, steeringMessage.row.id, opts.user)");
    expect(source).not.toContain("Steering received for the active agent turn.");
  });

  test("keeps every acknowledged handler drain-owned while durable ingress retries", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const claimRetry = handler.indexOf("retryTransientDatabaseOperation({");

    expect(handler.indexOf("activeInputHandlerCount += 1")).toBeLessThan(claimRetry);
    expect(claimRetry).toBeLessThan(handler.indexOf("activeTurnDispatch.dispatchSteering("));
    expect(handler.lastIndexOf("activeInputHandlerCount -= 1")).toBeGreaterThan(claimRetry);
    expect(source).toContain("activeTurnCount > 0 || activeInputHandlerCount > 0");
    expect(source).toContain("activeTurnCount !== 0 || activeInputHandlerCount !== 0");
  });

  test("persists new input as queued work instead of rejecting it during shutdown", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));

    expect(handler).toContain("deferProvider: draining");
    expect(handler).not.toContain('if ("draining" in turn && turn.draining)');
    expect(handler).not.toContain("Deployment drain rejection could not be persisted");
  });

  test("promotes queued user work before waking a waiting deployment", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const registry = source.slice(
      source.indexOf("const activeTurnDispatch = new ActiveTurnDispatchRegistry"),
      source.indexOf("const runKeyedDurableTask"),
    );

    expect(registry.indexOf("sessionTurnQueue?.wake()"))
      .toBeLessThan(registry.indexOf("wakeDeploymentRunnerWaitingForIdle()"));
  });

  test("serializes process heartbeats without installing a recurring Canvas sweep", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const heartbeat = source.slice(
      source.indexOf("function scheduleProcessHeartbeat"),
      source.indexOf("setInterval(scheduleProcessHeartbeat") + "setInterval(scheduleProcessHeartbeat, 15_000);".length,
    );

    expect(heartbeat).toContain("if (heartbeatInFlight || draining) return");
    expect(heartbeat).toContain("retryTransientDatabaseOperation({");
    expect(heartbeat).toContain("operation: () => heartbeatProcessInstance(instanceId)");
    expect(heartbeat).toContain(".catch((error) =>");
    expect(heartbeat).toContain("heartbeatInFlight = heartbeat");
    expect(source).not.toContain("setInterval(() => heartbeatProcessInstance");
    expect(source).not.toContain("rerenderAllCanvases");
    expect(source).not.toContain("scheduled_canvas_refresh");
    expect(source).toContain("canvasCommitWatcher.start(channels)");
  });

  test("periodically projects status and reaction cleanup for terminalized queued turns", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const maintenance = source.slice(
      source.lastIndexOf("setInterval(() => {", source.indexOf("async function drainAndStop")),
      source.indexOf("async function drainAndStop"),
    );

    expect(maintenance).toContain("for (const status of listPendingTurnStatusProjections())");
    expect(maintenance).toContain("scheduleSlackTurnStatusProjection(app.client, status.turn_id)");
    expect(maintenance).toContain("for (const cleanup of listPendingTurnReactionCleanups())");
    expect(maintenance).toContain("schedulePersistedTurnReactionCleanup(cleanup.turn_id)");
    expect(maintenance).toContain("}, 60_000);");
  });

  test("establishes bot identity before recovery and Socket Mode ingress", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const startup = source.slice(source.lastIndexOf("(async () => {"));

    expect(startup.indexOf("app.client.auth.test()")).toBeLessThan(startup.indexOf("reconcilePriorInstanceTurns()"));
    expect(startup.indexOf("reconcilePriorInstanceTurns()")).toBeLessThan(startup.indexOf("app.start()"));
    expect(source).toContain("scheduleChannelListAccessRepair(app.client, channel)");
    expect(source).toContain('scheduleDurableNotice(`list-access:${channel.slack_channel_id}`');
    expect(source).toContain("if (!isTransientSlackError(error))");
  });

  test("fork-from-here resolves the selected reply instead of its thread root", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const shortcut = source.slice(source.indexOf('app.shortcut("fork_from_here"'));

    expect(shortcut).toContain("const selectedMessageTs = s.message.ts");
    expect(shortcut).toContain("resolveForkParentSession(s.channel.id, selectedMessageTs)");
    expect(shortcut).not.toContain("resolveForkParentSession(s.channel.id, selectedThreadTs)");
    expect(shortcut).toContain("requireBoundary: true");
    expect(shortcut).toContain("sourceMessageExcerpt: forkSourceExcerpt(s.message.text)");
    expect(shortcut).toContain("text: forkRequestResultMessage(request)");
  });

  test("queues guidance until the provider registers and preserves order", async () => {
    const controller = new TurnSteeringController();
    const sent: string[] = [];
    const outcomes: string[] = [];

    controller.enqueue({
      clientMessageId: "one",
      text: "first",
      onSent: () => outcomes.push("sent-one"),
      onError: (error) => outcomes.push(error.message),
    });
    controller.enqueue({
      clientMessageId: "two",
      text: "second",
      onSent: () => outcomes.push("sent-two"),
      onError: (error) => outcomes.push(error.message),
    });

    controller.registerSender(async (input) => { sent.push(input.text); });
    await tick();

    expect(sent).toEqual(["first", "second"]);
    expect(outcomes).toEqual(["sent-one", "sent-two"]);
  });

  test("reserves arrival order before asynchronous message preparation", async () => {
    const controller = new TurnSteeringController();
    const sent: string[] = [];
    let finishFirstPreparation!: (text: string) => void;
    const firstPreparation = new Promise<string>((resolve) => { finishFirstPreparation = resolve; });
    controller.registerSender(async (input) => { sent.push(input.text); });

    controller.enqueue({
      clientMessageId: "one",
      text: "first fallback",
      prepareText: () => firstPreparation,
      onSent: () => {},
      onError: () => {},
    });
    controller.enqueue({
      clientMessageId: "two",
      text: "second fallback",
      prepareText: async () => "second prepared",
      onSent: () => {},
      onError: () => {},
    });

    await tick();
    expect(sent).toEqual([]);
    finishFirstPreparation("first prepared");
    await tick();

    expect(sent).toEqual(["first prepared", "second prepared"]);
  });

  test("fails queued guidance when the provider turn closes", async () => {
    const controller = new TurnSteeringController();
    const failures: string[] = [];
    controller.enqueue({
      clientMessageId: "one",
      text: "too late",
      onSent: () => {},
      onError: (error) => failures.push(error.message),
    });

    controller.close(new Error("turn finished"));
    await tick();

    expect(failures).toEqual(["turn finished"]);
    expect(controller.enqueue({
      clientMessageId: "two",
      text: "later",
      onSent: () => {},
      onError: () => {},
    })).toBe(false);
  });

  test("waits for in-flight attachment preparation after close and never sends the late result", async () => {
    const controller = new TurnSteeringController();
    let finishPreparation!: (text: string) => void;
    const preparing = new Promise<string>((resolve) => { finishPreparation = resolve; });
    const failures: string[] = [];
    const sent: string[] = [];
    controller.registerSender(async ({ text }) => { sent.push(text); }, "/tmp/turn-owned");
    controller.enqueue({
      clientMessageId: "with-file", text: "caption",
      prepareText: (root) => {
        expect(root).toBe("/tmp/turn-owned");
        return preparing;
      },
      onSent: () => {}, onError: (error) => { failures.push(error.message); },
    });
    controller.close(new Error("provider completed during download"));
    let canClean = false;
    const settled = controller.waitForPreparation().then(() => { canClean = true; });
    await tick();
    expect(canClean).toBeFalse();
    finishPreparation("caption plus local file path");
    await settled;
    expect(sent).toEqual([]);
    expect(failures).toEqual(["provider completed during download"]);
  });

  test("marks an in-flight close ambiguous and upgrades it after a late acknowledgement", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    let acknowledge!: () => void;
    const providerAcknowledgement = new Promise<void>((resolve) => { acknowledge = resolve; });
    controller.registerSender(() => providerAcknowledgement);
    controller.enqueue({
      clientMessageId: "one",
      text: "still sending",
      onSent: () => outcomes.push("sent"),
      onError: (error) => outcomes.push(`failed:${error.message}`),
      onAmbiguous: (error) => outcomes.push(`ambiguous:${error.message}`),
    });

    await tick();
    controller.close(new Error("turn finished"));
    acknowledge();
    await tick();

    expect(outcomes).toEqual(["ambiguous:turn finished", "sent"]);
  });

  test("defers an ambiguity notice until provider acknowledgement is definitively rejected", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    let rejectAcknowledgement!: (error: Error) => void;
    controller.registerSender(() => new Promise<void>((_resolve, reject) => { rejectAcknowledgement = reject; }));
    controller.enqueue({
      clientMessageId: "one",
      text: "in flight",
      onSent: () => outcomes.push("sent"),
      onError: () => outcomes.push("failed"),
      onAmbiguous: () => outcomes.push("ambiguous"),
      onAmbiguousFinalized: () => outcomes.push("notice-ready"),
    });

    await tick();
    controller.close(new Error("turn finished"));
    await tick();
    expect(outcomes).toEqual(["ambiguous"]);
    rejectAcknowledgement(new Error("provider rejected"));
    await tick();
    expect(outcomes).toEqual(["ambiguous", "notice-ready"]);
  });

  test("classifies a provider pre-write rejection as definitely unsent", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    controller.registerSender(async () => { throw new SteeringNotSentError("already complete"); });
    controller.enqueue({
      clientMessageId: "one",
      text: "too late",
      onSent: () => outcomes.push("sent"),
      onError: () => outcomes.push("failed"),
      onAmbiguous: () => outcomes.push("ambiguous"),
    });

    await tick();
    expect(outcomes).toEqual(["failed"]);
  });

  test("finalizes ambiguity immediately when the provider rejects after delivery starts", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    controller.registerSender(async () => { throw new Error("acknowledgement failed"); });
    controller.enqueue({
      clientMessageId: "one",
      text: "maybe sent",
      onSent: () => outcomes.push("sent"),
      onError: () => outcomes.push("failed"),
      onAmbiguous: () => outcomes.push("ambiguous"),
      onAmbiguousFinalized: () => outcomes.push("notice-ready"),
    });

    await tick();
    expect(outcomes).toEqual(["ambiguous", "notice-ready"]);
  });

  test("does not call the provider until the sending transition is durable", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    controller.registerSender(async () => { outcomes.push("provider"); });
    controller.enqueue({
      clientMessageId: "one",
      text: "guidance",
      onSending: async () => {
        outcomes.push("persist-sending");
        throw new Error("database is locked");
      },
      onSent: () => outcomes.push("sent"),
      onError: (error) => outcomes.push(`failed:${error.message}`),
    });

    await tick();
    expect(outcomes).toEqual(["persist-sending", "failed:database is locked"]);
  });

  test("turns a failed acknowledgement persistence callback into durable ambiguity", async () => {
    const controller = new TurnSteeringController();
    const outcomes: string[] = [];
    controller.registerSender(async () => { outcomes.push("provider-acknowledged"); });
    controller.enqueue({
      clientMessageId: "one",
      text: "guidance",
      onSent: async () => {
        outcomes.push("persist-sent");
        throw new Error("persistence failed");
      },
      onError: () => outcomes.push("failed"),
      onAmbiguous: () => outcomes.push("ambiguous"),
      onAmbiguousFinalized: () => outcomes.push("notice-ready"),
    });

    await tick();
    expect(outcomes).toEqual([
      "provider-acknowledged",
      "persist-sent",
      "ambiguous",
      "notice-ready",
    ]);
  });
});
