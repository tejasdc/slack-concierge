#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import {
  CODEX_BROKER_METHODS,
  PROVIDER_BROKER_MAX_FRAME_BYTES,
  assertProviderBrokerRequest,
  claudeRunFromBroker,
  codexRequestFromBroker,
  createBoundedJsonlReader,
  type ProviderBrokerPolicy,
  type ProviderBrokerRequest,
} from "../../bot/src/provider-broker-protocol";
import { ProviderSessionAuthority } from "./authority";

interface ForwardedRequest {
  clientRequestId: string;
  operation: ProviderBrokerRequest["operation"];
  threadId?: string;
}

function write(socket: Socket, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function notificationThreadId(notification: Record<string, any>) {
  return notification.params?.threadId
    || notification.params?.thread?.id
    || notification.params?.turn?.threadId
    || null;
}

function observedClaudeSession(line: string) {
  try {
    const event = JSON.parse(line);
    const value = event?.session_id || (event?.type === "system" && event?.subtype === "init" ? event?.session_id : null);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export function startProviderBroker(input: {
  policy: ProviderBrokerPolicy;
  authority: ProviderSessionAuthority;
  workerSocketPath: string;
  listenFd?: number;
  socketPath?: string;
}) {
  const server = createServer((client) => {
    const worker = createConnection(input.workerSocketPath);
    const pending = new Map<string, ForwardedRequest>();
    const authorizedThreads = new Set<string>();
    const activeClaudeRuns = new Set<string>();
    const claudeBuffers = new Map<string, string>();
    createBoundedJsonlReader(worker, (line) => {
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        client.destroy(new Error("Provider worker emitted malformed JSONL."));
        return;
      }
      if (message.type === "codex.event") {
        const threadId = notificationThreadId(message.event || {});
        if (threadId && authorizedThreads.has(threadId)) write(client, { type: "event", event: message.event });
        return;
      }
      if (message.type === "claude.stream") {
        const runId = String(message.run_id || "");
        if (!activeClaudeRuns.has(runId)) return;
        if (message.stream === "stdout") {
          const lines = `${claudeBuffers.get(runId) || ""}${String(message.chunk || "")}`.split("\n");
          claudeBuffers.set(runId, lines.pop() || "");
          for (const providerLine of lines) {
            const sessionUuid = observedClaudeSession(providerLine);
            if (!sessionUuid) continue;
            const bindingToken = input.authority.authorize("claude-code", sessionUuid);
            write(client, { type: "binding", provider: "claude-code", session_uuid: sessionUuid, binding_token: bindingToken });
          }
        }
        write(client, message);
        return;
      }
      if (message.type === "claude.ready") {
        if (activeClaudeRuns.has(String(message.run_id || ""))) write(client, message);
        return;
      }
      if (message.type !== "response") return;
      const forwarded = pending.get(String(message.id));
      if (!forwarded) return;
      pending.delete(String(message.id));
      if (forwarded.operation === "claude.run") {
        activeClaudeRuns.delete(forwarded.clientRequestId);
        claudeBuffers.delete(forwarded.clientRequestId);
      }
      if (message.error) {
        write(client, { type: "response", id: forwarded.clientRequestId, error: message.error });
        return;
      }
      let result = message.result;
      if (["codex.thread_start", "codex.thread_resume", "codex.thread_fork"].includes(forwarded.operation)) {
        const sessionUuid = String(result?.thread?.id || forwarded.threadId || "");
        if (!sessionUuid) {
          write(client, { type: "response", id: forwarded.clientRequestId, error: "Provider did not return a thread identity." });
          return;
        }
        const bindingToken = input.authority.authorize("codex", sessionUuid);
        authorizedThreads.add(sessionUuid);
        result = { ...result, _broker: { bindingToken } };
      } else if (forwarded.operation === "codex.thread_list") {
        result = {
          ...result,
          data: Array.isArray(result?.data)
            ? result.data.filter((thread: any) => input.authority.has("codex", String(thread?.id || "")))
            : [],
        };
      }
      write(client, { type: "response", id: forwarded.clientRequestId, result });
    }, (error) => client.destroy(error), PROVIDER_BROKER_MAX_FRAME_BYTES);
    worker.on("error", (error) => client.destroy(error));
    worker.on("close", () => client.destroy());

    createBoundedJsonlReader(client, (line) => {
      let request: ProviderBrokerRequest | null = null;
      try {
        request = JSON.parse(line);
        assertProviderBrokerRequest(request);
        if (pending.size >= 64) throw new Error("Provider broker request limit reached.");
        if (request.operation === "codex.observe") {
          if (Object.keys(request.payload).length !== 0 || request.binding_token) {
            throw new Error("Provider observer request is invalid.");
          }
          for (const threadId of input.authority.list("codex")) authorizedThreads.add(threadId);
          write(client, {
            type: "response",
            id: request.id,
            result: { subscribed: true, thread_count: authorizedThreads.size },
          });
          return;
        }
        const workerId = randomUUID();
        if (request.operation in CODEX_BROKER_METHODS) {
          const normalized = codexRequestFromBroker(input.policy, request);
          if (normalized.threadId) {
            input.authority.assert("codex", normalized.threadId, request.binding_token);
            authorizedThreads.add(normalized.threadId);
          }
          pending.set(workerId, {
            clientRequestId: request.id,
            operation: request.operation,
            threadId: normalized.threadId,
          });
          write(worker, {
            protocol_version: 1,
            id: workerId,
            operation: "codex.request",
            payload: { method: normalized.method, params: normalized.params },
          });
          return;
        }
        if (request.operation === "claude.run") {
          const normalized = claudeRunFromBroker(input.policy, request);
          if (normalized.session_uuid) {
            input.authority.assert("claude-code", normalized.session_uuid, request.binding_token);
          }
          if (activeClaudeRuns.size >= 1) throw new Error("A Claude provider run is already active on this connection.");
          pending.set(workerId, { clientRequestId: request.id, operation: request.operation });
          activeClaudeRuns.add(request.id);
          write(worker, {
            protocol_version: 1,
            id: workerId,
            operation: "claude.run",
            payload: { ...normalized, run_id: request.id },
          });
          return;
        }
        const runId = String(request.payload.run_id || "");
        if (!activeClaudeRuns.has(runId)) throw new Error("Claude provider run is not owned by this connection.");
        pending.set(workerId, { clientRequestId: request.id, operation: request.operation });
        write(worker, {
          protocol_version: 1,
          id: workerId,
          operation: request.operation,
          payload: {
            run_id: runId,
            ...(request.operation === "claude.stdin" ? { value: String(request.payload.value || "") } : {}),
          },
        });
      } catch (error) {
        write(client, {
          type: "response",
          id: request?.id || "invalid",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, (error) => client.destroy(error), PROVIDER_BROKER_MAX_FRAME_BYTES);
    client.on("close", () => worker.destroy());
  });
  server.maxConnections = 8;
  if (input.listenFd != null) server.listen({ fd: input.listenFd });
  else if (input.socketPath) server.listen(input.socketPath);
  else throw new Error("Provider broker requires a systemd socket or explicit test socket.");
  return server;
}

if (import.meta.main) {
  const projectId = process.env.CONCIERGE_PROVIDER_PROJECT_ID || "";
  const authorityRoot = process.env.CONCIERGE_PROVIDER_AUTHORITY_ROOT || "";
  const secret = Buffer.from(readFileSync(`${authorityRoot}/secret`, "utf8").trim(), "hex");
  const authority = new ProviderSessionAuthority(projectId, secret, `${authorityRoot}/sessions.json`);
  startProviderBroker({
    policy: {
      projectId,
      projectRoot: process.env.CONCIERGE_PROVIDER_PROJECT_ROOT || "",
      allowedModels: new Set((process.env.CONCIERGE_PROVIDER_ALLOWED_MODELS || "").split(",").filter(Boolean)),
      allowedEnvironment: new Set((process.env.CONCIERGE_PROVIDER_ALLOWED_ENVIRONMENT || "").split(",").filter(Boolean)),
    },
    authority,
    workerSocketPath: process.env.CONCIERGE_PROVIDER_WORKER_SOCKET || "",
    listenFd: Number(process.env.LISTEN_FDS || 0) === 1 ? 3 : undefined,
    socketPath: process.env.CONCIERGE_PROVIDER_BROKER_SOCKET,
  });
}
