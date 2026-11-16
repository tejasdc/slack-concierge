import { createHash, randomUUID } from "node:crypto";
import {
  CodexAppServerClient,
  ownerCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { clearRetryBreaker, recordRetryFailure } from "./retry-breaker";
import { RETRY_POLICIES } from "./retry-policies";
import { codexHistoryMessages } from "./provider-history";
import { projectSessionProviderMessage } from "./session-projection";
import { recordSessionEvent } from "./session-inputs";
import { recordCodexWorkload } from "./session-fit";
import { disconnectCodexLifecycle, observeCodexLifecycle } from "./codex-session-lifecycle";
import { runLedgerSegment, runLedgerSteps } from "./ledger-admission";
import {
  getConciergeProviderTurn,
  getUniqueCodexSessionBinding,
  listUniqueCodexSessionBindings,
  recordCodexSessionHistoryHead,
  db,
} from "./state";
import { custodySuccessorSession } from "./codex-custody-successor";

const OBSERVATION_RETRY_MS = 100;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Told when a bound Codex conversation's history changed, so its kept window can be topped up. */
const codexHistoryListeners=new Set<(sessionId:number,providerThreadUuid:string)=>void>();
export function onCodexHistoryChanged(listener:(sessionId:number,providerThreadUuid:string)=>void):()=>void {
  codexHistoryListeners.add(listener);
  return ()=>{codexHistoryListeners.delete(listener);};
}

export class CodexSessionObserver {
  private stopped = false;
  private connectionLoop: Promise<void> | null = null;
  private notificationLoop: Promise<void> = Promise.resolve();
  private readonly stoppedSignal: Promise<void>;
  private resolveStoppedSignal!: () => void;
  private readonly subscribedThreadIds = new Set<string>();
  private readonly protectedSessionThreadIds = new Set<string>();
  private readonly protectedObservationLoops = new Map<string, Promise<void>>();
  private readonly pendingThreadSubscriptions = new Map<string, Promise<void>>();
  private readonly appServer: CodexAppServerClientLike;
  private readonly ownsAppServer: boolean;
  private readonly lifecycleVersions = new Map<string, number>();

  constructor(options: { appServer?: CodexAppServerClientLike } = {}) {
    // Subscriptions belong to this observer, so releasing an idle thread cannot
    // unsubscribe the execution host or another client sharing its connection.
    this.ownsAppServer = !options.appServer;
    this.appServer = options.appServer ?? ownerCodexAppServerClient();
    this.stoppedSignal = new Promise((resolve) => { this.resolveStoppedSignal = resolve; });
  }

  start() {
    if (this.connectionLoop) return;
    this.connectionLoop = runLedgerSegment(() => {
      if (this.stopped) return;
      for (const binding of listUniqueCodexSessionBindings()) disconnectCodexLifecycle(binding.provider_thread_uuid);
    }).then(() => this.runConnections());
  }

  providerSessionBound(providerThreadUuid: string) {
    if (this.stopped) return Promise.resolve();
    const binding = getUniqueCodexSessionBinding(providerThreadUuid);
    const protectedCustody = binding ? protectedCustodyBinding(binding.session_id) : null;
    if (binding && protectedCustody) {
      if (this.protectedSessionThreadIds.has(providerThreadUuid)) {
        this.startProtectedObservation(providerThreadUuid);
        return Promise.resolve();
      }
    } else if (this.subscribedThreadIds.has(providerThreadUuid)) return Promise.resolve();
    const pending = this.pendingThreadSubscriptions.get(providerThreadUuid);
    if (pending) return pending;
    const subscription = (binding && protectedCustody
      ? this.observeProtectedBoundProviderSession(providerThreadUuid, binding.session_id, protectedCustody.role)
      : this.subscribeBoundProviderSession(providerThreadUuid)).finally(() => {
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
    // Closing this observer-owned bridge rejects its pending reads. Waiting for
    // those reads before closing could hold a release for their 30-second deadline.
    const close = this.ownsAppServer ? (this.appServer as CodexAppServerClient).close({ immediate: true }) : Promise.resolve();
    const settled = await Promise.allSettled([close,
      this.connectionLoop,
      this.notificationLoop,
      ...this.protectedObservationLoops.values(),
      ...this.pendingThreadSubscriptions.values(),
    ].filter(Boolean) as Promise<void>[]);
    if (settled[0]?.status === "rejected") throw settled[0].reason;
  }

  private async runConnections() {
    let failures = 0;
    while (!this.stopped) {
      let generation: number | null = null;
      const unsubscribe = this.appServer.onNotification((event) => this.queueNotification(event));
      try {
        generation = await this.appServer.connect();
        if (!await this.observeLoadedBindings(this.appServer, generation)) continue;
        failures = 0;
        if (this.stopped) return;
        await runLedgerSegment(() => {
          if (!this.stopped) clearRetryBreaker("codex-session-observer:app-server");
        });
        await Promise.race([this.appServer.waitForDisconnect(generation), this.stoppedSignal]);
      } catch (error) {
        if (!this.stopped) log("warn", "codex_session_observer_disconnected", errorFields(error));
      } finally {
        unsubscribe();
        await this.notificationLoop;
        // A planned owner handoff has no new provider evidence to record here. The next
        // owner refreshes lifecycle from the App Server after its request API opens.
        if (!this.stopped) await runLedgerSegment(() => {
          if (!this.stopped) {
            for (const threadId of this.subscribedThreadIds) disconnectCodexLifecycle(threadId);
          }
        });
        this.subscribedThreadIds.clear();
      }
      if (!this.stopped) {
        failures += 1;
        const decision = await runLedgerSegment(() => this.stopped ? null : recordRetryFailure({ key: "codex-session-observer:app-server", site: "codex-observer",
          what: "Codex conversation observation", failure: { kind: "transient",
            reason: "The Codex App Server did not answer.", restartSignal: "the Codex App Server answers a capped probe" } }));
        if (!decision) return;
        await Promise.race([wait(decision.action === "retry" ? Math.max(0, decision.atMs - Date.now()) : RETRY_POLICIES.observer.capDelayMs), this.stoppedSignal]);
      }
    }
  }

  private async observeLoadedBindings(connection: CodexAppServerClientLike, generation: number) {
    const bindings = new Map(listUniqueCodexSessionBindings().map(binding => [binding.provider_thread_uuid, binding]));
    let cursor: string | null = null;
    do {
      if (this.stopped) return false;
      const page = await connection.request("thread/loaded/list", { cursor, limit: 100 });
      if (this.stopped) return false;
      if (!Array.isArray(page?.data)) throw new Error("Codex did not return loaded thread IDs.");
      for (const threadId of page.data) {
        const binding = bindings.get(threadId);
        if (!binding || this.subscribedThreadIds.has(threadId)) continue;
        if (this.stopped) return false;
        if (this.stopped || await connection.connect() !== generation || this.stopped) return false;
        try {
          // Read stored state without loading a dormant conversation. A loaded idle
          // thread may have completed before reconnect, so refresh its receipts.
          const snapshot = await connection.request("thread/read", { threadId, includeTurns: false });
          await this.queueLifecycleRefresh(threadId);
          await this.refreshHistoryHead(binding.session_id, threadId);
          if (snapshot.thread?.status?.type === "active" || protectedCustodyBinding(binding.session_id)) {
            await this.providerSessionBound(threadId);
          }
        } catch (error) {
          if (this.stopped || await connection.connect() !== generation || this.stopped) return false;
          log("warn", "codex_session_thread_subscription_failed", {
            ...errorFields(error),
            provider_thread_uuid: threadId,
            session_id: binding.session_id,
          });
        }
        if (this.stopped || await connection.connect() !== generation || this.stopped) return false;
      }
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : null;
    } while (cursor);
    return true;
  }

  private async subscribeBoundProviderSession(providerThreadUuid: string) {
    if (this.stopped) return;
    const binding = getUniqueCodexSessionBinding(providerThreadUuid);
    if (!binding) return;
    const generation = await this.appServer.connect();
    if (this.stopped || await this.appServer.connect() !== generation || this.stopped) {
      throw new Error("The provider observer connection changed while subscribing a newly bound session.");
    }
    const latestBinding = getUniqueCodexSessionBinding(providerThreadUuid);
    const protectedCustody = latestBinding ? protectedCustodyBinding(latestBinding.session_id) : null;
    if (latestBinding && protectedCustody) {
      await this.observeProtectedBoundProviderSession(providerThreadUuid, latestBinding.session_id, protectedCustody.role);
      return;
    }
    if (!latestBinding) return;
    // Keep the current owner binding and custody relation adjacent to the native call. A
    // callback queued before accepted custody must not resume the predecessor afterward.
    await this.appServer.request("thread/resume", { threadId: providerThreadUuid, excludeTurns: true },
      {custodyOwnerSessionId:latestBinding.session_id});
    if (this.stopped || await this.appServer.connect() !== generation || this.stopped) {
      throw new Error("The provider observer connection changed after subscribing a newly bound session.");
    }
    this.subscribedThreadIds.add(providerThreadUuid);
    await this.queueLifecycleRefresh(providerThreadUuid);
    if (this.stopped) return;
    await this.refreshHistoryHead(binding.session_id, providerThreadUuid);
    log("info", "codex_session_thread_subscribed", {
      provider_thread_uuid: providerThreadUuid,
      session_id: binding.session_id,
      trigger: "provider_session_bound",
    });
  }

  /** Protected successor binding is evidence to inspect, never permission to load/resume it. */
  private async observeProtectedBoundProviderSession(providerThreadUuid: string, sessionId: number,
    role: "successor" | "predecessor") {
    if (this.stopped) return;
    const generation = await this.appServer.connect();
    if (this.stopped || await this.appServer.connect() !== generation || this.stopped) {
      throw new Error("The provider observer connection changed before protected observation.");
    }
    const snapshot = await this.appServer.request("thread/read", { threadId: providerThreadUuid, includeTurns: false });
    if (this.stopped || await this.appServer.connect() !== generation || this.stopped) {
      throw new Error("The provider observer connection changed during protected observation.");
    }
    if (snapshot.thread?.id !== providerThreadUuid) throw new Error("Protected observation returned a different native thread.");
    this.protectedSessionThreadIds.add(providerThreadUuid);
    await this.queueLifecycleRefresh(providerThreadUuid);
    await this.refreshHistoryHead(sessionId, providerThreadUuid);
    if (role === "successor") await this.observeProtectedTurnPages(providerThreadUuid, sessionId);
    this.startProtectedObservation(providerThreadUuid);
    log("info", "codex_session_protected_thread_observed", {
      provider_thread_uuid: providerThreadUuid, session_id: sessionId, trigger: "provider_session_bound",
    });
  }

  private startProtectedObservation(providerThreadUuid: string) {
    if (this.stopped || this.protectedObservationLoops.has(providerThreadUuid)) return;
    const loop = (async () => {
      while (!this.stopped && this.protectedSessionThreadIds.has(providerThreadUuid)) {
        try {
          const binding = getUniqueCodexSessionBinding(providerThreadUuid);
          const protectedCustody = binding ? protectedCustodyBinding(binding.session_id) : null;
          if (!binding || !protectedCustody) return;
          const relation = protectedCustody.relation;
          if (protectedCustody.role === "predecessor") {
            const status = await this.refreshLifecycle(providerThreadUuid);
            await this.refreshHistoryHead(binding.session_id, providerThreadUuid);
            if (status !== "active") return;
          } else {
            if (!relation || !["staged", "constructing", "constructed", "admitting", "admitted"].includes(relation.state)) return;
          }
          if (protectedCustody.role === "successor" && relation && (relation.attempt_spent_at || relation.native_turn_id)) {
            const status = await this.refreshLifecycle(providerThreadUuid);
            const terminalTurnObserved = await this.observeProtectedTurnPages(providerThreadUuid, binding.session_id);
            await this.refreshHistoryHead(binding.session_id, providerThreadUuid);
            if (status === "idle" && terminalTurnObserved) return;
          }
        } catch (error) {
          if (this.stopped) return;
          log("warn", "codex_session_protected_observation_failed", {
            provider_thread_uuid: providerThreadUuid, ...errorFields(error),
          });
        }
        await Promise.race([wait(1_000), this.stoppedSignal]);
      }
    })().finally(() => {
      if (this.protectedObservationLoops.get(providerThreadUuid) === loop) {
        this.protectedObservationLoops.delete(providerThreadUuid);
      }
    });
    this.protectedObservationLoops.set(providerThreadUuid, loop);
  }

  private async observeProtectedTurnPages(providerThreadUuid: string, sessionId: number): Promise<boolean> {
    const relation = custodySuccessorSession(sessionId);
    if (!relation) return false;
    let cursor: string | null = null;
    let target: any = null;
    do {
      const page = await this.appServer.request("thread/turns/list", {
        threadId: providerThreadUuid, cursor, limit: 20, sortDirection: "desc", itemsView: "summary",
      });
      if (!Array.isArray(page?.data)) throw new Error("Codex did not return a protected turn page.");
      target = page.data.find((turn: any) => relation.native_turn_id
        ? turn?.id === relation.native_turn_id : turn?.status === "inProgress") ?? null;
      if (target) break;
      const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (next && next === cursor) throw new Error("Codex repeated a protected turn cursor.");
      cursor = next;
    } while (cursor);
    if (!target || typeof target.id !== "string") return false;
    let itemCursor: string | null = null;
    do {
      const page = await this.appServer.request("thread/items/list", {
        threadId: providerThreadUuid, turnId: target.id, cursor: itemCursor, limit: 100, sortDirection: "asc",
      });
      if (!Array.isArray(page?.data) || page.data.some((entry: any) => entry?.turnId !== target.id)) {
        throw new Error("Codex returned protected items for a different native turn.");
      }
      await runLedgerSegment(() => {
        for (const entry of page.data) this.observeMessages({ threadId: providerThreadUuid, turnId: target.id, item: entry.item });
      });
      const next = typeof page.nextCursor === "string" ? page.nextCursor : null;
      if (next && next === itemCursor) throw new Error("Codex repeated a protected item cursor.");
      itemCursor = next;
    } while (itemCursor);
    return ["completed", "failed", "interrupted"].includes(target.status);
  }

  private invalidateHistory(sessionId: number, providerThreadUuid: string) {
    for (const listener of codexHistoryListeners) listener(sessionId, providerThreadUuid);
    recordSessionEvent({
      eventId: `provider-history:${sessionId}:${randomUUID()}`,
      sessionId,
      kind: "history",
      payload: { providerThreadUuid },
    });
  }

  private async refreshHistoryHead(sessionId: number, providerThreadUuid: string) {
    if (this.stopped) return;
    let digest: string;
    try {
      const page = await this.appServer.request("thread/items/list", {
        threadId: providerThreadUuid, limit: 1, sortDirection: "desc",
      });
      if (!Array.isArray(page?.data)) throw new Error("Codex did not return an item page.");
      digest = createHash("sha256").update(JSON.stringify(page.data[0] ?? null)).digest("hex");
    } catch (error) {
      if (this.stopped) return;
      log("warn", "codex_session_history_head_failed", {
        ...errorFields(error), provider_thread_uuid: providerThreadUuid, session_id: sessionId,
      });
      await runLedgerSegment(() => {
        if (!this.stopped) this.invalidateHistory(sessionId, providerThreadUuid);
      });
      return;
    }
    await runLedgerSegment(() => {
      if (this.stopped) return;
      if (recordCodexSessionHistoryHead(sessionId, providerThreadUuid, digest)) {
        this.invalidateHistory(sessionId, providerThreadUuid);
      }
    });
  }

  private queueNotification(event: any) {
    if (this.stopped) return;
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
    const continuation = await runLedgerSegment(() => this.persistNotificationSegment(event));
    if (!continuation) return;
    const { threadId, kind } = continuation;
    if (kind === "status") {
      if (event.params.status?.type === "active" && !this.subscribedThreadIds.has(threadId)) {
        // Subscribe outside the notification queue: subscription refresh joins this queue.
        void this.providerSessionBound(threadId).catch(error =>
          log("warn", "codex_session_lifecycle_subscription_failed", {
            provider_thread_uuid: threadId, ...errorFields(error),
          }));
      }
      await this.refreshLifecycle(threadId);
      const binding = await runLedgerSegment(() => getUniqueCodexSessionBinding(threadId));
      if (binding) await this.refreshHistoryHead(binding.session_id, threadId);
    }
    await this.releaseIdleSubscription(threadId);
  }

  private persistNotificationSegment(event: any): { threadId: string; kind: "completed" | "status" } | undefined {
    if (this.stopped) return;
    const threadId = event.params?.threadId;
    if (typeof threadId === "string" && getUniqueCodexSessionBinding(threadId)) {
      if (["turn/started", "turn/completed"].includes(event.method)) {
        observeCodexLifecycle(threadId, event.params.turn, event.method);
        if (event.method === "turn/started" && this.protectedSessionThreadIds.has(threadId))
          this.startProtectedObservation(threadId);
        if (event.method === "turn/completed") this.invalidateHistory(getUniqueCodexSessionBinding(threadId)!.session_id, threadId);
        if (event.method === "turn/completed") return { threadId, kind: "completed" };
        return;
      }
      if (event.method === "thread/status/changed") {
        return { threadId, kind: "status" };
      }
      if (event.method === "thread/closed") {
        disconnectCodexLifecycle(threadId);
        this.subscribedThreadIds.delete(threadId);
        this.protectedSessionThreadIds.delete(threadId);
        return;
      }
      if (event.method === "thread/tokenUsage/updated") {
        // How full the conversation is, for routing (session-fit.ts); Codex reports it per turn.
        const usage = event.params.tokenUsage;
        const tokens = Number(usage?.last?.inputTokens), window = Number(usage?.modelContextWindow);
        if (Number.isFinite(tokens) && tokens > 0)
          recordCodexWorkload(getUniqueCodexSessionBinding(threadId)!.session_id, { contextTokens: tokens, contextWindow: Number.isFinite(window) ? window : null });
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

  private async releaseIdleSubscription(threadId: string) {
    if (this.stopped) return;
    if (!this.subscribedThreadIds.has(threadId)) return;
    try {
      const snapshot = await this.appServer.request("thread/read", { threadId, includeTurns: false });
      if (this.stopped) return;
      if (snapshot.thread?.status?.type !== "idle") return;
      await this.appServer.request("thread/unsubscribe", { threadId });
      this.subscribedThreadIds.delete(threadId);
    } catch (error) {
      // A failed cleanup must not hold every other thread's notification behind it.
      log("warn", "codex_session_idle_unsubscribe_failed", {
        provider_thread_uuid: threadId, ...errorFields(error),
      });
    }
  }

  private queueLifecycleRefresh(threadId: string) {
    if (this.stopped) return Promise.resolve();
    this.notificationLoop = this.notificationLoop.then(() => this.refreshLifecycle(threadId));
    return this.notificationLoop;
  }

  private async refreshLifecycle(threadId: string): Promise<string | undefined> {
    if (this.stopped) return undefined;
    const version = this.lifecycleVersions.get(threadId) ?? 0;
    let page: any, snapshot: any;
    try {
      [page, snapshot] = await Promise.all([
        this.appServer.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }),
        this.appServer.request("thread/read", { threadId, includeTurns: false }),
      ]);
    } catch {
      await runLedgerSegment(() => {
        if (!this.stopped && (this.lifecycleVersions.get(threadId) ?? 0) === version) disconnectCodexLifecycle(threadId);
      });
      log("warn", "codex_session_lifecycle_refresh_failed", { provider_thread_uuid: threadId });
      return undefined;
    }
    // Notifications received during this read own newer evidence and are already queued.
    const status = await runLedgerSegment(() => {
      if (this.stopped || (this.lifecycleVersions.get(threadId) ?? 0) !== version) return undefined;
      observeCodexLifecycle(threadId, page.data?.[0], "thread/snapshot", snapshot.thread?.status?.type);
      return typeof snapshot.thread?.status?.type === "string" ? snapshot.thread.status.type : undefined;
    });
    return status;
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

/** Production callback shared by execution-host binding and provider-session lifecycle hooks. */
export function bindCodexProviderSession(
  observer: Pick<CodexSessionObserver, "providerSessionBound"> | null | undefined,
  providerThreadUuid: string,
  secondaryObserver?: { providerSessionBound(providerThreadUuid: string): Promise<void> } | null,
) {
  // Each synchronous stretch (the observers' own ledger reads and this binding read)
  // is its own admitted step; the observers' returned promises are the existing waits.
  return runLedgerSteps((function* (): Generator<unknown, void, any> {
    yield observer?.providerSessionBound(providerThreadUuid);
    const binding = getUniqueCodexSessionBinding(providerThreadUuid);
    if (binding && protectedCustodyBinding(binding.session_id)) return;
    yield secondaryObserver?.providerSessionBound(providerThreadUuid);
  })());
}

export function isProtectedCodexProviderThread(providerThreadUuid: string): boolean {
  const bindings=db.query("SELECT id FROM sessions WHERE provider_id='codex' AND agent_session_uuid=?")
    .all(providerThreadUuid) as {id:number}[];
  return bindings.some(binding=>!!protectedCustodyBinding(binding.id));
}

function protectedCustodyBinding(sessionId: number): { relation: ReturnType<typeof custodySuccessorSession>;
  role: "successor" | "predecessor" } | null {
  const successor = custodySuccessorSession(sessionId);
  if (successor) return { relation: successor, role: "successor" };
  const predecessor = db.query(`SELECT relation.* FROM codex_custody_successors relation
    JOIN session_handoffs handoff ON handoff.id=relation.handoff_id
    WHERE relation.predecessor_session_id=? AND handoff.state IN ('proposed','accepted') ORDER BY relation.created_at DESC LIMIT 1`)
    .get(sessionId) as NonNullable<ReturnType<typeof custodySuccessorSession>> | null;
  if(predecessor)return {relation:predecessor,role:'predecessor'};
  const hold=db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND handoff_kind='codex-custody-successor' AND state='proposed'")
    .get(sessionId);
  return hold?{relation:null,role:'predecessor'}:null;
}
