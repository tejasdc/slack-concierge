#!/usr/bin/env bun

import { existsSync, lstatSync, chmodSync, chownSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeploymentControlStore, canonicalDeploymentControlPath } from "./state";
import { defaultKernelEnvironment, handleKernelCommand, type KernelEnvironment } from "./handler";
import type { KernelCallerRole } from "./protocol";

export interface KernelSocketDefinition {
  role: KernelCallerRole;
  path: string;
  mode: number;
  group?: string;
}

function groupId(name: string) {
  const line = readFileSync("/etc/group", "utf8").split("\n")
    .find((candidate) => candidate.split(":", 1)[0] === name);
  if (!line) throw new Error(`Required deployment kernel group ${name} does not exist.`);
  const gid = Number(line.split(":")[2]);
  if (!Number.isSafeInteger(gid) || gid < 0) throw new Error(`Deployment kernel group ${name} has an invalid GID.`);
  return gid;
}

function removeStaleSocket(path: string) {
  if (!existsSync(path)) return;
  if (!lstatSync(path).isSocket()) throw new Error(`Refusing to replace non-socket kernel path ${path}.`);
  unlinkSync(path);
}

function defaultSocketDefinitions(directory: string): KernelSocketDefinition[] {
  return [
    { role: "bot", path: join(directory, "bot.sock"), mode: 0o660, group: "concierge-bot" },
    { role: "coordinator", path: join(directory, "coordinator.sock"), mode: 0o660, group: "concierge-deploy" },
    { role: "runner", path: join(directory, "runner.sock"), mode: 0o600 },
    { role: "repair", path: join(directory, "repair.sock"), mode: 0o660, group: "concierge-repair" },
    { role: "review", path: join(directory, "review.sock"), mode: 0o660, group: "concierge-review" },
    { role: "operator", path: join(directory, "operator.sock"), mode: 0o600 },
  ];
}

export function startKernelServer(input: {
  store: DeploymentControlStore;
  environment: KernelEnvironment;
  sockets: KernelSocketDefinition[];
  configureOwnership?: boolean;
}) {
  const listeners: any[] = [];
  for (const definition of input.sockets) {
    removeStaleSocket(definition.path);
    const buffers = new WeakMap<object, string>();
    const listener = Bun.listen({
      unix: definition.path,
      socket: {
        open(socket: any) {
          buffers.set(socket, "");
        },
        async data(socket: any, data: Uint8Array) {
          const next = `${buffers.get(socket) || ""}${Buffer.from(data).toString("utf8")}`;
          if (Buffer.byteLength(next) > 256 * 1024) {
            socket.write(`${JSON.stringify({ ok: false, error: "Kernel command exceeds 256 KiB." })}\n`);
            socket.end();
            return;
          }
          const newline = next.indexOf("\n");
          if (newline < 0) {
            buffers.set(socket, next);
            return;
          }
          buffers.set(socket, next.slice(newline + 1));
          try {
            const command = JSON.parse(next.slice(0, newline));
            const response = await handleKernelCommand(input.store, definition.role, command, input.environment);
            socket.write(`${JSON.stringify(response)}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
          } finally {
            socket.end();
          }
        },
        close(socket: any) {
          buffers.delete(socket);
        },
        error(socket: any, error: Error) {
          console.error(JSON.stringify({ event: "deployment_kernel_socket_error", role: definition.role, error: error.message }));
          socket.end();
        },
      },
    });
    chmodSync(definition.path, definition.mode);
    if (input.configureOwnership !== false && definition.group) chownSync(definition.path, 0, groupId(definition.group));
    listeners.push(listener);
  }
  return {
    listeners,
    stop() {
      for (const listener of listeners) listener.stop(true);
    },
  };
}

if (import.meta.main) {
  if (process.geteuid?.() !== 0 && process.env.CONCIERGE_KERNEL_ALLOW_NON_ROOT !== "1") {
    throw new Error("The protected deployment kernel must run as root.");
  }
  const repositoryRoot = process.env.CONCIERGE_REPOSITORY_ROOT
    ? resolve(process.env.CONCIERGE_REPOSITORY_ROOT)
    : resolve(import.meta.dir, "../..");
  const socketDirectory = process.env.CONCIERGE_DEPLOYMENT_SOCKET_DIR || "/run/concierge-deployment";
  const store = new DeploymentControlStore(canonicalDeploymentControlPath());
  const server = startKernelServer({
    store,
    environment: defaultKernelEnvironment(repositoryRoot),
    sockets: defaultSocketDefinitions(socketDirectory),
  });
  const stop = () => {
    server.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(JSON.stringify({
    event: "deployment_kernel_online",
    database: canonicalDeploymentControlPath(),
    sockets: server.listeners.length,
  }));
}
