import './sqlite-worker-identity';
/** Provider page projection belongs on a separate event loop from sends and page routing. */
const parentPort={postMessage:(reply:unknown)=>process.send?.(reply)};
import {SessionOwner} from './session-owner';
import {log} from './log';
import {sharedCodexAppServerClient} from './codex-app-server-client';
import {readClaudeHistory,readCodexHistory,readCodexHistoryWindow,hasSavedContext} from './provider-history';
import {getSessionById} from './state';
import {sessionMetadata} from './session-inputs';
import {notePhase,timedPhase,withHistoryReadPhases,type HistoryReadPhases} from './history-read-phases';
import {observeStorageOperation} from './storage-observation';

type Work={id:number;operation:'page'|'delta'|'prepare';sessionId:string;cwd:string;cursor:string|null;limit:number;after:string|null;
  want?:{dialogue:number;untilInput:boolean};thread?:string};
if(!process.send)throw new Error('HISTORY_PAGE_WORKER_PARENT_REQUIRED');
// Connect to Codex's App Server when the worker starts, not inside the first history open:
// after a restart the first open of each Codex conversation took 0.3-0.5 s against 0.05-0.25 s
// once warm (2026-10-30). A failed early connection is retried by the first request as before.
void sharedCodexAppServerClient().connect().catch(()=>{});
process.on('disconnect',()=>process.exit(0));
// Each request carries its own record of where its time went back to the read worker, which logs it.
// This worker's own ledger reads (projection and Inbox rows) are measured too: the read worker's
// storage figures cover only its own connection, and the 2026-11-20 phases showed 110-200 ms per
// read in this worker outside every provider call. The answer is sent once that measure is in.
process.on('message',(input:Work)=>{
  const phases:HistoryReadPhases={};const started=performance.now();
  return withHistoryReadPhases(phases,async()=>{
    const reply=await observeStorageOperation('history-page-worker',()=>handle(input),work=>{
      phases.worker_db_calls=work.db_calls;phases.worker_db_ms=Math.round(work.db_duration_ms*10)/10;
      phases.worker_db_slowest_ms=Math.round(work.db_slowest_ms*10)/10;
      if(work.db_slowest_fingerprint)phases.worker_db_slowest=work.db_slowest_fingerprint;
    });
    phases.history_worker_ms=Math.round(performance.now()-started);
    parentPort!.postMessage({...reply,phases});
  });
});
async function handle(input:Work):Promise<Record<string,unknown>>{
  try {
    // Codex activity tops up that conversation's kept window, so the next open reads it ready.
    if(input.operation==='prepare'){
      if(!Number.isSafeInteger(input.id)||typeof input.sessionId!=='string'||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
        ||typeof input.thread!=='string'||!/^[A-Za-z0-9-]{8,80}$/.test(input.thread))
        throw new Error('INVALID_HISTORY_PAGE_WORK');
      const sessionId=Number(input.sessionId.slice('concierge:'.length)),session=Number.isSafeInteger(sessionId)?getSessionById(sessionId):null;
      const metadata=session?sessionMetadata(session):{};
      await readCodexHistoryWindow({sessionUuid:input.thread,
        ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
        ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})});
      return {id:input.id,result:{prepared:true}};
    }
    if(!Number.isSafeInteger(input.id)||input.id<1||!/^concierge:[1-9][0-9]*$/.test(input.sessionId)
      ||!['page','delta'].includes(input.operation)||typeof input.cwd!=='string'||input.cwd.length>4096
      ||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100
      ||input.want!==undefined&&(!Number.isSafeInteger(input.want.dialogue)||input.want.dialogue<0||input.want.dialogue>40||typeof input.want.untilInput!=='boolean'))
      throw new Error('INVALID_HISTORY_PAGE_WORK');
    const ownerStarted=performance.now();
    const owner=new SessionOwner({wake(){},steer(){return false;},async stop(){return false;},available(){return false;},
      history:async(session,cursor,limit)=>{
        if(!session.agent_session_uuid)return null;
        const metadata=sessionMetadata(session);
        const options={sessionUuid:session.agent_session_uuid,cwd:input.cwd,cursor,limit,ownerSessionId:session.id,
          ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
          ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})};
        // The newest page of a window read is the conversation's kept window, not a listing.
        // A kept window that cannot be read or topped up falls back to the ordinary listing.
        if(session.provider_id==='codex'&&!hasSavedContext(session.id)&&cursor===null&&input.operation==='page'&&input.want&&(input.want.dialogue||input.want.untilInput))
          try{return await readCodexHistoryWindow({sessionUuid:session.agent_session_uuid,want:input.want,
            ...(typeof (metadata as any).providerRunner==='string'?{runner:(metadata as any).providerRunner}:{}),
            ...(typeof (metadata as any).providerAccount==='string'?{account:(metadata as any).providerAccount}:{})});}
          catch(error){log('warn','codex_history_window_unavailable',{session_id:session.id,error:String(error).slice(0,300)});}
        return timedPhase('provider_page_ms',async()=>session.provider_id==='claude-code'?readClaudeHistory(options):session.provider_id==='codex'?readCodexHistory(options):null);
      }},input.cwd);
    notePhase('owner_setup_ms',performance.now()-ownerStarted);
    const result=input.operation==='page'
      // A window is collected here, page after page, rather than one worker round trip per page.
      ?await owner.history(input.sessionId,input.cursor,input.limit,false,input.want)
      :await owner.historyDelta(input.sessionId,input.after??'');
    return {id:input.id,result};
  } catch(error) {
    return {id:input.id,error:{message:error instanceof Error?error.message:'History page failed.',
      status:typeof error==='object'&&error!==null&&'status' in error?Number(error.status):503}};
  }
}
