#!/usr/bin/env bun

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { createBoundedJsonlReader } from "../../bot/src/provider-broker-protocol";
import { JsonRpcProcess } from "./json-rpc-process";

const CODEX_METHODS = new Set([
  "model/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/list",
  "thread/fork",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
]);
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_CLAUDE_OUTPUT_BYTES = 32 * 1024 * 1024;
const REQUEST_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface WorkerRequest {
  protocol_version: 1;
  id: string;
  operation: "codex.request" | "claude.run" | "claude.stdin" | "claude.close";
  payload: Record<string, any>;
}

function safeWrite(socket: Socket, message: unknown) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function assertWorkerRequest(value: unknown): asserts value is WorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider worker request is invalid.");
  const request = value as Record<string, unknown>;
  if (request.protocol_version !== 1 || typeof request.id !== "string" || !REQUEST_ID.test(request.id)
    || !new Set(["codex.request", "claude.run", "claude.stdin", "claude.close"]).has(String(request.operation))
    || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new Error("Provider worker request is invalid.");
  }
}

function assertOnlyKeys(value: Record<string, any>, allowed: ReadonlySet<string>, label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} field ${key} is forbidden.`);
  }
}

function assertProjectPath(projectRoot: string, value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("Provider worker path is invalid.");
  const canonicalRoot = resolve(projectRoot);
  const canonicalValue = resolve(value);
  const fromRoot = relative(canonicalRoot, canonicalValue);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error("Provider worker path escaped its project.");
  return canonicalValue;
}

function validatedEnvironment(
  value: unknown,
  allowedEnvironment: ReadonlySet<string>,
) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider worker environment is invalid.");
  }
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!allowedEnvironment.has(key) || typeof entry !== "string" || entry.length > 2_000) {
      throw new Error(`Provider worker environment field ${key} is forbidden.`);
    }
    environment[key] = entry;
  }
  return environment;
}

function assertNormalizedCodexRequest(projectRoot: string, payload: Record<string, any>) {
  assertOnlyKeys(payload, new Set(["method", "params"]), "Provider worker Codex request");
  const method = String(payload.method || "");
  if (!CODEX_METHODS.has(method)) throw new Error(`Provider worker method ${method} is forbidden.`);
  if (!payload.params || typeof payload.params !== "object" || Array.isArray(payload.params)) {
    throw new Error("Provider worker Codex parameters are invalid.");
  }
  const params = payload.params as Record<string, any>;
  if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
    if (params.cwd !== resolve(projectRoot) || params.approvalPolicy !== "never"
      || params.sandbox !== "danger-full-access" || !Array.isArray(params.runtimeWorkspaceRoots)
      || params.runtimeWorkspaceRoots.length < 1 || params.runtimeWorkspaceRoots.length > 16) {
      throw new Error("Provider worker Codex execution policy is invalid.");
    }
    for (const root of params.runtimeWorkspaceRoots) assertProjectPath(projectRoot, root);
  }
  return { method, params };
}

function claudeUserMessage(prompt: string) {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  });
}

function claudeArgs(payload: Record<string, any>) {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--replay-user-messages",
    ...(payload.session_uuid ? ["--resume", payload.session_uuid] : []),
    ...(payload.fork_session === true ? ["--fork-session"] : []),
    ...(payload.model ? ["--model", payload.model] : []),
    ...(payload.system_prompt ? ["--append-system-prompt", payload.system_prompt] : []),
  ];
  for (const directory of payload.additional_dirs || []) args.push("--add-dir", directory);
  return args;
}

export function startProviderWorker(input: {
  projectRoot: string;
  home: string;
  allowedEnvironment?: ReadonlySet<string>;
  allowedModels?: ReadonlySet<string>;
  codexExecutable?: string;
  claudeExecutable?: string;
  listenFd?: number;
  socketPath?: string;
}) {
  if (!isAbsolute(input.projectRoot) || !isAbsolute(input.home)) {
    throw new Error("Provider worker requires absolute project and home paths.");
  }
  const projectRoot = resolve(input.projectRoot);
  const home = resolve(input.home);
  const allowedEnvironment = input.allowedEnvironment || new Set<string>();
  const allowedModels = input.allowedModels || new Set<string>();
  const codex = new JsonRpcProcess({
    command: [input.codexExecutable || "/usr/bin/codex", "app-server", "--stdio", "--strict-config"],
    cwd: projectRoot,
    environment: {
      HOME: home,
      CODEX_HOME: `${home}/.codex`,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
  });
  const clients = new Set<Socket>();
  codex.onNotification((notification) => {
    for (const client of clients) safeWrite(client, { type: "codex.event", event: notification });
  });
  const server = createServer((socket) => {
    clients.add(socket);
    const claudeRuns = new Map<string, ChildProcessWithoutNullStreams>();
    createBoundedJsonlReader(socket, (line) => {
      let request: WorkerRequest;
      try {
        request = JSON.parse(line);
        assertWorkerRequest(request);
      } catch (error) {
        safeWrite(socket, { type: "response", id: "invalid", error: String(error) });
        return;
      }
      void handleWorkerRequest({
        request,
        socket,
        codex,
        claudeRuns,
        projectRoot,
        home,
        allowedEnvironment,
        allowedModels,
        claudeExecutable: input.claudeExecutable || "/usr/bin/claude",
      }).catch((error) => {
        safeWrite(socket, {
          type: "response",
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, (error) => socket.destroy(error), MAX_FRAME_BYTES);
    socket.on("close", () => {
      clients.delete(socket);
      for (const child of claudeRuns.values()) terminateProcessGroup(child, "SIGTERM");
      claudeRuns.clear();
    });
  });
  if (input.listenFd != null) server.listen({ fd: input.listenFd });
  else if (input.socketPath) server.listen(input.socketPath);
  else throw new Error("Provider worker requires a systemd socket or explicit test socket.");
  return {
    server,
    close: async () => {
      for (const client of clients) client.destroy();
      await codex.close();
      server.close();
    },
  };
}

async function handleWorkerRequest(input: {
  request: WorkerRequest;
  socket: Socket;
  codex: JsonRpcProcess;
  claudeRuns: Map<string, ChildProcessWithoutNullStreams>;
  projectRoot: string;
  home: string;
  allowedEnvironment: ReadonlySet<string>;
  allowedModels: ReadonlySet<string>;
  claudeExecutable: string;
}) {
  const { request, socket } = input;
  if (request.operation === "codex.request") {
    const normalized = assertNormalizedCodexRequest(input.projectRoot, request.payload);
    const result = await input.codex.request(normalized.method, normalized.params);
    safeWrite(socket, { type: "response", id: request.id, result });
    return;
  }
  const runId = String(request.payload.run_id || request.id);
  if (request.operation === "claude.stdin") {
    const child = input.claudeRuns.get(runId);
    if (!child?.stdin.writable) throw new Error("Claude provider stdin is not available.");
    const value = String(request.payload.value || "");
    if (Buffer.byteLength(value) > 256 * 1024) throw new Error("Claude provider input exceeded limit.");
    child.stdin.write(value);
    safeWrite(socket, { type: "response", id: request.id, result: { accepted: true } });
    return;
  }
  if (request.operation === "claude.close") {
    const child = input.claudeRuns.get(runId);
    if (child?.stdin.writable) {
      child.stdin.end();
      const deadline = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 2_000);
      deadline.unref();
      child.once("close", () => clearTimeout(deadline));
    }
    safeWrite(socket, { type: "response", id: request.id, result: { accepted: true } });
    return;
  }
  if (input.claudeRuns.has(runId)) throw new Error("Claude provider run identity is already active.");
  assertOnlyKeys(request.payload, new Set([
    "run_id", "prompt", "session_uuid", "fork_session", "model", "system_prompt", "environment", "additional_dirs",
  ]), "Provider worker Claude request");
  const prompt = String(request.payload.prompt || "");
  if (!prompt || Buffer.byteLength(prompt) > 1024 * 1024) throw new Error("Claude provider prompt is invalid.");
  if (request.payload.session_uuid != null
    && (typeof request.payload.session_uuid !== "string" || !UUID.test(request.payload.session_uuid))) {
    throw new Error("Claude provider session identity is invalid.");
  }
  if (request.payload.fork_session != null && typeof request.payload.fork_session !== "boolean") {
    throw new Error("Claude provider fork policy is invalid.");
  }
  if (request.payload.model != null
    && (typeof request.payload.model !== "string" || !input.allowedModels.has(request.payload.model))) {
    throw new Error("Claude provider model is forbidden.");
  }
  if (request.payload.system_prompt != null
    && (typeof request.payload.system_prompt !== "string"
      || Buffer.byteLength(request.payload.system_prompt) > 1024 * 1024)) {
    throw new Error("Claude provider system prompt is invalid.");
  }
  if (!Array.isArray(request.payload.additional_dirs) || request.payload.additional_dirs.length > 16) {
    throw new Error("Claude provider directories are invalid.");
  }
  const additionalDirectories = request.payload.additional_dirs.map((directory: unknown) => (
    assertProjectPath(input.projectRoot, directory)
  ));
  const environment = validatedEnvironment(request.payload.environment, input.allowedEnvironment);
  const child = spawn(input.claudeExecutable, claudeArgs({
    ...request.payload,
    additional_dirs: additionalDirectories,
  }), {
    cwd: input.projectRoot,
    env: {
      HOME: input.home,
      CLAUDE_CONFIG_DIR: `${input.home}/.claude`,
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LANG: "C.UTF-8",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  input.claudeRuns.set(runId, child);
  let observedBytes = 0;
  const forward = (stream: "stdout" | "stderr", chunk: Buffer) => {
    observedBytes += chunk.byteLength;
    if (observedBytes > MAX_CLAUDE_OUTPUT_BYTES) {
      terminateProcessGroup(child, "SIGKILL");
      return;
    }
    safeWrite(socket, { type: "claude.stream", run_id: runId, stream, chunk: chunk.toString() });
  };
  child.stdout.on("data", (chunk) => forward("stdout", chunk));
  child.stderr.on("data", (chunk) => forward("stderr", chunk));
  child.stdin.write(`${claudeUserMessage(prompt)}\n`);
  safeWrite(socket, { type: "claude.ready", run_id: runId });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  input.claudeRuns.delete(runId);
  safeWrite(socket, { type: "response", id: request.id, result: outcome });
}

function terminateProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

if (import.meta.main) {
  const listenFd = Number(process.env.LISTEN_FDS || 0) === 1 ? 3 : undefined;
  startProviderWorker({
    projectRoot: process.env.CONCIERGE_PROVIDER_PROJECT_ROOT || "",
    home: process.env.HOME || "",
    allowedEnvironment: new Set(
      (process.env.CONCIERGE_PROVIDER_ALLOWED_ENVIRONMENT || "").split(",").filter(Boolean),
    ),
    allowedModels: new Set((process.env.CONCIERGE_PROVIDER_ALLOWED_MODELS || "").split(",").filter(Boolean)),
    listenFd,
    socketPath: process.env.CONCIERGE_PROVIDER_WORKER_SOCKET,
  });
}
