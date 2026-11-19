import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import {db} from '../src/state';
import {presentationHead} from '../src/presentation-changes';
import {PreparedTopics} from '../src/prepared-topics';
import {SessionOwner} from '../src/session-owner';
import {OWNER_POSITION_APPLIED_HEADER,OWNER_POSITION_HEADER,parseOwnerPosition} from '../src/owner-position';

// A prepared read given the caller's own write position answers at once: not ready while that
// exact projection is behind it, normal once its checkpoint covers it, and refused for a position
// another ledger issued. Nightly review 97e85519 (Nov 19, 2026) found prepared reads trailing a
// confirmed own write with nothing to say whether they included it.
test('prepared reads honour a minimum owner write position without waiting',async()=>{
 db.query("INSERT INTO sessions(slack_channel_id,slack_thread_ts,provider_id,native_metadata_json) VALUES('position-fixture','1','codex',?)")
  .run(JSON.stringify({inbox:true,title:'Inbox'}));
 const prepared=new Database(join(process.env.CONCIERGE_STATE_DIR!,'presentation.db'));
 const topics=new PreparedTopics(db,prepared);
 const owner=new SessionOwner({available:()=>false,wake:()=>{},steer:()=>false,stop:async()=>false},'/tmp');

 // Every write response names the committed position, refused writes included.
 const write=await owner.handle(new Request('http://fixture/sessions/v1/no-such-write',{method:'POST',body:'{}',headers:{'content-type':'application/json'}}));
 const position=write!.headers.get(OWNER_POSITION_HEADER)!;
 expect(parseOwnerPosition(position)?.sequence).toBe(presentationHead(db));
 const head=presentationHead(db);
 topics.activate(1,head-1);

 const read=async(query:string,path='presentation/topics?state=open&')=>{
  const started=performance.now();
  const response=await owner.handle(new Request(`http://fixture/sessions/v1/${path}${query}`));
  return {ms:performance.now()-started,status:response!.status,applied:response!.headers.get(OWNER_POSITION_APPLIED_HEADER),value:await response!.json() as any};
 };
 const behind=await read(`minOwnerPosition=${position}`);
 expect(behind.ms).toBeLessThan(300);
 expect(behind.status).toBe(200);
 expect(behind.value.notReady).toMatchObject({code:'OWNER_POSITION_PENDING',projection:'topics',requiredPosition:position,retryAfterMs:500});
 expect(parseOwnerPosition(behind.value.notReady.appliedPosition)?.sequence).toBe(head-1);

 prepared.query('UPDATE presentation_topics_meta SET source_head=? WHERE singleton=1').run(head);
 const current=await read(`minOwnerPosition=${position}`);
 expect(current.status).toBe(200);
 expect(current.value.notReady).toBeUndefined();
 expect(current.value.coverage.appliedSequence).toBe(head);
 expect(parseOwnerPosition(current.applied!)?.sequence).toBe(head);

 // Without the parameter nothing changes for older callers.
 const plain=await read('');
 expect(plain.value.notReady).toBeUndefined();
 expect(plain.applied).toBeNull();

 const ledger=parseOwnerPosition(position)!.ledger;
 const foreign=await read(`minOwnerPosition=v1.${ledger==='0000000000000000'?'1111111111111111':'0000000000000000'}.1`);
 expect(foreign.status).toBe(409);
 expect(foreign.value.error.code).toBe('OWNER_POSITION_FOREIGN');
 const future=await read(`minOwnerPosition=v1.${ledger}.${head+1000}`);
 expect(future.value.error.code).toBe('OWNER_POSITION_FOREIGN');
 expect((await read('minOwnerPosition=12')).value.error.code).toBe('OWNER_POSITION_INVALID');
 const unsupported=await read(`minOwnerPosition=${position}`,'presentation/messages?');
 expect(unsupported.status).toBe(400);
 expect(unsupported.value.error.code).toBe('OWNER_POSITION_UNSUPPORTED');
 prepared.close();
},30_000);
