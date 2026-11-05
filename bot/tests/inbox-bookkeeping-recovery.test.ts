import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {db} from '../src/state';
import {createNativeSession,recordSessionEvent,retainSessionInput} from '../src/session-inputs';
import {keepThreadsCurrent,migrateInboxTopics,retireRecoveredBookkeepingRequests} from '../src/session-topics';
import {acquireDatabaseTestLock} from './db-lock';

test('recovery retains human work without turning service bookkeeping into human requests',async()=>{
  const unlock=await acquireDatabaseTestLock();
  try{
    const inbox=createNativeSession('codex',{title:'Inbox recovery fixture',summary:'Inbox recovery fixture',inbox:true});
    const accepted=(origin:'human'|'service',id:string,text:string)=>{
      retainSessionInput({id,sessionId:inbox.id,scope:origin==='human'?'surface:thinkering':`session:${id}`,
        actionId:randomUUID(),kind:'input',origin,payload:{text}});
      recordSessionEvent({eventId:`accepted:${id}`,sessionId:inbox.id,inputId:id,kind:'accepted',payload:{text}});
    };
    accepted('human',`human-${randomUUID()}`,'Please keep this work open.');
    const bookkeeping=`area-theme:${randomUUID()}`;
    accepted('service',bookkeeping,'These open threads are close in meaning.');
    const returned=`return:${randomUUID()}`;
    accepted('service',returned,'The agent answered the earlier request.');
    const upkeep=`thread-upkeep:${randomUUID()}`;
    accepted('service',upkeep,'An earlier request still needs attention.');
    const returnedUpkeep=`thread-upkeep:${randomUUID()}`;
    accepted('service',returnedUpkeep,'The returned result needs no new request.');
    const migrated=migrateInboxTopics();
    expect(migrated.migrated).toBe(true);
    expect((db.query("SELECT count(*) AS n FROM inbox_requests WHERE state='open'").get() as {n:number}).n).toBe(1);
    expect(db.query("SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?").get(bookkeeping)).toBeNull();
    expect(db.query("SELECT 1 FROM inbox_topic_roots WHERE root_input_id IN (?,?,?)").get(returned,upkeep,returnedUpkeep)).toBeNull();

    // Simulate the older migration's already-retained synthetic topic and request through
    // the same owner event projection, then prove the correction is replayable and idempotent.
    const {applyTopicChange}=await import('../src/session-topics');
    const at=new Date().toISOString();
    const by={kind:'owner',sessionId:`concierge:${inbox.id}`};
    const syntheticRequests=[bookkeeping,returned,upkeep].map(root=>{
      const topicId=`topic:${randomUUID()}`,requestId=`req:${randomUUID()}`;
      const topic={topicId,sessionId:inbox.id,title:'Service bookkeeping',summary:'',state:'open',setAside:null,
        aliases:[],revision:1,recovered:true,readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
      const request={requestId,topicId,title:topic.title,brief:'',state:'open',disposition:null,revision:1,
        sources:[{inputId:root}],dispatches:[],closure:null,createdAt:at,updatedAt:at};
      const roots=root===returned?[root,returnedUpkeep]:[root];
      const payload={change:'created',topicId,topic,roots:roots.map(rootInputId=>({rootInputId,topicId,placedAt:at,placedBy:by,reason:'old migration'})),
        request,questions:[],by,reason:'old migration',revision:1,recovered:true};
      recordSessionEvent({eventId:`topic-migration:${root}`,sessionId:inbox.id,kind:'topic',payload});
      applyTopicChange('topic',payload);
      if(root===upkeep) {
        const assigned={...request,dispatches:[{requestId:randomUUID()}],revision:2,updatedAt:new Date().toISOString()};
        const next={...topic,revision:2,updatedAt:assigned.updatedAt};
        const assignment={change:'linked',topicId,topic:next,request:assigned,by,reason:'later agent work',revision:2};
        recordSessionEvent({eventId:`assigned:${root}`,sessionId:inbox.id,kind:'topic_request',payload:assignment});
        applyTopicChange('topic_request',assignment);
      }
      return requestId;
    });
    expect(retireRecoveredBookkeepingRequests()).toEqual({retired:2});
    expect(retireRecoveredBookkeepingRequests()).toEqual({retired:0});
    for(const requestId of syntheticRequests.slice(0,2))
      expect((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(requestId) as {state:string}).state).toBe('closed');
    expect((db.query('SELECT state FROM inbox_requests WHERE request_id=?').get(syntheticRequests[2]!) as {state:string}).state).toBe('open');
    expect((db.query("SELECT count(*) AS n FROM inbox_requests WHERE state='open'").get() as {n:number}).n).toBe(2);
    const admitted:string[]=[];
    keepThreadsCurrent(input=>{admitted.push(input.requestId);});
    for(const requestId of syntheticRequests.slice(0,2))expect(admitted).not.toContain(requestId);
  }finally{unlock();}
});
