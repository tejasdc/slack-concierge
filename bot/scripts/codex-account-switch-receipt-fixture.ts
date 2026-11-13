// Runs the admitted command path and canonical exact/compact receipt readers against disposable state.
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const scratch=mkdtempSync(join(tmpdir(),'concierge-codex-switch-receipt-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
const {CODEX_SWITCH_RECEIPT_TEST_AUTHORIZATION}=await import('../src/test-authorizations');
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_SWITCH_RECEIPT_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId},
  {SessionOwner},{SessionCommunicationCoordinator},{requestApiHandler},{readCompactReceipt}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),
  import('../src/session-communication'),import('../src/routed-request-api'),import('../src/prepared-receipt-core')]);
const {parseRouterSessionsArgs}=await import('./router-sessions');

const session=createNativeSession('codex',{title:'Disposable Codex receipt source'});
const sourceInput=retainSessionInput({sessionId:session.id,scope:'fixture',actionId:'switch-source',kind:'input',origin:'agent',
  payload:{text:'Exercise the guarded switch receipt without switching an account.'}}).input;
enqueueSessionInput(sourceInput.id);
const claim=claimNextQueuedTurn('codex-switch-receipt-fixture')!;
assert.ok(claim,'the source turn is admitted');
assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'codex-switch-receipt-fixture',claim.dispatch_attempt),true);
acknowledgeTurnProviderInput(claim.turn_id,'codex-switch-receipt-fixture',claim.dispatch_attempt,[]);
const source={input_id:sourceInput.id,run_id:nativeRunId(claim.turn_id)};

const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
let switchCalls=0,nextResult:Record<string,unknown>={status:'failed',detail:'The Codex work guard left the runner unchanged.'};
owner.switchAuthProfile=async()=>{switchCalls++;return nextResult;};
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}});
owner.communication=communication;
communication.start();
const route=requestApiHandler(null,undefined,communication,owner);
try{
const invoke=async(action_id='switch-once')=>{
  const parsed=parseRouterSessionsArgs(['auth','switch','codex','fixture-profile','--source-input',source.input_id,
    '--source-run',source.run_id,'--action-id',action_id]);
  assert.equal(parsed.operation,'auth-switch','the supported command parses to the source-bound switch operation');
  const response=await route(new Request('http://owner/session-communication/auth-switch',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(parsed.body)}));
  const body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));
  return body as any;
};
const first=await invoke(),duplicate=await invoke();
assert.equal(first.status,'failed','the original structured guard result is retained');
assert.equal(first.detail,'The Codex work guard left the runner unchanged.');
assert.equal(typeof first.operationId,'string','the direct reply exposes the retained operation ID');
assert.deepEqual({status:duplicate.status,detail:duplicate.detail,operationId:duplicate.operationId},
  {status:first.status,detail:first.detail,operationId:first.operationId},'same-action retry returns the same operation result');
assert.equal(duplicate.duplicate,true);
assert.equal(switchCalls,1,'the duplicate did not invoke the account switch again');

const exactResponse=await owner.handle(new Request(`http://owner/sessions/v1/operations/${encodeURIComponent(first.operationId)}`));
assert.ok(exactResponse);
assert.equal(exactResponse.status,200);
const exact=await exactResponse.json() as any;
assert.equal(exact.operationId,first.operationId);
assert.equal(exact.state,'failed','the canonical exact receipt uses the existing failed state');
assert.equal(exact.outcome,undefined,'the receipt does not add a second outcome vocabulary');
assert.equal(exact.result.status,first.status);
assert.equal(exact.result.detail,first.detail);
assert.equal(exact.origin,'agent');
assert.deepEqual(db.query('SELECT source_input_id,source_run_id,origin FROM session_inputs WHERE id=?').get(first.operationId),
  {source_input_id:sourceInput.id,source_run_id:source.run_id,origin:'agent'},'the retained operation preserves its exact source and authorship');
const compact=readCompactReceipt(db,first.operationId);
assert.equal(compact?.operationId,first.operationId);
assert.equal(compact?.state,'failed');
assert.equal(compact?.resultPreview,first.detail);

for(const [actionId,result,expectedState] of [
  ['switch-applied',{status:'completed',activation:{status:'applied'},detail:'The fixture account was activated.'},'completed'],
  ['switch-uncertain',{status:'uncertain',detail:'The fixture did not confirm activation.'},'uncertain'],
] as const){
  nextResult=result;
  const direct=await invoke(actionId);
  assert.equal(direct.status,result.status);
  assert.equal(direct.operationId.length>0,true);
  const read=await owner.handle(new Request(`http://owner/sessions/v1/operations/${encodeURIComponent(direct.operationId)}`));
  assert.ok(read);
  const receipt=await read.json() as any;
  assert.equal(receipt.state,expectedState,'operation state follows the retained structured status');
  assert.equal(receipt.result.status,result.status);
  assert.equal(receipt.outcome,undefined);
  assert.equal(readCompactReceipt(db,direct.operationId)?.state,expectedState);
}
assert.equal(switchCalls,3,'only three distinct actions entered the deterministic no-provider stub');

const legacy=retainSessionInput({id:'legacy-switch-operation',sessionId:session.id,scope:'fixture:legacy',actionId:'legacy-switch',
  kind:'action',origin:'agent',sourceInputId:sourceInput.id,sourceRunId:source.run_id,
  payload:{kind:'codex-account-switch',profileId:'fixture-profile',machine:'cloud'}}).input;
const legacyResult={status:'failed',detail:'The earlier active-work guard left the runner unchanged.'};
db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify(legacyResult),legacy.id);
const legacyResponse=await owner.handle(new Request(`http://owner/sessions/v1/operations/${encodeURIComponent(legacy.id)}`));
assert.ok(legacyResponse);
const legacyExact=await legacyResponse.json() as any;
assert.equal(legacyExact.operationId,legacy.id);
assert.equal(legacyExact.state,'failed','a historical refusal reads from its original status without migration');
assert.deepEqual(legacyExact.result,legacyResult,'the exact historical result is exposed unchanged');
const legacyCompact=readCompactReceipt(db,legacy.id);
assert.equal(legacyCompact?.state,'failed');
assert.equal(legacyCompact?.resultPreview,legacyResult.detail);
assert.equal(switchCalls,3,'reading historical receipts performs no switch');

console.log('Codex switch receipt acceptance passed: source-bound direct reply, duplicate, exact and compact owner reads.');
}finally{
  await communication.stop();
  db.close();
  rmSync(scratch,{recursive:true,force:true});
}
