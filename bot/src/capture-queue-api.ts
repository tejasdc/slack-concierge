import { timingSafeEqual } from "node:crypto";
import {
  claimNextCaptureEvent,
  markCaptureEventDelivered,
  markCaptureEventRetry,
  parkCaptureEvent,
  recoverInterruptedCaptureDeliveries,
  type CaptureClaimProof,
} from "./capture-state";
import { errorFields, log } from "./log";
import type { ProcessIdentity } from "./runtime-identity";

export interface CaptureQueueServerConfig {
  host: string;
  port: number;
  token: string;
}

export type CaptureQueueOperation = "claim" | "delivered" | "retry" | "park";

export interface CaptureQueueApiDependencies {
  afterCommit?: (operation: CaptureQueueOperation, eventId: string) => void;
}

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

function authorized(request: Request, token: string): boolean {
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requiredString(value: unknown, field: string, maximumLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${field} must be a non-empty string of at most ${maximumLength} characters`);
  }
  return value;
}

function requiredNonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function processOwner(value: unknown): ProcessIdentity {
  const owner = value as Record<string, unknown> | null;
  const pid = Number(owner?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("owner.pid must be a positive integer");
  return {
    pid,
    bootId: requiredString(owner?.boot_id, "owner.boot_id", 128),
    startTicks: requiredString(owner?.start_ticks, "owner.start_ticks", 64),
  };
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("content-type must be application/json");
  }
  const parsed = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function claimProof(eventId: string, body: Record<string, unknown>): CaptureClaimProof {
  return {
    eventId,
    claimId: requiredString(body.claim_id, "claim_id", 128),
    owner: processOwner(body.owner),
  };
}

export function createCaptureQueueRequestHandler(
  config: CaptureQueueServerConfig,
  dependencies: CaptureQueueApiDependencies = {},
) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!authorized(request, config.token)) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    if (url.pathname === "/health") {
      return request.method === "GET"
        ? jsonResponse(200, { ok: true })
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

    try {
      const body = await requestBody(request);
      if (url.pathname === "/claim") {
        const claimId = requiredString(body.claim_id, "claim_id", 128);
        const owner = processOwner(body.owner);
        recoverInterruptedCaptureDeliveries();
        const event = claimNextCaptureEvent(claimId, owner);
        if (!event) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        dependencies.afterCommit?.("claim", event.event_id);
        return jsonResponse(200, { event });
      }

      const match = url.pathname.match(/^\/events\/([^/]+)\/(delivered|retry|park)$/);
      if (!match) return jsonResponse(404, { error: "not_found" });
      const eventId = decodeURIComponent(match[1]);
      const operation = match[2] as Exclude<CaptureQueueOperation, "claim">;
      const claim = claimProof(eventId, body);
      const result = operation === "delivered"
        ? markCaptureEventDelivered(
          claim,
          body.slack_message_ts === null || body.slack_message_ts === undefined
            ? null
            : requiredString(body.slack_message_ts, "slack_message_ts", 64),
        )
        : operation === "retry"
          ? markCaptureEventRetry(
            claim,
            requiredString(body.error, "error", 2_000),
            requiredNonnegativeInteger(body.next_attempt_ms, "next_attempt_ms"),
          )
          : parkCaptureEvent(claim, requiredString(body.error, "error", 2_000));
      if (!result) return jsonResponse(409, { error: "claim_conflict" });
      dependencies.afterCommit?.(operation, eventId);
      return jsonResponse(200, { ok: true, outcome: result.outcome, event_status: result.event.status });
    } catch (error) {
      log("warn", "capture_queue_request_rejected", { path: url.pathname, ...errorFields(error) });
      return jsonResponse(400, { error: "invalid_request" });
    }
  };
}

export function startCaptureQueueServer(
  config: CaptureQueueServerConfig,
  dependencies: CaptureQueueApiDependencies = {},
) {
  if (config.host !== "127.0.0.1" && config.host !== "::1") {
    throw new Error(`Capture queue must bind to loopback, received ${config.host}`);
  }
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    maxRequestBodySize: 16_384,
    idleTimeout: 5,
    fetch: createCaptureQueueRequestHandler(config, dependencies),
    error(error) {
      log("error", "capture_queue_unhandled_error", errorFields(error));
      return jsonResponse(500, { error: "internal_error" });
    },
  });
  log("info", "capture_queue_online", { hostname: server.hostname, port: server.port });
  return server;
}
