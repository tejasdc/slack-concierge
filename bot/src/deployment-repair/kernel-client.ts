import { createConnection } from "node:net";
import { join } from "node:path";
import {
  kernelCommand,
  type KernelCommandEnvelope,
} from "../../../deployment-control/kernel/protocol";

export type KernelClientRole = "bot" | "coordinator" | "runner" | "repair" | "review" | "rollout" | "operator";

export class DeploymentKernelCommandError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "ambiguous",
  ) {
    super(message);
    this.name = "DeploymentKernelCommandError";
  }
}

export function deploymentKernelSocket(role: KernelClientRole) {
  const directory = process.env.CONCIERGE_DEPLOYMENT_SOCKET_DIR || "/run/concierge-deployment";
  return join(directory, `${role}.sock`);
}

export async function sendKernelCommand(
  role: KernelClientRole,
  command: KernelCommandEnvelope,
  input: { socketPath?: string; timeoutMs?: number } = {},
) {
  const socketPath = input.socketPath || deploymentKernelSocket(role);
  const timeoutMs = input.timeoutMs || 10_000;
  return await new Promise<any>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`Deployment kernel timed out after ${timeoutMs} ms.`)));
    socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on("data", (data) => {
      response += data.toString("utf8");
      if (Buffer.byteLength(response) > 256 * 1024) {
        finish(new Error("Deployment kernel response exceeded 256 KiB."));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(response.slice(0, newline)));
      } catch (error) {
        finish(new Error(`Deployment kernel returned invalid JSON: ${String(error)}`));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(new Error("Deployment kernel closed without a response."));
    });
  });
}

export async function checkedKernelCommand(
  role: KernelClientRole,
  command: string,
  expected: KernelCommandEnvelope["expected"],
  payload: Record<string, unknown>,
  input: { idempotencyKey?: string; socketPath?: string; timeoutMs?: number } = {},
) {
  const response = await sendKernelCommand(
    role,
    kernelCommand(command, expected, payload, input.idempotencyKey),
    input,
  );
  if (!response?.ok) {
    const ambiguity = response?.ambiguous ? " (ambiguous; not replayed)" : "";
    throw new DeploymentKernelCommandError(
      `Deployment kernel rejected ${command}${ambiguity}: ${response?.error || "unknown error"}`,
      response?.ambiguous ? "ambiguous" : "rejected",
    );
  }
  return response.result;
}
