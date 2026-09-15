import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acquireDatabaseTestLock } from "./db-lock";
import { createCaptureRequestHandler, ProductionCaptureServices, type CaptureIngressConfig } from "../src/capture-ingress";
import { captureDb, getCaptureEvent, claimCaptureEvent, markCaptureEventDelivered, recoverInterruptedCaptureDeliveries } from "../src/capture-state";
import { processIdentity } from "../src/runtime-identity";

const token = "thinkering-route-only-test-credential";
const inputId = `thinkering-${"a".repeat(64)}`;
const eventId = createHash("sha256").update(`thinkering:v1\0thinkering\0${inputId}\0`).digest("hex");
const config: CaptureIngressConfig = {
  server: { host: "127.0.0.1", port: 8080, healthPath: "/health", maxRequestBodyBytes: 262144 },
  queue: { host: "127.0.0.1", port: 8081, token },
  routes: [{ id: "thinkering", path: "/thinkering", label: "Thinkering", adapter: "thinkering",
    maxBodyBytes: 262144, auth: { header: "Authorization", scheme: "Bearer", token },
    destination: { type: "slack", channelId: "D123" }, bugReportChannel: "CREPORT" }],
};
let release: (() => void) | undefined;
beforeEach(async () => {
  release = await acquireDatabaseTestLock();
  captureDb.exec("DELETE FROM capture_events; DELETE FROM capture_delivery_gate;");
});
afterEach(() => release?.());

function request(body: unknown = { event_id: inputId, text: " A thought\n---\n**literal** <@U123> & 😀\n" }, headers: HeadersInit = {}, path = "/thinkering") {
  return new Request(`http://capture.test${path}`, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", ...headers,
  }, body: JSON.stringify(body) });
}
function handler() { return createCaptureRequestHandler(config, new ProductionCaptureServices(config)); }

test("explicit bug reports preserve full text and first accepted operational destination across retries", async () => {
  const handle = handler();
  const text = 'Thinkering bug report\nDescription 😀\n{"agentSessionId":"context-only","events":[1,2]}';
  const body = { event_id: inputId, text, kind: "bug_report" };
  expect((await handle(request(body))).status).toBe(202);
  expect(getCaptureEvent(eventId)).toMatchObject({ destination_channel: "CREPORT", source_client: "thinkering-bug-report",
    message_text: text + "\n\n— via thinkering", status: "pending" });
  expect(await (await handle(request(body))).json()).toMatchObject({ duplicate: true, status: "queued" });
  expect((await handle(request({ ...body, text: "changed" }))).status).toBe(409);
  expect((await handle(request({ ...body, session_id: "context-only" }))).status).toBe(422);
  expect((await handle(request({ ...body, kind: "thought" }))).status).toBe(422);
  expect((await handle(request({ event_id: inputId, text }))).status).toBe(200);
  expect(getCaptureEvent(eventId)?.destination_channel).toBe("CREPORT");
});

test("legacy accepted reports retain their DM receipt and never reroute on a later kind", async () => {
  const handle = handler();
  const text = "Legacy Thinkering bug report";
  await handle(request({ event_id: inputId, text }));
  const owner = processIdentity(process.pid);
  claimCaptureEvent(eventId, Date.now(), owner, "legacy-claim");
  markCaptureEventDelivered({ eventId, owner, claimId: "legacy-claim" }, { kind: "slack", slackMessageTs: "1787000000.000001" });
  const retry = await handle(request({ event_id: inputId, text, kind: "bug_report" }));
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ duplicate: true, status: "delivered", terminal_receipt: "1787000000.000001" });
  expect(getCaptureEvent(eventId)).toMatchObject({ destination_channel: "D123", source_client: "thinkering" });
});

test("new bug reports without an operational destination fail before acceptance", async () => {
  const unavailable = structuredClone(config);
  delete unavailable.routes[0]!.bugReportChannel;
  const response = await createCaptureRequestHandler(unavailable, new ProductionCaptureServices(unavailable))(
    request({ event_id: inputId, text: "Report", kind: "bug_report" }));
  expect(response.status).toBe(503);
  expect(getCaptureEvent(eventId)).toBeNull();
});

test("Thinkering persists exact text before acceptance, deduplicates concurrent retries, and rejects changed snapshots", async () => {
  const handle = handler();
  const text = " A thought\n---\n**literal** <@U123> & 😀\n";
  const results = await Promise.all([
    handle(request(undefined, { "x-thinkering-request-id": "12345678-1234-4567-89ab-123456789abc" })),
    handle(request(undefined, { "x-thinkering-request-id": "87654321-1234-4567-89ab-123456789abc" })),
  ]);
  expect(results[0]!.headers.get("x-request-id")).not.toBe(results[1]!.headers.get("x-request-id"));
  expect(results.map(result => result.status).sort()).toEqual([200, 202]);
  for (const result of results) expect(await result.json()).toMatchObject({ accepted: true, event_id: eventId, status: "queued", destination_kind: "slack", terminal_receipt: null });
  expect(getCaptureEvent(eventId)).toMatchObject({ message_text: `${text}\n\n— via thinkering`, destination_channel: "D123", source_client: "thinkering", status: "pending" });
  expect((captureDb.query("SELECT COUNT(*) AS n FROM capture_events").get() as {n:number}).n).toBe(1);
  expect((await handle(request({ event_id: inputId, text: "changed" }))).status).toBe(409);
  const owner = processIdentity(process.pid);
  claimCaptureEvent(eventId, Date.now(), owner, "test-claim");
  markCaptureEventDelivered({ eventId, owner, claimId: "test-claim" }, { kind: "slack", slackMessageTs: "1787000000.000001" });
  expect(await (await handle(request())).json()).toMatchObject({ duplicate: true, status: "delivered", terminal_receipt: "1787000000.000001" });
  expect((await handle(request({ event_id: inputId, text: "changed" }))).status).toBe(409);
  expect(getCaptureEvent(eventId)?.status).toBe("delivered");
});

test("concurrent conflicting Thinkering requests acknowledge only their canonical bytes", async () => {
  const handle = handler();
  const results = await Promise.all([handle(request({ event_id: inputId, text: "one" })), handle(request({ event_id: inputId, text: "two" }))]);
  expect(results.map(result => result.status).sort()).toEqual([202, 409]);
});

test("Thinkering rejects invalid auth, paths, media, fields, and limits without persistence", async () => {
  const handle = handler();
  for (const [body, code] of [[null, 422], [[], 422], [{ event_id: inputId, text: " " }, 422], [{ event_id: "bad", text: "x" }, 422], [{ event_id: inputId, text: "x", channel_id: "D999" }, 422], [{ event_id: inputId, text: "x".repeat(262144) }, 413]] as const) expect((await handle(request(body))).status).toBe(code);
  expect((await handle(request(undefined, { authorization: "Bearer wrong" }))).status).toBe(401);
  expect((await handle(request(undefined, { "content-type": "text/plain" }))).status).toBe(415);
  expect((await handle(request(undefined, {}, "/thinkering?destination=D999"))).status).toBe(404);
  expect((await handle(request(undefined, {}, "/thinkering/"))).status).toBe(404);
  expect((await handle(new Request("http://capture.test/thinkering"))).status).toBe(405);
  expect((await handle(new Request("http://capture.test/thinkering", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{" }))).status).toBe(400);
  expect((captureDb.query("SELECT COUNT(*) AS n FROM capture_events").get() as {n:number}).n).toBe(0);
});

test("Thinkering accepts long snapshots as one durable effect and returns no success on storage failure", async () => {
  const text = "long thought 😀\n".repeat(7000);
  expect((await handler()(request({ event_id: inputId, text }))).status).toBe(202);
  expect(getCaptureEvent(eventId)?.message_text).toBe(`${text}\n\n— via thinkering`);
  const failing = createCaptureRequestHandler(config, new ProductionCaptureServices(config, { beforePersistence() { throw new Error("storage unavailable"); } }));
  expect((await failing(request({ event_id: `thinkering-${"b".repeat(64)}`, text }))).status).toBe(503);
});

test("Thinkering dead sending owners park once, live owners remain owned, and delivered rows stay terminal", async () => {
  await handler()(request());
  const owner = processIdentity(process.pid);
  claimCaptureEvent(eventId, Date.now(), owner, "live");
  expect(recoverInterruptedCaptureDeliveries()).toBe(0);
  captureDb.query("UPDATE capture_events SET delivery_owner_boot_id='dead-boot' WHERE event_id=?").run(eventId);
  expect(recoverInterruptedCaptureDeliveries()).toBe(1);
  expect(getCaptureEvent(eventId)?.status).toBe("parked");
  expect(claimCaptureEvent(eventId)).toBeNull();
  expect(recoverInterruptedCaptureDeliveries()).toBe(0);
  expect(await (await handler()(request())).json()).toMatchObject({ duplicate: true, status: "parked" });
});
