import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {db} from '../src/state';
import {readTopic,listTopics,invalidateTopicRoots} from '../src/session-topics';
import {topicContext,preparedTopicValue} from '../src/prepared-topic-values';
import {PreparedTopics,readPreparedTopics,readPreparedTopic,readPreparedTopicChunk,readPreparedQuestions,readPreparedTopicOverview,readPreparedTopicItems} from '../src/prepared-topics';

test('prepared topic preserves canonical question, request, attention, and work values',()=>{
 const session=Number(db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('fixture','1','claude-code',?)")
  .run(JSON.stringify({inbox:true,title:'Fixture Inbox'})).lastInsertRowid);
 const at='2026-10-08T00:00:00.000Z';
 db.query('INSERT INTO inbox_topics(topic_id,session_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('fixture-topic',session,'A precise topic',at,at);
 const brief={decision:'Which device?',why:{text:'Only he can choose his device'},answerable:'Name the device'};
 for(const [id,state,kind,context] of [['ready','open','decision','ready'],['checking','open','decision','agent_checking'],
  ['deferred','deferred','decision','ready'],['ended','answered','decision','ready'],['empty-reading','open','reading','ready']]){
  db.query('INSERT INTO inbox_questions(question_id,topic_id,state,kind,context,brief_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
   .run(id,'fixture-topic',state,kind,context,JSON.stringify(brief),at,at);
 }
 db.query('INSERT INTO inbox_requests(request_id,topic_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run('request-one','fixture-topic','Do the work',at,at);
 const prepared=new Database(':memory:');
 prepared.exec(`CREATE TABLE presentation_messages(generation INTEGER,event_sequence INTEGER,topic_id TEXT,root_input_id TEXT,message_id TEXT,created_at TEXT,entry_kind TEXT);
  CREATE INDEX pm_topic ON presentation_messages(generation,topic_id,event_sequence DESC);
  CREATE TABLE presentation_topic_events(generation INTEGER,topic_id TEXT,event_sequence INTEGER);`);
 db.query('INSERT INTO session_inputs(id,session_id,scope,action_id,kind,origin,payload_json,receipt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
  .run('root-one',session,'fixture','root-one','input','human',JSON.stringify({text:'The question'}),'{}',at);
 db.query('INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)').run('root-one','fixture-topic');
 const accepted=Number(db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)')
  .run('accepted-one',session,'root-one','accepted','{}',at).lastInsertRowid);
 const longText='Exact retained answer 界 '.repeat(2000);
 const post=Number(db.query('INSERT INTO session_owner_events(event_id,session_id,input_id,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)')
  .run('post-one',session,'root-one','post',JSON.stringify({text:longText}),'2026-10-08T00:00:01.000Z').lastInsertRowid);
 prepared.query('INSERT INTO presentation_messages VALUES(?,?,?,?,?,?,?)').run(1,accepted,'fixture-topic','root-one','root-one',at,'other');
 prepared.query('INSERT INTO presentation_messages VALUES(?,?,?,?,?,?,?)').run(1,post,'fixture-topic','root-one','post-one','2026-10-08T00:00:01.000Z','post');
 db.query('INSERT INTO inbox_questions(question_id,topic_id,state,kind,context,brief_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run('read-answer','fixture-topic','open','reading','ready',JSON.stringify({...brief,reads:['post-one']}),at,at);
 invalidateTopicRoots();
 const canonical=readTopic('fixture-topic');
 const value=preparedTopicValue(topicContext(db,prepared,1,session),'fixture-topic')!;
 const {entries,...canonicalDetail}=canonical;
 expect(value.detail).toEqual(canonicalDetail);
 expect(value.summary).toEqual(listTopics().topics[0]);
 const store=new PreparedTopics(db,prepared);store.beginRebuild(1);store.write(store.context(1,session),'fixture-topic');store.activate(1,7);
 expect(readPreparedTopics(prepared,{canonicalHead:7}).topics[0].needsYou.count).toBe(1);
 expect(readPreparedQuestions(prepared,{state:'open',canonicalHead:7}).questions?.map((q:any)=>q.id)).toEqual(['ready']);
 const detail=readPreparedTopic(prepared,'fixture-topic',7);
 let raw='';for(let chunk=0;;chunk++){const part=readPreparedTopicChunk(prepared,detail.detailRef!.hash,chunk)!;raw+=part.text;if(chunk+1===part.count)break;}
 expect(JSON.parse(raw)).toEqual(canonicalDetail);
 expect(Buffer.byteLength(readPreparedTopicChunk(prepared,detail.detailRef!.hash,0)!.text)).toBeLessThanOrEqual(16384);
 expect(detail.detailRef).not.toBeNull();
 const overview=readPreparedTopicOverview(prepared,'fixture-topic',7);
 expect(overview.questionCounts).toEqual({open:1,reading:1,checking:1,deferred:1,history:1});
 expect(overview.questions.map((q:any)=>q.id)).toEqual(['ready']);
 const reading=readPreparedTopicItems(prepared,{topicId:'fixture-topic',kind:'questions',filter:'reading',canonicalHead:7});
 expect(reading.items[0].detailRef.hash).toMatch(/^[a-f0-9]{64}$/);
 expect(Buffer.byteLength(JSON.stringify(reading))).toBeLessThan(8192);
 expect(readPreparedQuestions(prepared,{state:'history',canonicalHead:7}).questionCounts).toEqual(overview.questionCounts);
 expect(readPreparedTopics(prepared,{query:'precise',canonicalHead:7}).topics[0].id).toBe('fixture-topic');
 expect(readPreparedTopics(prepared,{query:'A',canonicalHead:7}).topics[0].id).toBe('fixture-topic');
 prepared.close();
});
