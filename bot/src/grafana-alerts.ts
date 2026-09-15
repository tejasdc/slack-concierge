import { operationalResponseInstructions } from "./operational-response";
import type { Database } from "bun:sqlite";
import { createCoalescingEventRunner } from "./coalescing-event-runner";
import { GRAFANA_CONDITIONS, GRAFANA_ORIGIN, type GrafanaAlert } from "./grafana-webhook";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";

export type GrafanaAlertRow = {
  fingerprint: string; condition: string; starts_at: string; ends_at: string | null;
  status: "firing" | "resolved"; omitted: number; channel: string; root_ts: string | null;
  revision: number; delivered_revision: number; delivery_status: "pending" | "sending" | "delivered" | "parked";
  owner_id: string | null; attempts: number; next_attempt_ms: number; error: string | null;
  investigation_episode: string | null; investigation_turn_id: number | null;
  instances?: GrafanaAlertRow[];
  conditionFiring?: boolean;
  hiddenInstances?: number;
};

export function renderGrafanaAlert(row: GrafanaAlertRow) {
  const instances = row.instances || [row];
  const status = (row.conditionFiring ?? instances.some(instance => instance.status === "firing")) ? "firing" : "resolved";
  return [
    `*Grafana · ${status.toUpperCase()}*`,
    `*${row.condition}*`,
    GRAFANA_CONDITIONS[row.condition]!,
    ...instances.flatMap(instance => [
      `Fingerprint: \`${instance.fingerprint}\` · ${instance.status.toUpperCase()}`,
      `Started: ${instance.starts_at}`,
      ...(instance.ends_at ? [`Resolved: ${instance.ends_at}`] : []),
      ...(instance.omitted ? [`Notification incomplete: ${instance.omitted} instance(s) omitted or unconfigured.`] : []),
    ]),
    ...(row.hiddenInstances ? [`${row.hiddenInstances} older instance(s) retained in the native receipt.`] : []),
    `<${GRAFANA_ORIGIN}/alerting/list|Grafana alert history> · Machine-generated operational alert`,
  ].join("\n");
}

export type GrafanaPriorTurn = { id: number; status: string; outcome: string | null };

export function grafanaInvestigationPrompt(row: GrafanaAlertRow, history: GrafanaPriorTurn[] = []) {
  return [
    "This is a machine-generated Grafana operational alert, not a user capture.",
    ...operationalResponseInstructions(),
    `Condition: ${row.condition}`,
    `Fingerprint: ${row.fingerprint}`,
    `Episode startsAt: ${row.starts_at}`,
    `Signal: ${GRAFANA_CONDITIONS[row.condition]}`,
    `Source: ${GRAFANA_ORIGIN}`,
    `Recent native condition turns (newest first; outcome excerpts limited to 4000 characters, inspect native history for full evidence): ${JSON.stringify(history)}`,
  ].join("\n");
}

export class GrafanaSlackError extends Error {
  constructor(readonly retryable: boolean, readonly safeCode: string, readonly retryAfterMs = 0) { super(safeCode); }
}

export async function publishGrafanaAlert(input: {
  token: string; row: GrafanaAlertRow; fetch?: typeof fetch;
}) {
  const update = Boolean(input.row.root_ts);
  let response: Response;
  try {
    response = await (input.fetch || fetch)(`https://slack.com/api/chat.${update ? "update" : "postMessage"}`, {
      method: "POST", headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: input.row.channel, ...(update ? { ts: input.row.root_ts } : {}),
        text: renderGrafanaAlert(input.row), unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new GrafanaSlackError(update, update ? "update_transport_failure" : "ambiguous_post"); }
  const body: any = await response.json().catch(() => null);
  if (response.status === 429 || body?.error === "ratelimited") {
    const seconds = Number(response.headers.get("retry-after"));
    throw new GrafanaSlackError(true, "rate_limited", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0);
  }
  if (!response.ok || !body?.ok || typeof body.ts !== "string" || !/^\d+\.\d+$/.test(body.ts)) {
    throw new GrafanaSlackError(update && response.status >= 500, update ? "update_rejected" : "post_unconfirmed");
  }
  if (update && body.ts !== input.row.root_ts) throw new GrafanaSlackError(false, "update_receipt_mismatch");
  return body.ts as string;
}

export class GrafanaAlerts {
  private stopping = false;
  private readonly runner;
  constructor(private readonly options: {
    db: Database; destinationChannel: string; ownerId: string;
    isOwnerAlive(ownerId: string): boolean;
    publish(row: GrafanaAlertRow): Promise<string>;
    admit(row: GrafanaAlertRow): number;
    wakeTurns(): void;
    observe(event: string, fields: Record<string, unknown>): void;
    wait?(ms: number): Promise<void>;
  }) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS grafana_alerts (
      fingerprint TEXT PRIMARY KEY, condition TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('firing','resolved')), omitted INTEGER NOT NULL DEFAULT 0,
      channel TEXT NOT NULL, root_ts TEXT, revision INTEGER NOT NULL DEFAULT 1,
      delivered_revision INTEGER NOT NULL DEFAULT 0, delivery_status TEXT NOT NULL DEFAULT 'pending',
      owner_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0, error TEXT,
      investigation_episode TEXT, investigation_turn_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    this.runner = createCoalescingEventRunner({ run: () => this.deliver(), shouldStop: () => this.stopping });
  }
  private observe(event: string, fields: Record<string, unknown>) {
    try { this.options.observe(event, fields); } catch { /* Evidence cannot change committed acceptance. */ }
  }
  row(fingerprint: string) {
    return this.options.db.query("SELECT * FROM grafana_alerts WHERE fingerprint=?").get(fingerprint) as GrafanaAlertRow | null;
  }
  accept(alerts: GrafanaAlert[]) {
    if (this.stopping) throw new Error("Alert receiver is draining.");
    const receipts = this.options.db.transaction(() => alerts.map(alert => {
      const previous = this.row(alert.fingerprint);
      if (previous && previous.condition !== alert.condition) throw new Error("Alert fingerprint changed its condition.");
      const stale = previous && (alert.startsAt < previous.starts_at
        || (alert.startsAt === previous.starts_at && previous.status === "resolved" && alert.status === "firing"));
      const duplicate = previous && (stale || (alert.startsAt === previous.starts_at && alert.status === previous.status
        && alert.endsAt === previous.ends_at && alert.omitted === previous.omitted));
      if (!previous) {
        this.options.db.query(`INSERT INTO grafana_alerts (fingerprint,condition,starts_at,ends_at,status,omitted,channel)
          VALUES (?,?,?,?,?,?,?)`).run(alert.fingerprint, alert.condition, alert.startsAt, alert.endsAt, alert.status, alert.omitted, this.options.destinationChannel);
      } else if (!duplicate) {
        this.options.db.query(`UPDATE grafana_alerts SET starts_at=?,ends_at=?,status=?,omitted=?,revision=revision+1,
          delivery_status=CASE WHEN delivery_status IN ('sending','parked') THEN delivery_status ELSE 'pending' END,
          attempts=CASE WHEN delivery_status='sending' THEN attempts ELSE 0 END,
          next_attempt_ms=CASE WHEN error='rate_limited' THEN next_attempt_ms ELSE 0 END,updated_at=CURRENT_TIMESTAMP
          WHERE fingerprint=?`).run(alert.startsAt, alert.endsAt, alert.status, alert.omitted, alert.fingerprint);
      }
      const row = this.row(alert.fingerprint)!;
      return { fingerprint: row.fingerprint, startsAt: row.starts_at, status: row.status,
        duplicate: Boolean(duplicate), delivery_status: row.delivery_status, channel: row.channel,
        message_ts: row.root_ts, investigation_turn_id: row.investigation_turn_id };
    }))();
    this.wake();
    return { alerts: receipts };
  }
  recover() {
    for (const row of this.options.db.query("SELECT * FROM grafana_alerts WHERE delivery_status='sending'").all() as GrafanaAlertRow[]) {
      if (row.owner_id && this.options.isOwnerAlive(row.owner_id)) continue;
      this.options.db.query(`UPDATE grafana_alerts SET delivery_status=?,owner_id=NULL,error=? WHERE fingerprint=? AND delivery_status='sending'`)
        .run(row.root_ts ? "pending" : "parked", row.root_ts ? null : "ambiguous_post_after_owner_death", row.fingerprint);
      if (!row.root_ts) this.observe("grafana_alert_parked", { fingerprint: row.fingerprint, reason: "ambiguous_post_after_owner_death" });
    }
    this.wake();
  }
  wake() {
    void this.runner.request("event").catch(() => this.observe("grafana_alert_worker_failed", { reason: "delivery_or_persistence_failed" }));
  }
  async settled() { await this.runner.active(); }
  async stop() { this.stopping = true; await this.settled(); }
  private investigate(row: GrafanaAlertRow) {
    if (row.status !== "firing" || !row.root_ts || row.delivered_revision !== row.revision || row.investigation_episode === row.starts_at) return;
    this.options.db.transaction(() => {
      const current = this.row(row.fingerprint)!;
      if (current.status !== "firing" || current.investigation_episode === current.starts_at) return;
      let turnId: number | null = null;
      if (!["TestAlert", "ConciergeWebhookAcceptance"].includes(current.condition)) {
        const active = this.options.db.query(`SELECT turn.id FROM turns turn JOIN grafana_alerts alert
          ON alert.investigation_turn_id=turn.id WHERE alert.condition=? AND turn.turn_kind='machine_alert'
          AND turn.status IN ('queued','running','delivering','parked') LIMIT 1`).get(current.condition) as { id: number } | null;
        turnId = active?.id ?? this.options.admit(current);
      }
      this.options.db.query("UPDATE grafana_alerts SET investigation_episode=?,investigation_turn_id=? WHERE fingerprint=?")
        .run(current.starts_at, turnId, current.fingerprint);
      this.observe("grafana_alert_investigation", { fingerprint: current.fingerprint, turn_id: turnId });
    })();
    this.options.wakeTurns();
  }
  private async deliver() {
    while (!this.stopping) {
      let row = this.options.db.query(`SELECT * FROM grafana_alerts WHERE delivery_status='pending'
        ORDER BY next_attempt_ms,fingerprint LIMIT 1`).get() as GrafanaAlertRow | null;
      if (!row) {
        for (const delivered of this.options.db.query(`SELECT * FROM grafana_alerts WHERE delivery_status='delivered'
          AND status='firing' AND (investigation_episode IS NULL OR investigation_episode<>starts_at)`).all() as GrafanaAlertRow[]) this.investigate(delivered);
        return;
      }
      const rateLimitUntil = (this.options.db.query("SELECT MAX(next_attempt_ms) AS until_ms FROM grafana_alerts WHERE error='rate_limited'").get() as { until_ms: number | null }).until_ms || 0;
      const nextAttempt = Math.max(row.next_attempt_ms, rateLimitUntil);
      if (nextAttempt > Date.now()) {
        await (this.options.wait || Bun.sleep)(Math.min(nextAttempt - Date.now(), 1000)); continue;
      }
      if (this.options.db.query(`SELECT 1 FROM grafana_alerts WHERE condition=? AND channel=?
        AND root_ts IS NULL AND delivery_status='parked' LIMIT 1`).get(row.condition, row.channel)) {
        this.options.db.query(`UPDATE grafana_alerts SET delivery_status='parked',error='condition_root_unconfirmed'
          WHERE fingerprint=?`).run(row.fingerprint);
        continue;
      }
      const condition = this.options.db.query(`SELECT COUNT(*) AS count, MAX(status='firing') AS firing,
        (SELECT root_ts FROM grafana_alerts WHERE condition=? AND channel=? AND root_ts IS NOT NULL ORDER BY rowid LIMIT 1) AS root_ts
        FROM grafana_alerts WHERE condition=? AND channel=?`).get(row.condition, row.channel, row.condition, row.channel) as { count: number; firing: number; root_ts: string | null };
      // One condition root survives fingerprint changes; the worker serializes
      // first publication before another instance can discover its confirmed root.
      row = { ...row, root_ts: condition.root_ts || row.root_ts, conditionFiring: Boolean(condition.firing),
        instances: this.options.db.query(`SELECT * FROM grafana_alerts WHERE condition=? AND channel=?
          ORDER BY (fingerprint=?) DESC, status='firing' DESC, starts_at DESC, fingerprint LIMIT 64`)
          .all(row.condition, row.channel, row.fingerprint) as GrafanaAlertRow[],
        hiddenInstances: Math.max(0, condition.count - 64) };
      const claimed = this.options.db.query(`UPDATE grafana_alerts SET delivery_status='sending',owner_id=?,attempts=attempts+1,root_ts=?
        WHERE fingerprint=? AND delivery_status='pending'`).run(this.options.ownerId, row.root_ts, row.fingerprint);
      if (!claimed.changes) continue;
      let ts: string;
      try { ts = await this.options.publish(row); }
      catch (error) {
        const retry = error instanceof GrafanaSlackError && error.retryable && row.attempts < 2;
        this.options.db.query(`UPDATE grafana_alerts SET delivery_status=?,owner_id=NULL,error=?,next_attempt_ms=?
          WHERE fingerprint=? AND delivery_status='sending' AND owner_id=?`).run(retry ? "pending" : "parked",
          error instanceof GrafanaSlackError ? error.safeCode : "unconfirmed_delivery",
          Date.now() + Math.max(1000 * 2 ** row.attempts, error instanceof GrafanaSlackError ? error.retryAfterMs : 0),
          row.fingerprint, this.options.ownerId);
        this.observe(retry ? "grafana_alert_retry" : "grafana_alert_parked", { fingerprint: row.fingerprint });
        continue;
      }
      await retryTransientDatabaseOperation({ operation: () => {
        const result = this.options.db.query(`UPDATE grafana_alerts SET root_ts=?,delivered_revision=?,owner_id=NULL,error=NULL,
          delivery_status=CASE WHEN revision=? THEN 'delivered' ELSE 'pending' END
          WHERE fingerprint=? AND delivery_status='sending' AND owner_id=?`)
          .run(ts, row.revision, row.revision, row.fingerprint, this.options.ownerId);
        if (!result.changes) throw new Error("Alert delivery ownership changed.");
      } });
      this.observe("grafana_alert_delivered", { fingerprint: row.fingerprint, state: row.status, revision: row.revision, message_ts: ts });
      this.investigate(this.row(row.fingerprint)!);
    }
  }
}
