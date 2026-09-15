import {createHash,randomUUID} from 'node:crypto';
import {sharedCodexAppServerClient} from './codex-app-server-client';
import {codexHistoryMessages} from './provider-history';
import {db,getSessionById,observeExecutionChanges} from './state';
import {recordSessionEvent,sessionMetadata} from './session-inputs';

/** Observing a conversation never admits an input or changes execution ownership. */
export function observeSessionProvider(sessionId:number,onError:()=>void):()=>void {
  const client=sharedCodexAppServerClient();
  let closed=false;
  let binding='';
  let threadId:string|null=null;
  let connectionGeneration:number|null=null;
  const current=()=>{
    const session=getSessionById(sessionId);
    if(!session||session.provider_id!=='codex'||sessionMetadata(session).origin==='imported')return null;
    return session;
  };
  const invalidate=()=>recordSessionEvent({eventId:`history:${sessionId}:${randomUUID()}`,sessionId,kind:'history',payload:{}});
  const fail=()=>{if(!closed)onError();};
  const synchronize=()=>{
    if(closed)return;
    const session=current();
    const next=session?.agent_session_uuid?`${session.binding_generation}:${session.agent_session_uuid}`:'';
    if(next===binding)return;
    binding=next;threadId=session?.agent_session_uuid??null;
    if(!threadId)return;
    const expected=next,expectedThread=threadId;
    void(async()=>{
      const generation=await client.connect();
      if(closed||binding!==expected)return;
      connectionGeneration=generation;
      await client.request('thread/resume',{threadId:expectedThread,excludeTurns:true});
      if(closed||binding!==expected)return;
      // Catch up through native history after attaching or reconnecting, including
      // messages that arrived while this observer was disconnected.
      invalidate();
    })().catch(fail);
  };
  const detachMessages=client.onNotification(event=>{
    if(closed||event.method!=='item/completed')return;
    const params=event.params;
    const session=current();
    if(!session||!threadId||params?.threadId!==threadId||session.agent_session_uuid!==threadId
      ||`${session.binding_generation}:${threadId}`!==binding)return;
    try {
      for(const message of codexHistoryMessages(params.item,params.turnId,threadId)) {
        const turns=db.query('SELECT id FROM turns WHERE session_id=? AND provider_turn_id=?').all(sessionId,message.turnId??null) as {id:number}[];
        const payload={message};
        const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        recordSessionEvent({eventId:`observed:${sessionId}:${binding}:${turns.length===1?turns[0]!.id:0}:${digest}`,sessionId,
          ...(turns.length===1?{turnId:turns[0]!.id}:{}),kind:'message',payload});
      }
    } catch {fail();}
  });
  const detachDisconnect=client.onDisconnect((_error,generation)=>{if(generation===connectionGeneration)fail();});
  const detachChanges=observeExecutionChanges(synchronize);
  synchronize();
  return()=>{closed=true;detachMessages();detachDisconnect();detachChanges();};
}
