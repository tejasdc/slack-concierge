import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DeterministicSlackNotifier,
  notificationClientMessageId,
  notificationDigest,
  renderNotification,
  SlackNotificationAmbiguousError,
  validateNotificationProjection,
} from "../../../deployment-control/kernel/notifier";
import type {
  DeploymentNotificationRow,
  NotifierTargetRow,
} from "../../../deployment-control/kernel/state";

const INCIDENT = "12345678-1234-4234-8234-123456789abc";
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const INVOCATION = "c".repeat(32);
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config() {
  const directory = mkdtempSync(join(tmpdir(), "concierge-notifier-"));
  scratch.push(directory);
  const configPath = join(directory, "slack.toml");
  writeFileSync(configPath, `bot_token = "${["xoxb", "fixture-token"].join("-")}"\n`);
  return configPath;
}

function target(): NotifierTargetRow {
  return {
    target: "concierge",
    slack_channel_id: "C-project",
    slack_channel_name: "slack-concierge",
    registry_code_path: "/root/workspace/slack-concierge",
    bot_user_id: "U-bot",
    preflight_evidence_json: "{}",
    preflight_at: "2026-08-24 00:00:00",
    created_at: "2026-08-24 00:00:00",
    updated_at: "2026-08-24 00:00:00",
  };
}

function restoredProjection() {
  return validateNotificationProjection("runtime_restored", {
    incident_id: INCIDENT,
    candidate_commit: COMMIT_A,
    restored_commit: COMMIT_B,
    service_invocation_id: INVOCATION,
    capture_probe: "functional health passed",
    service_probe: "functional health passed",
    admission_state: "released",
    reason_code: "candidate_health_failed",
  });
}

function notification(): DeploymentNotificationRow {
  const projection = restoredProjection();
  return {
    id: "notification-1",
    target: "concierge",
    incident_id: INCIDENT,
    kind: "runtime_restored",
    payload_json: JSON.stringify(projection),
    payload_digest: notificationDigest("runtime_restored", projection),
    client_msg_id: notificationClientMessageId(INCIDENT, "runtime_restored"),
    status: "sending",
    root_alert_id: null,
    slack_ts: null,
    send_started_at: "2026-08-24 00:00:00",
    error: null,
    created_at: "2026-08-24 00:00:00",
    updated_at: "2026-08-24 00:00:00",
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("deterministic deployment notifier", () => {
  test("typed projections reject caller-controlled Slack and markup fields", () => {
    expect(() => validateNotificationProjection("runtime_restored", {
      ...restoredProjection(),
      channel: "C-other",
    })).toThrow("fields are invalid");
    expect(() => validateNotificationProjection("repair_parked", {
      incident_id: INCIDENT,
      candidate_commit: COMMIT_A,
      admission_state: "held",
      reason_code: "<@channel>",
    })).toThrow("Park reason is invalid");
    expect(renderNotification("runtime_restored", restoredProjection())).not.toContain("<");
  });

  test("live preflight proves exact bot identity and message readback then deletes its fixture", async () => {
    let preflightText = "";
    const calls: Array<{ method: string; body: any }> = [];
    const notifier = new DeterministicSlackNotifier(config(), {
      now: () => new Date("2026-08-24T00:01:00Z"),
      async fetch(url, init) {
        const method = url.split("/").at(-1)!;
        const body = JSON.parse(String(init.body));
        calls.push({ method, body });
        if (method === "auth.test") return response({ ok: true, user_id: "U-bot" });
        if (method === "chat.postMessage") {
          preflightText = body.text;
          return response({ ok: true, ts: "1700000000.000001" });
        }
        if (method === "conversations.history") {
          return response({ ok: true, messages: [{ ts: "1700000000.000001", user: "U-bot", text: preflightText }] });
        }
        if (method === "chat.delete") return response({ ok: true });
        throw new Error(`Unexpected method ${method}`);
      },
    });
    const result = await notifier.preflight({ ...target(), bot_user_id: null, preflight_at: null });
    expect(result).toMatchObject({ bot_user_id: "U-bot", channel: "C-project" });
    expect(calls.map((call) => call.method)).toEqual([
      "auth.test", "chat.postMessage", "conversations.history", "chat.delete",
    ]);
    expect(calls[1].body).toMatchObject({ channel: "C-project", mrkdwn: false, link_names: false });
  });

  test("send derives channel and text internally and ambiguous transport reconciles without reposting", async () => {
    const expectedText = renderNotification("runtime_restored", restoredProjection());
    let calls = 0;
    const notifier = new DeterministicSlackNotifier(config(), {
      now: () => new Date("2026-08-24T00:01:00Z"),
      async fetch(url, init) {
        calls += 1;
        const method = url.split("/").at(-1)!;
        const body = JSON.parse(String(init.body));
        if (method === "chat.postMessage") {
          expect(body).toMatchObject({ channel: "C-project", text: expectedText, mrkdwn: false });
          throw new Error("connection reset after write");
        }
        if (method === "conversations.history") {
          return response({ ok: true, messages: [{ ts: "1700000000.000002", user: "U-bot", text: expectedText }] });
        }
        throw new Error(`Unexpected method ${method}`);
      },
    });
    await expect(notifier.send(target(), notification(), null)).rejects.toBeInstanceOf(SlackNotificationAmbiguousError);
    const reconciled = await notifier.reconcile(target(), notification(), null);
    expect(reconciled).toEqual({ outcome: "delivered", slack_ts: "1700000000.000002" });
    expect(calls).toBe(2);
  });
});
