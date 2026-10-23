#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {savedMessagePage,savedWorkPage} from '../src/owner-collection-pages';
import {inboxQueuePage} from '../src/inbox-queue';
import {inboxCapturesPage} from '../src/inbox-captures-page';
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
async function inboxCapturesGrowth(){
 for(const count of [100,10_000]){
  const database=observedDatabase(new Database(':memory:'));
  try{
   database.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY);
     CREATE TABLE session_inputs(id TEXT PRIMARY KEY,session_id INTEGER,action_id TEXT,kind TEXT,payload_json TEXT,created_at TEXT);
     CREATE INDEX session_inputs_capture_page ON session_inputs(session_id) WHERE id GLOB 'capture:*';
     CREATE TABLE focus_held_captures(capture_id TEXT PRIMARY KEY,input_id TEXT UNIQUE,input_position INTEGER UNIQUE,held_at_ms INTEGER,released_at_ms INTEGER,release_action_id TEXT);
     CREATE INDEX focus_held_captures_pending ON focus_held_captures(input_position DESC) WHERE released_at_ms IS NULL;`);
   database.query('INSERT INTO sessions(id) VALUES(1)').run();
   const insert=database.query('INSERT INTO session_inputs(id,session_id,action_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)');
   for(let index=1;index<=count;index++)insert.run(`capture:${index}`,1,`capture-${index}`,'input',
     JSON.stringify({text:`Capture ${index}`,capture:{source:{kind:'thinkering',recordedAt:'2026-10-14T12:00:00Z'}}}),
     '2026-10-14T12:00:00Z');
   const held=database.query('INSERT INTO focus_held_captures(capture_id,input_id,input_position,held_at_ms) VALUES(?,?,?,0)');
   for(let index=1;index<=count;index+=3)held.run(String(index),`capture:${index}`,index);
   const plan=database.query(`EXPLAIN QUERY PLAN SELECT rowid AS position,id,payload_json,created_at FROM session_inputs
     WHERE session_id=1 AND id GLOB 'capture:*' AND json_extract(payload_json,'$.capture') IS NOT NULL ORDER BY rowid DESC LIMIT 21`).all() as {detail:string}[];
   assert.ok(plan.some(row=>row.detail.includes('session_inputs_capture_page')),JSON.stringify(plan));
   assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')),JSON.stringify(plan));
   const contract=PRESENTATION_READERS.inboxCaptures;
   let work:StorageWork|undefined;
   const first=observeStorageOperation('inboxCaptures',()=>withStorageReadBudget({maxCalls:128,maxRows:contract.maxStorageRows,
     maxResultBytes:contract.maxResponseBytes*2},()=>{
       const inbox=database.query('SELECT id FROM sessions WHERE id=1').get() as {id:number};
       return inboxCapturesPage(database,inbox.id,null,20);
     }),value=>{work=value;});
   assert.ok(work&&work.db_calls>0);
   assert.equal(first.items.length,20);assert.ok(first.nextCursor);
   const second=inboxCapturesPage(database,1,first.nextCursor,20);
   assert.equal(second.items.length,20);
   assert.ok(second.items.every(row=>!first.items.some(prior=>prior.id===row.id)));
   const heldPlan=database.query(`EXPLAIN QUERY PLAN SELECT input.id FROM focus_held_captures held JOIN session_inputs input ON input.id=held.input_id
     WHERE held.released_at_ms IS NULL ORDER BY held.input_position DESC LIMIT 21`).all() as {detail:string}[];
   assert.ok(heldPlan.some(row=>row.detail.includes('focus_held_captures_pending')),JSON.stringify(heldPlan));
   assert.ok(heldPlan.every(row=>!row.detail.includes('TEMP B-TREE')),JSON.stringify(heldPlan));
   const pending=observeStorageOperation('inboxCapturesHeld',()=>withStorageReadBudget({maxCalls:128,maxRows:contract.maxStorageRows,
     maxResultBytes:contract.maxResponseBytes*2},()=>inboxCapturesPage(database,1,null,20,true)));
   assert.equal(pending.items.length,20);assert.ok(pending.items.every(row=>row.held));
   const pendingNext=inboxCapturesPage(database,1,pending.nextCursor,20,true);
   assert.ok(pendingNext.items.length>0&&pendingNext.items.length<=20);
  }finally{database.close();}
 }
}
export const READ_GROWTH_FIXTURES={'saved-messages-growth':savedMessagesGrowth,'saved-work-growth':savedWorkGrowth,
 'inbox-queue-growth':inboxQueueGrowth,'inbox-captures-growth':inboxCapturesGrowth};
if(import.meta.main)for(const [name,check] of Object.entries(READ_GROWTH_FIXTURES)){await check();console.log(`${name}: passed`);}
