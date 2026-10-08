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
import { CommandIdentityConflict, UnknownCommandTarget, claimHumanCommand, commandStatus, prepareHumanCommand, retainHumanCommand, retryHumanCommand, settleHumanCommand, withdrawPendingCreation, type HumanCommand } from "./human-command-state";

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

const commandPath = /^\/sessions\/v1\/(?:sessions(?:\/[a-z][a-z0-9-]*%3A[1-9][0-9]*\/(?:inputs|actions|actions\/[A-Za-z0-9_-]+\/cancel|message-actions|stop|outage-choice|reconcile|bind|forks|comparisons|captures|tasks))?|operations\/[A-Za-z0-9:_-]+\/cancel|inbox\/topics(?:\/[A-Za-z0-9:_-]+\/actions)?|consultations|resurrections|saved-work(?:\/settings|\/[0-9]+\/(?:start|time|schedule|drop)))$/i;

function humanCommand(body:Record<string,unknown>):HumanCommand {
  const command=body as Record<string,unknown>;
  const clientId=requiredString(command.clientId,"clientId",128);
  const sessionId=requiredString(command.sessionId,"sessionId",200);
  const actionId=requiredString(command.actionId,"actionId",200);
  const door=requiredString(command.door,"door",100);
  const method=command.method;
  const path=requiredString(command.path,"path",500);
  const sequence=requiredNonnegativeInteger(command.sequence,"sequence");
  const payload=command.body;
  if(command.version!==1||method!=="POST"||!commandPath.test(path)||!payload||typeof payload!=="object"||Array.isArray(payload)
    ||(payload as Record<string,unknown>).clientActionId!==actionId||!/^[-a-z0-9:]{8,128}$/i.test(clientId)
    ||!(/^[a-z][a-z0-9-]*:[1-9][0-9]*$/.test(sessionId)||sessionId==="workspace")) {
    throw new Error("Invalid human command envelope.");
  }
  const targetSession=path.match(/^\/sessions\/v1\/sessions\/([^/]+)\//);
  if(targetSession?.[1]&&decodeURIComponent(targetSession[1])!==sessionId)throw new Error("Command stream does not name its target session.");
  // This is transport validation only. The owner still checks the command's scope, target,
  // authority and effect; ingress neither rewrites nor interprets its original body.
  return {version:1,clientId,sessionId,actionId,door,method,path,sequence,body:payload as Record<string,unknown>};
}

function commandReply(actionId:string) {
  const row=commandStatus(actionId);
  if(!row)return null;
  return {custody:"server",actionId:row.action_id,status:row.status,
    decisionStage:row.decision_stage,ownerStatus:row.owner_status,ownerResponse:row.owner_response_json?JSON.parse(row.owner_response_json):null};
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
    if (url.pathname === "/commands" && request.method === "POST") {
      try {
        const command=humanCommand(await requestBody(request));
        const retained=retainHumanCommand(command);
        dependencies.afterCommit?.("claim",retained.action_id);
        return jsonResponse(202,commandReply(retained.action_id)!);
      } catch(error) {
        if(error instanceof CommandIdentityConflict)return jsonResponse(409,{error:"command_identity_conflict"});
        if(error instanceof UnknownCommandTarget)return jsonResponse(409,{error:"command_target_not_retained"});
        log("warn","human_command_custody_refused",errorFields(error));
        return jsonResponse(400,{error:"invalid_command_envelope"});
      }
    }
    if (url.pathname === "/commands/claim" && request.method === "POST") {
      try {
        const body=await requestBody(request);
        const claimId=requiredString(body.claimId,"claimId",128);
        const claimed=claimHumanCommand(claimId);
        return claimed?jsonResponse(200,{command:{version:1,clientId:claimed.client_id,sessionId:claimed.session_id,door:claimed.door,
          sequence:claimed.sequence,actionId:claimed.action_id,method:claimed.method,path:claimed.path,
          body:JSON.parse(claimed.body_json)},prepared:claimed.prepared_json?JSON.parse(claimed.prepared_json):null,
          claimId,attempts:claimed.attempts}):
          new Response(null,{status:204,headers:{"cache-control":"no-store"}});
      } catch(error) {
        log("warn","human_command_claim_refused",errorFields(error));
        return jsonResponse(400,{error:"invalid_command_claim"});
      }
    }
    const settleMatch=url.pathname.match(/^\/commands\/([^/]+)\/(prepare|settle|retry)$/);
    if(settleMatch&&request.method==="POST") {
      try {
        const actionId=decodeURIComponent(settleMatch[1]);
        const body=await requestBody(request);
        const claimId=requiredString(body.claimId,"claimId",128);
        if(settleMatch[2]==="prepare") {
          if(!body.prepared||typeof body.prepared!=="object"||Array.isArray(body.prepared))throw new Error("Missing prepared command.");
          prepareHumanCommand(actionId,claimId,body.prepared);
          return jsonResponse(200,{ok:true});
        }
        if(settleMatch[2]==="retry") {
          const nextAttemptMs=requiredNonnegativeInteger(body.nextAttemptMs,"nextAttemptMs");
          return retryHumanCommand(actionId,claimId,nextAttemptMs)?jsonResponse(200,{ok:true}):jsonResponse(409,{error:"claim_conflict"});
        }
        const ownerStatus=requiredNonnegativeInteger(body.ownerStatus,"ownerStatus");
        const decisionStage=body.decisionStage;
        if(ownerStatus<200||ownerStatus>599||!("ownerResponse" in body)||!(["preparation","owner"] as unknown[]).includes(decisionStage))throw new Error("Invalid owner response.");
        const settled=settleHumanCommand(actionId,claimId,ownerStatus,body.ownerResponse,decisionStage as "preparation"|"owner");
        return jsonResponse(200,{ok:true,status:settled.status});
      } catch(error) {
        log("warn","human_command_settle_refused",errorFields(error));
        return jsonResponse(409,{error:"claim_conflict"});
      }
    }
    const commandMatch=url.pathname.match(/^\/commands\/([^/]+)$/);
    if(commandMatch&&request.method==="GET") {
      const actionId=decodeURIComponent(commandMatch[1]);
      const reply=commandReply(actionId);
      return reply?jsonResponse(200,reply):jsonResponse(404,{error:"command_not_found"});
    }
    const withdrawMatch=url.pathname.match(/^\/commands\/([^/]+)\/withdraw$/);
    if(withdrawMatch&&request.method==="POST"){
      const actionId=decodeURIComponent(withdrawMatch[1]);
      const row=withdrawPendingCreation(actionId);
      return row?.status==="canceled"?jsonResponse(200,commandReply(actionId)!):jsonResponse(409,{error:"creation_no_longer_at_ingress"});
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
      const deliveredReceipt = () => {
        const hasSlackReceipt = body.slack_message_ts !== null && body.slack_message_ts !== undefined;
        const hasJournalReceipt = body.journal_file_path !== null && body.journal_file_path !== undefined;
        const hasSessionReceipt = body.session_id !== undefined || body.session_input_id !== undefined;
        if (Number(hasSlackReceipt) + Number(hasJournalReceipt) + Number(hasSessionReceipt) !== 1) {
          throw new Error("delivered acknowledgement requires exactly one kind-specific receipt");
        }
        return hasSessionReceipt
          ? { kind: "session" as const, sessionId: requiredString(body.session_id, "session_id"), inputId: requiredString(body.session_input_id, "session_input_id") }
          : hasSlackReceipt
          ? { kind: "slack" as const, slackMessageTs: requiredString(body.slack_message_ts, "slack_message_ts", 64) }
          : { kind: "journal" as const, journalFilePath: requiredString(body.journal_file_path, "journal_file_path", 256) };
      };
      const result = operation === "delivered"
        ? markCaptureEventDelivered(
          claim,
          deliveredReceipt(),
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
      return jsonResponse(200, {
        ok: true,
        outcome: result.outcome,
        event_status: result.event.status,
        destination_kind: result.event.delivery_kind,
        session_id: result.event.session_id,
        terminal_receipt: result.event.delivery_kind === "session" ? result.event.session_input_id : result.event.delivery_kind === "slack"
          ? result.event.slack_message_ts
          : result.event.journal_file_path,
      });
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
    maxRequestBodySize: 1_048_576,
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
