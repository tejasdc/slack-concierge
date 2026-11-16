import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {CodexAppServerClientLike} from '../src/codex-app-server-client';
import {CodexAppServerClientError} from '../src/codex-app-server-client';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const state=mkdtempSync(join(tmpdir(),'codex-custody-effects-'));
process.env.CONCIERGE_STATE_DIR=state;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(state,'capture');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
const {createNativeSession,retainSessionInput,enqueueSessionInput}=await import('../src/session-inputs');
const {db}=await import('../src/state');
const {recordSessionEvent}=await import('../src/session-inputs');
const {reconcileCodexCustodyPredecessorEffects}=await import('../src/codex-custody-effects');
const predecessor=createNativeSession('codex',{title:'Effect fixture predecessor',summary:'fixture',purpose:'writing',origin:'native',cwd:state});
const threadId='fixture-predecessor-thread';
db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,predecessor.id);
const input=retainSessionInput({id:'effects-selected-input',sessionId:predecessor.id,scope:'effects-fixture',actionId:'selected',kind:'request',origin:'human',payload:{text:'fixture'}}).input;
enqueueSessionInput(input.id);
const turnId=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(input.id) as any).turn_id);
db.query("UPDATE turns SET status='done',provider_turn_id='fixture-native-turn',dispatch_attempt=1 WHERE id=?").run(turnId);

type Scenario={status?:unknown;queue?:unknown;queuePages?:unknown[];goal?:unknown;goalError?:{code:number;message:string};
 background?:unknown;backgroundPages?:unknown[];backgroundError?:{code:number;message:string};omit?:string};
function client(s:Scenario={}):CodexAppServerClientLike {
 return {connect:async()=>1,notify:async()=>{},onNotification:()=>()=>{},onDisconnect:()=>()=>true,waitForDisconnect:()=>new Promise<void>(()=>{}),
   request:async(method:string,params:any)=>{
    if(method==='thread/read')return s.omit==='read'?{}:{thread:{id:params.threadId,status:s.status??{type:'idle'}}};
    if(method==='thread/queue/list'){
      if(s.omit==='queue')return {};
      if(s.queuePages)return s.queuePages.shift();
      return {data:s.queue??[],nextCursor:null};
    }
    if(method==='thread/goal/get'){
      if(s.omit==='goal')return {};
      if(s.goalError)throw new CodexAppServerClientError(`Codex app-server thread/goal/get failed: ${s.goalError.message}`,'ambiguous',s.goalError.code);
      return {goal:s.goal===undefined?null:s.goal};
    }
    if(method==='thread/backgroundTerminals/list'){
      if(s.omit==='background')return {};
      const status=s.status as any;
      const error=s.backgroundError??(status?.type==='notLoaded'?{code:-32600,message:`thread not found: ${params.threadId}`} : undefined);
      if(error)throw new CodexAppServerClientError(`Codex app-server thread/backgroundTerminals/list failed: ${error.message}`,'ambiguous',error.code);
      if(s.backgroundPages)return s.backgroundPages.shift();
      return {data:s.background??[],nextCursor:null};
    }
    throw new Error(`unexpected native method ${method}`);
   }} as CodexAppServerClientLike;
}
const observe=async(id:string)=>{assert.equal(id,threadId);return [];};
const reconcile=(scenario:Scenario={},processes:unknown[]=[])=>reconcileCodexCustodyPredecessorEffects(client(scenario),
 {predecessorSessionId:predecessor.id,threadId,selectedTurnId:turnId},async id=>{assert.equal(id,threadId);return processes as any;});

const receipt=await reconcile();
assert.equal(receipt.threadStatus,'idle');assert.deepEqual(receipt.queuedSubmissionIds,[]);assert.deepEqual(receipt.goal,{status:'absent'});
assert.deepEqual(receipt.backgroundTerminals,{status:'observed',ids:[]});assert.deepEqual(receipt.currentProcesses,[]);
const notLoaded=await reconcile({status:{type:'notLoaded'}});
assert.equal(notLoaded.threadStatus,'notLoaded');assert.equal(notLoaded.backgroundTerminals.status,'thread-not-loaded');
await assert.rejects(()=>reconcile({status:{type:'notLoaded'}},[{pid:551,name:'old-codex-child',startTicks:'991',cgroup:'/fixture'}]),
 /fresh owner process observation found 1/,'notLoaded does not bypass the exact live process observation');
assert.deepEqual((await reconcile({goal:{threadId,objective:'completed job',status:'complete',tokensUsed:3,timeUsedSeconds:2}})).goal,
 {status:'complete',objective:'completed job'});
const goalsDisabled=await reconcile({status:{type:'notLoaded'},goalError:{code:-32600,message:'goals feature is disabled'}});
assert.deepEqual(goalsDisabled.goal,{status:'feature-disabled'},'only the exact pinned disabled-feature RPC refusal establishes this disposition');
await assert.rejects(()=>reconcile({goalError:{code:-32600,message:'goals feature is disabled'}}),/resident thread/);
await assert.rejects(()=>reconcile({goal:'feature-disabled' as any}),/unknown goal shape/,
 'a malformed native payload cannot impersonate an internally observed feature refusal');

await assert.rejects(()=>reconcile({status:{type:'active',activeFlags:[]}}),/reports active/);
await assert.rejects(()=>reconcile({status:{type:'systemError'}}),/reports systemError/);
await assert.rejects(()=>reconcile({status:{type:'unknown'}}),/reports unknown/);
await assert.rejects(()=>reconcile({queue:[{id:'queued-1',input:[],clientUserMessageId:'client-1'}]}),/native queue has 1/);
await assert.rejects(()=>reconcile({queue:[{id:'queued-1'}]}),/unknown queued-submission/);
await assert.rejects(()=>reconcile({queuePages:[{data:[],nextCursor:'page-2'},{data:[{id:'queued-2',input:[],clientUserMessageId:'client-2'}],nextCursor:null}]}),/native queue has 1/);
await assert.rejects(()=>reconcile({queuePages:[{data:[],nextCursor:'same'},{data:[],nextCursor:'same'}]}),/repeated pagination/);
await assert.rejects(()=>reconcile({goal:{threadId,objective:'unfinished',status:'active',tokensUsed:1,timeUsedSeconds:1}}),/goal remains active/);
await assert.rejects(()=>reconcile({goal:{threadId,objective:'mystery',status:'unknown',tokensUsed:0,timeUsedSeconds:0}}),/goal remains unknown/);
await assert.rejects(()=>reconcile({goal:{threadId,objective:'bad shape',status:'complete'}}),/unknown goal shape/);
await assert.rejects(()=>reconcile({goalError:{code:-32600,message:'database unavailable'}}),/database unavailable/);
await assert.rejects(()=>reconcile({goalError:{code:-32001,message:'goals feature is disabled'}}),/goals feature is disabled/);
await assert.rejects(()=>reconcile({background:[{itemId:'terminal-1',processId:'pid',command:'build',cwd:state}]}),/background terminal process/);
await assert.rejects(()=>reconcile({backgroundPages:[{data:[],nextCursor:'page-2'},{data:[{itemId:'terminal-2',processId:'pid',command:'build',cwd:state}],nextCursor:null}]}),/background terminal process/);
await assert.rejects(()=>reconcile({omit:'read'}),/exact thread/);
await assert.rejects(()=>reconcile({omit:'queue'}),/complete data page/);
await assert.rejects(()=>reconcile({omit:'goal'}),/unknown response shape/);
await assert.rejects(()=>reconcile({omit:'background'}),/complete data page/);
await assert.rejects(()=>reconcile({status:{type:'idle'},backgroundError:{code:-32600,message:`thread not found: ${threadId}`}}),/thread not found/,
 'the not-loaded server error cannot be interpreted as empty while thread/read says idle');
await assert.rejects(()=>reconcile({},[{pid:123,name:'worker',startTicks:'456',cgroup:'/fixture'}]),/fresh owner process observation found 1/);
db.query(`INSERT INTO executions(execution_id,turn_id,dispatch_attempt,session_id,provider,host_protocol,supervisor,directory,processor_json,state,created_at_ms,updated_at_ms)
 VALUES('predecessor-active',?,1,?,'codex',1,'fixture','/tmp','{}','live',0,0)`).run(turnId,predecessor.id);
await assert.rejects(()=>reconcile(),/owner execution records remain active/);
db.query("DELETE FROM executions WHERE execution_id='predecessor-active'").run();
recordSessionEvent({eventId:'codex-process-sighting:fixture',sessionId:predecessor.id,inputId:input.id,turnId,kind:'process_audit',
 payload:{threadId,processes:[{pid:123,name:'worker',startTicks:'456',cgroup:'/fixture'}],sightedAtMs:1}});
assert.deepEqual((await reconcile()).owner.recheckedProcessSightingTurnIds,[turnId],
 'a retained sighting is reconciled against the actual current observation instead of treated as proof of current activity');
await assert.rejects(()=>reconcile({},[{pid:123,name:'worker',startTicks:'456',cgroup:'/fixture'}]),/fresh owner process observation found 1/);

// A separate session's activity must not be mistaken for a predecessor effect or a
// machine-wide idle requirement. The helper only reads direct predecessor relationships.
const sibling=createNativeSession('codex',{title:'Unrelated child session',summary:'separate scope',purpose:'fixture',origin:'native',cwd:state});
const siblingInput=retainSessionInput({id:'disjoint-active-input',sessionId:sibling.id,scope:'sibling',actionId:'input',kind:'request',origin:'human',payload:{text:'active'}}).input;
enqueueSessionInput(siblingInput.id);
const siblingTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(siblingInput.id) as any).turn_id);
db.query(`INSERT INTO executions(execution_id,turn_id,dispatch_attempt,session_id,provider,host_protocol,supervisor,directory,processor_json,state,created_at_ms,updated_at_ms)
 VALUES('disjoint-active',?,1,?,'codex',1,'fixture','/tmp','{}','live',0,0)`).run(siblingTurn,sibling.id);
assert.equal((await reconcile()).threadId,threadId);
console.log('codex custody predecessor effects fixture passed: strict fresh native pages, current process observation, and exact-session scope');
db.close();
rmSync(state,{recursive:true,force:true});
