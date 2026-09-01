import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  executeForkRequest,
  forkRequestResultMessage,
  forkSourceExcerpt,
  isInlineForkAction,
  waitForForkBinding,
} from "../src/fork-requests";
import { providers } from "../src/providers";
import {
  claimForkRequest,
  beginForkRequest,
  claimForkRequestBinding,
  claimForkRequestDelivery,
  completeForkRequestDelivery,
  createOrGetSession,
  db,
  getForkRequest,
  getSession,
  getSessionByUuid,
  markForkRequestAnchorPosted,
  markForkRequestCreated,
  upsertSession,
} from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

let releaseDatabaseTestLock: (() => void) | null = null;
let originalFork: typeof providers.codex.fork;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  originalFork = providers.codex.fork;
  db.query("DELETE FROM fork_requests").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM process_instances").run();
  db.query("DELETE FROM channels").run();
});

afterEach(() => {
  providers.codex.fork = originalFork;
  db.query("DELETE FROM fork_requests").run();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

describe("fork request execution", () => {
  test("recognizes only the argument-free bang fork action", () => {
    expect(isInlineForkAction("!fork")).toBeTrue();
    expect(isInlineForkAction("  !FoRk \n")).toBeTrue();
    expect(isInlineForkAction("/fork")).toBeFalse();
    expect(isInlineForkAction("!fork from here")).toBeFalse();
  });

  test("bounds source excerpts without splitting Unicode characters", () => {
    const source = `${"a".repeat(318)}🧭tail`;

    expect(forkSourceExcerpt(source)).toBe(`${"a".repeat(318)}🧭…`);
  });

  test("holds ingress from Slack anchor creation through durable child binding", async () => {
    upsertSession("C1", "50.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "50.000001", "codex");
    claimForkRequest({
      requestId: "delivery-binding-barrier",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    beginForkRequest("delivery-binding-barrier", "owner-1");
    markForkRequestCreated("delivery-binding-barrier", "owner-1", "child-session");
    claimForkRequestDelivery("delivery-binding-barrier", "owner-1");

    let waits = 0;
    await waitForForkBinding({
      channelId: "C1",
      threadTs: "60.000001",
      wait: async () => {
        waits += 1;
        markForkRequestAnchorPosted("delivery-binding-barrier", "owner-1", "60.000001");
        claimForkRequestBinding("delivery-binding-barrier", "owner-1");
        completeForkRequestDelivery("delivery-binding-barrier", "owner-1");
      },
    });

    expect(waits).toBe(1);
    expect(getSessionByUuid("C1", "child-session")?.slack_thread_ts).toBe("60.000001");
  });

  test("holds ingress after Slack accepts an anchor whose response is lost", async () => {
    upsertSession("C1", "70.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "70.000001", "codex");
    const claim = claimForkRequest({
      requestId: "ambiguous-slack-delivery",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    providers.codex.fork = async () => ({
      text: "Fork created.",
      sessionUUID: "child-session",
      toolsUsed: [],
    });
    const postedClientIds: string[] = [];
    let firstPostAttempted!: () => void;
    const firstPost = new Promise<void>((resolve) => { firstPostAttempted = resolve; });
    const client = {
      chat: {
        postMessage: async (args: any) => {
          postedClientIds.push(args.client_msg_id);
          if (postedClientIds.length === 1) {
            firstPostAttempted();
            const error: any = new Error("socket hang up after Slack accepted the message");
            error.code = "slack_webapi_request_error";
            throw error;
          }
          return { ok: true, ts: "80.000001" };
        },
      },
    };

    const execution = executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
    });
    await firstPost;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (getForkRequest(claim.row.request_id)?.status === "forked") break;
      await Bun.sleep(1);
    }
    expect(getForkRequest(claim.row.request_id)?.status).toBe("forked");

    let replyPassedBarrier = false;
    const routedReply = waitForForkBinding({
      channelId: "C1",
      threadTs: "80.000001",
      timeoutMs: 2_000,
    }).then(() => {
      replyPassedBarrier = true;
      return createOrGetSession("C1", "80.000001", "codex");
    });
    await Bun.sleep(10);
    expect(replyPassedBarrier).toBe(false);

    const result = await execution;
    const replySession = await routedReply;

    expect(result.status).toBe("delivered");
    expect(postedClientIds).toEqual([
      claim.row.slack_client_msg_id,
      claim.row.slack_client_msg_id,
    ]);
    expect(replySession.agent_session_uuid).toBe("child-session");
  });

  test("persists the provider child and creates a new top-level Slack thread with stable identities", async () => {
    upsertSession("C1", "100.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "100.000001", "codex");
    const claim = claimForkRequest({
      requestId: "shortcut-trigger",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      sourceMessageTs: "100.000003",
      sourceMessageExcerpt: forkSourceExcerpt("Implement readable <fork> breadcrumbs & link to the source."),
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      lastProviderTurnId: "turn-selected",
      cwd: "/tmp/project",
      additionalDirs: ["/tmp/shared"],
    });
    let forkInput: any;
    providers.codex.fork = async (input) => {
      forkInput = input;
      return {
        text: "Fork created.",
        sessionUUID: "child-session",
        toolsUsed: [],
        providerTurnId: null,
      };
    };
    let posted: any;
    const client = {
      chat: {
        postMessage: async (args: any) => {
          posted = args;
          const durable = getForkRequest(claim.row.request_id);
          expect(durable?.status).toBe("delivering");
          expect(durable?.forked_provider_session_uuid).toBe("child-session");
          return { ok: true, ts: "200.000001" };
        },
      },
    };

    const result = await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
    });

    expect(forkInput.lastTurnId).toBe("turn-selected");
    expect(forkInput.threadSource).toBe(claim.row.provider_request_key);
    expect(posted.thread_ts).toBeUndefined();
    expect(posted.client_msg_id).toBe(claim.row.slack_client_msg_id);
    expect(posted.text).toBe([
      "Forked Codex from <https://slack.com/archives/C1/p100000003|this source message>:",
      "> Implement readable &lt;fork&gt; breadcrumbs &amp; link to the source.",
      "Reply in this new thread to continue the fork.",
    ].join("\n"));
    expect(result.status).toBe("delivered");
    expect(result.slack_message_ts).toBe("200.000001");
    expect(forkRequestResultMessage(result)).toBe(
      "Fork created: <https://slack.com/archives/C1/p200000001|open the new thread>.",
    );
    expect(getSessionByUuid("C1", "child-session")?.slack_thread_ts).toBe("200.000001");
  });

  test("describes a whole-session fork without exposing its provider session id", async () => {
    upsertSession("C1", "700.000001", "codex", "private-provider-session", { status: "idle" });
    const source = getSession("C1", "700.000001", "codex");
    const claim = claimForkRequest({
      requestId: "whole-session-anchor",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "private-provider-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    providers.codex.fork = async () => ({
      text: "Fork created.",
      sessionUUID: "child-session",
      toolsUsed: [],
    });
    let postedText = "";
    const client = {
      chat: {
        postMessage: async (args: any) => {
          postedText = args.text;
          return { ok: true, ts: "800.000001" };
        },
      },
    };

    expect((await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
    })).status).toBe("delivered");
    expect(postedText).toBe(
      "Forked Codex from the latest complete session. Reply in this new thread to continue the fork.",
    );
    expect(postedText).not.toContain("private-provider-session");
  });

  test("concurrent duplicate Slack callbacks lease one provider fork", async () => {
    upsertSession("C1", "300.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "300.000001", "codex");
    const claim = claimForkRequest({
      requestId: "duplicate-trigger",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      sourceMessageTs: "300.000002",
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      lastProviderTurnId: "turn-selected",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    let providerCalls = 0;
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseProvider = resolve; });
    providers.codex.fork = async () => {
      providerCalls += 1;
      providerStarted();
      await blocked;
      return { text: "Fork created.", sessionUUID: "child-session", toolsUsed: [] };
    };
    let posts = 0;
    const client = {
      chat: {
        postMessage: async () => {
          posts += 1;
          return { ok: true, ts: "400.000001" };
        },
      },
    };

    const first = executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
    });
    await started;
    const duplicate = await executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
    });
    expect(duplicate.status).toBe("forking");
    releaseProvider();
    expect((await first).status).toBe("delivered");
    expect(providerCalls).toBe(1);
    expect(posts).toBe(1);
  });

  test("does not classify SQLite completion failure as permanent Slack rejection", async () => {
    upsertSession("C1", "500.000001", "codex", "source-session", { status: "idle" });
    const source = getSession("C1", "500.000001", "codex");
    const claim = claimForkRequest({
      requestId: "persistence-race",
      channelId: "C1",
      requestedBy: "U1",
      sourceSessionId: source.id,
      providerId: "codex",
      sourceProviderSessionUUID: "source-session",
      cwd: "/tmp/project",
      additionalDirs: [],
    });
    providers.codex.fork = async () => ({
      text: "Fork created.",
      sessionUUID: "child-session",
      toolsUsed: [],
    });
    const postedClientIds: string[] = [];
    const client = {
      chat: {
        postMessage: async (args: any) => {
          postedClientIds.push(args.client_msg_id);
          return { ok: true, ts: "600.000001" };
        },
      },
    };
    let completionAttempts = 0;
    let bindingObserved!: () => void;
    const observedBinding = new Promise<void>((resolve) => { bindingObserved = resolve; });
    const execution = executeForkRequest({
      requestId: claim.row.request_id,
      client,
      instanceId: "owner-1",
      completeDelivery: (requestId, ownerInstanceId) => {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          bindingObserved();
          throw new Error("simulated non-Slack persistence failure");
        }
        return completeForkRequestDelivery(requestId, ownerInstanceId);
      },
    });
    await observedBinding;
    let replyPassedBinding = false;
    const routedReply = waitForForkBinding({
      channelId: "C1",
      threadTs: "600.000001",
    }).then(() => {
      replyPassedBinding = true;
      return createOrGetSession("C1", "600.000001", "codex");
    });
    await Bun.sleep(10);
    expect(replyPassedBinding).toBe(false);

    const result = await execution;
    const replySession = await routedReply;

    expect(result.status).toBe("delivered");
    expect(completionAttempts).toBe(2);
    expect(postedClientIds).toEqual([claim.row.slack_client_msg_id]);
    expect(replySession.agent_session_uuid).toBe("child-session");
    expect(getSessionByUuid("C1", "child-session")?.id).toBe(replySession.id);
  });
});
