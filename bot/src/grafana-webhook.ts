import { createHmac, timingSafeEqual } from "node:crypto";

export const GRAFANA_ALERT_PATH = "/alerts/grafana";
export const GRAFANA_ORIGIN = "https://gracefulfennel1915.grafana.net";
export const GRAFANA_BODY_LIMIT = 262_144;
export const GRAFANA_CONDITIONS: Readonly<Record<string, string>> = {
  ThinkeringExternalUnavailable: "Thinkering HTTPS is unavailable or its external observations stopped.",
  ThinkeringBackupStale: "Thinkering backup success is stale or its evidence is unreadable.",
  AX41ResourcePressure: "AX41 has sustained disk, inode or memory pressure.",
  ThinkeringDurableBacklogStale: "Thinkering has old queued, uncertain or unpublished agent work.",
  AX41CollectionUnavailable: "Metrics collection is missing, stale or dropping telemetry.",
  AX41LogCollectionStalled: "The host log heartbeat is no longer reaching Loki.",
  PersonalTelemetryAllowance: "Telemetry approaches the initial allowance; check actual account usage.",
  TestAlert: "Grafana contact test.",
  ConciergeWebhookAcceptance: "Grafana firing and recovery acceptance test.",
};
export type GrafanaAlert = {
  fingerprint: string; condition: string; startsAt: string; endsAt: string | null;
  status: "firing" | "resolved"; omitted: number;
};

export function grafanaEnvelope(alerts: GrafanaAlert[]) {
  return { externalURL: GRAFANA_ORIGIN, status: alerts.some(alert => alert.status === "firing") ? "firing" : "resolved",
    truncatedAlerts: alerts[0]?.omitted || 0,
    alerts: alerts.map(alert => ({ fingerprint: alert.fingerprint, labels: { alertname: alert.condition },
      startsAt: alert.startsAt, endsAt: alert.endsAt, status: alert.status })) };
}

export function grafanaBearer(queueToken: string) {
  if (!queueToken) throw new Error("Grafana ingress requires a nonempty internal credential.");
  return createHmac("sha256", queueToken).update("slack-concierge:grafana-alerts:v1").digest("hex");
}

export function isGrafanaBearer(request: Request, token: string) {
  const actual = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return token.length > 0 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

class WebhookError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || value.length > 40
      || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new WebhookError(422, "invalid_alert_timestamp");
  }
  return new Date(value).toISOString();
}

export function parseGrafanaAlerts(value: any): GrafanaAlert[] {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![GRAFANA_ORIGIN, GRAFANA_ORIGIN + "/"].includes(value.externalURL)
      || !Array.isArray(value.alerts) || !value.alerts.length || value.alerts.length > 64
      || !["firing", "resolved"].includes(value.status)
      || !Number.isSafeInteger(value.truncatedAlerts ?? 0) || (value.truncatedAlerts ?? 0) < 0) {
    throw new WebhookError(422, "invalid_grafana_envelope");
  }
  let unknown = 0;
  const alerts: GrafanaAlert[] = [];
  for (const entry of value.alerts) {
    const condition = entry?.labels?.alertname;
    if (typeof condition !== "string" || !Object.hasOwn(GRAFANA_CONDITIONS, condition)) {
      unknown++; continue;
    }
    if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{16,64}$/.test(entry.fingerprint)
        || !["firing", "resolved"].includes(entry.status)) throw new WebhookError(422, "invalid_alert_identity");
    const startsAt = timestamp(entry.startsAt);
    const endsAt = entry.status === "resolved" ? timestamp(entry.endsAt) : null;
    if (endsAt && endsAt < startsAt) throw new WebhookError(422, "invalid_alert_recovery");
    alerts.push({ condition, fingerprint: entry.fingerprint, startsAt, endsAt, status: entry.status, omitted: 0 });
  }
  if (!alerts.length) throw new WebhookError(422, "no_configured_alerts");
  for (const alert of alerts) alert.omitted = unknown + (value.truncatedAlerts ?? 0);
  return alerts;
}

export async function readGrafanaBody(request: Request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new WebhookError(415, "json_required");
  }
  if (Number(request.headers.get("content-length")) > GRAFANA_BODY_LIMIT) throw new WebhookError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new WebhookError(400, "json_required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GRAFANA_BODY_LIMIT) { await reader.cancel(); throw new WebhookError(413, "body_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WebhookError(400, "invalid_json"); }
}

export function createGrafanaWebhookHandler(input: {
  token: string;
  accept(alerts: GrafanaAlert[]): Promise<Record<string, unknown>>;
  observe?(status: number, accepted: number, omitted: number): void;
}) {
  return async (request: Request) => {
    let status = 503, count = 0, omitted = 0;
    const response = (code: number, body: Record<string, unknown>) => {
      status = code;
      return Response.json(body, { status: code, headers: { "cache-control": "no-store" } });
    };
    try {
      const url = new URL(request.url);
      if (url.pathname !== GRAFANA_ALERT_PATH || url.search) return response(404, { error: "not_found" });
      if (request.method !== "POST") return response(405, { error: "method_not_allowed" });
      if (!isGrafanaBearer(request, input.token)) return response(401, { error: "unauthorized" });
      const alerts = parseGrafanaAlerts(await readGrafanaBody(request));
      omitted = alerts[0]!.omitted;
      const receipt = await input.accept(alerts);
      count = alerts.length;
      return response(202, { accepted: true, omitted, ...receipt });
    } catch (error) {
      return error instanceof WebhookError
        ? response(error.status, { error: error.message })
        : response(503, { error: "alert_receiver_unavailable" });
    } finally {
      try { input.observe?.(status, count, omitted); } catch { /* Diagnostics cannot change acceptance. */ }
    }
  };
}
