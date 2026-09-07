import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createHmac } from "node:crypto";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  createCaptureRequestHandler,
  loadCaptureIngressConfig,
  ProductionCaptureServices,
  startCaptureIngress,
  type Capture,
  type CaptureIngressConfig,
  type CaptureRouteConfig,
  type CaptureServices,
} from "../src/capture-ingress";
import {
  claimCaptureEvent,
  captureDb,
  getCaptureEvent,
  markCaptureEventDelivered,
} from "../src/capture-state";
import { processIdentity } from "../src/runtime-identity";

const bearerToken = "test-capture-token-with-at-least-24-characters";
const pebbleFixture = JSON.parse(readFileSync(
  join(import.meta.dir, "fixtures/pebble-index-webhook-v1.json"),
  "utf8",
));

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
    },
    triggerDestinations: [
      {
        sourceTrigger: pebbleFixture.triggers.single,
        sourceWebhookVersion: pebbleFixture.webhook_version,
        destination: { type: "journal", sink: "journalmaxx-inbox" },
      },
      {
        sourceTrigger: pebbleFixture.triggers.double,
        sourceWebhookVersion: pebbleFixture.webhook_version,
        destination: { type: "slack", channelId: "C123" },
      },
      {
        sourceTrigger: pebbleFixture.triggers.test,
        sourceWebhookVersion: pebbleFixture.webhook_version,
        destination: { type: "slack", channelId: "C123" },
      },
    ],
  };
}

function config(route = pebbleRoute()): CaptureIngressConfig {
  return {
    server: { host: "127.0.0.1", port: 8080, healthPath: "/health", maxRequestBodyBytes: 1_048_576 },
    queue: { host: "127.0.0.1", port: 8081, token: bearerToken },
    routes: [route],
  };
}

function pebbleRequest(fields: {
  transcription?: string;
  recordedAt?: string;
  client?: string;
  audio?: File;
  trigger?: string;
  webhookVersion?: string;
} = {}) {
  const form = new FormData();
  form.set("transcription", fields.transcription ?? "Remember to review the capture architecture");
  form.set("recordedAt", fields.recordedAt ?? "1787000000123");
  form.set("client", fields.client ?? "ring");
  if (fields.audio) form.set("audio", fields.audio);
  const headers: Record<string, string> = { authorization: `Bearer ${bearerToken}` };
  if (fields.trigger !== undefined) headers[pebbleFixture.trigger_header] = fields.trigger;
  if (fields.webhookVersion !== undefined) headers[pebbleFixture.webhook_version_header] = fields.webhookVersion;
  return new Request("http://capture.test/pebble", {
    method: "POST",
    headers,
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

test("the committed Pebble fixture pins the official version and trigger contract", () => {
  expect(pebbleFixture).toEqual({
    source_repository: "https://github.com/coredevices/mobileapp",
    source_commit: "d52101ad3d8940c5aa392d6f224e774cb6f5ce84",
    source_path: "experimental/src/commonMain/kotlin/coredevices/ring/external/indexwebhook/IndexWebhookApi.kt",
    webhook_version_header: "X-Index-Webhook-Version",
    webhook_version: "1",
    trigger_header: "X-Index-Trigger",
    triggers: {
      single: "single-click-hold",
      double: "double-click-hold",
      test: "test-event",
    },
    test_transcription: "Index webhook test event",
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

test("the existing capture config exposes the signed GitHub deployment route without new credentials", async () => {
  const body = JSON.stringify({
    ref: "refs/heads/main",
    after: "a".repeat(40),
    repository: { full_name: "tejasdc/slack-concierge" },
  });
  const signature = `sha256=${createHmac("sha256", bearerToken).update(body).digest("hex")}`;
  const forwarded: unknown[] = [];
  const handler = createCaptureRequestHandler(config(), {
    accept: async () => { throw new Error("capture route should not run"); },
  }, {
    forwardDeploymentPush: async (push) => { forwarded.push(push); },
  });
  const response = await handler(new Request("http://capture.test/github/slack-concierge-deploy", {
    method: "POST",
    headers: {
      "x-github-event": "push",
      "x-github-delivery": "bootstrap-delivery",
      "x-hub-signature-256": signature,
    },
    body,
  }));
  expect(response.status).toBe(202);
  expect(forwarded).toEqual([{
    deliveryId: "bootstrap-delivery",
    repository: "tejasdc/slack-concierge",
    ref: "refs/heads/main",
    after: "a".repeat(40),
  }]);
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

test("Slack captures are durable and queued before acknowledgement without calling Slack", async () => {
  const route = pebbleRoute();
  const services = new ProductionCaptureServices(config(route));
  const response = await createCaptureRequestHandler(config(route), services)(pebbleRequest());
  expect(response.status).toBe(202);
  const responseBody: any = await response.json();
  expect(getCaptureEvent(responseBody.event_id)).toMatchObject({
    status: "pending",
    slack_message_ts: null,
    destination_channel: "C123",
    message_text: "Remember to review the capture architecture\n\n— via pebble",
  });
  await services.close();
});

test("versioned Pebble gestures durably select journal or Slack while canonical retries stay first-write-wins", async () => {
  const route = pebbleRoute();
  const services = new ProductionCaptureServices(config(route));
  const handler = createCaptureRequestHandler(config(route), services);
  const versioned = (trigger: string, recordedAt: string, transcription: string) => pebbleRequest({
    trigger,
    webhookVersion: pebbleFixture.webhook_version,
    recordedAt,
    transcription,
  });
  try {
    const singleResponse = await handler(versioned(
      pebbleFixture.triggers.single,
      "1787000000200",
      "  Preserve this thought  ",
    ));
    expect(singleResponse.status).toBe(202);
    const single: any = await singleResponse.json();
    expect(single).toMatchObject({
      accepted: true,
      duplicate: false,
      trigger: "single-click-hold",
      webhook_version: "1",
      destination_kind: "journal",
      terminal_receipt: null,
    });
    const singleRow = getCaptureEvent(single.event_id)!;
    expect(singleRow).toMatchObject({
      delivery_kind: "journal",
      destination_channel: "",
      journal_sink: "journalmaxx-inbox",
      source_trigger: "single-click-hold",
      source_webhook_version: "1",
      slack_message_ts: null,
      journal_file_path: null,
    });
    expect(singleRow.message_text).toBe([
      "---",
      `capture_id: ${JSON.stringify(single.event_id)}`,
      'source: "pebble-index"',
      'route_id: "pebble-index"',
      'recorded_at: "2026-08-17T20:53:20.200Z"',
      "recorded_at_ms: 1787000000200",
      'source_client: "ring"',
      'source_trigger: "single-click-hold"',
      'source_webhook_version: "1"',
      "---",
      "Preserve this thought",
      "",
    ].join("\n"));

    const conflictingRetry: any = await (await handler(versioned(
      pebbleFixture.triggers.double,
      "1787000000200",
      "Preserve this thought",
    ))).json();
    expect(conflictingRetry).toMatchObject({
      event_id: single.event_id,
      duplicate: true,
      trigger: "single-click-hold",
      webhook_version: "1",
      destination_kind: "journal",
    });

    const double: any = await (await handler(versioned(
      pebbleFixture.triggers.double,
      "1787000000201",
      "Intervene now",
    ))).json();
    const testEvent: any = await (await handler(versioned(
      pebbleFixture.triggers.test,
      "1787000000202",
      pebbleFixture.test_transcription,
    ))).json();
    const legacy: any = await (await handler(pebbleRequest({
      recordedAt: "1787000000203",
      transcription: "Legacy shortcut",
    }))).json();
    expect(getCaptureEvent(double.event_id)).toMatchObject({
      delivery_kind: "slack",
      destination_channel: "C123",
      source_trigger: "double-click-hold",
      source_webhook_version: "1",
    });
    expect(getCaptureEvent(testEvent.event_id)).toMatchObject({
      delivery_kind: "slack",
      source_trigger: "test-event",
      source_webhook_version: "1",
    });
    expect(getCaptureEvent(legacy.event_id)).toMatchObject({
      delivery_kind: "slack",
      source_trigger: null,
      source_webhook_version: null,
    });
    expect(captureDb.query("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({ count: 4 });
  } finally {
    await services.close();
  }
});

test("trigger-only Pebble gestures infer their configured version and preserve gesture routing", async () => {
  const services = new ProductionCaptureServices(config());
  const handler = createCaptureRequestHandler(config(), services);
  try {
    const singleResponse = await handler(pebbleRequest({
      trigger: pebbleFixture.triggers.single,
      recordedAt: "1787000000210",
      transcription: "Trigger-only journal capture",
    }));
    const doubleResponse = await handler(pebbleRequest({
      trigger: pebbleFixture.triggers.double,
      recordedAt: "1787000000211",
      transcription: "Trigger-only Slack capture",
    }));
    expect(singleResponse.status).toBe(202);
    expect(doubleResponse.status).toBe(202);
    const single: any = await singleResponse.json();
    const double: any = await doubleResponse.json();
    expect(single).toMatchObject({
      trigger: pebbleFixture.triggers.single,
      webhook_version: pebbleFixture.webhook_version,
      destination_kind: "journal",
    });
    expect(double).toMatchObject({
      trigger: pebbleFixture.triggers.double,
      webhook_version: pebbleFixture.webhook_version,
      destination_kind: "slack",
    });
    expect(getCaptureEvent(single.event_id)).toMatchObject({
      source_trigger: pebbleFixture.triggers.single,
      source_webhook_version: pebbleFixture.webhook_version,
      delivery_kind: "journal",
    });
    expect(getCaptureEvent(double.event_id)).toMatchObject({
      source_trigger: pebbleFixture.triggers.double,
      source_webhook_version: pebbleFixture.webhook_version,
      delivery_kind: "slack",
    });
  } finally {
    await services.close();
  }
});

test("version-only, unsupported, empty, and unknown Pebble source headers fail before persistence", async () => {
  const services = new ProductionCaptureServices(config());
  const handler = createCaptureRequestHandler(config(), services);
  try {
    for (const request of [
      pebbleRequest({ webhookVersion: pebbleFixture.webhook_version }),
      pebbleRequest({ trigger: "", webhookVersion: pebbleFixture.webhook_version }),
      pebbleRequest({ trigger: pebbleFixture.triggers.single, webhookVersion: "2" }),
      pebbleRequest({ trigger: "triple-click-hold" }),
      pebbleRequest({ trigger: "triple-click-hold", webhookVersion: pebbleFixture.webhook_version }),
    ]) {
      const response = await handler(request);
      expect(response.status).toBe(422);
    }
    expect(captureDb.query("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({ count: 0 });
  } finally {
    await services.close();
  }
});

test("capture acceptance logs expose canonical provenance without transcript text", async () => {
  const services = new ProductionCaptureServices(config());
  const transcript = "PRIVATE_TRANSCRIPT_MUST_NOT_APPEAR_IN_LOGS";
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line?: unknown) => { lines.push(String(line)); };
  try {
    const handler = createCaptureRequestHandler(config(), services);
    const first = await handler(pebbleRequest({
      transcription: transcript,
      trigger: pebbleFixture.triggers.single,
      webhookVersion: pebbleFixture.webhook_version,
    }));
    expect(first.status).toBe(202);
    const duplicate = await handler(pebbleRequest({
      transcription: transcript,
      trigger: pebbleFixture.triggers.double,
      webhookVersion: pebbleFixture.webhook_version,
    }));
    expect(duplicate.status).toBe(200);
  } finally {
    console.log = originalLog;
    await services.close();
  }
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain(transcript);
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      event: "capture_text_accepted",
      trigger: "single-click-hold",
      webhook_version: "1",
      destination_kind: "journal",
      duplicate: false,
    }),
    expect.objectContaining({
      event: "capture_text_accepted",
      trigger: "single-click-hold",
      webhook_version: "1",
      destination_kind: "journal",
      duplicate: true,
    }),
  ]);
});

test("transcripts that Slack would truncate are rejected before durable acceptance", async () => {
  const route = pebbleRoute();
  const services = new ProductionCaptureServices(config(route));
  const response = await createCaptureRequestHandler(config(route), services)(pebbleRequest({
    transcription: "x".repeat(40_000),
  }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining("40,000-character limit") });
  expect(captureDb.query("SELECT count(*) AS count FROM capture_events").get()).toEqual({ count: 0 });
  await services.close();
});

test("accepted journal captures stay canonical across Slack retargeting and semantic header drift", async () => {
  const originalRoute = pebbleRoute();
  const originalServices = new ProductionCaptureServices(config(originalRoute));
  const transcription = "j".repeat(40_001);
  const stableFields = {
    transcription,
    recordedAt: "1787000000300",
    client: "ring",
  };
  try {
    const firstResponse = await createCaptureRequestHandler(config(originalRoute), originalServices)(pebbleRequest({
      ...stableFields,
      trigger: pebbleFixture.triggers.single,
      webhookVersion: pebbleFixture.webhook_version,
    }));
    expect(firstResponse.status).toBe(202);
    const first: any = await firstResponse.json();
    expect(first).toMatchObject({
      accepted: true,
      duplicate: false,
      status: "queued",
      trigger: pebbleFixture.triggers.single,
      webhook_version: pebbleFixture.webhook_version,
      destination_kind: "journal",
      terminal_receipt: null,
    });

    const owner = processIdentity(process.pid);
    const claimId = "journal-route-drift-claim";
    expect(claimCaptureEvent(first.event_id, Date.now(), owner, claimId)).toMatchObject({
      delivery_kind: "journal",
      status: "sending",
    });
    const receipt = `pebble-${first.event_id}.md`;
    expect(markCaptureEventDelivered({ eventId: first.event_id, claimId, owner }, {
      kind: "journal",
      journalFilePath: receipt,
    })?.outcome).toBe("applied");
    const canonicalRow = getCaptureEvent(first.event_id)!;
    expect(canonicalRow).toMatchObject({
      route_id: "pebble-index",
      delivery_kind: "journal",
      destination_channel: "",
      journal_sink: "journalmaxx-inbox",
      source_trigger: pebbleFixture.triggers.single,
      source_webhook_version: pebbleFixture.webhook_version,
      status: "delivered",
      journal_file_path: receipt,
      slack_message_ts: null,
    });
    expect(canonicalRow.message_text).toContain(transcription);

    const retargetedRoute = structuredClone(originalRoute);
    retargetedRoute.destination = { type: "slack", channelId: "C999" };
    retargetedRoute.triggerDestinations = retargetedRoute.triggerDestinations?.map((entry) => ({
      ...entry,
      destination: { type: "slack" as const, channelId: "C999" },
    }));
    const retargetedServices = new ProductionCaptureServices(config(retargetedRoute));
    try {
      const retryResponse = await createCaptureRequestHandler(config(retargetedRoute), retargetedServices)(pebbleRequest({
        ...stableFields,
        trigger: pebbleFixture.triggers.single,
        webhookVersion: pebbleFixture.webhook_version,
      }));
      expect(retryResponse.status).toBe(200);
      expect(await retryResponse.json()).toMatchObject({
        event_id: first.event_id,
        duplicate: true,
        status: "delivered",
        trigger: pebbleFixture.triggers.single,
        webhook_version: pebbleFixture.webhook_version,
        destination_kind: "journal",
        terminal_receipt: receipt,
      });

      const completeHeaderDrift = await createCaptureRequestHandler(config(retargetedRoute), retargetedServices)(pebbleRequest({
        ...stableFields,
        trigger: "unknown-complete-trigger",
        webhookVersion: "999",
      }));
      expect(completeHeaderDrift.status).toBe(200);
      expect(await completeHeaderDrift.json()).toMatchObject({
        event_id: first.event_id,
        duplicate: true,
        trigger: pebbleFixture.triggers.single,
        webhook_version: pebbleFixture.webhook_version,
        destination_kind: "journal",
        status: "delivered",
        terminal_receipt: receipt,
      });

      const triggerOnlyRetry = await createCaptureRequestHandler(config(retargetedRoute), retargetedServices)(pebbleRequest({
        ...stableFields,
        trigger: pebbleFixture.triggers.double,
      }));
      expect(triggerOnlyRetry.status).toBe(200);
      expect(await triggerOnlyRetry.json()).toMatchObject({
        event_id: first.event_id,
        duplicate: true,
        trigger: pebbleFixture.triggers.single,
        webhook_version: pebbleFixture.webhook_version,
        destination_kind: "journal",
        status: "delivered",
        terminal_receipt: receipt,
      });

      const removedTriggerRoute = structuredClone(retargetedRoute);
      removedTriggerRoute.triggerDestinations = removedTriggerRoute.triggerDestinations?.filter(
        (entry) => entry.sourceTrigger !== pebbleFixture.triggers.single,
      );
      const removedTriggerServices = new ProductionCaptureServices(config(removedTriggerRoute));
      try {
        const removedTriggerRetry = await createCaptureRequestHandler(
          config(removedTriggerRoute),
          removedTriggerServices,
        )(pebbleRequest({
          ...stableFields,
          trigger: pebbleFixture.triggers.single,
        }));
        expect(removedTriggerRetry.status).toBe(200);
        expect(await removedTriggerRetry.json()).toMatchObject({
          event_id: first.event_id,
          duplicate: true,
          trigger: pebbleFixture.triggers.single,
          webhook_version: pebbleFixture.webhook_version,
          destination_kind: "journal",
          status: "delivered",
          terminal_receipt: receipt,
        });
      } finally {
        await removedTriggerServices.close();
      }
      expect(getCaptureEvent(first.event_id)).toEqual(canonicalRow);
      expect(captureDb.query("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({ count: 1 });
    } finally {
      await retargetedServices.close();
    }
  } finally {
    await originalServices.close();
  }
});

test("the prepared DM route preserves old accepted destinations across retarget and duplicate delivery", async () => {
  const credentials = mkdtempSync(join(tmpdir(), "capture-dm-credentials-"));
  for (const name of ["watch_audio", "capture_queue", "pebble_index"]) {
    writeFileSync(join(credentials, name), `${bearerToken}\n`, { mode: 0o440 });
    chmodSync(join(credentials, name), 0o440);
  }
  chmodSync(credentials, 0o550);
  const previous = process.env.CREDENTIALS_DIRECTORY;
  let prepared: CaptureIngressConfig;
  try {
    process.env.CREDENTIALS_DIRECTORY = credentials;
    prepared = loadCaptureIngressConfig(join(import.meta.dir, "../../config/capture-routes.toml"));
  } finally {
    if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previous;
    rmSync(credentials, { recursive: true, force: true });
  }
  expect(prepared.routes.find((route) => route.id === "pebble-index")?.triggerDestinations).toEqual([
    {
      sourceTrigger: "single-click-hold",
      sourceWebhookVersion: "1",
      destination: { type: "journal", sink: "thinkering-inbox" },
    },
    {
      sourceTrigger: "double-click-hold",
      sourceWebhookVersion: "1",
      destination: { type: "slack", channelId: "D0BMWUJ3RD5" },
    },
    {
      sourceTrigger: "test-event",
      sourceWebhookVersion: "1",
      destination: { type: "slack", channelId: "D0BMWUJ3RD5" },
    },
  ]);
  const old = structuredClone(prepared);
  old.routes.find((route) => route.id === "pebble-index")!.destination = {
    type: "slack", channelId: "C0BNNP6U6GN",
  };
  const before = new ProductionCaptureServices(old);
  const after = new ProductionCaptureServices(prepared);
  try {
    const accepted: any = await (await createCaptureRequestHandler(old, before)(pebbleRequest())).json();
    const handler = createCaptureRequestHandler(prepared, after);
    const duplicate: any = await (await handler(pebbleRequest())).json();
    const fresh: any = await (await handler(pebbleRequest({ recordedAt: "1787000000124" }))).json();
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true, event_id: accepted.event_id });
    expect(getCaptureEvent(accepted.event_id)?.destination_channel).toBe("C0BNNP6U6GN");
    expect(getCaptureEvent(fresh.event_id)).toMatchObject({ destination_channel: "D0BMWUJ3RD5", status: "pending" });
    expect(captureDb.query("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({ count: 2 });
  } finally {
    await before.close();
    await after.close();
  }
});

test("capture config rejects duplicate or unsafe trigger routing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-trigger-config-"));
  const credentials = join(directory, "credentials");
  const configPath = join(directory, "capture.toml");
  mkdirSync(credentials, { mode: 0o550 });
  for (const name of ["capture_queue", "pebble_index"]) {
    writeFileSync(join(credentials, name), `${bearerToken}\n`, { mode: 0o440 });
    chmodSync(join(credentials, name), 0o440);
  }
  const base = [
    "[server]",
    'host = "127.0.0.1"',
    "port = 18080",
    "[queue]",
    'host = "127.0.0.1"',
    "port = 18081",
    'auth_token_credential = "capture_queue"',
    "[[routes]]",
    'id = "pebble-index"',
    'path = "/pebble"',
    'adapter = "pebble-index"',
    "max_body_bytes = 1024",
    'auth_token_credential = "pebble_index"',
    "[routes.destination]",
    'type = "slack"',
    'channel_id = "C123"',
  ];
  const trigger = (value: string) => [
    "[[routes.trigger_destinations]]",
    `trigger = ${JSON.stringify(value)}`,
    'webhook_version = "1"',
    "[routes.trigger_destinations.destination]",
    'type = "journal"',
    'sink = "journalmaxx-inbox"',
  ];
  const previous = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = credentials;
  try {
    writeFileSync(configPath, [...base, ...trigger("single-click-hold"), ...trigger("single-click-hold")].join("\n"));
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("duplicate trigger destinations");
    writeFileSync(configPath, [...base, ...trigger("../single")].join("\n"));
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("safe filename component");
    writeFileSync(configPath, [...base, ...trigger("single-click-hold")].map((line) => (
      line === 'sink = "journalmaxx-inbox"' ? 'sink = "../../root"' : line
    )).join("\n"));
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("safe filename component");
  } finally {
    if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previous;
    chmodSync(credentials, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the production config loader and loopback server enforce streamed route limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-loopback-"));
  const credentials = join(directory, "credentials");
  const output = join(directory, "output");
  const configPath = join(directory, "capture.toml");
  mkdirSync(credentials, { mode: 0o550 });
  mkdirSync(output);
  writeFileSync(join(credentials, "watch_audio"), `${bearerToken}\n`, { mode: 0o440 });
  chmodSync(join(credentials, "watch_audio"), 0o440);
  writeFileSync(join(credentials, "capture_queue"), `${bearerToken}\n`, { mode: 0o440 });
  chmodSync(join(credentials, "capture_queue"), 0o440);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(configPath, [
    "[server]",
    'host = "127.0.0.1"',
    `port = ${port}`,
    'health_path = "/health"',
    "max_request_body_bytes = 4",
    "[queue]",
    'host = "127.0.0.1"',
    `port = ${port + 1}`,
    'auth_token_credential = "capture_queue"',
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

test("the production config loader rejects credentials outside systemd's private permission shape", () => {
  const directory = mkdtempSync(join(tmpdir(), "capture-credential-mode-"));
  const credentials = join(directory, "credentials");
  const configPath = join(directory, "capture.toml");
  mkdirSync(credentials, { mode: 0o550 });
  writeFileSync(join(credentials, "capture_queue"), `${bearerToken}\n`, { mode: 0o440 });
  writeFileSync(join(credentials, "watch_audio"), `${bearerToken}\n`, { mode: 0o460 });
  chmodSync(join(credentials, "watch_audio"), 0o460);
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  writeFileSync(configPath, [
    "[server]",
    'host = "127.0.0.1"',
    `port = ${port}`,
    'health_path = "/health"',
    "max_request_body_bytes = 4",
    "[queue]",
    'host = "127.0.0.1"',
    `port = ${port + 1}`,
    'auth_token_credential = "capture_queue"',
    "[[routes]]",
    'id = "watch-audio"',
    'path = "/audio"',
    'label = "Watch audio"',
    'adapter = "raw-body"',
    "max_body_bytes = 4",
    'auth_token_credential = "watch_audio"',
    "[routes.destination]",
    'type = "directory"',
    `directory = ${JSON.stringify(directory)}`,
    'filename_prefix = "audio"',
  ].join("\n"));
  const previousCredentialsDirectory = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = credentials;
  try {
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0400 or 0440");
    chmodSync(join(credentials, "watch_audio"), 0o444);
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0400 or 0440");
    chmodSync(join(credentials, "watch_audio"), 0o540);
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0400 or 0440");
    chmodSync(join(credentials, "watch_audio"), 0o450);
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0400 or 0440");
    chmodSync(join(credentials, "watch_audio"), 0o440);
    chmodSync(credentials, 0o570);
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0500 or 0550");
    chmodSync(credentials, 0o557);
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("0500 or 0550");
    chmodSync(credentials, 0o550);
    writeFileSync(join(credentials, "watch_audio_target"), `${bearerToken}\n`, { mode: 0o440 });
    unlinkSync(join(credentials, "watch_audio"));
    symlinkSync(join(credentials, "watch_audio_target"), join(credentials, "watch_audio"));
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("not a file");
    const credentialDirectoryLink = join(directory, "credentials-link");
    symlinkSync(credentials, credentialDirectoryLink);
    process.env.CREDENTIALS_DIRECTORY = credentialDirectoryLink;
    expect(() => loadCaptureIngressConfig(configPath)).toThrow("not a directory");
  } finally {
    if (previousCredentialsDirectory === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previousCredentialsDirectory;
    chmodSync(credentials, 0o700);
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
    queue: { host: "127.0.0.1", port: port + 1, token: bearerToken },
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

test("concurrent Pebble acceptance shares one graceful shutdown with an audio upload", async () => {
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
  const ingress = startCaptureIngress({
    server: { host: "127.0.0.1", port, healthPath: "/health", maxRequestBodyBytes: 1024 },
    queue: { host: "127.0.0.1", port: port + 1, token: bearerToken },
    routes: [audioRoute, textRoute],
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
  expect(captureDb.query("SELECT count(*) AS count FROM capture_events WHERE status='pending'").get()).toEqual({ count: 2 });
  const primaryStop = ingress.stop("first-stop");
  const repeatedStop = ingress.stop("repeated-stop");
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
