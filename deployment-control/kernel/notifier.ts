import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  DeploymentNotificationRow,
  NotificationKind,
  NotifierTargetRow,
} from "./state";

export interface RuntimeRestoredProjection {
  incident_id: string;
  candidate_commit: string;
  restored_commit: string;
  service_invocation_id: string;
  capture_probe: "functional health passed";
  service_probe: "functional health passed";
  admission_state: "released" | "held";
  reason_code: "candidate_health_failed" | "candidate_start_failed" | "candidate_provenance_failed";
}

export interface RepairParkedProjection {
  incident_id: string;
  candidate_commit: string;
  admission_state: "released" | "held";
  reason_code:
    | "rollback_unsafe"
    | "rollback_unproven"
    | "provider_admission_ambiguous"
    | "feature_mapping_unavailable"
    | "human_authority_required";
}

export interface ForwardRepairSucceededProjection {
  incident_id: string;
  deployed_commit: string;
  service_invocation_id: string;
  capture_probe: "functional health passed";
  service_probe: "functional health passed";
  admission_state: "released";
}

export type NotificationProjection =
  | RuntimeRestoredProjection
  | RepairParkedProjection
  | ForwardRepairSucceededProjection;

export class SlackNotificationAmbiguousError extends Error {}
export class SlackNotificationRejectedError extends Error {}

function assertExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Notification fields are invalid; expected ${expected.join(", ")}.`);
  }
}

function fullCommit(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function incidentId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)) {
    throw new Error("Incident ID is invalid.");
  }
  return value;
}

function invocationId(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) {
    throw new Error("Service invocation ID is invalid.");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${label} is invalid.`);
  return value as T;
}

export function validateNotificationProjection(kind: NotificationKind, value: Record<string, unknown>) {
  if (kind === "runtime_restored") {
    assertExactKeys(value, [
      "incident_id", "candidate_commit", "restored_commit", "service_invocation_id",
      "capture_probe", "service_probe", "admission_state", "reason_code",
    ]);
    return {
      incident_id: incidentId(value.incident_id),
      candidate_commit: fullCommit(value.candidate_commit, "Candidate commit"),
      restored_commit: fullCommit(value.restored_commit, "Restored commit"),
      service_invocation_id: invocationId(value.service_invocation_id),
      capture_probe: oneOf(value.capture_probe, ["functional health passed"] as const, "Capture probe"),
      service_probe: oneOf(value.service_probe, ["functional health passed"] as const, "Service probe"),
      admission_state: oneOf(value.admission_state, ["released", "held"] as const, "Admission state"),
      reason_code: oneOf(value.reason_code, [
        "candidate_health_failed", "candidate_start_failed", "candidate_provenance_failed",
      ] as const, "Restoration reason"),
    } satisfies RuntimeRestoredProjection;
  }
  if (kind === "repair_parked") {
    assertExactKeys(value, ["incident_id", "candidate_commit", "admission_state", "reason_code"]);
    return {
      incident_id: incidentId(value.incident_id),
      candidate_commit: fullCommit(value.candidate_commit, "Candidate commit"),
      admission_state: oneOf(value.admission_state, ["released", "held"] as const, "Admission state"),
      reason_code: oneOf(value.reason_code, [
        "rollback_unsafe", "rollback_unproven", "provider_admission_ambiguous",
        "feature_mapping_unavailable", "human_authority_required",
      ] as const, "Park reason"),
    } satisfies RepairParkedProjection;
  }
  assertExactKeys(value, [
    "incident_id", "deployed_commit", "service_invocation_id",
    "capture_probe", "service_probe", "admission_state",
  ]);
  return {
    incident_id: incidentId(value.incident_id),
    deployed_commit: fullCommit(value.deployed_commit, "Deployed commit"),
    service_invocation_id: invocationId(value.service_invocation_id),
    capture_probe: oneOf(value.capture_probe, ["functional health passed"] as const, "Capture probe"),
    service_probe: oneOf(value.service_probe, ["functional health passed"] as const, "Service probe"),
    admission_state: oneOf(value.admission_state, ["released"] as const, "Admission state"),
  } satisfies ForwardRepairSucceededProjection;
}

export function renderNotification(kind: NotificationKind, projection: NotificationProjection) {
  const marker = `Deployment incident ${projection.incident_id} · ${kind}`;
  if (kind === "runtime_restored") {
    const value = projection as RuntimeRestoredProjection;
    return [
      marker,
      `Candidate ${value.candidate_commit} failed (${value.reason_code}).`,
      `Restored ${value.restored_commit}; capture and service functional health passed on invocation ${value.service_invocation_id}.`,
      `Admission is ${value.admission_state}. Automated forward repair is continuing.`,
    ].join("\n");
  }
  if (kind === "repair_parked") {
    const value = projection as RepairParkedProjection;
    return [
      marker,
      `Candidate ${value.candidate_commit} is parked (${value.reason_code}).`,
      `Admission is ${value.admission_state}. No unsafe restore or replacement provider session was attempted.`,
    ].join("\n");
  }
  const value = projection as ForwardRepairSucceededProjection;
  return [
    marker,
    `Forward repair ${value.deployed_commit} is live; capture and service functional health passed on invocation ${value.service_invocation_id}.`,
    "Admission is released. The incident is resolved.",
  ].join("\n");
}

export function notificationDigest(kind: NotificationKind, projection: NotificationProjection) {
  return createHash("sha256").update(JSON.stringify({ kind, projection })).digest("hex");
}

export function notificationClientMessageId(incident: string, kind: NotificationKind) {
  const hex = createHash("sha256").update(`concierge-deployment:${incident}:${kind}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function readSlackBotToken(configPath: string) {
  const config = readFileSync(configPath, "utf8");
  const match = config.match(/^\s*bot_token\s*=\s*("(?:[^"\\]|\\.)*")\s*$/m);
  if (!match) throw new Error("Slack bot token is unavailable in the incumbent Concierge configuration.");
  const token = JSON.parse(match[1]);
  if (typeof token !== "string" || !token.startsWith("xoxb-") || token.length > 500) {
    throw new Error("Slack bot token has an invalid format.");
  }
  return token;
}

export interface SlackNotifierServices {
  fetch(url: string, init: RequestInit): Promise<Response>;
  now(): Date;
}

export class DeterministicSlackNotifier {
  constructor(
    readonly configPath: string,
    readonly services: SlackNotifierServices = { fetch: globalThis.fetch, now: () => new Date() },
  ) {}

  private async api(method: string, body: Record<string, unknown>) {
    let response: Response;
    try {
      response = await this.services.fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${readSlackBotToken(this.configPath)}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new SlackNotificationAmbiguousError(`Slack ${method} transport outcome is ambiguous: ${error instanceof Error ? error.message : String(error)}`);
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new SlackNotificationAmbiguousError(`Slack ${method} returned an unreadable response.`);
    }
    if (!response.ok || !payload?.ok) {
      throw new SlackNotificationRejectedError(`Slack ${method} rejected the request: ${String(payload?.error || response.status)}`);
    }
    return payload;
  }

  async preflight(target: NotifierTargetRow) {
    const identity = await this.api("auth.test", {});
    if (typeof identity.user_id !== "string" || !identity.user_id) {
      throw new Error("Slack notifier preflight did not return a bot user identity.");
    }
    const preflightId = randomUUID();
    const text = `Deployment notifier preflight ${preflightId}`;
    const posted = await this.api("chat.postMessage", {
      channel: target.slack_channel_id,
      text,
      client_msg_id: notificationClientMessageId(preflightId, "repair_parked"),
      mrkdwn: false,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (typeof posted.ts !== "string" || !posted.ts) throw new Error("Slack notifier preflight send returned no timestamp.");
    try {
      const history = await this.api("conversations.history", {
        channel: target.slack_channel_id,
        oldest: posted.ts,
        latest: posted.ts,
        inclusive: true,
        limit: 10,
      });
      const matches = Array.isArray(history.messages)
        ? history.messages.filter((message: any) => message.ts === posted.ts
          && message.user === identity.user_id
          && message.text === text)
        : [];
      if (matches.length !== 1) throw new Error("Slack notifier preflight could not prove exact identity readback.");
      await this.api("chat.delete", { channel: target.slack_channel_id, ts: posted.ts });
    } catch (error) {
      throw new SlackNotificationAmbiguousError(
        `Slack notifier preflight fixture ${posted.ts} could not be reconciled and removed safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { bot_user_id: identity.user_id as string, channel: target.slack_channel_id, identity: preflightId };
  }

  async send(target: NotifierTargetRow, notification: DeploymentNotificationRow, rootSlackTs: string | null) {
    if (!target.bot_user_id || !target.preflight_at) throw new Error("Slack notifier target has not passed live preflight.");
    const projection = validateNotificationProjection(
      notification.kind,
      JSON.parse(notification.payload_json) as Record<string, unknown>,
    );
    const posted = await this.api("chat.postMessage", {
      channel: target.slack_channel_id,
      text: renderNotification(notification.kind, projection),
      ...(rootSlackTs ? { thread_ts: rootSlackTs } : {}),
      client_msg_id: notification.client_msg_id,
      mrkdwn: false,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (typeof posted.ts !== "string" || !posted.ts) {
      throw new SlackNotificationAmbiguousError("Slack accepted notification without a readable timestamp.");
    }
    return { slack_ts: posted.ts as string };
  }

  async reconcile(target: NotifierTargetRow, notification: DeploymentNotificationRow, rootSlackTs: string | null) {
    if (!target.bot_user_id || !notification.send_started_at) {
      throw new Error("Ambiguous Slack notification lacks preflight identity or send window evidence.");
    }
    const projection = validateNotificationProjection(
      notification.kind,
      JSON.parse(notification.payload_json) as Record<string, unknown>,
    );
    const text = renderNotification(notification.kind, projection);
    const started = Date.parse(`${notification.send_started_at.replace(" ", "T")}Z`) / 1000;
    const history = rootSlackTs
      ? await this.api("conversations.replies", { channel: target.slack_channel_id, ts: rootSlackTs, limit: 100 })
      : await this.api("conversations.history", {
        channel: target.slack_channel_id,
        oldest: String(Math.max(0, started - 120)),
        latest: String(this.services.now().getTime() / 1000 + 120),
        inclusive: true,
        limit: 100,
      });
    const matches = Array.isArray(history.messages)
      ? history.messages.filter((message: any) => message.user === target.bot_user_id && message.text === text)
      : [];
    if (matches.length === 1 && typeof matches[0].ts === "string") return { outcome: "delivered" as const, slack_ts: matches[0].ts };
    if (matches.length > 1) return { outcome: "parked" as const, error: "Slack readback found multiple exact notification matches." };
    return { outcome: "unproven" as const };
  }
}
