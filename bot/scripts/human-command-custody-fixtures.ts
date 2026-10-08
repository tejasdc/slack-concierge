import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

if(process.env.CONCIERGE_TEST_AUTHORIZATION!=='responsive-system-b1eed622')
 throw new Error('Scoped acceptance authorization required');
const root=await mkdtemp(join(tmpdir(),'human-command-custody-'));
Object.assign(process.env,{CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),CONCIERGE_TEST_MODE:'1'});
const [{createCaptureQueueRequestHandler},{HumanCommandWorker},{captureDb}]=await Promise.all([
 import('../src/capture-queue-api'),import('../src/human-command-worker'),import('../src/capture-state')]);
const token=crypto.randomUUID(),handler=createCaptureQueueRequestHandler({host:'127.0.0.1',port:0,token});
const fetchQueue=(path:string,body?:unknown)=>handler(new Request('http://fixture'+path,{
 method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},
 body:body===undefined?undefined:JSON.stringify(body)}));
const command=(actionId:string,sessionId:string,sequence:number,path:string)=>({version:1,clientId:'fixture-browser',sessionId,
 sequence,actionId,door:'fixture',method:'POST',path,
 body:{clientActionId:actionId,action:actionId.includes('close')?{kind:'close',reason:'Fixture'}:{kind:'read',sequence:1}}});
const status=async(id:string)=>(await (await fetchQueue('/commands/'+id)).json()) as {status:string;ownerStatus:number|null;decisionStage:string|null};
const wait=async(id:string,wanted:string)=>{const until=Date.now()+5000;while(Date.now()<until){
 const row=await status(id);if(row.status===wanted)return row;await Bun.sleep(20);
}throw new Error(`${id} did not reach ${wanted}: ${JSON.stringify(await status(id))}`);};
let worker:InstanceType<typeof HumanCommandWorker>|null=null;
try{
 const topic='topic:fixture';
 const malformed=command('bad-path',topic,1,'/sessions/v1/inbox/topics/%ZZ/actions');
 const close=command('close-action',topic,2,'/sessions/v1/inbox/topics/topic%3Afixture/actions');
 const read=command('read-action','topic:other',1,'/sessions/v1/inbox/topics/topic%3Aother/actions');
 const invalidPrepared=command('bad-prepared','topic:invalid',1,'/sessions/v1/inbox/topics/topic%3Ainvalid/actions');
 const prepOutage=command('prep-outage','topic:outage',1,'/sessions/v1/inbox/topics/topic%3Aoutage/actions');
 const uncertain=command('lost-ack','topic:uncertain',1,'/sessions/v1/inbox/topics/topic%3Auncertain/actions');
 const attemptLimit=command('attempt-limit','topic:limit',1,'/sessions/v1/inbox/topics/topic%3Alimit/actions');
 const oversized=command('oversized','topic:size',1,'/sessions/v1/inbox/topics/topic%3Asize/actions');
 const afterSize=command('after-size','topic:size',2,'/sessions/v1/inbox/topics/topic%3Asize/actions');
 const existing=command('already-retained','topic:retained',1,'/sessions/v1/inbox/topics/topic%3Aretained/actions');
 for(const item of [malformed,close,read,invalidPrepared,prepOutage,uncertain,attemptLimit,afterSize,existing])
  assert.equal((await fetchQueue('/commands',item)).status,202);
 assert.equal((await fetchQueue('/commands/refuse-oversize',oversized)).status,202);
 assert.equal((await wait('oversized','refused')).ownerStatus,413);
 // A late compact refusal cannot overwrite an action the owner may already have seen.
 assert.equal((await fetchQueue('/commands/refuse-oversize',existing)).status,202);
 assert.equal((await status('already-retained')).status,'pending');
 // A healthy browser can rejoin its retained command without consuming another sequence.
 assert.equal((await fetchQueue('/commands',close)).status,202);
 captureDb.query("UPDATE human_commands SET created_at=datetime('now','-3 minutes') WHERE action_id IN ('lost-ack','prep-outage')").run();
 captureDb.query("UPDATE human_commands SET attempts=5 WHERE action_id='attempt-limit'").run();
 const effects=new Map<string,number>();let loseAcknowledgement=true;const stopped:string[]=[];
 worker=new HumanCommandWorker({queueUrl:'http://fixture',queueToken:token,
  fetch:((input:RequestInfo|URL,init?:RequestInit)=>handler(new Request(input,init))) as typeof fetch,
  prepare:async item=>item.actionId==='bad-path'?{status:400,value:{error:{code:'COMMAND_TARGET_INVALID'}}}:
   item.actionId==='bad-prepared'?{status:200,value:null}:
   item.actionId==='prep-outage'?{status:503,value:{error:'gateway unavailable'}}:
   {status:200,value:{primaryBody:item.body,fallbackBody:null}},
  deliver:async item=>{
   effects.set(item.actionId,1); // owner deduplicates the exact action identity.
   if((item.actionId==='lost-ack'&&loseAcknowledgement)||item.actionId==='attempt-limit')return {status:503,value:{error:'lost response'}};
   return {status:200,value:{ok:true,actionId:item.actionId}};
  },
  stopped:async(item)=>{stopped.push(item.actionId);}});
 worker.start();
 assert.equal((await wait('bad-path','refused')).decisionStage,'preparation');
 assert.equal((await wait('bad-prepared','refused')).ownerStatus,422);
 assert.equal((await wait('prep-outage','refused')).decisionStage,'preparation');
 assert.equal((await wait('close-action','delivered')).ownerStatus,200);
 assert.equal((await wait('read-action','delivered')).ownerStatus,200);
 assert.equal((await wait('after-size','delivered')).ownerStatus,200);
 assert.equal((await wait('already-retained','delivered')).ownerStatus,200);
 assert.equal((await wait('lost-ack','unconfirmed')).ownerStatus,null);
 assert.equal((await wait('attempt-limit','unconfirmed')).ownerStatus,null);
 assert.deepEqual(new Set(stopped),new Set(['prep-outage','lost-ack','attempt-limit']));
 assert.equal(effects.get('bad-path'),undefined);
 assert.equal(effects.get('bad-prepared'),undefined);
 assert.equal(effects.get('prep-outage'),undefined);
 assert.equal((await fetchQueue('/commands/lost-ack/resume',{})).status,200);
 loseAcknowledgement=false;
 assert.equal((await wait('lost-ack','delivered')).ownerStatus,200);
 assert.equal(effects.get('lost-ack'),1);
 console.log(JSON.stringify({check:'human-command-custody',status:'passed',encodedTopic:true,
  malformedPreparation:'terminal',independentStreams:'progressed',lostAck:'unconfirmed-then-same-action',
  oversize:'terminal-before-owner',existingCustody:'wins',attemptBudget:'stopped',effects:effects.size}));
}finally{await worker?.stop();await rm(root,{recursive:true,force:true});}
