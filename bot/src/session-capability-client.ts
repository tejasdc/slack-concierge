import { createHash } from "node:crypto";
import { request } from "node:http";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentProvider, ProviderCapabilities } from "./providers";
import type { RunResult } from "./codex";
import { ProviderDispatchError, ProviderTurnCancelledError } from "./provider-failures";

export interface CapabilityRunRef {
  operationId: string;
  sessionId: string;
  inputId: string;
  runId: string;
}

export interface SourceEvidence {
  sourceId: string;
  sourceVersion: string;
  eventId: string;
  ordinal: number;
  role: "user" | "assistant" | "tool";
  locator: string;
  textHash: string;
  text: string;
}

export interface CapabilitySource {
  id: string;
  provider: "codex" | "claude-code" | "chatgpt";
  scope: string;
  nativeId: string;
  synthetic: boolean;
  title: string;
  createdAt: string;
  project: string | null;
  version: string;
  branch: string;
  messages: SourceEvidence[];
  omissions: string[];
  consultation: { sourceId: string; sourceVersion: string; boundary: string; packetVersion: "dialogue-v1" } | null;
}

export interface SourceRefresh {
  accountScope: string | null;
  state: "idle" | "refreshing" | "partial" | "failed";
  inventoryComplete: boolean;
  discovered: number;
  saved: number;
  indexed: number;
  failed: number;
  reportedTotal: number | null;
  lastAttemptAt: string | null;
  lastCompleteAt: string | null;
  reason: string | null;
}

export interface SourceSearchResult {
  sources: CapabilitySource[];
  matches: SourceEvidence[];
  complete: boolean;
  reason: string | null;
  indexedAt: string | null;
  refresh: SourceRefresh[];
}

export interface SourceRef { sourceId: string; sourceVersion: string; branch: string }

export interface CapabilityMessage {
  id: string;
  role: string;
  content: string;
  tool: string | null;
  phase: string | null;
  detailKey?: string;
  submissionId?: string;
  toolCallId?: string;
  turnId?: string;
  attachments?: { id: string; name: string; contentType: string }[];
  richContent?: { version: 1; parts: Record<string, unknown>[] };
  source?: SourceEvidence;
}

export interface ChatGptBinding {
  accountScope: string;
  sessionId: string;
  anchor?: { sourceId: string; sourceVersion: string; messageId: string; branch: string; textHash: string };
}

export interface CapabilityAttachment {
  id: string;
  name: string;
  contentType: string;
  sha256: string;
  base64: string;
}

export interface ChatGptAdmission {
  provider: "chatgpt";
  purpose: "chat";
  inputId: string;
  runId: string;
  bindingGeneration: number;
  admittedAt: string;
  promptHash: string;
  model: string | null;
  attachments: Omit<CapabilityAttachment, "base64">[];
  policy: "standard";
  nativeBinding: ChatGptBinding | null;
}

export interface ChatGptProviderInput {
  id: string;
  prompt: string;
  purpose: "chat";
  model: string | null;
  attachments: CapabilityAttachment[];
  policy: "standard";
  nativeBinding: ChatGptBinding | null;
}

export type CapabilityFailure = { code: string; message: string };
export interface ChatGptResult {
  sessionId: string | null;
  turnId: string | null;
  text: string;
  state: "completed" | "failed" | "canceled" | "uncertain";
  error: CapabilityFailure | string | null;
  nativeBinding: ChatGptBinding | null;
}

export interface ChatGptReceipt {
  runId: string;
  state: "recorded" | "running" | "completed" | "failed" | "canceled" | "uncertain";
  acknowledgedAt: string | null;
  nativeBinding: ChatGptBinding | null;
  result: ChatGptResult | null;
  error: CapabilityFailure | null;
}

export interface ChatGptEvent {
  cursor: string;
  eventId: string;
  runId: string;
  inputId: string;
  kind: "identity" | "message" | "result";
  at: string;
  payload: Record<string, unknown>;
}

export interface ChatGptObservation {
  runId: string;
  events: ChatGptEvent[];
  nextCursor: string | null;
  complete: boolean;
  result: ChatGptResult | null;
}

export type CapabilityEvidence =
  | { kind: "start" | "reconcile"; run: CapabilityRunRef; receipt: ChatGptReceipt }
  | { kind: "observe"; run: CapabilityRunRef; after: string | null; observation: ChatGptObservation }
  | { kind: "failure"; run: CapabilityRunRef; after: string | null; code: string; message: string; status: number | null; uncertain: boolean };

export interface ChatGptRunContext {
  run: CapabilityRunRef;
  admission: ChatGptAdmission;
  attachments: CapabilityAttachment[];
  onEvidence(evidence: CapabilityEvidence): void | Promise<void>;
  onNativeBinding?(binding: ChatGptBinding): void | Promise<void>;
  signal?: AbortSignal;
}

export interface ChatGptReadRef { sessionId: string; bindingGeneration: number; binding: ChatGptBinding }

export const chatGptCapabilities: ProviderCapabilities = {
  send: true, stop: false, steer: false, consultation: false, history: true,
  fork: false, forkBoundary: null, consultationFork: false,
  reason: "ChatGPT native Stop, steering, fork, outbound tools and enforced consultation are unavailable.",
};

export class SessionCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null = null,
    readonly uncertain = false,
  ) {
    super(message);
    this.name = "SessionCapabilityError";
  }
}

export class ChatGptDispatchError extends ProviderDispatchError {
  constructor(readonly evidence: Extract<CapabilityEvidence, { kind: "failure" }>, binding: ChatGptBinding | null, turnId: string | null) {
    super({ message: evidence.message, failureClass: "parked_terminal", terminalConfirmed: !evidence.uncertain,
      providerSessionId: binding?.sessionId, providerTurnId: turnId });
    this.name = "ChatGptDispatchError";
  }
}

const providerPath = "/session-capabilities/v1/provider/";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);

function verify(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SessionCapabilityError("CAPABILITY_PROTOCOL_ERROR", message);
}

function exactFields(value: object, names: string[]) {
  verify(Object.keys(value).every(key => names.includes(key)), "Capability input contains unsupported fields.");
}

function runRef(input: CapabilityRunRef): CapabilityRunRef {
  verify(nonempty(input.operationId) && nonempty(input.inputId) && nonempty(input.runId)
    && /^concierge:[1-9][0-9]*$/.test(input.sessionId), "An exact owner run reference is required.");
  return { operationId: input.operationId, sessionId: input.sessionId, inputId: input.inputId, runId: input.runId };
}

function verifyBinding(binding: unknown): asserts binding is ChatGptBinding {
  verify(isRecord(binding) && nonempty(binding.accountScope) && nonempty(binding.sessionId), "Invalid native binding.");
  exactFields(binding, ["accountScope", "sessionId", "anchor"]);
  if (binding.anchor !== undefined) {
    const anchor = binding.anchor;
    verify(isRecord(anchor) && nonempty(anchor.sourceId) && isHash(anchor.sourceVersion)
      && nonempty(anchor.messageId) && nonempty(anchor.branch) && isHash(anchor.textHash), "Invalid native source anchor.");
    exactFields(anchor, ["sourceId", "sourceVersion", "messageId", "branch", "textHash"]);
  }
}

function verifyEvidence(evidence: SourceEvidence, pin?: { sourceId: string; sourceVersion: string }) {
  verify(isRecord(evidence) && nonempty(evidence.sourceId) && isHash(evidence.sourceVersion)
    && nonempty(evidence.eventId) && Number.isSafeInteger(evidence.ordinal) && evidence.ordinal >= 0
    && ["user", "assistant", "tool"].includes(evidence.role) && nonempty(evidence.locator)
    && typeof evidence.text === "string" && digest(evidence.text) === evidence.textHash, "Source evidence bytes or identity do not match.");
  if (pin) verify(evidence.sourceId === pin.sourceId && evidence.sourceVersion === pin.sourceVersion, "Source evidence changed its pinned source/version.");
}

function verifySource(source: CapabilitySource, pin?: SourceRef) {
  verify(isRecord(source) && nonempty(source.id) && isHash(source.version) && nonempty(source.branch)
    && Array.isArray(source.messages) && Array.isArray(source.omissions), "Invalid retained source.");
  if (pin) verify(source.id === pin.sourceId && source.version === pin.sourceVersion && source.branch === pin.branch,
    "The capability substituted the pinned source/version/branch.");
  for (const evidence of source.messages) verifyEvidence(evidence, { sourceId: source.id, sourceVersion: source.version });
  if (source.consultation) verify(source.consultation.sourceId === source.id && source.consultation.sourceVersion === source.version
    && source.consultation.packetVersion === "dialogue-v1", "Consultation source pins changed.");
}

function verifyHistory(value: { messages: CapabilityMessage[]; nextCursor: string | null }, pin?: SourceRef) {
  verify(isRecord(value) && Array.isArray(value.messages) && (value.nextCursor === null || nonempty(value.nextCursor)), "Invalid history page.");
  for (const message of value.messages) {
    verify(isRecord(message) && nonempty(message.id) && nonempty(message.role) && typeof message.content === "string", "Invalid native history message.");
    if (pin) {
      verify(!!message.source, "Source history omitted its evidence pins.");
      verifyEvidence(message.source, pin);
      verify(message.source.eventId === message.id && message.source.role === message.role && message.source.text === message.content,
        "Source history does not match its pinned evidence.");
    }
  }
}

function verifyResult(value: ChatGptResult) {
  verify(isRecord(value) && ["completed", "failed", "canceled", "uncertain"].includes(value.state)
    && typeof value.text === "string" && (value.sessionId === null || nonempty(value.sessionId))
    && (value.turnId === null || nonempty(value.turnId)), "Invalid native result.");
  if (value.nativeBinding !== null) {
    verifyBinding(value.nativeBinding);
    verify(value.sessionId === value.nativeBinding.sessionId, "Result conversation identity does not match its binding.");
  }
}

function failureText(error: ChatGptResult["error"] | ChatGptReceipt["error"], fallback: string) {
  return typeof error === "string" ? error : error?.message ?? fallback;
}

/** A configured capability transport; it owns no accepted work, retries, timers or catalogue. */
export class SessionCapabilityClient {
  private readonly socketPath: string;

  constructor(options: { socketPath: string }) {
    verify(isAbsolute(options.socketPath) && !options.socketPath.includes("\0"), "Configure an absolute private capability socket path.");
    this.socketPath = options.socketPath;
  }
  saveCaptureNote(input:{captureId:string;text:string;title:string;capturedAt:string}) {
    return this.post('/captures/note',input);
  }

  private post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const bytes = JSON.stringify(body);
      const req = request({ socketPath: this.socketPath, method: "POST", path,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(bytes), connection: "close" } }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("error", () => reject(new SessionCapabilityError("CAPABILITY_DISCONNECTED", "The private capability response disconnected; no retry was attempted.", null, true)));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          let value: any;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
          catch { reject(new SessionCapabilityError("CAPABILITY_PROTOCOL_ERROR", "The private capability returned an invalid JSON response.", status, true)); return; }
          if (status < 200 || status >= 300) {
            reject(new SessionCapabilityError(typeof value?.error?.code === "string" ? value.error.code : "CAPABILITY_HTTP_ERROR",
              typeof value?.error?.message === "string" ? value.error.message : `The private capability refused the request (HTTP ${status}).`,
              status, status >= 500 && value?.error?.code !== "SESSION_OWNER_UNAVAILABLE"));
            return;
          }
          if (String(res.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") {
            reject(new SessionCapabilityError("CAPABILITY_PROTOCOL_ERROR", "The private capability returned a non-JSON content type.", status, true)); return;
          }
          resolve(value as T);
        });
      });
      req.on("error", () => reject(new SessionCapabilityError(signal?.aborted ? "CAPABILITY_OBSERVATION_ABORTED" : "CAPABILITY_DISCONNECTED",
        signal?.aborted ? "Local capability observation ended; native cancellation is unconfirmed." : "The private capability connection failed; no retry was attempted.", null, true)));
      const abort = () => {
        reject(new SessionCapabilityError("CAPABILITY_OBSERVATION_ABORTED", "Local capability observation ended; native cancellation is unconfirmed.", null, true));
        req.destroy();
      };
      signal?.addEventListener("abort", abort, { once: true });
      req.once("close", () => signal?.removeEventListener("abort", abort));
      if (signal?.aborted) { abort(); return; }
      req.end(bytes);
    });
  }

  async searchSources(input: { query: string; includeTools?: boolean; limit?: number }): Promise<SourceSearchResult> {
    const value = await this.post<SourceSearchResult>("/sources/search", { query: input.query, includeTools: input.includeTools ?? false, ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    verify(isRecord(value) && Array.isArray(value.sources) && Array.isArray(value.matches) && Array.isArray(value.refresh)
      && typeof value.complete === "boolean", "Invalid source search response.");
    for (const source of value.sources) verifySource(source);
    for (const evidence of value.matches) {
      const source = value.sources.find(source => source.id === evidence.sourceId && source.version === evidence.sourceVersion);
      verify(!!source, "Search evidence omitted its exact source.");
      verifyEvidence(evidence, { sourceId: source.id, sourceVersion: source.version });
    }
    return value;
  }

  async sourceContext(input: SourceRef & { eventId?: string; limit?: number }) {
    const value = await this.post<{ source: CapabilitySource; evidence: SourceEvidence[]; hasMore: boolean }>("/sources/context",
      { sourceId: input.sourceId, sourceVersion: input.sourceVersion, branch: input.branch,
        ...(input.eventId !== undefined ? { eventId: input.eventId } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) });
    verifySource(value.source, input);
    verify(Array.isArray(value.evidence) && typeof value.hasMore === "boolean", "Invalid source context response.");
    for (const evidence of value.evidence) verifyEvidence(evidence, input);
    if (input.eventId !== undefined) verify(value.evidence.some(evidence => evidence.eventId === input.eventId), "Context omitted the exact requested event.");
    return value;
  }

  async importSource(input: { name: string; content: string; scope: string }) {
    const value = await this.post<{ sources: CapabilitySource[] }>("/sources/import", { name: input.name, content: input.content, scope: input.scope });
    verify(isRecord(value) && Array.isArray(value.sources), "Invalid source import response.");
    for (const source of value.sources) {
      verifySource(source);
      verify(source.version === digest(input.content), "Imported source version does not hash the exact UTF8 bytes.");
    }
    return value;
  }

  async sourceHistory(input: SourceRef & { cursor: string | null; limit: number }) {
    const value = await this.post<{ messages: CapabilityMessage[]; nextCursor: string | null }>("/sources/history",
      { sourceId: input.sourceId, sourceVersion: input.sourceVersion, branch: input.branch, cursor: input.cursor, limit: input.limit });
    verifyHistory(value, input);
    return value;
  }

  async refreshSources() {
    const value = await this.post<{ refresh: SourceRefresh[] }>("/sources/refresh", { provider: "chatgpt" });
    verify(isRecord(value) && Array.isArray(value.refresh), "Invalid source refresh response.");
    return value;
  }

  async start(run: CapabilityRunRef, providerInput: ChatGptProviderInput, signal?: AbortSignal) {
    exactFields(providerInput, ["id", "prompt", "purpose", "model", "attachments", "policy", "nativeBinding"]);
    verify(providerInput.id === run.runId, "The native provider effect must use the existing common run UUID.");
    const value = await this.post<ChatGptReceipt>(providerPath + "start", { ...runRef(run), providerInput }, signal);
    this.verifyReceipt(value, run);
    return value;
  }

  async reconcile(run: CapabilityRunRef, signal?: AbortSignal) {
    const value = await this.post<ChatGptReceipt>(providerPath + "reconcile", runRef(run), signal);
    this.verifyReceipt(value, run);
    return value;
  }

  private verifyReceipt(value: ChatGptReceipt, run: CapabilityRunRef) {
    verify(isRecord(value) && value.runId === run.runId && ["recorded", "running", "completed", "failed", "canceled", "uncertain"].includes(value.state)
      && (value.acknowledgedAt === null || nonempty(value.acknowledgedAt)), "Provider receipt changed its run identity or shape.");
    if (value.nativeBinding !== null) verifyBinding(value.nativeBinding);
    if (value.result !== null) {
      verifyResult(value.result);
      verify(value.result.state === value.state, "Provider receipt disagrees with its native result.");
      verify(isDeepStrictEqual(value.nativeBinding, value.result.nativeBinding), "Provider receipt disagrees with its native result binding.");
    }
  }

  async observe(run: CapabilityRunRef, after: string | null, signal?: AbortSignal) {
    const value = await this.post<ChatGptObservation>(providerPath + "observe", { ...runRef(run), after }, signal);
    verify(isRecord(value) && value.runId === run.runId && Array.isArray(value.events) && typeof value.complete === "boolean"
      && (value.nextCursor === null || nonempty(value.nextCursor)), "Invalid provider observation identity or shape.");
    for (const event of value.events) verify(isRecord(event) && event.runId === run.runId && event.inputId === run.inputId
      && nonempty(event.eventId) && nonempty(event.cursor) && nonempty(event.at) && isRecord(event.payload)
      && ["identity", "message", "result"].includes(event.kind), "Provider observation contains another run/input or an invalid event.");
    if (value.result !== null) verifyResult(value.result);
    return value;
  }

  async stop(run: CapabilityRunRef): Promise<never> {
    await this.post(providerPath + "stop", runRef(run));
    throw new SessionCapabilityError("CAPABILITY_PROTOCOL_ERROR", "ChatGPT cannot confirm native Stop with the current capability contract.");
  }

  private readRef(input: ChatGptReadRef) {
    verify(/^concierge:[1-9][0-9]*$/.test(input.sessionId) && Number.isSafeInteger(input.bindingGeneration)
      && input.bindingGeneration > 0, "Exact canonical session and binding generation required.");
    verifyBinding(input.binding);
    return { sessionId: input.sessionId, bindingGeneration: input.bindingGeneration, binding: input.binding };
  }

  async history(input: ChatGptReadRef & { cursor: string | null; limit: number }) {
    const value = await this.post<{ messages: CapabilityMessage[]; nextCursor: string | null }>(providerPath + "history",
      { ...this.readRef(input), cursor: input.cursor, limit: input.limit });
    verifyHistory(value);
    return value;
  }

  async detail(input: ChatGptReadRef & { detailKey: string }) {
    const value = await this.post<{ content: string }>(providerPath + "detail", { ...this.readRef(input), detailKey: input.detailKey });
    verify(isRecord(value) && typeof value.content === "string", "Invalid native detail response.");
    return value;
  }

  async bind(input: Omit<ChatGptReadRef, "binding"> & { operationId: string; reference: ChatGptBinding }) {
    verify(nonempty(input.operationId), "Binding an imported conversation requires an exact owner bind operation.");
    const { binding, ...pin } = this.readRef({ ...input, binding: input.reference });
    verify(!!binding.anchor, "Binding an imported conversation requires an exact source anchor.");
    const value = await this.post<{ binding: ChatGptBinding }>(providerPath + "bind", { operationId: input.operationId, ...pin, reference: binding });
    verifyBinding(value.binding);
    verify(isDeepStrictEqual(value.binding, input.reference), "Verified binding changed the requested native account/conversation/anchor.");
    return value;
  }

  async snapshot(input: ChatGptReadRef) {
    const value = await this.post<{ name: string; content: string; scope: string; branch: string; sourceVersion: string }>(providerPath + "snapshot", this.readRef(input));
    verify(isRecord(value) && typeof value.content === "string" && nonempty(value.name) && nonempty(value.scope)
      && nonempty(value.branch) && digest(value.content) === value.sourceVersion, "Snapshot version does not match the exact source bytes.");
    return value;
  }

  async artifact(input: ChatGptReadRef & { messageId: string; path: string }) {
    const value = await this.post<Omit<CapabilityAttachment, "id">>(providerPath + "artifact",
      { ...this.readRef(input), messageId: input.messageId, path: input.path });
    verify(isRecord(value) && nonempty(value.name) && nonempty(value.contentType) && typeof value.base64 === "string"
      && digest(Buffer.from(value.base64, "base64")) === value.sha256, "Artifact bytes do not match the retained digest.");
    return value;
  }

  createChatGptProvider(context: ChatGptRunContext): AgentProvider {
    const retained = structuredClone({ run: runRef(context.run), admission: context.admission, attachments: context.attachments });
    return {
      id: "chatgpt",
      capabilities: { ...chatGptCapabilities },
      run: input => this.runChatGpt(input, { ...context, ...retained }),
      fork: async () => { throw new SessionCapabilityError("CAPABILITY_UNAVAILABLE", "ChatGPT native fork is unavailable.", 409); },
    };
  }

  private async runChatGpt(input: Parameters<AgentProvider["run"]>[0], context: ChatGptRunContext): Promise<RunResult> {
    const { run, admission } = context;
    let binding = admission.nativeBinding;
    let turnId: string | null = null;
    let cursor: string | null = null;
    let mayHaveStarted = false;
    let effectRecorded = false;
    let terminalConfirmed = false;
    const acceptBinding = async (candidate: ChatGptBinding | null) => {
      if (candidate === null) return;
      verifyBinding(candidate);
      if (binding !== null) verify(isDeepStrictEqual(candidate, binding), "Provider changed the exact native binding during the owned run.");
      if (!isDeepStrictEqual(candidate, binding)) await context.onNativeBinding?.(candidate);
      binding = candidate;
      input.onProviderThreadStarted?.(candidate.sessionId);
    };
    const finish = async (result: ChatGptResult): Promise<RunResult> => {
      verifyResult(result);
      await acceptBinding(result.nativeBinding);
      if (result.sessionId !== null) verify(result.sessionId === binding?.sessionId, "Provider result changed its native conversation.");
      if (turnId !== null && result.turnId !== null) verify(turnId === result.turnId, "Provider result changed its native turn.");
      turnId = result.turnId ?? turnId;
      if (result.state === "uncertain") throw new SessionCapabilityError("CHATGPT_SEND_UNCONFIRMED", failureText(result.error, "ChatGPT send remains uncertain."), null, true);
      terminalConfirmed = true;
      input.onProviderTerminal?.();
      if (result.state === "canceled") throw new ProviderTurnCancelledError("ChatGPT confirmed native cancellation.");
      if (result.state === "failed") throw new SessionCapabilityError("CHATGPT_RUN_FAILED", failureText(result.error, "ChatGPT execution failed."), 409);
      return { text: result.text, sessionUUID: result.sessionId, providerTurnId: turnId, toolsUsed: [] };
    };
    try {
      verify(admission.provider === "chatgpt" && admission.purpose === "chat" && admission.policy === "standard"
        && (input.interactionPolicy === undefined || input.interactionPolicy === "standard")
        && admission.inputId === run.inputId && admission.runId === run.runId && Number.isSafeInteger(admission.bindingGeneration)
        && admission.bindingGeneration > 0 && nonempty(admission.admittedAt), "ChatGPT requires an exact retained standard chat admission.");
      verify(digest(input.prompt) === admission.promptHash && (input.model ?? null) === admission.model
        && input.sessionUUID === (admission.nativeBinding?.sessionId ?? null), "Provider preparation no longer matches the owner's immutable admission.");
      if (admission.nativeBinding !== null) verifyBinding(admission.nativeBinding);
      verify(context.attachments.length === admission.attachments.length, "Provider attachment custody does not match admission.");
      for (let index = 0; index < context.attachments.length; index++) {
        const attachment = context.attachments[index]!;
        const { base64, ...pin } = attachment;
        verify(isDeepStrictEqual(pin, admission.attachments[index]) && typeof base64 === "string"
          && digest(Buffer.from(base64, "base64")) === pin.sha256, "Provider attachment bytes/order no longer match admission.");
      }
      if (context.signal?.aborted) throw new SessionCapabilityError("CAPABILITY_OWNER_LOST", "The owner ended this admission before capability dispatch.", 409);
      mayHaveStarted = true;
      const receipt = await this.start(run, { id: run.runId, prompt: input.prompt, purpose: admission.purpose,
        model: admission.model, attachments: context.attachments, policy: admission.policy, nativeBinding: admission.nativeBinding }, context.signal);
      effectRecorded = true;
      terminalConfirmed = receipt.state === "failed" || receipt.state === "canceled" || receipt.state === "completed";
      if (binding !== null && receipt.nativeBinding !== null) verify(isDeepStrictEqual(binding, receipt.nativeBinding), "Provider receipt changed the admitted native binding.");
      await context.onEvidence({ kind: "start", run, receipt });
      await acceptBinding(receipt.nativeBinding);
      if (receipt.acknowledgedAt !== null) input.onInputAcknowledged?.();
      if (receipt.result !== null) return await finish(receipt.result);
      if (receipt.state === "uncertain") throw new SessionCapabilityError(receipt.error?.code ?? "CHATGPT_SEND_UNCONFIRMED", failureText(receipt.error, "ChatGPT send remains uncertain."), null, true);
      if (receipt.state === "failed") throw new SessionCapabilityError(receipt.error?.code ?? "CHATGPT_START_FAILED", failureText(receipt.error, "ChatGPT start failed."), 409);
      if (receipt.state === "canceled") {
        input.onProviderTerminal?.();
        throw new ProviderTurnCancelledError("ChatGPT confirmed native cancellation.");
      }
      verify(["recorded", "running"].includes(receipt.state), "Terminal provider receipt omitted its native result.");
      input.onProgress?.({ type: "started" });
      while (true) {
        const observation = await this.observe(run, cursor, context.signal);
        let observedBinding = binding;
        let observedTurn = turnId;
        const verifyIdentity = (identity: { sessionId: unknown; turnId: unknown; nativeBinding: unknown }) => {
          if (identity.nativeBinding !== null) {
            verifyBinding(identity.nativeBinding);
            verify(observedBinding === null || isDeepStrictEqual(observedBinding, identity.nativeBinding), "Provider changed the exact native binding during observation.");
            observedBinding = identity.nativeBinding;
          }
          if (identity.sessionId !== null) verify(identity.sessionId === observedBinding?.sessionId, "Provider observation changed its native conversation.");
          if (identity.turnId !== null) {
            verify(nonempty(identity.turnId) && (observedTurn === null || observedTurn === identity.turnId), "Provider observation changed its native turn.");
            observedTurn = identity.turnId;
          }
        };
        for (const event of observation.events) {
          if (event.kind === "identity" || event.kind === "result") {
            verifyIdentity(event.payload as any);
            if (event.kind === "result") {
              verifyResult(event.payload as unknown as ChatGptResult);
              verify(observation.result !== null && isDeepStrictEqual(event.payload, observation.result), "Observed result event differs from its retained result.");
            }
          } else verifyHistory({ messages: [event.payload.message as CapabilityMessage], nextCursor: null });
        }
        if (observation.result !== null) verifyIdentity(observation.result);
        await context.onEvidence({ kind: "observe", run, after: cursor, observation });
        for (const event of observation.events) {
          if (event.kind === "identity") {
            const identity = event.payload;
            await acceptBinding(identity.nativeBinding as ChatGptBinding | null);
            verify(identity.sessionId === binding?.sessionId, "Provider identity changed its conversation.");
            if (identity.turnId != null) {
              verify(nonempty(identity.turnId) && (turnId === null || turnId === identity.turnId), "Provider identity changed its native turn.");
              turnId = identity.turnId;
              input.onProviderTurnStarted?.(turnId);
            }
          } else if (event.kind === "message") {
            const message = event.payload.message as CapabilityMessage;
            verifyHistory({ messages: [message], nextCursor: null });
            if (message.role === "assistant" && message.phase === "commentary") input.onProgress?.({ type: "commentary", text: message.content });
          }
        }
        if (observation.result !== null) return await finish(observation.result);
        verify(!observation.complete, "Provider observation ended without a retained result.");
        verify(observation.events.length > 0 && observation.nextCursor !== null && observation.nextCursor !== cursor,
          "Active provider observation returned no advancing evidence; execution remains unconfirmed.");
        cursor = observation.nextCursor;
      }
    } catch (error) {
      if (error instanceof ProviderTurnCancelledError) throw error;
      const failure = error instanceof SessionCapabilityError ? error : new SessionCapabilityError("CAPABILITY_HOST_FAILURE",
        "The host could not retain or project capability evidence; execution remains unconfirmed.", null, mayHaveStarted);
      const evidence: Extract<CapabilityEvidence, { kind: "failure" }> = { kind: "failure", run, after: cursor,
        code: failure.code, message: failure.message, status: failure.status,
        uncertain: failure.uncertain || (effectRecorded && !terminalConfirmed) || (mayHaveStarted && failure.code === "CAPABILITY_PROTOCOL_ERROR") };
      try { await context.onEvidence(evidence); } catch { /* The thrown error retains evidence when the owner's durable writer fails. */ }
      throw new ChatGptDispatchError(evidence, binding, turnId);
    }
  }
}
