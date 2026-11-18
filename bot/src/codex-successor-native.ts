import type { CodexAppServerClientLike } from './codex-app-server-client';
import type {CustodyNativeConnection} from './codex-custody-connection';
import {assertCustodyEndpoint} from './codex-custody-colocation';
import {isAstraModel} from './aliases';
import {rewriteRelayedCodexRequest} from './runner-machine';

/** Owner-derived construction facts. Persistence and eligibility remain with session-owner. */
export interface CodexSuccessorPlan {
  readonly operationId: string;
  readonly ownerSessionId?:number;
  readonly model: string;
  readonly provider: string;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly environmentId: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly approvalPolicy: 'never';
  readonly sandbox: 'danger-full-access';
  readonly custodyCommitted: true;
  readonly predecessorExcluded: true;
  readonly nativeConnection?:CustodyNativeConnection;
  readonly additionalContext?: Readonly<Record<string, { value: string; name?: string; kind: 'application'|'untrusted' }>>;
}

export interface CodexSuccessorConstruction {
  readonly operationId: string;
  readonly threadId: string;
  readonly model: string;
  readonly provider: string;
  readonly reasoningEffort: string;
  readonly cwd: string;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly environmentId: string;
  readonly environmentCwd: string;
  readonly environmentRuntimeWorkspaceRoots: readonly string[];
  readonly response: unknown;
}

export interface CodexSuccessorAdmission {
  readonly operationId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly response: unknown;
}

export class CodexSuccessorConstructionMismatchError extends Error {
  constructor(readonly threadId: string, readonly response: unknown, detail: string) {
    super(`Native successor ${threadId} conflicts with the committed plan: ${detail}`);
    this.name = 'CodexSuccessorConstructionMismatchError';
  }
}

export function successorTurnStartParams(plan: CodexSuccessorPlan, threadId: string,
  exactReminder: string, clientUserMessageId: string) {
  assertCommitted(plan);
  return {
    threadId, input: [{ type: 'text', text: exactReminder, text_elements: [] }], clientUserMessageId,
    model: plan.model, effort: 'medium', cwd: plan.cwd,
    runtimeWorkspaceRoots: normalizedRoots(plan),
    environments: [{ environmentId: plan.environmentId, cwd: plan.cwd,
      runtimeWorkspaceRoots: normalizedRoots(plan) }],
  };
}

const nonempty = (value: string, field: string) => {
  if (!value.trim()) throw new Error(`Successor ${field} is required.`);
  return value;
};

/** The adapter and last-byte owner guard use the same prospective native request. */
export function successorThreadStartParams(plan:CodexSuccessorPlan) {
  assertCommitted(plan);
  const roots=normalizedRoots(plan);
  const params={model:plan.model,modelProvider:nonempty(plan.provider,'provider'),allowProviderModelFallback:false,
    cwd:plan.cwd,runtimeWorkspaceRoots:roots,
    environments:[{environmentId:nonempty(plan.environmentId,'environment id'),cwd:plan.cwd,runtimeWorkspaceRoots:roots}],
    config:{...plan.config,model_reasoning_effort:'medium'},approvalPolicy:plan.approvalPolicy,sandbox:plan.sandbox,
    ephemeral:false,...(plan.additionalContext?{developerInstructions:renderContext(plan.additionalContext)}:{})};
  const endpoint=plan.nativeConnection?.endpoint;
  assertCustodyEndpoint(endpoint??undefined);
  if(!endpoint?.relayRunner)return params;
  // The final owner guard and the runner assess the same effective native request.
  // Its machine mapping is retained with this physical connection, never re-resolved
  // through whichever runner happens to own the current listen channel.
  return JSON.parse(rewriteRelayedCodexRequest(JSON.stringify({method:'thread/start',params}),
    endpoint.relayAssociation!.preparation.machine).text).params;
}

/**
 * Narrow native boundary for an owner-committed successor. It never starts the daemon,
 * resumes a thread, or retries an ambiguous construction/admission. The owner must persist
 * each returned identity before proceeding to the next consequential call.
 */
export class CodexSuccessorNativeAdapter {
  constructor(private readonly client: CodexAppServerClientLike) {}

  async construct(plan: CodexSuccessorPlan): Promise<CodexSuccessorConstruction> {
    assertCommitted(plan);
    const roots = normalizedRoots(plan);
    const response = await this.client.request('thread/start', successorThreadStartParams(plan),
      { untilDisconnect: true,custodyOwnerSessionId:plan.ownerSessionId });
    const thread = response?.thread;
    const threadId = typeof thread?.id === 'string' ? thread.id : '';
    if (!threadId) throw new Error('Native construction returned no durable thread identity; construction outcome requires reconciliation.');
    const effective = thread?.configuration ?? thread?.config ?? thread;
    const selectedEnvironments = thread?.environments;
    const selectedEnvironment = Array.isArray(selectedEnvironments) && selectedEnvironments.length === 1
      ? selectedEnvironments[0] : undefined;
    const actual: CodexSuccessorConstruction = {
      operationId: plan.operationId, threadId,
      model: String(response?.model ?? effective.model ?? thread.model ?? ''),
      provider: String(response?.modelProvider ?? response?.model_provider ?? effective.modelProvider ?? effective.model_provider ?? thread.modelProvider ?? thread.model_provider ?? ''),
      reasoningEffort: String(response?.reasoningEffort ?? response?.reasoning_effort ?? effective.reasoningEffort ?? effective.modelReasoningEffort ?? effective.model_reasoning_effort ?? thread.reasoningEffort ?? thread.reasoning_effort ?? ''),
      cwd: String(response?.cwd ?? effective.cwd ?? thread.cwd ?? ''),
      runtimeWorkspaceRoots: strings(response?.runtimeWorkspaceRoots ?? response?.runtime_workspace_roots ?? effective.runtimeWorkspaceRoots ?? effective.runtime_workspace_roots),
      environmentId: String(selectedEnvironment?.environmentId ?? ''),
      environmentCwd: String(selectedEnvironment?.cwd ?? ''),
      environmentRuntimeWorkspaceRoots: strings(selectedEnvironment?.runtimeWorkspaceRoots),
      response,
    };
    try { assertEffective(actual, plan, roots); }
    catch (error) { throw new CodexSuccessorConstructionMismatchError(threadId, response,
      error instanceof Error ? error.message : String(error)); }
    return actual;
  }

  async admit(plan: CodexSuccessorPlan, construction: CodexSuccessorConstruction,
    exactReminder: string): Promise<CodexSuccessorAdmission> {
    assertCommitted(plan);
    if (construction.operationId !== plan.operationId || !construction.threadId)
      throw new Error('Construction identity does not belong to this committed operation.');
    assertEffective(construction, plan, normalizedRoots(plan));
    if (!exactReminder) throw new Error('The exact selected reminder payload is required.');
    // A rejected/ambiguous call is returned to the owner as such. Never resend here.
    const response = await this.client.request('turn/start', successorTurnStartParams(plan, construction.threadId,
      exactReminder, `custody-successor:${plan.operationId}`), { untilDisconnect: true,custodyOwnerSessionId:plan.ownerSessionId });
    const turnId = typeof response?.turn?.id === 'string' ? response.turn.id : '';
    if (!turnId) throw new Error('Native admission returned no turn identity; admission outcome requires reconciliation.');
    return { operationId: plan.operationId, threadId: construction.threadId, turnId, response };
  }

  /** Observation only. It deliberately does not call thread/resume or turn/start. */
  async observe(threadId: string): Promise<unknown> {
    return this.client.request('thread/read', { threadId, includeTurns: true });
  }

  async interrupt(threadId: string, turnId: string): Promise<unknown> {
    return this.client.request('turn/interrupt', { threadId, turnId });
  }
}

function assertCommitted(plan: CodexSuccessorPlan): void {
  nonempty(plan.operationId, 'operation id');
  if (!isAstraModel(plan.model)) throw new Error('Successor model must preserve the retained Astra binding.');
  if (plan.custodyCommitted !== true || plan.predecessorExcluded !== true)
    throw new Error('Native construction requires owner-committed custody and predecessor exclusion.');
  if (!plan.cwd.startsWith('/') || plan.runtimeWorkspaceRoots.length === 0)
    throw new Error('Owner-approved absolute workspace paths are required.');
  if (plan.runtimeWorkspaceRoots.some(root => !root.startsWith('/')))
    throw new Error('Every runtime workspace root must be absolute.');
  if (plan.approvalPolicy !== 'never' || plan.sandbox !== 'danger-full-access')
    throw new Error('The assessed native permissions must be preserved.');
}

function normalizedRoots(plan: CodexSuccessorPlan): string[] {
  return [...new Set([plan.cwd, ...plan.runtimeWorkspaceRoots])];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function assertEffective(actual: CodexSuccessorConstruction, plan: CodexSuccessorPlan, roots: string[]): void {
  if (actual.model !== plan.model || actual.provider !== plan.provider || actual.reasoningEffort !== 'medium'
    || actual.cwd !== plan.cwd || actual.environmentId !== plan.environmentId
    || JSON.stringify(actual.runtimeWorkspaceRoots) !== JSON.stringify(roots)
    || actual.environmentCwd !== plan.cwd
    || JSON.stringify(actual.environmentRuntimeWorkspaceRoots) !== JSON.stringify(roots)
    || !Array.isArray((actual.response as any)?.thread?.environments)
    || (actual.response as any).thread.environments.length !== 1
    || (actual.response as any)?.approvalPolicy !== 'never'
    || (actual.response as any)?.sandbox?.type !== 'dangerFullAccess')
    throw new Error('Native thread configuration conflicts with the committed successor plan; selected admission refused.');
}

function renderContext(context: NonNullable<CodexSuccessorPlan['additionalContext']>): string {
  return Object.entries(context).map(([key, entry]) => `[${entry.kind}:${entry.name ?? key}]\n${entry.value}`).join('\n\n');
}
