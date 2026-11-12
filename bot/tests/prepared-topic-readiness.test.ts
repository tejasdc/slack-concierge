import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {db} from '../src/state';
import {presentationHead} from '../src/presentation-changes';
import {PreparedTopics} from '../src/prepared-topics';
import {SessionOwner} from '../src/session-owner';

// His Threads list reads the prepared copy at once. Waiting for the worker held reads for up to
// four seconds (p95 4,033 ms, Nov 12 2026); a list behind its admission head answers incomplete
// immediately with a one-second retry, so the device keeps its rows and asks again soon.
test('Inbox list answers at once: incomplete with a short retry while behind, complete once the worker catches up',async()=>{
 const inbox=Number(db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('readiness-fixture','1','codex',?)")
  .run(JSON.stringify({inbox:true,title:'Inbox'})).lastInsertRowid);
 const prepared=new Database(join(process.env.CONCIERGE_STATE_DIR!,'presentation.db'));
 const topics=new PreparedTopics(db,prepared);
 const head=presentationHead(db);
 topics.activate(1,head-1);
 const owner=new SessionOwner({available:()=>false,wake:()=>{},steer:()=>false,stop:async()=>false},'/tmp');
 const read=async(path='')=>{
  const started=performance.now();
  const response=await owner.handle(new Request(`http://fixture/sessions/v1/presentation/topics?state=open${path}`));
  expect(response?.status).toBe(200);
  return {ms:performance.now()-started,value:await response!.json() as any};
 };
 const behind=await read();
 expect(behind.ms).toBeLessThan(300);
 expect(behind.value.coverage).toMatchObject({complete:false,code:'presentation_indexing',retryAfterMs:1000});
 prepared.query('UPDATE presentation_topics_meta SET source_head=? WHERE singleton=1').run(head);
 const current=await read();
 expect(current.ms).toBeLessThan(300);
 expect(current.value.coverage).toMatchObject({complete:true,code:null,appliedSequence:head});
 expect(current.value.coverage.retryAfterMs).toBeUndefined();
 expect(current.value.topics).toEqual([]);
 expect(inbox).toBeGreaterThan(0);
 // A later page continues a walk whose first page was current; a newer ledger head alone
 // must not tear it.
 db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('later-fixture','1','codex','{}')").run();
 expect(presentationHead(db)).toBeGreaterThan(head);
 const meta=prepared.query('SELECT generation,inbox_session FROM presentation_topics_meta WHERE singleton=1').get() as {generation:number;inbox_session:number};
 const next=Buffer.from(JSON.stringify({g:meta.generation,inbox:meta.inbox_session,state:'open',order:'updated',key:''})).toString('base64url');
 const page=await read(`&cursor=${next}`);
 expect(page.ms).toBeLessThan(300);
 expect(page.value.coverage).toMatchObject({complete:true,code:null});
 prepared.close();
},30_000);
