import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
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
  loadProviderProjectRegistry,
  resolveProviderProject,
} from "../src/provider-broker-client";
import { ProviderSessionAuthority } from "../../deployment-control/provider/authority";
import { startProviderBroker } from "../../deployment-control/provider/broker";

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
      projects: [{ id: "project-a", stable_path: "/srv/projects/a", socket_path: "/run/provider/a.sock" }],
    }));
    const registry = loadProviderProjectRegistry(registryPath);
    expect(resolveProviderProject("/srv/projects/a/notes", registry).id).toBe("project-a");
    expect(() => resolveProviderProject("/srv/projects/b", registry)).toThrow("not uniquely managed");

    writeFileSync(registryPath, JSON.stringify({
      schema_version: 1,
      projects: [
        { id: "project-a", stable_path: "/srv/projects/a", socket_path: "/run/provider/a.sock" },
        { id: "project-a", stable_path: "/srv/projects/b", socket_path: "/run/provider/b.sock" },
      ],
    }));
    expect(() => loadProviderProjectRegistry(registryPath)).toThrow("invalid or duplicate");
  });
});

describe("provider broker integration", () => {
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

    await Promise.all([client.close(), observer.close()]);
  });
});
