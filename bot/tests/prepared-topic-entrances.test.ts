import {expect,test} from 'bun:test';
import {SessionOwner} from '../src/session-owner';
import {parseRouterSessionsArgs} from '../scripts/router-sessions';

test('old topic HTTP entrances use bounded preparation and report missing coverage',async()=>{
 const owner=new SessionOwner({available:()=>false,wake:()=>{},steer:()=>false,stop:async()=>false},'/tmp');
 // No Inbox or presentation has been created. Canonical reconstruction would throw;
 // these entrances must instead expose that preparation has not completed.
 for(const path of ['topics','topics/resolve?message=old-message','topics/old-topic','questions']){
  const response=await owner.handle(new Request(`http://fixture/sessions/v1/inbox/${path}`));
  expect(response?.status).toBe(200);
  const value=await response!.json() as any;
  expect(value.coverage.complete).toBe(false);
  expect(value.coverage.code).toBe('presentation_indexing');
 }
});

test('agents can follow bounded topic pages and exact detail without creating an action',()=>{
 const source=['--source-input','fixture-input','--source-run','fixture-run'];
 const page=parseRouterSessionsArgs(['topics','items','topic-one',...source,'--kind','questions','--cursor','next','--limit','20']);
 expect(page).toMatchObject({operation:'topics',body:{verb:'items',topic_id:'topic-one',kind:'questions',cursor:'next',limit:20}});
 const detail=parseRouterSessionsArgs(['topics','detail','topic-one',...source,'--digest','a'.repeat(64),'--part','2']);
 expect(detail).toMatchObject({operation:'topics',body:{verb:'detail',topic_id:'topic-one',digest:'a'.repeat(64),part:2}});
});
