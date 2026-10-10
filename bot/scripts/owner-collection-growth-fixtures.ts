#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {savedMessagePage,savedWorkPage} from '../src/owner-collection-pages';
import {inboxQueuePage} from '../src/inbox-queue';
import {observedDatabase,observeStorageOperation,withStorageReadBudget,type StorageWork} from '../src/storage-observation';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';

function source(count:number){
 const db=observedDatabase(new Database(':memory:'));
 db.exec(`CREATE TABLE session_saved_messages(session_id INTEGER,message_id TEXT,excerpt TEXT,created_at TEXT,PRIMARY KEY(session_id,message_id));
  CREATE TABLE session_followed_messages(session_id INTEGER,message_id TEXT,excerpt TEXT,created_at TEXT,PRIMARY KEY(session_id,message_id));
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,saved_kind TEXT,status TEXT,
    turn_kind TEXT,owner_instance_id TEXT,provider_admission_intended_at TEXT,provider_started_at TEXT,
    provider_turn_id TEXT,provider_input_acknowledged_at TEXT,stop_requested_at TEXT,native_run_id TEXT,
    accepted_input_id TEXT,queue_priority INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE session_inputs(id TEXT PRIMARY KEY,origin TEXT,kind TEXT,steering_id INTEGER,receipt_json TEXT,payload_json TEXT,created_at TEXT);
  CREATE INDEX saved_message_page ON session_saved_messages(created_at DESC,session_id DESC,message_id DESC);
  CREATE INDEX followed_message_page ON session_followed_messages(created_at DESC,session_id DESC,message_id DESC);
  CREATE INDEX saved_work_page ON turns(id DESC) WHERE saved_kind IS NOT NULL AND status='queued';
  CREATE INDEX turns_session_queue_priority ON turns(session_id,queue_priority DESC,id) WHERE status='queued';`);
 const saved=db.query('INSERT INTO session_saved_messages VALUES(?,?,?,?)');
 const followed=db.query('INSERT INTO session_followed_messages VALUES(?,?,?,?)');
 const turn=db.query('INSERT INTO turns(id,session_id,saved_kind,status) VALUES(?,?,?,?)');
 const inboxTurn=db.query("INSERT INTO turns(id,session_id,saved_kind,status,turn_kind,accepted_input_id,queue_priority) VALUES(?,1,NULL,'queued','native',?,?)");
 const inboxInput=db.query("INSERT INTO session_inputs VALUES(?,'human','input',NULL,NULL,?,'2026-10-10')");
 for(let id=1;id<=count;id++){
  const at=new Date(Date.UTC(2026,9,8)+Math.floor(id/3)*1000).toISOString();
  saved.run(id%23+1,`saved-${id}`,'A saved message',at);
  followed.run(id%23+1,`followed-${id}`,'A followed thread',at);
  turn.run(id,id%23+1,id%2===0?'banked':null,id%2===0?'queued':'done');
  const name=`capture:${id}`;
  inboxTurn.run(count+id,name,id%13===0?1:0);
  inboxInput.run(name,JSON.stringify({text:`Capture ${id}`,capture:{id:String(id)}}));
 }
 return db;
}
function bounded<T>(name:'savedMessages'|'savedWork'|'inboxQueue',read:()=>T){
 const contract=PRESENTATION_READERS[name];let work:StorageWork|undefined;
 const page=observeStorageOperation(name,()=>withStorageReadBudget({maxCalls:128,maxRows:contract.maxStorageRows,
  maxResultBytes:contract.maxResponseBytes*2},read),value=>{work=value;});
 assert.ok(work&&work.db_calls>0);
 assert.ok(Buffer.byteLength(JSON.stringify(page))<contract.maxResponseBytes);
 return page;
}
function checkPlan(db:Database,sql:string,index:string){
 const plan=db.query('EXPLAIN QUERY PLAN '+sql).all() as {detail:string}[];
 assert.ok(plan.some(row=>row.detail.includes(index)),JSON.stringify(plan));
 assert.ok(plan.every(row=>!/TEMP B-TREE|SCAN session_saved_messages|SCAN session_followed_messages|SCAN turns/.test(row.detail)),JSON.stringify(plan));
}
async function savedMessagesGrowth(){
 for(const count of [100,1000,10_000]){const db=source(count);try{
  for(const kind of ['messages','followed'] as const){
   const table=kind==='messages'?'session_saved_messages':'session_followed_messages';
   const index=kind==='messages'?'saved_message_page':'followed_message_page';
   checkPlan(db,`SELECT session_id,message_id,excerpt,created_at FROM ${table} WHERE (created_at,session_id,message_id)<('2026-10-08T00:10:00.000Z',10,'saved-10') ORDER BY created_at DESC,session_id DESC,message_id DESC LIMIT 11`,index);
   const first=bounded('savedMessages',()=>savedMessagePage(db,kind));
   assert.equal(first.items.length,10);assert.ok(first.nextCursor);
   const second=bounded('savedMessages',()=>savedMessagePage(db,kind,first.nextCursor));
   assert.equal(second.items.length,10);assert.ok(second.items.every(row=>!first.items.some(prior=>prior.message_id===row.message_id)));
  }
 }finally{db.close();}}
}
async function savedWorkGrowth(){
 for(const count of [100,1000,10_000]){const db=source(count);try{
  checkPlan(db,"SELECT * FROM turns WHERE saved_kind IS NOT NULL AND status='queued' AND id<500 ORDER BY id DESC LIMIT 11",'saved_work_page');
  const first=bounded('savedWork',()=>savedWorkPage(db));
  assert.equal(first.items.length,10);assert.ok(first.nextCursor);
  const second=bounded('savedWork',()=>savedWorkPage(db,first.nextCursor));
  assert.equal(second.items.length,10);assert.ok(second.items.every(row=>!first.items.some(prior=>prior.id===row.id)));
 }finally{db.close();}}
}
async function inboxQueueGrowth(){
 for(const count of [100,1000,10_000]){
  const db=source(count);
  try{
   const plan=db.query(`EXPLAIN QUERY PLAN SELECT turn.id FROM turns turn JOIN session_inputs input ON input.id=turn.accepted_input_id
     WHERE turn.session_id=1 AND turn.status='queued' ORDER BY turn.queue_priority DESC,turn.id LIMIT 51`).all() as {detail:string}[];
   assert.ok(plan.some(row=>row.detail.includes('turns_session_queue_priority')),JSON.stringify(plan));
   assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')),JSON.stringify(plan));
   const first=bounded('inboxQueue',()=>inboxQueuePage(db,1,null,50));
   assert.equal(first.items.length,50);assert.ok(first.nextCursor);
   const second=bounded('inboxQueue',()=>inboxQueuePage(db,1,first.nextCursor,50));
   assert.equal(second.items[0]?.position,51);
   assert.ok(second.items.every(row=>!first.items.some(prior=>prior.inputId===row.inputId)));
  }finally{db.close();}
 }
}
export const READ_GROWTH_FIXTURES={'saved-messages-growth':savedMessagesGrowth,'saved-work-growth':savedWorkGrowth,
 'inbox-queue-growth':inboxQueueGrowth};
if(import.meta.main)for(const [name,check] of Object.entries(READ_GROWTH_FIXTURES)){await check();console.log(`${name}: passed`);}
