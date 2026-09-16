import { createHash, randomUUID } from "node:crypto";
import {
  sharedCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { codexHistoryMessages } from "./provider-history";
import { projectSessionProviderMessage } from "./session-projection";
import { recordSessionEvent } from "./session-inputs";
import { disconnectCodexLifecycle, observeCodexLifecycle } from "./codex-session-lifecycle";
import {
  getConciergeProviderTurn,
  getUniqueCodexSessionBinding,
  listUniqueCodexSessionBindings,
} from "./state";

const OBSERVATION_RETRY_MS = 100;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class CodexSessionObserver {
  private stopped = false;
  private connectionLoop: Promise<void> | null = null;
  private notificationLoop: Promise<void> = Promise.resolve();
  private readonly stoppedSignal: Promise<void>;
  private resolveStoppedSignal!: () => void;
  private readonly subscribedThreadIds = new Set<string>();
  private readonly pendingThreadSubscriptions = new Map<string, Promise<void>>();
  private readonly appServer: CodexAppServerClientLike;
  private readonly lifecycleVersions = new Map<string, number>();

  constructor(options: { appServer?: CodexAppServerClientLike } = {}) {
    this.appServer = options.appServer ?? sharedCodexAppServerClient();
    this.stoppedSignal = new Promise((resolve) => { this.resolveStoppedSignal = resolve; });
  }

  start() {
    if (this.connectionLoop) return;
    for (const binding of listUniqueCodexSessionBindings()) disconnectCodexLifecycle(binding.provider_thread_uuid);
    this.connectionLoop = this.runConnections();
  }

  providerSessionBound(providerThreadUuid: string) {
    if (this.stopped || this.subscribedThreadIds.has(providerThreadUuid)) return Promise.resolve();
    const pending = this.pendingThreadSubscriptions.get(providerThreadUuid);
    if (pending) return pending;
    const subscription = this.subscribeBoundProviderSession(providerThreadUuid).finally(() => {
      if (this.pendingThreadSubscriptions.get(providerThreadUuid) === subscription) {
        this.pendingThreadSubscriptions.delete(providerThreadUuid);
      }
    });
    this.pendingThreadSubscriptions.set(providerThreadUuid, subscription);
    return subscription;
  }

  async stop() {
    this.stopped = true;
    this.resolveStoppedSignal();
    await Promise.allSettled([
      this.connectionLoop,
      this.notificationLoop,
      ...this.pendingThreadSubscriptions.values(),
    ].filter(Boolean) as Promise<void>[]);
  }

  private async runConnections() {
    let retryMs = 1_000;
    while (!this.stopped) {
      let generation: number | null = null;
      const unsubscribe = this.appServer.onNotification((event) => this.queueNotification(event));
      try {
        generation = await this.appServer.connect();
        if (!await this.subscribeCurrentBindings(this.appServer, generation)) continue;
        retryMs = 1_000;
        await Promise.race([this.appServer.waitForDisconnect(generation), this.stoppedSignal]);
      } catch (error) {
        if (!this.stopped) log("warn", "codex_session_observer_disconnected", errorFields(error));
      } finally {
        unsubscribe();
        await this.notificationLoop;
        for (const threadId of this.subscribedThreadIds) disconnectCodexLifecycle(threadId);
        this.subscribedThreadIds.clear();
      }
      if (!this.stopped) {
        await Promise.race([wait(retryMs), this.stoppedSignal]);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }

  private async subscribeCurrentBindings(connection: CodexAppServerClientLike, generation: number) {
    for (const binding of listUniqueCodexSessionBindings()) {
      if (await connection.connect() !== generation) return false;
      try {
        await connection.request("thread/resume", {
          threadId: binding.provider_thread_uuid,
          excludeTurns: true,
        });
        this.subscribedThreadIds.add(binding.provider_thread_uuid);
        await this.queueLifecycleRefresh(binding.provider_thread_uuid);
        this.invalidateHistory(binding.session_id, binding.provider_thread_uuid);
        log("info", "codex_session_thread_subscribed", {
          provider_thread_uuid: binding.provider_thread_uuid,
          session_id: binding.session_id,
        });
      } catch (error) {
        if (await connection.connect() !== generation) return false;
        log("warn", "codex_session_thread_subscription_failed", {
          ...errorFields(error),
          provider_thread_uuid: binding.provider_thread_uuid,
          session_id: binding.session_id,
        });
      }
      if (await connection.connect() !== generation) return false;
    }
    return true;
  }

  private async subscribeBoundProviderSession(providerThreadUuid: string) {
    const binding = getUniqueCodexSessionBinding(providerThreadUuid);
    if (!binding) return;
    const generation = await this.appServer.connect();
    if (this.stopped || await this.appServer.connect() !== generation) {
      throw new Error("The provider observer connection changed while subscribing a newly bound session.");
    }
    await this.appServer.request("thread/resume", { threadId: providerThreadUuid, excludeTurns: true });
    if (this.stopped || await this.appServer.connect() !== generation) {
      throw new Error("The provider observer connection changed after subscribing a newly bound session.");
    }
    this.subscribedThreadIds.add(providerThreadUuid);
    await this.queueLifecycleRefresh(providerThreadUuid);
    this.invalidateHistory(binding.session_id, providerThreadUuid);
    log("info", "codex_session_thread_subscribed", {
      provider_thread_uuid: providerThreadUuid,
      session_id: binding.session_id,
      trigger: "provider_session_bound",
    });
  }

  private invalidateHistory(sessionId: number, providerThreadUuid: string) {
    recordSessionEvent({
      eventId: `provider-history:${sessionId}:${randomUUID()}`,
      sessionId,
      kind: "history",
      payload: { providerThreadUuid },
    });
  }

  private queueNotification(event: any) {
    if (event.method === "thread/started" && typeof event.params?.thread?.id === "string") {
      void this.providerSessionBound(event.params.thread.id).catch(() => {
        log("warn", "codex_session_lifecycle_subscription_failed", { provider_thread_uuid: event.params.thread.id });
      });
    }
    if (["turn/started", "turn/completed", "thread/status/changed", "thread/closed"].includes(event.method)) {
      const threadId = event.params?.threadId;
      if (typeof threadId === "string") this.lifecycleVersions.set(threadId, (this.lifecycleVersions.get(threadId) ?? 0) + 1);
    }
    this.notificationLoop = this.notificationLoop
      .then(() => this.persistNotification(event))
      .catch((error) => log("error", "codex_session_notification_failed", errorFields(error)));
  }

  private async persistNotification(event: any) {
    let failures = 0;
    while (!this.stopped) {
      try {
        await this.onNotification(event);
        return;
      } catch {
        failures += 1;
        log("error", "codex_session_notification_persistence_failed", {
          provider_thread_uuid: typeof event.params?.threadId === "string" ? event.params.threadId : null,
          provider_turn_id: event.params?.turnId ?? event.params?.turn?.id ?? null,
          failures,
        });
        await Promise.race([wait(Math.min(OBSERVATION_RETRY_MS * 2 ** Math.min(failures - 1, 6), 5_000)), this.stoppedSignal]);
      }
    }
  }

  private async onNotification(event: any) {
    const threadId = event.params?.threadId;
    if (typeof threadId === "string" && getUniqueCodexSessionBinding(threadId)) {
      if (["turn/started", "turn/completed"].includes(event.method)) {
        observeCodexLifecycle(threadId, event.params.turn, event.method);
        if (event.method === "turn/completed") this.invalidateHistory(getUniqueCodexSessionBinding(threadId)!.session_id, threadId);
        return;
      }
      if (event.method === "thread/status/changed") {
        await this.refreshLifecycle(threadId);
        return;
      }
      if (event.method === "thread/closed") {
        disconnectCodexLifecycle(threadId);
        this.subscribedThreadIds.delete(threadId);
        return;
      }
      if (event.method === "thread/compacted"
        || event.method === "item/started" && event.params.item?.type === "contextCompaction") {
        const binding = getUniqueCodexSessionBinding(threadId)!;
        recordSessionEvent({ eventId: `provider-compaction:${randomUUID()}`, sessionId: binding.session_id,
          kind: "provider-activity", payload: { providerThreadUuid: threadId,
            providerTurnId: event.params.turnId ?? null, activity: "compaction", source: event.method } });
        // Compaction is activity within a turn, never terminal evidence.
        this.invalidateHistory(binding.session_id, threadId);
        return;
      }
    }
    if (event.method !== "item/completed") return;
    const params = event.params || {};
    const item = params.item || {};
    if (typeof item.type !== "string" || typeof item.id !== "string" || !item.id
      || ["reasoning", "hookPrompt"].includes(item.type)) return;
    this.observeMessages(params);
  }

  private queueLifecycleRefresh(threadId: string) {
    this.notificationLoop = this.notificationLoop.then(() => this.refreshLifecycle(threadId));
    return this.notificationLoop;
  }

  private async refreshLifecycle(threadId: string) {
    const version = this.lifecycleVersions.get(threadId) ?? 0;
    let page: any, snapshot: any;
    try {
      [page, snapshot] = await Promise.all([
        this.appServer.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }),
        this.appServer.request("thread/read", { threadId, includeTurns: false }),
      ]);
    } catch {
      disconnectCodexLifecycle(threadId);
      log("warn", "codex_session_lifecycle_refresh_failed", { provider_thread_uuid: threadId });
      return;
    }
    // Notifications received during this read own newer evidence and are already queued.
    if (this.stopped || (this.lifecycleVersions.get(threadId) ?? 0) !== version) return;
    observeCodexLifecycle(threadId, page.data?.[0], "thread/snapshot", snapshot.thread?.status?.type);
  }

  private observeMessages(params: any) {
    const providerThreadUuid = String(params.threadId || "");
    const providerTurnId = String(params.turnId || "");
    const binding = getUniqueCodexSessionBinding(providerThreadUuid);
    if (!binding || !providerTurnId) return;
    const messages = codexHistoryMessages(params.item || {}, providerTurnId, providerThreadUuid);
    const turn = getConciergeProviderTurn(providerThreadUuid, providerTurnId);
    for (const message of messages) {
      if (turn?.session_id === binding.session_id) {
        projectSessionProviderMessage(turn.id, message);
        continue;
      }
      const payload = { message };
      const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      recordSessionEvent({
        eventId: `provider-message:${binding.session_id}:${digest}`,
        sessionId: binding.session_id,
        kind: "message",
        payload,
      });
    }
  }
}
