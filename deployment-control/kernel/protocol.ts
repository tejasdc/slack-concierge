import { createHash, randomUUID } from "node:crypto";

export type KernelCallerRole = "bot" | "coordinator" | "runner" | "provider" | "operator";

export interface KernelCommandEnvelope {
  protocol_version: 1;
  target: "concierge";
  idempotency_key: string;
  command: string;
  expected: {
    entity: "target" | "intent" | "generation" | "attempt" | "incident" | "handoff" | "release";
    id: string;
    status: string;
  };
  payload: Record<string, unknown>;
}

const ROLE_COMMANDS: Record<KernelCallerRole, Set<string>> = {
  bot: new Set(["intent.request", "handoff.list", "handoff.claim", "handoff.settle", "snapshot.read"]),
  coordinator: new Set([
    "generation.prepare",
    "attempt.create",
    "attempt.launch",
    "incident.transition",
    "incident.bind_repair_session",
    "release.restore",
    "snapshot.read",
  ]),
  runner: new Set([
    "attempt.claim",
    "attempt.phase",
    "attempt.fail",
    "attempt.succeed",
    "release.prepare",
    "release.activate",
    "release.healthy",
    "release.promote",
    "snapshot.read",
  ]),
  provider: new Set(["incident.bind_repair_session", "snapshot.read"]),
  operator: new Set([
    "intent.request",
    "generation.prepare",
    "attempt.create",
    "attempt.launch",
    "attempt.claim",
    "attempt.phase",
    "attempt.fail",
    "attempt.succeed",
    "incident.transition",
    "incident.bind_repair_session",
    "handoff.list",
    "handoff.claim",
    "handoff.settle",
    "release.prepare",
    "release.activate",
    "release.healthy",
    "release.promote",
    "release.restore",
    "snapshot.read",
  ]),
};

function sortedJson(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(object[key])}`).join(",")}}`;
}

export function commandDigest(command: KernelCommandEnvelope) {
  return createHash("sha256").update(sortedJson(command)).digest("hex");
}

export function assertKernelCommand(value: unknown): asserts value is KernelCommandEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Kernel command must be an object.");
  const command = value as Record<string, unknown>;
  if (command.protocol_version !== 1) throw new Error("Unsupported kernel protocol version.");
  if (command.target !== "concierge") throw new Error("Kernel target must be concierge.");
  if (typeof command.idempotency_key !== "string"
    || command.idempotency_key.length < 16
    || command.idempotency_key.length > 200
    || !/^[A-Za-z0-9:._-]+$/.test(command.idempotency_key)) {
    throw new Error("Kernel idempotency key is invalid.");
  }
  if (typeof command.command !== "string" || command.command.length > 80) {
    throw new Error("Kernel command kind is invalid.");
  }
  if (!command.expected || typeof command.expected !== "object" || Array.isArray(command.expected)) {
    throw new Error("Kernel command expected state is required.");
  }
  const expected = command.expected as Record<string, unknown>;
  if (!new Set(["target", "intent", "generation", "attempt", "incident", "handoff", "release"]).has(String(expected.entity))) {
    throw new Error("Kernel expected entity is invalid.");
  }
  if (typeof expected.id !== "string" || expected.id.length < 1 || expected.id.length > 200) {
    throw new Error("Kernel expected entity ID is invalid.");
  }
  if (typeof expected.status !== "string" || expected.status.length < 1 || expected.status.length > 80) {
    throw new Error("Kernel expected status is invalid.");
  }
  if (!command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    throw new Error("Kernel command payload must be an object.");
  }
  if (Buffer.byteLength(JSON.stringify(command.payload)) > 128 * 1024) {
    throw new Error("Kernel command payload is too large.");
  }
}

export function authorizeKernelCommand(role: KernelCallerRole, command: string) {
  if (!ROLE_COMMANDS[role].has(command)) throw new Error(`Caller role ${role} cannot execute ${command}.`);
}

export function kernelCommand(
  command: string,
  expected: KernelCommandEnvelope["expected"],
  payload: Record<string, unknown>,
  idempotencyKey = `kernel:${command}:${randomUUID()}`,
): KernelCommandEnvelope {
  return {
    protocol_version: 1,
    target: "concierge",
    idempotency_key: idempotencyKey,
    command,
    expected,
    payload,
  };
}
