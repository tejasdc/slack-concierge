import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {db} from '../src/state';
import {presentationHead} from '../src/presentation-changes';
import {PreparedTopics} from '../src/prepared-topics';
import {SessionOwner} from '../src/session-owner';

test('Inbox list waits for its admission head, then answers despite later ledger writes',async()=>{
 const inbox=Number(db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('readiness-fixture','1','codex',?)")
  .run(JSON.stringify({inbox:true,title:'Inbox'})).lastInsertRowid);
 const prepared=new Database(join(process.env.CONCIERGE_STATE_DIR!,'presentation.db'));
 const topics=new PreparedTopics(db,prepared);
 const head=presentationHead(db);
 topics.activate(1,head-1);
 const owner=new SessionOwner({available:()=>false,wake:()=>{},steer:()=>false,stop:async()=>false},'/tmp');
 const response=owner.handle(new Request('http://fixture/sessions/v1/presentation/topics?state=open'));
 setTimeout(()=>{
  db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('later-fixture','1','codex','{}')").run();
  prepared.query('UPDATE presentation_topics_meta SET source_head=? WHERE singleton=1').run(head);
 },60);
 const result=await response;
 expect(result?.status).toBe(200);
 const value=await result!.json() as any;
 expect(value.coverage).toMatchObject({complete:true,code:null,appliedSequence:head});
 expect(presentationHead(db)).toBeGreaterThan(head);
 expect(value.topics).toEqual([]);
 expect(inbox).toBeGreaterThan(0);
 const stillBehind=await owner.handle(new Request('http://fixture/sessions/v1/presentation/topics?state=open'));
 expect((await stillBehind!.json() as any).coverage).toMatchObject({complete:false,code:'presentation_indexing'});
 prepared.close();
},30_000);
