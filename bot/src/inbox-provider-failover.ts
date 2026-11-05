import {db,getSessionById,type SessionRow} from './state';
import {inboxSession} from './session-inbox';
import {newWorkCapacity,capacityCanStart} from './provider-start-choice';
import {nativeRunId,sessionMetadata} from './session-inputs';
import {proposeHandoff} from './session-handoff';
import {log} from './log';

const preparing=new Set<number>();

/** A provider change is proposed once; the successor accepts the normal handoff inventory. */
export function maybeStartInboxProviderFailover(session:SessionRow|null=inboxSession()) {
  if(!session||session.provider_id!=='claude-code'||sessionMetadata(session).inboxRole!=='project-router'
    ||sessionMetadata(session).suspended||preparing.has(session.id))return;
  const claude=newWorkCapacity('claude-code');
  const codex=newWorkCapacity('codex');
  if(!claude||claude.used<100||!codex||!capacityCanStart(codex))return;
  if(db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') LIMIT 1").get(session.id))return;
  const source=db.query(`SELECT input.id,turn.id AS turn_id,turn.native_run_id
    FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
    WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
    ORDER BY turn.id DESC LIMIT 1`).get(session.id) as {id:string;turn_id:number;native_run_id:string|null}|null;
  if(!source)return;
  preparing.add(session.id);
  void proposeHandoff({actorSession:session.id,inputId:source.id,runId:source.native_run_id??nativeRunId(source.turn_id),
    predecessorId:session.id,provider:'codex',reason:'Every usable Claude account has exhausted its included allowance; continue the Inbox through its exact handoff inventory.',
    sessionName:'Inbox',actionId:`automatic-inbox-exhaustion:${session.id}`})
    .then(result=>log('warn','inbox_provider_handoff_proposed',{predecessor:session.id,successor:result.successor,handoff_id:result.handoffId}))
    .catch(error=>log('error','inbox_provider_handoff_failed',{predecessor:session.id,error:String(error)}))
    .finally(()=>preparing.delete(session.id));
}
