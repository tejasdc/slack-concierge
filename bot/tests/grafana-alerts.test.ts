import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GrafanaAlerts, GrafanaSlackError, publishGrafanaAlert, renderGrafanaAlert, type GrafanaAlertRow } from "../src/grafana-alerts";
import type { GrafanaAlert } from "../src/grafana-webhook";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const firing = (overrides: Partial<GrafanaAlert> = {}): GrafanaAlert => ({
  fingerprint: "a".repeat(16), condition: "ThinkeringBackupStale", startsAt: "2026-09-15T05:00:00.000Z",
  endsAt: null, status: "firing", omitted: 0, ...overrides,
});
function fixture(publish?: (row: GrafanaAlertRow) => Promise<string>) {
  const db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE turns(id INTEGER PRIMARY KEY,turn_kind TEXT,status TEXT)");
  const published: GrafanaAlertRow[] = [], observations: any[] = [];
  const options = {
    db, ownerId: "owner", destinationChannel: "COWNED", isOwnerAlive: (owner: string) => owner === "owner",
    publish: publish || (async (row: GrafanaAlertRow) => { published.push({ ...row }); return row.root_ts || "1789452000.123456"; }),
    admit: () => Number(db.query("INSERT INTO turns(turn_kind,status) VALUES ('machine_alert','queued')").run().lastInsertRowid),
    wakeTurns: () => {}, observe: (event: string, fields: any) => observations.push({ event, ...fields }),
  };
  return { db, published, observations, options, service: new GrafanaAlerts(options) };
}

describe("durable Grafana machine delivery", () => {
  test("duplicate firing, recovery and late firing retain one bot root and one investigation", async () => {
    const f = fixture(); f.service.accept([firing()]); await f.service.settled();
    for (let i = 0; i < 5; i++) f.service.accept([firing()]);
    await f.service.settled();
    expect(f.published).toHaveLength(1);
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    f.service.accept([firing({ status: "resolved", endsAt: "2026-09-15T05:30:00.000Z" })]); await f.service.settled();
    f.service.accept([firing()]); await f.service.settled();
    expect(f.published).toHaveLength(2);
    expect(f.published[1]!.root_ts).toBe("1789452000.123456");
    expect(f.service.row(firing().fingerprint)?.status).toBe("resolved");
    expect(renderGrafanaAlert(f.service.row(firing().fingerprint)!)).toContain("Grafana · RESOLVED");
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
  });

  test("recovery arriving while the initial post is in flight wins and cannot start an obsolete investigation", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const states: string[] = [];
    const f = fixture(async row => { states.push(row.status); if (states.length === 1) await gate; return "1789452000.123456"; });
    f.service.accept([firing()]);
    f.service.accept([firing({ status: "resolved", endsAt: "2026-09-15T05:30:00.000Z" })]);
    release(); await f.service.settled();
    expect(states).toEqual(["firing", "resolved"]);
    expect(f.service.row(firing().fingerprint)?.delivery_status).toBe("delivered");
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
  });

  test("overlapping instances and new episodes coalesce while the condition already has work", async () => {
    const f = fixture(); f.service.accept([firing()]); await f.service.settled();
    f.service.accept([firing({ fingerprint: "b".repeat(16) })]); await f.service.settled();
    f.service.accept([firing({ startsAt: "2026-09-15T06:00:00.000Z" })]); await f.service.settled();
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    f.db.exec("UPDATE turns SET status='done'");
    f.service.accept([firing({ startsAt: "2026-09-15T06:00:00.000Z" })]); await f.service.settled();
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 1 });
    f.service.accept([firing({ startsAt: "2026-09-15T07:00:00.000Z" })]); await f.service.settled();
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 2 });
  });

  test("native contact tests and resolved-first alerts never start agents", async () => {
    const f = fixture();
    f.service.accept([firing({ condition: "TestAlert" }), firing({ fingerprint: "b".repeat(16),
      status: "resolved", endsAt: "2026-09-15T05:30:00.000Z" })]);
    await f.service.settled();
    expect(f.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
  });

  test("ambiguous publication parks and a later duplicate never reposts", async () => {
    let attempts = 0;
    const f = fixture(async () => { attempts++; throw new GrafanaSlackError(false, "ambiguous_post"); });
    f.service.accept([firing()]); await f.service.settled();
    f.service.accept([firing()]); await f.service.settled();
    expect(attempts).toBe(1);
    expect(f.service.row(firing().fingerprint)?.delivery_status).toBe("parked");
    expect(f.observations.some(e => e.event === "grafana_alert_parked")).toBe(true);
  });

  test("startup only recovers dead owners and never retries an ambiguous first post", async () => {
    const f = fixture(); f.service.accept([firing()]); await f.service.settled();
    f.db.exec("UPDATE grafana_alerts SET root_ts=NULL,delivery_status='sending',owner_id='dead'");
    const recovered = new GrafanaAlerts(f.options); recovered.recover(); await recovered.settled();
    expect(recovered.row(firing().fingerprint)?.delivery_status).toBe("parked");
    expect(f.published).toHaveLength(1);
    f.db.exec("UPDATE grafana_alerts SET root_ts='1789452000.123456',delivery_status='sending',owner_id='owner'");
    recovered.recover(); await recovered.settled();
    expect(recovered.row(firing().fingerprint)?.delivery_status).toBe("sending");
    f.db.exec("UPDATE grafana_alerts SET owner_id='dead'");
    recovered.recover(); await recovered.settled();
    expect(f.published).toHaveLength(2);
    expect(recovered.row(firing().fingerprint)?.delivery_status).toBe("delivered");
  });

  test("raw Slack transport never blindly repeats an ambiguous bot post", async () => {
    const f = fixture(); f.service.accept([firing()]); await f.service.settled();
    let attempts = 0;
    const row = { ...f.service.row(firing().fingerprint)!, root_ts: null };
    await expect(publishGrafanaAlert({ token: "private", row, fetch: (async () => {
      attempts++; throw new Error("network"); }) as typeof fetch })).rejects.toMatchObject({ retryable: false, safeCode: "ambiguous_post" });
    expect(attempts).toBe(1);
  });

  test("rate-limited delivery retains Slack's required retry delay", async () => {
    const f = fixture(); f.service.accept([firing()]); await f.service.settled();
    await expect(publishGrafanaAlert({ token: "private", row: f.service.row(firing().fingerprint)!,
      fetch: (async () => Response.json({ ok: false, error: "ratelimited" }, {
        status: 429, headers: { "retry-after": "30" },
      })) as typeof fetch,
    })).rejects.toMatchObject({ retryable: true, safeCode: "rate_limited", retryAfterMs: 30_000 });
  });

  test("new alerts and recovery preserve the durable Slack cooldown, and drain can stop it", async () => {
    let attempts = 0, wake!: () => void, waiting!: () => void;
    const held = new Promise<void>(resolve => { wake = resolve; });
    const observed = new Promise<void>(resolve => { waiting = resolve; });
    const f = fixture(async () => { attempts++; throw new GrafanaSlackError(true, "rate_limited", 30_000); });
    (f.options as any).wait = async () => { waiting(); await held; };
    f.service.accept([firing()]); await observed;
    const until = f.service.row(firing().fingerprint)!.next_attempt_ms;
    expect(until).toBeGreaterThan(Date.now() + 29_000);
    f.service.accept([firing({ status: "resolved", endsAt: "2026-09-15T05:30:00.000Z" }), firing({ fingerprint: "b".repeat(16) })]);
    expect(f.service.row(firing().fingerprint)!.next_attempt_ms).toBe(until);
    expect(attempts).toBe(1);
    const stopped = f.service.stop(); wake(); await stopped;
    expect(attempts).toBe(1);
  });
});
