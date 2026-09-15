import { afterEach, beforeEach, expect, test } from "bun:test";
import { db, upsertChannel, claimNextQueuedTurn, getChannel, getSessionById } from "../src/state";
import { deliverThinkeringReport } from "../src/thinkering-reports";
import { buildQueuedTurnInput } from "../src/queued-turn-execution";
import type { CaptureEventRow } from "../src/capture-state";
import { acquireDatabaseTestLock } from "./db-lock";

let release: (() => void) | undefined;
beforeEach(async () => {
  release = await acquireDatabaseTestLock();
  db.exec("DELETE FROM turns; DELETE FROM sessions; DELETE FROM channels; DELETE FROM slack_user_input_claims; DELETE FROM deployment_drain;");
  upsertChannel({ slack_channel_id: "CREPORT", slack_channel_name: "thinkering", group_name: null,
    name: "Thinkering", code_path: "/tmp/thinkering-report-test", vault_path: "/tmp/thinkering-report-test", provider_default: "cc-fast" });
});
afterEach(() => release?.());
const event = (): CaptureEventRow => ({ event_id: "a".repeat(64), route_id: "thinkering",
  source_client: "thinkering-bug-report", destination_channel: "CREPORT", client_msg_id: "test",
  message_text: 'Thinkering bug report\n{"sessionId":"untrusted-other-session"}\nExact diagnostic bytes 😀\n\n— via thinkering' } as CaptureEventRow);

test("report delivery uses the bot, retains full evidence, and admits one native operator turn without using reported identity", async () => {
  let posts = 0;
  const input = { event: event(), channel: "CREPORT", operatorUserId: "U1", botToken: "bot-only",
    wakeTurns() {}, fetch: (async (_url: any, init: any) => {
      posts++;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer bot-only");
      expect(JSON.parse(init.body).text).toContain(event().message_text);
      return Response.json({ ok: true, channel: "CREPORT", ts: "1789457000.000001" });
    }) as typeof fetch };
  expect(await deliverThinkeringReport(input)).toBe("1789457000.000001");
  expect(await deliverThinkeringReport(input)).toBe("1789457000.000001");
  expect(posts).toBe(1);
  const claim = claimNextQueuedTurn("report-owner")!;
  const native = buildQueuedTurnInput(claim, { client: {}, getChannel, getSessionById, baseSystemPromptForText: () => undefined });
  expect(native.turnKind).toBe("machine_alert");
  expect(native.threadTs).toBe("1789457000.000001");
  expect(native.prompt).toContain(JSON.stringify(event().message_text));
  expect(native.prompt).toContain("routine in-scope repair");
  expect(native.prompt).toContain("context-only");
  expect(native.session.agent_session_uuid).not.toBe("untrusted-other-session");
  expect(db.query("SELECT COUNT(*) AS n FROM slack_user_input_claims").get()).toEqual({ n: 0 });
});

test("unavailable or mismatched report destination cannot post to an alternate channel", async () => {
  let posts = 0;
  await expect(deliverThinkeringReport({ event: { ...event(), destination_channel: "DOTHER" }, channel: "CREPORT",
    operatorUserId: "U1", botToken: "bot-only", wakeTurns() {}, fetch: (async () => { posts++; return new Response(); }) as typeof fetch,
  })).rejects.toMatchObject({ retryable: false });
  expect(posts).toBe(0);
});
