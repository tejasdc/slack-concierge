import {Database} from 'bun:sqlite';
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PreparedSearchIndex} from '../src/prepared-search';
import {PreparedSearchUpkeep} from '../src/prepared-search-upkeep';
import {allocatedBytes} from '../src/sqlite-free-pages';

// A presentation file in the November 2026 layout: documents with a folded copy, a contentful
// trigram index and a contentful short index. The upkeep must empty it, rebuild one copy of the
// dialogue without tool output, answer the same searches and hand the freed blocks back.
const dir=mkdtempSync(join(tmpdir(),'prepared-search-upkeep-'));
const path=join(dir,'presentation.db');
try {
 const db=new Database(path,{create:true});
 db.exec('PRAGMA journal_mode=WAL');
 db.exec(`CREATE TABLE prepared_search_documents(
    id INTEGER PRIMARY KEY,document_key TEXT NOT NULL UNIQUE,session_id INTEGER NOT NULL,
    kind TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,folded TEXT NOT NULL,metadata TEXT NOT NULL);
  CREATE INDEX prepared_search_session ON prepared_search_documents(session_id,id);
  CREATE VIRTUAL TABLE prepared_search_text USING fts5(folded,tokenize='trigram');
  CREATE VIRTUAL TABLE prepared_search_short USING fts5(tokens,detail=none);
  CREATE TABLE presentation_owner_messages(generation INTEGER NOT NULL,session_id INTEGER NOT NULL,message_id TEXT NOT NULL,
    first_sequence INTEGER NOT NULL,last_sequence INTEGER NOT NULL,PRIMARY KEY(generation,session_id,message_id));`);
 const filler=(n:number)=>`tool output ${n} `+'x'.repeat(20_000);
 db.transaction(()=>{
  for(let id=1;id<=600;id++){
   const role=id%3===0?'assistant':'tool',text=role==='tool'?filler(id):`assistant answer ${id} about bicycles`;
   db.query('INSERT INTO prepared_search_documents VALUES(?,?,?,?,?,?,?,?)').run(id,`message:${id}:m${id}`,id,'message',role,text,text.toLowerCase(),'{}');
   db.query('INSERT INTO prepared_search_text(rowid,folded) VALUES(?,?)').run(id,text.toLowerCase());
   db.query('INSERT INTO prepared_search_short(rowid,tokens) VALUES(?,?)').run(id,'g61 g62');
   db.query('INSERT INTO presentation_owner_messages VALUES(1,?,?,?,?)').run(id,`m${id}`,id,id);
  }
 })();
 db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
 const before=allocatedBytes(path);

 const search=new PreparedSearchIndex(db);
 const logs:{event:string;fields:Record<string,unknown>}[]=[];
 const messages=new Map<string,{role:string;text:string}>();
 for(let id=1;id<=600;id++)messages.set(`${id}:m${id}`,id%3===0?{role:'assistant',text:`Assistant answer ${id} about bicycles`}:{role:'tool',text:filler(id)});
 const upkeep=new PreparedSearchUpkeep(db,path,search,{
  generation:()=>1,
  indexMessage:(sessionId,messageId,sequence)=>{const message=messages.get(`${sessionId}:${messageId}`)!;
   search.upsert({key:`message:${sessionId}:${messageId}`,sessionId,kind:'message',eventId:messageId,sourceId:`native:${sessionId}`,
    sourceVersion:null,textHash:null,role:message.role,text:message.text,at:null,ordinal:sequence});},
  inputsAfter:()=>[],indexInput:()=>{},
  sessionsAfter:()=>[],indexSession:()=>{},
 },()=>{},(event,fields)=>logs.push({event,fields}),1);

 // A newer catch-up version written before the backfill reaches it must survive the backfill.
 search.upsert({key:'message:3:m3',sessionId:3,kind:'message',eventId:'m3',sourceId:'native:3',sourceVersion:null,textHash:null,
  role:'assistant',text:'A newer streamed answer about unicycles',at:null,ordinal:10_000});

 let now=0;
 for(let step=0;step<10_000&&!logs.some(entry=>entry.event==='presentation_search_size');step++){upkeep.step(now);now+=60_000;}
 const legacy=db.query("SELECT name FROM sqlite_master WHERE name LIKE 'prepared_search%' OR name LIKE 'retired_search%'").all();
 assert.deepEqual(legacy,[],'the old search tables are gone');
 const released=logs.find(entry=>entry.event==='presentation_search_legacy_released')!;
 assert.ok((released.fields.documents_by_role as any).tool.documents===400,JSON.stringify(released.fields));
 assert.equal((db.query('SELECT ready FROM search_meta').get() as {ready:number}).ready,1);
 assert.equal((db.query('SELECT COUNT(*) AS n FROM search_documents').get() as {n:number}).n,200,'only dialogue is indexed');

 const reader=new PreparedSearchIndex(db,false);
 assert.equal(reader.search('bicycles',100).hits.length,100);
 assert.deepEqual(reader.search('answer 597',5).hits.map(hit=>hit.sessionId),[597]);
 assert.deepEqual(reader.search('unicycles',5).hits.map(hit=>hit.sessionId),[3],'the newer version was kept');
 assert.equal(reader.search('tool output',5,true).hits.length,0);
 assert.deepEqual(reader.search('unicycles ab',5).hits.map(hit=>hit.sessionId),[3]);
 assert.equal(reader.search('unicycles zq',5).hits.length,0,'a short term beside a long one is checked');
 db.query("INSERT INTO search_text(search_text) VALUES('integrity-check')").run();

 const size=logs.find(entry=>entry.event==='presentation_search_size')!.fields as any;
 assert.equal(size.release?.released,true,JSON.stringify(size));
 const after=allocatedBytes(path);
 assert.ok(after<before/3,`allocated ${after} of ${before} bytes; logical ${statSync(path).size}`);
 assert.equal((db.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');
 // Freed pages are reused normally after their blocks were returned.
 for(let id=1000;id<1300;id++)search.upsert({key:`message:x:${id}`,sessionId:id,kind:'message',eventId:String(id),sourceId:'x',
  sourceVersion:null,textHash:null,role:'assistant',text:`late reuse ${id} `+'y'.repeat(5000),at:null,ordinal:id});
 db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
 assert.equal((db.query('PRAGMA integrity_check').get() as {integrity_check:string}).integrity_check,'ok');
 assert.equal(reader.search('late reuse',100).hits.length,100);
 // A rollback: the earlier release recreates the old tables by name and indexes into them.
 db.exec(`CREATE TABLE prepared_search_documents(id INTEGER PRIMARY KEY,document_key TEXT NOT NULL UNIQUE,session_id INTEGER NOT NULL,
    kind TEXT NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,folded TEXT NOT NULL,metadata TEXT NOT NULL);
  CREATE VIRTUAL TABLE prepared_search_text USING fts5(folded,tokenize='trigram');
  CREATE VIRTUAL TABLE prepared_search_short USING fts5(tokens,detail=none);
  INSERT INTO prepared_search_text(rowid,folded) VALUES(1,'written during rollback');`);
 messages.set('9999:m9999',{role:'assistant',text:'Written during the rollback window'});
 db.query('INSERT INTO presentation_owner_messages VALUES(1,9999,?,99999,99999)').run('m9999');
 logs.length=0;
 upkeep.step(now);now+=60_000;
 assert.equal((db.query('SELECT ready FROM search_meta').get() as {ready:number}).ready,1,'search stays answerable while it catches up');
 for(let step=0;step<10_000&&!logs.some(entry=>entry.event==='presentation_search_ready');step++){upkeep.step(now);now+=60_000;}
 assert.deepEqual(db.query("SELECT name FROM sqlite_master WHERE name LIKE 'prepared_search%' OR name LIKE 'retired_search%'").all(),[],
  JSON.stringify(logs.map(entry=>entry.event)));
 assert.deepEqual(reader.search('rollback window',5).hits.map(hit=>hit.sessionId),[9999]);
 assert.ok(!logs.some(entry=>entry.event==='presentation_search_upkeep_failed'),JSON.stringify(logs));
 // The backfill walks by rowid instead of sorting the whole generation each step.
 const plan=db.query(`EXPLAIN QUERY PLAN SELECT rowid FROM presentation_owner_messages NOT INDEXED WHERE rowid>? AND generation=? ORDER BY rowid LIMIT 250`)
  .all(0,1) as {detail:string}[];
 assert.ok(plan.some(row=>/INTEGER PRIMARY KEY|rowid>/.test(row.detail))&&!plan.some(row=>/TEMP B-TREE/.test(row.detail)),JSON.stringify(plan));

 db.close();
 console.log(JSON.stringify({check:'prepared-search-upkeep',status:'passed',allocated_before:before,allocated_after:after,
  released:released.fields.released_bytes}));
} finally {rmSync(dir,{recursive:true,force:true});}
