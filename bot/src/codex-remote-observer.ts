import { createHash } from "node:crypto";
import {
  sharedCodexAppServerClient,
  CodexAppServerClientError,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import {
  BrokeredCodexObserverClient,
  providerBrokerEnabled,
} from "./provider-broker-client";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { isTransientSlackError } from "./slack-errors";
import {
  claimCodexRemoteMirrorEvent,
  getCodexRemoteTurnMapping,
  getUniqueCodexSessionMapping,
  isCodexRemoteTurn,
  isConciergeProviderTurn,
  listUniqueCodexSessionMappings,
  markCodexRemoteMirrorDelivered,
  nextCodexRemoteMirrorAttemptMs,
  parkCodexRemoteMirrorEvent,
  observeCodexRemoteMirrorEvent,
  recoverCodexRemoteMirrorClaims,
  retryCodexRemoteMirrorEvent,
  type CodexSessionMapping,
} from "./state";
import { ensureTldr, extractTldr } from "./text";

const LOCAL_DELIVERY_RETRY_MS = 100;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function channelToken(value: string) {
  return value.trim().replace(/^#/, "").toLowerCase();
}

function channelSet(value: string | undefined) {
  return new Set((value || "").split(",").map(channelToken).filter(Boolean));
}

export function codexRemoteChannelAllowed(
  mapping: Pick<CodexSessionMapping, "slack_channel_id" | "slack_channel_name">,
  includeValue = process.env.CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS,
  excludeValue = process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS ?? "slack-inbox",
) {
  const include = channelSet(includeValue);
  const exclude = channelSet(excludeValue);
  const identities = [channelToken(mapping.slack_channel_id), channelToken(mapping.slack_channel_name)];
  if (identities.some((identity) => exclude.has(identity))) return false;
  return include.size === 0 || identities.some((identity) => include.has(identity));
}

function sameMapping(left: CodexSessionMapping, right: CodexSessionMapping) {
  return left.session_id === right.session_id
    && left.provider_thread_uuid === right.provider_thread_uuid
    && left.slack_channel_id === right.slack_channel_id
    && left.slack_thread_ts === right.slack_thread_ts;
}

function eventMatchesMapping(
  event: Pick<NonNullable<ReturnType<typeof claimCodexRemoteMirrorEvent>>, "authorizing_session_id" | "provider_thread_uuid" | "slack_channel_id" | "slack_thread_ts">,
  mapping: CodexSessionMapping,
) {
  return mapping.session_id === event.authorizing_session_id
    && mapping.provider_thread_uuid === event.provider_thread_uuid
    && mapping.slack_channel_id === event.slack_channel_id
    && mapping.slack_thread_ts === event.slack_thread_ts;
}

function clientMessageId(threadId: string, itemId: string) {
  const hex = createHash("sha256").update(`codex-remote:${threadId}:${itemId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function namedRemoteReference(kind: string, name: unknown) {
  const label = typeof name === "string" && name.trim() ? `: ${name.trim()}` : "";
  return `[${kind} referenced in Codex Remote${label}]`;
}

function remoteInputProjection(entry: any) {
  switch (entry?.type) {
    case "text":
      return typeof entry.text === "string" ? entry.text.trim() : "";
    case "image":
    case "localImage":
      return "[Image attached in Codex Remote]";
    case "audio":
    case "localAudio":
      return "[Audio attached in Codex Remote]";
    case "skill":
      return namedRemoteReference("Skill", entry.name);
    case "mention":
      return namedRemoteReference("Mention", entry.name);
    default:
      return namedRemoteReference("Unsupported content", entry?.type);
  }
}

export function codexRemoteUserText(item: any) {
  const projected = (Array.isArray(item?.content) ? item.content : [])
    .map(remoteInputProjection)
    .filter(Boolean);
  return projected.length > 0
    ? projected.join("\n\n")
    : "[Codex Remote request contained no renderable content]";
}

export function codexRemoteMirrorEventChannelAllowed(
  event: Pick<NonNullable<ReturnType<typeof claimCodexRemoteMirrorEvent>>, "authorizing_session_id" | "provider_thread_uuid" | "slack_channel_id" | "slack_thread_ts">,
  mapping: CodexSessionMapping | null,
  includeValue = process.env.CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS,
  excludeValue = process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS ?? "slack-inbox",
) {
  return Boolean(
    mapping
    && eventMatchesMapping(event, mapping)
    && codexRemoteChannelAllowed(mapping, includeValue, excludeValue),
  );
}

export function codexRemoteAgentText(text: string) {
  return ensureTldr(text);
}

export async function deliverCodexRemoteMirrorEvent(
  event: ReturnType<typeof claimCodexRemoteMirrorEvent> & {},
  dependencies: {
    postMessage(): Promise<{ ts?: string }>;
    markDelivered?: typeof markCodexRemoteMirrorDelivered;
    getMapping?: typeof getUniqueCodexSessionMapping;
    park?: typeof parkCodexRemoteMirrorEvent;
    shouldStop?(): boolean;
    waitBeforeRetry?(milliseconds: number): Promise<void>;
  },
): Promise<{ delivered: boolean; responseTldr: string | null }> {
  const park = dependencies.park ?? parkCodexRemoteMirrorEvent;
  const getMapping = dependencies.getMapping ?? getUniqueCodexSessionMapping;
  const mapping = getMapping(event.provider_thread_uuid);
  if (!mapping || !eventMatchesMapping(event, mapping)) {
    park(
      event.provider_thread_uuid,
      event.provider_item_id,
      "The Codex session no longer has one unique authorized Slack destination.",
    );
    return { delivered: false, responseTldr: null };
  }
  if (!codexRemoteChannelAllowed(mapping)) {
    park(
      event.provider_thread_uuid,
      event.provider_item_id,
      "The authorized Slack destination is no longer eligible for Codex Remote mirroring.",
    );
    return { delivered: false, responseTldr: null };
  }
  const response = await dependencies.postMessage();
  if (!response?.ts) throw new Error("Slack did not return a timestamp for the mirrored Codex item.");
  const slackMessageTs = String(response.ts);
  const responseTldr = event.item_kind === "agent" ? extractTldr(event.payload_text) : null;
  const markDelivered = dependencies.markDelivered ?? markCodexRemoteMirrorDelivered;
  const shouldStop = dependencies.shouldStop ?? (() => false);
  const waitBeforeRetry = dependencies.waitBeforeRetry ?? wait;
  let failures = 0;
  while (!shouldStop()) {
    try {
      if (markDelivered(
        event.provider_thread_uuid,
        event.provider_item_id,
        slackMessageTs,
      )) {
        return { delivered: true, responseTldr };
      }
      throw new Error("The mirrored Codex item lost its durable delivery claim.");
    } catch (error) {
      failures += 1;
      log("error", "codex_remote_delivery_commit_failed", {
        ...errorFields(error),
        provider_thread_uuid: event.provider_thread_uuid,
        provider_item_id: event.provider_item_id,
        slack_message_ts: slackMessageTs,
        failures,
      });
      await waitBeforeRetry(Math.min(LOCAL_DELIVERY_RETRY_MS * 2 ** Math.min(failures - 1, 6), 5_000));
    }
  }
  return { delivered: false, responseTldr };
}

export class CodexRemoteObserver {
  private stopped = false;
  private connectionLoop: Promise<void> | null = null;
  private deliveryLoop: Promise<void> | null = null;
  private notificationLoop: Promise<void> = Promise.resolve();
  private deliveryWakePending = false;
  private resolveDeliveryWake: (() => void) | null = null;
  private deliveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private deliveryRetryAt: number | null = null;
  private readonly subscribedThreadIds = new Set<string>();
  private readonly pendingThreadSubscriptions = new Map<string, Promise<void>>();
  private readonly appServer: CodexAppServerClientLike;
  private readonly observeMirrorEvent: typeof observeCodexRemoteMirrorEvent;
  private readonly listMappings: typeof listUniqueCodexSessionMappings;
  private readonly getMapping: typeof getUniqueCodexSessionMapping;
  private readonly getRemoteTurnMapping: typeof getCodexRemoteTurnMapping;
  private readonly claimMirrorEvent: typeof claimCodexRemoteMirrorEvent;
  private readonly getNextMirrorAttemptMs: typeof nextCodexRemoteMirrorAttemptMs;
  private readonly waitBeforeObservationRetry: (milliseconds: number) => Promise<void>;
  private readonly waitBeforeSubscriptionRetry: (milliseconds: number) => Promise<void>;
  private readonly stoppedSignal: Promise<void>;
  private resolveStoppedSignal!: () => void;

  constructor(
    private readonly slackClient: any,
    private readonly scheduleThreadStatusProjection?: (
      channel: string,
      threadTs: string,
    ) => Promise<unknown>,
    options: {
      appServer?: CodexAppServerClientLike;
      observeMirrorEvent?: typeof observeCodexRemoteMirrorEvent;
      listMappings?: typeof listUniqueCodexSessionMappings;
      getMapping?: typeof getUniqueCodexSessionMapping;
      getRemoteTurnMapping?: typeof getCodexRemoteTurnMapping;
      claimMirrorEvent?: typeof claimCodexRemoteMirrorEvent;
      getNextMirrorAttemptMs?: typeof nextCodexRemoteMirrorAttemptMs;
      waitBeforeObservationRetry?: (milliseconds: number) => Promise<void>;
      waitBeforeSubscriptionRetry?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.appServer = options.appServer ?? (
      providerBrokerEnabled()
        ? new BrokeredCodexObserverClient(() => this.listMappings())
        : sharedCodexAppServerClient()
    );
    this.observeMirrorEvent = options.observeMirrorEvent ?? observeCodexRemoteMirrorEvent;
    this.listMappings = options.listMappings ?? listUniqueCodexSessionMappings;
    this.getMapping = options.getMapping ?? getUniqueCodexSessionMapping;
    this.getRemoteTurnMapping = options.getRemoteTurnMapping ?? getCodexRemoteTurnMapping;
    this.claimMirrorEvent = options.claimMirrorEvent ?? claimCodexRemoteMirrorEvent;
    this.getNextMirrorAttemptMs = options.getNextMirrorAttemptMs ?? nextCodexRemoteMirrorAttemptMs;
    this.waitBeforeObservationRetry = options.waitBeforeObservationRetry ?? wait;
    this.waitBeforeSubscriptionRetry = options.waitBeforeSubscriptionRetry ?? wait;
    this.stoppedSignal = new Promise((resolve) => { this.resolveStoppedSignal = resolve; });
  }

  start() {
    if (this.connectionLoop) return;
    const recovered = recoverCodexRemoteMirrorClaims();
    if (recovered) log("warn", "codex_remote_mirror_claims_recovered", { count: recovered });
    this.connectionLoop = this.runConnections();
    this.deliveryLoop = this.runDeliveries();
    this.wakeDeliveries();
  }

  providerSessionBound(providerThreadUuid: string) {
    if (!this.appServer.refreshProjectSubscriptions || this.stopped) return Promise.resolve();
    if (this.subscribedThreadIds.has(providerThreadUuid)) return Promise.resolve();
    const pending = this.pendingThreadSubscriptions.get(providerThreadUuid);
    if (pending) return pending;
    const subscription = this.subscribeBoundProviderSession(providerThreadUuid)
      .finally(() => {
        if (this.pendingThreadSubscriptions.get(providerThreadUuid) === subscription) {
          this.pendingThreadSubscriptions.delete(providerThreadUuid);
        }
      });
    this.pendingThreadSubscriptions.set(providerThreadUuid, subscription);
    return subscription;
  }

  async stop() {
    this.stopped = true;
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryTimer = null;
    this.deliveryRetryAt = null;
    this.resolveStoppedSignal();
    this.wakeDeliveries();
    await Promise.allSettled(
      [
        this.connectionLoop,
        this.deliveryLoop,
        this.notificationLoop,
        ...this.pendingThreadSubscriptions.values(),
      ].filter(Boolean) as Promise<void>[],
    );
    await this.appServer.close?.();
  }

  private async runConnections() {
    let retryMs = 1_000;
    while (!this.stopped) {
      let generation: number | null = null;
      const unsubscribe = this.appServer.onNotification((event) => {
        this.queueNotification(event);
      });
      try {
        generation = await this.appServer.connect();
        if (!await this.subscribeCurrentMappings(this.appServer, generation)) continue;
        retryMs = 1_000;
        await Promise.race([
          this.appServer.waitForDisconnect(generation),
          this.stoppedSignal,
        ]);
      } catch (error) {
        if (!this.stopped) log("warn", "codex_remote_observer_disconnected", errorFields(error));
      } finally {
        unsubscribe();
      }
      if (!this.stopped) {
        await Promise.race([wait(retryMs), this.stoppedSignal]);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }

  private async subscribeCurrentMappings(connection: CodexAppServerClientLike, generation: number) {
    const eligibleMappings = this.listMappings().filter((candidate) => codexRemoteChannelAllowed(candidate));
    for (const mapping of eligibleMappings) {
      if (await connection.connect() !== generation) return false;
      try {
        await connection.request("thread/resume", {
          threadId: mapping.provider_thread_uuid,
          excludeTurns: true,
        });
        log("info", "codex_remote_thread_subscribed", {
          provider_thread_uuid: mapping.provider_thread_uuid,
          channel: mapping.slack_channel_id,
          thread_ts: mapping.slack_thread_ts,
        });
        this.subscribedThreadIds.add(mapping.provider_thread_uuid);
      } catch (error) {
        if (await connection.connect() !== generation) return false;
        log("warn", "codex_remote_thread_subscription_failed", {
          ...errorFields(error),
          provider_thread_uuid: mapping.provider_thread_uuid,
          channel: mapping.slack_channel_id,
          thread_ts: mapping.slack_thread_ts,
        });
      }
      if (await connection.connect() !== generation) return false;
    }
    return true;
  }

  private async subscribeBoundProviderSession(providerThreadUuid: string) {
    let failures = 0;
    while (!this.stopped) {
      const mappings = this.listMappings().filter((mapping) => (
        mapping.provider_thread_uuid === providerThreadUuid
        && codexRemoteChannelAllowed(mapping)
      ));
      if (mappings.length !== 1 || !mappings[0].provider_binding_token) return;
      try {
        const generation = await this.appServer.connect();
        await this.appServer.refreshProjectSubscriptions?.();
        if (this.stopped) return;
        if (await this.appServer.connect() !== generation) {
          throw new CodexAppServerClientError(
            "The provider observer connection changed while subscribing a newly bound session.",
            "ambiguous",
          );
        }
        await this.appServer.request("thread/resume", {
          threadId: providerThreadUuid,
          excludeTurns: true,
        });
        if (this.stopped) return;
        if (await this.appServer.connect() !== generation) {
          throw new CodexAppServerClientError(
            "The provider observer connection changed after subscribing a newly bound session.",
            "ambiguous",
          );
        }
        this.subscribedThreadIds.add(providerThreadUuid);
        log("info", "codex_remote_thread_subscribed", {
          provider_thread_uuid: providerThreadUuid,
          channel: mappings[0].slack_channel_id,
          thread_ts: mappings[0].slack_thread_ts,
          trigger: "provider_session_bound",
          retry_failures: failures,
        });
        return;
      } catch (error) {
        if (error instanceof CodexAppServerClientError && error.outcome === "rejected") throw error;
        failures += 1;
        log("warn", "codex_remote_bound_session_subscription_retry", {
          ...errorFields(error),
          provider_thread_uuid: providerThreadUuid,
          failures,
        });
        const retryMs = Math.min(LOCAL_DELIVERY_RETRY_MS * 2 ** Math.min(failures - 1, 6), 5_000);
        await Promise.race([
          this.waitBeforeSubscriptionRetry(retryMs),
          this.stoppedSignal,
        ]);
      }
    }
  }

  private queueNotification(event: any) {
    this.notificationLoop = this.notificationLoop
      .then(() => this.onNotification(event))
      .catch((error) => {
        log("error", "codex_remote_notification_failed", errorFields(error));
      });
  }

  private async onNotification(event: any) {
    if (event.method !== "item/completed") return;
    const params = event.params || {};
    const item = params.item || {};
    const mirrorRelevant = item.type === "userMessage" || (
      item.type === "agentMessage"
      && ["final_answer", "finalAnswer"].includes(item.phase)
    );
    if (!mirrorRelevant) return;
    let failures = 0;
    while (!this.stopped) {
      try {
        const observed = this.observeNotification(params);
        if (observed) this.wakeDeliveries();
        return;
      } catch (error) {
        failures += 1;
        log("error", "codex_remote_notification_persistence_failed", {
          ...errorFields(error),
          provider_thread_uuid: String(params.threadId || ""),
          provider_turn_id: String(params.turnId || ""),
          provider_item_id: String(params.item?.id || ""),
          failures,
        });
        const retryMs = Math.min(LOCAL_DELIVERY_RETRY_MS * 2 ** Math.min(failures - 1, 6), 5_000);
        await Promise.race([
          this.waitBeforeObservationRetry(retryMs),
          this.stoppedSignal,
        ]);
      }
    }
  }

  private observeNotification(params: any) {
    const providerThreadUuid = String(params.threadId || "");
    const turnId = String(params.turnId || "");
    const mapping = this.getMapping(providerThreadUuid);
    if (!mapping || !codexRemoteChannelAllowed(mapping)) return false;
    return this.observeItem(mapping, turnId, params.item || {});
  }

  private observeItem(mapping: CodexSessionMapping, turnId: string, item: any): boolean {
    const itemId = String(item?.id || "");
    if (!turnId || !itemId) return false;
    if (item.type === "userMessage") {
      if (typeof item.clientId === "string" && item.clientId.startsWith("slack-concierge:")) {
        return false;
      }
      const text = codexRemoteUserText(item);
      const conciergeTurn = isConciergeProviderTurn(mapping.provider_thread_uuid, turnId);
      if (!conciergeTurn) {
        const turnMapping = this.getRemoteTurnMapping(mapping.provider_thread_uuid, turnId);
        if (turnMapping && !sameMapping(turnMapping, mapping)) return false;
        if (!turnMapping && isCodexRemoteTurn(mapping.provider_thread_uuid, turnId)) return false;
        return this.enqueue(turnMapping ?? mapping, turnId, itemId, "user", text, !turnMapping);
      }
      return this.enqueue(
        mapping,
        turnId,
        itemId,
        "user",
        text,
      );
    }
    if (
      item.type === "agentMessage"
      && ["final_answer", "finalAnswer"].includes(item.phase)
      && typeof item.text === "string"
      && item.text.trim()
    ) {
      const turnMapping = this.getRemoteTurnMapping(mapping.provider_thread_uuid, turnId);
      if (!turnMapping || !sameMapping(turnMapping, mapping)) return false;
      return this.enqueue(turnMapping, turnId, itemId, "agent", codexRemoteAgentText(item.text));
    }
    return false;
  }

  private enqueue(
    mapping: CodexSessionMapping,
    turnId: string,
    itemId: string,
    itemKind: "user" | "agent",
    payloadText: string,
    recordRemoteTurn = false,
  ): boolean {
    return this.observeMirrorEvent({
      providerThreadUuid: mapping.provider_thread_uuid,
      providerItemId: itemId,
      providerTurnId: turnId,
      authorizingSessionId: mapping.session_id,
      itemKind,
      payloadText,
      slackChannelId: mapping.slack_channel_id,
      slackThreadTs: mapping.slack_thread_ts,
      clientMsgId: clientMessageId(mapping.provider_thread_uuid, itemId),
      recordRemoteTurn,
    });
  }

  private wakeDeliveries() {
    this.deliveryWakePending = true;
    const resolve = this.resolveDeliveryWake;
    this.resolveDeliveryWake = null;
    resolve?.();
  }

  private async waitForDeliveryWake() {
    if (this.deliveryWakePending) {
      this.deliveryWakePending = false;
      return;
    }
    await Promise.race([
      new Promise<void>((resolve) => { this.resolveDeliveryWake = resolve; }),
      this.stoppedSignal,
    ]);
    this.resolveDeliveryWake = null;
    this.deliveryWakePending = false;
  }

  private synchronizeDeliveryRetryTimer() {
    const nextAttemptMs = this.getNextMirrorAttemptMs();
    if (nextAttemptMs === null) {
      if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
      this.deliveryRetryTimer = null;
      this.deliveryRetryAt = null;
      return;
    }
    if (this.deliveryRetryTimer && this.deliveryRetryAt !== null && this.deliveryRetryAt <= nextAttemptMs) return;
    if (this.deliveryRetryTimer) clearTimeout(this.deliveryRetryTimer);
    this.deliveryRetryAt = nextAttemptMs;
    this.deliveryRetryTimer = setTimeout(() => {
      this.deliveryRetryTimer = null;
      this.deliveryRetryAt = null;
      if (!this.stopped) this.wakeDeliveries();
    }, Math.max(0, nextAttemptMs - Date.now()));
  }

  private async runDeliveries() {
    while (!this.stopped) {
      await this.waitForDeliveryWake();
      while (!this.stopped) {
        const event = this.claimMirrorEvent();
        if (!event) {
          this.synchronizeDeliveryRetryTimer();
          break;
        }
        try {
          const delivery = await deliverCodexRemoteMirrorEvent(event, {
            getMapping: this.getMapping,
            postMessage: () => slackCall(this.slackClient, "chat.postMessage", {
              channel: event.slack_channel_id,
              thread_ts: event.slack_thread_ts,
              text: event.item_kind === "user"
                ? `*From Codex Remote:*\n${event.payload_text}`
                : event.payload_text,
              client_msg_id: event.client_msg_id,
            }, { channel: event.slack_channel_id }),
            shouldStop: () => this.stopped,
          });
          if (!delivery.delivered) continue;
          if (delivery.responseTldr && this.scheduleThreadStatusProjection) {
            try {
              await this.scheduleThreadStatusProjection(event.slack_channel_id, event.slack_thread_ts);
            } catch (projectionError) {
              log("error", "codex_remote_summary_projection_failed", {
                ...errorFields(projectionError),
                provider_thread_uuid: event.provider_thread_uuid,
                provider_item_id: event.provider_item_id,
                channel: event.slack_channel_id,
                thread_ts: event.slack_thread_ts,
              });
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (isTransientSlackError(error) && event.attempts < 20) {
            const delay = Math.min(1_000 * 2 ** Math.min(event.attempts, 6), 60_000);
            retryCodexRemoteMirrorEvent(
              event.provider_thread_uuid,
              event.provider_item_id,
              detail,
              Date.now() + delay,
            );
          } else {
            parkCodexRemoteMirrorEvent(event.provider_thread_uuid, event.provider_item_id, detail);
            log("error", "codex_remote_mirror_parked", {
              ...errorFields(error),
              provider_thread_uuid: event.provider_thread_uuid,
              provider_item_id: event.provider_item_id,
              channel: event.slack_channel_id,
            });
          }
        }
      }
    }
  }
}
