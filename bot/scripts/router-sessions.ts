#!/usr/bin/env bun
import { requestApiResponse } from "./router-request-client";

const usage = `router-actions.sh sessions search --source-channel C --source-ts T [--limit N] -- <concept...>
router-actions.sh sessions context <address> --source-channel C --source-ts T
router-actions.sh sessions ask <address> --source-channel C --source-ts T --action-id A [--after-request <request-id> ...] -- <text>
router-actions.sh sessions reply <request-id> --source-channel C --source-ts T --action-id A [--partial] -- <text>
router-actions.sh sessions get <request-id> --source-channel C --source-ts T`;

type Source = { channel_id: string; message_ts: string };
export type SessionCommunicationRequest =
  | { operation: "search"; body: { source: Source; concepts: string[]; limit?: number } }
  | { operation: "context"; body: { source: Source; address: string } }
  | { operation: "ask"; body: { source: Source; action_id: string; address: string; text: string; after?: string[] } }
  | { operation: "reply"; body: { source: Source; action_id: string; request_id: string; text: string; final: boolean } }
  | { operation: "get"; body: { source: Source; request_id: string } };

class SessionUsageError extends Error {}

function invalid(detail: string): never {
  throw new SessionUsageError(detail);
}

export function parseRouterSessionsArgs(argv: string[]): SessionCommunicationRequest {
  const [operation, ...args] = argv;
  if (operation !== "search" && operation !== "context" && operation !== "ask" && operation !== "reply" && operation !== "get") {
    invalid("Choose a session command: search, context, ask, reply, or get.");
  }
  const separator = args.indexOf("--");
  const options = separator < 0 ? [...args] : args.slice(0, separator);
  const content = separator < 0 ? [] : args.slice(separator + 1);
  const identity = operation === "search" ? undefined : options.shift();
  if (operation !== "search" && (!identity?.trim() || identity.startsWith("--"))) {
    invalid(`${operation} requires an exact ${operation === "context" || operation === "ask" ? "discovered address" : "request ID"}.`);
  }
  const flags = new Map<string, string>();
  const after: string[] = [];
  let partial = false;
  while (options.length) {
    const flag = options.shift()!;
    if (flag === "--partial" && operation === "reply") {
      if (partial) invalid("Repeated --partial option.");
      partial = true;
      continue;
    }
    const allowed = flag === "--source-channel" || flag === "--source-ts"
      || (flag === "--limit" && operation === "search")
      || (flag === "--action-id" && (operation === "ask" || operation === "reply"))
      || (flag === "--after-request" && operation === "ask");
    if (!allowed) invalid(`Unexpected option or positional argument: ${flag}`);
    const value = options.shift();
    if (!value?.trim() || value.startsWith("--")) invalid(`${flag} requires a value.`);
    if (flag === "--after-request") {
      if (after.includes(value)) invalid("Repeated dependency request ID.");
      after.push(value);
    } else {
      if (flags.has(flag)) invalid(`Repeated ${flag} option.`);
      flags.set(flag, value);
    }
  }
  const channel = flags.get("--source-channel");
  const timestamp = flags.get("--source-ts");
  if (!channel || !/^[CGD][A-Z0-9]+$/.test(channel)) invalid("--source-channel requires this input's exact Slack channel ID.");
  if (!timestamp || !/^\d+\.\d+$/.test(timestamp)) invalid("--source-ts requires this input's exact Slack message timestamp.");
  const source = { channel_id: channel, message_ts: timestamp };

  if (operation === "search") {
    if (separator < 0 || content.length < 1 || content.length > 8 || content.some(concept => !concept.trim())) {
      invalid("search requires 1–8 nonempty concepts after --, each quoted as one argument.");
    }
    const rawLimit = flags.get("--limit");
    if (rawLimit !== undefined && (!/^[1-9]\d*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) {
      invalid("--limit requires a positive integer.");
    }
    return { operation, body: { source, concepts: content, ...(rawLimit !== undefined ? { limit: Number(rawLimit) } : {}) } };
  }
  if (operation === "context" || operation === "get") {
    if (separator >= 0) invalid(`${operation} does not accept text or a -- separator.`);
    return operation === "context"
      ? { operation, body: { source, address: identity! } }
      : { operation, body: { source, request_id: identity! } };
  }
  const actionId = flags.get("--action-id");
  if (!actionId) invalid(`${operation} requires an explicit stable --action-id.`);
  if (separator < 0 || content.length !== 1 || !content[0]!.trim()) {
    invalid(`${operation} requires exactly one nonempty text argument after --.`);
  }
  return operation === "ask"
    ? { operation, body: { source, action_id: actionId, address: identity!, text: content[0]!, ...(after.length ? { after } : {}) } }
    : { operation, body: { source, action_id: actionId, request_id: identity!, text: content[0]!, final: !partial } };
}

export function runRouterSessions(request: SessionCommunicationRequest) {
  return requestApiResponse(`/session-communication/${request.operation}`, request.body);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let request: SessionCommunicationRequest | undefined;
  try {
    if (args.length === 1 && (args[0] === "help" || args[0] === "--help")) console.log(usage);
    else {
      request = parseRouterSessionsArgs(args);
      const response = await runRouterSessions(request);
      if (response.ok) console.log(JSON.stringify(response.result));
      else {
        console.error(JSON.stringify(response.result));
        process.exitCode = 1;
      }
    }
  } catch (error) {
    const invalidArguments = error instanceof SessionUsageError;
    console.error(JSON.stringify({
      ok: false,
      error: invalidArguments ? "invalid_session_arguments" : "session_communication_unavailable",
      detail: error instanceof Error ? error.message : String(error),
      ...(invalidArguments ? { usage } : request ? {
        operation: request.operation,
        source: request.body.source,
        ...("action_id" in request.body ? { action_id: request.body.action_id } : {}),
        ...("address" in request.body ? { address: request.body.address } : {}),
        ...("request_id" in request.body ? { request_id: request.body.request_id } : {}),
      } : {}),
    }));
    process.exitCode = invalidArguments ? 2 : 1;
  }
}
