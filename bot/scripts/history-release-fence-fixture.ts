import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
const scratch=mkdtempSync(join(tmpdir(),'history-fence-'));
process.env.CONCIERGE_STATE_DIR=scratch;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const [{db,claimNextQueuedTurn,markTurnProviderAdmissionIntended},{createNativeSession,retainSessionInput,enqueueSessionInput,getAcceptedSessionInput},
 {SessionExecutionHost},{ActiveTurnDispatchRegistry}]=await Promise.all([
 import('../src/state'),import('../src/session-inputs'),import('../src/session-execution-host'),import('../src/turn-dispatch-seams')]);
let starts=0,release!:()=>void;
const host=new SessionExecutionHost({instanceId:'fence-fixture',registry:new ActiveTurnDispatchRegistry({onStarted(){},onSettled(){}}),providers:{},defaultCwd:scratch,wake(){},thesaurusContext:async()=>'',
 capabilityClient:{createChatGptProvider(){starts++;throw new Error('must not invoke');}} as any});
try{
 const refusedSession=createNativeSession('chatgpt',{title:'local refusal',purpose:'chat',model:'his:pro',cwd:scratch,origin:'native'});
 const refusedInput=retainSessionInput({id:'local-refusal',sessionId:refusedSession.id,scope:'fixture',actionId:'local-refusal',kind:'input',origin:'human',payload:{text:'Preserve this known-unsent request'}}).input;
 enqueueSessionInput(refusedInput.id);
 const refusedClaim=claimNextQueuedTurn('fence-fixture')!;
 assert.equal((await host.run(refusedClaim)).status,'error');
 assert.equal((db.query('SELECT provider_admission_intended_at FROM turns WHERE id=?').get(refusedClaim.turn_id) as any).provider_admission_intended_at,null,
   'a local provider factory refusal must not be classified as a possible external send');
 assert.equal(starts,1);
 const session=createNativeSession('chatgpt',{title:'release fence',purpose:'chat',model:'his:pro',cwd:scratch,origin:'native'});
 const input=retainSessionInput({id:'before-fence',sessionId:session.id,scope:'fixture',actionId:'before-fence',kind:'input',origin:'human',payload:{text:'Keep my exact request'}}).input;
 enqueueSessionInput(input.id);const claim=claimNextQueuedTurn('fence-fixture')!;
 (host as any).retireHistory=()=>new Promise<void>(resolve=>{release=resolve;});
 const retirement=host.prepareRelease();
 const result=await host.run(claim);
 assert.equal(result.status,'retry_queued');assert.equal(starts,1);
 assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(claim.turn_id) as any).status,'queued');
 assert.equal(JSON.parse(getAcceptedSessionInput(input.id)!.payload_json).text,'Keep my exact request');
 const during=retainSessionInput({id:'during-fence',sessionId:session.id,scope:'fixture',actionId:'during-fence',kind:'input',origin:'human',payload:{text:'Accepted during retirement'}}).input;
 enqueueSessionInput(during.id);assert.ok(getAcceptedSessionInput(during.id));
 release();await retirement;
 (host as any).retireHistory=async()=>{throw new Error('injected retirement failure');};
 await host.prepareRelease();
 assert.equal((host as any).draining,true,'failure must retain the dispatch fence and allow ordinary shutdown to continue');
 assert.equal(starts,1);
  // A retained earlier intent is uncertainty, not evidence that invocation never happened.
  const uncertainSession=createNativeSession('chatgpt',{title:'uncertain release',purpose:'chat',model:'his:pro',cwd:scratch,origin:'native'});
  const uncertain=retainSessionInput({id:'uncertain-fence',sessionId:uncertainSession.id,scope:'fixture',actionId:'uncertain-fence',kind:'input',origin:'human',payload:{text:'Do not replay uncertain work'}}).input;
  enqueueSessionInput(uncertain.id);
  const uncertainClaim=claimNextQueuedTurn('fence-fixture',Date.now(),[session.id])!;
  assert.equal(uncertainClaim.session_id,uncertainSession.id);
  assert.ok(markTurnProviderAdmissionIntended(uncertainClaim.turn_id,'fence-fixture',uncertainClaim.dispatch_attempt));
  assert.equal((await host.run(uncertainClaim)).status,'provider_parked');
  assert.equal(starts,1);
 console.log('history release fence: claimed unsent work requeued exactly; durable acceptance live; retirement failure continues with fence held');
}finally{db.close();rmSync(scratch,{recursive:true,force:true});}
process.exit(0);
