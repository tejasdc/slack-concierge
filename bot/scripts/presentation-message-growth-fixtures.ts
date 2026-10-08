import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {readPreparedInboxDetailPart,readPreparedInboxDisplays,readPreparedMessages} from '../src/presentation-message-reader';
import {observeStorageOperation,observedDatabase,type StorageWork} from '../src/storage-observation';

function fixture(unrelated:number){
  const raw=new Database(':memory:');
  raw.exec(`CREATE TABLE presentation_message_meta(singleton INTEGER PRIMARY KEY,generation INTEGER,event_watermark INTEGER,ready INTEGER);
    CREATE TABLE presentation_messages(generation INTEGER,session_id INTEGER,root_input_id TEXT,message_id TEXT,event_sequence INTEGER);
    CREATE INDEX message_root_page ON presentation_messages(generation,session_id,root_input_id,event_sequence DESC);
    CREATE UNIQUE INDEX message_id_lookup ON presentation_messages(generation,session_id,message_id);
    CREATE TABLE presentation_message_display(generation INTEGER,event_sequence INTEGER,display_json TEXT);
    CREATE UNIQUE INDEX display_lookup ON presentation_message_display(generation,event_sequence);
    CREATE TABLE presentation_message_detail_chunks(generation INTEGER,event_sequence INTEGER,part INTEGER,content TEXT,digest TEXT);
    CREATE UNIQUE INDEX detail_lookup ON presentation_message_detail_chunks(generation,event_sequence,part);
    INSERT INTO presentation_message_meta VALUES(1,1,999999,1);`);
  const messages=raw.query('INSERT INTO presentation_messages VALUES(1,1,?,?,?)');
  const displays=raw.query('INSERT INTO presentation_message_display VALUES(1,?,?)');
  for(let n=1;n<=40;n++){
    messages.run('selected',`m${n}`,n);
    displays.run(n,JSON.stringify({id:`m${n}`,content:'A bounded display'}));
  }
  const unrelatedMessage=raw.query('INSERT INTO presentation_messages VALUES(1,2,?,?,?)');
  const unrelatedDisplay=raw.query('INSERT INTO presentation_message_display VALUES(1,?,?)');
  for(let n=1;n<=unrelated;n++){
    unrelatedMessage.run(`other-${n}`,`other-m${n}`,100+n);
    unrelatedDisplay.run(100+n,JSON.stringify({id:`other-m${n}`,content:'Unrelated retained data'}));
  }
  const part=raw.query('INSERT INTO presentation_message_detail_chunks VALUES(1,10,?,?,?)');
  for(let n=0;n<8;n++)part.run(n,'x'.repeat(4096),'stable-digest');
  return {raw,db:observedDatabase(raw)};
}
function measure<T>(callback:()=>T):{result:T;work:StorageWork}{
  let work:StorageWork|undefined;
  const result=observeStorageOperation('presentation-growth-fixture',callback,value=>{work=value;});
  assert.ok(work);
  return {result,work};
}
export async function messageWindowGrowth(){
  let baseline:StorageWork|undefined;
  for(const unrelated of [100,10_000]){
    const {raw,db}=fixture(unrelated);
    try{
      const {result,work}=measure(()=>{
        const page=readPreparedMessages(db,1,'selected',20,null,0);
        return {page,displays:readPreparedInboxDisplays(db,page.keys)};
      });
      assert.equal(result.page.keys.length,20);
      assert.equal(result.displays.length,20);
      assert.ok(result.page.nextCursor);
      assert.ok(Buffer.byteLength(JSON.stringify(result))<64*1024);
      assert.equal(work.db_calls,23);
      assert.ok(work.db_rows<=43);
      assert.ok(work.db_result_bytes<64*1024);
      const plan=raw.query(`EXPLAIN QUERY PLAN SELECT event_sequence,message_id FROM presentation_messages
        WHERE generation=1 AND session_id=1 AND root_input_id='selected' AND event_sequence<999999
        ORDER BY event_sequence DESC LIMIT 21`).all() as {detail:string}[];
      assert.ok(plan.some(row=>row.detail.includes('USING INDEX message_root_page')),JSON.stringify(plan));
      assert.ok(plan.every(row=>!row.detail.includes('USE TEMP B-TREE')),JSON.stringify(plan));
      if(baseline){assert.equal(work.db_calls,baseline.db_calls);assert.equal(work.db_rows,baseline.db_rows);
        assert.equal(work.db_result_bytes,baseline.db_result_bytes);}
      baseline=work;
    } finally {raw.close();}
  }
}
export async function messageDetailGrowth(){
  let baseline:StorageWork|undefined;
  for(const unrelated of [100,10_000]){
    const {raw,db}=fixture(unrelated);
    try{
      const {result,work}=measure(()=>readPreparedInboxDetailPart(db,1,'m10',0));
      assert.equal(result?.content.length,4096);
      assert.equal(result?.nextPart,1);
      assert.equal(work.db_calls,3);
      assert.ok(work.db_rows<=4);
      assert.ok(work.db_result_bytes<16*1024);
      const plan=raw.query(`EXPLAIN QUERY PLAN SELECT part,content,digest FROM presentation_message_detail_chunks
        WHERE generation=1 AND event_sequence=10 AND part>=0 ORDER BY part LIMIT 2`).all() as {detail:string}[];
      assert.ok(plan.some(row=>row.detail.includes('USING INDEX detail_lookup')),JSON.stringify(plan));
      if(baseline){assert.equal(work.db_calls,baseline.db_calls);assert.equal(work.db_rows,baseline.db_rows);
        assert.equal(work.db_result_bytes,baseline.db_result_bytes);}
      baseline=work;
    } finally {raw.close();}
  }
}
export const messageGrowthFixtures={
  'messages-window-growth':messageWindowGrowth,
  'message-detail-growth':messageDetailGrowth
} as const;

if(import.meta.main){for(const [name,check] of Object.entries(messageGrowthFixtures)){await check();console.log(`${name}: passed`);}}
