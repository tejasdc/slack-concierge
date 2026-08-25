import { randomUUID } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createBoundedJsonlReader } from "./provider-broker-protocol";

export const DEPLOYMENT_INTENT_PROTOCOL_VERSION = 1 as const;
export const DEPLOYMENT_INTENT_MAX_FRAME_BYTES = 64 * 1024;

export interface DeploymentIntentProject {
  id: string;
  stable_path: string;
  scratch_path: string;
}

export interface DeploymentIntentContext {
  source_turn_id: number;
  owner_instance_id: string;
  source_session_id: number;
  slack_channel_id: string;
  slack_thread_ts: string;
}

export interface DeploymentIntentRequest {
  protocol_version: typeof DEPLOYMENT_INTENT_PROTOCOL_VERSION;
  id: string;
  expected_commit: string;
  context: DeploymentIntentContext;
}

interface DeploymentIntentResponse {
  protocol_version: typeof DEPLOYMENT_INTENT_PROTOCOL_VERSION;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const REQUEST_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const IDENTIFIER = /^[^\0\r\n]{1,500}$/;

export function deploymentIntentSocketPath(scratchPath: string) {
  return join(resolve(scratchPath), "deployment-intent", "intent.sock");
}

export function assertDeploymentIntentRequest(value: unknown): asserts value is DeploymentIntentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Deployment intent request must be an object.");
  }
  const request = value as Record<string, any>;
  const context = request.context;
  if (request.protocol_version !== DEPLOYMENT_INTENT_PROTOCOL_VERSION
    || typeof request.id !== "string" || !REQUEST_ID.test(request.id)
    || typeof request.expected_commit !== "string" || !COMMIT.test(request.expected_commit)
    || !context || typeof context !== "object" || Array.isArray(context)
    || !Number.isSafeInteger(context.source_turn_id) || context.source_turn_id <= 0
    || !Number.isSafeInteger(context.source_session_id) || context.source_session_id <= 0
    || typeof context.owner_instance_id !== "string" || !IDENTIFIER.test(context.owner_instance_id)
    || typeof context.slack_channel_id !== "string" || !IDENTIFIER.test(context.slack_channel_id)
    || typeof context.slack_thread_ts !== "string" || !IDENTIFIER.test(context.slack_thread_ts)) {
    throw new Error("Deployment intent request is invalid.");
  }
  const requestKeys = Object.keys(request).sort().join(",");
  const contextKeys = Object.keys(context).sort().join(",");
  if (requestKeys !== "context,expected_commit,id,protocol_version"
    || contextKeys !== "owner_instance_id,slack_channel_id,slack_thread_ts,source_session_id,source_turn_id") {
    throw new Error("Deployment intent request contains forbidden fields.");
  }
}

function writeResponse(socket: Socket, response: DeploymentIntentResponse) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
}

function prepareSocketDirectory(socketPath: string) {
  const directory = dirname(socketPath);
  const parent = dirname(directory);
  const parentStat = statSync(parent);
  if (!parentStat.isDirectory()) throw new Error(`Deployment intent scratch root ${parent} is not a directory.`);
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o750 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || directoryStat.uid !== (process.getuid?.() ?? directoryStat.uid)
    || directoryStat.gid !== parentStat.gid) {
    throw new Error(`Deployment intent socket directory ${directory} has unsafe ownership or type.`);
  }
  chmodSync(directory, 0o750);
  if (!existsSync(socketPath)) return;
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket() || socketStat.uid !== directoryStat.uid || socketStat.gid !== directoryStat.gid) {
    throw new Error(`Deployment intent socket path ${socketPath} is not an owned stale socket.`);
  }
  unlinkSync(socketPath);
}

async function listen(server: Server, socketPath: string) {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const directoryStat = statSync(dirname(socketPath));
  chownSync(socketPath, process.getuid?.() ?? directoryStat.uid, directoryStat.gid);
  chmodSync(socketPath, 0o660);
}

export class DeploymentIntentIngress {
  private readonly listeners: Array<{ server: Server; socketPath: string; sockets: Set<Socket> }> = [];
  private stopped = false;

  constructor(
    private readonly projects: readonly DeploymentIntentProject[],
    private readonly submit: (project: DeploymentIntentProject, request: DeploymentIntentRequest) => Promise<unknown>,
  ) {}

  async start() {
    if (this.listeners.length > 0) return;
    for (const project of this.projects) {
      const socketPath = deploymentIntentSocketPath(project.scratch_path);
      prepareSocketDirectory(socketPath);
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.setTimeout(10_000, () => socket.destroy());
        socket.once("close", () => sockets.delete(socket));
        this.handle(project, socket);
      });
      server.maxConnections = 16;
      await listen(server, socketPath);
      this.listeners.push({ server, socketPath, sockets });
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const { sockets } of this.listeners) {
      for (const socket of sockets) socket.destroy();
    }
    await Promise.all(this.listeners.map(({ server }) => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    })));
    for (const { socketPath } of this.listeners) {
      if (!existsSync(socketPath)) continue;
      const observed = lstatSync(socketPath);
      if (observed.isSocket() && observed.uid === (process.getuid?.() ?? observed.uid)) unlinkSync(socketPath);
    }
    this.listeners.length = 0;
  }

  private handle(project: DeploymentIntentProject, socket: Socket) {
    let received = false;
    createBoundedJsonlReader(socket, (line) => {
      if (received) {
        socket.destroy();
        return;
      }
      received = true;
      let request: DeploymentIntentRequest | null = null;
      try {
        request = JSON.parse(line);
        assertDeploymentIntentRequest(request);
      } catch (error) {
        writeResponse(socket, {
          protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
          id: request?.id && REQUEST_ID.test(request.id) ? request.id : "invalid",
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      void this.submit(project, request).then(
        (result) => writeResponse(socket, {
          protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
          id: request!.id,
          ok: true,
          result,
        }),
        (error) => writeResponse(socket, {
          protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
          id: request!.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }, () => socket.destroy(), DEPLOYMENT_INTENT_MAX_FRAME_BYTES);
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string, maximum = 500) {
  const value = environment[name];
  if (!value || value.length > maximum || !IDENTIFIER.test(value)) {
    throw new Error(`${name} is required for a contained deployment request.`);
  }
  return value;
}

export async function requestDeploymentIntent(input: {
  expectedCommit: string;
  socketPath?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) {
  const environment = input.environment || process.env;
  const socketPath = input.socketPath || requiredEnvironment(environment, "CONCIERGE_DEPLOYMENT_INTENT_SOCKET", 2_000);
  if (!isAbsolute(socketPath)) throw new Error("Contained deployment intent socket must be absolute.");
  if (!COMMIT.test(input.expectedCommit)) throw new Error("Contained deployment requires a full commit SHA.");
  const request: DeploymentIntentRequest = {
    protocol_version: DEPLOYMENT_INTENT_PROTOCOL_VERSION,
    id: `deployment:${randomUUID()}`,
    expected_commit: input.expectedCommit.toLowerCase(),
    context: {
      source_turn_id: Number(requiredEnvironment(environment, "CONCIERGE_TURN_ID", 30)),
      owner_instance_id: requiredEnvironment(environment, "CONCIERGE_OWNER_INSTANCE_ID"),
      source_session_id: Number(requiredEnvironment(environment, "CONCIERGE_SESSION_ID", 30)),
      slack_channel_id: requiredEnvironment(environment, "CONCIERGE_SLACK_CHANNEL_ID"),
      slack_thread_ts: requiredEnvironment(environment, "CONCIERGE_SLACK_THREAD_TS"),
    },
  };
  assertDeploymentIntentRequest(request);
  return await new Promise<any>((resolveRequest, rejectRequest) => {
    const socket = createConnection(socketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectRequest(new Error("Contained deployment intent timed out."));
    }, input.timeoutMs ?? 10_000);
    let received = false;
    const finish = (error?: Error, result?: unknown) => {
      clearTimeout(timeout);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(result);
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.once("error", (error) => finish(error));
    createBoundedJsonlReader(socket, (line) => {
      if (received) return finish(new Error("Deployment intent ingress returned multiple responses."));
      received = true;
      let response: DeploymentIntentResponse;
      try {
        response = JSON.parse(line);
      } catch {
        return finish(new Error("Deployment intent ingress returned malformed JSON."));
      }
      if (response.protocol_version !== DEPLOYMENT_INTENT_PROTOCOL_VERSION || response.id !== request.id) {
        return finish(new Error("Deployment intent ingress response identity changed."));
      }
      if (!response.ok) return finish(new Error(response.error || "Deployment intent was rejected."));
      finish(undefined, response.result);
    }, (error) => finish(error), DEPLOYMENT_INTENT_MAX_FRAME_BYTES);
  });
}
