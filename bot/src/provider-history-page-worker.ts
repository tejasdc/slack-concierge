/** Provider page projection belongs on a separate event loop from sends and page routing. */
import {parentPort} from 'node:worker_threads';
import {SessionOwner} from './session-owner';
import {log} from './log';
import {readClaudeHistory,readCodexHistory,readCodexHistoryWindow} from './provider-history';

type Work={id:number;operation:'page'|'delta'|'prepare';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null;
  want?:{dialogue:number;untilInput:boolean};thread?:string};
if(!parentPort)throw new Error('HISTORY_PAGE_WORKER_PARENT_REQUIRED');
parentPort.on('message',async(input:Work)=>{
  try {
    // Codex activity tops up that conversation's kept window, so the next open reads it ready.
    if(input.operation==='prepare'){
      if(!Number.isSafeInteger(input.id)||typeof input.thread!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.thread))
        throw new Error('INVALID_HISTORY_PAGE_WORK');
      await readCodexHistoryWindow({sessionUuid:input.thread});
      parentPort!.postMessage({id:input.id,result:{prepared:true}});
      return;
    }
    if(!Number.isSafeInteger(input.id)||input.id<1||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
      ||!['page','delta'].includes(input.operation)||typeof input.cwd!=='string'||input.cwd.length>4096
      ||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100
      ||input.want!==undefined&&(!Number.isSafeInteger(input.want.dialogue)||input.want.dialogue<0||input.want.dialogue>40||typeof input.want.untilInput!=='boolean'))
      throw new Error('INVALID_HISTORY_PAGE_WORK');
    const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
      history:async(session,cursor,limit)=>{
        if(!session.agent_session_uuid)return null;
        const options={sessionUuid:session.agent_session_uuid,cwd:input.cwd,cursor,limit,ownerSessionId:session.id};
        // The newest page of a window read is the conversation's kept window, not a listing.
        // A kept window that cannot be read or topped up falls back to the ordinary listing.
        if(session.provider_id==='codex'&&cursor===null&&input.operation==='page'&&input.want&&(input.want.dialogue||input.want.untilInput))
          try{return await readCodexHistoryWindow({sessionUuid:session.agent_session_uuid});}
          catch(error){log('warn','codex_history_window_unavailable',{session_id:session.id,error:String(error).slice(0,300)});}
        return session.provider_id==='claude-code'?readClaudeHistory(options):session.provider_id==='codex'?readCodexHistory(options):null;
      }},input.cwd);
    const result=input.operation==='page'
      // A window is collected here, page after page, rather than one worker round trip per page.
      ?await owner.history(input.sessionId,input.cursor,input.limit,false,input.want)
      :await owner.historyDelta(input.sessionId,input.after??'');
    parentPort!.postMessage({id:input.id,result});
  } catch(error) {
    parentPort!.postMessage({id:input.id,error:{message:error instanceof Error?error.message:'History page failed.',
      status:typeof error==='object'&&error!==null&&'status' in error?Number(error.status):503}});
  }
});
