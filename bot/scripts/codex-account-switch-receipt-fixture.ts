import assert from 'node:assert/strict';
import {codexAccountSwitchProjection,codexAccountSwitchReply} from '../src/codex-account-switch-receipt';
import {compactReceiptFromFacts} from '../src/prepared-receipt-core';

const activeWorkRefusal={status:'failed',detail:'A Codex turn is active on the owner or another Codex client, so the runner was left alone.'};
assert.deepEqual(codexAccountSwitchProjection(activeWorkRefusal),{
  outcome:'refused',resultPreview:activeWorkRefusal.detail,
});
assert.deepEqual(codexAccountSwitchProjection({status:'deferred',detail:'Guard refused this attempt.'}),{
  outcome:'refused',resultPreview:'Guard refused this attempt.',
});
assert.equal(codexAccountSwitchProjection({status:'completed',activation:{status:'applied'}}).outcome,'completed');
assert.equal(codexAccountSwitchProjection({status:'failed',detail:'The move failed and rolled back.'}).outcome,'failed');
assert.equal(codexAccountSwitchProjection({status:'uncertain',detail:'The runner did not confirm.'}).outcome,'uncertain');
assert.deepEqual(codexAccountSwitchReply('retained-operation-id',activeWorkRefusal),{
  ...activeWorkRefusal,operationId:'retained-operation-id',outcome:'refused',
});
const input={id:'retained-operation-id',session_id:9,kind:'action',origin:'agent',
  source_input_id:'request:11111111-1111-4111-8111-111111111111',
  source_run_id:'22222222-2222-4222-8222-222222222222',request_id:null,turn_id:null,steering_id:null,
  created_at:'2026-11-13T21:30:01.000Z',updated_at:'2026-11-13T21:30:01.000Z',
  payload_json:JSON.stringify({kind:'codex-account-switch',profileId:'saved-profile',machine:'cloud'}),
  receipt_json:JSON.stringify(activeWorkRefusal)};
const compact=compactReceiptFromFacts(input,null,null,
  {known:false,outcome:null,targetSessionId:null,targetAddress:null,sourceInputId:null,resultPreview:null,acknowledgedAt:null},null,
  {kind:'exact',statusDetail:null,providerOutage:null,attachments:[],attachmentCount:0,provenance:null});
assert.deepEqual({operationId:compact.operationId,state:compact.state,resultPreview:compact.resultPreview},
  {operationId:'retained-operation-id',state:'refused',resultPreview:activeWorkRefusal.detail});
process.stdout.write('Codex account-switch receipt projection fixture passed.\n');
