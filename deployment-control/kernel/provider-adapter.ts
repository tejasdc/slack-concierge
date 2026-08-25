#!/usr/bin/env bun

import { createHash, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";

const DEFAULT_AUTH_PATH = "/root/.codex/auth.json";
const DEFAULT_CONTROL_SOCKET = "/run/concierge-deployment/provider-adapter.sock";
const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_PROVIDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CAPABILITY_LIFETIME_MS = 24 * 60 * 60 * 1000;

type WorkerKind = "repair" | "review";

interface CapabilityRecord {
  incidentId: string;
  workerKind: WorkerKind;
  capabilityDigest: Buffer;
  expiresAtMs: number;
}

interface ExistingCodexCredential {
  accessToken: string;
  accountId: string;
}

export interface ProviderAdapterServices {
  now(): number;
  readCredential(): ExistingCodexCredential;
  fetchUpstream(request: Request): Promise<Response>;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}

function validIncidentId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validCapability(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validWorkerKind(value: unknown): value is WorkerKind {
  return value === "repair" || value === "review";
}

function secureEqual(left: Buffer, right: Buffer) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function safeResponseHeaders(upstream: Headers) {
  const result = new Headers();
  for (const [name, value] of upstream) {
    const normalized = name.toLowerCase();
    if (["connection", "content-length", "set-cookie", "transfer-encoding"].includes(normalized)) continue;
    result.set(name, value);
  }
  return result;
}

function upstreamHeaders(incoming: Headers, credential: ExistingCodexCredential) {
  const result = new Headers();
  for (const [name, value] of incoming) {
    const normalized = name.toLowerCase();
    if ([
      "authorization",
      "chatgpt-account-id",
      "connection",
      "content-length",
      "cookie",
      "host",
      "proxy-authorization",
      "transfer-encoding",
    ].includes(normalized)) continue;
    result.set(name, value);
  }
  result.set("authorization", `Bearer ${credential.accessToken}`);
  result.set("chatgpt-account-id", credential.accountId);
  result.set("content-type", "application/json");
  return result;
}

function boundedResponseBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) return null;
  const reader = body.getReader();
  let receivedBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > MAX_PROVIDER_RESPONSE_BYTES) {
          await reader.cancel("Provider response exceeded the adapter limit.");
          controller.error(new Error("Provider response exceeded the adapter limit."));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function boundedRequestBody(body: ReadableStream<Uint8Array> | null) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > MAX_REQUEST_BYTES) {
      await reader.cancel("Provider request exceeded the adapter limit.");
      return null;
    }
    chunks.push(chunk.value);
  }
  return new Uint8Array(Buffer.concat(chunks, receivedBytes));
}

export function readExistingCodexCredential(path = DEFAULT_AUTH_PATH): ExistingCodexCredential {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
    throw new Error("The existing Codex credential authority must be a root-owned mode-0600 regular file.");
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const tokens = parsed.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error("The existing Codex credential authority has no token set.");
  }
  const accessToken = (tokens as Record<string, unknown>).access_token;
  const accountId = (tokens as Record<string, unknown>).account_id;
  if (typeof accessToken !== "string" || accessToken.length < 32
    || typeof accountId !== "string" || accountId.length < 8) {
    throw new Error("The existing Codex credential authority is incomplete.");
  }
  return { accessToken, accountId };
}

export class ProviderCredentialAdapter {
  private readonly capabilities = new Map<string, CapabilityRecord>();

  constructor(readonly services: ProviderAdapterServices) {}

  private key(incidentId: string, workerKind: WorkerKind) {
    return `${incidentId}:${workerKind}`;
  }

  register(input: {
    incidentId: string;
    workerKind: WorkerKind;
    capability: string;
    expiresAtMs: number;
    replace?: boolean;
  }) {
    if (!validIncidentId(input.incidentId) || !validWorkerKind(input.workerKind)
      || !validCapability(input.capability) || !Number.isSafeInteger(input.expiresAtMs)) {
      throw new Error("Provider capability registration is invalid.");
    }
    const now = this.services.now();
    if (input.expiresAtMs <= now || input.expiresAtMs > now + MAX_CAPABILITY_LIFETIME_MS) {
      throw new Error("Provider capability expiry is outside the allowed lifetime.");
    }
    const key = this.key(input.incidentId, input.workerKind);
    const existing = this.capabilities.get(key);
    const capabilityDigest = sha256(input.capability);
    if (existing && !input.replace && (!secureEqual(existing.capabilityDigest, capabilityDigest)
      || existing.expiresAtMs !== input.expiresAtMs)) {
      throw new Error("Provider capability identity changed after registration.");
    }
    this.capabilities.set(key, {
      incidentId: input.incidentId,
      workerKind: input.workerKind,
      capabilityDigest,
      expiresAtMs: input.expiresAtMs,
    });
    return { registered: true, incident_id: input.incidentId, worker_kind: input.workerKind };
  }

  revoke(incidentId: string, workerKind: WorkerKind) {
    if (!validIncidentId(incidentId) || !validWorkerKind(workerKind)) {
      throw new Error("Provider capability revocation is invalid.");
    }
    this.capabilities.delete(this.key(incidentId, workerKind));
    return { revoked: true, incident_id: incidentId, worker_kind: workerKind };
  }

  private authorize(request: Request, incidentId: string, workerKind: WorkerKind) {
    const record = this.capabilities.get(this.key(incidentId, workerKind));
    const authorization = request.headers.get("authorization") || "";
    const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
    if (!record || record.expiresAtMs <= this.services.now() || !match
      || !secureEqual(record.capabilityDigest, sha256(match[1]))) {
      return false;
    }
    return true;
  }

  async handle(request: Request) {
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/incidents\/([^/]+)\/(repair|review)\/responses$/);
    if (!match || url.search) return new Response("Not found", { status: 404 });
    const [, incidentId, workerKind] = match;
    if (!validIncidentId(incidentId) || !validWorkerKind(workerKind)
      || !this.authorize(request, incidentId, workerKind)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_REQUEST_BYTES) {
      return new Response("Request too large", { status: 413 });
    }
    const body = await boundedRequestBody(request.body);
    if (!body) return new Response("Request too large", { status: 413 });
    let credential: ExistingCodexCredential;
    try {
      credential = this.services.readCredential();
    } catch {
      return new Response("Provider authority unavailable", { status: 503 });
    }
    const upstream = await this.services.fetchUpstream(new Request(DEFAULT_UPSTREAM, {
      method: "POST",
      headers: upstreamHeaders(request.headers, credential),
      body,
      redirect: "error",
    }));
    const upstreamLengthHeader = upstream.headers.get("content-length");
    if (upstreamLengthHeader !== null) {
      const upstreamLength = Number(upstreamLengthHeader);
      if (!/^\d+$/.test(upstreamLengthHeader) || !Number.isSafeInteger(upstreamLength)
        || upstreamLength > MAX_PROVIDER_RESPONSE_BYTES) {
        await upstream.body?.cancel();
        return new Response("Provider response too large", { status: 502 });
      }
    }
    return new Response(boundedResponseBody(upstream.body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: safeResponseHeaders(upstream.headers),
    });
  }
}

export function defaultProviderAdapter() {
  return new ProviderCredentialAdapter({
    now: () => Date.now(),
    readCredential: () => readExistingCodexCredential(process.env.CONCIERGE_CODEX_AUTH_PATH || DEFAULT_AUTH_PATH),
    fetchUpstream: (request) => fetch(request),
  });
}

function startControlSocket(adapter: ProviderCredentialAdapter, path: string) {
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`Refusing to replace non-socket provider adapter path ${path}.`);
    unlinkSync(path);
  }
  const buffers = new WeakMap<object, string>();
  const listener = Bun.listen({
    unix: path,
    socket: {
      open(socket: any) {
        buffers.set(socket, "");
      },
      data(socket: any, data: Uint8Array) {
        const next = `${buffers.get(socket) || ""}${Buffer.from(data).toString("utf8")}`;
        if (Buffer.byteLength(next) > 4096) {
          socket.end(`${JSON.stringify({ ok: false, error: "Provider adapter command is too large." })}\n`);
          return;
        }
        const newline = next.indexOf("\n");
        if (newline < 0) {
          buffers.set(socket, next);
          return;
        }
        try {
          const command = JSON.parse(next.slice(0, newline)) as Record<string, unknown>;
          const result = command.command === "register" || command.command === "replace"
            ? adapter.register({
                incidentId: String(command.incident_id || ""),
                workerKind: String(command.worker_kind || "") as WorkerKind,
                capability: String(command.capability || ""),
                expiresAtMs: Number(command.expires_at_ms),
                replace: command.command === "replace",
              })
            : command.command === "revoke"
              ? adapter.revoke(String(command.incident_id || ""), String(command.worker_kind || "") as WorkerKind)
              : (() => { throw new Error("Unknown provider adapter command."); })();
          socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
        }
      },
      close(socket: any) {
        buffers.delete(socket);
      },
      error(socket: any) {
        socket.end();
      },
    },
  });
  chmodSync(path, 0o600);
  return listener;
}

if (import.meta.main) {
  if (process.geteuid?.() !== 0) throw new Error("The provider credential adapter must run as root.");
  const adapter = defaultProviderAdapter();
  const port = Number(process.env.CONCIERGE_PROVIDER_ADAPTER_PORT || 41951);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Provider adapter port is invalid.");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: (request) => adapter.handle(request),
  });
  const control = startControlSocket(
    adapter,
    process.env.CONCIERGE_PROVIDER_ADAPTER_SOCKET || DEFAULT_CONTROL_SOCKET,
  );
  const runtimeVersion = basename(realpathSync(dirname(process.argv[1])));
  if (!/^[0-9a-f]{64}$/.test(runtimeVersion)) {
    throw new Error("Provider adapter is not running from an immutable version directory.");
  }
  const versionPath = process.env.CONCIERGE_PROVIDER_ADAPTER_VERSION_PATH
    || "/run/concierge-deployment/provider-adapter-version";
  const temporaryVersionPath = `${versionPath}.${process.pid}`;
  writeFileSync(temporaryVersionPath, `${runtimeVersion}\n`, { mode: 0o600 });
  renameSync(temporaryVersionPath, versionPath);
  const stop = () => {
    control.stop(true);
    void server.stop(true);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(JSON.stringify({ event: "deployment_provider_adapter_online", port }));
}
