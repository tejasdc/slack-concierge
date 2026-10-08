import {strict as assert} from 'node:assert';
import {Database} from 'bun:sqlite';
import {PreparedTopics,readPreparedTopics,readPreparedTopic,readPreparedTopicChanges,readPreparedTopicOverview,readPreparedTopicItems,readPreparedQuestions,readPreparedTopicResolution,readPreparedTopicChunk,readPreparedInboxAttention} from '../src/prepared-topics';
import {observedDatabase,withStorageReadBudget,observeStorageOperation} from '../src/storage-observation';

async function readerGrowth(reader:'window'|'overview'|'items'|'questions'|'resolution'|'detail'|'changes'|'attention'){
 for(const count of [100,1000,10000]){
  const source=new Database(':memory:'),raw=new Database(':memory:');
  new PreparedTopics(source,raw);
  raw.exec('CREATE TABLE presentation_messages(generation INTEGER,message_id TEXT,root_input_id TEXT,topic_id TEXT,event_sequence INTEGER); CREATE INDEX fixture_message ON presentation_messages(generation,message_id,event_sequence);');
  raw.query('UPDATE presentation_topics_meta SET generation=1,source_head=7,ready=1').run();
  const insert=raw.query('INSERT INTO presentation_topics VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  raw.transaction(()=>{for(let i=0;i<count;i++){
   const id=String(i).padStart(8,'0'),key=`0:0000000000000:${id}`;
   const topic={id,title:'Topic',needsYou:{count:0}};
   insert.run(1,id,1,'open',0,0,'2026-10-08T00:00:00Z','2026-10-08T00:00:00Z',JSON.stringify(topic),'a'.repeat(64),'topic',key,key,'{}',JSON.stringify({topic,questionCounts:{open:1},requestCount:0}));
   raw.query('INSERT INTO presentation_topic_questions VALUES(?,?,?,?,?,?,?)').run(1,id,`question-${id}`,'open','2026-10-08T00:00:00Z',JSON.stringify({id:`question-${id}`}),key);
   raw.query('INSERT INTO presentation_messages VALUES(?,?,?,?,?)').run(1,`message-${id}`,`root-${id}`,id,i+1);
  }})();
  const db=observedDatabase(raw);
  raw.query('INSERT INTO presentation_topic_chunks VALUES(?,?,?,?)').run('a'.repeat(64),0,'x'.repeat(16384),1);
  const budget={maxCalls:128,maxRows:reader==='overview'?260:reader==='window'?240:100,maxResultBytes:1024*1024};
  const selected=()=>reader==='window'?readPreparedTopics(db,{canonicalHead:7}):reader==='overview'?readPreparedTopicOverview(db,'00000000',7)
   :reader==='items'?readPreparedTopicItems(db,{topicId:'00000000',kind:'questions',filter:'open',canonicalHead:7})
   :reader==='questions'?readPreparedQuestions(db,{state:'open',canonicalHead:7})
   :reader==='resolution'?readPreparedTopicResolution(db,'message-00000000',7)
   :reader==='detail'?readPreparedTopicChunk(db,'a'.repeat(64),0)
   :reader==='attention'?readPreparedInboxAttention(db,1,7)
   :readPreparedTopicChanges(db,Buffer.from(JSON.stringify({g:1,sequence:0})).toString('base64url'),7);
  let calls=0;
  const result=observeStorageOperation(`fixture-${reader}`,()=>withStorageReadBudget(budget,selected),work=>{calls=work.db_calls;});
  assert.ok(calls>0,'the fixture must actually instrument its database calls');
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=(reader==='overview'?524288:reader==='detail'||reader==='items'?131072:262144));
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
  assert.equal(readPreparedTopicOverview(db,'00000000',7).questions[0]?.id,'question-00000000');
  assert.equal(readPreparedTopicItems(db,{topicId:'00000000',kind:'questions',filter:'open',canonicalHead:7}).items.length,1);
  const questions=readPreparedQuestions(db,{state:'open',canonicalHead:7});
  assert.equal(questions.questions?.length,20);assert.equal(questions.questionCounts?.open,count);
  assert.equal(readPreparedTopicResolution(db,'message-00000000',7).topic.id,'00000000');
  raw.query('UPDATE presentation_topics_meta SET generation=2').run();
  assert.equal(readPreparedTopics(db,{canonicalHead:7,cursor:first.nextCursor}).coverage.code,'reset_required');
  source.close();raw.close();
 }
}
export const READ_GROWTH_FIXTURES={
 'topics-window-growth':()=>readerGrowth('window'),'topics-detail-growth':()=>readerGrowth('detail'),'topics-changes-growth':()=>readerGrowth('changes'),
 'topics-overview-growth':()=>readerGrowth('overview'),'topics-items-growth':()=>readerGrowth('items'),'topics-questions-growth':()=>readerGrowth('questions'),
 'topics-resolution-growth':()=>readerGrowth('resolution'),'inbox-attention-growth':()=>readerGrowth('attention')};
if(import.meta.main){for(const fixture of Object.values(READ_GROWTH_FIXTURES))await fixture();console.log('All prepared topic readers passed runtime budgets at 100/1,000/10,000 topics.');}
