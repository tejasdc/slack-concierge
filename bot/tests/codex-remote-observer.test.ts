import { afterAll, describe, expect, test } from "bun:test";
import {
  CodexRemoteObserver,
  codexRemoteAgentText,
  codexRemoteChannelAllowed,
  codexRemoteUserText,
  deliverCodexRemoteMirrorEvent,
} from "../src/codex-remote-observer";
import { assertProviderHistoryReplayable } from "../src/provider-replay";
import {
  db,
  claimCodexRemoteMirrorEvent,
  codexRemoteMirrorEventMappingValid,
  getCodexRemoteTurnMapping,
  getUniqueCodexSessionMapping,
  isCodexRemoteTurn,
  listUniqueCodexSessionMappings,
  markCodexRemoteMirrorDelivered,
  observeCodexRemoteMirrorEvent as persistCodexRemoteMirrorEvent,
  parkCodexRemoteMirrorEvent,
  recoverCodexRemoteMirrorClaims,
  retryCodexRemoteMirrorEvent,
  providerThreadHasCodexRemoteInput,
  getSlackThreadStatus,
  getSession,
  setSessionStatus,
  upsertChannel,
  upsertSession,
} from "../src/state";

function mappingFor(providerThreadUuid: string, slackChannelId: string, slackThreadTs: string) {
  upsertChannel({
    slack_channel_id: slackChannelId,
    slack_channel_name: slackChannelId.toLowerCase(),
    group_name: null,
    name: slackChannelId,
    vault_path: "/tmp",
    code_path: "/tmp",
  });
  upsertSession(slackChannelId, slackThreadTs, "codex", providerThreadUuid);
  const session = getSession(slackChannelId, slackThreadTs, "codex");
  if (!session) throw new Error("test session was not created");
  return {
    session_id: session.id,
    provider_thread_uuid: providerThreadUuid,
    provider_binding_token: null,
    project_path: "/tmp",
    slack_channel_id: slackChannelId,
    slack_channel_name: slackChannelId.toLowerCase(),
    slack_thread_ts: slackThreadTs,
  };
}

function observeCodexRemoteMirrorEvent(input: Parameters<typeof persistCodexRemoteMirrorEvent>[0]) {
  if (input.authorizingSessionId) return persistCodexRemoteMirrorEvent(input);
  const mapping = mappingFor(input.providerThreadUuid, input.slackChannelId, input.slackThreadTs);
  return persistCodexRemoteMirrorEvent({ ...input, authorizingSessionId: mapping.session_id });
}

afterAll(() => {
  db.query("DELETE FROM codex_remote_mirror_events").run();
  db.query("DELETE FROM codex_remote_turns").run();
  db.query("DELETE FROM codex_remote_observed_items").run();
  db.query("DELETE FROM codex_remote_subscriptions").run();
});

describe("Codex Remote observation", () => {
  test("excludes slack-inbox by default and supports explicit channel allowlists", () => {
    expect(codexRemoteChannelAllowed({ slack_channel_id: "C1", slack_channel_name: "slack-inbox" })).toBeFalse();
    expect(codexRemoteChannelAllowed({ slack_channel_id: "C2", slack_channel_name: "concierge" })).toBeTrue();
    expect(codexRemoteChannelAllowed(
      { slack_channel_id: "C2", slack_channel_name: "concierge" },
      "other,C2",
      "slack-inbox",
    )).toBeTrue();
    expect(codexRemoteChannelAllowed(
      { slack_channel_id: "C2", slack_channel_name: "concierge" },
      "other",
      "slack-inbox",
    )).toBeFalse();
  });

  test("returns only active provider threads with one unambiguous Slack mapping", () => {
    const suffix = String(Date.now());
    for (const [channelId, channelName] of [[`C_REMOTE_A_${suffix}`, "remote-a"], [`C_REMOTE_B_${suffix}`, "remote-b"]]) {
      upsertChannel({
        slack_channel_id: channelId,
        slack_channel_name: channelName,
        group_name: null,
        name: channelName,
        vault_path: "/tmp",
        code_path: "/tmp",
      });
    }
    upsertSession(`C_REMOTE_A_${suffix}`, "1.1", "codex", `unique-${suffix}`);
    upsertSession(`C_REMOTE_A_${suffix}`, "1.2", "codex", `duplicate-${suffix}`);
    upsertSession(`C_REMOTE_B_${suffix}`, "2.1", "codex", `duplicate-${suffix}`);
    upsertSession(`C_REMOTE_B_${suffix}`, "2.2", "codex", `archived-${suffix}`);
    const archived = getSession(`C_REMOTE_B_${suffix}`, "2.2", "codex")!;
    setSessionStatus(archived.id, "archived");

    const mappings = listUniqueCodexSessionMappings();
    expect(mappings.some((mapping) => mapping.provider_thread_uuid === `unique-${suffix}`)).toBeTrue();
    expect(mappings.some((mapping) => mapping.provider_thread_uuid === `duplicate-${suffix}`)).toBeFalse();
    expect(mappings.some((mapping) => mapping.provider_thread_uuid === `archived-${suffix}`)).toBeFalse();
    expect(getUniqueCodexSessionMapping(`unique-${suffix}`)?.slack_thread_ts).toBe("1.1");
    expect(getUniqueCodexSessionMapping(`duplicate-${suffix}`)).toBeNull();
    expect(getUniqueCodexSessionMapping(`archived-${suffix}`)).toBeNull();
  });

  test("does no recurring history or delivery work while a healthy connection is idle", async () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`idle-${suffix}`, `C_IDLE_${suffix}`, "0.0");
    const requests: string[] = [];
    let listener: ((event: any) => void) | null = null;
    let mappingListCalls = 0;
    let targetedMappingCalls = 0;
    let deliveryClaimCalls = 0;
    const fakeAppServer = {
      connect: async () => 1,
      request: async (method: string) => {
        requests.push(method);
        return { thread: { id: mapping.provider_thread_uuid } };
      },
      notify: async () => {},
      onNotification: (candidate: (event: any) => void) => {
        listener = candidate;
        return () => { listener = null; return true; };
      },
      onDisconnect: () => () => false,
      waitForDisconnect: () => new Promise<void>(() => {}),
    };
    const observer = new CodexRemoteObserver({}, undefined, {
      appServer: fakeAppServer,
      listMappings: () => {
        mappingListCalls += 1;
        return [mapping];
      },
      getMapping: () => {
        targetedMappingCalls += 1;
        return mapping;
      },
      observeMirrorEvent: () => false,
      claimMirrorEvent: () => {
        deliveryClaimCalls += 1;
        return null;
      },
      getNextMirrorAttemptMs: () => null,
    });

    observer.start();
    await Bun.sleep(20);
    expect(requests).toEqual(["thread/resume"]);
    expect(mappingListCalls).toBe(1);
    const claimsAfterStartup = deliveryClaimCalls;
    await Bun.sleep(20);
    await Bun.sleep(20);
    expect(requests).toEqual(["thread/resume"]);
    expect(mappingListCalls).toBe(1);
    expect(deliveryClaimCalls).toBe(claimsAfterStartup);

    listener?.({
      method: "item/completed",
      params: {
        threadId: mapping.provider_thread_uuid,
        turnId: "remote-idle-turn",
        item: {
          id: "remote-idle-user",
          type: "userMessage",
          clientId: "codex-mobile",
          content: [{ type: "text", text: "Wake once" }],
        },
      },
    });
    await (observer as any).notificationLoop;
    expect(targetedMappingCalls).toBe(1);
    expect(mappingListCalls).toBe(1);
    expect(requests).not.toContain("thread/read");
    await observer.stop();
  });

  test("subscribes a newly bound broker session from the binding event without polling", async () => {
    const suffix = String(Date.now());
    const baseMapping = mappingFor(`bound-${suffix}`, `C_BOUND_${suffix}`, "0.05");
    const mapping = {
      ...baseMapping,
      provider_binding_token: "binding-token",
      project_path: "/srv/projects/bound",
    };
    const requests: string[] = [];
    let refreshes = 0;
    const fakeAppServer = {
      connect: async () => 7,
      request: async (method: string) => {
        requests.push(method);
        return { thread: { id: mapping.provider_thread_uuid } };
      },
      notify: async () => {},
      onNotification: () => () => false,
      onDisconnect: () => () => false,
      waitForDisconnect: () => new Promise<void>(() => {}),
      refreshProjectSubscriptions: async () => { refreshes += 1; },
    };
    const observer = new CodexRemoteObserver({}, undefined, {
      appServer: fakeAppServer,
      listMappings: () => [mapping],
    });

    await Promise.all([
      observer.providerSessionBound(mapping.provider_thread_uuid),
      observer.providerSessionBound(mapping.provider_thread_uuid),
    ]);
    await observer.providerSessionBound(mapping.provider_thread_uuid);

    expect(refreshes).toBe(1);
    expect(requests).toEqual(["thread/resume"]);
  });

  test("persists pushed items directly and retries the same item after a transient write failure", async () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`live-first-${suffix}`, `C_LIVE_FIRST_${suffix}`, "0.1");
    const pushedItem = {
      id: "live-guidance",
      type: "userMessage",
      clientId: `codex-remote:${suffix}`,
      content: [{ type: "text", text: "Use the mobile guidance" }],
    };
    let observationAttempts = 0;
    const observer = new CodexRemoteObserver({}, undefined, {
      listMappings: () => [mapping],
      getMapping: () => mapping,
      waitBeforeObservationRetry: async () => {},
      observeMirrorEvent: (input) => {
        observationAttempts += 1;
        if (observationAttempts === 1) throw new Error("sqlite busy");
        return observeCodexRemoteMirrorEvent(input);
      },
    });

    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: mapping.provider_thread_uuid,
        turnId: "remote-turn",
        item: pushedItem,
      },
    });
    expect(observationAttempts).toBe(2);
    const event = claimCodexRemoteMirrorEvent();
    expect(event).toMatchObject({
      provider_thread_uuid: mapping.provider_thread_uuid,
      provider_turn_id: "remote-turn",
      provider_item_id: "live-guidance",
      item_kind: "user",
      payload_text: "Use the mobile guidance",
    });
    expect(markCodexRemoteMirrorDelivered(
      mapping.provider_thread_uuid,
      "live-guidance",
      "slack-guidance",
    )).toBeTrue();
  });

  test("uses pushed item identities and binds a remote turn to its first destination", async () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`identity-${suffix}`, `C_IDENTITY_${suffix}`, "0.2");
    const legacyCounts = {
      subscriptions: Number((db.query("SELECT COUNT(*) AS count FROM codex_remote_subscriptions").get() as any).count),
      observedItems: Number((db.query("SELECT COUNT(*) AS count FROM codex_remote_observed_items").get() as any).count),
    };
    const observer = new CodexRemoteObserver({}, undefined, {
      listMappings: () => [mapping],
      getMapping: () => mapping,
    });

    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: mapping.provider_thread_uuid,
        turnId: "remote-turn",
        item: {
          id: "live-user-id",
          type: "userMessage",
          clientId: `codex-remote:${suffix}`,
          content: [{ type: "text", text: "Continue from Codex Remote" }],
        },
      },
    });
    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: mapping.provider_thread_uuid,
        turnId: "remote-turn",
        item: {
          id: "live-agent-id",
          type: "agentMessage",
          phase: "final_answer",
          text: "Finished once",
        },
      },
    });

    const mirrored = db.query(`
      SELECT provider_item_id, item_kind
      FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=?
      ORDER BY observation_sequence
    `).all(mapping.provider_thread_uuid);
    expect(mirrored).toEqual([
      { provider_item_id: "live-user-id", item_kind: "user" },
      { provider_item_id: "live-agent-id", item_kind: "agent" },
    ]);
    expect(getCodexRemoteTurnMapping(mapping.provider_thread_uuid, "remote-turn")).toEqual(mapping);
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("live-user-id");
    expect(markCodexRemoteMirrorDelivered(
      mapping.provider_thread_uuid,
      "live-user-id",
      "slack-user",
    )).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("live-agent-id");
    expect(markCodexRemoteMirrorDelivered(
      mapping.provider_thread_uuid,
      "live-agent-id",
      "slack-agent",
    )).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM codex_remote_subscriptions").get()).toEqual({
      count: legacyCounts.subscriptions,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM codex_remote_observed_items").get()).toEqual({
      count: legacyCounts.observedItems,
    });
  });

  test("delivers each pushed item idempotently without a history baseline", () => {
    const suffix = String(Date.now());
    const threadId = `thread-${suffix}`;
    const input = {
      providerThreadUuid: threadId,
      providerItemId: "new-item",
      providerTurnId: "turn-1",
      itemKind: "user" as const,
      payloadText: "Continue from mobile",
      slackChannelId: "C1",
      slackThreadTs: "1.1",
      clientMsgId: `client-${suffix}`,
      recordRemoteTurn: true,
    };
    expect(observeCodexRemoteMirrorEvent(input)).toBeTrue();
    expect(observeCodexRemoteMirrorEvent(input)).toBeFalse();
    expect(isCodexRemoteTurn(threadId, "turn-1")).toBeTrue();
    const claimed = claimCodexRemoteMirrorEvent();
    expect(claimed).toMatchObject({
      provider_thread_uuid: threadId,
      provider_item_id: "new-item",
      status: "sending",
      attempts: 1,
    });
    expect(markCodexRemoteMirrorDelivered(threadId, "new-item", "slack-1")).toBeTrue();
  });

  test("rolls back a turn binding when its durable mirror enqueue fails", () => {
    const suffix = String(Date.now());
    const threadId = `transaction-${suffix}`;
    const clientMsgId = `collision-${suffix}`;
    expect(observeCodexRemoteMirrorEvent({
      providerThreadUuid: threadId,
      providerItemId: "first-item",
      providerTurnId: "first-turn",
      itemKind: "user",
      payloadText: "First",
      slackChannelId: "C1",
      slackThreadTs: "1.1",
      clientMsgId,
    })).toBeTrue();

    expect(() => observeCodexRemoteMirrorEvent({
      providerThreadUuid: threadId,
      providerItemId: "second-item",
      providerTurnId: "second-turn",
      itemKind: "user",
      payloadText: "Second",
      slackChannelId: "C1",
      slackThreadTs: "1.1",
      clientMsgId,
      recordRemoteTurn: true,
    })).toThrow();
    expect(isCodexRemoteTurn(threadId, "second-turn")).toBeFalse();
    expect(db.query(`
      SELECT 1 FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id='second-item'
    `).get(threadId)).toBeNull();
    const claimed = claimCodexRemoteMirrorEvent();
    expect(claimed?.provider_item_id).toBe("first-item");
    expect(markCodexRemoteMirrorDelivered(threadId, "first-item", "slack-first")).toBeTrue();
  });

  test("delivers a remote user request before its final answer regardless of item id ordering", () => {
    const suffix = String(Date.now());
    const threadId = `ordered-${suffix}`;
    for (const [providerItemId, itemKind] of [["z-user", "user"], ["a-agent", "agent"]] as const) {
      expect(observeCodexRemoteMirrorEvent({
        providerThreadUuid: threadId,
        providerItemId,
        providerTurnId: "turn-ordered",
        itemKind,
        payloadText: providerItemId,
        slackChannelId: "C1",
        slackThreadTs: "1.1",
        clientMsgId: `${providerItemId}-${suffix}`,
      })).toBeTrue();
    }
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("z-user");
    expect(markCodexRemoteMirrorDelivered(threadId, "z-user", "slack-user")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("a-agent");
    expect(markCodexRemoteMirrorDelivered(threadId, "a-agent", "slack-agent")).toBeTrue();
  });

  test("does not let an answer overtake a retried request while unrelated Slack threads continue", () => {
    const suffix = String(Date.now());
    const threadId = `retry-ordered-${suffix}`;
    for (const [providerItemId, itemKind] of [["request", "user"], ["answer", "agent"]] as const) {
      observeCodexRemoteMirrorEvent({
        providerThreadUuid: threadId,
        providerItemId,
        providerTurnId: "turn-retry",
        itemKind,
        payloadText: providerItemId,
        slackChannelId: "C_RETRY",
        slackThreadTs: "1.1",
        clientMsgId: `${providerItemId}-${suffix}`,
      });
    }
    observeCodexRemoteMirrorEvent({
      providerThreadUuid: `unrelated-${suffix}`,
      providerItemId: "unrelated-request",
      providerTurnId: "turn-unrelated",
      itemKind: "user",
      payloadText: "unrelated",
      slackChannelId: "C_OTHER",
      slackThreadTs: "2.2",
      clientMsgId: `unrelated-${suffix}`,
    });

    expect(claimCodexRemoteMirrorEvent(1)?.provider_item_id).toBe("request");
    expect(retryCodexRemoteMirrorEvent(threadId, "request", "temporary", 60_000)).toBeTrue();
    expect(claimCodexRemoteMirrorEvent(1)?.provider_item_id).toBe("unrelated-request");
    expect(markCodexRemoteMirrorDelivered(`unrelated-${suffix}`, "unrelated-request", "slack-other")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent(1)).toBeNull();
    expect(claimCodexRemoteMirrorEvent(60_000)?.provider_item_id).toBe("request");
    expect(markCodexRemoteMirrorDelivered(threadId, "request", "slack-request")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent(60_000)?.provider_item_id).toBe("answer");
    expect(markCodexRemoteMirrorDelivered(threadId, "answer", "slack-answer")).toBeTrue();
  });

  test("parks downstream events in the same Slack thread after an earlier permanent failure", () => {
    const suffix = String(Date.now());
    const threadId = `park-ordered-${suffix}`;
    for (const [providerItemId, itemKind] of [["request", "user"], ["answer", "agent"]] as const) {
      observeCodexRemoteMirrorEvent({
        providerThreadUuid: threadId,
        providerItemId,
        providerTurnId: "turn-park",
        itemKind,
        payloadText: providerItemId,
        slackChannelId: "C_PARK",
        slackThreadTs: "3.3",
        clientMsgId: `${providerItemId}-park-${suffix}`,
      });
    }
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("request");
    expect(parkCodexRemoteMirrorEvent(threadId, "request", "permanent")).toBeTrue();
    const downstream = db.query(`
      SELECT status, error FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id='answer'
    `).get(threadId) as any;
    expect(downstream.status).toBe("parked");
    expect(downstream.error).toContain("earlier parked");
  });

  test("mirrors a TLDR without replacing the durable cumulative Slack summary", async () => {
    const suffix = String(Date.now());
    const threadId = `summary-${suffix}`;
    const channelId = `C_SUMMARY_${suffix}`;
    const mapping = mappingFor(threadId, channelId, "4.4");
    const reply = codexRemoteAgentText("Finished the mobile follow-up.");
    expect(reply).toStartWith("TL;DR: Finished the mobile follow-up.");
    persistCodexRemoteMirrorEvent({
      providerThreadUuid: threadId,
      providerItemId: "answer",
      providerTurnId: "turn-summary",
      authorizingSessionId: mapping.session_id,
      itemKind: "agent",
      payloadText: reply,
      slackChannelId: channelId,
      slackThreadTs: "4.4",
      clientMsgId: `summary-${suffix}`,
    });
    db.query(`
      INSERT INTO slack_thread_statuses (slack_channel_id, slack_thread_ts, thread_tldr)
      VALUES (?, ?, 'Prior cumulative Slack summary')
    `).run(channelId, "4.4");
    const event = claimCodexRemoteMirrorEvent();
    expect(event?.provider_item_id).toBe("answer");
    const delivered = await deliverCodexRemoteMirrorEvent(event!, {
      getMapping: () => mapping,
      postMessage: async () => ({ ts: "slack-answer" }),
    });
    expect(delivered).toEqual({ delivered: true, responseTldr: "Finished the mobile follow-up." });
    expect(getSlackThreadStatus(channelId, "4.4")?.thread_tldr).toBe("Prior cumulative Slack summary");
  });

  test("parks a queued mirror instead of posting after its channel is excluded", async () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`excluded-${suffix}`, `C_EXCLUDED_${suffix}`, "4.5");
    persistCodexRemoteMirrorEvent({
      providerThreadUuid: mapping.provider_thread_uuid,
      providerItemId: "queued-request",
      providerTurnId: "turn-excluded",
      authorizingSessionId: mapping.session_id,
      itemKind: "user",
      payloadText: "Do not post after exclusion",
      slackChannelId: mapping.slack_channel_id,
      slackThreadTs: mapping.slack_thread_ts,
      clientMsgId: `excluded-${suffix}`,
      recordRemoteTurn: true,
    });
    const event = claimCodexRemoteMirrorEvent()!;
    let postCalls = 0;
    const previousExclude = process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS;
    process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS = mapping.slack_channel_id;
    try {
      expect(await deliverCodexRemoteMirrorEvent(event, {
        getMapping: () => mapping,
        postMessage: async () => {
          postCalls += 1;
          return { ts: "must-not-post" };
        },
      })).toEqual({ delivered: false, responseTldr: null });
    } finally {
      if (previousExclude === undefined) delete process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS;
      else process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS = previousExclude;
    }
    expect(postCalls).toBe(0);
    expect(db.query(`
      SELECT status, error FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id='queued-request'
    `).get(mapping.provider_thread_uuid)).toMatchObject({
      status: "parked",
      error: expect.stringContaining("no longer eligible"),
    });
  });

  test("posts once while retrying the post-ack durable transition locally", async () => {
    const suffix = String(Date.now());
    const threadId = `post-ack-${suffix}`;
    observeCodexRemoteMirrorEvent({
      providerThreadUuid: threadId,
      providerItemId: "answer",
      providerTurnId: "turn-post-ack",
      itemKind: "agent",
      payloadText: "TL;DR: delivered once",
      slackChannelId: `C_POST_ACK_${suffix}`,
      slackThreadTs: "5.5",
      clientMsgId: `post-ack-${suffix}`,
    });
    const event = claimCodexRemoteMirrorEvent();
    expect(event).not.toBeNull();
    let postCalls = 0;
    let markCalls = 0;

    const delivery = await deliverCodexRemoteMirrorEvent(event!, {
      postMessage: async () => {
        postCalls += 1;
        return { ts: "slack-once" };
      },
      markDelivered: () => {
        markCalls += 1;
        if (markCalls === 1) throw new Error("sqlite temporarily unavailable");
        if (markCalls === 2) return false;
        return markCodexRemoteMirrorDelivered(threadId, "answer", "slack-once");
      },
      waitBeforeRetry: async () => {},
    });

    expect(delivery.delivered).toBeTrue();
    expect(postCalls).toBe(1);
    expect(markCalls).toBe(3);
    expect(markCodexRemoteMirrorDelivered(threadId, "answer", "slack-once")).toBeTrue();
  });

  test("recovers a restart between Slack acknowledgment and the local transition with the same client id", () => {
    const suffix = String(Date.now());
    const threadId = `restart-ack-${suffix}`;
    const stableClientId = `stable-client-${suffix}`;
    observeCodexRemoteMirrorEvent({
      providerThreadUuid: threadId,
      providerItemId: "request",
      providerTurnId: "turn-restart",
      itemKind: "user",
      payloadText: "Continue from the app",
      slackChannelId: `C_RESTART_${suffix}`,
      slackThreadTs: "6.6",
      clientMsgId: stableClientId,
    });
    expect(claimCodexRemoteMirrorEvent()?.client_msg_id).toBe(stableClientId);
    expect(recoverCodexRemoteMirrorClaims()).toBeGreaterThanOrEqual(1);
    const recovered = claimCodexRemoteMirrorEvent();
    expect(recovered?.client_msg_id).toBe(stableClientId);
    expect(markCodexRemoteMirrorDelivered(threadId, "request", "slack-deduplicated")).toBeTrue();
  });

  test("suppresses both initial and steering inputs sent by Concierge while mirroring external input", () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`namespace-${suffix}`, `C_NAMESPACE_${suffix}`, "7.7");
    const observer = new CodexRemoteObserver({}, undefined, { listMappings: () => [mapping] });
    for (const [id, clientId] of [
      ["initial", "slack-concierge:turn:42"],
      ["steering", "slack-concierge:steer:C1:123.4"],
    ]) {
      (observer as any).observeItem(mapping, "turn-local", {
        id,
        type: "userMessage",
        clientId,
        content: [{ type: "text", text: id }],
      });
    }
    (observer as any).observeItem(mapping, "turn-remote", {
      id: "external",
      type: "userMessage",
      clientId: "codex-mobile",
      content: [{ type: "text", text: "External guidance" }],
    });
    const event = claimCodexRemoteMirrorEvent();
    expect(event?.provider_item_id).toBe("external");
    expect(markCodexRemoteMirrorDelivered(mapping.provider_thread_uuid, "external", "slack-external")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()).toBeNull();
  });

  test("classifies and mirrors media-only, mixed-media, and future external input", () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`media-${suffix}`, `C_MEDIA_${suffix}`, "7.8");
    const observer = new CodexRemoteObserver({}, undefined, { listMappings: () => [mapping] });

    (observer as any).observeItem(mapping, "media-turn", {
      id: "image-only",
      type: "userMessage",
      clientId: "codex-mobile",
      content: [{ type: "image", url: "https://example.invalid/private-image" }],
    });
    (observer as any).observeItem(mapping, "media-turn", {
      id: "media-final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Reviewed the image",
    });
    const image = claimCodexRemoteMirrorEvent();
    expect(image).toMatchObject({
      provider_item_id: "image-only",
      payload_text: "[Image attached in Codex Remote]",
    });
    expect(providerThreadHasCodexRemoteInput(mapping.provider_thread_uuid)).toBeTrue();
    const mediaSession = { provider_id: "codex" as const, agent_session_uuid: mapping.provider_thread_uuid };
    expect(assertProviderHistoryReplayable.bind(null, mediaSession, "comparison")).toThrow("incomplete history");
    expect(assertProviderHistoryReplayable.bind(null, mediaSession, "fork")).toThrow("comparison and fork are disabled");
    expect(markCodexRemoteMirrorDelivered(mapping.provider_thread_uuid, "image-only", "slack-image")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()).toMatchObject({
      provider_item_id: "media-final",
      payload_text: expect.stringContaining("TL;DR: Reviewed the image"),
    });
    expect(markCodexRemoteMirrorDelivered(mapping.provider_thread_uuid, "media-final", "slack-final")).toBeTrue();

    expect(codexRemoteUserText({
      content: [
        { type: "text", text: "Inspect both attachments" },
        { type: "localImage", path: "/tmp/image.png" },
        { type: "audio", url: "https://example.invalid/private-audio" },
        { type: "skill", name: "visual-review", path: "/tmp/SKILL.md" },
        { type: "mention", name: "design-agent", path: "/tmp/AGENTS.md" },
        { type: "futureAttachment", secret: "not projected" },
      ],
    })).toBe([
      "Inspect both attachments",
      "[Image attached in Codex Remote]",
      "[Audio attached in Codex Remote]",
      "[Skill referenced in Codex Remote: visual-review]",
      "[Mention referenced in Codex Remote: design-agent]",
      "[Unsupported content referenced in Codex Remote: futureAttachment]",
    ].join("\n\n"));
  });

  test("keeps Remote provenance with the provider thread when sessions are rebound", () => {
    const suffix = String(Date.now());
    const providerThread = `provider-history-${suffix}`;
    const original = mappingFor(providerThread, `C_HISTORY_A_${suffix}`, "7.9");
    persistCodexRemoteMirrorEvent({
      providerThreadUuid: providerThread,
      providerItemId: "external-history",
      providerTurnId: "remote-history-turn",
      authorizingSessionId: original.session_id,
      itemKind: "user",
      payloadText: "External history",
      slackChannelId: original.slack_channel_id,
      slackThreadTs: original.slack_thread_ts,
      clientMsgId: `external-history-${suffix}`,
      recordRemoteTurn: true,
    });
    upsertSession(original.slack_channel_id, original.slack_thread_ts, "codex", `replacement-${suffix}`);
    const rebound = mappingFor(providerThread, `C_HISTORY_B_${suffix}`, "8.0");

    expect(providerThreadHasCodexRemoteInput(providerThread)).toBeTrue();
    expect(providerThreadHasCodexRemoteInput(`replacement-${suffix}`)).toBeFalse();
    const reboundSession = { provider_id: "codex" as const, agent_session_uuid: rebound.provider_thread_uuid };
    expect(assertProviderHistoryReplayable.bind(null, reboundSession, "comparison")).toThrow("incomplete history");
    expect(assertProviderHistoryReplayable.bind(null, reboundSession, "fork")).toThrow("comparison and fork are disabled");
    expect(claimCodexRemoteMirrorEvent()).toBeNull();
    expect(db.query(`
      SELECT status FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id='external-history'
    `).get(providerThread)).toEqual({ status: "parked" });
  });

  test("keeps a pushed final behind its user item during a transient write failure", async () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`transient-${suffix}`, `C_TRANSIENT_${suffix}`, "8.8");
    let failed = false;
    const observer = new CodexRemoteObserver({}, undefined, {
      listMappings: () => [mapping],
      waitBeforeObservationRetry: async () => {},
      observeMirrorEvent: (input) => {
        if (!failed && input.itemKind === "user") {
          failed = true;
          throw new Error("sqlite temporarily busy");
        }
        return persistCodexRemoteMirrorEvent(input);
      },
    });
    const user = {
      id: "remote-user",
      type: "userMessage",
      clientId: "codex-mobile",
      content: [{ type: "text", text: "Please continue" }],
    };
    const final = { id: "remote-final", type: "agentMessage", phase: "final_answer", text: "Finished" };
    (observer as any).queueNotification({
      method: "item/completed",
      params: { threadId: mapping.provider_thread_uuid, turnId: "remote-turn", item: user },
    });
    (observer as any).queueNotification({
      method: "item/completed",
      params: { threadId: mapping.provider_thread_uuid, turnId: "remote-turn", item: final },
    });
    await (observer as any).notificationLoop;
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("remote-user");
    expect(markCodexRemoteMirrorDelivered(mapping.provider_thread_uuid, "remote-user", "slack-user")).toBeTrue();
    expect(claimCodexRemoteMirrorEvent()?.provider_item_id).toBe("remote-final");
    expect(markCodexRemoteMirrorDelivered(mapping.provider_thread_uuid, "remote-final", "slack-final")).toBeTrue();
  });

  test("does not reroute a final when its remote turn is rebound between items", async () => {
    const suffix = String(Date.now());
    const providerThreadUuid = `split-${suffix}`;
    const original = mappingFor(providerThreadUuid, `C_SPLIT_A_${suffix}`, "9.0");
    const observer = new CodexRemoteObserver({}, undefined);

    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: providerThreadUuid,
        turnId: "remote-split-turn",
        item: {
          id: "remote-request",
          type: "userMessage",
          clientId: "codex-mobile",
          content: [{ type: "text", text: "Continue elsewhere" }],
        },
      },
    });
    upsertSession(original.slack_channel_id, original.slack_thread_ts, "codex", `replacement-${suffix}`);
    const rebound = mappingFor(providerThreadUuid, `C_SPLIT_B_${suffix}`, "9.01");
    expect(getUniqueCodexSessionMapping(providerThreadUuid)).toEqual(rebound);

    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: providerThreadUuid,
        turnId: "remote-split-turn",
        item: {
          id: "remote-follow-up",
          type: "userMessage",
          clientId: "codex-mobile",
          content: [{ type: "text", text: "More guidance after the rebind" }],
        },
      },
    });
    await (observer as any).onNotification({
      method: "item/completed",
      params: {
        threadId: providerThreadUuid,
        turnId: "remote-split-turn",
        item: {
          id: "remote-final",
          type: "agentMessage",
          phase: "final_answer",
          text: "Finished after the rebind",
        },
      },
    });

    expect(db.query(`
      SELECT provider_item_id, item_kind, slack_channel_id
      FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=?
      ORDER BY observation_sequence
    `).all(providerThreadUuid)).toEqual([{
      provider_item_id: "remote-request",
      item_kind: "user",
      slack_channel_id: original.slack_channel_id,
    }]);
    expect(claimCodexRemoteMirrorEvent()).toBeNull();
  });

  test("parks queued delivery when its once-unique session mapping becomes ambiguous", () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`ambiguous-${suffix}`, `C_AUTH_A_${suffix}`, "9.1");
    persistCodexRemoteMirrorEvent({
      providerThreadUuid: mapping.provider_thread_uuid,
      providerItemId: "request",
      providerTurnId: "turn",
      authorizingSessionId: mapping.session_id,
      itemKind: "user",
      payloadText: "Queued",
      slackChannelId: mapping.slack_channel_id,
      slackThreadTs: mapping.slack_thread_ts,
      clientMsgId: `ambiguous-${suffix}`,
      recordRemoteTurn: true,
    });
    mappingFor(mapping.provider_thread_uuid, `C_AUTH_B_${suffix}`, "9.2");
    expect(claimCodexRemoteMirrorEvent()).toBeNull();
    const parked = db.query(`
      SELECT status, error FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_item_id='request'
    `).get(mapping.provider_thread_uuid) as any;
    expect(parked.status).toBe("parked");
    expect(parked.error).toContain("unique authorized Slack destination");
  });

  test("revalidates the authorizing session again after a delivery claim", () => {
    const suffix = String(Date.now());
    const mapping = mappingFor(`rebind-${suffix}`, `C_REBIND_${suffix}`, "9.3");
    persistCodexRemoteMirrorEvent({
      providerThreadUuid: mapping.provider_thread_uuid,
      providerItemId: "request",
      providerTurnId: "turn",
      authorizingSessionId: mapping.session_id,
      itemKind: "user",
      payloadText: "Claimed",
      slackChannelId: mapping.slack_channel_id,
      slackThreadTs: mapping.slack_thread_ts,
      clientMsgId: `rebind-${suffix}`,
    });
    const event = claimCodexRemoteMirrorEvent()!;
    expect(codexRemoteMirrorEventMappingValid(event)).toBeTrue();
    upsertSession(mapping.slack_channel_id, mapping.slack_thread_ts, "codex", `replacement-${suffix}`);
    expect(codexRemoteMirrorEventMappingValid(event)).toBeFalse();
    expect(parkCodexRemoteMirrorEvent(event.provider_thread_uuid, event.provider_item_id, "mapping changed")).toBeTrue();
  });

  test("continues subscribing healthy mappings when one provider thread is stale", async () => {
    const suffix = String(Date.now());
    const stale = mappingFor(`stale-${suffix}`, `C_STALE_${suffix}`, "10.1");
    const healthy = mappingFor(`healthy-${suffix}`, `C_HEALTHY_${suffix}`, "10.2");
    const resumed: string[] = [];
    const connection: any = {
      request: async (method: string, params: any) => {
        if (method === "thread/resume" && params.threadId === stale.provider_thread_uuid) {
          throw new Error("thread not found");
        }
        if (method === "thread/resume") resumed.push(params.threadId);
        return { thread: { id: params.threadId } };
      },
    };
    const observer = new CodexRemoteObserver({}, undefined, { listMappings: () => [stale, healthy] });
    await (observer as any).subscribeCurrentMappings({ ...connection, connect: async () => 1 }, 1);
    expect(resumed).toEqual([healthy.provider_thread_uuid]);
  });

  test("restarts subscription enumeration when the App Server connection generation changes", async () => {
    const suffix = String(Date.now());
    const first = mappingFor(`generation-a-${suffix}`, `C_GENERATION_A_${suffix}`, "10.3");
    const second = mappingFor(`generation-b-${suffix}`, `C_GENERATION_B_${suffix}`, "10.4");
    let generation = 1;
    const resumed: Array<{ generation: number; threadId: string }> = [];
    const connection: any = {
      connect: async () => generation,
      request: async (_method: string, params: any) => {
        resumed.push({ generation, threadId: params.threadId });
        if (generation === 1) generation = 2;
        return { thread: { id: params.threadId } };
      },
    };
    const observer = new CodexRemoteObserver({}, undefined, { listMappings: () => [first, second] });

    expect(await (observer as any).subscribeCurrentMappings(connection, 1)).toBeFalse();
    expect(await (observer as any).subscribeCurrentMappings(connection, 2)).toBeTrue();
    expect(resumed).toEqual([
      { generation: 1, threadId: first.provider_thread_uuid },
      { generation: 2, threadId: first.provider_thread_uuid },
      { generation: 2, threadId: second.provider_thread_uuid },
    ]);
  });

  test("fails closed when a legacy remote turn has no authorization binding", async () => {
    const suffix = String(Date.now());
    const original = mappingFor(`unbound-${suffix}`, `C_UNBOUND_A_${suffix}`, "10.5");
    db.query(`
      INSERT INTO codex_remote_turns (
        provider_thread_uuid, provider_turn_id, authorizing_session_id,
        slack_channel_id, slack_thread_ts
      ) VALUES (?, ?, NULL, ?, ?)
    `).run(original.provider_thread_uuid, "legacy-unbound-turn", original.slack_channel_id, original.slack_thread_ts);
    db.query("UPDATE sessions SET agent_session_uuid=? WHERE id=?")
      .run(`replacement-${suffix}`, original.session_id);
    const current = mappingFor(original.provider_thread_uuid, `C_UNBOUND_B_${suffix}`, "10.6");
    const observer = new CodexRemoteObserver({}, undefined, { getMapping: () => current });

    expect((observer as any).observeItem(current, "legacy-unbound-turn", {
      id: "later-user-item",
      type: "userMessage",
      clientId: "codex-mobile",
      content: [{ type: "text", text: "Do not rebind this turn" }],
    })).toBeFalse();
    expect(db.query(`
      SELECT COUNT(*) AS count FROM codex_remote_mirror_events
      WHERE provider_thread_uuid=? AND provider_turn_id=?
    `).get(current.provider_thread_uuid, "legacy-unbound-turn")).toEqual({ count: 0 });
  });

});
