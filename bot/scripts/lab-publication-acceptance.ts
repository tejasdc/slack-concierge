/** Incident85ee7a4e only. Two real scratch owners; no provider runs or production data.
 * This proves canonical admission/HTTP/projection, not browser or physical-Mac behavior. */
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {LAB_PUBLICATION_TEST_AUTHORIZATION} from '../src/test-authorizations';

const fixture='lab-publication-85ee7a4e';
if(process.argv.includes('--owner')){
 const self=process.argv[process.argv.indexOf('--owner')+1]!;
 assert.equal(process.env.CONCIERGE_TEST_AUTHORIZATION,LAB_PUBLICATION_TEST_AUTHORIZATION);
 assert.equal(process.env.CONCIERGE_TEST_MODE,'1');
 process.env.CONCIERGE_PEER_NAME=self;
 process.env.THINKERING_SESSION_CAPABILITY_SOCKET=join(process.env.CONCIERGE_STATE_DIR!,'no-thinkering.sock');
 process.env.THINKERING_ORIGIN_URL='http://127.0.0.1:1';
 for(const key of ['CONCIERGE_THINKERING_CAPABILITY_URL','CONCIERGE_THINKERING_TOKEN_FILE','THINKERING_CAPABILITY_URL'])delete process.env[key];
 const [state,inputs,{SessionOwner},{SessionCommunicationCoordinator},{SessionPeers,PeerClient},inbox,{topicsCommand},{preparedInboxDisplay}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/session-peers'),import('../src/session-inbox'),import('../src/session-topics'),import('../src/presentation-inbox-display')]);
 const {db}=state;
 const runtime={available:()=>true,wake:()=>{},stop:async()=>false,steer:(input:any)=>{
  const active=db.query("SELECT id FROM turns WHERE session_id=? AND status='running'").get(input.session_id) as {id:number}|null;
  if(!active)return false;
  const attached=inputs.attachSessionSteering(input.id,active.id);
  state.markTurnSteeringMessageSending(attached.steering_id!);state.markTurnSteeringMessageSent(attached.steering_id!);return true;
 }};
 const owner=new SessionOwner(runtime,process.env.CONCIERGE_STATE_DIR!);
 const clients=new Map<string,InstanceType<typeof PeerClient>>();
 const errors:unknown[]=[];
 const peers=new SessionPeers({self,clients,owner,isOwnerAlive:()=>true,onError:error=>errors.push(String(error))});
 const communication=new SessionCommunicationCoordinator({owner,peers,isOwnerAlive:()=>true,onError:error=>errors.push(String(error)),arm:()=>()=>{}});
 owner.communication=communication;communication.start();await communication.idle();
 const run=()=>{
  const claim=state.claimNextQueuedTurn(fixture);assert.ok(claim);
  assert.equal(state.markTurnProviderAdmissionIntended(claim.turn_id,fixture,claim.dispatch_attempt),true);
  state.acknowledgeTurnProviderInput(claim.turn_id,fixture,claim.dispatch_attempt,[]);
  return {turn:claim.turn_id,session:claim.session_id,source:{input_id:claim.accepted_input_id!,run_id:inputs.nativeRunId(claim.turn_id)}};
 };
 const box=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Synthetic Lab acceptance thread'}});
 const boxId=Number(box.session.id.slice(10));inputs.updateSessionMetadata(boxId,{inbox:true});const boxRun=run();
 const author=await owner.create({clientActionId:randomUUID(),provider:'codex',purpose:'chat',firstInput:{text:'Synthetic Lab publication author'}});
 const authorRun=run();
 const actor={sessionId:boxId,turnId:boxRun.turn,inputId:boxRun.source.input_id,runId:boxRun.source.run_id};
 const area=topicsCommand(actor,{verb:'area.create',action_id:'publication-area',name:'Lab acceptance'}).area;
 topicsCommand(actor,{verb:'create',action_id:'publication-topic',title:'Lab acceptance',roots:[boxRun.source.input_id],area_ids:[area.id]});
 const counts=()=>({requests:(db.query('SELECT count(*) AS n FROM session_communication_requests').get() as any).n,
  turns:(db.query('SELECT count(*) AS n FROM turns').get() as any).n,
  duties:(db.query('SELECT count(*) AS n FROM session_communication_requests WHERE outcome IS NULL').get() as any).n,
  posts:(db.query("SELECT count(*) AS n FROM session_owner_events WHERE kind='post'").get() as any).n});
 // Authenticated loopback transport stands in for the gateway listener only. Every command
 // response and source proof below is produced by the actual owner.handle and real peer client.
 const token=process.env.LAB_PUBLICATION_ACCEPTANCE_TOKEN!;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
  if(request.headers.get('authorization')!==`Bearer ${token}`)return new Response(null,{status:401});
  return await owner.handle(request)??new Response(null,{status:404});
 }});
 const call=async(path:string,body:unknown,principal?:string)=>{
  const response=await fetch(`http://127.0.0.1:${server.port}${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(principal?{'x-concierge-agent-principal':principal}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 const receive=async(message:any)=>{
  const {id,verb}=message;let result:any;
  try{
   if(verb==='configure'){clients.set(message.peer,new PeerClient(message.peer,message.url,token));result={configured:true};}
   else if(verb==='post')result=await call(message.path??'/sessions/v1/inbox/posts',message.body,message.principal);
   else if(verb==='stats')result={...counts(),errors};
   else if(verb==='finish'){state.finishTurn(authorRun.turn,'done','Synthetic author finished');result={finished:true};}
   else if(verb==='read'){
    const row=db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(message.messageId) as {sequence:number};assert.ok(row);
    const response=await fetch(`http://127.0.0.1:${server.port}/sessions/v1/sessions/${box.session.id}/history?limit=100`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5_000)});
    assert.equal(response.status,200);
    const history=await response.json() as any;
    const live=history.messages.find((item:any)=>item.id===message.messageId);
    const prepared=preparedInboxDisplay(db,boxId,row.sequence,message.messageId)?.preview;
    result={live,prepared};
   }
   else if(verb==='replies'){
    // Make the participant eligible using the canonical routed-work operation, then submit
    // the same incoming path the old Lab adapter used. The result must actually owe a reply.
    await communication.ask({source:boxRun.source,action_id:'participant-work',address:author.session.address,
     summary:'Synthetic Lab participant',text:'Answer the synthetic Lab discussion',requestedEffect:'work',thread:boxRun.source.input_id});
    const samples=[];
    for(const marked of [true,false]){
     const before=counts();
     const response=await call(`/sessions/v1/sessions/${box.session.id}/inputs`,{clientActionId:randomUUID(),text:marked?'Synthetic design-only notice':'Synthetic human Lab question',
      replyToMessage:{kind:'message',sessionId:box.session.id,messageId:boxRun.source.input_id},deliverTo:author.session.id,
      ...(marked?{agentSource:{inputId:authorRun.source.input_id,runId:authorRun.source.run_id}}:{})});
     assert.ok(response.status<300,JSON.stringify(response));await communication.idle();
     const request=db.query('SELECT * FROM session_communication_requests ORDER BY rowid DESC LIMIT 1').get() as any;
     assert.equal(counts().requests,before.requests+1);assert.equal(request.target_session_id,authorRun.session);assert.equal(request.outcome,null);
     const delivered=inputs.getAcceptedSessionInput(request.target_input_id)!;
     assert.equal(inputs.getAcceptedSessionInput(request.source_input_id)!.origin,marked?'agent':'human');
     assert.match(JSON.parse(delivered.payload_json).text,marked?/marked agent test/i:/Tejas/);
     const answer=`Synthetic ${marked?'marked':'human'} participant answer`;
     communication.reply({source:authorRun.source,action_id:marked?'marked-answer':'human-answer',request_id:request.request_id,
      text:answer,final:false,answers_question:true});await communication.idle();
     assert.ok(inbox.inboxHistory(state.getSessionById(boxId)!,null,100)!.messages.some(item=>item.content===answer));
     samples.push({marked,responseStatus:response.status,requestId:request.request_id,requestCreated:true,answerPresentedInHistory:true});
    }
    result=samples;
   }else throw new Error('Unknown acceptance control.');
   process.send?.({id,result});
  }catch(error){process.send?.({id,error:String(error),stack:error instanceof Error?error.stack:undefined});}
 };
 process.on('message',message=>{void receive(message);});
 process.on('disconnect',()=>{server.stop(true);process.exit(0);});
 process.send?.({ready:true,self,url:`http://127.0.0.1:${server.port}`,source:authorRun.source,author:author.session.id,inbox:box.session.id,thread:boxRun.source.input_id});
}else{
 const root=await mkdtemp(join(tmpdir(),'concierge-lab-publication-'));
 const children:ChildProcess[]=[];const token=randomUUID();
 const start=async(self:string)=>{
  const dir=join(root,self);await mkdir(dir);
  const child=spawn(process.execPath,[import.meta.path,'--owner',self],{env:{...process.env,CONCIERGE_STATE_DIR:dir,CONCIERGE_CAPTURE_STATE_DIR:join(dir,'capture'),
   CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:LAB_PUBLICATION_TEST_AUTHORIZATION,LAB_PUBLICATION_ACCEPTANCE_TOKEN:token},stdio:['ignore','pipe','pipe','ipc']});
  children.push(child);let stderr='';child.stderr!.on('data',chunk=>{stderr=(stderr+chunk).slice(-6000);});child.stdout!.resume();
  const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  child.on('exit',code=>{for(const waiter of pending.values())waiter.reject(new Error(`Owner ${self} exited ${code}: ${stderr}`));pending.clear();});
  const ready=await new Promise<any>((resolve,reject)=>{
   child.on('error',reject);child.once('exit',code=>reject(new Error(`Owner ${self} exited ${code}: ${stderr}`)));
   child.on('message',(value:any)=>{if(value.ready)resolve(value);else{const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);value.error?waiter.reject(new Error(value.stack??value.error)):waiter.resolve(value.result);}}});
  });
  const command=(verb:string,body:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const id=randomUUID();pending.set(id,{resolve,reject});child.send({id,verb,...body});});
  return {ready,command};
 };
 const began=performance.now();const timer=setTimeout(()=>{for(const child of children)child.kill('SIGKILL');},90_000);
 try{
  const sourceEvidence=await Promise.all(['../src/session-owner.ts','../src/session-communication.ts','../src/inbox-publication.ts',
   '../src/state-database.ts','../src/test-authorizations.ts','../src/inbox-attribution-read.ts','../src/session-inbox.ts',
   '../src/presentation-inbox-display.ts','lab-publication-acceptance.ts'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(import.meta.dir,path))).digest('hex')})));
  const cloud=await start('cloud'),mac=await start('mac');
  await cloud.command('configure',{peer:'mac',url:mac.ready.url});await mac.command('configure',{peer:'cloud',url:cloud.ready.url});
  const incoming=await cloud.command('replies');
  const publication=(source:any,sourceOwner:string,action_id:string)=>({version:1,source,action_id,sourceOwner,destinationOwner:'cloud',targetSessionId:cloud.ready.inbox,thread:cloud.ready.thread,text:` ${action_id}: exact publication bytes `});
  const rows=[];
  for(const [machine,source,author] of [['cloud',cloud.ready.source,cloud.ready.author],['mac',mac.ready.source,`mac:${mac.ready.author.slice(10)}`]] as const){
   const body=publication(source,machine,`${machine}-publication`),before=await cloud.command('stats');
   const first=await cloud.command('post',{body});assert.ok(first.status<300,JSON.stringify(first));assert.equal(first.body.duplicate,false);
   const duplicate=await cloud.command('post',{body});assert.ok(duplicate.status<300);assert.equal(duplicate.body.duplicate,true);assert.deepEqual(duplicate.body.post,first.body.post);
   for(const changed of [{...body,text:body.text+'changed'},{...body,text:body.text.trim()},{...body,source:{...source,run_id:'wrong-run'}}]){
    const refused=await cloud.command('post',{body:changed});assert.ok(refused.status>=400,JSON.stringify(refused));
   }
   const after=await cloud.command('stats');assert.equal(after.requests,before.requests);assert.equal(after.turns,before.turns);assert.equal(after.duties,before.duties);assert.equal(after.posts,before.posts+1);
   const display=await cloud.command('read',{messageId:first.body.post.messageId});
   for(const projection of [display.live,display.prepared]){assert.equal(projection.content,body.text);assert.equal(projection.author.session.id,author);assert.equal(projection.author.inputId,source.input_id);assert.equal(projection.author.runId,source.run_id);}
   rows.push({machine,httpStatus:first.status,post:first.body.post,duplicate:true,changedBytesRefused:true,noNewRequestTurnDuty:true,liveAndPreparedAuthor:author});
  }
  const valid=publication(mac.ready.source,'mac','foreign-invalid-target');
  for(const body of [{...valid,targetSessionId:'concierge:99999'},{...valid,thread:'missing-thread'},{...valid,source:{...valid.source,input_id:'invented-source'}}]){
   const before=await cloud.command('stats'),refused=await cloud.command('post',{body});assert.ok(refused.status>=400);assert.equal((await cloud.command('stats')).posts,before.posts);
  }
  const principal=await cloud.command('post',{body:valid,principal:'run:untrusted'});assert.equal(principal.status,403);
  // Retain exact foreign intent at the source, then end its run before destination admission.
  const held=publication(mac.ready.source,'mac','held-before-finish');
  const proof=await mac.command('post',{path:'/sessions/v1/peers/inbox-post-source',body:held});assert.ok(proof.status<300,JSON.stringify(proof));
  await mac.command('finish');const completed=await cloud.command('post',{body:held});assert.ok(completed.status<300,JSON.stringify(completed));
  const unadmitted=await cloud.command('post',{body:{...held,action_id:'not-admitted-before-finish'}});assert.ok(unadmitted.status>=400);
  await cloud.command('finish');
  for(const [machine,source] of [['cloud',cloud.ready.source],['mac',mac.ready.source]] as const){const receipt=await cloud.command('post',{body:publication(source,machine,`${machine}-publication`)});assert.ok(receipt.status<300);assert.equal(receipt.body.duplicate,true);}
  assert.deepEqual((await cloud.command('stats')).errors,[]);assert.deepEqual((await mac.command('stats')).errors,[]);
  const result={fixture,status:'passed',sourceEvidence,elapsedMs:Math.round(performance.now()-began),incoming,rows,sourceProofThenEndedRun:true,unadmittedEndedSourceRefused:true,
   scope:'canonical isolated HTTP owner and peer admission; not installed/browser/device acceptance',substitutes:['synthetic inputs','scratch ledgers','inert provider runtime','authenticated loopback listener instead of gateway']};
  const output=process.argv[process.argv.indexOf('--output')+1];if(process.argv.includes('--output')){assert.ok(output);await writeFile(output,JSON.stringify(result,null,2)+'\n');}
  console.log(JSON.stringify(result));
 }finally{
  clearTimeout(timer);for(const child of children){if(child.connected)child.disconnect();child.kill('SIGTERM');}
  await Promise.all(children.map(child=>child.exitCode!==null?Promise.resolve():new Promise<void>(resolve=>child.once('exit',()=>resolve()))));
  await rm(root,{recursive:true,force:true});
 }
}
