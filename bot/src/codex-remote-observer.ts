import { createHash } from "node:crypto";
import {
  sharedCodexAppServerClient,
  type CodexAppServerClientLike,
} from "./codex-app-server-client";
import { errorFields, log } from "./log";
import { slackCall } from "./rate-limit";
import { isTransientSlackError } from "./slack-errors";
import {
  claimCodexRemoteMirrorEvent,
  claimCodexRemoteObservedItem,
  codexRemoteMirrorEventMappingValid,
  initializeCodexRemoteSubscription,
  isCodexRemoteTurn,
  isConciergeProviderTurn,
  listUniqueCodexSessionMappings,
  markCodexRemoteMirrorDelivered,
  parkCodexRemoteMirrorEvent,
  observeCodexRemoteMirrorEvent,
  recoverCodexRemoteMirrorClaims,
  retryCodexRemoteMirrorEvent,
  type CodexSessionMapping,
} from "./state";
import { ensureTldr, extractTldr } from "./text";

const SUBSCRIPTION_REFRESH_MS = 10_000;
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
  mappings: CodexSessionMapping[],
  includeValue = process.env.CONCIERGE_CODEX_REMOTE_INCLUDE_CHANNELS,
  excludeValue = process.env.CONCIERGE_CODEX_REMOTE_EXCLUDE_CHANNELS ?? "slack-inbox",
) {
  const mapping = mappings.find((candidate) => (
    candidate.session_id === event.authorizing_session_id
    && candidate.provider_thread_uuid === event.provider_thread_uuid
    && candidate.slack_channel_id === event.slack_channel_id
    && candidate.slack_thread_ts === event.slack_thread_ts
  ));
  return Boolean(mapping && codexRemoteChannelAllowed(mapping, includeValue, excludeValue));
}

export function codexRemoteAgentText(text: string) {
  return ensureTldr(text);
}

export async function deliverCodexRemoteMirrorEvent(
  event: ReturnType<typeof claimCodexRemoteMirrorEvent> & {},
  dependencies: {
    postMessage(): Promise<{ ts?: string }>;
    markDelivered?: typeof markCodexRemoteMirrorDelivered;
    listMappings?: typeof listUniqueCodexSessionMappings;
    park?: typeof parkCodexRemoteMirrorEvent;
    shouldStop?(): boolean;
    waitBeforeRetry?(milliseconds: number): Promise<void>;
  },
): Promise<{ delivered: boolean; responseTldr: string | null }> {
  const park = dependencies.park ?? parkCodexRemoteMirrorEvent;
  if (!codexRemoteMirrorEventMappingValid(event)) {
    park(
      event.provider_thread_uuid,
      event.provider_item_id,
      "The Codex session no longer has one unique authorized Slack destination.",
    );
    return { delivered: false, responseTldr: null };
  }
  const listMappings = dependencies.listMappings ?? listUniqueCodexSessionMappings;
  if (!codexRemoteMirrorEventChannelAllowed(event, listMappings())) {
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
  private readonly mappings = new Map<string, CodexSessionMapping>();
  private readonly startupThreadIds = new Set<string>();
  private readonly appServer: CodexAppServerClientLike;
  private readonly subscriptionRefreshMs: number;
  private readonly observeMirrorEvent: typeof observeCodexRemoteMirrorEvent;
  private readonly listMappings: typeof listUniqueCodexSessionMappings;
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
      subscriptionRefreshMs?: number;
      observeMirrorEvent?: typeof observeCodexRemoteMirrorEvent;
      listMappings?: typeof listUniqueCodexSessionMappings;
    } = {},
  ) {
    this.appServer = options.appServer ?? sharedCodexAppServerClient();
    this.subscriptionRefreshMs = options.subscriptionRefreshMs ?? SUBSCRIPTION_REFRESH_MS;
    this.observeMirrorEvent = options.observeMirrorEvent ?? observeCodexRemoteMirrorEvent;
    this.listMappings = options.listMappings ?? listUniqueCodexSessionMappings;
    this.stoppedSignal = new Promise((resolve) => { this.resolveStoppedSignal = resolve; });
  }

  start() {
    if (this.connectionLoop) return;
    for (const mapping of this.listMappings().filter((candidate) => codexRemoteChannelAllowed(candidate))) {
      this.startupThreadIds.add(mapping.provider_thread_uuid);
    }
    const recovered = recoverCodexRemoteMirrorClaims();
    if (recovered) log("warn", "codex_remote_mirror_claims_recovered", { count: recovered });
    this.connectionLoop = this.runConnections();
    this.deliveryLoop = this.runDeliveries();
  }

  async stop() {
    this.stopped = true;
    this.resolveStoppedSignal();
    await Promise.allSettled([this.connectionLoop, this.deliveryLoop].filter(Boolean) as Promise<void>[]);
  }

  private async runConnections() {
    let retryMs = 1_000;
    while (!this.stopped) {
      let generation: number | null = null;
      const unsubscribe = this.appServer.onNotification((event) => this.onNotification(event));
      try {
        generation = await this.appServer.connect();
        await this.refreshSubscriptions(this.appServer);
        retryMs = 1_000;
        while (!this.stopped) {
          const outcome = await Promise.race([
            this.appServer.waitForDisconnect(generation).then(() => "ended" as const),
            wait(this.subscriptionRefreshMs).then(() => "refresh" as const),
            this.stoppedSignal.then(() => "stopped" as const),
          ]);
          if (outcome !== "refresh") break;
          await this.refreshSubscriptions(this.appServer);
        }
      } catch (error) {
        if (!this.stopped) log("warn", "codex_remote_observer_disconnected", errorFields(error));
      } finally {
        unsubscribe();
        this.mappings.clear();
      }
      if (!this.stopped) {
        await Promise.race([wait(retryMs), this.stoppedSignal]);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  }

  private async refreshSubscriptions(connection: CodexAppServerClientLike) {
    const eligibleMappings = this.listMappings().filter((candidate) => codexRemoteChannelAllowed(candidate));
    const eligibleThreadIds = new Set(eligibleMappings.map((mapping) => mapping.provider_thread_uuid));
    for (const threadId of this.mappings.keys()) {
      if (eligibleThreadIds.has(threadId)) continue;
      this.mappings.delete(threadId);
      log("warn", "codex_remote_thread_tracking_removed", { provider_thread_uuid: threadId });
    }
    for (const mapping of eligibleMappings) {
      try {
        if (this.mappings.has(mapping.provider_thread_uuid)) {
          for (const turn of await this.readTurns(connection, mapping.provider_thread_uuid)) {
            for (const item of Array.isArray(turn.items) ? turn.items : []) {
              this.observeItem(mapping, String(turn.id || ""), item);
            }
          }
          continue;
        }
        const turns = await this.readTurns(connection, mapping.provider_thread_uuid);
        const historicalIds = turns.flatMap((turn: any) => (
          Array.isArray(turn.items) ? turn.items.map((item: any) => String(item?.id || "")).filter(Boolean) : []
        ));
        const baselineExistingThread = this.startupThreadIds.has(mapping.provider_thread_uuid);
        const firstSubscription = initializeCodexRemoteSubscription(
          mapping.provider_thread_uuid,
          baselineExistingThread ? historicalIds : [],
        );
        if (!firstSubscription || !baselineExistingThread) {
          for (const turn of turns) {
            for (const item of Array.isArray(turn.items) ? turn.items : []) {
              this.observeItem(mapping, String(turn.id || ""), item);
            }
          }
        }
        this.mappings.set(mapping.provider_thread_uuid, mapping);
        await connection.request("thread/resume", {
          threadId: mapping.provider_thread_uuid,
          excludeTurns: true,
        });
        for (const turn of await this.readTurns(connection, mapping.provider_thread_uuid)) {
          for (const item of Array.isArray(turn.items) ? turn.items : []) {
            this.observeItem(mapping, String(turn.id || ""), item);
          }
        }
        log("info", "codex_remote_thread_subscribed", {
          provider_thread_uuid: mapping.provider_thread_uuid,
          channel: mapping.slack_channel_id,
          thread_ts: mapping.slack_thread_ts,
          first_subscription: firstSubscription,
        });
      } catch (error) {
        this.mappings.delete(mapping.provider_thread_uuid);
        log("warn", "codex_remote_thread_subscription_failed", {
          ...errorFields(error),
          provider_thread_uuid: mapping.provider_thread_uuid,
          channel: mapping.slack_channel_id,
          thread_ts: mapping.slack_thread_ts,
        });
      }
    }
  }

  private async readTurns(connection: CodexAppServerClientLike, threadId: string): Promise<any[]> {
    const history = await connection.request("thread/read", { threadId, includeTurns: true });
    return Array.isArray(history?.thread?.turns) ? history.thread.turns : [];
  }

  private onNotification(event: any) {
    if (event.method !== "item/completed") return;
    const params = event.params || {};
    try {
      const providerThreadUuid = String(params.threadId || "");
      let mapping = this.mappings.get(providerThreadUuid);
      if (!mapping) {
        mapping = this.listMappings().find((candidate) => (
          candidate.provider_thread_uuid === providerThreadUuid
          && codexRemoteChannelAllowed(candidate)
        ));
        if (!mapping) return;
        initializeCodexRemoteSubscription(providerThreadUuid, []);
        this.mappings.set(providerThreadUuid, mapping);
        log("info", "codex_remote_thread_discovered_from_live_event", {
          provider_thread_uuid: providerThreadUuid,
          channel: mapping.slack_channel_id,
          thread_ts: mapping.slack_thread_ts,
        });
      }
      this.observeItem(mapping, String(params.turnId || ""), params.item || {});
    } catch (error) {
      log("error", "codex_remote_notification_persistence_failed", {
        ...errorFields(error),
        provider_thread_uuid: String(params.threadId || ""),
        provider_turn_id: String(params.turnId || ""),
        provider_item_id: String(params.item?.id || ""),
      });
    }
  }

  private observeItem(mapping: CodexSessionMapping, turnId: string, item: any) {
    const itemId = String(item?.id || "");
    if (!turnId || !itemId) return;
    if (item.type === "userMessage") {
      if (typeof item.clientId === "string" && item.clientId.startsWith("slack-concierge:")) {
        claimCodexRemoteObservedItem(mapping.provider_thread_uuid, itemId);
        return;
      }
      const text = codexRemoteUserText(item);
      this.enqueue(
        mapping,
        turnId,
        itemId,
        "user",
        text,
        !isConciergeProviderTurn(mapping.provider_thread_uuid, turnId),
      );
      return;
    }
    if (
      item.type === "agentMessage"
      && ["final_answer", "finalAnswer"].includes(item.phase)
      && typeof item.text === "string"
      && item.text.trim()
      && isCodexRemoteTurn(mapping.provider_thread_uuid, turnId)
    ) {
      this.enqueue(mapping, turnId, itemId, "agent", codexRemoteAgentText(item.text));
      return;
    }
    if (isConciergeProviderTurn(mapping.provider_thread_uuid, turnId)) {
      claimCodexRemoteObservedItem(mapping.provider_thread_uuid, itemId);
    }
  }

  private enqueue(
    mapping: CodexSessionMapping,
    turnId: string,
    itemId: string,
    itemKind: "user" | "agent",
    payloadText: string,
    recordRemoteTurn = false,
  ) {
    this.observeMirrorEvent({
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

  private async runDeliveries() {
    while (!this.stopped) {
      const event = claimCodexRemoteMirrorEvent();
      if (!event) {
        await wait(500);
        continue;
      }
      try {
        const delivery = await deliverCodexRemoteMirrorEvent(event, {
          listMappings: this.listMappings,
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
