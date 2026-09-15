import { createHash } from "node:crypto";
import {
  sharedCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { codexHistoryMessages } from "./provider-history";
import { projectSessionProviderMessage } from "./session-projection";
import { recordSessionEvent } from "./session-inputs";
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

  constructor(options: { appServer?: CodexAppServerClientLike } = {}) {
    this.appServer = options.appServer ?? sharedCodexAppServerClient();
    this.stoppedSignal = new Promise((resolve) => { this.resolveStoppedSignal = resolve; });
  }

  start() {
    if (this.connectionLoop) return;
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
    log("info", "codex_session_thread_subscribed", {
      provider_thread_uuid: providerThreadUuid,
      session_id: binding.session_id,
      trigger: "provider_session_bound",
    });
  }

  private queueNotification(event: any) {
    this.notificationLoop = this.notificationLoop
      .then(() => this.onNotification(event))
      .catch((error) => log("error", "codex_session_notification_failed", errorFields(error)));
  }

  private async onNotification(event: any) {
    if (event.method !== "item/completed") return;
    const params = event.params || {};
    const item = params.item || {};
    if (typeof item.type !== "string" || typeof item.id !== "string" || !item.id
      || ["reasoning", "hookPrompt"].includes(item.type)) return;
    let failures = 0;
    while (!this.stopped) {
      try {
        this.observeMessages(params);
        return;
      } catch (error) {
        failures += 1;
        log("error", "codex_session_notification_persistence_failed", {
          ...errorFields(error),
          provider_thread_uuid: String(params.threadId || ""),
          provider_turn_id: String(params.turnId || ""),
          provider_item_id: String(item.id),
          failures,
        });
        const retryMs = Math.min(OBSERVATION_RETRY_MS * 2 ** Math.min(failures - 1, 6), 5_000);
        await Promise.race([wait(retryMs), this.stoppedSignal]);
      }
    }
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
