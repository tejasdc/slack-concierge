import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { errorFields, log } from "./log";
import { currentProcessIdentity, type ProcessIdentity } from "./runtime-identity";
import { isTransientSlackError } from "./slack-errors";
import type { CaptureEventRow } from "./capture-state";

const SLACK_POST_URL = "https://slack.com/api/chat.postMessage";
const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";
const REQUEST_TIMEOUT_MS = 10_000;

export class SlackCaptureDeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
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
}): Promise<string | null> {
  const fetchImpl = input.fetch || fetch;
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
    throw new SlackCaptureDeliveryError(`Slack transport failed: ${String(error)}`, true);
  }
  const retryAfterSeconds = Number(response.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1_000 : null;
  if (response.status === 429) throw new SlackCaptureDeliveryError("Slack rate limited capture delivery", true, retryAfterMs);
  if (response.status >= 500) throw new SlackCaptureDeliveryError(`Slack HTTP ${response.status}`, true);
  if (!response.ok) throw new SlackCaptureDeliveryError(`Slack HTTP ${response.status}`, false);
  const result: any = await response.json().catch(() => null);
  if (result?.ok) return result.ts || result.message?.ts || null;
  const slackError = Object.assign(new Error(String(result?.error || "slack_api_error")), { data: result });
  throw new SlackCaptureDeliveryError(slackError.message, isTransientSlackError(slackError));
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
      const slackMessageTs = await postCaptureToSlack({
        event,
        token: this.options.slackUserToken,
        fetch: this.fetchImpl,
      });
      await this.acknowledge("delivered", claimId, event, { slack_message_ts: slackMessageTs });
      log("info", "capture_delivery_ok", {
        event_id: event.event_id,
        route_id: event.route_id,
        destination_channel: event.destination_channel,
        slack_message_ts: slackMessageTs,
      });
    } catch (error) {
      const deliveryError = error instanceof SlackCaptureDeliveryError ? error : null;
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
