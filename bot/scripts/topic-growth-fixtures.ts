import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {PreparedTopics,readPreparedTopics,readPreparedTopic,readPreparedTopicChanges} from '../src/prepared-topics';
import {observedDatabase} from '../src/storage-observation';

async function windowGrowth(){
 for(const count of [100,1000,10000]){
  const source=new Database(':memory:'),raw=new Database(':memory:');
  new PreparedTopics(source,raw);
  raw.query('UPDATE presentation_topics_meta SET generation=1,source_head=7,ready=1').run();
  const insert=raw.query('INSERT INTO presentation_topics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  raw.transaction(()=>{for(let i=0;i<count;i++){
   const id=String(i).padStart(8,'0'),key=`0:0000000000000:${id}`;
   insert.run(1,id,1,'open',0,0,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z',JSON.stringify({id,title:'Topic',needsYou:{count:0}}),'a'.repeat(64),'topic',key,key,'{}','{}');
  }})();
  const db=observedDatabase(raw);
  const first=readPreparedTopics(db,{canonicalHead:7,limit:20});
  assert.equal(first.topics.length,20);assert.ok(first.nextCursor);
  const next=readPreparedTopics(db,{canonicalHead:7,limit:20,cursor:first.nextCursor});
  assert.equal(next.topics[0]?.id,'00000020');
  const lastCursor=Buffer.from(JSON.stringify({g:1,state:'open',key:`0:0000000000000:${String(count-21).padStart(8,'0')}`})).toString('base64url');
  const last=readPreparedTopics(db,{canonicalHead:7,cursor:lastCursor});assert.equal(last.topics.length,20);
  const plans=raw.query("EXPLAIN QUERY PLAN SELECT summary_json FROM presentation_topics WHERE generation=1 AND state='open' AND sort_key>? ORDER BY sort_key LIMIT 21")
   .all('0:0000000000000:00000020') as {detail:string}[];
  assert.ok(plans.some(p=>p.detail.includes('sort_key>?')),JSON.stringify(plans));
  assert.ok(plans.every(p=>!p.detail.includes('TEMP B-TREE')&&!p.detail.startsWith('SCAN')),JSON.stringify(plans));
  raw.query('INSERT INTO presentation_topic_changes(generation,topic_id,before_json,after_json) VALUES(1,?,?,?)')
   .run('00000000',JSON.stringify({id:'00000000'}),null);
  const changed=readPreparedTopicChanges(db,first.asOf!,7);
  assert.equal(changed.changes[0]?.after,null);
  assert.equal(changed.changes[0]?.topicId,'00000000');
  assert.equal(readPreparedTopic(db,'00000000',8).coverage.complete,false);
  raw.query('UPDATE presentation_topics_meta SET generation=2').run();
  assert.equal(readPreparedTopics(db,{canonicalHead:7,cursor:first.nextCursor}).coverage.code,'reset_required');
  source.close();raw.close();
 }
}
export const READ_GROWTH_FIXTURES={'topics-window-growth':windowGrowth,'topics-detail-growth':windowGrowth,'topics-changes-growth':windowGrowth};
if(import.meta.main){await windowGrowth();console.log('Prepared topic keyset, detail, deletion, and reset growth fixtures passed (100/1,000/10,000 topics).');}
