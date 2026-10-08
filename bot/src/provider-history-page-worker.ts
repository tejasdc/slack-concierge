/** Provider page projection belongs on a separate event loop from sends and page routing. */
import {parentPort} from 'node:worker_threads';
import {SessionOwner} from './session-owner';
import {readClaudeHistory,readCodexHistory} from './provider-history';

type Work={id:number;operation:'page'|'delta';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null};
if(!parentPort)throw new Error('HISTORY_PAGE_WORKER_PARENT_REQUIRED');
parentPort.on('message',async(input:Work)=>{
  try {
    if(!Number.isSafeInteger(input.id)||input.id<1||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
      ||!['page','delta'].includes(input.operation)||typeof input.cwd!=='string'||input.cwd.length>4096
      ||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>20)
      throw new Error('INVALID_HISTORY_PAGE_WORK');
    const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
      history:async(session,cursor,limit)=>{
        if(!session.agent_session_uuid)return null;
        const options={sessionUuid:session.agent_session_uuid,cwd:input.cwd,cursor,limit,ownerSessionId:session.id};
        return session.provider_id==='claude-code'?readClaudeHistory(options):session.provider_id==='codex'?readCodexHistory(options):null;
      }},input.cwd);
    const result=input.operation==='page'
      ?await owner.history(input.sessionId,input.cursor,input.limit)
      :await owner.historyDelta(input.sessionId,input.after??'');
    parentPort!.postMessage({id:input.id,result});
  } catch(error) {
    parentPort!.postMessage({id:input.id,error:{message:error instanceof Error?error.message:'History page failed.',
      status:typeof error==='object'&&error!==null&&'status' in error?Number(error.status):503}});
  }
});
