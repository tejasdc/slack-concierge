import assert from 'node:assert/strict';
import {parseRouterSessionsArgs} from './router-sessions';

const sourceInput='research-human-input';
const sourceRun='research-human-run';
const actionId='research-stable-action';

function ask(options:string[]) {
  const parsed=parseRouterSessionsArgs([
    'ask','--purpose','research',...options,
    '--session-name','Research provider effort check',
    '--summary','Check provider-specific effort',
    '--source-input',sourceInput,'--source-run',sourceRun,'--action-id',actionId,
    '--','Analyze the declared research question.',
  ]);
  assert.equal(parsed.operation,'ask');
  if(parsed.operation!=='ask')throw new Error('Expected an ask request.');
  assert.equal(parsed.body.source.input_id,sourceInput);
  assert.equal(parsed.body.source.run_id,sourceRun);
  assert.equal(parsed.body.action_id,actionId);
  assert.equal(parsed.body.purpose,'research');
  return parsed.body;
}

const alternate=ask([
  '--provider','cx-sol','--provider-reason','Need an independent coding-provider analysis',
  '--project','slack-concierge',
]);
assert.equal(alternate.provider,'cx-sol');
assert.equal(alternate.providerReason,'Need an independent coding-provider analysis');
assert.equal('effort' in alternate,false,
  'ChatGPT Pro effort must not be sent to an alternate provider that should use its own default.');

const alternateWithEffort=ask([
  '--provider','cx-sol','--provider-reason','Need an independent coding-provider analysis',
  '--project','slack-concierge','--effort','high',
]);
assert.equal(alternateWithEffort.effort,'high',
  'An explicitly supplied compatible effort must remain attached to the selected provider.');

const defaultChatGpt=ask([]);
assert.equal(defaultChatGpt.provider,'chatgpt');
assert.equal(defaultChatGpt.effort,'pro',
  'Declared research without an alternate provider must keep the ChatGPT Pro default.');

const explicitChatGptEffort=ask(['--provider','chatgpt','--effort','high']);
assert.equal(explicitChatGptEffort.effort,'high',
  'An explicit ChatGPT effort must remain unchanged for owner-side human-choice verification.');

console.log('declared research keeps effort provider-specific and preserves request identity');
