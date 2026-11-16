import assert from 'node:assert/strict';
import { CodexSuccessorNativeAdapter, type CodexSuccessorPlan } from '../src/codex-successor-native';

const plan: CodexSuccessorPlan = {
  operationId: 'fixture-operation', model: 'gpt-6-astra', provider: 'openai',
  cwd: '/workspace/project', runtimeWorkspaceRoots: ['/workspace/project', '/workspace/project/typing'],
  environmentId: 'local', config: {}, approvalPolicy: 'never', sandbox: 'danger-full-access',
  custodyCommitted: true, predecessorExcluded: true,
};
const calls: Array<{ method: string; params: any }> = [];
const selectedEnvironment = { environmentId: 'local', cwd: plan.cwd,
  runtimeWorkspaceRoots: [...plan.runtimeWorkspaceRoots] };
const client: any = { request: async (method: string, params: any) => {
  calls.push({ method, params });
  if (method === 'thread/start') return {
    thread: { id: 'native-thread-1', modelProvider: 'openai', model: 'gpt-6-astra', reasoningEffort: 'medium',
      cwd: plan.cwd, runtimeWorkspaceRoots: [...plan.runtimeWorkspaceRoots],
      environments: [{ ...selectedEnvironment }] }, model: 'gpt-6-astra', modelProvider: 'openai',
    reasoningEffort: 'medium', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' },
  };
  if (method === 'turn/start') return { turn: { id: 'native-turn-1' } };
  return { thread: { id: 'native-thread-1', turns: [] } };
} };

const adapter = new CodexSuccessorNativeAdapter(client);
const construction = await adapter.construct(plan);
assert.equal(construction.threadId, 'native-thread-1');
assert.deepEqual(calls[0]?.params.environments, [{ environmentId: 'local', cwd: plan.cwd,
  runtimeWorkspaceRoots: [...plan.runtimeWorkspaceRoots] }]);
assert.equal(calls[0]?.params.allowProviderModelFallback, false);
assert.equal(calls[0]?.params.config.model_reasoning_effort, 'medium');
const admission = await adapter.admit(plan, construction, 'exact retained reminder');
assert.equal(admission.turnId, 'native-turn-1');
assert.deepEqual(calls[1]?.params.environments, calls[0]?.params.environments);
assert.equal(calls[1]?.params.input[0]?.text, 'exact retained reminder');

await assert.rejects(() => adapter.construct({ ...plan, predecessorExcluded: false } as unknown as CodexSuccessorPlan), /exclusion/);
await assert.rejects(() => adapter.construct({ ...plan, model: 'gpt-6-luna' as any }), /Astra/);
const wrongClient: any = { request: async () => ({ thread: { id: 'wrong', modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'high',cwd: plan.cwd,
  runtimeWorkspaceRoots: [...plan.runtimeWorkspaceRoots], environments: [{ ...selectedEnvironment }] },
  model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'high' }) };
const mismatch = await new CodexSuccessorNativeAdapter(wrongClient).construct(plan).then(()=>null,error=>error);
assert.equal(mismatch?.threadId, 'wrong', 'a settings mismatch retains the created native identity');

function conflictingEnvironmentResponse(environments: unknown[]) {
  return { thread: { id: 'conflicting-environment', modelProvider: 'openai', model: 'gpt-6-astra',
    reasoningEffort: 'medium', cwd: plan.cwd, runtimeWorkspaceRoots: [...plan.runtimeWorkspaceRoots], environments },
    model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'medium', approvalPolicy: 'never',
    sandbox: { type: 'dangerFullAccess' } };
}
for (const [label, environments] of [
  ['additional selected environment', [{ ...selectedEnvironment }, { ...selectedEnvironment, environmentId: 'remote' }]],
  ['environment cwd conflict', [{ ...selectedEnvironment, cwd: '/other' }]],
  ['environment roots conflict', [{ ...selectedEnvironment, runtimeWorkspaceRoots: ['/other'] }]],
] as const) {
  const conflictingClient: any = { request: async () => conflictingEnvironmentResponse(environments) };
  const conflict = await new CodexSuccessorNativeAdapter(conflictingClient).construct(plan).then(() => null, error => error);
  assert.equal(conflict?.threadId, 'conflicting-environment', `${label} retains constructed identity`);
  assert.match(String(conflict?.message), /conflicts with the committed successor plan/);
}
console.log('codex successor native fixture passed: positive construction/admission and 6 refusal cases');
