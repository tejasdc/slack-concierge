import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProvider } from "../src/providers";
import {
  buildQueuedTurnInput,
  executePersistedQueuedTurn,
  type ClaimedTurnInput,
} from "../src/queued-turn-execution";
import { slackBucket } from "../src/rate-limit";
import { persistentSessionThreadTs } from "../src/routing";
import { SessionTurnQueueCoordinator } from "../src/session-turn-queue";
import { loadSkillPrompt, selectSkillRoute } from "../src/skill-routes";
import { TurnSteeringController } from "../src/steering";
import { startRecoveredSessionTurnQueue } from "../src/turn-dispatch-seams";
import { scheduleTurnReactionCleanup } from "../src/turn-reaction-cleanup";
import { executeAgentTurn, type TurnExecutionServices } from "../src/turn-execution";
import { reconcileRecoverableTurns } from "../src/turn-recovery";
import { acquireDatabaseTestLock } from "./db-lock";

const state = require("../src/state");
const {
  acquireSessionTurn,
  claimNextQueuedTurn,
  claimSlackUserInput,
  claimTurnStatusProjection,
  createOrGetSession,
  db,
  failRunningTurnAndReleaseSession,
  finishTurn,
  getChannel,
  getSessionById,
  getTurnReactionCleanup,
  getTurnStatusProjection,
  listRecoverableTurns,
  markTurnStatusProjectionDelivered,
  recordTurnStatusMessage,
  requestTurnStatusProjection,
  setSessionStatus,
  upsertChannel,
} = state;

let releaseDatabaseTestLock: (() => void) | null = null;
let projectDir = "";

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  slackBucket.reset();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM slack_thread_statuses").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
  projectDir = mkdtempSync(join(tmpdir(), "concierge-queued-turn-"));
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

async function projectTurnStatus(client: any, turnId: number, text: string, beforeClaim?: () => void) {
  requestTurnStatusProjection(turnId, text);
  beforeClaim?.();
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

describe("persisted queued turn execution", () => {
  test("recovery recognizes a bound shared anchor even when it is the visible reply root", () => {
    installPersistentChannel();
    const root = "1770000000.000001";
    const session = createOrGetSession("C1", root, "claude-code");
    db.query("UPDATE sessions SET agent_session_uuid='shared-claude' WHERE id=?").run(session.id);
    db.query("UPDATE channels SET default_session_uuid='shared-claude' WHERE slack_channel_id='C1'").run();
    const first = acquireSessionTurn(session.id, root, "first", "runtime-1", null, root);
    claimSlackUserInput("C1", "1770000000.000002", "reply-claim", "runtime-1", {
      replyThreadTs: root, userId: "U1", userText: "reply",
    });
    const queued = acquireSessionTurn(session.id, "1770000000.000002", "reply", "runtime-1", "reply-claim", root);
    expect(queued.queued).toBeTrue();
    finishTurn(first.id, "done", "finished");
    setSessionStatus(session.id, "idle");
    const claim = claimNextQueuedTurn("runtime-2");
    const input = buildQueuedTurnInput(claim, {
      client: {}, getSessionById, getChannel, baseSystemPromptForText: () => undefined,
    });
    expect(input.sessionMode).toBe("single-persistent");
    expect(input.session.agent_session_uuid).toBe("shared-claude");
    expect(input.threadTs).toBe(root);
    expect(input.userMsgTs).toBe("1770000000.000002");
  });

  test.each(["root", "reply-to-older-thread"])("runs rapid router inputs through FIFO with their own triggering identity (%s)", async secondKind => {
    installPersistentChannel();
    const firstRoot = "1787196473.089489";
    const secondMessageTs = "1787196473.317689";
    const secondRoot = secondKind === "root" ? secondMessageTs : "1787100000.000001";
    const anchor = persistentSessionThreadTs("C1");
    const secondText = "<@UBOT> @substack-editor Check https://tejazz.slack.com/archives/C123/p1786144075781769?thread_ts=1786136808.487959&cid=C123";
    const session = createOrGetSession("C1", anchor, "claude-code");
    claimSlackUserInput("C1", firstRoot, "claim-first", "runtime-1", {
      replyThreadTs: firstRoot,
      userId: "U1",
      userText: "Click it on my link.",
    });
    claimSlackUserInput("C1", secondMessageTs, "claim-second", "runtime-1", {
      replyThreadTs: secondRoot,
      userId: "U1",
      userText: secondText,
    });
    const duplicate = claimSlackUserInput("C1", secondMessageTs, "duplicate-delivery", "runtime-1", {
      replyThreadTs: secondRoot,
      userId: "U1",
      userText: secondText,
    });
    const first = acquireSessionTurn(
      session.id,
      firstRoot,
      "Click it on my link.",
      "runtime-1",
      "claim-first",
      firstRoot,
    );
    const second = acquireSessionTurn(
      session.id,
      secondMessageTs,
      secondText,
      "runtime-1",
      "claim-second",
      secondRoot,
      {
        userId: "U1",
        providerModel: "persisted-model",
        reasoningEffort: "high",
      },
    );

    expect(first.acquired).toBeTrue();
    expect(second.queued).toBeTrue();
    expect(duplicate.claimed).toBeFalse();
    expect(db.query("SELECT COUNT(*) AS count FROM turns").get()).toEqual({ count: 2 });
    const staleQueuedProjection = claimTurnStatusProjection(second.id, Date.now());
    expect(staleQueuedProjection?.desired_text).toContain("Status: queued");

    const statusThreads: string[] = [];
    const deliveredResponses: Array<{ threadTs: string; text: string }> = [];
    let statusSequence = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async (args: any) => {
          statusThreads.push(args.thread_ts);
          return { ok: true, ts: `status-${++statusSequence}` };
        },
        update: async () => ({ ok: true }),
      },
      conversations: {
        replies: async () => ({
          ok: true,
          messages: [
            { ts: "1786136808.487959", user: "U2", text: "Try the neighborhood list." },
          ],
        }),
      },
    };
    const providerInputs: Array<{
      prompt: string;
      sessionUUID: string | null;
      systemPrompt?: string;
      model?: string;
      reasoningEffort?: string;
    }> = [];
    let firstProviderStarted!: () => void;
    const firstProviderStartedPromise = new Promise<void>((resolve) => {
      firstProviderStarted = resolve;
    });
    let releaseFirstProvider!: () => void;
    const firstProviderRelease = new Promise<void>((resolve) => {
      releaseFirstProvider = resolve;
    });
    let steeringRegistrations = 0;
    const provider: AgentProvider = {
      id: "claude-code",
      async run(input) {
        providerInputs.push({
          prompt: input.prompt,
          sessionUUID: input.sessionUUID,
          systemPrompt: input.systemPrompt,
          model: input.model,
          reasoningEffort: input.reasoning_effort,
        });
        steeringRegistrations += 1;
        input.onSteeringReady?.(async () => {});
        input.onProgress?.({ type: "started" });
        if (providerInputs.length === 1) {
          firstProviderStarted();
          await firstProviderRelease;
        }
        input.onProviderTerminal?.();
        return {
          text: providerInputs.length === 1
            ? "TL;DR: First root completed.\n\nFirst response."
            : "TL;DR: Second root completed.\n\nSecond response.",
          sessionUUID: "provider-session-1",
          providerTurnId: `provider-turn-${providerInputs.length}`,
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let staleQueuedDeliveryApplied = false;
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async ({ threadTs, text }) => {
        deliveredResponses.push({ threadTs, text });
        return "delivered";
      },
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(
        client,
        turnId,
        text,
        turnId === second.id && !staleQueuedDeliveryApplied
          ? () => {
              staleQueuedDeliveryApplied = true;
              markTurnStatusProjectionDelivered(second.id, staleQueuedProjection!.desired_revision);
            }
          : undefined,
      ),
      projectThreadSummary: async () => "delivered",
    };
    const execute = (input: ClaimedTurnInput, ownerInstanceId: string) => {
      const steeringController = new TurnSteeringController();
      return executeAgentTurn({
        ...input,
        provider,
        cwd: input.channel.code_path || input.channel.vault_path,
        additionalDirs: [],
        botToken: "test-token",
        ownerInstanceId,
        steeringController,
        closeSteering: (reason) => steeringController.close(reason),
        services,
      });
    };
    const firstExecution = execute({
      turnId: first.id,
      session,
      channel: getChannel("C1"),
      channelId: "C1",
      threadTs: firstRoot,
      userMsgTs: firstRoot,
      user: "U1",
      text: "Click it on my link.",
      prompt: "Click it on my link.",
      files: [],
      client,
      providerId: "claude-code",
      providerLabel: "claude-code",
      sessionThreadTs: anchor,
      sessionMode: "single-persistent",
      hydrateSlackLinks: true,
    }, "runtime-1");
    await firstProviderStartedPromise;
    expect(claimNextQueuedTurn("runtime-before-recovery")).toBeNull();
    releaseFirstProvider();
    expect((await firstExecution).status).toBe("delivered");

    let secondOutcome: any = null;
    let secondFinished!: () => void;
    const secondFinishedPromise = new Promise<void>((resolve) => {
      secondFinished = resolve;
    });
    const coordinator = new SessionTurnQueueCoordinator({
      claim: () => claimNextQueuedTurn("runtime-2"),
      run: async (claim) => {
        secondOutcome = await executePersistedQueuedTurn(claim, {
          buildInput: (queuedClaim) => buildQueuedTurnInput(queuedClaim, {
            client,
            getSessionById,
            getChannel,
            baseSystemPromptForText: (text) => loadSkillPrompt(
              selectSkillRoute([{
                name: "substack-editor",
                match: /@substack-editor/i,
                skillPath: "/test/SKILL.md",
              }], text),
              { exists: () => true, read: () => "QUEUED SKILL PROMPT" },
            ),
          }),
          run: (input) => execute(input, "runtime-2"),
          fail: (_claim, error) => ({ status: "error", error: String(error) }),
        });
        secondFinished();
      },
      shouldStop: () => false,
      onError: (_claim, error) => {
        throw error;
      },
    });
    coordinator.wake();
    await secondFinishedPromise;

    expect(secondOutcome.status).toBe("delivered");
    expect(providerInputs).toHaveLength(2);
    expect(providerInputs.map(input => JSON.parse(input.prompt.match(/<slack-message-context>\n(.+)\n<\/slack-message-context>/)![1]!))).toEqual([
      { channel_id: "C1", message_ts: firstRoot, thread_ts: firstRoot },
      { channel_id: "C1", message_ts: secondMessageTs, thread_ts: secondRoot },
    ]);
    expect(providerInputs.every(input => !input.prompt.includes(anchor))).toBeTrue();
    expect(providerInputs[1].sessionUUID).toBe("provider-session-1");
    expect(providerInputs[1].model).toBe("persisted-model");
    expect(providerInputs[1].reasoningEffort).toBe("high");
    expect(providerInputs[1].prompt).not.toContain("<@UBOT>");
    expect(providerInputs[1].prompt).not.toContain("@substack-editor");
    expect(providerInputs[1].prompt).toContain("Use this linked-thread context");
    expect(providerInputs[1].prompt).toContain("Try the neighborhood list.");
    expect(providerInputs[1].systemPrompt).toContain("QUEUED SKILL PROMPT");
    expect(statusThreads).toEqual([firstRoot, secondRoot]);
    expect(deliveredResponses.map((response) => response.threadTs)).toEqual([firstRoot, secondRoot]);
    expect(deliveredResponses[0].text).toContain("First root completed");
    expect(deliveredResponses[1].text).toContain("Second root completed");
    expect(steeringRegistrations).toBe(2);
    expect(staleQueuedDeliveryApplied).toBeTrue();
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      projection_status: "delivered",
      desired_revision: 3,
      projected_revision: 3,
    });
    expect(getTurnStatusProjection(second.id)?.desired_text).toContain("Status: done");
  });

  test("requeues an orphaned pre-dispatch predecessor before the production restart seam promotes its successor", async () => {
    installPersistentChannel();
    const anchor = persistentSessionThreadTs("C1");
    const firstTs = "190.000001";
    const secondTs = "190.000002";
    const session = createOrGetSession("C1", anchor, "claude-code");
    claimSlackUserInput("C1", firstTs, "first-claim", "dead-runtime", {
      replyThreadTs: firstTs,
      userId: "U1",
      userText: "First request",
    });
    claimSlackUserInput("C1", secondTs, "second-claim", "dead-runtime", {
      replyThreadTs: secondTs,
      userId: "U1",
      userText: "Second request",
    });
    const first = acquireSessionTurn(
      session.id,
      firstTs,
      "First request",
      "dead-runtime",
      "first-claim",
      firstTs,
    );
    const second = acquireSessionTurn(
      session.id,
      secondTs,
      "Second request",
      "dead-runtime",
      "second-claim",
      secondTs,
    );
    expect(first.acquired).toBeTrue();
    expect(second.queued).toBeTrue();

    const events: string[] = [];
    let statusSequence = 0;
    const client = {
      reactions: {
        add: async () => ({ ok: true }),
        remove: async () => ({ ok: true }),
      },
      chat: {
        postMessage: async () => ({ ok: true, ts: `restart-status-${++statusSequence}` }),
        update: async () => ({ ok: true }),
      },
    };
    const services: TurnExecutionServices = {
      hydrateLegacyThreadOwnership: async () => 0,
      deliverOutcome: async () => "delivered",
      projectTurnStatus: ({ turnId, text }) => projectTurnStatus(client, turnId, text),
      projectThreadSummary: async () => "delivered",
    };
    const provider: AgentProvider = {
      id: "claude-code",
      async run(input) {
        events.push("provider-started");
        input.onSteeringReady?.(async () => {});
        input.onProgress?.({ type: "started" });
        input.onProviderTerminal?.();
        return {
          text: "TL;DR: Queued successor completed.\n\nRecovered execution.",
          sessionUUID: "replacement-provider-session",
          providerTurnId: "replacement-provider-turn",
          toolsUsed: [],
        };
      },
      async fork() {
        throw new Error("not used");
      },
    };
    let successorOutcome: any = null;
    let completeSuccessor!: () => void;
    let failSuccessor!: (error: unknown) => void;
    const successorCompleted = new Promise<void>((resolve, reject) => {
      completeSuccessor = resolve;
      failSuccessor = reject;
    });

    await startRecoveredSessionTurnQueue({
      recoverPriorTurns: async () => {
        events.push("recovery-started");
        expect(await reconcileRecoverableTurns({
          client,
          instanceId: "replacement-runtime",
          isOwnerAlive: () => false,
          services,
        })).toBe("done");
        events.push("recovery-complete");
      },
      startRuntime: async () => { events.push("runtime-started"); },
      verifyProviderReady: async () => { events.push("provider-ready"); },
      startQueue: () => {
        events.push("queue-started");
        const coordinator = new SessionTurnQueueCoordinator({
          claim: () => claimNextQueuedTurn("replacement-runtime"),
          run: async (claim) => {
            try {
              const outcome = await executePersistedQueuedTurn(claim, {
                buildInput: (queuedClaim) => buildQueuedTurnInput(queuedClaim, {
                  client,
                  getSessionById,
                  getChannel,
                  baseSystemPromptForText: () => undefined,
                }),
                run: (input) => {
                  const steeringController = new TurnSteeringController();
                  return executeAgentTurn({
                    ...input,
                    provider,
                    cwd: input.channel.code_path || input.channel.vault_path,
                    additionalDirs: [],
                    botToken: "test-token",
                    ownerInstanceId: "replacement-runtime",
                    steeringController,
                    closeSteering: (reason) => steeringController.close(reason),
                    services,
                  });
                },
                fail: (_claim, error) => { throw error; },
              });
              if (claim.turn_id === second.id) {
                successorOutcome = outcome;
                completeSuccessor();
              }
            } catch (error) {
              failSuccessor(error);
              throw error;
            }
          },
          shouldStop: () => false,
          onError: (_claim, error) => { failSuccessor(error); },
        });
        coordinator.wake();
      },
    });
    await successorCompleted;

    expect(events).toEqual([
      "recovery-started",
      "recovery-complete",
      "runtime-started",
      "provider-ready",
      "queue-started",
      "provider-started",
      "provider-started",
    ]);
    expect(successorOutcome.status).toBe("delivered");
    expect(db.query("SELECT status FROM turns WHERE id=?").get(first.id)).toEqual({ status: "done" });
    expect(db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(second.id)).toEqual({
      status: "done",
      owner_instance_id: null,
    });
  });

  test("settles malformed persisted input visibly without entering provider execution", async () => {
    installPersistentChannel();
    const anchor = persistentSessionThreadTs("C1");
    const session = createOrGetSession("C1", anchor, "claude-code");
    const first = acquireSessionTurn(session.id, "200.000001", "first", "runtime-1");
    claimSlackUserInput("C1", "200.000002", "claim-malformed", "runtime-1", {
      replyThreadTs: "200.000002",
      userId: "U1",
      userText: "second",
    });
    const second = acquireSessionTurn(
      session.id,
      "200.000002",
      "second",
      "runtime-1",
      "claim-malformed",
      "200.000002",
    );
    finishTurn(first.id, "done", "done");
    db.query(`UPDATE slack_user_input_claims SET files_json='{bad json'
              WHERE slack_channel_id='C1' AND slack_user_msg_ts='200.000002'`).run();
    const claim = claimNextQueuedTurn("runtime-2");
    if (!claim) throw new Error("Expected malformed queued turn to be claimed");
    let providerEntered = false;

    const outcome = await executePersistedQueuedTurn(claim, {
      buildInput: (queuedClaim) => buildQueuedTurnInput(queuedClaim, {
        client: {},
        getSessionById,
        getChannel,
        baseSystemPromptForText: () => undefined,
      }),
      run: async () => {
        providerEntered = true;
        return { status: "delivered" };
      },
      fail: (queuedClaim, error) => {
        const message = String(error);
        expect(failRunningTurnAndReleaseSession(
          queuedClaim.turn_id,
          "runtime-2",
          message,
          `Status: error - ${message}`,
        )).toBeTrue();
        return { status: "error", error: message };
      },
    });

    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("files_json is not valid JSON");
    expect(providerEntered).toBeFalse();
    expect(db.query("SELECT status, owner_instance_id FROM turns WHERE id=?").get(second.id)).toEqual({
      status: "error",
      owner_instance_id: null,
    });
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      projection_status: "pending",
      desired_revision: 2,
    });
    expect(getTurnStatusProjection(second.id)?.desired_text).toContain("Status: error");
  });

  test("atomically terminalizes archived queued input and makes cleanup runnable without restart", async () => {
    installPersistentChannel();
    const anchor = persistentSessionThreadTs("C1");
    const session = createOrGetSession("C1", anchor, "claude-code");
    const first = acquireSessionTurn(session.id, "210.000001", "first", "runtime-1");
    claimSlackUserInput("C1", "210.000002", "claim-archived", "runtime-1", {
      replyThreadTs: "210.000002",
      userId: "U1",
      userText: "accepted before archive",
    });
    const second = acquireSessionTurn(
      session.id,
      "210.000002",
      "accepted before archive",
      "runtime-1",
      "claim-archived",
      "210.000002",
    );
    finishTurn(first.id, "done", "done");
    setSessionStatus(session.id, "archived");

    expect(claimNextQueuedTurn("runtime-2")).toBeNull();
    expect(db.query("SELECT status, agent_text, owner_instance_id FROM turns WHERE id=?").get(second.id)).toEqual({
      status: "error",
      agent_text: "Queued turn session was archived before execution.",
      owner_instance_id: null,
    });
    expect(getSessionById(session.id)?.status).toBe("archived");
    expect(listRecoverableTurns().some((turn: { id: number }) => turn.id === second.id)).toBeFalse();
    expect(getTurnStatusProjection(second.id)).toMatchObject({
      projection_status: "pending",
      desired_revision: 2,
    });
    expect(getTurnStatusProjection(second.id)?.desired_text).toContain("archived before execution");
    expect(getTurnReactionCleanup(second.id)).toMatchObject({ cleanup_status: "pending" });

    const removedReactions: any[] = [];
    expect(await scheduleTurnReactionCleanup({
      reactions: {
        remove: async (input: any) => {
          removedReactions.push(input);
          return { ok: true };
        },
      },
    }, second.id)).toBe("delivered");
    expect(removedReactions).toEqual([{
      channel: "C1",
      timestamp: "210.000002",
      name: "hourglass_flowing_sand",
    }]);
    expect(getTurnReactionCleanup(second.id)).toMatchObject({ cleanup_status: "delivered" });
  });
});
