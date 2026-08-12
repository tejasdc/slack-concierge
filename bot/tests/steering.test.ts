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

  test("checks live steering before drain, capture, and channel admission", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const duplicateLookup = handler.indexOf("claimSlackUserInput(");
    const steeringLookup = handler.indexOf("activeSteeringTargets.get(steeringKey)");

    expect(duplicateLookup).toBeGreaterThan(0);
    expect(duplicateLookup).toBeLessThan(steeringLookup);
    expect(steeringLookup).toBeGreaterThan(0);
    expect(steeringLookup).toBeLessThan(handler.indexOf("if (draining)"));
    expect(steeringLookup).toBeLessThan(handler.indexOf("if (inlineCaptureRequested)"));
    expect(handler.indexOf("if (inlineCaptureRequested)")).toBeLessThan(handler.indexOf("ensureChannelProject("));
    expect(handler).toContain("await scheduleInlineCaptureRecovery(opts.client, opts.channel, opts.userMsgTs)");
    expect(handler).not.toContain("await handleInlineCapture({");
    expect(steeringLookup).toBeLessThan(handler.indexOf('channel.mode === "agent-tag"'));
  });

  test("keeps every acknowledged handler drain-owned while durable ingress retries", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const claimRetry = handler.indexOf("retryTransientDatabaseOperation({");

    expect(handler.indexOf("activeInputHandlerCount += 1")).toBeLessThan(claimRetry);
    expect(claimRetry).toBeLessThan(handler.indexOf("activeSteeringTargets.get(steeringKey)"));
    expect(handler.lastIndexOf("activeInputHandlerCount -= 1")).toBeGreaterThan(claimRetry);
    expect(source).toContain("activeTurnCount > 0 || activeInputHandlerCount > 0");
    expect(source).toContain("activeTurnCount !== 0 || activeInputHandlerCount !== 0");
  });

  test("routes both deployment drain gates through the durable input notice worker", () => {
    const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf-8");
    const handler = source.slice(source.indexOf("async function handleUserMessage"), source.indexOf("const ROUTABLE_SUBTYPES"));
    const processDrain = handler.slice(handler.indexOf("if (draining)"), handler.indexOf("if (inlineCaptureRequested)"));
    const databaseDrain = handler.slice(
      handler.indexOf('if ("draining" in turn && turn.draining)'),
      handler.indexOf("if (turn.duplicate)"),
    );

    expect(processDrain).toContain("scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs)");
    expect(databaseDrain).toContain("scheduleSlackInputRecoveryNotice(opts.client, opts.channel, opts.userMsgTs)");
    expect(processDrain).not.toContain("chat.postMessage");
    expect(databaseDrain).not.toContain("chat.postMessage");
    expect(source).toContain('text: claimed.kind === "draining"');
    expect(source).toContain("slack-concierge:input-recovery-notice:");
  });

  test("serializes process heartbeats and catches recurring task failures", () => {
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
    expect(source).toContain('void rerenderAllCanvases("interval").catch((error) =>');
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
