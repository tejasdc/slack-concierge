import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runFixtureChild} from './fixture-child';
import {LAB_CONVERSATIONS_TEST_AUTHORIZATION} from '../src/test-authorizations';

async function child(){
 const [{SessionOwner},{LabConversations},inputs,state,{parseRouterSessionsArgs,runRouterSessions},{resendIsSafe},{classifyNativeReadRoute,assertNativeReadRouteCoverage}]=await Promise.all([
  import('../src/session-owner'),import('../src/lab-conversations'),import('../src/session-inputs'),import('../src/state'),import('./router-sessions'),import('./router-request-client'),import('../src/native-read-routes')]);
 const root=process.env.CONCIERGE_STATE_DIR!;
 const make=(title:string)=>inputs.createNativeSession('codex',{summary:undefined,title,purpose:'chat',cwd:root,model:'gpt-6-luna',reasoningEffort:'low',origin:'native'});
 const coordinator=make('coordinator'),first=make('first'),second=make('second');
 const owner=new SessionOwner({available:()=>true,wake(){},steer:()=>false,stop:async()=>false},root);
 const lab=new LabConversations({bootstrap:async()=>({version:1,state:{owner:`concierge:${coordinator.id}`},entries:[{id:'question',text:'original'}]}),
  prepare:async(choice:any)=>choice.sessionId?{choice,sessionId:Number(choice.sessionId.slice(10))}:{choice,provider:'codex',metadata:{summary:undefined,title:choice.label,purpose:'chat',cwd:root,model:choice.model,reasoningEffort:choice.reasoningEffort,origin:'native'}},
  sources:async()=>[],bind:async(thread,membershipRevision)=>({version:1,thread,membershipRevision,bound:true}),context:async()=>{throw new Error('Unexpected provider context');},publish:async()=>{throw new Error('Unexpected publication');},dispatch:input=>owner.dispatch(input),wake(){}});
 (owner as any).labCoordinator=lab;
 await lab.create({clientActionId:'opening',thread:'fixture',questionEntryId:'question',participants:[{key:'first',label:'First',sessionId:`concierge:${first.id}`},{key:'second',label:'Second',sessionId:`concierge:${second.id}`}]});
 const source=inputs.retainSessionInput({sessionId:coordinator.id,scope:'fixture',actionId:'human-task',kind:'input',origin:'human',payload:{text:'Use the specified voice.'}}).input;
 inputs.enqueueSessionInput(source.id);const claim=state.claimNextQueuedTurn('membership-fixture')!;
 assert.equal(claim.session_id,coordinator.id);assert.ok(state.markTurnProviderAdmissionIntended(claim.turn_id,'membership-fixture',claim.dispatch_attempt));
 const runId=inputs.nativeRunId(claim.turn_id),spec={add:[{key:'new',label:'New voice',provider:'codex',model:'gpt-6-luna',reasoningEffort:'low',project:'exact-project',instructions:'First line.\nSecond line.'}],remove:[`concierge:${first.id}`]};
 const file=join(root,'roster.json');await writeFile(file,JSON.stringify(spec));
 const parsed=parseRouterSessionsArgs(['board','participants','--thread','lab:fixture','--revision','1','--json-file',file,'--source-input',source.id,'--source-run',runId,'--action-id','swap']);
 assert.equal(parsed.operation,'lab-participants');if(parsed.operation!=='lab-participants')throw new Error('Unexpected operation');
 assert.deepEqual(parsed.body.add,spec.add);assert.deepEqual(parsed.body.remove,spec.remove);assert.equal(parsed.body.revision,1);
 assert.deepEqual(parseRouterSessionsArgs(['board','roster','--thread','fixture']),{operation:'lab-roster',body:{thread:'fixture'}});
 assert.deepEqual(parseRouterSessionsArgs(['board','participant-change','--thread','fixture','--action-id','swap']),{operation:'lab-participant-change',body:{thread:'fixture',action_id:'swap'}});
 assert.throws(()=>parseRouterSessionsArgs(['board','participants','--thread','fixture','--revision','1','--json-file',file,'--source-input',source.id,'--action-id','swap']));
 const body={clientActionId:parsed.body.action_id,expectedRevision:parsed.body.revision,add:parsed.body.add,remove:parsed.body.remove,agentSource:{inputId:source.id,runId}};
 const path='/sessions/v1/lab/conversations/fixture/participants';assert.equal(resendIsSafe(path,body),true);assert.equal(resendIsSafe(path,{...body,agentSource:undefined}),false);
 const send=(value:any,principal=`run:${coordinator.id}:${claim.turn_id}`)=>owner.handle(new Request(`http://owner${path}`,{method:'POST',headers:{'content-type':'application/json','x-concierge-agent-principal':principal},body:JSON.stringify(value)}));
 assert.equal((await send(body,`run:${coordinator.id}:${claim.turn_id+1}`))?.status,403);
 const socket=Bun.serve({unix:join(root,'requests.sock'),fetch:async request=>(await owner.handle(request))??new Response(null,{status:404})});
 let view:any;
 try{const response=await runRouterSessions(parsed);assert.equal(response.ok,true);view=response.result;
  const roster=await runRouterSessions(parseRouterSessionsArgs(['board','roster','--thread','fixture']));assert.equal(roster.ok,true);assert.equal((roster.result as any).membershipRevision,2);
 assert.equal(view.change.revision,2);assert.equal(view.change.add.length,1);assert.deepEqual(view.change.remove,spec.remove);
 assert.equal(view.participants.find((p:any)=>p.key==='new').model,'gpt-6-luna');assert.equal(view.participants.find((p:any)=>p.key==='new').reasoningEffort,'low');
 const duplicate:any=await (await send(body))!.json();assert.equal(duplicate.change.inputId,view.change.inputId);assert.equal(duplicate.change.duplicate,true);
 assert.equal((await send({...body,remove:[`concierge:${second.id}`]}))?.status,409);
 assert.equal((await send({...body,clientActionId:'stale'}))?.status,409);
 state.finishTurn(claim.turn_id,'done','');
 assert.equal((await send(body))?.status,403,'ended source cannot replay its mutation');
 const readPath='/sessions/v1/lab/conversations/fixture/participant-changes/swap';
 const read=await owner.handle(new Request(`http://owner${readPath}`));assert.equal(read?.status,200);
 assert.deepEqual(await read!.json(),{version:1,thread:'fixture',clientActionId:'swap',inputId:view.change.inputId,membershipRevision:2,add:view.change.add,remove:spec.remove});
 const viaCommand=await runRouterSessions(parseRouterSessionsArgs(['board','participant-change','--thread','fixture','--action-id','swap']));assert.equal(viaCommand.ok,true);assert.deepEqual(viaCommand.result,{version:1,thread:'fixture',clientActionId:'swap',inputId:view.change.inputId,membershipRevision:2,add:view.change.add,remove:spec.remove});
 const unknown=await runRouterSessions(parseRouterSessionsArgs(['board','participant-change','--thread','fixture','--action-id','unknown']));assert.equal(unknown.ok,false);assert.equal(unknown.status,404);
 assert.equal((await owner.handle(new Request('http://owner/sessions/v1/lab/conversations/fixture/participant-changes/unknown')))?.status,404);
 assert.equal((await owner.handle(new Request('http://owner/sessions/v1/lab/conversations/other/participant-changes/swap')))?.status,404);
 assertNativeReadRouteCoverage();assert.equal(classifyNativeReadRoute('GET',readPath)?.source,'canonical');
 }finally{await socket.stop(true);}
 console.log(JSON.stringify({fixture:'lab-agent-membership-command',sourcePrincipal:true,casAndRetry:true,exactPostRunRecovery:true,metadataOnly:true,selectedFields:true}));
}
if(process.argv.includes('--child'))await child();
else {const root=await mkdtemp(join(tmpdir(),'concierge-lab-agent-roster-'));try{console.log(JSON.stringify(await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],env:{...process.env,CONCIERGE_STATE_DIR:root,CONCIERGE_STATE_DB:join(root,'state.db'),CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),CONCIERGE_OWNER_URL:'',CONCIERGE_AGENT_TOKEN:'',CONCIERGE_RUNNER_STATE:'',CONCIERGE_PRIVATE_CODE_STATE:'',CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LAB_CONVERSATIONS_TEST_AUTHORIZATION,CONCIERGE_EXECUTION_HOSTS:'0',THINKERING_SESSION_CAPABILITY_SOCKET:join(root,'absent.sock'),CONCIERGE_THINKERING_CAPABILITY_URL:'',CONCIERGE_THINKERING_TOKEN_FILE:''},deadlineMs:60_000,fixture:'lab-agent-membership-command'})));}finally{await rm(root,{recursive:true,force:true});}}
