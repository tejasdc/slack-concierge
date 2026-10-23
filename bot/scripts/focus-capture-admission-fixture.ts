import {strict as assert} from 'node:assert';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdirSync,writeFileSync} from 'node:fs';
import {runFixtureChild} from './fixture-child';

async function checkOne(mode:'--child'|'--mac-child') {
 const state=await mkdtemp(join(tmpdir(),'concierge-focus-capture-'));
 try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,mode],env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'native-attribution-5eaa0768',
  CONCIERGE_PEER_NAME:mode==='--mac-child'?'mac':'cloud',
  CONCIERGE_STATE_DIR:state,CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},deadlineMs:30_000,fixture:'focus-capture-admission'});
 }finally{await rm(state,{recursive:true,force:true});}
}
async function check(){await checkOne('--child');await checkOne('--mac-child');}

async function child() {
 const [{db,claimNextQueuedTurn},{SessionOwner},{createNativeSession}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs')]);
 const workspace=join(process.env.CONCIERGE_STATE_DIR!,'workspace');
 mkdirSync(join(workspace,'slack-inbox','.git'),{recursive:true});
 writeFileSync(join(workspace,'slack-inbox','AGENTS.md'),'Private Inbox fixture.\n');
 let steered=0;
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>{steered++;return false;},stop:async()=>false} as any,workspace);
 const inboxId=Number(owner.inbox().session.id.split(':')[1]);
 const action='fixture-focus-active';
 const focusUntilMs=Date.now()+14*60_000;
 await owner.focusHoldControl({held:true,untilMs:focusUntilMs,label:'Private Focus fixture',reviewCaptures:true,clientActionId:action});
 assert.equal((await owner.focusHoldStatus() as any).reviewCaptures,true);
 const original={source:{kind:'thinkering',id:'fixture-focus-1',recordedAt:new Date().toISOString()},text:'Preserved Focus words',
  files:[{name:'focus.txt',contentType:'text/plain',base64:'Zm9jdXMgYXR0YWNobWVudA=='}]};
 const accepted=owner.acceptInboxCapture(original);
 const captureId=accepted.item.captureId;
 assert.equal(accepted.item.held,true);
 assert.equal(accepted.item.attachments.length,1,'held admission must retain the attachment custody');
 assert.equal((accepted.operation as any).state,'held');
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(`capture:${captureId}`) as {count:number}).count,0);
 assert.equal((db.query("SELECT count(*) AS count FROM session_owner_events WHERE event_id=?").get(`capture:${captureId}`) as {count:number}).count,0,
  'a held capture must not appear in the Inbox conversation before review');
 assert.equal(steered,0);
 assert.equal(owner.acceptInboxCapture(original).item.captureId,captureId);
 const addressed=createNativeSession('codex',{title:'Private addressed capture target'});
 const addressedAction='share-reply:11111111-1111-4111-8111-111111111111';
 const addressedInput=owner.submit(`concierge:${addressed.id}`,{clientActionId:addressedAction,text:'Exact addressed words',selection:[],intent:null}).operation as {operationId:string};
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(addressedInput.operationId) as {count:number}).count,0);
 assert.equal((await owner.focusHoldStatus() as any).heldCaptureCount,2);
 const page=owner.inboxCapturesPage(null,20,true);
 assert.equal(page.items.length,2);
 const addressedCaptureId=page.items.find(item=>item.id===addressedInput.operationId)?.captureId;
 assert.ok(addressedCaptureId);
 await assert.rejects(owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'fixture-release'}),/Finish Focus/);
 const urgent=owner.acceptInboxCapture({source:{kind:'thinkering',id:'fixture-urgent-1',recordedAt:new Date().toISOString()},
  text:'Medication needed now',urgency:'medication'});
 assert.equal(urgent.item.urgency,'medication');assert.equal(urgent.item.held,false);
 assert.equal(claimNextQueuedTurn('fixture-focus-active-session',Date.now(),[inboxId]),null,
  'the active-session exclusion must still hold while an urgent capture is queued');
 const claimed=claimNextQueuedTurn('fixture-focus-provider',Date.now());
 assert.equal(claimed?.accepted_input_id,urgent.operation.id,'explicit urgent capture must bypass the live Focus lease');
 await owner.focusHoldControl({held:false,clientActionId:'fixture-focus-end'});
 assert.equal((await owner.focusHoldStatus() as any).heldCaptureCount,2,'ending Focus must not release a capture');
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(`capture:${captureId}`) as {count:number}).count,0);
 const released=await owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'fixture-release'});
 assert.equal(released.released,true);assert.equal(released.heldCaptureCount,1);
 assert.equal((await owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'fixture-release'})).released,false);
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(`capture:${captureId}`) as {count:number}).count,1);
 assert.equal((db.query("SELECT count(*) AS count FROM session_owner_events WHERE event_id=?").get(`capture:${captureId}`) as {count:number}).count,1,
  'the chosen release makes the capture visible once');
 await owner.releaseHeldCaptures({captureIds:[addressedCaptureId],clientActionId:'fixture-addressed-release'});
 const addressedTurn=db.query('SELECT session_id FROM turns WHERE accepted_input_id=?')
  .get(addressedInput.operationId) as {session_id:number}|null;
 assert.equal(addressedTurn?.session_id,addressed.id,'the selected addressed capture must enter its original session');
 await assert.rejects(owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'fixture-other'}),/not waiting/);
 await owner.focusHoldControl({held:true,untilMs:Date.now()+14*60_000,label:'Legacy Focus fixture',clientActionId:'fixture-legacy-focus'});
 assert.equal((await owner.focusHoldStatus() as any).reviewCaptures,false);
 const legacy=owner.acceptInboxCapture({source:{kind:'thinkering',id:'fixture-legacy-1',recordedAt:new Date().toISOString()},text:'Old client capture'});
 assert.equal(legacy.item.held,false,'old Focus clients must retain queue-only behavior until the review UI ships');
 await assert.rejects(owner.focusHoldControl({held:true,untilMs:focusUntilMs,label:'Private Focus fixture',clientActionId:action}),/another meaning/);
 await owner.focusHoldControl({held:false,clientActionId:'fixture-legacy-focus-end'});
 const delayed=owner.acceptInboxCapture({source:{kind:'thinkering',id:'fixture-delayed-1',recordedAt:new Date().toISOString()},
  text:'Delayed gateway words',holdForReview:true});
 assert.equal(delayed.item.held,true,'the gateway capture decision must survive a stale lease');
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(delayed.operation.id) as {count:number}).count,0);
 const delayedReply=owner.submit(`concierge:${addressed.id}`,{clientActionId:'share-reply:22222222-2222-4222-8222-222222222222',
  text:'Delayed Mac addressed words',selection:[],intent:null,holdForReview:true}).operation as {operationId:string;state:string};
 assert.equal(delayedReply.state,'held','an explicitly marked addressed reply must stay held after the lease ends');
 assert.equal((db.query('SELECT count(*) AS count FROM turns WHERE accepted_input_id=?').get(delayedReply.operationId) as {count:number}).count,0);
 console.log(JSON.stringify({fixture:'focus-capture-admission',status:'passed'}));
}

async function macChild(){
 const [{db},{SessionOwner},{createNativeSession}]=await Promise.all([
  import('../src/state'),import('../src/session-owner'),import('../src/session-inputs')]);
 const workspace=join(process.env.CONCIERGE_STATE_DIR!,'workspace');
 mkdirSync(join(workspace,'slack-inbox','.git'),{recursive:true});
 writeFileSync(join(workspace,'slack-inbox','AGENTS.md'),'Private Inbox fixture.\n');
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false} as any,workspace);
 let cloudHeld=true;
 owner.communication={peersOrNull:()=>({self:'mac',client:()=>({request:async()=>({held:cloudHeld,heldCaptureCount:0})})}),wake:()=>{}} as any;
 const addressed=createNativeSession('codex',{title:'Mac addressed capture target'});
 const accepted=owner.submit(`concierge:${addressed.id}`,{clientActionId:'share-reply:33333333-3333-4333-8333-333333333333',
  text:'Mac target words',selection:[],intent:null,holdForReview:true}).operation as {operationId:string;state:string};
 assert.equal(accepted.state,'held');
 const page=owner.inboxCapturesPage(null,20,true);
 assert.equal(page.items.length,1,'Mac held review must work without a local Inbox session');
 assert.equal((await owner.focusHoldStatus() as any).localHeldCaptureCount,1);
 const captureId=page.items[0]!.captureId;
 await assert.rejects(owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'mac-release'}),/Finish Focus/);
 cloudHeld=false;
 const released=await owner.releaseHeldCaptures({captureIds:[captureId],clientActionId:'mac-release'});
 assert.equal(released.released,true);
 assert.equal((db.query('SELECT session_id FROM turns WHERE accepted_input_id=?').get(accepted.operationId) as {session_id:number}).session_id,addressed.id);
 console.log(JSON.stringify({fixture:'focus-capture-admission',status:'passed',machine:'mac'}));
}

if(process.argv.includes('--mac-child'))await macChild();else if(process.argv.includes('--child'))await child();else await check();
