/** Isolated process-death acceptance; all inputs and peer replies are synthetic. */
import {strict as assert} from 'node:assert';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622')throw new Error('Scoped acceptance authorization required');
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function child(root:string,url:string,token:string,crashPoint:boolean){
 const [{SessionOwner},{createNativeSession},{db},{HumanCommandWorker},{SessionPeers}]=await Promise.all([
  import('../src/session-owner'),import('../src/session-inputs'),import('../src/state'),
  import('../src/human-command-worker'),import('../src/session-peers')]);
 const session=(db.query('SELECT id FROM sessions ORDER BY id LIMIT 1').get() as {id:number}|null)
  ??createNativeSession('claude-code',{title:'Synthetic restart acceptance',cwd:root});
 assert.equal(session.id,1);
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},root);
 let acceptedId:string|null=null;
 const worker=new HumanCommandWorker({queueUrl:url,queueToken:token,
  prepare:async command=>({status:200,value:{primaryBody:command.body,fallbackBody:null}}),
  deliver:async(command,prepared:any)=>{
   const response=await owner.handle(new Request('http://fixture'+command.path,{method:command.method,
    headers:{'content-type':'application/json'},body:JSON.stringify(prepared.primaryBody)}));
   assert.ok(response&&[200,202].includes(response.status));
   const value=await response!.json() as any;acceptedId=value.operation.operationId;
   if(crashPoint){
    const input=db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(acceptedId) as {turn_id:number};
    db.query(`INSERT INTO session_peer_requests(request_id,peer,source_session_id,source_turn_id,source_input_id,
      action_id,payload_json,payload_hash,remote_session_id,remote_address,remote_operation_id,due_at_ms,created_at_ms)
      VALUES('late-fixture','fixture-peer',1,? ,?,'late-action','{"requestedEffect":"informational"}',
      'fixture-hash','concierge:2','session:fixture','remote-operation',?,?)`)
      .run(input.turn_id,acceptedId,Date.now()+60_000,Date.now());
    await writeFile(join(root,'accepted-before-kill.json'),JSON.stringify({acceptedId,pid:process.pid}));
    await new Promise(()=>{}); // Parent kills this process after canonical acceptance, before acknowledgement.
   }
   return {status:response!.status,value};
  }});
 worker.start();
 if(crashPoint){await new Promise(()=>{});return;}
 const deadline=Date.now()+15_000;
 let custody:any;
 while(Date.now()<deadline){
  custody=await fetch(url+'/commands/restart-action',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
  if(custody.status==='delivered')break;
  await pause(25);
 }
 assert.equal(custody.status,'delivered');await worker.stop();
 const before=JSON.parse(await readFile(join(root,'accepted-before-kill.json'),'utf8'));
 assert.equal(acceptedId,before.acceptedId);
 const inputs=db.query("SELECT id,payload_json FROM session_inputs WHERE scope='surface:thinkering' AND action_id='restart-action'").all() as any[];
 assert.equal(inputs.length,1);assert.equal(JSON.parse(inputs[0].payload_json).text,'Synthetic retained words 界');
 const peers=new SessionPeers({self:'fixture',clients:new Map(),owner,onError:error=>{throw error;},isOwnerAlive:()=>true});
 const reply={eventId:'late-reply-event',kind:'final',text:'Synthetic late peer answer',
  responder:{peer:'fixture-peer',sessionId:'concierge:2',inputId:'peer-input',runId:'peer-run'}};
 assert.equal(peers.receiveReply('late-fixture',reply).recorded,'recorded');
 assert.equal(peers.receiveReply('late-fixture',reply).recorded,'duplicate');
 const settled=db.query("SELECT outcome FROM session_peer_requests WHERE request_id='late-fixture'").get() as any;
 assert.equal(settled.outcome,'answered');
 assert.equal((db.query("SELECT COUNT(*) AS n FROM session_peer_events WHERE request_id='late-fixture'").get() as any).n,1);
 await writeFile(join(root,'recovered.json'),JSON.stringify({beforePid:before.pid,afterPid:process.pid,
  acceptedId,acceptedInputs:inputs.length,duplicateCustodyRejoined:true,latePeerOutcome:settled.outcome,
  latePeerDuplicate:'duplicate',providerObservation:'not exercised: no provider is launched'}));
 process.exit(0);
}

async function main(){
 const root=await mkdtemp(join(tmpdir(),'concierge-restart-acceptance-'));
 Object.assign(process.env,{CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),CONCIERGE_TEST_MODE:'1'});
 const {createCaptureQueueRequestHandler}=await import('../src/capture-queue-api');
 const token=randomUUID()+randomUUID();
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:createCaptureQueueRequestHandler({host:'127.0.0.1',port:0,token})});
 const url=`http://127.0.0.1:${server.port}`;const children:ChildProcess[]=[];let errors='';
 const launch=(mode:string)=>{
  const child=spawn(process.execPath,[import.meta.path,'--child',root,url,token,mode],{env:process.env,stdio:['ignore','ignore','pipe']});
  child.stderr!.on('data',chunk=>{errors=(errors+String(chunk)).slice(-4000);});children.push(child);return child;
 };
 const awaitFile=async(name:string,child:ChildProcess)=>{
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
   const text=await readFile(join(root,name),'utf8').catch(()=>null);if(text)return JSON.parse(text);
   if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Child exited before ${name}: ${errors}`);
   await pause(25);
  }
  throw new Error(`Timed out waiting for ${name}: ${errors}`);
 };
 try{
  const command={version:1,clientId:'restart-client',sessionId:'concierge:1',sequence:1,actionId:'restart-action',door:'fixture',
   method:'POST',path:'/sessions/v1/sessions/concierge%3A1/inputs',body:{clientActionId:'restart-action',text:'Synthetic retained words 界',delivery:'queue'}};
  const retain=()=>fetch(url+'/commands',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(command)});
  assert.equal((await retain()).status,202);
  const first=launch('before');await awaitFile('accepted-before-kill.json',first);
  const ended=new Promise(resolve=>first.once('exit',resolve));first.kill('SIGKILL');await ended;
  assert.equal((await retain()).status,202); // Lost browser acknowledgement reuses identical custody.
  const second=launch('after');const result=await awaitFile('recovered.json',second);
  assert.notEqual(result.beforePid,result.afterPid);
  console.log(JSON.stringify({check:'responsive-restart',status:'passed',isolatedState:true,...result}));
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await Promise.all(children.map(child=>child.exitCode!==null||child.signalCode!==null?Promise.resolve():new Promise(resolve=>child.once('exit',resolve))));
  await server.stop(true);await rm(root,{recursive:true,force:true});
 }
}
if(process.argv[2]==='--child')await child(process.argv[3]!,process.argv[4]!,process.argv[5]!,process.argv[6]==='before');
else await main();
