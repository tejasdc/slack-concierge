import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import type {CodexAppServerClientLike} from '../src/codex-app-server-client';
import controlFormat from '../src/codex-custody-control-format.json';

const scratch=mkdtempSync(join(tmpdir(),'codex-custody-successor-'));
process.env.CONCIERGE_STATE_DIR=scratch;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
process.env.CODEX_HOME=join(scratch,'codex');
const releaseRoot=join(scratch,'selected-controller'),releases=join(releaseRoot,'releases');mkdirSync(releases,{recursive:true});
const controlDigest=createHash('sha256').update(JSON.stringify(controlFormat)).digest('hex');
const controllerManifest={format:2,files:{'control/codex-custody-control-format.json':controlDigest}};
const controllerDigest=createHash('sha256').update(JSON.stringify(controllerManifest)).digest('hex');
const selectedArtifact=join(releases,controllerDigest);mkdirSync(join(selectedArtifact,'control'),{recursive:true});
writeFileSync(join(selectedArtifact,'control','codex-custody-control-format.json'),JSON.stringify(controlFormat));
writeFileSync(join(selectedArtifact,'manifest.json'),JSON.stringify({...controllerManifest,artifact_digest:controllerDigest}));
symlinkSync(join('releases',controllerDigest),join(releaseRoot,'control'));
process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT=releaseRoot;
const workspace=join(scratch,'writing');mkdirSync(workspace);spawnSync('git',['init',workspace],{stdio:'ignore'});
spawnSync('git',['-C',workspace,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture'],{stdio:'ignore'});
mkdirSync(join(process.env.CODEX_HOME,'sessions','2026','11','14'),{recursive:true});
const thread='native-predecessor',sourceFile=join(scratch,'original-rollout.jsonl');
writeFileSync(sourceFile,JSON.stringify({threadId:thread,worktree:workspace}));
writeFileSync(join(process.env.CODEX_HOME,'sessions','2026','11','14',`rollout-2026-11-14T00-00-00-${thread}.jsonl`),JSON.stringify({text:workspace}));
const key=join(scratch,'lab.key');writeFileSync(key,'fixture-key');
const lab=Bun.serve({port:0,fetch:()=>Response.json({threads:[]})});
process.env.THINKERING_AGENT_TEST_KEY_FILE=key;process.env.THINKERING_ORIGIN_URL=`http://127.0.0.1:${lab.port}`;
const {db,getSessionById,claimNextQueuedTurn}=await import('../src/state');
 const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent,sessionMetadata,updateSessionMetadata}=await import('../src/session-inputs');
const {SessionCommunicationCoordinator}=await import('../src/session-communication');
const {recoverCustodySuccessor,custodySuccessor,protectedCustodyRun}=await import('../src/codex-custody-successor');
const {SessionExecutionHost}=await import('../src/session-execution-host');
const {ActiveTurnDispatchRegistry}=await import('../src/turn-dispatch-seams');
const {runCodexTurn}=await import('../src/codex');
let stopHost:(()=>Promise<void>)|null=null;

let constructionCount=0,spentAtNativeSend:string|null=null,runModelGateDuringSend=()=>{},markNativeSent!:()=>void;
let releaseNativeCompletion!:()=>void,markProviderTurnRecorded!:()=>void,nativeCompleted=false;
const nativeSent=new Promise<void>(resolve=>{markNativeSent=resolve;});
const nativeCompletion=new Promise<void>(resolve=>{releaseNativeCompletion=()=>{nativeCompleted=true;resolve();};});
const providerTurnRecorded=new Promise<void>(resolve=>{markProviderTurnRecorded=resolve;});
const nativeCalls:string[]=[];const listeners=new Set<(event:any)=>void>();
const nativeClient:CodexAppServerClientLike & {close():Promise<void>}={
  async connect(){return 1},async notify(){},onNotification(listener:(event:any)=>void){listeners.add(listener);return ()=>listeners.delete(listener);},onDisconnect(){return ()=>true},
  waitForDisconnect(){return new Promise<void>(()=>{})},
  async request(method:string,params:any){nativeCalls.push(method);
    if(method==='thread/turns/list')return params.threadId==='successor-native-thread'
      ?{data:[{id:'successor-native-turn',status:nativeCompleted?'completed':'inProgress',error:null,items:[
        {type:'userMessage',clientId:'slack-concierge:turn:4:attempt:1'},...(nativeCompleted?[{type:'agentMessage',id:'successor-answer',text:'Useful writing continuation retained.'}]:[]),
      ]}],nextCursor:null}
      :{data:[{id:'native-empty-attempt',status:'completed',error:null}],nextCursor:null};
    if(method==='thread/items/list')return params.threadId==='successor-native-thread'
      ?{data:[{turnId:'successor-native-turn',item:{type:'userMessage',clientId:'slack-concierge:turn:4:attempt:1'}},
        ...(nativeCompleted?[{turnId:'successor-native-turn',item:{type:'agentMessage',id:'successor-answer',text:'Useful writing continuation retained.'}}]:[])],nextCursor:null}
      :{data:[],nextCursor:null};
    if(method==='thread/read')return {thread:{id:thread,path:sourceFile,modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace]}};
    if(method==='thread/start'){constructionCount++;return {thread:{id:'successor-native-thread',modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,
      runtimeWorkspaceRoots:[workspace],environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},model:'gpt-6-astra',modelProvider:'openai',reasoningEffort:'medium',cwd:workspace,
      runtimeWorkspaceRoots:[workspace],approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};}
    if(method==='turn/start'){
      assert.equal(params.input?.[0]?.text,'Continue the exact retained writing request.','native send preserves the exact retained reminder');
      const row=custodySuccessor('report-back:writing-request');
      assert.ok(row?.attempt_spent_at,'native turn is forbidden until canonical allowance was spent');
      spentAtNativeSend=row.attempt_spent_at;
      assert.equal(row?.state,'admitting','native turn sees committed custody in admitting state');
      markNativeSent();
      queueMicrotask(()=>{
        for(const listener of listeners)listener({method:'turn/started',params:{threadId:'successor-native-thread',turn:{id:'successor-native-turn'}}});
        void nativeCompletion.then(()=>{
          for(const listener of listeners)listener({method:'turn/completed',params:{threadId:'successor-native-thread',turn:{id:'successor-native-turn',status:'completed',error:null,items:[
            {type:'userMessage',clientId:params.clientUserMessageId},
            {type:'agentMessage',id:'successor-answer',text:'Useful writing continuation retained.'},
          ]}}});
        });
      });
      return {turn:{id:'successor-native-turn'}};
    }
    throw new Error(`unexpected native request ${method}`);
  },async close(){},
};

try {
 const predecessor=createNativeSession('codex',{title:'Astra Medium writing',summary:'Continue writing',purpose:'writing',origin:'native',cwd:workspace,
   model:'gpt-6-astra',reasoningEffort:'medium'});
 db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(thread,predecessor.id);
 const human=retainSessionInput({id:'human-model-choice',sessionId:predecessor.id,scope:'fixture',actionId:'human-choice',kind:'request',origin:'human',
   payload:{text:'Use Astra Medium for this writing work.'}}).input;enqueueSessionInput(human.id);
 const humanTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(human.id) as any).turn_id);
 db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id='prior-human-turn' WHERE id=?").run(humanTurn);
 recordSessionEvent({eventId:'retained-human-astra-medium',sessionId:predecessor.id,inputId:human.id,kind:'model_choice',payload:{model:'gpt-6-astra',effort:'medium'}});
 const requestId='writing-request';
 const reminder=retainSessionInput({id:`report-back:${requestId}`,sessionId:predecessor.id,scope:'fixture',actionId:'reminder',kind:'request',origin:'service',requestId,
   sourceInputId:human.id,sourceRunId:nativeRunId(humanTurn),payload:{text:'Continue the exact retained writing request.'}}).input;enqueueSessionInput(reminder.id);
 const failedTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(reminder.id) as any).turn_id),failedRun=nativeRunId(failedTurn);
 db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:{provider:'codex',inputId:reminder.id,runId:failedRun,
   bindingGeneration:predecessor.binding_generation,model:'gpt-6-astra',reasoningEffort:'medium'}}),reminder.id);
 db.query(`UPDATE turns SET status='done',dispatch_attempt=1,provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,
   provider_turn_id='native-empty-attempt',provider_input_acknowledged_at=NULL,ended_at=CURRENT_TIMESTAMP WHERE id=?`).run(failedTurn);
 db.query("UPDATE sessions SET status='idle' WHERE id=?").run(predecessor.id);
 recordSessionEvent({eventId:`provider-turn-attempt:${failedTurn}:1`,sessionId:predecessor.id,inputId:reminder.id,turnId:failedTurn,kind:'provider_turn_attempt',
   payload:{provider:'codex',providerTurnId:'native-empty-attempt',dispatchAttempt:1}});
 recordSessionEvent({eventId:`result:${failedTurn}`,sessionId:predecessor.id,inputId:reminder.id,turnId:failedTurn,kind:'result',payload:{inputId:reminder.id,
   sessionId:predecessor.id,turnId:failedTurn,runId:failedRun,sessionUUID:thread,providerTurnId:'native-empty-attempt',model:'gpt-6-astra',text:'',toolsUsed:[],dispatchAttempt:1}});

 const requester=createNativeSession('codex',{title:'Requesting owner',summary:'Run recovery',purpose:'continue work',origin:'native',cwd:workspace});
 const actorInput=retainSessionInput({id:'requester-live-input',sessionId:requester.id,scope:'fixture',actionId:'actor',kind:'request',origin:'human',payload:{text:'Recover my writing request.'}}).input;
 enqueueSessionInput(actorInput.id);const actorTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(actorInput.id) as any).turn_id);
 const actorRun=nativeRunId(actorTurn);db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP WHERE id=?").run(actorTurn);
 db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
   target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(requestId,'fixture','request-message',actorTurn,requester.id,'root','request-action',predecessor.id,'fixture','root',
   JSON.stringify({requestedEffect:'work'}),'payload-hash',0,0,actorInput.id,human.id,'admitted');

 process.env.CONCIERGE_EXECUTION_HOSTS='1';
 const host=new SessionExecutionHost({instanceId:'fixture-owner',registry:new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}}),providers:{codex:{id:'codex',
   run:(actual:any)=>{const onStarted=actual.onProviderTurnStarted;return runCodexTurn({...actual,
     onProviderTurnStarted:(id:string)=>{onStarted?.(id);markProviderTurnRecorded();},applicationInstructions:actual.systemPrompt});},
   fork:async()=>{throw new Error('fork is outside this fixture');}}},
   defaultCwd:workspace,wake:()=>{},thesaurusContext:async()=>'',custodyClientFactory:()=>nativeClient});
 stopHost=()=>host.stop();
 const owner=host.owner;
 const coordinator=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}} as any);
 (coordinator as any).stopped=false;(coordinator as any).wake=()=>{};
 runModelGateDuringSend=()=>{
   const providerTurnId='successor-native-turn';
   const preserved=coordinator.modelStartGate({providerSessionId:'successor-native-thread',model:'gpt-6-astra',providerTurnId,
     ownerTurnId:claim.turn_id,sourceRunId:nativeRunId(claim.turn_id)});
   assert.deepEqual(preserved,{known:true,allowed:true},'the exact running successor retains Astra Medium without a fabricated human choice');
   assert.equal(db.query("SELECT COUNT(*) AS n FROM session_owner_events WHERE session_id=? AND kind='model_escalation'").get(custody.successor_session_id).n,0,
     'successor preservation does not manufacture a human escalation choice');
   const wrongThread=coordinator.modelStartGate({providerSessionId:'another-native-thread',model:'gpt-6-astra',providerTurnId,
     ownerTurnId:claim.turn_id,sourceRunId:nativeRunId(claim.turn_id)});
   assert.deepEqual(wrongThread,{known:false},'a different native thread cannot inherit preservation');
   updateSessionMetadata(custody.successor_session_id,{reasoningEffort:'high'});
   const wrongEffort=coordinator.modelStartGate({providerSessionId:'successor-native-thread',model:'gpt-6-astra',providerTurnId,
     ownerTurnId:claim.turn_id,sourceRunId:nativeRunId(claim.turn_id)});
   assert.equal(wrongEffort.allowed,false,'a changed effort cannot inherit Medium preservation');
   updateSessionMetadata(custody.successor_session_id,{reasoningEffort:'medium'});
   const delegatedAstra=coordinator.modelStartGate({providerSessionId:'successor-native-thread',model:'gpt-6-astra',providerTurnId,
     ownerTurnId:claim.turn_id,sourceRunId:nativeRunId(claim.turn_id),providerAgentId:'new-astra-helper'});
   assert.equal(delegatedAstra.allowed,false,'a new Astra helper cannot inherit the accepted parent binding');
 };
 const result=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},action_id:'recover-writing-once',request_id:requestId,custody_successor:true});
 assert.equal(result.state,'constructed');
 assert.equal(constructionCount,1);
 const custody=custodySuccessor(reminder.id)!;
 assert.equal(custody.canonical_input_id,reminder.id);
 assert.equal(custody.native_thread_id,'successor-native-thread');
 assert.equal(JSON.parse(custody.plan_json).model,'gpt-6-astra');
 assert.equal(JSON.parse(custody.plan_json).custodyCommitted,true);
 assert.equal(db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(reminder.id).turn_id,failedTurn,'original reminder/attempt stay immutable');
 assert.equal(db.query('SELECT provider_turn_id FROM turns WHERE id=?').get(failedTurn).provider_turn_id,'native-empty-attempt');
 const successor=getSessionById(custody.successor_session_id)!;
 assert.equal(sessionMetadata(successor).suspended,false);
 assert.equal(successor.agent_session_uuid,'successor-native-thread');
 assert.equal(db.query('SELECT state FROM session_handoffs WHERE id=?').get(custody.handoff_id).state,'accepted');
 assert.equal(nativeCalls.filter(call=>call==='thread/start').length,1);
 assert.equal(nativeCalls.includes('thread/resume'),false);

 // The actual queue admits the successor placement only after construction. Its shared
 // allowance is committed before native send; normal turn acknowledgement/result consumers
 // then resolve the original work request from the placement's exact payload.
 const claim=claimNextQueuedTurn('fixture-owner');assert.ok(claim);assert.equal(claim.session_id,custody.successor_session_id);
 assert.equal(claim.accepted_input_id,custody.placement_input_id,'the selected native turn is the exact transferred work placement');
 const protectedRun=protectedCustodyRun(claim.turn_id,'fixture-owner',claim.dispatch_attempt)!;
 assert.equal(protectedRun.plan.model,'gpt-6-astra');
 const originalRollout=readFileSync(sourceFile);
 writeFileSync(sourceFile,'stale source replacement');
 await assert.rejects(()=>protectedRun.beforeAdmission(),/source changed/i,'stale retained source refuses before spending the allowance');
 assert.equal(custodySuccessor(reminder.id)?.attempt_spent_at,null,'stale source leaves the shared attempt available for reconciliation');
 assert.equal(nativeCalls.includes('turn/start'),false,'stale-source refusal happens before a native send');
 writeFileSync(sourceFile,originalRollout);
 const hostRun=host.run(claim);
 await nativeSent;
 await providerTurnRecorded;
 const spentAt=spentAtNativeSend;
 assert.ok(spentAt,'canonical additional attempt spent durably before native send');
 assert.equal(nativeCalls.filter(call=>call==='turn/start').length,1,'selected native turn/start occurs exactly once');
 const activeIdentity=db.query('SELECT status,owner_instance_id,provider_admission_intended_at,provider_turn_id FROM turns WHERE id=?').get(claim.turn_id) as any;
 assert.equal(activeIdentity.status,'running','the native completion gate keeps the selected owner turn active');
 assert.ok(activeIdentity.provider_admission_intended_at,'owner marks native provider admission before custody successor input can act');
 assert.equal(activeIdentity.provider_turn_id,'successor-native-turn','the actual native turn identity is already retained before a scoped action');
 const placement=(await import('../src/session-inputs')).getAcceptedSessionInput(custody.placement_input_id)!;
 const progressAction='fixture-custody-partial';
 await coordinator.reply({source:{input_id:placement.id,run_id:nativeRunId(claim.turn_id)},action_id:progressAction,request_id:requestId,
   text:'Disposable useful progress.',final:false});
 const progress=db.query('SELECT request_id,kind,payload_json FROM session_communication_events WHERE action_key=?')
   .get(JSON.stringify(['input',placement.id,progressAction])) as any;
 assert.equal(progress.request_id,requestId,'the successor can reply only under the exact retained original request');
 assert.equal(progress.kind,'progress','a partial reply leaves the original work obligation open');
 const progressPayload=JSON.parse(progress.payload_json);
 assert.equal(progressPayload.responding_session_id,`concierge:${custody.successor_session_id}`,'the new successor is the recorded responder');
 assert.equal(progressPayload.source.input_id,placement.id,'partial authority is bound to the exact running placement input');
 assert.equal((db.query('SELECT outcome FROM session_communication_requests WHERE request_id=?').get(requestId) as any).outcome,null,
   'partial successor reply does not close the original work obligation');
 runModelGateDuringSend();
 releaseNativeCompletion();
 const providerTurnId='successor-native-turn';
 assert.equal(placement.payload_json,reminder.payload_json);
 const actualResult=await hostRun;
 assert.equal(actualResult.status,'delivered','host reports delivered after native completion');
 assert.equal(custodySuccessor(reminder.id)?.state,'acknowledged','real native user-message acknowledgment resolves custody state');
 const settledTurn=db.query('SELECT provider_turn_id,provider_input_acknowledged_at,status FROM turns WHERE id=?').get(claim.turn_id) as any;
 assert.equal(settledTurn.provider_turn_id,providerTurnId,'native turn identity is persisted by the real provider-start callback');
 assert.ok(settledTurn.provider_input_acknowledged_at,'native acknowledgment is persisted by the real input consumer');
 assert.equal(settledTurn.status,'done','host settles the turn from native completion');
 const savedResult=db.query("SELECT payload_json FROM session_owner_events WHERE event_id=?").get(`result:${claim.turn_id}`) as any;
 assert.match(JSON.parse(savedResult.payload_json).text,/Useful writing continuation/,'persisted useful result is derived from native completion');
 assert.equal(db.query('SELECT provider_input_acknowledged_at FROM turns WHERE id=?').get(claim.turn_id).provider_input_acknowledged_at!==null,true);
 await assert.rejects(()=>protectedRun.beforeAdmission(),/spent|changed|exclusive/i,'second native admission is refused after the shared allowance is spent');
 const unrelated=retainSessionInput({id:'successor-unrelated-input',sessionId:custody.successor_session_id,scope:'fixture-next',actionId:'unrelated',
   kind:'input',origin:'human',payload:{text:'Do this separate follow-up task.'}}).input;enqueueSessionInput(unrelated.id);
 const nextClaim=claimNextQueuedTurn('fixture-owner');assert.ok(nextClaim);assert.equal(nextClaim.accepted_input_id,unrelated.id);
 const nextProtected=protectedCustodyRun(nextClaim.turn_id,'fixture-owner',nextClaim.dispatch_attempt)!;
 assert.equal(nextProtected.construction.threadId,'successor-native-thread','later work stays on the exact committed successor thread');
 await nextProtected.beforeAdmission();
 const allowanceAfterNext=custodySuccessor(reminder.id)!;
 assert.equal(allowanceAfterNext.attempt_spent_at,spentAt,'unrelated work cannot reset the canonical recovery allowance');
 assert.equal(allowanceAfterNext.dispatch_attempt,claim.dispatch_attempt,'unrelated turn does not consume a second selected-input attempt');

 const makeTarget=async(requestKey:string)=>{
   const target=createNativeSession('codex',{title:`${requestKey} Astra Medium`,summary:'Continue exact writing',purpose:'writing',origin:'native',cwd:workspace,
     model:'gpt-6-astra',reasoningEffort:'medium'});
   const threadId=`thread-${requestKey}`,rollout=join(scratch,`${requestKey}.jsonl`);writeFileSync(rollout,JSON.stringify({threadId,workspace}));
   writeFileSync(join(process.env.CODEX_HOME!,'sessions','2026','11','14',`rollout-2026-11-14T00-00-01-${threadId}.jsonl`),JSON.stringify({text:workspace}));
   db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(threadId,target.id);
   const human=retainSessionInput({id:`human-${requestKey}`,sessionId:target.id,scope:`fixture-${requestKey}`,actionId:'human-choice',kind:'request',origin:'human',
     payload:{text:'Use Astra Medium for this writing task.'}}).input;enqueueSessionInput(human.id);
   const humanTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(human.id) as any).turn_id);
   db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP,provider_turn_id=? WHERE id=?").run(`prior-${requestKey}`,humanTurn);
   const report=retainSessionInput({id:`report-back:${requestKey}`,sessionId:target.id,scope:`fixture-${requestKey}`,actionId:'report',kind:'request',origin:'service',
     requestId:requestKey,sourceInputId:human.id,sourceRunId:nativeRunId(humanTurn),payload:{text:`Continue ${requestKey} exactly.`}}).input;enqueueSessionInput(report.id);
   const turnId=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(report.id) as any).turn_id),runId=nativeRunId(turnId);
   const admission={provider:'codex',inputId:report.id,runId,bindingGeneration:target.binding_generation,model:'gpt-6-astra',reasoningEffort:'medium'};
   db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission}),report.id);
   db.query(`UPDATE turns SET status='done',dispatch_attempt=1,provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP,
     provider_turn_id=?,provider_input_acknowledged_at=NULL,ended_at=CURRENT_TIMESTAMP WHERE id=?`).run(`empty-${requestKey}`,turnId);
   recordSessionEvent({eventId:`provider-turn-attempt:${turnId}:1`,sessionId:target.id,inputId:report.id,turnId,kind:'provider_turn_attempt',
     payload:{provider:'codex',providerTurnId:`empty-${requestKey}`,dispatchAttempt:1}});
   recordSessionEvent({eventId:`result:${turnId}`,sessionId:target.id,inputId:report.id,turnId,kind:'result',payload:{inputId:report.id,sessionId:target.id,
     turnId,runId,sessionUUID:threadId,providerTurnId:`empty-${requestKey}`,model:'gpt-6-astra',text:'',toolsUsed:[],dispatchAttempt:1}});
   db.query("UPDATE sessions SET status='idle' WHERE id=?").run(target.id);
   db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
     target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(requestKey,'fixture',`message-${requestKey}`,actorTurn,requester.id,'root',`action-${requestKey}`,
       target.id,'fixture','root',JSON.stringify({requestedEffect:'work'}),`hash-${requestKey}`,0,0,actorInput.id,human.id,'admitted');
   return {target,threadId,rollout,report,turnId};
 };
 const makeNative=(threadId:string,rollout:string,start:()=>unknown)=>({
   async connect(){return 1},async notify(){},onNotification(){return ()=>true},onDisconnect(){return ()=>true},waitForDisconnect(){return new Promise<void>(()=>{})},
   async request(method:string){
     if(method==='thread/turns/list')return {data:[{id:`empty-${threadId.slice(7)}`,status:'completed',error:null}],nextCursor:null};
     if(method==='thread/items/list')return {data:[],nextCursor:null};
     if(method==='thread/read')return {thread:{id:threadId,path:rollout,modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace]}};
     if(method==='thread/start')return start();throw new Error(`unexpected ${method}`);
   },async close(){},
 });
 // A lost thread/start response is retained as uncertain. Re-entry returns that held operation
 // without asking the native service to construct another thread.
 const lost=await makeTarget('lost-construction');let lostStarts=0;
 const lostNative=makeNative(lost.threadId,lost.rollout,()=>{lostStarts++;throw new Error('native construction response lost');});
 const lostRequest={actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,requestId:'lost-construction',actionId:'lost-one',validateSource:()=>{}};
 await assert.rejects(()=>recoverCustodySuccessor(lostRequest,lostNative),/response lost/);
 assert.equal(custodySuccessor(lost.report.id)?.state,'held');
 const lostRetry=await recoverCustodySuccessor({...lostRequest,actionId:'lost-two'},lostNative);
 assert.equal(lostRetry.state,'held');assert.equal(lostStarts,1,'uncertain native construction cannot be repeated');

 // A known native thread whose effective effort conflicts with the owner plan stays held,
 // retains that native identity for reconciliation, and never releases its queued placement.
 const mismatch=await makeTarget('wrong-settings');let mismatchStarts=0;
 const mismatchNative=makeNative(mismatch.threadId,mismatch.rollout,()=>{mismatchStarts++;return {thread:{id:'native-wrong-settings',modelProvider:'openai',
   model:'gpt-6-astra',reasoningEffort:'high',cwd:workspace,runtimeWorkspaceRoots:[workspace],environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},
   model:'gpt-6-astra',modelProvider:'openai',reasoningEffort:'high',cwd:workspace,runtimeWorkspaceRoots:[workspace],approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};});
 const mismatchRequest={actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,requestId:'wrong-settings',actionId:'wrong-one',validateSource:()=>{}};
 await assert.rejects(()=>recoverCustodySuccessor(mismatchRequest,mismatchNative),/conflicts with the committed plan/);
 const held=custodySuccessor(mismatch.report.id)!;assert.equal(held.state,'held');assert.equal(held.native_thread_id,'native-wrong-settings');
 assert.equal((db.query('SELECT agent_session_uuid FROM sessions WHERE id=?').get(held.successor_session_id) as any).agent_session_uuid,null);
 assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(held.placement_turn_id) as any).status,'queued');
 assert.equal(claimNextQueuedTurn('fixture-owner'),null,'mismatched settings do not release successor work to the native queue');
 const mismatchRetry=await recoverCustodySuccessor({...mismatchRequest,actionId:'wrong-two'},mismatchNative);
 assert.equal(mismatchRetry.native_thread_id,'native-wrong-settings');assert.equal(mismatchStarts,1);

 // An attached diagnostic claim cannot replace the owner-retained admission binding.
 const diagnostic=await makeTarget('diagnostic-only');
 const invalidAdmission={provider:'codex',inputId:diagnostic.report.id,runId:nativeRunId(diagnostic.turnId),bindingGeneration:diagnostic.target.binding_generation,
   model:'gpt-6-astra',reasoningEffort:'xhigh'};
 db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',admission:invalidAdmission,
   codex_original_history_v1:{assessed:true,diagnosticProof:'caller-supplied'},diagnostic:{watermark:29906}}),diagnostic.report.id);
 let diagnosticStarts=0;const diagnosticNative=makeNative(diagnostic.threadId,diagnostic.rollout,()=>{diagnosticStarts++;return {};});
 await assert.rejects(()=>recoverCustodySuccessor({actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,
   requestId:'diagnostic-only',actionId:'diagnostic-claim',validateSource:()=>{}},diagnosticNative),/Retained admission/);
 assert.equal(diagnosticStarts,0,'strict-failed and diagnostic records provide no successor admission authority');

 // A second action cannot mint another successor or another native construction for this canonical reminder.
 const duplicate=await recoverCustodySuccessor({actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,requestId,actionId:'second-action',
   validateSource:()=>{}},nativeClient);
 assert.equal(duplicate.handoff_id,custody.handoff_id,'different actions resolve to the same canonical custody record');
 assert.equal(constructionCount,1,'the canonical recovery allowance cannot be renewed with a different action');
 assert.equal(nativeCalls.filter(call=>call==='turn/start').length,1,'duplicate recovery cannot produce a second selected provider admission');

 // A fresh exact owner selection with conflicting effort is refused before construction.
 const bad=createNativeSession('codex',{title:'wrong effort',summary:undefined,purpose:'writing',origin:'native',cwd:workspace,model:'gpt-6-astra',reasoningEffort:'medium'});
 db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run('bad-thread',bad.id);
 assert.equal(nativeCalls.includes('thread/resume'),false);
 console.log('custody successor owner fixture passed: live work authority, complete prior-attempt observation, atomic custody, explicit Astra Medium construction, one persisted acknowledgement/useful result, canonical dedupe');
} finally {await stopHost?.();lab.stop();db.close();rmSync(scratch,{recursive:true,force:true});}
