import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createKeyedTaskScheduler,
  retryTransientDatabaseOperation,
  runDurableNoticeWorker,
} from "../src/durable-notice-worker";

test("keyed task scheduling shares one live capture execution", async () => {
  const schedule = createKeyedTaskScheduler();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const run = async () => { executions += 1; await held; };

  const original = schedule("capture-sinks:C1:123.456", run);
  const retry = schedule("capture-sinks:C1:123.456", run);
  expect(retry).toBe(original);
  release();
  await Promise.all([original, retry]);

  expect(executions).toBe(1);
});

describe("retryTransientDatabaseOperation", () => {
  test("keeps retrying a real SQLite write after its busy timeout expires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-ingress-lock-"));
    const path = join(dir, "ingress.db");
    const claimantDb = new Database(path, { create: true });
    const lockerDb = new Database(path);
    try {
      claimantDb.exec("PRAGMA busy_timeout=5");
      claimantDb.exec("CREATE TABLE claims (id TEXT PRIMARY KEY)");
      lockerDb.exec("BEGIN IMMEDIATE");
      let released = false;

      const result = await retryTransientDatabaseOperation({
        operation: () => claimantDb.query("INSERT INTO claims VALUES ('slack-event')").run(),
        wait: async () => {
          if (!released) {
            lockerDb.exec("ROLLBACK");
            released = true;
          }
        },
      });

      expect(result.stopped).toBe(false);
      expect(claimantDb.query("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 1 });
    } finally {
      try { lockerDb.exec("ROLLBACK"); } catch {}
      lockerDb.close();
      claimantDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runDurableNoticeWorker", () => {
  test("durably schedules a transient retry and keeps retrying live", async () => {
    let now = 1_000;
    let deliveryAttempts = 0;
    let persistenceFailures = 2;
    const waits: number[] = [];
    const row = {
      noticeStatus: "pending" as "pending" | "sending" | "delivered" | "parked",
      attempts: 0,
      nextAttemptMs: 0 as number | null,
    };

    const outcome = await runDurableNoticeWorker({
      load: () => ({ ...row }),
      claim: (claimNow) => {
        if (row.noticeStatus !== "pending" || (row.nextAttemptMs || 0) > claimNow) return null;
        row.noticeStatus = "sending";
        row.attempts += 1;
        return { ...row };
      },
      deliver: async () => {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) throw Object.assign(new Error("temporary"), { code: "transient" });
      },
      markDelivered: () => { row.noticeStatus = "delivered"; },
      markRetry: (_error, nextAttemptMs) => {
        if (persistenceFailures-- > 0) throw new Error("database is locked");
        row.noticeStatus = "pending";
        row.nextAttemptMs = nextAttemptMs;
      },
      markParked: () => { row.noticeStatus = "parked"; },
      isRetryable: (error) => (error as any).code === "transient",
      wait: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      now: () => now,
      initialDelayMs: 100,
    });

    expect(outcome).toBe("delivered");
    expect(deliveryAttempts).toBe(2);
    expect(row).toMatchObject({ noticeStatus: "delivered", attempts: 2 });
    expect(waits).toEqual([50, 100, 100]);
  });

  test("parks permanent Slack errors instead of looping", async () => {
    const row = {
      noticeStatus: "pending" as "pending" | "sending" | "delivered" | "parked",
      attempts: 0,
      nextAttemptMs: 0 as number | null,
    };
    const outcome = await runDurableNoticeWorker({
      load: () => ({ ...row }),
      claim: () => {
        row.noticeStatus = "sending";
        row.attempts += 1;
        return { ...row };
      },
      deliver: async () => { throw new Error("missing_scope"); },
      markDelivered: () => { row.noticeStatus = "delivered"; },
      markRetry: () => { row.noticeStatus = "pending"; },
      markParked: () => { row.noticeStatus = "parked"; },
      isRetryable: () => false,
      wait: async () => {},
    });

    expect(outcome).toBe("permanent_failure");
    expect(row.noticeStatus).toBe("parked");
    expect(row.attempts).toBe(1);
  });

  test("does not park a delivered notice when durable completion fails", async () => {
    let parked = false;
    const row = {
      noticeStatus: "pending" as "pending" | "sending" | "delivered" | "parked",
      attempts: 0,
      nextAttemptMs: 0 as number | null,
    };
    const durableError = Object.assign(new Error("simulated durable transition failure"), {
      code: "SQLITE_CORRUPT",
    });

    await expect(runDurableNoticeWorker({
      load: () => ({ ...row }),
      claim: () => {
        row.noticeStatus = "sending";
        row.attempts += 1;
        return { ...row };
      },
      deliver: async () => {},
      markDelivered: () => { throw durableError; },
      markRetry: () => { row.noticeStatus = "pending"; },
      markParked: () => { parked = true; row.noticeStatus = "parked"; },
      isRetryable: () => false,
      wait: async () => {},
    })).rejects.toBe(durableError);

    expect(parked).toBe(false);
    expect(row.noticeStatus).toBe("sending");
  });

  test("retries transient load and claim failures without a restart", async () => {
    let loadFailures = 2;
    let claimFailures = 2;
    let delivered = false;
    const waits: number[] = [];
    const row = {
      noticeStatus: "pending" as "pending" | "sending" | "delivered" | "parked",
      attempts: 0,
      nextAttemptMs: 0 as number | null,
    };

    const outcome = await runDurableNoticeWorker({
      load: () => {
        if (loadFailures-- > 0) throw new Error("database is locked");
        return { ...row };
      },
      claim: () => {
        if (claimFailures-- > 0) throw Object.assign(new Error("busy"), { code: "SQLITE_BUSY" });
        row.noticeStatus = "sending";
        row.attempts += 1;
        return { ...row };
      },
      deliver: async () => {},
      markDelivered: () => { row.noticeStatus = "delivered"; delivered = true; },
      markRetry: () => {},
      markParked: () => {},
      isRetryable: () => false,
      wait: async (milliseconds) => { waits.push(milliseconds); },
    });

    expect(outcome).toBe("delivered");
    expect(delivered).toBe(true);
    expect(waits).toEqual([50, 100, 50, 100]);
  });

  test("resumes a SQLite claim after a real writer lock clears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "concierge-notice-lock-"));
    const path = join(dir, "notice.db");
    const workerDb = new Database(path, { create: true });
    const lockerDb = new Database(path);
    try {
      workerDb.exec("PRAGMA busy_timeout=5");
      workerDb.exec("CREATE TABLE notices (id INTEGER PRIMARY KEY, status TEXT, attempts INTEGER)");
      workerDb.query("INSERT INTO notices VALUES (1, 'pending', 0)").run();
      lockerDb.exec("BEGIN IMMEDIATE");
      lockerDb.query("UPDATE notices SET attempts=attempts WHERE id=1").run();
      let released = false;

      const outcome = await runDurableNoticeWorker({
        load: () => {
          const row = workerDb.query("SELECT status, attempts FROM notices WHERE id=1").get() as any;
          return { noticeStatus: row.status, attempts: row.attempts, nextAttemptMs: 0 };
        },
        claim: () => {
          workerDb.query("UPDATE notices SET status='sending', attempts=attempts+1 WHERE id=1 AND status='pending'").run();
          const row = workerDb.query("SELECT status, attempts FROM notices WHERE id=1").get() as any;
          return row.status === "sending"
            ? { noticeStatus: row.status, attempts: row.attempts, nextAttemptMs: 0 }
            : null;
        },
        deliver: async () => {},
        markDelivered: () => workerDb.query("UPDATE notices SET status='delivered' WHERE id=1").run(),
        markRetry: () => {},
        markParked: () => {},
        isRetryable: () => false,
        wait: async () => {
          if (!released) {
            lockerDb.exec("ROLLBACK");
            released = true;
          }
        },
      });

      expect(outcome).toBe("delivered");
      expect((workerDb.query("SELECT status, attempts FROM notices WHERE id=1").get() as any))
        .toEqual({ status: "delivered", attempts: 1 });
    } finally {
      try { lockerDb.exec("ROLLBACK"); } catch {}
      lockerDb.close();
      workerDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
