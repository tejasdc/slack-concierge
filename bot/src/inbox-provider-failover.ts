import {db,getSessionById,type SessionRow} from './state';
import {inboxSession} from './session-inbox';
import {newWorkCapacity,capacityCanStart} from './provider-start-choice';
import {nativeRunId,sessionMetadata} from './session-inputs';
import {proposeHandoff} from './session-handoff';
import {log} from './log';

const preparing=new Set<number>();

/** A provider change is proposed once; the successor accepts the normal handoff inventory. */
export function maybeStartInboxProviderFailover(session:SessionRow|null=inboxSession()) {
  if(!session||!['claude-code','codex'].includes(session.provider_id)||sessionMetadata(session).inboxRole!=='project-router'
    ||sessionMetadata(session).suspended||preparing.has(session.id))return;
  const sourceProvider=session.provider_id as 'claude-code'|'codex';
  const targetProvider=sourceProvider==='claude-code'?'codex':'claude-code';
  const current=newWorkCapacity(sourceProvider,Date.now(),sourceProvider==='claude-code');
  const alternative=newWorkCapacity(targetProvider);
  const last=db.query(`SELECT status,dispatch_failure_class,accepted_input_id,
      provider_admission_intended_at,provider_started_at,provider_turn_id,provider_input_acknowledged_at
    FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(session.id) as {
      status:string;dispatch_failure_class:string|null;accepted_input_id:string|null;
      provider_admission_intended_at:string|null;provider_started_at:string|null;
      provider_turn_id:string|null;provider_input_acknowledged_at:string|null}|null;
  const failedBeforeAdmission=!!last&&
    last.status==='queued'&&['auth_wait','backoff','usage_wait'].includes(last.dispatch_failure_class??'')
    &&last.provider_admission_intended_at===null&&last.provider_started_at===null
    &&last.provider_turn_id===null&&last.provider_input_acknowledged_at===null;
  const exhausted=!!current&&current.used>=100&&!current.paidCredits;
  if((!exhausted&&!failedBeforeAdmission)||!alternative||!capacityCanStart(alternative))return;
  if(db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') LIMIT 1").get(session.id))return;
  const source=db.query(`SELECT input.id,turn.id AS turn_id,turn.native_run_id
    FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
    WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
    ORDER BY turn.id DESC LIMIT 1`).get(session.id) as {id:string;turn_id:number;native_run_id:string|null}|null;
  if(!source)return;
  preparing.add(session.id);
  void proposeHandoff({actorSession:session.id,inputId:source.id,runId:source.native_run_id??nativeRunId(source.turn_id),
    predecessorId:session.id,provider:targetProvider==='codex'?'codex':'cc-opus-1m',reason:exhausted
      ?`${sourceProvider} has exhausted its usable allowance; continue the Inbox through its exact handoff inventory.`
      :`${sourceProvider} could not start the Inbox input ${last?.accepted_input_id??'unknown'} before provider admission. Inspect and recover that exact accepted input without replaying any acknowledged effect.`,
    sessionName:'Inbox',actionId:`automatic-inbox-failover:${session.id}`})
    .then(result=>log('warn','inbox_provider_handoff_proposed',{predecessor:session.id,successor:result.successor,handoff_id:result.handoffId}))
    .catch(error=>log('error','inbox_provider_handoff_failed',{predecessor:session.id,error:String(error)}))
    .finally(()=>preparing.delete(session.id));
}
