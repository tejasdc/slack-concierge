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
import { isTransientSlackError } from "./slack-errors";
import type { CaptureEventRow } from "./capture-state";

import { RouterActionError, runRouterAction } from "../scripts/router-post";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const REQUEST_TIMEOUT_MS = 10_000;
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

class CaptureWorkerStopped extends Error {}

export interface CaptureDeliveryWorkerOptions {
  queueUrl: string;
  queueToken: string;
  slackUserToken: string;
  owner?: ProcessIdentity;
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  pollIntervalMs?: number;
  expectedSlackTeamId?: string;
  journalRoots?: Readonly<Record<string, string>>;
  onFatal?: (error: unknown) => void;
}

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function retryDelay(attempt: number, override: number | null): number {
  return override ?? Math.min(1_000 * (2 ** Math.max(0, attempt - 1)), 30_000);
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

export async function validateSlackUserToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
  expectedTeamId?: string,
): Promise<string> {
  if (!token.startsWith("xoxp-") || token.length < 24) throw new Error("Concierge user_token must be a Slack user OAuth token.");
  const response = await fetchImpl(SLACK_AUTH_TEST_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const result: any = await response.json().catch(() => null);
  if (!response.ok || !result?.ok || !result.user_id) {
    throw new Error(`Concierge user_token failed auth.test: ${String(result?.error || response.status)}`);
  }
  if (expectedTeamId && String(result.team_id || "") !== expectedTeamId) {
    throw new Error("Concierge user_token does not belong to the expected sandbox workspace.");
  }
  return String(result.user_id);
}

export async function postCaptureToSlack(input: {
  event: CaptureEventRow;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string> {
  const fetchImpl = input.fetch || fetch;
  const thinkering = input.event.route_id === "thinkering";
  if (thinkering && Array.from(input.event.message_text).length > 4_000) {
    try {
      const receipt = await runRouterAction({
        verb: "post", channel: input.event.destination_channel,
        text: "Selected content attached as thinkering-capture.txt.\n\n— via thinkering",
        filePaths: [], fileIds: [],
      }, ((url, init) => fetchImpl(url, {
        ...init, signal: init?.signal || AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
      })) as typeof fetch, undefined, {
        channel: input.event.destination_channel, token: input.token,
        files: [{ title: "thinkering-capture.txt", bytes: Buffer.from(input.event.message_text, "utf8") }],
      });
      return receipt.ts;
    } catch (error) {
      // A permalink failure cannot erase an already proven exact message receipt.
      if (error instanceof RouterActionError && error.context?.delivery === "confirmed"
          && error.context.ts && error.code !== "message_truncated") return error.context.ts;
      const fileIds = error instanceof RouterActionError ? error.context?.file_ids || [] : [];
      throw new SlackCaptureDeliveryError(`Thinkering upload requires inspection; file_ids=${fileIds.join(",")}`, false);
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(SLACK_POST_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json; charset=utf-8",
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        channel: input.event.destination_channel,
        text: input.event.message_text,
        client_msg_id: input.event.client_msg_id,
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
  } catch (error) {
    throw new SlackCaptureDeliveryError(thinkering ? "Thinkering Slack transport outcome is ambiguous" : `Slack transport failed: ${String(error)}`, !thinkering);
  }
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : null;
  if (response.status === 429) throw new SlackCaptureDeliveryError("Slack rate limited capture delivery", true, retryAfterMs);
  if (response.status >= 500) throw new SlackCaptureDeliveryError(`Slack HTTP ${response.status}`, !thinkering);
  if (!response.ok) throw new SlackCaptureDeliveryError(`Slack HTTP ${response.status}`, false);
  const result: any = await response.json().catch(() => null);
  if (result?.ok) {
    const messageTs = result.ts || result.message?.ts;
    if (thinkering && (result.channel !== input.event.destination_channel
        || result.warning === "message_truncated"
        || result.response_metadata?.warnings?.includes("message_truncated"))) {
      throw new SlackCaptureDeliveryError("Thinkering Slack receipt is mismatched or truncated; inspect before retrying", false);
    }
    if (typeof messageTs !== "string" || !messageTs) {
      throw new SlackCaptureDeliveryError("Slack response omitted capture message timestamp", false);
    }
    return messageTs;
  }
  const slackError = Object.assign(new Error(String(result?.error || "slack_api_error")), { data: result });
  throw new SlackCaptureDeliveryError(slackError.message, thinkering ? result?.error === "ratelimited" : isTransientSlackError(slackError));
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
    const userId = await validateSlackUserToken(
      this.options.slackUserToken,
      this.fetchImpl,
      this.options.expectedSlackTeamId,
    );
    log("info", "capture_delivery_dependencies_ready", { slack_user_id: userId, queue_url: this.options.queueUrl });
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
    while (!this.stopping) {
      try {
        const response = await this.fetchImpl(`${this.options.queueUrl}${path}`, {
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${this.options.queueToken}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status < 500) return response;
        log("warn", "capture_queue_request_retry", { path, status: response.status });
      } catch (error) {
        log("warn", "capture_queue_transport_retry", { path, ...errorFields(error) });
      }
      await this.wait(this.pollIntervalMs);
    }
    throw new CaptureWorkerStopped();
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
      const receipt = event.delivery_kind === "slack"
        ? {
          field: "slack_message_ts",
          value: await postCaptureToSlack({
            event,
            token: this.options.slackUserToken,
            fetch: this.fetchImpl,
          }),
        }
        : {
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
      log("info", "capture_delivery_ok", {
        event_id: event.event_id,
        route_id: event.route_id,
        destination_kind: event.delivery_kind,
        terminal_receipt: receipt.value,
      });
    } catch (error) {
      const deliveryError = error instanceof SlackCaptureDeliveryError || error instanceof JournalCaptureDeliveryError
        ? error
        : null;
      if (!deliveryError) throw error;
      if (!deliveryError.retryable) {
        await this.acknowledge("park", claimId, event, { error: deliveryError.message });
        log("error", "capture_delivery_parked", { event_id: event.event_id, route_id: event.route_id, error: deliveryError.message });
        return;
      }
      const delayMs = retryDelay(event.delivery_attempts, deliveryError.retryAfterMs);
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
