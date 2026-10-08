#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {PreparedSessionCards,readPreparedSessionWindow,readPreparedSessionChanges} from '../src/prepared-session-cards';

/** Isolated release fixtures. No production state or provider import is permitted here. */
function fixture(count:number){
  const source=new Database(':memory:'),prepared=new Database(':memory:');
  source.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,provider_id TEXT,status TEXT,native_metadata_json TEXT,
    agent_session_uuid TEXT,slack_channel_id TEXT,slack_thread_ts TEXT,created_at TEXT,last_turn_at TEXT);
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,started_at TEXT,provider_turn_id TEXT);
    CREATE INDEX turns_session_latest ON turns(session_id,id DESC);
    CREATE INDEX turns_session_active ON turns(session_id,id DESC) WHERE status IN ('running','delivering');
    CREATE INDEX turns_session_queued ON turns(session_id,id DESC) WHERE status='queued';
    CREATE INDEX turns_session_started ON turns(session_id,id DESC) WHERE status<>'queued' AND started_at IS NOT NULL;
    CREATE INDEX turns_session_provider_turn ON turns(session_id,provider_turn_id) WHERE provider_turn_id IS NOT NULL;`);
  const labels=(_database:Database,row:{native_metadata_json:string|null})=>({
    title:JSON.parse(row.native_metadata_json||'{}').title,summary:'Summary',project:'thinkering'});
  let inboxAttention:boolean|null=null;
  const cards=new PreparedSessionCards(source,prepared,labels,row=>row.id===count?inboxAttention:null);
  cards.beginRebuild(1);
  const insert=source.query('INSERT INTO sessions(id,provider_id,status,native_metadata_json,created_at,last_turn_at) VALUES(?,?,?,?,?,?)');
  for(let id=1;id<=count;id++)insert.run(id,'claude-code','idle',JSON.stringify({title:id===1?'界'.repeat(2000):`Session ${id}`,inbox:id===count}),
    '2026-10-08T00:00:00Z',new Date(Date.UTC(2026,9,8,0,0,0)+id*1000).toISOString());
  const insertTurn=source.query('INSERT INTO turns(id,session_id,status,started_at) VALUES(?,?,?,?)');
  for(let id=1;id<=count*10;id++)insertTurn.run(id,1,id%7===0?'queued':'done','2026-10-08T00:00:00Z');
  for(const sql of [
    "SELECT id FROM turns WHERE session_id=1 ORDER BY id DESC LIMIT 1",
    "SELECT id FROM turns WHERE session_id=1 AND status IN ('running','delivering') ORDER BY id DESC LIMIT 1",
    "SELECT COUNT(*) FROM turns WHERE session_id=1 AND status='queued'",
    "SELECT started_at FROM turns WHERE session_id=1 AND status<>'queued' AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1"
  ]){
    const plans=source.query('EXPLAIN QUERY PLAN '+sql).all() as {detail:string}[];
    assert.ok(plans.some(plan=>/\bSEARCH turns\b/.test(plan.detail)),JSON.stringify(plans));
    assert.ok(plans.every(plan=>!/\bSCAN turns\b/.test(plan.detail)),JSON.stringify(plans));
  }
  let after=0;
  while(true){const page=cards.rebuildPage(1,after,50);after=page.lastId;if(!page.hasMore)break;}
  cards.activate(1,0);
  return {source,prepared,cards,getAttention:()=>inboxAttention,setAttention:(value:boolean)=>{inboxAttention=value;}};
}

async function windowGrowth(){
  for(const count of [100,1000]){
    const {source,prepared,cards}=fixture(count);
    try {
      const first=readPreparedSessionWindow(prepared,{space:'everyday',limit:20,canonicalHead:0});
      assert.equal(first.cards.length,20);
      assert.ok(Buffer.byteLength(JSON.stringify(first))<96*1024);
      assert.ok(first.nextCursor);
      source.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({title:'Moved after opening'}),count-30);
      cards.apply(1,[{sequence:1,source_table:'sessions',row_key:String(count-30),session_id:count-30}]);
      cards.checkpoint(1,1);
      const second=readPreparedSessionWindow(prepared,{space:'everyday',cursor:first.nextCursor,limit:20,canonicalHead:1});
      assert.equal(second.cards.length,20,'concurrent change must not starve the older page');
      assert.ok(second.cards.every(card=>!first.cards.some(previous=>previous.id===card.id)));
      const delta=readPreparedSessionChanges(prepared,first.asOf,'everyday',1);
      assert.equal(delta.changes.length,1,'moved card must be in the revision feed');
      assert.equal(delta.changes[0]?.after?.title,'Moved after opening');
    } finally {source.close();prepared.close();}
  }
}

async function changesGrowth(){
  for(const count of [100,1000]){
    const {source,prepared,cards,setAttention}=fixture(count);
    try {
      const before=readPreparedSessionWindow(prepared,{space:'everyday',needsAttention:true,canonicalHead:0});
      assert.equal(before.coverage.code,'attention_catching_up');
      assert.equal(before.cards.length,0);
      setAttention(true);
      cards.apply(1,[{sequence:1,source_table:'inbox_questions',session_id:count}], [count]);
      cards.checkpoint(1,1);
      const delta=readPreparedSessionChanges(prepared,before.asOf,'everyday',1);
      assert.equal(delta.changes.length,1);
      assert.equal(delta.changes[0]?.before?.needsAttention,null);
      assert.equal(delta.changes[0]?.after?.needsAttention,true);
      assert.ok(Buffer.byteLength(JSON.stringify(delta))<96*1024);
      const after=readPreparedSessionWindow(prepared,{space:'everyday',needsAttention:true,canonicalHead:1});
      assert.equal(after.cards[0]?.id,`concierge:${count}`);
      assert.equal(after.coverage.complete,true);
      const labBefore=readPreparedSessionWindow(prepared,{space:'lab',canonicalHead:1});
      source.query('UPDATE sessions SET native_metadata_json=? WHERE id=?')
        .run(JSON.stringify({title:'Moved into lab',cwd:'/root/workspace/agent-ecology'}),count-1);
      cards.apply(1,[{sequence:2,source_table:'sessions',row_key:String(count-1),session_id:count-1}]);
      cards.checkpoint(1,2);
      const everydayChange=readPreparedSessionChanges(prepared,after.asOf,'everyday',2);
      const labChange=readPreparedSessionChanges(prepared,labBefore.asOf,'lab',2);
      assert.equal(everydayChange.changes.length,1);
      assert.equal(everydayChange.changes[0]?.after?.space,'lab');
      assert.equal(labChange.changes.length,1);
      assert.equal(labChange.changes[0]?.before?.space,'everyday');
      const wrongSpace=readPreparedSessionChanges(prepared,after.asOf,'lab',2);
      assert.equal(wrongSpace.coverage.code,'reset');
    } finally {source.close();prepared.close();}
  }
}

export const sessionCardGrowthFixtures={
  'sessions-window-growth':windowGrowth,
  'sessions-changes-growth':changesGrowth
} as const;

if(import.meta.main){
  for(const [name,check] of Object.entries(sessionCardGrowthFixtures)){await check();console.log(`${name}: passed`);}
}
