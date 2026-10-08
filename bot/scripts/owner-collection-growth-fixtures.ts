#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {savedMessagePage,savedWorkPage} from '../src/owner-collection-pages';
import {observedDatabase,observeStorageOperation,withStorageReadBudget,type StorageWork} from '../src/storage-observation';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';

function source(count:number){
 const db=observedDatabase(new Database(':memory:'));
 db.exec(`CREATE TABLE session_saved_messages(session_id INTEGER,message_id TEXT,excerpt TEXT,created_at TEXT,PRIMARY KEY(session_id,message_id));
  CREATE TABLE session_followed_messages(session_id INTEGER,message_id TEXT,excerpt TEXT,created_at TEXT,PRIMARY KEY(session_id,message_id));
  CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,saved_kind TEXT,status TEXT);
  CREATE INDEX saved_message_page ON session_saved_messages(created_at DESC,session_id DESC,message_id DESC);
  CREATE INDEX followed_message_page ON session_followed_messages(created_at DESC,session_id DESC,message_id DESC);
  CREATE INDEX saved_work_page ON turns(id DESC) WHERE saved_kind IS NOT NULL AND status='queued';`);
 const saved=db.query('INSERT INTO session_saved_messages VALUES(?,?,?,?)');
 const followed=db.query('INSERT INTO session_followed_messages VALUES(?,?,?,?)');
 const turn=db.query('INSERT INTO turns VALUES(?,?,?,?)');
 for(let id=1;id<=count;id++){
  const at=new Date(Date.UTC(2026,9,8)+Math.floor(id/3)*1000).toISOString();
  saved.run(id%23+1,`saved-${id}`,'A saved message',at);
  followed.run(id%23+1,`followed-${id}`,'A followed thread',at);
  turn.run(id,id%23+1,id%2===0?'banked':null,id%2===0?'queued':'done');
 }
 return db;
}
function bounded<T>(name:'savedMessages'|'savedWork',read:()=>T){
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
export const READ_GROWTH_FIXTURES={'saved-messages-growth':savedMessagesGrowth,'saved-work-growth':savedWorkGrowth};
if(import.meta.main)for(const [name,check] of Object.entries(READ_GROWTH_FIXTURES)){await check();console.log(`${name}: passed`);}
