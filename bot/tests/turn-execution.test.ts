import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/providers";
import { slackBucket } from "../src/rate-limit";
import { TurnSteeringController } from "../src/steering";
import { executeAgentTurn, type TurnExecutionServices } from "../src/turn-execution";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimSlackThreadStatusProjection,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  getChannel,
  getSession,
  getSlackThreadStatus,
  getTurnStatusProjection,
  listRecoverableTurns,
  markDeliveryChunkDelivered,
  markSlackThreadStatusProjectionDelivered,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  requestSlackThreadStatusProjection,
  requestTurnStatusProjection,
  upsertChannel,
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
  projectDir = mkdtempSync(join(tmpdir(), "concierge-turn-execution-"));
});

afterEach(() => {
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

describe("executeAgentTurn", () => {
  test("settles the lock and publishes an error status when setup fails before provider start", async () => {
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
    const lifecycleEvents: string[] = [];
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
      projectTurnStatus: ({ turnId, text }) => {
        lifecycleEvents.push("terminal-status");
        return projectTurnStatus(client, turnId, text);
      },
      projectThreadSummary: async () => "delivered",
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
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
        lifecycleEvents.push("steering-closed");
        controller.close(reason);
      },
      services,
    });

    expect(outcome.status).toBe("error");
    expect(providerCalled).toBeFalse();
    expect(closeSteeringCalls).toBeGreaterThan(0);
    expect(lifecycleEvents.indexOf("steering-closed")).toBeLessThan(
      lifecycleEvents.indexOf("terminal-status"),
    );
    expect(statusTexts.some((text) => text.includes("Status: error"))).toBeTrue();
    expect(db.query("SELECT status FROM turns WHERE id=?").get(acquired.id)).toMatchObject({ status: "error" });
    expect(getSession("C1", rootThreadTs, "codex").status).toBe("error");
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
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
    };
    const provider: AgentProvider = {
      id: "codex",
      async run(input) {
        input.onProgress?.({ type: "started" });
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
    const attachmentDir = join(tmpdir(), "inbox-attachments", "C1", userMsgTs);
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
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
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
        throw new Error("delivery must not begin after the list failure");
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
      loadListContext: async () => "",
      applyListOperations: async () => {
        throw new Error("list operation failed");
      },
      syncCanvasIfChanged: async () => {},
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
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
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
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
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
      loadListContext: async () => "",
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
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

  test("gives every follow-up its own heartbeat while retaining one cumulative thread summary", async () => {
    upsertChannel({
      slack_channel_id: "C1",
      slack_channel_name: "concierge",
      group_name: null,
      name: "Concierge",
      vault_path: projectDir,
      code_path: projectDir,
    });
    const rootThreadTs = "1000.000001";
    const session = createOrGetSession("C1", rootThreadTs, "codex");
    const slackEvents: Array<{ kind: string; ts?: string; text?: string; threadTs?: string }> = [];
    const providerPrompts: string[] = [];
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
      id: "codex",
      async run(input) {
        const index = providerTurn++;
        providerPrompts.push(String(input.systemPrompt));
        input.onProgress?.({ type: "started" });
        input.onProgress?.({ type: "tool_use", toolName: "exec" });
        await Promise.race([
          heartbeatPromises[index],
          new Promise((_, reject) => setTimeout(() => reject(new Error("heartbeat did not arrive")), 1_000)),
        ]);
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
      loadListContext: async () => {
        await Promise.race([
          heartbeatPromises[statusCount - 1],
          new Promise((_, reject) => setTimeout(() => reject(new Error("preprocessing heartbeat did not arrive")), 1_000)),
        ]);
        return "No pending Slack List items.";
      },
      applyListOperations: async () => {},
      syncCanvasIfChanged: async () => {},
    };

    const runTurn = async (userMsgTs: string, text: string) => {
      const currentSession = getSession("C1", rootThreadTs, "codex");
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
        statusIntervalMs: 5,
      });
    };

    expect((await runTurn("1000.000010", "First request")).status).toBe("delivered");
    const firstTurnEventCount = slackEvents.length;
    expect((await runTurn("1000.000020", "Follow-up request")).status).toBe("delivered");

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
    expect(providerPrompts[1]).toContain("Completed the first request.");
  });
});
