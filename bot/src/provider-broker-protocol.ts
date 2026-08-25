import { timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

export const PROVIDER_BROKER_PROTOCOL_VERSION = 1 as const;
export const PROVIDER_BROKER_MAX_FRAME_BYTES = 4 * 1024 * 1024;

export const CODEX_BROKER_METHODS = {
  "codex.model_list": "model/list",
  "codex.thread_start": "thread/start",
  "codex.thread_resume": "thread/resume",
  "codex.thread_read": "thread/read",
  "codex.thread_list": "thread/list",
  "codex.thread_fork": "thread/fork",
  "codex.turn_start": "turn/start",
  "codex.turn_steer": "turn/steer",
  "codex.turn_interrupt": "turn/interrupt",
} as const;

export type CodexBrokerOperation = keyof typeof CODEX_BROKER_METHODS;
export type ProviderBrokerOperation = CodexBrokerOperation
  | "codex.observe"
  | "claude.run"
  | "claude.stdin"
  | "claude.close";

export interface ProviderBrokerRequest {
  protocol_version: typeof PROVIDER_BROKER_PROTOCOL_VERSION;
  id: string;
  operation: ProviderBrokerOperation;
  binding_token?: string | null;
  payload: Record<string, unknown>;
}

export interface ProviderBrokerPolicy {
  projectId: string;
  projectRoot: string;
  allowedRoots: readonly string[];
  allowedModels: ReadonlySet<string>;
  allowedEnvironment: ReadonlySet<string>;
  fixedEnvironment?: Readonly<Record<string, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9:._-]{1,200}$/;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const LOCAL_OPERATIONS = new Set(["codex.observe", "claude.run", "claude.stdin", "claude.close"]);

export function assertProviderBrokerRequest(value: unknown): asserts value is ProviderBrokerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider broker request must be an object.");
  }
  const request = value as Record<string, unknown>;
  if (request.protocol_version !== PROVIDER_BROKER_PROTOCOL_VERSION) {
    throw new Error("Unsupported provider broker protocol version.");
  }
  if (typeof request.id !== "string" || !REQUEST_ID.test(request.id)) {
    throw new Error("Provider broker request ID is invalid.");
  }
  if (!(request.operation in CODEX_BROKER_METHODS) && !LOCAL_OPERATIONS.has(String(request.operation))) {
    throw new Error("Provider broker operation is not allowed.");
  }
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new Error("Provider broker payload must be an object.");
  }
  if (request.binding_token != null
    && (typeof request.binding_token !== "string" || request.binding_token.length > 256)) {
    throw new Error("Provider broker binding token is invalid.");
  }
}

function assertOnlyKeys(payload: Record<string, unknown>, allowed: ReadonlySet<string>, operation: string) {
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) throw new Error(`${operation} does not accept caller field ${key}.`);
  }
}

function requiredString(payload: Record<string, unknown>, key: string, maximum = 200) {
  const value = payload[key];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Provider broker ${key} is invalid.`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string, maximum = 200) {
  const value = payload[key];
  if (value == null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`Provider broker ${key} is invalid.`);
  }
  return value;
}

function assertUuid(value: string, label: string) {
  if (!UUID.test(value)) throw new Error(`${label} is not a provider UUID.`);
}

function optionalBoolean(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(`Provider broker ${key} must be a boolean.`);
  return value;
}

function codexTextInput(payload: Record<string, unknown>) {
  const input = payload.input;
  if (!Array.isArray(input) || input.length !== 1) {
    throw new Error("Provider Codex input must contain exactly one text item.");
  }
  const item = input[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Provider Codex input item is invalid.");
  }
  const fields = item as Record<string, unknown>;
  assertOnlyKeys(fields, new Set(["type", "text", "text_elements"]), "Codex text input");
  if (fields.type !== "text" || typeof fields.text !== "string"
    || fields.text.length < 1 || fields.text.length > 1024 * 1024
    || !Array.isArray(fields.text_elements) || fields.text_elements.length !== 0) {
    throw new Error("Provider Codex input item is invalid.");
  }
  return [{ type: "text", text: fields.text, text_elements: [] }];
}

function codexAdditionalContext(payload: Record<string, unknown>) {
  const value = payload.additionalContext;
  if (value == null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider Codex additional context is invalid.");
  }
  const context = value as Record<string, unknown>;
  assertOnlyKeys(context, new Set(["slack-concierge"]), "Codex additional context");
  const application = context["slack-concierge"];
  if (!application || typeof application !== "object" || Array.isArray(application)) {
    throw new Error("Provider Codex application context is invalid.");
  }
  const fields = application as Record<string, unknown>;
  assertOnlyKeys(fields, new Set(["value", "kind"]), "Codex application context");
  if (fields.kind !== "application" || typeof fields.value !== "string"
    || fields.value.length < 1 || fields.value.length > 1024 * 1024) {
    throw new Error("Provider Codex application context is invalid.");
  }
  return { "slack-concierge": { value: fields.value, kind: "application" } };
}

function assertAllowedPath(policy: ProviderBrokerPolicy, value: string) {
  if (!isAbsolute(value)) throw new Error("Provider path must be absolute.");
  const canonicalValue = resolve(value);
  const roots = [policy.projectRoot, ...policy.allowedRoots].map((root) => resolve(root));
  const allowed = roots.some((canonicalRoot) => {
    const pathFromRoot = relative(canonicalRoot, canonicalValue);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });
  if (!allowed) {
    throw new Error(`Provider path ${value} is outside the assigned project.`);
  }
  return canonicalValue;
}

function runtimeRoots(policy: ProviderBrokerPolicy, payload: Record<string, unknown>) {
  const supplied = payload.runtimeWorkspaceRoots;
  if (supplied == null) return [resolve(policy.projectRoot)];
  if (!Array.isArray(supplied) || supplied.length < 1 || supplied.length > 16) {
    throw new Error("Provider runtime workspace roots are invalid.");
  }
  return [...new Set(supplied.map((path) => {
    if (typeof path !== "string") throw new Error("Provider runtime workspace root must be a string.");
    return assertAllowedPath(policy, path);
  }))];
}

function derivedEnvironment(policy: ProviderBrokerPolicy, payload: Record<string, unknown>) {
  const supplied = payload.environment;
  if (supplied == null) return undefined;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("Provider environment must be an object.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
    if (!policy.allowedEnvironment.has(key) || typeof value !== "string" || value.length > 2_000) {
      throw new Error(`Provider environment field ${key} is not allowed.`);
    }
    result[key] = value;
  }
  return result;
}

function executionEnvironment(policy: ProviderBrokerPolicy, payload: Record<string, unknown>) {
  const supplied = derivedEnvironment(policy, payload) || {};
  const fixed = policy.fixedEnvironment || {};
  for (const [key, value] of Object.entries(fixed)) {
    if (!/^[A-Z0-9_]+$/.test(key) || typeof value !== "string" || value.length < 1 || value.length > 2_000) {
      throw new Error(`Provider fixed environment field ${key} is invalid.`);
    }
  }
  return { ...supplied, ...fixed };
}

function selectedModel(policy: ProviderBrokerPolicy, payload: Record<string, unknown>) {
  const model = optionalString(payload, "model", 100);
  if (model && !policy.allowedModels.has(model)) throw new Error(`Provider model ${model} is not allowed.`);
  return model;
}

export function codexRequestFromBroker(
  policy: ProviderBrokerPolicy,
  request: ProviderBrokerRequest,
): { method: string; params: Record<string, unknown>; threadId?: string } {
  if (!(request.operation in CODEX_BROKER_METHODS)) throw new Error("Request is not a Codex operation.");
  const payload = request.payload;
  const method = CODEX_BROKER_METHODS[request.operation as CodexBrokerOperation];
  const threadId = typeof payload.threadId === "string" ? payload.threadId : undefined;
  if (threadId) assertUuid(threadId, "Provider thread identity");

  if (request.operation === "codex.model_list") {
    assertOnlyKeys(payload, new Set(), request.operation);
    return { method, params: {} };
  }
  if (request.operation === "codex.thread_list") {
    assertOnlyKeys(payload, new Set(["limit", "cursor", "sortKey", "sortDirection", "sourceKinds"]), request.operation);
    const limit = payload.limit == null ? 100 : Number(payload.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Provider list limit is invalid.");
    const sortKey = payload.sortKey == null ? undefined : optionalString(payload, "sortKey", 50);
    const sortDirection = payload.sortDirection == null
      ? undefined
      : optionalString(payload, "sortDirection", 20);
    if (sortKey && sortKey !== "created_at") throw new Error("Provider list sort key is invalid.");
    if (sortDirection && sortDirection !== "desc") throw new Error("Provider list sort direction is invalid.");
    let sourceKinds: string[] | undefined;
    if (payload.sourceKinds != null) {
      if (!Array.isArray(payload.sourceKinds) || payload.sourceKinds.length > 10
        || payload.sourceKinds.some((kind) => kind !== "vscode")) {
        throw new Error("Provider list source kinds are invalid.");
      }
      sourceKinds = [...payload.sourceKinds];
    }
    return {
      method,
      params: {
        limit,
        ...(payload.cursor == null ? {} : { cursor: optionalString(payload, "cursor", 500) }),
        ...(sortKey ? { sortKey } : {}),
        ...(sortDirection ? { sortDirection } : {}),
        ...(sourceKinds ? { sourceKinds } : {}),
        cwd: resolve(policy.projectRoot),
      },
    };
  }
  if (["codex.thread_start", "codex.thread_resume", "codex.thread_fork"].includes(request.operation)) {
    assertOnlyKeys(payload, new Set([
      ...(request.operation === "codex.thread_start" ? [] : ["threadId"]),
      "runtimeWorkspaceRoots", "model", "reasoningEffort", "lastTurnId",
      "threadSource", "deferGoalContinuation", "excludeTurns", "environment",
    ]), request.operation);
    if (request.operation !== "codex.thread_start" && !threadId) {
      throw new Error(`${request.operation} requires a provider thread identity.`);
    }
    const model = selectedModel(policy, payload);
    const reasoningEffort = optionalString(payload, "reasoningEffort", 20);
    if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
      throw new Error(`Provider reasoning effort ${reasoningEffort} is not allowed.`);
    }
    const environment = executionEnvironment(policy, payload);
    const deferGoalContinuation = optionalBoolean(payload, "deferGoalContinuation");
    const excludeTurns = optionalBoolean(payload, "excludeTurns");
    return {
      method,
      threadId,
      params: {
        ...(threadId ? { threadId } : {}),
        cwd: resolve(policy.projectRoot),
        runtimeWorkspaceRoots: runtimeRoots(policy, payload),
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ...(Object.keys(environment).length > 0
          ? { config: { shell_environment_policy: { inherit: "none", set: environment } } }
          : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(payload.lastTurnId == null ? {} : { lastTurnId: requiredString(payload, "lastTurnId", 200) }),
        ...(payload.threadSource == null ? {} : { threadSource: requiredString(payload, "threadSource", 500) }),
        ...(deferGoalContinuation === true ? { deferGoalContinuation: true } : {}),
        ...(excludeTurns === true ? { excludeTurns: true } : {}),
      },
    };
  }
  if (request.operation === "codex.thread_read") {
    assertOnlyKeys(payload, new Set(["threadId", "includeTurns"]), request.operation);
    if (!threadId) throw new Error("codex.thread_read requires a provider thread identity.");
    const includeTurns = optionalBoolean(payload, "includeTurns");
    return { method, threadId, params: { threadId, includeTurns: includeTurns === true } };
  }
  if (request.operation === "codex.turn_start") {
    assertOnlyKeys(payload, new Set(["threadId", "input", "clientUserMessageId", "additionalContext"]), request.operation);
    if (!threadId) throw new Error("codex.turn_start payload is invalid.");
    const additionalContext = codexAdditionalContext(payload);
    return {
      method,
      threadId,
      params: {
        threadId,
        input: codexTextInput(payload),
        ...(payload.clientUserMessageId == null ? {} : {
          clientUserMessageId: requiredString(payload, "clientUserMessageId", 200),
        }),
        ...(additionalContext ? { additionalContext } : {}),
      },
    };
  }
  if (request.operation === "codex.turn_steer") {
    assertOnlyKeys(payload, new Set(["threadId", "expectedTurnId", "clientUserMessageId", "input"]), request.operation);
    if (!threadId) throw new Error("codex.turn_steer payload is invalid.");
    return {
      method,
      threadId,
      params: {
        threadId,
        expectedTurnId: requiredString(payload, "expectedTurnId", 200),
        clientUserMessageId: requiredString(payload, "clientUserMessageId", 200),
        input: codexTextInput(payload),
      },
    };
  }
  assertOnlyKeys(payload, new Set(["threadId", "turnId"]), request.operation);
  if (!threadId) throw new Error("codex.turn_interrupt requires a provider thread identity.");
  return {
    method,
    threadId,
    params: {
      threadId,
      turnId: requiredString(payload, "turnId", 200),
    },
  };
}

export function claudeRunFromBroker(policy: ProviderBrokerPolicy, request: ProviderBrokerRequest) {
  if (request.operation !== "claude.run") throw new Error("Request is not a Claude operation.");
  const payload = request.payload;
  assertOnlyKeys(payload, new Set([
    "prompt", "sessionUuid", "forkSession", "model", "systemPrompt", "environment", "additionalDirs",
  ]), request.operation);
  const prompt = requiredString(payload, "prompt", 1024 * 1024);
  const sessionUuid = optionalString(payload, "sessionUuid", 100);
  if (sessionUuid) assertUuid(sessionUuid, "Provider session identity");
  const model = selectedModel(policy, payload);
  const systemPrompt = optionalString(payload, "systemPrompt", 1024 * 1024);
  const environment = executionEnvironment(policy, payload);
  const suppliedDirectories = payload.additionalDirs == null ? [] : payload.additionalDirs;
  if (!Array.isArray(suppliedDirectories) || suppliedDirectories.length > 16) {
    throw new Error("Claude additional directories are invalid.");
  }
  const additionalDirectories = suppliedDirectories.map((directory) => {
    if (typeof directory !== "string") throw new Error("Claude additional directory must be a string.");
    return assertAllowedPath(policy, directory);
  });
  return {
    prompt,
    session_uuid: sessionUuid,
    fork_session: payload.forkSession === true,
    model,
    system_prompt: systemPrompt,
    environment,
    additional_dirs: additionalDirectories,
  };
}

export function safeTokenEqual(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function createBoundedJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
  maximumBytes = PROVIDER_BROKER_MAX_FRAME_BYTES,
) {
  let buffered = Buffer.alloc(0);
  let failed = false;
  const receive = (chunk: Buffer | string) => {
    if (failed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffered = buffered.length === 0 ? bytes : Buffer.concat([buffered, bytes]);
    while (true) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) break;
      if (newline > maximumBytes) {
        failed = true;
        onError(new Error("Provider broker frame exceeded limit."));
        return;
      }
      const line = buffered.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      buffered = buffered.subarray(newline + 1);
      onLine(line);
    }
    if (buffered.length > maximumBytes) {
      failed = true;
      onError(new Error("Provider broker frame exceeded limit."));
    }
  };
  stream.on("data", receive);
  return () => stream.off("data", receive);
}
