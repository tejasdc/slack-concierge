import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {db} from '../src/state';
import {readTopic,listTopics,invalidateTopicRoots} from '../src/session-topics';
import {topicContext,preparedTopicValue} from '../src/prepared-topic-values';
import {preparedInboxDisplay} from '../src/presentation-inbox-display';
import {observedDatabase,observeStorageOperation} from '../src/storage-observation';
import {PreparedTopics,readPreparedTopics,readPreparedTopic,readPreparedTopicChunk,readPreparedQuestions,readPreparedTopicOverview,readPreparedTopicItems,readPreparedTopicEvents,readPreparedTopicChanges,readPreparedInboxAttention} from '../src/prepared-topics';
import {topicEventSentence} from '../src/topic-event-display';

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
  CREATE TABLE presentation_topic_events(generation INTEGER,topic_id TEXT,event_sequence INTEGER);
  CREATE TABLE presentation_message_display(generation INTEGER,event_sequence INTEGER,display_json TEXT);`);
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
 for(const [sequence,id] of [[accepted,'root-one'],[post,'post-one']] as const){
  const display=preparedInboxDisplay(db,session,sequence,id)!;
  prepared.query('INSERT INTO presentation_message_display VALUES(?,?,?)').run(1,sequence,JSON.stringify(display.preview));
 }
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
 expect(readPreparedQuestions(prepared,{state:'open',canonicalHead:7}).topics.flatMap((g:any)=>g.questions.map((q:any)=>q.id))).toEqual(['ready']);
 const detail=readPreparedTopic(prepared,'fixture-topic',7);
 let raw='';for(let chunk=0;;chunk++){const part=readPreparedTopicChunk(prepared,detail.detailRef!.hash,chunk)!;raw+=part.text;if(chunk+1===part.count)break;}
 expect(JSON.parse(raw).collections).toBe('paged');
 expect(JSON.parse(raw).questions).toEqual([]);
 expect(JSON.parse(raw).requests).toEqual([]);
 expect(Buffer.byteLength(readPreparedTopicChunk(prepared,detail.detailRef!.hash,0)!.text)).toBeLessThanOrEqual(16384);
 expect(detail.detailRef).not.toBeNull();
 const overview=readPreparedTopicOverview(prepared,'fixture-topic',7);
 expect(overview.questionCounts).toEqual({open:1,reading:1,checking:1,deferred:1,history:1});
 expect(overview.questions.map((q:any)=>q.id)).toEqual(['ready']);
 const reading=readPreparedTopicItems(prepared,{topicId:'fixture-topic',kind:'questions',filter:'reading',canonicalHead:7});
 expect(reading.items[0].reads[0].detailRef).toEqual({sessionId:`concierge:${session}`,messageId:'post-one'});
 expect(reading.items[0].reads[0].text.length).toBeLessThan(longText.length);
 expect(Buffer.byteLength(JSON.stringify(reading))).toBeLessThan(8192);
 expect(readPreparedQuestions(prepared,{state:'history',canonicalHead:7}).questionCounts).toEqual(overview.questionCounts);
 expect(readPreparedTopics(prepared,{query:'precise',canonicalHead:7}).topics[0].id).toBe('fixture-topic');
 expect(readPreparedTopics(prepared,{query:'A',canonicalHead:7}).topics[0].id).toBe('fixture-topic');
 // The same long answer can be referenced by many historical reading items. Preparing
 // those items must never make one full answer copy per question.
 const hugeText='A retained eight megabyte answer. '.repeat(260000);
 db.query('UPDATE session_owner_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({text:hugeText}),'post-one');
 const updatedDisplay=preparedInboxDisplay(db,session,post,'post-one')!;
 prepared.query('UPDATE presentation_message_display SET display_json=? WHERE event_sequence=?').run(JSON.stringify(updatedDisplay.preview),post);
 const insert=db.query('INSERT INTO inbox_questions(question_id,topic_id,state,kind,context,brief_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
 db.transaction(()=>{for(let i=0;i<1000;i++)insert.run(`historical-${i}`,'fixture-topic','read','reading','ready',JSON.stringify({...brief,reads:['post-one']}),at,at);})();
 const boundedStore=new PreparedTopics(observedDatabase(db),observedDatabase(prepared));
 const context=boundedStore.context(1,session);let bytes=0,calls=0;
 observeStorageOperation('topic-streaming-growth',()=>boundedStore.write(context,'fixture-topic'),work=>{bytes=work.db_result_bytes;calls=work.db_calls;});
 expect(calls).toBeGreaterThan(1000);
 expect(bytes).toBeLessThan(16*1024*1024);
 expect(readPreparedTopicOverview(prepared,'fixture-topic',7).questionCounts.history).toBe(1001);
 expect(Buffer.byteLength(JSON.stringify(readPreparedTopicOverview(prepared,'fixture-topic',7)))).toBeLessThan(32*1024);
 console.log(JSON.stringify({fixture:'1000-reading-items-one-8MB-answer',db_result_bytes:bytes,db_calls:calls}));
 const management={change:'reconciled',topicId:'fixture-topic',questions:Array.from({length:2000},()=>({brief:{decision:'x'.repeat(1000)}})),by:{kind:'human'},revision:4};
 const eventSequence=Number(db.query('INSERT INTO session_owner_events(event_id,session_id,kind,payload_json,created_at) VALUES(?,?,?,?,?)')
  .run('management-one',session,'topic_question',JSON.stringify(management),at).lastInsertRowid);
 store.writeEvent(1,eventSequence);
 expect(readPreparedTopicEvents(prepared,[eventSequence])[0]?.content).toBe(topicEventSentence(management));
 expect(Buffer.byteLength(JSON.stringify(readPreparedTopicEvents(prepared,[eventSequence])))).toBeLessThan(4096);
 const oldCursor=readPreparedTopics(prepared,{canonicalHead:7}).asOf!;
 prepared.query("INSERT INTO presentation_topic_changes(generation,topic_id,created_ms) VALUES(1,'fixture-topic',0)").run();
 // An expired change cursor resets explicitly; immutable source events remain intact.
 store.collectPage(Date.now()+8*24*60*60*1000);
 expect(readPreparedTopicChanges(prepared,oldCursor,7).coverage.code).toBe('reset_required');
 expect(db.query('SELECT 1 FROM session_owner_events WHERE sequence=?').get(eventSequence)).not.toBeNull();
 const newerSession=Number(db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('fixture','2','claude-code',?)")
  .run(JSON.stringify({inbox:true,title:'New Inbox'})).lastInsertRowid);
 db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({inbox:true,title:'Fixture Inbox',needs:[
  {eventId:'old-unfiled',inputId:'old-input',question:'Old unfiled need',generation:91,outcome:'needs_you',at}]}),session);
 store.apply(1,[{source_table:'sessions',row_key:String(newerSession),session_id:newerSession}],[]);
 while(store.drain(1).hasMore){}
 store.checkpoint(1,8);
 expect(readPreparedTopics(prepared,{canonicalHead:8}).topics).toEqual([]);
 expect(readPreparedQuestions(prepared,{state:'open',canonicalHead:8}).questionCounts.open).toBe(0);
 expect(readPreparedTopicOverview(prepared,'fixture-topic',8).replyTargets.router).toBe(`concierge:${newerSession}`);
 expect(readPreparedInboxAttention(prepared,newerSession,8).total).toBeGreaterThan(0);
 expect(readPreparedInboxAttention(prepared,session,8).total).toBe(readPreparedInboxAttention(prepared,newerSession,8).total+1);
 expect(readPreparedInboxAttention(prepared,session,8).maxGeneration).toBe(91);
 // Reusing an interrupted generation cannot leave stale request links or event displays.
 store.beginRebuild(1);
 expect(readPreparedTopicEvents(prepared,[eventSequence])).toEqual([null]);
 expect(prepared.query('SELECT count(*) AS n FROM presentation_topic_request_links WHERE generation=1').get()).toEqual({n:0});
 prepared.close();
});
