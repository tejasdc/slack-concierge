import toml from "@iarna/toml";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { once } from "node:events";
import { basename, join, resolve } from "node:path";
import { createCaptureEvent } from "./capture-state";
import { startCaptureQueueServer, type CaptureQueueServerConfig } from "./capture-queue-api";
import { errorFields, log } from "./log";
import { retryTransientDatabaseOperation } from "./durable-notice-worker";

const DEFAULT_CONFIG_PATH = "/etc/concierge/capture-routes.toml";
const MAX_SLACK_MESSAGE_CHARACTERS = 40_000;

type CaptureAdapterName = "pebble-index" | "raw-body";
type CaptureDestinationConfig = SlackCaptureDestinationConfig | DirectoryCaptureDestinationConfig;

interface CaptureServerConfig {
  host: string;
  port: number;
  healthPath: string;
  maxRequestBodyBytes: number;
}

interface CaptureAuthConfig {
  header: string;
  scheme: string;
  token: string;
}

export interface SlackCaptureDestinationConfig {
  type: "slack";
  channelId: string;
}

export interface DirectoryCaptureDestinationConfig {
  type: "directory";
  directory: string;
  filenamePrefix: string;
}

export interface CaptureRouteConfig {
  id: string;
  path: string;
  label: string;
  adapter: CaptureAdapterName;
  maxBodyBytes: number;
  auth: CaptureAuthConfig;
  destination: CaptureDestinationConfig;
}

export interface CaptureIngressConfig {
  server: CaptureServerConfig;
  queue: CaptureQueueServerConfig;
  routes: CaptureRouteConfig[];
}

export interface TextCapture {
  kind: "text";
  eventId: string;
  routeId: string;
  label: string;
  text: string;
  recordedAtMs: number;
  client: string;
}

export interface BinaryCapture {
  kind: "binary";
  eventId: string;
  routeId: string;
  temporaryPath: string;
  sizeBytes: number;
  contentType: string;
  receivedAtMs: number;
}

export type Capture = TextCapture | BinaryCapture;

export interface CaptureAcceptance {
  eventId: string;
  duplicate: boolean;
  status: "stored" | "queued" | "delivered" | "parked";
  filename?: string;
  bytes?: number;
}

export interface CaptureServices {
  accept(route: CaptureRouteConfig, capture: Capture): Promise<CaptureAcceptance>;
}

export interface CaptureRequestDependencies {
  createRawBodyWriter?: typeof createWriteStream;
}

export interface ProductionCaptureDependencies {
  beforePersistence?: (eventId?: string) => void;
}

class CaptureRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Capture config requires ${name}.`);
  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Capture config ${name} must be a positive integer.`);
  return parsed;
}

function safeFilenameComponent(value: unknown, name: string): string {
  const component = requiredString(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component)) {
    throw new Error(`Capture config ${name} must be a safe filename component.`);
  }
  return component;
}

function secureSecret(path: string, credentialDirectory: string): string {
  const directory = lstatSync(credentialDirectory);
  if (!directory.isDirectory()) throw new Error(`Systemd credential directory is not a directory: ${credentialDirectory}`);
  const directoryMode = directory.mode & 0o777;
  if (directoryMode !== 0o500 && directoryMode !== 0o550) {
    throw new Error(`Systemd credential directory must have permission mode 0500 or 0550: ${credentialDirectory}`);
  }
  const absolutePath = resolve(path);
  const file = lstatSync(absolutePath);
  if (!file.isFile()) throw new Error(`Capture secret is not a file: ${absolutePath}`);
  const fileMode = file.mode & 0o777;
  if (fileMode !== 0o400 && fileMode !== 0o440) {
    throw new Error(`Systemd credential must have permission mode 0400 or 0440: ${absolutePath}`);
  }
  const secret = readFileSync(absolutePath, "utf8").trim();
  if (secret.length < 24) throw new Error(`Capture secret is too short: ${absolutePath}`);
  return secret;
}

function credentialSecret(name: unknown, field: string): string {
  const credentialName = requiredString(name, field);
  if (!/^[A-Za-z0-9_.-]+$/.test(credentialName)) throw new Error(`Invalid systemd credential name: ${credentialName}`);
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialDirectory) throw new Error(`CREDENTIALS_DIRECTORY is required for ${field}.`);
  return secureSecret(join(credentialDirectory, credentialName), credentialDirectory);
}

export function loadCaptureIngressConfig(path = process.env.CONCIERGE_CAPTURE_CONFIG || DEFAULT_CONFIG_PATH): CaptureIngressConfig {
  const parsed: any = toml.parse(readFileSync(path, "utf8"));
  const server = parsed.server || {};
  const queue = parsed.queue || {};
  const routes = Array.isArray(parsed.routes) ? parsed.routes : [];
  if (routes.length === 0) throw new Error("Capture config must define at least one [[routes]] entry.");

  const configuredRoutes: CaptureRouteConfig[] = routes.map((route: any, index: number) => {
    const name = `routes[${index}]`;
    const adapter = requiredString(route.adapter, `${name}.adapter`) as CaptureAdapterName;
    if (adapter !== "pebble-index" && adapter !== "raw-body") {
      throw new Error(`Unsupported capture adapter: ${adapter}`);
    }
    const pathValue = requiredString(route.path, `${name}.path`);
    if (!pathValue.startsWith("/") || pathValue.includes("?") || pathValue.includes("#")) {
      throw new Error(`Capture route path must be an absolute URL path: ${pathValue}`);
    }
    const destination = route.destination || {};
    let configuredDestination: CaptureDestinationConfig;
    if (destination.type === "slack") {
      configuredDestination = {
        type: "slack",
        channelId: requiredString(destination.channel_id, `${name}.destination.channel_id`),
      };
    } else if (destination.type === "directory") {
      configuredDestination = {
        type: "directory",
        directory: resolve(requiredString(destination.directory, `${name}.destination.directory`)),
        filenamePrefix: safeFilenameComponent(destination.filename_prefix || route.id, `${name}.destination.filename_prefix`),
      };
    } else {
      throw new Error(`Unsupported capture destination: ${String(destination.type)}`);
    }
    return {
      id: requiredString(route.id, `${name}.id`),
      path: pathValue,
      label: requiredString(route.label || route.id, `${name}.label`),
      adapter,
      maxBodyBytes: positiveInteger(route.max_body_bytes, `${name}.max_body_bytes`),
      auth: {
        header: requiredString(route.auth_header || "Authorization", `${name}.auth_header`),
        scheme: typeof route.auth_scheme === "string" ? route.auth_scheme.trim() : "Bearer",
        token: credentialSecret(route.auth_token_credential, `${name}.auth_token_credential`),
      },
      destination: configuredDestination,
    };
  });

  const paths = new Set<string>();
  const ids = new Set<string>();
  for (const route of configuredRoutes) {
    if (paths.has(route.path)) throw new Error(`Duplicate capture route path: ${route.path}`);
    if (ids.has(route.id)) throw new Error(`Duplicate capture route id: ${route.id}`);
    paths.add(route.path);
    ids.add(route.id);
    if (route.adapter === "pebble-index" && route.destination.type !== "slack") {
      throw new Error(`Pebble Index route ${route.id} requires a Slack destination.`);
    }
    if (route.adapter === "raw-body" && route.destination.type !== "directory") {
      throw new Error(`Raw body route ${route.id} requires a directory destination.`);
    }
  }

  const largestRouteBody = Math.max(...configuredRoutes.map((route) => route.maxBodyBytes));
  const maxRequestBodyBytes = positiveInteger(server.max_request_body_bytes || largestRouteBody, "server.max_request_body_bytes");
  if (maxRequestBodyBytes < largestRouteBody) {
    throw new Error("server.max_request_body_bytes cannot be smaller than a route max_body_bytes.");
  }
  return {
    server: {
      host: requiredString(server.host || "127.0.0.1", "server.host"),
      port: positiveInteger(server.port || 8080, "server.port"),
      healthPath: requiredString(server.health_path || "/health", "server.health_path"),
      maxRequestBodyBytes,
    },
    queue: {
      host: requiredString(queue.host || "127.0.0.1", "queue.host"),
      port: positiveInteger(queue.port || 8081, "queue.port"),
      token: credentialSecret(queue.auth_token_credential, "queue.auth_token_credential"),
    },
    routes: configuredRoutes,
  };
}

function authorized(request: Request, auth: CaptureAuthConfig): boolean {
  const supplied = request.headers.get(auth.header) || "";
  const expected = auth.scheme ? `${auth.scheme} ${auth.token}` : auth.token;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function contentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function ensureBodyWithinRouteLimit(request: Request, route: CaptureRouteConfig) {
  const length = contentLength(request);
  if (length !== null && length > route.maxBodyBytes) {
    throw new CaptureRequestError(413, `request body exceeds ${route.maxBodyBytes} bytes`);
  }
}

function captureId(parts: Array<string | Uint8Array>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(typeof part === "string" ? part : part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function clientMessageId(eventId: string): string {
  const hex = createHash("sha256").update(`slack-concierge:capture:${eventId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function formText(form: FormData, field: string, required: boolean): string {
  const value = form.get(field);
  if (value === null && !required) return "";
  if (typeof value !== "string" || !value.trim()) throw new CaptureRequestError(422, `missing or invalid ${field} field`);
  return value.trim();
}

async function readBodyWithinRouteLimit(request: Request, route: CaptureRouteConfig): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > route.maxBodyBytes) {
        await reader.cancel("capture route body limit exceeded");
        throw new CaptureRequestError(413, "request body exceeds the route body limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parsePebbleIndex(request: Request, route: CaptureRouteConfig, body: Uint8Array): Promise<TextCapture> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new CaptureRequestError(415, "Pebble Index requires multipart/form-data");
  }
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData().catch(() => {
    throw new CaptureRequestError(400, "malformed multipart form");
  });
  let measuredBytes = 0;
  for (const [, value] of form.entries()) {
    measuredBytes += typeof value === "string" ? Buffer.byteLength(value) : value.size;
  }
  if (measuredBytes > route.maxBodyBytes) throw new CaptureRequestError(413, "multipart fields exceed the route body limit");
  const audio = form.get("audio");
  if (audio instanceof File && audio.size > 0) {
    throw new CaptureRequestError(422, "this route is transcript-only; configure Pebble Send as Transcription only");
  }
  const text = formText(form, "transcription", true);
  const recordedAtText = formText(form, "recordedAt", true);
  const recordedAtMs = Number(recordedAtText);
  if (!Number.isSafeInteger(recordedAtMs) || recordedAtMs <= 0) {
    throw new CaptureRequestError(422, "recordedAt must be a positive Unix timestamp in milliseconds");
  }
  const client = formText(form, "client", false) || "ring";
  return {
    kind: "text",
    eventId: captureId(["pebble-index:v1", route.id, recordedAtText, client, text]),
    routeId: route.id,
    label: route.label,
    text,
    recordedAtMs,
    client,
  };
}

async function parseRawBody(
  request: Request,
  route: CaptureRouteConfig,
  createRawBodyWriter: typeof createWriteStream,
): Promise<BinaryCapture> {
  const contentType = (request.headers.get("content-type") || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (route.destination.type !== "directory") throw new Error("Raw body routes require a directory destination.");
  if (!request.body) throw new CaptureRequestError(422, "request body is empty");

  mkdirSync(route.destination.directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(route.destination.directory, `.${route.destination.filenamePrefix}-${randomUUID()}.tmp`);
  const writer = createRawBodyWriter(temporaryPath, { flags: "wx", mode: 0o600 });
  const reader = request.body.getReader();
  const hash = createHash("sha256");
  hash.update("raw-body:v1");
  hash.update("\0");
  hash.update(route.id);
  hash.update("\0");
  let sizeBytes = 0;
  let writerError: unknown = null;
  let signalWriterFailure!: () => void;
  const writerFailed = new Promise<void>((resolveFailure) => { signalWriterFailure = resolveFailure; });
  writer.on("error", (error) => {
    writerError = error;
    signalWriterFailure();
  });
  const guardWriter = async <T>(operation: Promise<T>): Promise<T> => {
    const outcome = await Promise.race([
      operation.then((value) => ({ failed: false as const, value })),
      writerFailed.then(() => ({ failed: true as const })),
    ]);
    if (outcome.failed) throw writerError || new Error("capture output stream failed");
    return outcome.value;
  };
  try {
    for (;;) {
      const chunk = await guardWriter(reader.read());
      if (chunk.done) break;
      sizeBytes += chunk.value.byteLength;
      if (sizeBytes > route.maxBodyBytes) {
        await reader.cancel("capture route body limit exceeded");
        throw new CaptureRequestError(413, "request body exceeds the route body limit");
      }
      hash.update(chunk.value);
      if (!writer.write(chunk.value)) await guardWriter(once(writer, "drain"));
    }
    if (sizeBytes === 0) throw new CaptureRequestError(422, "request body is empty");
    hash.update("\0");
    writer.end();
    await guardWriter(once(writer, "finish"));
    return {
      kind: "binary",
      eventId: hash.digest("hex"),
      routeId: route.id,
      temporaryPath,
      sizeBytes,
      contentType,
      receivedAtMs: Date.now(),
    };
  } catch (error) {
    writer.destroy();
    if (!writer.closed) await once(writer, "close").catch(() => {});
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function parseCapture(
  request: Request,
  route: CaptureRouteConfig,
  dependencies: CaptureRequestDependencies,
): Promise<Capture> {
  ensureBodyWithinRouteLimit(request, route);
  if (route.adapter === "raw-body") return parseRawBody(request, route, dependencies.createRawBodyWriter || createWriteStream);
  const body = await readBodyWithinRouteLimit(request, route);
  return parsePebbleIndex(request, route, body);
}

function jsonResponse(status: number, payload: Record<string, unknown>, headers: HeadersInit = {}) {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function createCaptureRequestHandler(
  config: CaptureIngressConfig,
  services: CaptureServices,
  dependencies: CaptureRequestDependencies = {},
) {
  const routesByPath = new Map(config.routes.map((route) => [route.path, route]));
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === config.server.healthPath) {
      return request.method === "GET"
        ? jsonResponse(200, { ok: true })
        : jsonResponse(405, { error: "method_not_allowed" }, { allow: "GET" });
    }
    const route = routesByPath.get(path);
    if (!route) return jsonResponse(404, { error: "not_found" });
    if (request.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" }, { allow: "POST" });
    if (!authorized(request, route.auth)) {
      return jsonResponse(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    }
    let capture: Capture | null = null;
    try {
      capture = await parseCapture(request, route, dependencies);
      const accepted = await services.accept(route, capture);
      const responseStatus = capture.kind === "binary" ? 201 : accepted.duplicate ? 200 : 202;
      return jsonResponse(responseStatus, {
        accepted: true,
        event_id: accepted.eventId,
        duplicate: accepted.duplicate,
        status: accepted.status,
        ...(accepted.filename ? { saved: accepted.filename } : {}),
        ...(accepted.bytes !== undefined ? { bytes: accepted.bytes } : {}),
      });
    } catch (error) {
      if (capture?.kind === "binary" && existsSync(capture.temporaryPath)) unlinkSync(capture.temporaryPath);
      if (error instanceof CaptureRequestError) return jsonResponse(error.status, { error: error.message });
      log("error", "capture_ingress_request_failed", { route_id: route.id, ...errorFields(error) });
      return jsonResponse(503, { error: "capture_unavailable" });
    }
  };
}

function slackText(capture: TextCapture): string {
  const recordedAt = new Date(capture.recordedAtMs).toISOString();
  return `Voice capture: ${capture.label}\nRecorded: ${recordedAt}\n\n${capture.text}\n\n— via ${capture.routeId}`;
}

function extensionFor(contentType: string): string {
  return ({
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/aac": ".aac",
    "audio/webm": ".webm",
    "application/json": ".json",
    "text/plain": ".txt",
  } as Record<string, string>)[contentType] || ".bin";
}

function storeBinaryCapture(route: CaptureRouteConfig, capture: BinaryCapture): CaptureAcceptance {
  if (route.destination.type !== "directory") throw new Error("Binary captures require a directory destination.");
  mkdirSync(route.destination.directory, { recursive: true, mode: 0o700 });
  const filename = `${route.destination.filenamePrefix}-${capture.eventId}${extensionFor(capture.contentType)}`;
  const output = join(route.destination.directory, basename(filename));
  let duplicate = false;
  try {
    linkSync(capture.temporaryPath, output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    duplicate = true;
  } finally {
    if (existsSync(capture.temporaryPath)) unlinkSync(capture.temporaryPath);
  }
  log("info", "capture_binary_stored", {
    route_id: route.id,
    event_id: capture.eventId,
    filename,
    bytes: capture.sizeBytes,
  });
  return { eventId: capture.eventId, duplicate, status: "stored", filename, bytes: capture.sizeBytes };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

export class ProductionCaptureServices implements CaptureServices {
  private stopping = false;

  constructor(
    private readonly config: CaptureIngressConfig,
    private readonly dependencies: ProductionCaptureDependencies = {},
  ) {}

  async accept(route: CaptureRouteConfig, capture: Capture): Promise<CaptureAcceptance> {
    if (capture.kind === "binary") return storeBinaryCapture(route, capture);
    if (route.destination.type !== "slack") throw new Error("Text captures require a Slack destination.");
    const messageText = slackText(capture);
    if (messageText.length > MAX_SLACK_MESSAGE_CHARACTERS) {
      throw new CaptureRequestError(422, `rendered transcript exceeds Slack's ${MAX_SLACK_MESSAGE_CHARACTERS.toLocaleString("en-US")}-character limit`);
    }
    const stored = await this.persist(() => createCaptureEvent({
        eventId: capture.eventId,
        routeId: route.id,
        destinationChannel: route.destination.channelId,
        messageText,
        recordedAtMs: capture.recordedAtMs,
        sourceClient: capture.client,
        clientMessageId: clientMessageId(capture.eventId),
    }), capture.eventId);
    return {
      eventId: stored.event.event_id,
      duplicate: !stored.created,
      status: stored.event.status === "delivered" ? "delivered" : stored.event.status === "parked" ? "parked" : "queued",
    };
  }

  recover() {
    for (const route of this.config.routes) {
      if (route.destination.type !== "directory" || !existsSync(route.destination.directory)) continue;
      const prefix = `.${route.destination.filenamePrefix}-`;
      for (const filename of readdirSync(route.destination.directory)) {
        if (filename.startsWith(prefix) && filename.endsWith(".tmp")) {
          unlinkSync(join(route.destination.directory, filename));
        }
      }
    }
    log("info", "capture_ingress_recovered");
  }

  async close() {
    this.stopping = true;
  }

  private async persist<T>(operation: () => T, eventId?: string): Promise<T> {
    const result = await retryTransientDatabaseOperation({
      operation: () => {
        this.dependencies.beforePersistence?.(eventId);
        return operation();
      },
      shouldStop: () => this.stopping,
      wait,
    });
    if (result.stopped) throw new Error("Capture service stopped before durable state could be persisted.");
    return result.value;
  }
}

export interface CaptureIngressRuntimeOptions {
  dependencies?: ProductionCaptureDependencies;
}

export function startCaptureIngress(
  config = loadCaptureIngressConfig(),
  options: CaptureIngressRuntimeOptions = {},
) {
  const services = new ProductionCaptureServices(config, options.dependencies);
  const queueServer = startCaptureQueueServer(config.queue);
  const handler = createCaptureRequestHandler(config, services);
  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    maxRequestBodySize: config.server.maxRequestBodyBytes,
    idleTimeout: 15,
    fetch: handler,
    error(error) {
      log("error", "capture_ingress_unhandled_error", errorFields(error));
      return jsonResponse(500, { error: "internal_error" });
    },
  });
  services.recover();
  log("info", "capture_ingress_online", {
    hostname: server.hostname,
    port: server.port,
    routes: config.routes.map((route) => ({ id: route.id, path: route.path, adapter: route.adapter, destination: route.destination.type })),
  });
  let stopPromise: Promise<void> | null = null;
  const stop = (signal: string) => {
    if (!stopPromise) {
      stopPromise = (async () => {
        log("info", "capture_ingress_drain_started", { signal });
        await server.stop(false);
        await queueServer.stop(false);
        await services.close();
        log("info", "capture_ingress_drain_complete", { signal });
      })();
    }
    return stopPromise;
  };
  return { server, queueServer, services, stop };
}

if (import.meta.main) {
  try {
    const ingress = startCaptureIngress();
    const exitAfterStop = (signal: string) => {
      void ingress.stop(signal).then(() => process.exit(process.exitCode || 0));
    };
    process.on("SIGTERM", () => exitAfterStop("SIGTERM"));
    process.on("SIGINT", () => exitAfterStop("SIGINT"));
  } catch (error) {
    log("error", "capture_ingress_startup_failed", errorFields(error));
    process.exit(1);
  }
}
