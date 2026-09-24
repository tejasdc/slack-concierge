import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { errorFields, log } from "./log";
import { currentProcessIdentity, type ProcessIdentity } from "./runtime-identity";
import { captureDb, type CaptureEventRow, type CaptureSource } from "./capture-state";
import { retainedCaptureAttachments } from "./capture-attachments";
import { createRetryBreaker } from "./retry-breaker-core";
import { withRetry } from "./retry";
import { RETRY_POLICIES } from "./retry-policies";


const REQUEST_TIMEOUT_MS = 10_000;
const { clearRetryBreaker, recordRetryFailure } = createRetryBreaker(captureDb);
export const JOURNALMAXX_INBOX_SINK = "journalmaxx-inbox";
export const PRODUCTION_JOURNALMAXX_INBOX = "/root/workspace/vault/inbox";
export const THINKERING_INBOX_SINK = "thinkering-inbox";
export const PRODUCTION_THINKERING_INBOX = "/var/lib/thinkering/production/capture-inbox";

export class SlackCaptureDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

export class JournalCaptureDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

class SessionCaptureDeliveryError extends Error {
  readonly retryAfterMs = null;
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

export interface InboxCaptureDelivery {
  source: CaptureSource;
  text: string;
  files: Array<{ name: string; contentType: string; base64: string }>;
}

class CaptureWorkerStopped extends Error {}

export interface CaptureDeliveryWorkerOptions {
  queueUrl: string;
  queueToken: string;
  owner?: ProcessIdentity;
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  journalRoots?: Readonly<Record<string, string>>;
  deliverInboxCapture?(capture: InboxCaptureDelivery): unknown | Promise<unknown>;
  onFatal?: (error: unknown) => void;
}

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function ownerPayload(owner: ProcessIdentity) {
  return { pid: owner.pid, boot_id: owner.bootId, start_ticks: owner.startTicks };
}

function queueCredentialPath(name: string): string {
  const credentialDirectory = process.env.CREDENTIALS_DIRECTORY;
  if (credentialDirectory) return join(credentialDirectory, name);
  return process.env.CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE || "/etc/concierge/capture-queue.token";
}

export function loadCaptureQueueToken(name = "capture_queue"): string {
  return loadCaptureQueueTokenFromPath(queueCredentialPath(name));
}

export function loadCaptureQueueTokenFromPath(tokenPath: string, containedBy?: string): string {
  const path = resolve(tokenPath);
  const file = containedBy ? lstatSync(path) : statSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(`Capture queue credential permissions are unsafe: ${path}`);
  if (containedBy) {
    const canonicalRoot = realpathSync(containedBy);
    const canonicalPath = realpathSync(path);
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Sandbox capture queue credential escapes the active run state directory.");
    }
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 24) throw new Error("Capture queue credential is too short.");
  return token;
}

export type JournalDurabilityBarrier = "temporary_file" | "existing_file" | "installed_directory" | "cleaned_directory";

function journalPermanentFailure(message: string): never {
  throw new JournalCaptureDeliveryError(message, false);
}

function journalPath(root: string, eventId: string) {
  if (!/^[a-f0-9]{64}$/.test(eventId)) journalPermanentFailure("Journal capture event ID is unsafe.");
  const filename = `pebble-${eventId}.md`;
  const temporaryFilename = `.pebble-${eventId}.tmp`;
  if (basename(filename) !== filename || basename(temporaryFilename) !== temporaryFilename) {
    journalPermanentFailure("Journal capture filename is unsafe.");
  }
  const output = resolve(root, filename);
  const temporary = resolve(root, temporaryFilename);
  if (relative(root, output).startsWith("..") || relative(root, temporary).startsWith("..")) {
    journalPermanentFailure("Journal capture path escapes its trusted root.");
  }
  return { filename, output, temporary };
}

function syncDescriptor(path: string, directory: boolean) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
      journalPermanentFailure(`Journal ${directory ? "root" : "file"} changed to an unsafe object.`);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function existingRegularFile(path: string, label: string): boolean {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) journalPermanentFailure(`Journal ${label} is not a regular file.`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeEventTemporaryFile(
  temporary: string,
  root: string,
  barrier?: (barrier: JournalDurabilityBarrier) => void,
) {
  if (!existingRegularFile(temporary, "temporary path")) return;
  unlinkSync(temporary);
  syncDescriptor(root, true);
  barrier?.("cleaned_directory");
}

function acceptExistingJournalFile(input: {
  output: string;
  temporary: string;
  root: string;
  bytes: Buffer;
  barrier?: (barrier: JournalDurabilityBarrier) => void;
}) {
  if (!existingRegularFile(input.output, "final path")) return false;
  const descriptor = openSync(input.output, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) journalPermanentFailure("Journal final path changed to an unsafe object.");
    if (!readFileSync(descriptor).equals(input.bytes)) {
      journalPermanentFailure("Journal final file conflicts with the accepted capture bytes.");
    }
    fsyncSync(descriptor);
    input.barrier?.("existing_file");
  } finally {
    closeSync(descriptor);
  }
  syncDescriptor(input.root, true);
  input.barrier?.("installed_directory");
  removeEventTemporaryFile(input.temporary, input.root, input.barrier);
  return true;
}

export function deliverJournalCapture(input: {
  event: CaptureEventRow;
  root: string;
  barrier?: (barrier: JournalDurabilityBarrier) => void;
}): string {
  try {
    if (input.event.delivery_kind !== "journal" || ![JOURNALMAXX_INBOX_SINK, THINKERING_INBOX_SINK].includes(String(input.event.journal_sink))) {
      journalPermanentFailure("Capture event does not name the supported journal sink.");
    }
    const configuredRoot = resolve(input.root);
    const rootStat = lstatSync(configuredRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      journalPermanentFailure("Journal root is not a real directory.");
    }
    const canonicalRoot = realpathSync(configuredRoot);
    if (canonicalRoot !== configuredRoot) journalPermanentFailure("Journal root resolves through a symbolic link.");
    const paths = journalPath(canonicalRoot, input.event.event_id);
    const bytes = Buffer.from(input.event.message_text, "utf8");
    if (acceptExistingJournalFile({ ...paths, root: canonicalRoot, bytes, barrier: input.barrier })) {
      return paths.filename;
    }
    removeEventTemporaryFile(paths.temporary, canonicalRoot, input.barrier);
    const descriptor = openSync(
      paths.temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) journalPermanentFailure("Journal temporary path is not a regular file.");
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      input.barrier?.("temporary_file");
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(paths.temporary, paths.output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!acceptExistingJournalFile({ ...paths, root: canonicalRoot, bytes, barrier: input.barrier })) throw error;
      return paths.filename;
    }
    syncDescriptor(canonicalRoot, true);
    input.barrier?.("installed_directory");
    unlinkSync(paths.temporary);
    syncDescriptor(canonicalRoot, true);
    input.barrier?.("cleaned_directory");
    return paths.filename;
  } catch (error) {
    if (error instanceof JournalCaptureDeliveryError) throw error;
    throw new JournalCaptureDeliveryError(`Journal filesystem delivery failed: ${String(error)}`, true);
  }
}

export class CaptureDeliveryWorker {
  private readonly owner: ProcessIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private stopping = false;
  private running: Promise<void> | null = null;
  private ready: Promise<void> | null = null;
  private fatalReported = false;

  constructor(private readonly options: CaptureDeliveryWorkerOptions) {
    this.owner = options.owner || currentProcessIdentity();
    this.fetchImpl = options.fetch || fetch;
    this.wait = options.wait || defaultWait;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
  }

  async prepare(): Promise<void> {
    const health = await this.fetchImpl(`${this.options.queueUrl}/health`, {
      headers: { authorization: `Bearer ${this.options.queueToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const healthResult: any = await health.json().catch(() => null);
    if (!health.ok || !healthResult?.ok) {
      throw new Error(`Capture queue readiness failed: ${String(healthResult?.error || health.status)}`);
    }
    log("info", "capture_delivery_dependencies_ready", { queue_url: this.options.queueUrl });
  }

  async start(): Promise<void> {
    if (this.running) {
      await this.ready;
      return;
    }
    this.stopping = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.running = this.run(resolveReady)
      .catch((error) => {
        rejectReady(error);
        if (error instanceof CaptureWorkerStopped || this.stopping) return;
        this.stopping = true;
        if (this.fatalReported) return;
        this.fatalReported = true;
        log("error", "capture_delivery_worker_fatal", errorFields(error));
        this.options.onFatal?.(error);
      });
    await this.ready;
    log("info", "capture_delivery_worker_online", { queue_url: this.options.queueUrl, owner_pid: this.owner.pid });
  }

  async stop() {
    this.stopping = true;
    await this.running;
  }

  private async run(reportReady: () => void) {
    let ready = false;
    while (!this.stopping) {
      const claimId = randomUUID();
      const event = await this.claimNext(claimId);
      if (!ready) {
        ready = true;
        reportReady();
      }
      if (!event) {
        await this.wait(this.pollIntervalMs);
        continue;
      }
      await this.deliver(claimId, event);
    }
  }

  private async queueRequest(path: string, body?: Record<string, unknown>): Promise<Response> {
    if (this.stopping) throw new CaptureWorkerStopped();
    return withRetry({ operation: "capture-queue", key: this.options.queueUrl, policy: RETRY_POLICIES.captureDelivery,
      wait: this.wait,
      run: async () => {
        const response = await this.fetchImpl(`${this.options.queueUrl}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${this.options.queueToken}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status >= 500) throw new Error(`Capture queue answered ${response.status}.`);
        return response;
      },
      classifyError: () => "transient",
    });
  }

  private async claimNext(claimId: string): Promise<CaptureEventRow | null> {
    const response = await this.queueRequest("/claim", { claim_id: claimId, owner: ownerPayload(this.owner) });
    if (response.status === 204) return null;
    const result: any = await response.json().catch(() => null);
    if (!response.ok || !result?.event) throw new Error(`Capture queue claim failed: ${String(result?.error || response.status)}`);
    const event = result.event as CaptureEventRow;
    if (event.delivery_claim_id !== claimId
      || event.delivery_owner_pid !== this.owner.pid
      || event.delivery_owner_boot_id !== this.owner.bootId
      || event.delivery_owner_start_ticks !== this.owner.startTicks) {
      throw new Error("Capture queue returned an event owned by a different claim.");
    }
    return event;
  }

  private async acknowledge(
    operation: "delivered" | "retry" | "park",
    claimId: string,
    event: CaptureEventRow,
    fields: Record<string, unknown>,
  ) {
    const response = await this.queueRequest(
      `/events/${encodeURIComponent(event.event_id)}/${operation}`,
      { claim_id: claimId, owner: ownerPayload(this.owner), ...fields },
    );
    const result: any = await response.json().catch(() => null);
    if (!response.ok || !result?.ok) {
      throw new Error(`Capture queue ${operation} failed: ${String(result?.error || response.status)}`);
    }
  }

  private async deliver(claimId: string, event: CaptureEventRow) {
    try {
      if (event.delivery_kind === "session") {
        if (!this.options.deliverInboxCapture) throw new SessionCaptureDeliveryError("Native Inbox delivery is unavailable", false);
        const source = JSON.parse(event.source_snapshot_json || "null") as CaptureSource | null;
        if (!source || source.id !== event.event_id) throw new SessionCaptureDeliveryError("Native capture source identity is missing or mismatched", false);
        let result: any;
        try {
          result = await this.options.deliverInboxCapture({
            source,
            text: event.message_text,
            files: retainedCaptureAttachments(event.attachment_snapshot_json).map(file => ({
              name: file.filename, contentType: file.contentType, base64: file.dataBase64,
            })),
          });
        } catch (error) {
          const status = Number((error as any)?.status);
          const code = String((error as any)?.code || "");
          throw new SessionCaptureDeliveryError("Native Inbox admission failed; retained capture requires retry or inspection",
            status >= 500 || code === "SQLITE_BUSY" || code === "SQLITE_LOCKED");
        }
        if (typeof result?.inbox?.sessionId !== "string" || !result.inbox.sessionId
          || typeof result?.operation?.id !== "string" || !result.operation.id
          || result?.item?.sessionId !== result.inbox.sessionId
          || result?.item?.inputId !== result.operation.id
          || result?.item?.source?.id !== source.id || result?.item?.source?.kind !== source.kind) {
          throw new SessionCaptureDeliveryError("Native Inbox receipt does not match the retained capture", false);
        }
        await this.acknowledge("delivered", claimId, event, {
          session_id: result.inbox.sessionId, session_input_id: result.operation.id,
        });
        clearRetryBreaker(`capture:${event.event_id}`);
        log("info", "capture_delivery_ok", { event_id: event.event_id, route_id: event.route_id,
          destination_kind: "session", terminal_receipt: result.operation.id, session_id: result.inbox.sessionId });
        return;
      }
      // Captures were once published into Slack with Tejas's own user token, so the bot
      // would read them as his messages. That token is revoked and no route delivers to
      // Slack; a leftover row is held for inspection, never posted as him.
      if (event.delivery_kind === "slack") {
        throw new SlackCaptureDeliveryError("Slack capture delivery is retired; this row needs inspection", false);
      }
      const receipt = {
        field: "journal_file_path",
        value: deliverJournalCapture({
          event,
          root: (this.options.journalRoots || {
            [JOURNALMAXX_INBOX_SINK]: PRODUCTION_JOURNALMAXX_INBOX,
            [THINKERING_INBOX_SINK]: PRODUCTION_THINKERING_INBOX,
          })[String(event.journal_sink)] || journalPermanentFailure("Capture event names an unknown journal sink."),
        }),
      };
      await this.acknowledge("delivered", claimId, event, { [receipt.field]: receipt.value });
      clearRetryBreaker(`capture:${event.event_id}`);
      log("info", "capture_delivery_ok", {
        event_id: event.event_id,
        route_id: event.route_id,
        destination_kind: event.delivery_kind,
        terminal_receipt: receipt.value,
      });
    } catch (error) {
      const deliveryError = error instanceof SlackCaptureDeliveryError || error instanceof JournalCaptureDeliveryError || error instanceof SessionCaptureDeliveryError
        ? error
        : null;
      if (!deliveryError) throw error;
      const decision = recordRetryFailure({ key: `capture:${event.event_id}`, site: "capture", what: "An Inbox capture",
        failure: { kind: deliveryError.retryable ? "transient" : "permanent", reason: deliveryError.message,
          retryAfterMs: deliveryError.retryAfterMs,
          restartSignal: "the capture is retried explicitly" },
      });
      if (decision.action !== "retry") {
        await this.acknowledge("park", claimId, event, { error: deliveryError.message });
        log("error", "capture_delivery_parked", { event_id: event.event_id, route_id: event.route_id, error: deliveryError.message });
        return;
      }
      const delayMs = decision.atMs - Date.now();
      await this.acknowledge("retry", claimId, event, {
        error: deliveryError.message,
        next_attempt_ms: Date.now() + delayMs,
      });
      log("warn", "capture_delivery_retry", {
        event_id: event.event_id,
        route_id: event.route_id,
        attempt: event.delivery_attempts,
        delay_ms: delayMs,
        error: deliveryError.message,
      });
    }
  }
}
