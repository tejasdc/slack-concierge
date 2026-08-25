import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import {
  PROVIDER_BROKER_PROTOCOL_VERSION,
  claudeRunFromBroker,
  codexRequestFromBroker,
  createBoundedJsonlReader,
  type ProviderBrokerPolicy,
  type ProviderBrokerRequest,
} from "../src/provider-broker-protocol";
import {
  BrokeredCodexAppServerClient,
  BrokeredCodexObserverClient,
  loadProviderProjectRegistry,
  resolveProviderProject,
} from "../src/provider-broker-client";
import { ProviderSessionAuthority } from "../../deployment-control/provider/authority";
import { startProviderBroker } from "../../deployment-control/provider/broker";
import { startProviderWorker } from "../../deployment-control/provider/worker";

const scratch: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "concierge-provider-broker-"));
  scratch.push(directory);
  return directory;
}

function policy(projectRoot: string): ProviderBrokerPolicy {
  return {
    projectId: "project-a",
    projectRoot,
    allowedRoots: [`${projectRoot}-scratch`],
    allowedModels: new Set(["gpt-5.6-sol", "claude-sonnet"]),
    allowedEnvironment: new Set(["CONCIERGE_SLACK_CHANNEL_ID"]),
  };
}

function request(
  operation: ProviderBrokerRequest["operation"],
  payload: Record<string, unknown>,
): ProviderBrokerRequest {
  return {
    protocol_version: PROVIDER_BROKER_PROTOCOL_VERSION,
    id: randomUUID(),
    operation,
    payload,
  };
}

describe("provider broker protocol", () => {
  test("derives execution authority and accepts only the Concierge text contract", () => {
    const normalized = codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_start", {
      runtimeWorkspaceRoots: ["/srv/projects/a", "/srv/projects/a/notes"],
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      environment: { CONCIERGE_SLACK_CHANNEL_ID: "C1" },
    }));
    expect(normalized).toEqual({
      method: "thread/start",
      threadId: undefined,
      params: {
        cwd: "/srv/projects/a",
        runtimeWorkspaceRoots: ["/srv/projects/a", "/srv/projects/a/notes"],
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: { shell_environment_policy: { inherit: "none", set: { CONCIERGE_SLACK_CHANNEL_ID: "C1" } } },
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
    });

    const turn = codexRequestFromBroker(policy("/srv/projects/a"), request("codex.turn_start", {
      threadId: "0198ed8c-42bd-7f17-a8ef-2f9f782568b0",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      additionalContext: { "slack-concierge": { value: "context", kind: "application" } },
    }));
    expect(turn.params.input).toEqual([{ type: "text", text: "hello", text_elements: [] }]);
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.turn_start", {
      threadId: "0198ed8c-42bd-7f17-a8ef-2f9f782568b0",
      input: [{ type: "localImage", path: "/root/secret" }],
    }))).toThrow("does not accept caller field path");
  });

  test("rejects caller-selected paths, environment, models, and list selectors", () => {
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_start", {
      threadId: "0198ed8c-42bd-7f17-a8ef-2f9f782568b0",
    }))).toThrow("does not accept caller field threadId");
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_start", {
      runtimeWorkspaceRoots: ["/srv/projects/b"],
    }))).toThrow("outside the assigned project");
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_start", {
      environment: { HOME: "/root" },
    }))).toThrow("HOME is not allowed");
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_start", {
      model: "unreviewed-model",
    }))).toThrow("is not allowed");
    expect(() => codexRequestFromBroker(policy("/srv/projects/a"), request("codex.thread_list", {
      sourceKinds: ["cli"],
    }))).toThrow("source kinds are invalid");
  });

  test("injects fixed deployment authority after caller environment selection", () => {
    const fixedPolicy = {
      ...policy("/srv/projects/a"),
      fixedEnvironment: {
        CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/srv/provider-scratch/a/deployment-intent/intent.sock",
        CONCIERGE_REPO: "/srv/projects/a",
      },
      allowedEnvironment: new Set([
        "CONCIERGE_SLACK_CHANNEL_ID",
        "CONCIERGE_DEPLOYMENT_INTENT_SOCKET",
      ]),
    };
    const codex = codexRequestFromBroker(fixedPolicy, request("codex.thread_start", {
      environment: {
        CONCIERGE_SLACK_CHANNEL_ID: "C1",
        CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/caller/socket",
      },
    }));
    expect((codex.params.config as any).shell_environment_policy.set).toEqual({
      CONCIERGE_SLACK_CHANNEL_ID: "C1",
      CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/srv/provider-scratch/a/deployment-intent/intent.sock",
      CONCIERGE_REPO: "/srv/projects/a",
    });
    const claude = claudeRunFromBroker(fixedPolicy, request("claude.run", {
      prompt: "deploy",
      environment: { CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/caller/socket" },
    }));
    expect(claude.environment).toMatchObject({
      CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/srv/provider-scratch/a/deployment-intent/intent.sock",
      CONCIERGE_REPO: "/srv/projects/a",
    });
  });

  test("derives Claude paths and rejects out-of-project directories", () => {
    const normalized = claudeRunFromBroker(policy("/srv/projects/a"), request("claude.run", {
      prompt: "hello",
      additionalDirs: ["/srv/projects/a/notes"],
      model: "claude-sonnet",
    }));
    expect(normalized.additional_dirs).toEqual(["/srv/projects/a/notes"]);
    expect(() => claudeRunFromBroker(policy("/srv/projects/a"), request("claude.run", {
      prompt: "hello",
      additionalDirs: ["/root"],
    }))).toThrow("outside the assigned project");
  });

  test("bounds a frame before a newline is received", () => {
    const stream = new PassThrough();
    const errors: string[] = [];
    createBoundedJsonlReader(stream, () => {}, (error) => errors.push(error.message), 8);
    stream.write("123456789");
    stream.write("more");
    expect(errors).toEqual(["Provider broker frame exceeded limit."]);
  });
});

describe("provider session authority", () => {
  test("persists one project/provider binding before issuing its stable token", () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "sessions.json");
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, project_id: "project-a", sessions: {} }), { mode: 0o600 });
    chmodSync(statePath, 0o600);
    const authority = new ProviderSessionAuthority("project-a", randomBytes(32), statePath);
    const sessionUuid = "0198ed8c-42bd-7f17-a8ef-2f9f782568b0";
    const token = authority.authorize("codex", sessionUuid);
    expect(token).toHaveLength(64);
    expect(() => authority.assert("codex", sessionUuid, token)).not.toThrow();
    const wrongToken = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    expect(() => authority.assert("codex", sessionUuid, wrongToken)).toThrow("not authorized");
    expect(JSON.parse(readFileSync(statePath, "utf8")).sessions).toEqual({ [sessionUuid]: "codex" });
  });

  test("rejects a world-readable authority file", () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "sessions.json");
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, project_id: "project-a", sessions: {} }), { mode: 0o644 });
    chmodSync(statePath, 0o644);
    expect(() => new ProviderSessionAuthority("project-a", randomBytes(32), statePath)).toThrow("private regular file");
  });
});

describe("provider project registry", () => {
  test("routes only one exact managed project and rejects duplicate authority", () => {
    const directory = temporaryDirectory();
    const registryPath = join(directory, "projects.json");
    writeFileSync(registryPath, JSON.stringify({
      schema_version: 1,
      projects: [{
        id: "project-a",
        stable_path: "/srv/projects/a",
        socket_path: "/run/provider/a.sock",
        scratch_path: "/srv/provider-scratch/a",
        allowed_paths: ["/srv/projects/a", "/srv/provider-scratch/a"],
      }],
    }));
    const registry = loadProviderProjectRegistry(registryPath);
    expect(resolveProviderProject("/srv/projects/a/notes", registry).id).toBe("project-a");
    expect(() => resolveProviderProject("/srv/projects/b", registry)).toThrow("not uniquely managed");

    writeFileSync(registryPath, JSON.stringify({
      schema_version: 1,
      projects: [
        {
          id: "project-a", stable_path: "/srv/projects/a", socket_path: "/run/provider/a.sock",
          scratch_path: "/srv/provider-scratch/a", allowed_paths: [],
        },
        {
          id: "project-a", stable_path: "/srv/projects/b", socket_path: "/run/provider/b.sock",
          scratch_path: "/srv/provider-scratch/b", allowed_paths: [],
        },
      ],
    }));
    expect(() => loadProviderProjectRegistry(registryPath)).toThrow("invalid or duplicate");
  });
});

describe("provider broker integration", () => {
  test("the worker accepts broker-injected fields and overwrites their values for Claude", async () => {
    const directory = temporaryDirectory();
    const workerPath = join(directory, "worker.sock");
    const observedEnvironment = join(directory, "claude-environment");
    const claude = join(directory, "claude");
    writeFileSync(claude, [
      "#!/usr/bin/env bash",
      `printf '%s' "$CONCIERGE_DEPLOYMENT_INTENT_SOCKET" > ${JSON.stringify(observedEnvironment)}`,
      "printf '%s\\n' '{\"type\":\"result\"}'",
    ].join("\n"));
    chmodSync(claude, 0o755);
    const worker = startProviderWorker({
      projectRoot: directory,
      home: directory,
      allowedEnvironment: new Set(),
      fixedEnvironment: { CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/fixed/intent.sock" },
      codexExecutable: "/bin/false",
      claudeExecutable: claude,
      socketPath: workerPath,
    });
    await once(worker.server, "listening");
    const client = createConnection(workerPath);
    await once(client, "connect");
    const response = new Promise<Record<string, any>>((resolveResponse, rejectResponse) => {
      createBoundedJsonlReader(client, (line) => {
        const message = JSON.parse(line);
        if (message.type === "response" && message.id === "claude-1") resolveResponse(message);
      }, rejectResponse);
    });
    client.write(`${JSON.stringify({
      protocol_version: 1,
      id: "claude-1",
      operation: "claude.run",
      payload: {
        prompt: "deploy",
        additional_dirs: [],
        environment: { CONCIERGE_DEPLOYMENT_INTENT_SOCKET: "/caller/intent.sock" },
      },
    })}\n`);

    expect((await response).result).toEqual({ code: 0, signal: null });
    expect(readFileSync(observedEnvironment, "utf8")).toBe("/fixed/intent.sock");
    client.destroy();
    await worker.close();
  });

  test("binds new sessions, rejects wrong bindings, and filters observer events", async () => {
    const directory = temporaryDirectory();
    const workerPath = join(directory, "worker.sock");
    const brokerPath = join(directory, "broker.sock");
    const statePath = join(directory, "sessions.json");
    writeFileSync(statePath, JSON.stringify({ schema_version: 1, project_id: "project-a", sessions: {} }), { mode: 0o600 });
    chmodSync(statePath, 0o600);
    const authority = new ProviderSessionAuthority("project-a", randomBytes(32), statePath);
    const workerSockets = new Set<Socket>();
    const childSession = "0198ed8c-42bd-7f17-a8ef-2f9f782568b0";
    let workerRequestCount = 0;
    const worker = createServer((socket) => {
      workerSockets.add(socket);
      socket.on("close", () => workerSockets.delete(socket));
      createBoundedJsonlReader(socket, (line) => {
        workerRequestCount += 1;
        const message = JSON.parse(line);
        const result = message.payload.method === "thread/start"
          ? { thread: { id: childSession } }
          : { thread: { id: childSession, turns: [] } };
        socket.write(`${JSON.stringify({ type: "response", id: message.id, result })}\n`);
      }, (error) => socket.destroy(error));
    });
    servers.push(worker);
    worker.listen(workerPath);
    await once(worker, "listening");
    const broker = startProviderBroker({
      policy: policy("/srv/projects/a"),
      authority,
      workerSocketPath: workerPath,
      socketPath: brokerPath,
    });
    servers.push(broker);
    await once(broker, "listening");

    const client = new BrokeredCodexAppServerClient(brokerPath);
    const started = await client.request("thread/start", {
      cwd: "/caller-selected",
      runtimeWorkspaceRoots: ["/srv/projects/a"],
      approvalPolicy: "caller-selected",
      sandbox: "caller-selected",
    });
    expect(started.thread.id).toBe(childSession);
    expect(client.bindingToken()).toHaveLength(64);
    expect(authority.has("codex", childSession)).toBeTrue();
    await client.request("thread/read", { threadId: childSession, includeTurns: true });
    expect(workerRequestCount).toBe(2);

    const wrong = new BrokeredCodexAppServerClient(brokerPath, "0".repeat(64));
    await expect(wrong.request("thread/read", { threadId: childSession, includeTurns: true })).rejects.toThrow("not authorized");
    expect(workerRequestCount).toBe(2);
    await wrong.close();

    const observer = new BrokeredCodexAppServerClient(brokerPath);
    const notifications: any[] = [];
    observer.onNotification((event) => notifications.push(event));
    await observer.request("broker/observe", {});
    for (const socket of workerSockets) {
      socket.write(`${JSON.stringify({
        type: "codex.event",
        event: { method: "item/completed", params: { threadId: randomUUID() } },
      })}\n`);
      socket.write(`${JSON.stringify({
        type: "codex.event",
        event: { method: "item/completed", params: { threadId: childSession } },
      })}\n`);
      socket.write(`${JSON.stringify({ type: "codex.event", event: { method: "unscoped" } })}\n`);
    }
    await Bun.sleep(20);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].params.threadId).toBe(childSession);

    const registryPath = join(directory, "projects.json");
    writeFileSync(registryPath, JSON.stringify({
      schema_version: 1,
      projects: [{
        id: "project-a",
        stable_path: "/srv/projects/a",
        socket_path: brokerPath,
        scratch_path: join(directory, "scratch"),
        allowed_paths: ["/srv/projects/a"],
      }],
    }));
    const priorRegistryPath = process.env.CONCIERGE_PROVIDER_PROJECTS_PATH;
    process.env.CONCIERGE_PROVIDER_PROJECTS_PATH = registryPath;
    const aggregateObserver = new BrokeredCodexObserverClient(() => [{
      provider_thread_uuid: childSession,
      provider_binding_token: client.bindingToken(),
      project_path: "/srv/projects/a",
    }]);
    try {
      const firstGeneration = await aggregateObserver.connect();
      expect(await aggregateObserver.connect()).toBe(firstGeneration);
      for (const socket of [...workerSockets]) socket.destroy();
      await aggregateObserver.waitForDisconnect(firstGeneration);
      expect(await aggregateObserver.connect()).toBeGreaterThan(firstGeneration);
    } finally {
      await aggregateObserver.close();
      if (priorRegistryPath === undefined) delete process.env.CONCIERGE_PROVIDER_PROJECTS_PATH;
      else process.env.CONCIERGE_PROVIDER_PROJECTS_PATH = priorRegistryPath;
    }

    await Promise.all([client.close(), observer.close()]);
  });
});
