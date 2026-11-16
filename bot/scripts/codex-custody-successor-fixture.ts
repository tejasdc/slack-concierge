import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
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
let grantToCloseDuringLab:string|null=null;const lab=Bun.serve({port:0,fetch:request=>{
 if(grantToCloseDuringLab&&new URL(request.url).pathname==='/api/lab'){
   db.query("UPDATE session_communication_requests SET outcome='answered',status='answered' WHERE request_id=? AND outcome IS NULL").run(grantToCloseDuringLab);
   grantToCloseDuringLab=null;
 }
 return Response.json({threads:[]});
}});
process.env.THINKERING_AGENT_TEST_KEY_FILE=key;process.env.THINKERING_ORIGIN_URL=`http://127.0.0.1:${lab.port}`;
const {db,getSessionById,claimNextQueuedTurn,markTurnProviderAdmissionIntended,recordTurnProviderTurnId,acknowledgeTurnProviderInput}=await import('../src/state');
 const {createNativeSession,retainSessionInput,enqueueSessionInput,nativeRunId,recordSessionEvent,sessionMetadata,updateSessionMetadata}=await import('../src/session-inputs');
const {SessionCommunicationCoordinator}=await import('../src/session-communication');
const {recoverCustodySuccessor:recoverWithProcessObservation,custodySuccessor,protectedCustodyRun}=await import('../src/codex-custody-successor');
const recoverCustodySuccessor=(input:any,client:CodexAppServerClientLike)=>recoverWithProcessObservation(input,client,async()=>[]);
const {SessionExecutionHost}=await import('../src/session-execution-host');
const {ActiveTurnDispatchRegistry}=await import('../src/turn-dispatch-seams');
const {runCodexTurn}=await import('../src/codex');
let stopHost:(()=>Promise<void>)|null=null;

let constructionCount=0,spentAtNativeSend:string|null=null,runModelGateDuringSend=()=>{},markNativeSent!:()=>void;
let markConstructionStarted!:()=>void,releaseConstruction!:()=>void;
const constructionStarted=new Promise<void>(resolve=>{markConstructionStarted=resolve;});
const constructionGate=new Promise<void>(resolve=>{releaseConstruction=resolve;});
let releaseNativeCompletion!:()=>void,markProviderTurnRecorded!:()=>void,nativeCompleted=false;
const nativeSent=new Promise<void>(resolve=>{markNativeSent=resolve;});
const nativeCompletion=new Promise<void>(resolve=>{releaseNativeCompletion=()=>{nativeCompleted=true;resolve();};});
const providerTurnRecorded=new Promise<void>(resolve=>{markProviderTurnRecorded=resolve;});
const nativeCalls:string[]=[];const listeners=new Set<(event:any)=>void>();
const nativeClient:CodexAppServerClientLike & {close():Promise<void>}={
  custodySenderId:'fixture-owner-native-client',nativeEndpoint:{socketPath:'/disposable',relayRunner:null,serverInfo:{fixture:true}},
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
    if(method==='thread/read')return {thread:{id:thread,status:{type:'idle'},path:sourceFile,modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace]}};
    if(method==='thread/queue/list'||method==='thread/backgroundTerminals/list')return {data:[],nextCursor:null};
    if(method==='thread/goal/get')return {goal:null};
    if(method==='thread/start'){constructionCount++;markConstructionStarted();await constructionGate;return {thread:{id:'successor-native-thread',modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,
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
let newCustodyClient:CodexAppServerClientLike & {close():Promise<void>}=nativeClient;
const managedLegacySenders:{custodySenderId:string;activeGeneration:number|null;close(options?:{immediate?:boolean}):Promise<void>}[]=[];
const cutoffBridge=join(scratch,'cutoff-bridge.js');
const jsonLinesModule=pathToFileURL(resolve(import.meta.dir,'../src/json-lines.ts')).href;
writeFileSync(cutoffBridge,`import {onJsonLines} from ${JSON.stringify(jsonLinesModule)};
process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
onJsonLines(process.stdin,line=>{const call=JSON.parse(line);
  if(call.type==='close')process.exit(0);
  if(call.type==='request'){const result=call.method==='thread/read'?{thread:{id:call.params.threadId}}:{turn:{id:call.params.clientUserMessageId||'native-empty-attempt'}};
   process.stdout.write(JSON.stringify({type:'response',id:call.id,result})+'\\n');}
 });`);
const {CodexAppServerClient,freezeManagedCodexTarget}=await import('../src/codex-app-server-client');
async function registerLegacyPrefix(sessionId:number,threadId:string,sourcePath:string,bindingGeneration:number,providerTurnId:string){
 const sender=new CodexAppServerClient('/disposable',process.execPath,{bridgePath:cutoffBridge,manageDaemon:false,shutdownGraceMs:50});
 managedLegacySenders.push(sender);
 await sender.request('turn/start',{threadId,clientUserMessageId:providerTurnId,input:[]},{custodyOwnerSessionId:sessionId});
 const endpoint=sender.nativeEndpoint;
 const cutoff=freezeManagedCodexTarget({ownerSessionId:sessionId,threadId,
   endpoint:{socketPath:endpoint.socketPath,relayRunner:endpoint.relayRunner},sourcePath,bindingGeneration});
 const receipt=await cutoff.reconcile();
 assert.equal(receipt.captured.length,1,'the real disposable native sender is tied to this exact predecessor');
 assert.equal(receipt.captured[0]?.senderId,sender.custodySenderId);
 assert.equal(receipt.captured[0]?.generation,sender.activeGeneration);
 assert.equal(receipt.barriers.length,1,'the old sender generation returns its exact read barrier');
 assert.equal(cutoff.coverage,'managed-client-registry-only');assert.equal(cutoff.externalCoverage,'not-asserted');
 return receipt;
}

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
   JSON.stringify({requestedEffect:'work',text:'Continue the selected writing work.',after:[]}),'payload-hash',0,0,actorInput.id,human.id,'admitted');
 for(const [siblingId,suffix] of [['sibling-duty-one','one'],['sibling-duty-two','two']] as const){
   db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
     target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(siblingId,'fixture',`${suffix}-message`,actorTurn,requester.id,'root',`${suffix}-action`,predecessor.id,'fixture','root',
       JSON.stringify({requestedEffect:'work',text:`Independent ${suffix} duty`,after:[]}),`${suffix}-hash`,0,0,actorInput.id,reminder.id,'admitted');
 }

 process.env.CONCIERGE_EXECUTION_HOSTS='1';
 const host=new SessionExecutionHost({instanceId:'fixture-owner',registry:new ActiveTurnDispatchRegistry({onStarted:()=>{},onSettled:()=>{}}),providers:{codex:{id:'codex',
   run:(actual:any)=>{const onStarted=actual.onProviderTurnStarted;return runCodexTurn({...actual,
     onProviderTurnStarted:(id:string)=>{onStarted?.(id);markProviderTurnRecorded();},applicationInstructions:actual.systemPrompt});},
   fork:async()=>{throw new Error('fork is outside this fixture');}}},
   defaultCwd:workspace,wake:()=>{},thesaurusContext:async()=>'',custodyClientFactory:()=>newCustodyClient,custodyObserveProcesses:async threadId=>{
     assert.equal(typeof threadId,'string');return [];
   }});
 stopHost=()=>host.stop();
 const owner=host.owner;
 const coordinator=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}} as any);
 (coordinator as any).stopped=false;(coordinator as any).wake=()=>{};
 // This old provider-turn identity was observed in the selected immutable attempt row.
 await registerLegacyPrefix(predecessor.id,thread,sourceFile,predecessor.binding_generation,'native-empty-attempt');
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
 const recovery=coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},action_id:'recover-writing-once',request_id:requestId,custody_successor:true});
 await constructionStarted;
 const constructing=custodySuccessor(reminder.id)!;
 host.owner.action(`concierge:${constructing.successor_session_id}`,{clientActionId:'pause-during-native-construction',action:{kind:'pause'}});
 assert.equal(sessionMetadata(getSessionById(constructing.successor_session_id)!).custodyUserPaused,true,'supported Pause records a newer explicit hold');
 releaseConstruction();
 const result=await recovery;
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
 assert.equal(sessionMetadata(successor).suspended,true,'construction completion preserves a Pause issued while native construction was pending');
 assert.equal(sessionMetadata(successor).custodyUserPaused,true);
 assert.equal(successor.agent_session_uuid,'successor-native-thread');
 assert.equal(db.query('SELECT state FROM session_handoffs WHERE id=?').get(custody.handoff_id).state,'accepted');
 assert.equal(nativeCalls.filter(call=>call==='thread/start').length,1);
 assert.equal(nativeCalls.includes('thread/resume'),false);

 // The actual queue admits the successor placement only after construction. Its shared
 // allowance is committed before native send; normal turn acknowledgement/result consumers
 // then resolve the original work request from the placement's exact payload.
 assert.equal(claimNextQueuedTurn('fixture-owner'),null,'passive recovery placement remains held after construction when the user paused it');
 host.owner.action(`concierge:${successor.id}`,{clientActionId:'continue-after-construction',action:{kind:'continue'}});
 assert.equal(sessionMetadata(getSessionById(successor.id)!).suspended,false,'Continue clears the explicit pause after construction is fully bound');
 assert.equal(sessionMetadata(getSessionById(successor.id)!).custodyUserPaused,false);
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
 assert.equal(custodySuccessor(reminder.id)?.state,'admitted','native identity precedes the gated user acknowledgement');
 host.owner.action(`concierge:${successor.id}`,{clientActionId:'pause-admitted-before-ack',action:{kind:'pause'}});
 assert.equal(sessionMetadata(getSessionById(successor.id)!).suspended,true);
 host.owner.action(`concierge:${successor.id}`,{clientActionId:'continue-admitted-before-ack',action:{kind:'continue'}});
 assert.equal(sessionMetadata(getSessionById(successor.id)!).suspended,false,'Continue recognizes admitted construction before acknowledgement');
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
 assert.equal(sessionMetadata(getSessionById(successor.id)!).suspended,false,'acknowledgement must not strand the earlier Continue');
 const settledTurn=db.query('SELECT provider_turn_id,provider_input_acknowledged_at,status FROM turns WHERE id=?').get(claim.turn_id) as any;
 assert.equal(settledTurn.provider_turn_id,providerTurnId,'native turn identity is persisted by the real provider-start callback');
 assert.ok(settledTurn.provider_input_acknowledged_at,'native acknowledgment is persisted by the real input consumer');
 assert.equal(settledTurn.status,'done','host settles the turn from native completion');
 const savedResult=db.query("SELECT payload_json FROM session_owner_events WHERE event_id=?").get(`result:${claim.turn_id}`) as any;
 assert.match(JSON.parse(savedResult.payload_json).text,/Useful writing continuation/,'persisted useful result is derived from native completion');
 assert.equal(db.query('SELECT provider_input_acknowledged_at FROM turns WHERE id=?').get(claim.turn_id).provider_input_acknowledged_at!==null,true);
 await assert.rejects(()=>protectedRun.beforeAdmission(),/spent|changed|exclusive/i,'second native admission is refused after the shared allowance is spent');
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
       target.id,'fixture','root',JSON.stringify({requestedEffect:'work',text:`Continue ${requestKey} work.`,after:[]}),`hash-${requestKey}`,0,0,actorInput.id,human.id,'admitted');
   return {target,threadId,rollout,report,turnId};
 };
 const makeLiveHumanRepairer=async(prefix:string)=>{
   const session=createNativeSession('codex',{title:`${prefix} repair source`,summary:'fixture work authority',purpose:'repair',origin:'native',cwd:workspace});
   const input=retainSessionInput({id:`${prefix}-input`,sessionId:session.id,scope:prefix,actionId:'live-human-work',kind:'request',origin:'human',
     payload:{text:'Repair the retained custody operation.'}}).input;enqueueSessionInput(input.id);
   const turnId=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(input.id) as any).turn_id);
   db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP WHERE id=?").run(turnId);
   return {session,input,turnId,runId:nativeRunId(turnId)};
 };
 const makeBorrowedAuthority=async(prefix:string)=>{
   const grantor=createNativeSession('codex',{title:`${prefix} grantor`,summary:'fixture grant source',purpose:'writing',origin:'native',cwd:workspace});
   const grantorInput=retainSessionInput({id:`${prefix}-grantor-input`,sessionId:grantor.id,scope:prefix,actionId:'source',kind:'input',origin:'human',payload:{text:'Assign the retained writing duty.'}}).input;
   enqueueSessionInput(grantorInput.id);const grantorTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(grantorInput.id) as any).turn_id);
   const grantorRun=nativeRunId(grantorTurn);db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(grantorTurn);
   const grantId=`${prefix}-work-grant`;
   const grantInput=retainSessionInput({id:`${prefix}-work-input`,sessionId:requester.id,scope:`communication:${grantorInput.id}`,actionId:'work-grant',kind:'request',origin:'agent',
     sourceInputId:grantorInput.id,sourceRunId:grantorRun,requestId:grantId,payload:{text:'Continue the assigned writing duty.'}}).input;
   enqueueSessionInput(grantInput.id);const grantTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(grantInput.id) as any).turn_id);
   db.query("UPDATE turns SET status='done',provider_input_acknowledged_at=CURRENT_TIMESTAMP WHERE id=?").run(grantTurn);
   const insertRequest=(id:string,targetInputId:string,effect:'work'|'informational')=>db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,
     source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(id,'fixture',`${id}-message`,grantorTurn,grantor.id,'root',`${id}-action`,requester.id,'fixture','root',
       JSON.stringify({requestedEffect:effect,text:`${effect} ${id}`,after:[]}),id,0,0,grantorInput.id,targetInputId,'admitted');
   insertRequest(grantId,grantInput.id,'work');
   const wakeId=`${prefix}-informational-wake`;
   const wakeInput=retainSessionInput({id:`${prefix}-wake-input`,sessionId:requester.id,scope:`communication:${grantorInput.id}`,actionId:'wake',kind:'request',origin:'agent',
     sourceInputId:grantorInput.id,sourceRunId:grantorRun,requestId:wakeId,payload:{text:'Ask an informational question.'}}).input;
   enqueueSessionInput(wakeInput.id);const wakeTurn=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(wakeInput.id) as any).turn_id);
   const wakeRun=nativeRunId(wakeTurn);db.query("UPDATE turns SET status='running',owner_instance_id='fixture-owner',provider_admission_intended_at=CURRENT_TIMESTAMP,provider_started_at=CURRENT_TIMESTAMP WHERE id=?").run(wakeTurn);
   insertRequest(wakeId,wakeInput.id,'informational');
   return {grantId,grantInput,wakeInput,wakeRun};
 };
 const makeNative=(threadId:string,rollout:string,start:()=>unknown,onObserve?:()=>void,onConnect?:()=>void)=>({
   custodySenderId:`fixture-owner-native-client-${threadId}`,nativeEndpoint:{socketPath:'/disposable',relayRunner:null,serverInfo:{fixture:true}},
   async connect(){onConnect?.();return 1},async notify(){},onNotification(){return ()=>true},onDisconnect(){return ()=>true},waitForDisconnect(){return new Promise<void>(()=>{})},
   async request(method:string){
     if(method==='thread/turns/list'){onObserve?.();const expected=(db.query(`SELECT turn.provider_turn_id FROM turns turn JOIN sessions session ON session.id=turn.session_id
       WHERE session.agent_session_uuid=? AND turn.provider_turn_id IS NOT NULL ORDER BY turn.id DESC LIMIT 1`).get(threadId) as any)?.provider_turn_id;
       return {data:[{id:expected??`empty-${threadId.slice(7)}`,status:'completed',error:null}],nextCursor:null};}
     if(method==='thread/items/list')return {data:[],nextCursor:null};
     if(method==='thread/read')return {thread:{id:threadId,status:{type:'idle'},path:rollout,modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace]}};
     if(method==='thread/queue/list'||method==='thread/backgroundTerminals/list')return {data:[],nextCursor:null};
     if(method==='thread/goal/get')return {goal:null};
     if(method==='thread/start')return start();throw new Error(`unexpected ${method}`);
   },async close(){},
 });
 const emptyRun={sourceThread:'',sourceFile:'',successorThread:'',canonicalInputId:'',requestId:'',expectedPrompt:'',spentAtSend:null as string|null,
   sends:0,finished:false,items:new Map<string,unknown[]>(),listeners:new Set<(event:any)=>void>()};
 const emptyNativeClient:CodexAppServerClientLike & {close():Promise<void>}={
   custodySenderId:'fixture-empty-native-client',nativeEndpoint:{socketPath:'/disposable',relayRunner:null,serverInfo:{fixture:true}},
   async connect(){return 1},async notify(){},onNotification(listener){emptyRun.listeners.add(listener);return ()=>emptyRun.listeners.delete(listener);},
   onDisconnect(){return ()=>true},waitForDisconnect(){return new Promise<void>(()=>{})},async close(){},
   async request(method:string,params:any){
     if(method==='thread/queue/list'||method==='thread/backgroundTerminals/list')return {data:[],nextCursor:null};
     if(method==='thread/goal/get')return {goal:null};
     if(method==='thread/turns/list'){
       if(params.threadId===emptyRun.sourceThread){
         const id=(db.query(`SELECT turn.provider_turn_id FROM turns turn JOIN sessions session ON session.id=turn.session_id
           WHERE session.agent_session_uuid=? AND turn.provider_turn_id IS NOT NULL ORDER BY turn.id DESC LIMIT 1`).get(emptyRun.sourceThread) as any)?.provider_turn_id;
         return {data:[{id,status:'completed',error:null,items:[]}],nextCursor:null};
       }
       if(params.threadId===emptyRun.successorThread)return {data:[...(emptyRun.sends?[{id:'empty-successor-turn',status:emptyRun.finished?'completed':'inProgress',error:null,
         items:emptyRun.items.get('empty-successor-turn')??[]}]:[]),...(emptyRun.items.has('followup-native-turn')?[{id:'followup-native-turn',status:'completed',error:null,
         items:emptyRun.items.get('followup-native-turn')??[]}]:[])],nextCursor:null};
       return {data:[],nextCursor:null};
     }
     if(method==='thread/items/list')return {data:(emptyRun.items.get(params.turnId)??[]).map(item=>({turnId:params.turnId,item})),nextCursor:null};
     if(method==='thread/read')return {thread:{id:params.threadId,status:{type:'idle'},path:emptyRun.sourceFile,modelProvider:'openai',model:'gpt-6-astra',
       reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace]}};
     if(method==='thread/start')return {thread:{id:emptyRun.successorThread,modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,
       runtimeWorkspaceRoots:[workspace],environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},model:'gpt-6-astra',modelProvider:'openai',
       reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
     if(method==='turn/start'){
       const isSelected=params.input?.[0]?.text===emptyRun.expectedPrompt;
       const id=isSelected?'empty-successor-turn':'followup-native-turn';
       if(isSelected){const row=custodySuccessor(emptyRun.canonicalInputId);assert.ok(row?.attempt_spent_at,'empty runner attempt spends canonical allowance before native send');
         emptyRun.spentAtSend=row.attempt_spent_at;emptyRun.sends++;emptyRun.items.set(id,[]);}
       else emptyRun.items.set(id,[{type:'userMessage',clientId:params.clientUserMessageId},{type:'agentMessage',id:'followup-answer',text:'The independent duty remains open and actionable.'}]);
       queueMicrotask(()=>{
         for(const listener of emptyRun.listeners)listener({method:'turn/started',params:{threadId:emptyRun.successorThread,turn:{id}}});
         queueMicrotask(()=>{emptyRun.finished=true;for(const listener of emptyRun.listeners)listener({method:'turn/completed',params:{threadId:emptyRun.successorThread,
           turn:{id,status:'completed',error:null,items:emptyRun.items.get(id)}}});});
       });
       return {turn:{id}};
     }
     throw new Error(`unexpected empty-route native request ${method}`);
   },
 };
 // Exercise selected Stop and later work through the real owner/host/client forward policy.
 // The child substitutes only stock-native responses; all owner identity and byte guards run.
 for(const terminalCase of ['stop','error'] as const){
 const lifecycleRequest=terminalCase+'-selected-real-bridge';
 const stoppedTarget=await makeTarget(lifecycleRequest);
 for(const suffix of ['one','two'])db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,
   source_session_id,source_root_ts,action_id,target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,
   source_input_id,target_input_id,status,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`)
   .run(lifecycleRequest+'-'+suffix,'fixture',lifecycleRequest+'-'+suffix,actorTurn,requester.id,'root',lifecycleRequest+'-'+suffix,
     stoppedTarget.target.id,'fixture','root',JSON.stringify({requestedEffect:'work',text:'Retained independent '+suffix,after:[]}),suffix,
     0,0,actorInput.id,stoppedTarget.report.id,'admitted');
 await registerLegacyPrefix(stoppedTarget.target.id,stoppedTarget.threadId,stoppedTarget.rollout,
   stoppedTarget.target.binding_generation,'empty-'+lifecycleRequest);
 const lifecycleBridge=join(scratch,terminalCase+'-lifecycle-bridge.ts'),lifecycleTrace=join(scratch,terminalCase+'-lifecycle-trace.jsonl');
 const effectsFile=join(scratch,terminalCase+'-lifecycle-effects.json');writeFileSync(effectsFile,'{}');
 writeFileSync(lifecycleBridge,`import {onJsonLines} from ${JSON.stringify(jsonLinesModule)};
 import {appendFileSync,readFileSync} from 'node:fs';
 const source=${JSON.stringify(stoppedTarget.threadId)},successor=${JSON.stringify(terminalCase+'-selected-successor')},path=${JSON.stringify(stoppedTarget.rollout)};
 let selectedClient='',interrupts=0;const turns=new Map();
 const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
 const notify=(method,params)=>send({type:'event',event:{method,params}});
 send({type:'ready'});
 onJsonLines(process.stdin,line=>{const call=JSON.parse(line);if(call.type==='close')process.exit(0);
 if(call.type!=='request')return;const p=call.params||{},effects=JSON.parse(readFileSync(${JSON.stringify(effectsFile)},'utf8'));
 appendFileSync(${JSON.stringify(lifecycleTrace)},JSON.stringify({method:call.method,params:p})+'\\n');
 let result;
 if(call.method==='thread/start')result={thread:{id:successor,modelProvider:'openai',model:p.model,reasoningEffort:'medium',cwd:p.cwd,
   runtimeWorkspaceRoots:p.runtimeWorkspaceRoots,environments:p.environments},model:p.model,modelProvider:'openai',reasoningEffort:'medium',
   cwd:p.cwd,runtimeWorkspaceRoots:p.runtimeWorkspaceRoots,approvalPolicy:p.approvalPolicy,sandbox:{type:'dangerFullAccess'}};
 else if(call.method==='thread/read')result={thread:{id:p.threadId,status:{type:'idle'},path,modelProvider:'openai',
   model:'gpt-6-astra',reasoningEffort:'medium',cwd:${JSON.stringify(workspace)},runtimeWorkspaceRoots:[${JSON.stringify(workspace)}]}};
 else if(call.method==='thread/queue/list')result={data:effects.queue||[],nextCursor:null};
 else if(call.method==='thread/backgroundTerminals/list')result={data:effects.terminals||[],nextCursor:null};
 else if(call.method==='thread/goal/get')result={goal:effects.goal||null};
 else if(call.method==='thread/turns/list'){
   if(effects.failed&&turns.has('selected-stop-native-turn'))Object.assign(turns.get('selected-stop-native-turn'),{status:'failed',error:{message:'Confirmed selected fixture failure'}});
   result={data:p.threadId===source?[{id:${JSON.stringify('empty-'+lifecycleRequest)},status:'completed',items:[]}]:[...turns.values()],nextCursor:null};
 }
 else if(call.method==='thread/items/list')result={data:(turns.get(p.turnId)?.items||[]).map(item=>({turnId:p.turnId,item})),nextCursor:null};
 else if(call.method==='turn/start'){
   const selected=!selectedClient,id=selected?'selected-stop-native-turn':'later-native-turn';if(selected)selectedClient=p.clientUserMessageId;
   const items=[{type:'userMessage',clientId:p.clientUserMessageId}];
   if(!selected)items.push({type:'agentMessage',id:'later-answer',text:'Distinct work completed after exact selected Stop.'});
   turns.set(id,{id,status:selected?'inProgress':'completed',items});result={turn:{id}};
   send({type:'response',id:call.id,result});notify('turn/started',{threadId:successor,turn:{id}});
   notify('item/completed',{threadId:successor,turnId:id,item:items[0]});
   if(!selected)notify('turn/completed',{threadId:successor,turn:turns.get(id)});return;
 }else if(call.method==='turn/interrupt'){
   interrupts++;result={};
   // First RPC success alone proves nothing. Only the reconciliation-loop interrupt stops it.
   if(interrupts>1){const t=turns.get(p.turnId);t.status='interrupted';notify('turn/completed',{threadId:successor,turn:t});}
 }else throw new Error('Unexpected lifecycle native call '+call.method);
 send({type:'response',id:call.id,result});});`);
 const lifecycleNative=new CodexAppServerClient('/disposable',process.execPath,{bridgePath:lifecycleBridge,manageDaemon:false,shutdownGraceMs:50});
 newCustodyClient=lifecycleNative;
 const stoppedRecovery=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},
   action_id:terminalCase+'-recover-selected-lifecycle',request_id:lifecycleRequest,custody_successor:true});
 const selectedStopClaim=claimNextQueuedTurn('fixture-owner');assert.ok(selectedStopClaim);
 assert.equal(selectedStopClaim.turn_id,stoppedRecovery.placement_turn_id);
 const selectedStopRun=host.run(selectedStopClaim);
 const waitUntil=async(check:()=>boolean)=>{const deadline=Date.now()+10_000;while(!check()){
   if(Date.now()>deadline)throw new Error('Lifecycle fixture did not reach its exact state');await Bun.sleep(1);
 }};
 await waitUntil(()=>custodySuccessor(stoppedTarget.report.id)?.state==='acknowledged');
 const selectedSpent=custodySuccessor(stoppedTarget.report.id)!.attempt_spent_at;
 host.owner.action(`concierge:${stoppedRecovery.successor_session_id}`,{clientActionId:terminalCase+'-pause-real-selected-stop',action:{kind:'pause'}});
 if(terminalCase==='stop')await host.owner.stop(`concierge:${stoppedRecovery.successor_session_id}`,{clientActionId:'stop-real-selected',runId:nativeRunId(selectedStopClaim.turn_id)});
 else writeFileSync(effectsFile,JSON.stringify({failed:true}));
 assert.equal((await selectedStopRun).status,terminalCase==='stop'?'cancelled':'error','real native terminal outcome reaches owner settlement');
 writeFileSync(effectsFile,'{}');
 const stopTrace=readFileSync(lifecycleTrace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(stopTrace.filter(call=>call.method==='turn/interrupt').length,terminalCase==='stop'?2:0,
   'direct Stop and same-generation reconciliation-loop Stop both cross the installed forwarding policy');
 assert.equal(sessionMetadata(getSessionById(stoppedRecovery.successor_session_id)!).suspended,true,'terminal outcome preserves explicit Pause');
 host.owner.action(`concierge:${stoppedRecovery.successor_session_id}`,{clientActionId:terminalCase+'-continue-real-selected-stop',action:{kind:'continue'}});
 for(const dutyId of [lifecycleRequest,lifecycleRequest+'-one',lifecycleRequest+'-two']){
   await (coordinator as any).dispatch(db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(dutyId));
   assert.equal(db.query('SELECT outcome FROM session_communication_requests WHERE request_id=?').get(dutyId).outcome,null);
 }
 assert.ok(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`custody-attempt-failed:${stoppedTarget.report.id}:${selectedStopClaim.turn_id}`),
   'the actual communication terminal branch must run before later work is accepted');
 assert.equal(custodySuccessor(stoppedTarget.report.id)?.state,'acknowledged','confirmed selected Stop preserves successor binding availability');
 const laterInput=retainSessionInput({id:terminalCase+'-after-real-selected-stop',sessionId:stoppedRecovery.successor_session_id,scope:'fixture',actionId:terminalCase+'-after-real-stop',
   kind:'input',origin:'human',payload:{text:'Perform distinct work for the retained writing duty.'}}).input;
 enqueueSessionInput(laterInput.id);
 const laterClaim=claimNextQueuedTurn('fixture-owner');assert.ok(laterClaim);assert.equal(laterClaim.accepted_input_id,laterInput.id);
 assert.equal((await host.run(laterClaim)).status,'delivered','later work runs after reconciliation through actual protected native turn/start');
 assert.ok(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`custody-terminal-effects:${laterClaim.turn_id}:${laterClaim.dispatch_attempt}`),
   'later admission obtains fresh native/background/process effect reconciliation');
 assert.equal(custodySuccessor(stoppedTarget.report.id)!.attempt_spent_at,selectedSpent,'later work never replenishes the canonical allowance');
 const lifecycleCalls=readFileSync(lifecycleTrace,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(lifecycleCalls.filter(call=>call.method==='turn/start').length,2,'one selected send and one distinct followup, without replay');
 assert.equal(lifecycleCalls.some(call=>['thread/resume','thread/fork'].includes(call.method)),false);
 const laterResult=JSON.parse((db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(`result:${laterClaim.turn_id}`) as any).payload_json);
 assert.match(laterResult.text,/Distinct work completed after exact selected Stop/);
 // Known terminal is not an assertion that background effects vanished. A later admission
 // is held before byte forwarding if a fresh native queue observation is nonempty.
 writeFileSync(effectsFile,JSON.stringify({queue:[{id:'retained-native-queue',input:[],clientUserMessageId:'unresolved-queued-input'}]}));
 const heldInput=retainSessionInput({id:terminalCase+'-after-stop-with-effects',sessionId:stoppedRecovery.successor_session_id,scope:'fixture',actionId:terminalCase+'-after-stop-effects',
   kind:'input',origin:'human',payload:{text:'This must stay held behind unresolved effects.'}}).input;enqueueSessionInput(heldInput.id);
 const heldClaim=claimNextQueuedTurn('fixture-owner');assert.ok(heldClaim);assert.equal(heldClaim.accepted_input_id,heldInput.id);
 assert.notEqual((await host.run(heldClaim)).status,'delivered');
 assert.equal(readFileSync(lifecycleTrace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(call=>call.method==='turn/start').length,2,
   'unresolved effects cannot produce a third native turn/start');
 newCustodyClient=nativeClient;
 }

 const borrowed=await makeBorrowedAuthority('borrowed-authority-positive');
 const borrowedAction='borrowed-authority-reentry';
 const borrowedResult=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:borrowed.wakeInput.id,run_id:borrowed.wakeRun},
   action_id:borrowedAction,request_id:requestId,custody_successor:true});
 assert.equal(borrowedResult.handoff_id,custody.handoff_id,'an informational wake borrows the existing live work grant for the same canonical operation');
 const borrowedEventId=`custody-recovery-action:${createHash('sha256').update(JSON.stringify([borrowed.wakeInput.id,borrowedAction])).digest('hex')}`;
 const borrowedEvent=db.query('SELECT input_id,payload_json FROM session_owner_events WHERE event_id=?').get(borrowedEventId) as any;
 const borrowedPayload=JSON.parse(borrowedEvent.payload_json);
 assert.equal(borrowedEvent.input_id,borrowed.wakeInput.id,'action provenance retains the actual informational wake as actor source');
 assert.equal(borrowedPayload.authorityInputId,borrowed.grantInput.id,'borrowed work is attributed to the distinct retained grant input');
 assert.equal(borrowedPayload.sourceRunId,borrowed.wakeRun);
 db.query("UPDATE session_communication_requests SET outcome='answered',status='answered' WHERE request_id=?").run(borrowed.grantId);

 const collisionTarget=await makeTarget('different-canonical-action');
 const callsBeforeCollision=nativeCalls.length;
 await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},
   action_id:'recover-writing-once',request_id:collisionTarget.report.request_id!,custody_successor:true}),/another recovery operation or authority basis|different handoff kind or target/,
   'one accepted source/action cannot be repurposed for a different canonical reminder');
 await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},
   action_id:'recover-writing-once',request_id:requestId,custody_successor:false}),/custody-successor recovery/,
   'the legacy non-successor entrance cannot reinterpret an accepted custody action');
 retainSessionInput({id:'legacy-action-conflict',sessionId:requester.id,scope:`communication:${actorInput.id}`,actionId:'preexisting-other-operation',
   kind:'action',origin:'agent',sourceInputId:actorInput.id,sourceRunId:actorRun,payload:{kind:'unrelated-operation'}});
 await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},
   action_id:'preexisting-other-operation',request_id:requestId,custody_successor:false}),/different operation/,
   'a preexisting communication action cannot be overwritten by legacy recovery');
 assert.equal(nativeCalls.length,callsBeforeCollision,'action collision is refused before another native read or construction');
 const allowanceBeforeFreshAction=custodySuccessor(reminder.id)!;
 const sameCanonical=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},
   action_id:'fresh-action-same-canonical',request_id:requestId,custody_successor:true});
 assert.equal(sameCanonical.handoff_id,custody.handoff_id,'a new action on the same canonical reminder returns the retained operation');
 assert.equal(custodySuccessor(reminder.id)?.attempt_spent_at,allowanceBeforeFreshAction.attempt_spent_at,'a fresh action cannot reset the one shared allowance');
 assert.equal(nativeCalls.filter(call=>call==='thread/start').length,1,'canonical re-entry cannot construct another native thread');

 const authorityRace=await makeTarget('authority-race');const changingGrant=await makeBorrowedAuthority('authority-race-source');
 let raceStarts=0;const raceNative=makeNative(authorityRace.threadId,authorityRace.rollout,()=>{raceStarts++;return {};});
 grantToCloseDuringLab=changingGrant.grantId;
 newCustodyClient=raceNative;
 await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:changingGrant.wakeInput.id,run_id:changingGrant.wakeRun},
   action_id:'authority-changes-during-stage',request_id:'authority-race',custody_successor:true}),/lost its exact live work authority/,
   'the exact grant is re-resolved after asynchronous Lab staging before custody commitment');
 assert.equal((db.query('SELECT outcome FROM session_communication_requests WHERE request_id=?').get(changingGrant.grantId) as any).outcome,'answered',
   'the fake Lab read changes the effective work grant during staging');
 assert.equal(custodySuccessor(authorityRace.report.id),null,'stale authority creates no canonical custody relation');
 const heldStage=db.query('SELECT state,successor_session_id FROM session_handoffs WHERE requesting_input_id=? AND action_id=?')
   .get(changingGrant.wakeInput.id,'authority-changes-during-stage') as any;
 assert.equal(heldStage.state,'proposed','authority loss leaves only passive proposed staging, never committed custody');
 assert.equal((db.query('SELECT agent_session_uuid FROM sessions WHERE id=?').get(heldStage.successor_session_id) as any).agent_session_uuid,null,
   'authority loss before custody commitment cannot construct a native successor');
 assert.equal(raceStarts,0);
 newCustodyClient=nativeClient;

 // The original repair source can end after the real handoff transaction commits custody but
 // before construction intent. A different live work-authorized session must resume that exact
 // canonical operation with a fresh connection witness, without minting another allowance.
 const lateRetryTarget=await makeTarget('custody-retry-after-source-ended');
 const oldSenderIndex=managedLegacySenders.length;
 await registerLegacyPrefix(lateRetryTarget.target.id,lateRetryTarget.threadId,lateRetryTarget.rollout,
   lateRetryTarget.target.binding_generation,'empty-custody-retry-after-source-ended');
 const exactOldSender=managedLegacySenders[oldSenderIndex]!;
 const endedRepairer=await makeLiveHumanRepairer('ended-repairer');
 const replacementRepairer=await makeLiveHumanRepairer('replacement-repairer');
 const firstLateAction='source-ends-after-custody-commit';
 db.exec(`CREATE TRIGGER fixture_end_repairer_after_custody_commit AFTER UPDATE OF state ON session_handoffs
   WHEN NEW.requesting_input_id='${endedRepairer.input.id}' AND NEW.action_id='${firstLateAction}' AND NEW.state='accepted'
   BEGIN
     UPDATE turns SET status='done',owner_instance_id=NULL,ended_at=CURRENT_TIMESTAMP WHERE id=${endedRepairer.turnId};
     UPDATE sessions SET status='idle' WHERE id=${endedRepairer.session.id};
   END`);
 let lateInitialStarts=0;
 newCustodyClient=makeNative(lateRetryTarget.threadId,lateRetryTarget.rollout,()=>{lateInitialStarts++;return {};});
 await assert.rejects(()=>coordinator.recoverCodexNeverAcknowledged({source:{input_id:endedRepairer.input.id,run_id:endedRepairer.runId},
   action_id:firstLateAction,request_id:'custody-retry-after-source-ended',custody_successor:true}),
   /lost its exact live work authority|Source must identify this admitted input and its exact live run/,
   'the original agent ends at the custody-commit boundary before construction intent');
 db.exec('DROP TRIGGER fixture_end_repairer_after_custody_commit');
 const committedWithoutConstruction=custodySuccessor(lateRetryTarget.report.id)!;
 assert.equal(committedWithoutConstruction.state,'custody');
 assert.equal(committedWithoutConstruction.construction_intended_at,null);
 assert.equal(committedWithoutConstruction.native_thread_id,null);
 assert.equal(committedWithoutConstruction.attempt_spent_at,null);
 assert.equal(lateInitialStarts,0,
   'losing the original repair source never reaches native construction');
 let retryStarts=0;
 const retryClient=makeNative(lateRetryTarget.threadId,lateRetryTarget.rollout,()=>{retryStarts++;return {thread:{id:'recovered-after-custody-commit',
   modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],
   environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},model:'gpt-6-astra',modelProvider:'openai',
   reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};});
 newCustodyClient=retryClient;
 const recoveredWithoutNewBudget=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:replacementRepairer.input.id,run_id:replacementRepairer.runId},
   action_id:'new-agent-resumes-committed-custody',request_id:'custody-retry-after-source-ended',custody_successor:true});
 newCustodyClient=nativeClient;
 assert.equal(recoveredWithoutNewBudget.state,'constructed');assert.equal(retryStarts,1);
 host.owner.action(`concierge:${recoveredWithoutNewBudget.successor_session_id}`,{clientActionId:'hold-after-repairer-retry',action:{kind:'pause'}});
 const afterRepairerRetry=custodySuccessor(lateRetryTarget.report.id)!;
 assert.equal(afterRepairerRetry.handoff_id,committedWithoutConstruction.handoff_id,'the new agent resumes the same accepted handoff');
 assert.equal(afterRepairerRetry.successor_session_id,committedWithoutConstruction.successor_session_id,'custody owner identity is stable');
 assert.equal(afterRepairerRetry.attempt_spent_at,null,'custody recovery does not spend or reset the selected provider allowance');
 const retrySnapshot=JSON.parse(afterRepairerRetry.snapshot_json),retainedBarrier=retrySnapshot.cutoff.barriers.find((row:any)=>row.senderId===exactOldSender.custodySenderId);
 assert.equal(retainedBarrier?.generation,exactOldSender.activeGeneration,
   'retry re-establishes the still-active original legacy sender generation barrier');
 const retryPlan=JSON.parse(afterRepairerRetry.plan_json);
 assert.notEqual(retryPlan.nativeConnection.clientId,JSON.parse(committedWithoutConstruction.plan_json).nativeConnection.clientId,
   'the retry pins its distinct newly-created native connection client identity');
 assert.equal(retryPlan.nativeConnection.endpoint.socketPath,'/disposable','retry persists its fresh construction-client endpoint witness');
 assert.equal(retryPlan.nativeConnection.generation,1,'retry persists the replacement client generation before construction');
 assert.equal(db.query('SELECT COUNT(*) AS n FROM codex_custody_successors WHERE canonical_input_id=?').get(lateRetryTarget.report.id).n,1,
   'retry preserves one canonical recovery row');
 assert.equal(db.query('SELECT COUNT(*) AS n FROM codex_unacknowledged_recoveries WHERE accepted_input_id=?').get(lateRetryTarget.report.id).n,0,
   'no duplicate legacy recovery attempt is created');
 assert.equal(lateInitialStarts,0,'the ended source never sent a construction request');
 newCustodyClient=nativeClient;

 // Pause can arrive after passive handoff staging but before the canonical custody relation
 // exists. The proposed recovery handoff itself must therefore carry the Pause marker forward.
 const preRelationTarget=await makeTarget('pause-before-custody-relation');let pauseRecorded=false;
 await registerLegacyPrefix(preRelationTarget.target.id,preRelationTarget.threadId,preRelationTarget.rollout,
   preRelationTarget.target.binding_generation,'empty-pause-before-custody-relation');
 const preRelationAction='pause-before-custody-relation';
 const preRelationClient=makeNative(preRelationTarget.threadId,preRelationTarget.rollout,()=>({thread:{id:'pause-before-relation-native-thread',
   modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],
   environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},model:'gpt-6-astra',modelProvider:'openai',
   reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}}),undefined,()=>{
   const staged=db.query("SELECT successor_session_id FROM session_handoffs WHERE action_id=? AND handoff_kind='codex-custody-successor' AND state='proposed'")
     .get(preRelationAction) as {successor_session_id:number}|null;
   if(staged&&!pauseRecorded&&!db.query('SELECT 1 FROM codex_custody_successors WHERE successor_session_id=?').get(staged.successor_session_id)){
     host.owner.action(`concierge:${staged.successor_session_id}`,{clientActionId:'pause-before-relation',action:{kind:'pause'}});pauseRecorded=true;
   }
 });
 newCustodyClient=preRelationClient;
 const pausedBeforeRelation=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},action_id:preRelationAction,
   request_id:'pause-before-custody-relation',custody_successor:true});
 newCustodyClient=nativeClient;
 assert.equal(pausedBeforeRelation.state,'constructed');assert.equal(pauseRecorded,true,'the fixture pauses in the staged-handoff/pre-relation window');
 const pausedPreRelationSession=getSessionById(pausedBeforeRelation.successor_session_id)!;
 assert.equal(sessionMetadata(pausedPreRelationSession).custodyUserPaused,true,'pre-relation Pause is durably retained through custody relation creation');
 assert.equal(sessionMetadata(pausedPreRelationSession).suspended,true,'construction cannot clear a Pause issued before the custody row existed');
 assert.equal(claimNextQueuedTurn('fixture-owner'),null,'the paused pre-relation placement stays unadmitted');
 host.owner.action(`concierge:${pausedPreRelationSession.id}`,{clientActionId:'continue-after-pre-relation-pause',action:{kind:'continue'}});
 assert.equal(sessionMetadata(getSessionById(pausedPreRelationSession.id)!).suspended,false,'Continue releases the held constructed successor');
 host.owner.action(`concierge:${pausedPreRelationSession.id}`,{clientActionId:'re-pause-after-pre-relation-proof',action:{kind:'pause'}});
 assert.equal(claimNextQueuedTurn('fixture-owner'),null,'the fixture re-pauses its independent staged placement so later checks cannot admit it');

 // Full failure chain: the protected Codex runner sends the consumed allowance once, receives
 // terminal completion with no input acknowledgement and no output, and the real host persists
 // CODEX_INPUT_NOT_ACKNOWLEDGED before communication reconciliation keeps every duty open.
 const emptyTarget=await makeTarget('runner-empty-attempt');
 await registerLegacyPrefix(emptyTarget.target.id,emptyTarget.threadId,emptyTarget.rollout,emptyTarget.target.binding_generation,
   'empty-runner-empty-attempt');
 for(const [dutyId,suffix] of [['runner-empty-sibling-one','one'],['runner-empty-sibling-two','two']] as const){
   db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
     target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,status,outcome)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(dutyId,'fixture',dutyId,actorTurn,requester.id,'root',dutyId,emptyTarget.target.id,'fixture','root',
       JSON.stringify({requestedEffect:'work',text:`Independent runner-empty ${suffix} duty`,after:[]}),dutyId,0,0,actorInput.id,emptyTarget.report.id,'admitted');
 }
 emptyRun.sourceThread=emptyTarget.threadId;emptyRun.sourceFile=emptyTarget.rollout;emptyRun.successorThread='runner-empty-successor-thread';
 emptyRun.canonicalInputId=emptyTarget.report.id;emptyRun.requestId='runner-empty-attempt';emptyRun.expectedPrompt='Continue runner-empty-attempt exactly.';
 newCustodyClient=emptyNativeClient;
 const emptyRecovery=await coordinator.recoverCodexNeverAcknowledged({source:{input_id:actorInput.id,run_id:actorRun},action_id:'recover-empty-runner-attempt',
   request_id:emptyRun.requestId,custody_successor:true});
 assert.equal(emptyRecovery.state,'constructed');assert.equal(emptyRun.sends,0,'construction does not spend/send the selected native attempt');
 const emptyClaim=claimNextQueuedTurn('fixture-owner');assert.ok(emptyClaim);assert.equal(emptyClaim.session_id,emptyRecovery.successor_session_id);
 const failedHostRun=host.run(emptyClaim);
 while(emptyRun.sends===0)await new Promise(resolve=>setTimeout(resolve,1));
 const failedOutcome=await failedHostRun;
 assert.equal(failedOutcome.status,'error','host settles terminal native refusal through its normal error outcome path');
 assert.equal(emptyRun.sends,1,'the one shared allowance produces exactly one native turn/start');
 assert.ok(emptyRun.spentAtSend,'the fake native server observes durable canonical allowance before send');
 const emptyRelation=custodySuccessor(emptyTarget.report.id)!;
 assert.equal(emptyRelation.native_turn_id,'empty-successor-turn');assert.equal(emptyRelation.attempt_spent_at,emptyRun.spentAtSend);
 const persistedEmpty=db.query('SELECT status,agent_text,provider_turn_id,provider_input_acknowledged_at FROM turns WHERE id=?').get(emptyClaim.turn_id) as any;
 assert.equal(persistedEmpty.status,'error','the host persists the actual runner failure as a terminal error');
 assert.match(persistedEmpty.agent_text,/CODEX_INPUT_NOT_ACKNOWLEDGED/);
 assert.equal(persistedEmpty.provider_turn_id,'empty-successor-turn');assert.equal(persistedEmpty.provider_input_acknowledged_at,null);
 for(const dutyId of [emptyRun.requestId,'runner-empty-sibling-one','runner-empty-sibling-two']){
   const duty=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(dutyId) as any;
   await (coordinator as any).dispatch(duty);
   assert.equal((db.query('SELECT outcome FROM session_communication_requests WHERE request_id=?').get(dutyId) as any).outcome,null,
     `real runner-to-owner failure leaves ${dutyId} open for its own disposition`);
 }
 assert.equal(custodySuccessor(emptyTarget.report.id)?.state,'held','coordinator stores the real runner failure on canonical custody');
 host.owner.action(`concierge:${emptyRecovery.successor_session_id}`,{clientActionId:'continue-unacknowledged-selected',action:{kind:'continue'}});
 assert.equal(sessionMetadata(getSessionById(emptyRecovery.successor_session_id)!).suspended,true,'Continue cannot release unacknowledged selected failure');
 assert.equal(emptyRun.sends,1,'uncertain/unacknowledged failure cannot replenish the native allowance');
 newCustodyClient=nativeClient;

 // A lost thread/start response is retained as uncertain. Re-entry returns that held operation
 // without asking the native service to construct another thread.
 const lost=await makeTarget('lost-construction');let lostStarts=0;
 await registerLegacyPrefix(lost.target.id,lost.threadId,lost.rollout,lost.target.binding_generation,'empty-lost-construction');
 const lostNative=makeNative(lost.threadId,lost.rollout,()=>{lostStarts++;throw new Error('native construction response lost');});
 const lostRequest={actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,requestId:'lost-construction',actionId:'lost-one',validateSource:()=>{}};
 await assert.rejects(()=>recoverCustodySuccessor(lostRequest,lostNative),/response lost/);
 assert.equal(custodySuccessor(lost.report.id)?.state,'held');
 const lostRetry=await recoverCustodySuccessor({...lostRequest,actionId:'lost-two'},lostNative);
 assert.equal(lostRetry.state,'held');assert.equal(lostStarts,1,'uncertain native construction cannot be repeated');

 // A known native thread whose effective effort conflicts with the owner plan stays held,
 // retains that native identity for reconciliation, and never releases its queued placement.
 const mismatch=await makeTarget('wrong-settings');let mismatchStarts=0;
 await registerLegacyPrefix(mismatch.target.id,mismatch.threadId,mismatch.rollout,mismatch.target.binding_generation,'empty-wrong-settings');
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

 // The native identity is durably retained before postconstruction source verification can fail.
 const replaced=await makeTarget('source-replaced-during-construction');let replacedStarts=0;
 await registerLegacyPrefix(replaced.target.id,replaced.threadId,replaced.rollout,replaced.target.binding_generation,
   'empty-source-replaced-during-construction');
 const replacedNative=makeNative(replaced.threadId,replaced.rollout,()=>{
   replacedStarts++;writeFileSync(replaced.rollout,'source changed after native construction returned');
   return {thread:{id:'native-source-replaced',modelProvider:'openai',model:'gpt-6-astra',reasoningEffort:'medium',cwd:workspace,
     runtimeWorkspaceRoots:[workspace],environments:[{environmentId:'local',cwd:workspace,runtimeWorkspaceRoots:[workspace]}]},
     model:'gpt-6-astra',modelProvider:'openai',reasoningEffort:'medium',cwd:workspace,runtimeWorkspaceRoots:[workspace],
     approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
 });
 const replacedRequest={actorSession:requester.id,sourceInputId:actorInput.id,sourceRunId:actorRun,
   requestId:'source-replaced-during-construction',actionId:'source-replaced',validateSource:()=>{}};
 await assert.rejects(()=>recoverCustodySuccessor(replacedRequest,replacedNative),/Original source changed during successor preparation/);
 const retainedConstruction=custodySuccessor(replaced.report.id)!;
 assert.equal(retainedConstruction.state,'held');
 assert.equal(retainedConstruction.native_thread_id,'native-source-replaced','ordinary postconstruction verification failure retains received native identity');
 assert.equal(JSON.parse(retainedConstruction.construction_json!).threadId,'native-source-replaced','full effective construction response survives the later failure');
 assert.equal((db.query('SELECT agent_session_uuid FROM sessions WHERE id=?').get(retainedConstruction.successor_session_id) as any).agent_session_uuid,null,
   'held construction identity is not prematurely bound for admission');
 assert.equal(replacedStarts,1);

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
} finally {await stopHost?.();await Promise.all(managedLegacySenders.map(sender=>sender.close({immediate:true})));lab.stop();db.close();rmSync(scratch,{recursive:true,force:true});}
