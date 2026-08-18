import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  createCaptureRequestHandler,
  loadCaptureIngressConfig,
  postCaptureToSlack,
  ProductionCaptureServices,
  startCaptureIngress,
  type Capture,
  type CaptureIngressConfig,
  type CaptureRouteConfig,
  type CaptureServices,
} from "../src/capture-ingress";
import {
  captureDb,
  claimCaptureEvent,
  createCaptureEvent,
  getCaptureEvent,
  recoverInterruptedCaptureDeliveries,
} from "../src/capture-state";
import { readBootId } from "../src/runtime-identity";

const bearerToken = "test-capture-token-with-at-least-24-characters";

function pebbleRoute(): CaptureRouteConfig {
  return {
    id: "pebble-index",
    path: "/pebble",
    label: "Pebble Index 01",
    adapter: "pebble-index",
    maxBodyBytes: 262_144,
    auth: { header: "Authorization", scheme: "Bearer", token: bearerToken },
    destination: {
      type: "slack",
      channelId: "C123",
      token: "xoxp-test-token-with-at-least-24-characters",
    },
  };
}

function config(route = pebbleRoute()): CaptureIngressConfig {
  return {
    server: { host: "127.0.0.1", port: 8080, healthPath: "/health", maxRequestBodyBytes: 1_048_576 },
    routes: [route],
  };
}

function pebbleRequest(fields: { transcription?: string; recordedAt?: string; client?: string; audio?: File } = {}) {
  const form = new FormData();
  form.set("transcription", fields.transcription ?? "Remember to review the capture architecture");
  form.set("recordedAt", fields.recordedAt ?? "1787000000123");
  form.set("client", fields.client ?? "ring");
  if (fields.audio) form.set("audio", fields.audio);
  return new Request("http://capture.test/pebble", {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
    body: form,
  });
}

test("Pebble multipart transcripts are authenticated, normalized, and acknowledged quickly", async () => {
  let accepted: Capture | null = null;
  const services: CaptureServices = {
    accept: async (_route, capture) => {
      accepted = capture;
      return { eventId: capture.eventId, duplicate: false, status: "queued" };
    },
  };
  const response = await createCaptureRequestHandler(config(), services)(pebbleRequest());
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, status: "queued" });
  expect(accepted).toMatchObject({
    kind: "text",
    routeId: "pebble-index",
    text: "Remember to review the capture architecture",
    recordedAtMs: 1_787_000_000_123,
    client: "ring",
  });
});

test("Pebble duplicate deliveries have a stable event identity", async () => {
  const eventIds: string[] = [];
  const services: CaptureServices = {
    accept: async (_route, capture) => {
      eventIds.push(capture.eventId);
      return { eventId: capture.eventId, duplicate: eventIds.length > 1, status: "delivered" };
    },
  };
  const handler = createCaptureRequestHandler(config(), services);
  expect((await handler(pebbleRequest())).status).toBe(202);
  expect((await handler(pebbleRequest())).status).toBe(200);
  expect(eventIds[0]).toBe(eventIds[1]);
});

test("capture routes reject bad auth, audio on transcript-only routes, and oversized bodies", async () => {
  const services: CaptureServices = {
    accept: async () => { throw new Error("must not accept invalid requests"); },
  };
  const handler = createCaptureRequestHandler(config(), services);
  const unauthorized = pebbleRequest();
  unauthorized.headers.set("authorization", "Bearer wrong-token");
  expect((await handler(unauthorized)).status).toBe(401);

  const withAudio = pebbleRequest({ audio: new File([new Uint8Array([1, 2, 3])], "recording.m4a", { type: "audio/mp4" }) });
  const audioResponse = await handler(withAudio);
  expect(audioResponse.status).toBe(422);
  expect(await audioResponse.json()).toMatchObject({ error: expect.stringContaining("transcript-only") });

  const oversized = pebbleRequest();
  oversized.headers.set("content-length", "262145");
  expect((await handler(oversized)).status).toBe(413);
});

test("raw-body routes preserve the existing authenticated audio file sink idempotently", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-audio-"));
  const route: CaptureRouteConfig = {
    id: "watch-audio",
    path: "/audio",
    label: "Watch audio",
    adapter: "raw-body",
    maxBodyBytes: 1024,
    auth: { header: "Authorization", scheme: "Bearer", token: bearerToken },
    destination: { type: "directory", directory, filenamePrefix: "audio" },
  };
  const services = new ProductionCaptureServices(config(route));
  writeFileSync(join(directory, ".audio-stale.tmp"), "partial");
  services.recover();
  expect(readdirSync(directory)).toEqual([]);
  const handler = createCaptureRequestHandler(config(route), services);
  const request = () => new Request("http://capture.test/audio", {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "audio/mp4" },
    body: new Uint8Array([1, 2, 3, 4]),
  });
  const first = await handler(request());
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, status: "stored", bytes: 4 });
  const duplicate = await handler(request());
  expect(duplicate.status).toBe(201);
  expect(await duplicate.json()).toMatchObject({ accepted: true, duplicate: true, status: "stored", bytes: 4 });
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^audio-[a-f0-9]{64}\.m4a$/);
  expect([...readFileSync(join(directory, files[0]))]).toEqual([1, 2, 3, 4]);
  await services.close();
  rmSync(directory, { recursive: true, force: true });
});

test("raw-body output failures return a retryable response without an unhandled stream error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-audio-failure-"));
  const route: CaptureRouteConfig = {
    id: "watch-audio",
    path: "/audio",
    label: "Watch audio",
    adapter: "raw-body",
    maxBodyBytes: 1024,
    auth: { header: "Authorization", scheme: "Bearer", token: bearerToken },
    destination: { type: "directory", directory, filenamePrefix: "audio" },
  };
  const services: CaptureServices = {
    accept: async () => { throw new Error("a failed stream must not be accepted"); },
  };
  const response = await createCaptureRequestHandler(config(route), services, {
    createRawBodyWriter: (() => new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(Object.assign(new Error("disk full"), { code: "ENOSPC" })), 0);
      },
    })) as any,
  })(new Request("http://capture.test/audio", {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "audio/mp4" },
    body: new Uint8Array([1, 2, 3, 4]),
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "capture_unavailable" });
  await Bun.sleep(5);
  expect(readdirSync(directory)).toEqual([]);
  rmSync(directory, { recursive: true, force: true });
});

test("Slack delivery uses a deterministic client id and disables transcript markup", async () => {
  let posted: any = null;
  const event: any = {
    destination_channel: "C123",
    message_text: "captured <@U123>",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  };
  const ts = await postCaptureToSlack({
    event,
    token: "xoxp-test",
    fetch: async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return Response.json({ ok: true, ts: "1787000000.000001" });
    },
  });
  expect(ts).toBe("1787000000.000001");
  expect(posted).toMatchObject({
    channel: "C123",
    text: "captured <@U123>",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
    mrkdwn: false,
    unfurl_links: false,
  });
});

let releaseDatabaseTestLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  captureDb.query("DELETE FROM capture_delivery_gate").run();
  captureDb.query("DELETE FROM capture_events").run();
});

afterEach(() => {
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

test("Slack captures are durable before acknowledgement and complete in the background", async () => {
  const route = pebbleRoute();
  const requests: any[] = [];
  const services = new ProductionCaptureServices(config(route), async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, ts: "1787000000.000002" });
  });
  const response = await createCaptureRequestHandler(config(route), services)(pebbleRequest());
  expect(response.status).toBe(202);
  const responseBody: any = await response.json();
  expect(getCaptureEvent(responseBody.event_id)).not.toBeNull();
  for (let attempt = 0; attempt < 100 && getCaptureEvent(responseBody.event_id)?.status !== "delivered"; attempt += 1) {
    await Bun.sleep(5);
  }
  expect(getCaptureEvent(responseBody.event_id)).toMatchObject({
    status: "delivered",
    slack_message_ts: "1787000000.000002",
    destination_channel: "C123",
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].text).toContain("Remember to review the capture architecture");
  await services.close();
});

test("transcripts that Slack would truncate are rejected before durable acceptance", async () => {
  let requests = 0;
  const route = pebbleRoute();
  const services = new ProductionCaptureServices(config(route), async () => {
    requests += 1;
    return Response.json({ ok: true, ts: "unexpected" });
  });
  const response = await createCaptureRequestHandler(config(route), services)(pebbleRequest({
    transcription: "x".repeat(40_000),
  }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("40,000-character limit") });
  expect(requests).toBe(0);
  await services.close();
});

test("the Slack worker retries rate limits and parks permanent API failures", async () => {
  const route = pebbleRoute();
  let transientRequests = 0;
  const retryStartedAt = Date.now();
  const retrying = new ProductionCaptureServices(config(route), async () => {
    transientRequests += 1;
    if (transientRequests === 1) return new Response("", { status: 429 });
    return Response.json({ ok: true, ts: "1787000000.000003" });
  });
  const retryResponse: any = await (await createCaptureRequestHandler(config(route), retrying)(pebbleRequest({
    transcription: "retry this capture",
  }))).json();
  for (let attempt = 0; attempt < 300 && getCaptureEvent(retryResponse.event_id)?.status !== "delivered"; attempt += 1) {
    await Bun.sleep(5);
  }
  expect(getCaptureEvent(retryResponse.event_id)).toMatchObject({ status: "delivered", delivery_attempts: 2 });
  expect(Date.now() - retryStartedAt).toBeGreaterThanOrEqual(900);
  expect(transientRequests).toBe(2);
  await retrying.close();

  const parking = new ProductionCaptureServices(config(route), async () => Response.json({ ok: false, error: "invalid_auth" }));
  const parkResponse: any = await (await createCaptureRequestHandler(config(route), parking)(pebbleRequest({
    transcription: "park this capture",
  }))).json();
  for (let attempt = 0; attempt < 100 && getCaptureEvent(parkResponse.event_id)?.status !== "parked"; attempt += 1) {
    await Bun.sleep(5);
  }
  expect(getCaptureEvent(parkResponse.event_id)).toMatchObject({ status: "parked", delivery_error: "invalid_auth" });
  await parking.close();
});

test("restart recovery reuses the deterministic Slack client message id after an ambiguous post", async () => {
  const eventId = "ambiguous-capture";
  const clientId = "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee";
  createCaptureEvent({
    eventId,
    routeId: "pebble-index",
    destinationChannel: "C123",
    messageText: "possibly already posted",
    recordedAtMs: 1_787_000_000_000,
    sourceClient: "ring",
    clientMessageId: clientId,
  });
  expect(claimCaptureEvent(eventId, Date.now(), {
    pid: 2_147_483_647,
    bootId: readBootId(),
    startTicks: "1",
  })).not.toBeNull();
  expect(recoverInterruptedCaptureDeliveries()).toBe(1);
  let postedClientId = "";
  const services = new ProductionCaptureServices(config(), async (_url, init) => {
    postedClientId = JSON.parse(String(init?.body)).client_msg_id;
    return Response.json({ ok: true, ts: "1787000000.000004" });
  });
  services.recover();
  for (let attempt = 0; attempt < 100 && getCaptureEvent(eventId)?.status !== "delivered"; attempt += 1) await Bun.sleep(5);
  expect(postedClientId).toBe(clientId);
  expect(getCaptureEvent(eventId)?.status).toBe("delivered");
  await services.close();
});

test("a post-claim state failure terminates the worker so its lease becomes recoverable", async () => {
  const deadOwner = {
    pid: 2_147_483_647,
    bootId: readBootId(),
    startTicks: "1",
  };
  let reportFatal!: (error: unknown) => void;
  const fatal = new Promise<unknown>((resolveFatal) => { reportFatal = resolveFatal; });
  const services = new ProductionCaptureServices(
    config(),
    async () => Response.json({ ok: false, error: "invalid_auth" }),
    {
      deliveryOwner: deadOwner,
      beforePersistence(phase) {
        if (phase === "park") throw new Error("capture state disk failed");
      },
      onFatal: reportFatal,
    },
  );
  const accepted = await services.accept(pebbleRoute(), {
    kind: "text",
    eventId: "fatal-state-transition",
    routeId: "pebble-index",
    label: "Pebble Index 01",
    text: "must remain recoverable",
    recordedAtMs: 1_787_000_000_000,
    client: "ring",
  });
  const fatalError = await Promise.race([
    fatal,
    Bun.sleep(1_000).then(() => { throw new Error("fatal worker callback timed out"); }),
  ]);
  expect(String(fatalError)).toContain("capture state disk failed");
  expect(getCaptureEvent(accepted.eventId)).toMatchObject({
    status: "sending",
    delivery_owner_pid: deadOwner.pid,
  });
  expect(recoverInterruptedCaptureDeliveries()).toBe(1);
  expect(getCaptureEvent(accepted.eventId)).toMatchObject({ status: "pending" });
  await services.close();
});

test("Slack delivery concurrency is bounded", async () => {
  const route = pebbleRoute();
  let active = 0;
  let maximumActive = 0;
  const services = new ProductionCaptureServices(config(route), async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Bun.sleep(25);
    active -= 1;
    return Response.json({ ok: true, ts: `${Date.now()}.000001` });
  });
  const eventIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const accepted = await services.accept(route, {
      kind: "text",
      eventId: `bounded-${index}`,
      routeId: route.id,
      label: route.label,
      text: `bounded capture ${index}`,
      recordedAtMs: 1_787_000_000_000 + index,
      client: "ring",
    });
    eventIds.push(accepted.eventId);
  }
  for (let attempt = 0; attempt < 100 && eventIds.some((id) => getCaptureEvent(id)?.status !== "delivered"); attempt += 1) {
    await Bun.sleep(10);
  }
  expect(maximumActive).toBe(2);
  expect(eventIds.every((id) => getCaptureEvent(id)?.status === "delivered")).toBe(true);
  await services.close();
});

test("Slack requests abort instead of hanging the capture service", async () => {
  const event: any = {
    destination_channel: "C123",
    message_text: "timeout",
    client_msg_id: "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee",
  };
  await expect(postCaptureToSlack({
    event,
    token: "xoxp-test",
    timeoutMs: 5,
    fetch: async (_url, init) => {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      return Response.json({ ok: true });
    },
  })).rejects.toThrow("Slack transport failed");
});

test("the production config loader and loopback server enforce streamed route limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-loopback-"));
  const credentials = join(directory, "credentials");
  const output = join(directory, "output");
  const configPath = join(directory, "capture.toml");
  mkdirSync(credentials);
  mkdirSync(output);
  writeFileSync(join(credentials, "watch_audio"), `${bearerToken}\n`, { mode: 0o600 });
  chmodSync(join(credentials, "watch_audio"), 0o600);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(configPath, [
    "[server]",
    'host = "127.0.0.1"',
    `port = ${port}`,
    'health_path = "/health"',
    "max_request_body_bytes = 4",
    "[[routes]]",
    'id = "watch-audio"',
    'path = "/audio"',
    'label = "Watch audio"',
    'adapter = "raw-body"',
    "max_body_bytes = 4",
    'auth_token_credential = "watch_audio"',
    "[routes.destination]",
    'type = "directory"',
    `directory = ${JSON.stringify(output)}`,
    'filename_prefix = "audio"',
  ].join("\n"));
  const previousCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = credentials;
  const ingress = startCaptureIngress(loadCaptureIngressConfig(configPath));
  try {
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    const oversized = await fetch(`http://127.0.0.1:${port}/audio`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/octet-stream" },
      body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    expect(readdirSync(output)).toEqual([]);
    const compatible = await fetch(`http://127.0.0.1:${port}/audio`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}`, "content-type": "text/plain" },
      body: "ok",
    });
    expect(compatible.status).toBe(201);
    expect(readdirSync(output)[0]).toEndWith(".txt");
  } finally {
    await ingress.stop("test");
    if (previousCredentialsDirectory === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousCredentialsDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("graceful ingress stop lets an active slow audio upload finish exactly once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-graceful-stop-"));
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const route: CaptureRouteConfig = {
    id: "watch-audio",
    path: "/audio",
    label: "Watch audio",
    adapter: "raw-body",
    maxBodyBytes: 1024,
    auth: { header: "Authorization", scheme: "Bearer", token: bearerToken },
    destination: { type: "directory", directory, filenamePrefix: "audio" },
  };
  const ingress = startCaptureIngress({
    server: { host: "127.0.0.1", port, healthPath: "/health", maxRequestBodyBytes: 1024 },
    routes: [route],
  });
  let releaseTail!: () => void;
  const tailReleased = new Promise<void>((resolveTail) => { releaseTail = resolveTail; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      void tailReleased.then(() => {
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      });
    },
  });
  const upload = fetch(`http://127.0.0.1:${port}/audio`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "audio/mp4" },
    body,
  } as any);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const temporary = readdirSync(directory).find((filename) => filename.endsWith(".tmp"));
    if (temporary && readFileSync(join(directory, temporary)).length > 0) break;
    await Bun.sleep(5);
  }
  expect(readdirSync(directory).some((filename) => filename.endsWith(".tmp"))).toBe(true);

  let stopped = false;
  const stopping = ingress.stop("deploy-test").then(() => { stopped = true; });
  await Bun.sleep(25);
  expect(stopped).toBe(false);
  releaseTail();
  const response = await upload;
  expect(response.status).toBe(201);
  await stopping;

  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^audio-[a-f0-9]{64}\.m4a$/);
  expect([...readFileSync(join(directory, files[0]))]).toEqual([1, 2, 3, 4]);
  rmSync(directory, { recursive: true, force: true });
});

test("concurrent fatal workers share one graceful shutdown while an upload finishes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-reentrant-stop-"));
  const port = 40_000 + Math.floor(Math.random() * 10_000);
  const audioRoute: CaptureRouteConfig = {
    id: "watch-audio",
    path: "/audio",
    label: "Watch audio",
    adapter: "raw-body",
    maxBodyBytes: 1024,
    auth: { header: "Authorization", scheme: "Bearer", token: bearerToken },
    destination: { type: "directory", directory, filenamePrefix: "audio" },
  };
  const textRoute = pebbleRoute();
  let releaseSlackResponses!: () => void;
  const slackResponses = new Promise<void>((resolve) => { releaseSlackResponses = resolve; });
  let slackRequests = 0;
  let fatalReports = 0;
  let ingress!: ReturnType<typeof startCaptureIngress>;
  let primaryStop!: Promise<void>;
  let repeatedStop!: Promise<void>;
  ingress = startCaptureIngress({
    server: { host: "127.0.0.1", port, healthPath: "/health", maxRequestBodyBytes: 1024 },
    routes: [audioRoute, textRoute],
  }, {
    fetch: async () => {
      slackRequests += 1;
      if (slackRequests === 2) releaseSlackResponses();
      await slackResponses;
      return Response.json({ ok: false, error: "invalid_auth" });
    },
    dependencies: {
      beforePersistence(phase) {
        if (phase === "park") throw new Error("concurrent capture state failure");
      },
      onFatal() {
        fatalReports += 1;
        primaryStop = ingress.stop("fatal-worker");
        repeatedStop = ingress.stop("repeated-fatal");
      },
    },
  });

  let releaseTail!: () => void;
  const tailReleased = new Promise<void>((resolve) => { releaseTail = resolve; });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      void tailReleased.then(() => {
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      });
    },
  });
  const upload = fetch(`http://127.0.0.1:${port}/audio`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}`, "content-type": "audio/mp4" },
    body,
  } as any);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (readdirSync(directory).some((filename) => filename.endsWith(".tmp"))) break;
    await Bun.sleep(5);
  }

  const captures = ["first", "second"].map((text, index) => {
    const form = new FormData();
    form.set("transcription", text);
    form.set("recordedAt", String(1_787_000_000_000 + index));
    form.set("client", "ring");
    return fetch(`http://127.0.0.1:${port}/pebble`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearerToken}` },
      body: form,
    });
  });
  expect((await Promise.all(captures)).map((response) => response.status)).toEqual([202, 202]);
  for (let attempt = 0; attempt < 100 && fatalReports === 0; attempt += 1) await Bun.sleep(5);

  expect(fatalReports).toBe(1);
  expect(primaryStop).toBe(repeatedStop);
  let primaryStopped = false;
  let repeatedStopped = false;
  void primaryStop.then(() => { primaryStopped = true; });
  void repeatedStop.then(() => { repeatedStopped = true; });
  await Bun.sleep(25);
  expect([primaryStopped, repeatedStopped]).toEqual([false, false]);

  releaseTail();
  expect((await upload).status).toBe(201);
  await Promise.all([primaryStop, repeatedStop]);
  expect([primaryStopped, repeatedStopped]).toEqual([true, true]);
  expect(readdirSync(directory).filter((filename) => !filename.endsWith(".tmp"))).toHaveLength(1);
  rmSync(directory, { recursive: true, force: true });
});
