import type { Database } from 'bun:sqlite';
import type { SessionRow } from './state';

/** The last host that actually started this native provider conversation. */
export function lastLaunchedConversationHome(db:Database,sessionId:number,provider:string):
    {supervisor:string;runner:string|null}|null {
  return db.query(`SELECT execution.supervisor,attempt.runner FROM executions execution
    LEFT JOIN runner_attempts attempt ON attempt.job_id='turn:'||execution.execution_id
    WHERE execution.session_id=? AND execution.provider=? AND execution.unit IS NOT NULL
    ORDER BY execution.created_at_ms DESC,attempt.started_at_ms DESC LIMIT 1`)
    .get(sessionId,provider) as {supervisor:string;runner:string|null}|null;
}

/** One answer to whether an existing native provider conversation has a provable home.
 * New sessions without a provider UUID use the current placement choice; existing UUIDs
 * require a saved binding, a launched execution, an exact parent for a fork, or a local
 * resurrection record. Current configuration is never evidence for an existing thread. */
export function nativeConversationHome(db:Database,session:SessionRow,metadata:Record<string,any>,
  getSession:(id:number)=>SessionRow|null,seen=new Set<number>()):{known:boolean;runner:string|null;reason:string|null} {
  if(!['claude-code','antigravity'].includes(session.provider_id))return {known:true,runner:null,reason:null};
  if(Object.hasOwn(metadata,'providerRunner'))return {known:true,runner:metadata.providerRunner??null,reason:null};
  if(!session.agent_session_uuid)return {known:true,runner:null,reason:null};
  if(seen.has(session.id))return {known:false,runner:null,reason:'The conversation home cannot be recovered from its circular fork lineage.'};
  seen.add(session.id);
  const launched=lastLaunchedConversationHome(db,session.id,session.provider_id);
  if(launched){
    if(launched.supervisor==='runner')return launched.runner
      ?{known:true,runner:launched.runner,reason:null}
      :{known:false,runner:null,reason:`This ${session.provider_id} conversation ran on a runner, but its exact runner lease is unavailable.`};
    return {known:true,runner:null,reason:null};
  }
  if(metadata.lineage&&session.parent_session_id){
    const parent=getSession(session.parent_session_id);
    if(parent?.provider_id===session.provider_id)return nativeConversationHome(db,parent,JSON.parse(parent.native_metadata_json||'{}'),getSession,seen);
  }
  if(metadata.resurrection)return {known:true,runner:null,reason:null};
  return {known:false,runner:null,reason:`This ${session.provider_id} conversation has no saved machine binding and no exact execution record; refusing to guess its home.`};
}
