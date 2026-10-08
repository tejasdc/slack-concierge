#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {PreparedLabRequests,readPreparedLabRequests} from '../src/prepared-lab-requests';
import {observedDatabase,observeStorageOperation,withStorageReadBudget,type StorageWork} from '../src/storage-observation';
import {PRESENTATION_READERS} from '../src/presentation-reader-contracts';

async function labGrowth(){
 for(const count of [100,1000,10_000]){
  const source=new Database(':memory:'),prepared=observedDatabase(new Database(':memory:'));
  try{
   source.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,native_metadata_json TEXT);
    CREATE TABLE session_communication_requests(request_id TEXT PRIMARY KEY,source_session_id INTEGER,target_session_id INTEGER,created_at_ms INTEGER);
    CREATE INDEX lab_source ON session_communication_requests(source_session_id,request_id);
    CREATE INDEX lab_target ON session_communication_requests(target_session_id,request_id);`);
   source.query('INSERT INTO sessions VALUES(?,?)').run(1,JSON.stringify({cwd:'/root/workspace/agent-ecology'}));
   source.query('INSERT INTO sessions VALUES(?,?)').run(2,JSON.stringify({cwd:'/root/workspace/thinkering'}));
   source.query('INSERT INTO sessions VALUES(?,?)').run(3,JSON.stringify({cwd:'/root/workspace/thinkering'}));
   const insert=source.query('INSERT INTO session_communication_requests VALUES(?,?,?,?)');
   for(let index=1;index<=count;index++)insert.run(`request-${String(index).padStart(6,'0')}`,index%19===0?1:index%31===0?3:2,2,index);
   insert.run('target-move',2,3,count+1);
   const materializer=new PreparedLabRequests(source,prepared);
   materializer.beginRebuild(1);
   for(const id of [1,2,3])materializer.rebuildSession(1,id);
   let after='';while(true){const page=materializer.rebuildPage(1,after,20);after=page.lastId;if(!page.hasMore)break;}
   materializer.activate(1,0);
   const contract=PRESENTATION_READERS.lab;
   const read=(cursor:string|null=null)=>{let work:StorageWork|undefined;
    const result=observeStorageOperation('lab-fixture',()=>withStorageReadBudget({maxCalls:128,maxRows:contract.maxStorageRows,
      maxResultBytes:contract.maxResponseBytes*2},()=>readPreparedLabRequests(prepared,cursor,0)),value=>{work=value;});
    assert.ok(work&&work.db_calls>0);return result;};
   const first=read();assert.ok(first.requestIds.length>0);assert.ok(first.nextCursor||count===100);
   if(first.nextCursor){const second=read(first.nextCursor);assert.ok(second.requestIds.every(id=>!first.requestIds.includes(id)));}
   for(const [sql,index] of [
    ["SELECT request_id FROM session_communication_requests WHERE source_session_id=3 AND request_id>'a' ORDER BY request_id LIMIT 50",'lab_source'],
    ["SELECT request_id FROM session_communication_requests WHERE target_session_id=3 AND request_id>'a' ORDER BY request_id LIMIT 50",'lab_target']]){
    const plan=source.query('EXPLAIN QUERY PLAN '+sql).all() as {detail:string}[];
    assert.ok(plan.some(row=>row.detail.includes(index)),JSON.stringify(plan));
   }
   const plan=prepared.query(`EXPLAIN QUERY PLAN SELECT request_id,created_at_ms FROM presentation_lab_requests
    WHERE generation=1 AND (created_at_ms,request_id)<(500,'request-000500') ORDER BY created_at_ms DESC,request_id DESC LIMIT 21`).all() as {detail:string}[];
   assert.ok(plan.some(row=>row.detail.includes('presentation_lab_requests_page')),JSON.stringify(plan));
   source.query('UPDATE sessions SET native_metadata_json=? WHERE id=3').run(JSON.stringify({cwd:'/root/workspace/lab-commons'}));
   materializer.apply(1,[{source_table:'sessions',row_key:'3',session_id:3,request_id:null}]);
   while(materializer.drain(1)){}
   assert.ok((prepared.query("SELECT 1 FROM presentation_lab_requests WHERE generation=1 AND request_id='target-move' LIMIT 1").get()),
    'moving either end into the lab must include the request');
   source.query('UPDATE sessions SET native_metadata_json=? WHERE id=3').run(JSON.stringify({cwd:'/root/workspace/thinkering'}));
   materializer.apply(1,[{source_table:'sessions',row_key:'3',session_id:3,request_id:null}]);
   while(materializer.drain(1)){}
   assert.equal(prepared.query("SELECT 1 FROM presentation_lab_requests WHERE generation=1 AND request_id='target-move' LIMIT 1").get(),null,
    'moving a session out must remove unrelated requests');
  }finally{source.close();prepared.close();}
 }
}
export const READ_GROWTH_FIXTURES={'lab-growth':labGrowth};
if(import.meta.main){await labGrowth();console.log('lab-growth: passed');}
