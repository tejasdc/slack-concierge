import { expect, test } from "bun:test";
import { createCaptureRequestHandler, type CaptureIngressConfig, type CaptureServices } from "../src/capture-ingress";

const secret = "private-capture-credential-sentinel";
const privateText = "private-note-body-sentinel";
const callerId = "12ABCDEF-1234-4567-89AB-123456789ABC";
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const config: CaptureIngressConfig = {
  server: { host: "127.0.0.1", port: 0, healthPath: "/health", maxRequestBodyBytes: 262144 },
  queue: { host: "127.0.0.1", port: 0, token: secret },
  routes: ["thinkering", "pebble"].map(id => ({
    id, path: "/" + id, label: id, adapter: id === "thinkering" ? "thinkering" : "pebble-index",
    maxBodyBytes: 262144, auth: { header: "Authorization", scheme: "Bearer", token: secret },
    destination: { type: "slack", channelId: "D123" },
  })),
};
const body = { event_id: "thinkering-" + "a".repeat(64), text: privateText };
function request(headers: Record<string, string> = {}, path = "/thinkering", input: unknown = body) {
  return new Request("http://capture.test" + path, {
    method: "POST", headers: { authorization: "Bearer " + secret, "content-type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}
function recorder(services: CaptureServices = { async accept(_route, capture) {
  return { eventId: capture.eventId, duplicate: false, status: "queued", destinationKind: "slack", terminalReceipt: null };
} }) {
  const entries: Record<string, unknown>[] = [];
  return { entries, handle: createCaptureRequestHandler(config, services, {
    logRequest(level, event, fields) { entries.push({ level, event, ...fields }); },
  }) };
}

test("receive evidence precedes acceptance and request identity is independent of the caller", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const accepting = new Promise<void>(resolve => { entered = resolve; });
  const { entries, handle } = recorder({ async accept(_route, capture) {
    entered(); await waiting;
    return { eventId: capture.eventId, duplicate: false, status: "queued", destinationKind: "slack", terminalReceipt: null };
  } });
  const pending = handle(request({ "x-thinkering-request-id": callerId, "x-request-id": callerId }));
  await accepting;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ event: "capture_request_received", caller_request_id: callerId, route_id: "thinkering", method: "POST" });
  release();
  const response = await pending;
  const receipt = await response.json();
  expect(response.status).toBe(202);
  expect(response.headers.get("x-request-id")).toMatch(uuid);
  expect(response.headers.get("x-request-id")).not.toBe(callerId);
  expect(receipt).not.toHaveProperty("request_id");
  expect(entries).toHaveLength(2);
  expect(entries[1]).toMatchObject({
    event: "capture_request_completed", request_id: response.headers.get("x-request-id"), caller_request_id: callerId,
    outcome: "accepted", stage: "accepting", http_status: 202, event_id: receipt.event_id, duplicate: false, status: "queued",
  });
  expect(entries[0]!.request_id).toBe(entries[1]!.request_id);
  expect(entries[1]!.duration_ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(entries)).not.toContain(privateText);
  expect(JSON.stringify(entries)).not.toContain(secret);
});

test("absent, malformed, oversized and combined correlation headers cannot refuse or leak a valid capture", async () => {
  const { entries, handle } = recorder();
  const requestIds: string[] = [];
  for (const value of [undefined, "", privateText, "a".repeat(1000), callerId + ", " + callerId]) {
    const response = await handle(request(value === undefined ? {} : { "x-thinkering-request-id": value }));
    expect(response.status).toBe(202);
    requestIds.push(response.headers.get("x-request-id")!);
    expect(entries.at(-1)!.caller_request_id).toBeNull();
  }
  expect(new Set(requestIds).size).toBe(requestIds.length);
  expect(requestIds.every(id => uuid.test(id))).toBe(true);
  expect(JSON.stringify(entries)).not.toContain(privateText);
  expect(JSON.stringify(entries)).not.toContain("a".repeat(1000));
});

test("all expected refusals produce safe correlated metadata without accepting a capture", async () => {
  let accepts = 0;
  const { entries, handle } = recorder({ async accept() { accepts++; throw new Error(privateText); } });
  const headers = { "x-thinkering-request-id": callerId };
  const cases: [Request, number, string][] = [
    [request({ ...headers, authorization: "Bearer " + privateText }), 401, "unauthorized"],
    [request(headers, "/" + privateText + "?token=" + secret), 404, "not_found"],
    [new Request("http://capture.test/thinkering", { headers }), 405, "method_not_allowed"],
    [request({ ...headers, "content-type": "text/plain" }), 415, "unsupported_media_type"],
    [request(headers, "/thinkering", { ...body, unexpected: privateText }), 422, "invalid_capture"],
    [request(headers, "/thinkering", { ...body, text: "x".repeat(262144) }), 413, "body_too_large"],
    [new Request("http://capture.test/thinkering", { method: "POST", headers: { ...headers, authorization: "Bearer " + secret, "content-type": "application/json" }, body: "{" + privateText }), 400, "invalid_request"],
  ];
  for (const [input, status, failure] of cases) {
    const response = await handle(input);
    expect(response.status).toBe(status);
    expect(entries.at(-1)).toMatchObject({
      event: "capture_request_completed", caller_request_id: callerId, request_id: response.headers.get("x-request-id"),
      outcome: "rejected", http_status: status, failure_code: failure,
    });
    expect(entries.at(-1)).not.toHaveProperty("event_id");
  }
  expect(accepts).toBe(0);
  const unavailable = await handle(request(headers));
  expect(unavailable.status).toBe(503);
  expect(entries.at(-1)).toMatchObject({ outcome: "unavailable", stage: "accepting", failure_code: "capture_unavailable" });
  expect(JSON.stringify(entries)).not.toContain(privateText);
  expect(JSON.stringify(entries)).not.toContain(secret);
});

test("shared metadata also covers Pebble and does not expose journal receipt paths", async () => {
  const form = new FormData();
  form.set("transcription", privateText); form.set("recordedAt", "1789412150958"); form.set("client", "ring");
  const { entries, handle } = recorder({ async accept(_route, capture) {
    return { eventId: capture.eventId, duplicate: true, status: "delivered", destinationKind: "journal", terminalReceipt: "/private/" + privateText };
  } });
  const response = await handle(new Request("http://capture.test/pebble", {
    method: "POST", headers: { authorization: "Bearer " + secret, "x-thinkering-request-id": callerId }, body: form,
  }));
  expect(response.status).toBe(200);
  expect(entries.at(-1)).toMatchObject({ route_id: "pebble", outcome: "accepted", duplicate: true, status: "delivered", destination_kind: "journal", terminal_receipt: null });
  expect((await response.json()).terminal_receipt).toBe("/private/" + privateText);
  expect(JSON.stringify(entries)).not.toContain(privateText);
});

test("diagnostic writer failures preserve acceptance and health stays outside request diagnostics", async () => {
  const services: CaptureServices = { async accept(_route, capture) { return { eventId: capture.eventId, duplicate: false, status: "queued" }; } };
  const handle = createCaptureRequestHandler(config, services, { logRequest() { throw new Error("broken diagnostic sink"); } });
  expect((await handle(request())).status).toBe(202);
  expect((await handle(request({ authorization: "wrong" }))).status).toBe(401);
  const normal = recorder();
  const health = await normal.handle(new Request("http://capture.test/health"));
  expect(health.status).toBe(200);
  expect(health.headers.has("x-request-id")).toBe(false);
  expect(normal.entries).toEqual([]);
});
