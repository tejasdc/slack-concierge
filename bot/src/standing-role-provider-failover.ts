import {db,type SessionRow} from './state';
import {newWorkCapacity,capacityCanStart,type AutomaticProvider} from './provider-start-choice';
import {AUTOMATIC_PROVIDER_ALIASES,aliasKeepingTier,normalizeReasoningEffort} from './aliases';
import {anyModelRefused} from './provider-model-capacity';
import {nativeRunId,sessionMetadata} from './session-inputs';
import {proposeHandoff} from './session-handoff';
import {log} from './log';
import {holdsInbox} from './inbox-session-pin';

const preparing=new Set<number>();

/**
 * A standing role other than the pinned Inbox (the repair agent, the journal keeper, …)
 * role) is one logical job served by one session at a time. When that session's provider cannot
 * start its work and another automatic provider has room, the owner proposes the ordinary
 * provider-change handoff; acceptance moves the role to the successor (session-handoff.ts).
 * Until 2026-11-16 only the Inbox had this: the repair role sat on Codex with no room from Nov 7
 * 06:34 to Nov 9 03:08 UTC while Claude had room, and nobody acted on its repair notices.
 */
function roleOf(session:SessionRow):string|null {
  const meta=sessionMetadata(session);
  if(meta.inboxRole==='project-router')return 'inbox';
  if(typeof meta.standingRole==='string'&&meta.standingRole)return meta.standingRole;
  return meta.repairAgent?'concierge-repair':null;
}

/** Every session currently holding a standing role. A short list (one per role). */
function roleHolders():SessionRow[] {
  return db.query(`SELECT * FROM sessions WHERE status<>'archived'
      AND COALESCE(json_extract(native_metadata_json,'$.suspended'),0)=0
      AND (json_extract(native_metadata_json,'$.inboxRole')='project-router'
        OR COALESCE(json_extract(native_metadata_json,'$.standingRole'),'')<>''
        OR COALESCE(json_extract(native_metadata_json,'$.repairAgent'),0)=1)`).all() as SessionRow[];
}

/** One pass over every standing role after a provider usage reading. */
export function moveStandingRolesOffSpentProviders():void {
  for(const session of roleHolders()){
    try{maybeStartStandingRoleFailover(session);}
    catch(error){log('error','standing_role_failover_failed',{session_id:session.id,error:String(error)});}
  }
}

/** A provider change is proposed once; the successor accepts the normal handoff inventory. */
export function maybeStartStandingRoleFailover(session:SessionRow|null) {
  // Every automatic provider can hold a role, so every one can be left and every other one can take
  // over. Until 2026-11-09 only Claude and Codex were handled: the Inbox on Gemini (concierge:9305) had
  // no way out when Gemini ran out while Claude still had room.
  const automatic=Object.keys(AUTOMATIC_PROVIDER_ALIASES) as AutomaticProvider[];
  if(!session||holdsInbox(session)||session.status==='archived'||!automatic.includes(session.provider_id as AutomaticProvider)
    ||sessionMetadata(session).suspended||preparing.has(session.id))return;
  const role=roleOf(session);
  if(!role||role==='inbox')return;
  const sourceProvider=session.provider_id as AutomaticProvider;
  const current=newWorkCapacity(sourceProvider,Date.now(),sourceProvider==='claude-code');
  // Another provider with room takes over: Claude or Codex first (most total room wins), Gemini only
  // when neither has room, because automatic choice keeps Gemini for small tasks and roles are long-running.
  const alternatives=automatic.filter(provider=>provider!==sourceProvider)
    .map(provider=>newWorkCapacity(provider)).filter((candidate):candidate is NonNullable<typeof candidate>=>!!candidate&&capacityCanStart(candidate))
    .sort((a,b)=>Number(a.provider==='antigravity')-Number(b.provider==='antigravity')||b.providerRoom-a.providerRoom||a.used-b.used);
  const alternative=alternatives[0]??null;
  if(!alternative)return;
  const last=db.query(`SELECT status,dispatch_failure_class,accepted_input_id,
      provider_admission_intended_at,provider_started_at,provider_turn_id,provider_input_acknowledged_at
    FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1`).get(session.id) as {
      status:string;dispatch_failure_class:string|null;accepted_input_id:string|null;
      provider_admission_intended_at:string|null;provider_started_at:string|null;
      provider_turn_id:string|null;provider_input_acknowledged_at:string|null}|null;
  const usageHeld=db.query(`SELECT accepted_input_id FROM turns
    WHERE session_id=? AND status='queued' AND dispatch_hold='usage' ORDER BY id LIMIT 1`)
    .get(session.id) as {accepted_input_id:string|null}|null;
  const failedBeforeAdmission=!!last&&
    last.status==='queued'&&['auth_wait','backoff','usage_wait'].includes(last.dispatch_failure_class??'')
    &&last.provider_admission_intended_at===null&&last.provider_started_at===null
    &&last.provider_turn_id===null&&last.provider_input_acknowledged_at===null;
  // Gemini answers a spent quota with "Individual quota reached", which is remembered as a model at
  // capacity and drops Gemini from the usage readings, so neither the reading nor a usage hold showed
  // it and the Inbox concierge:9305 stayed stuck (2026-11-11). Only Gemini uses that record for a spent
  // quota; a Claude or Codex capacity refusal is a short busy spell and must not move a role.
  const exhausted=(!!current&&current.used>=100&&!current.paidCredits)
    ||(sourceProvider==='antigravity'&&anyModelRefused(sourceProvider));
  const confirmedUsageWall=!!usageHeld&&(!current||!capacityCanStart(current));
  const waiting=!!db.query(`SELECT 1 FROM turns WHERE session_id=? AND status='queued' LIMIT 1`).get(session.id);
  // Move only waiting work on confirmed allowance evidence, not a passing sign-in or busy spell.
  const usageRefused=failedBeforeAdmission&&last?.dispatch_failure_class==='usage_wait';
  const moves=confirmedUsageWall||usageRefused||(exhausted&&waiting);
  if(!moves)return;
  if(db.query("SELECT 1 FROM session_handoffs WHERE predecessor_session_id=? AND state IN ('proposed','accepted') LIMIT 1").get(session.id))return;
  const source=db.query(`SELECT input.id,turn.id AS turn_id,turn.native_run_id
    FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
    WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
    ORDER BY turn.id DESC LIMIT 1`).get(session.id) as {id:string;turn_id:number;native_run_id:string|null}|null;
  if(!source)return;
  const meta=sessionMetadata(session);
  const targetProvider=alternative.provider;
  // Keep model tier and reasoning effort, as held-work failover does.
  const sourceModel=meta.model??(db.query(`SELECT provider_model FROM turns WHERE session_id=? AND provider_model IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get(session.id) as {provider_model:string}|null)?.provider_model??null;
  const provider=aliasKeepingTier(targetProvider,sourceModel);
  const effort=targetProvider!=='antigravity'&&meta.reasoningEffort?normalizeReasoningEffort(meta.reasoningEffort):null;
  const job=`the ${role} standing role`;
  const attempt=(db.query(`SELECT count(*) AS count FROM session_handoffs WHERE predecessor_session_id=? AND action_id LIKE ?`)
    .get(session.id,'automatic-%-failover:%') as {count:number}).count+1;
  preparing.add(session.id);
  void proposeHandoff({actorSession:session.id,inputId:source.id,runId:source.native_run_id??nativeRunId(source.turn_id),
    predecessorId:session.id,provider,...(effort?{effort}:{}),reason:exhausted||confirmedUsageWall
      ?`${sourceProvider} has exhausted its usable allowance and ${targetProvider} has room; continue ${job} through its exact handoff inventory.`
      :`${sourceProvider} could not start ${job}'s input ${last?.accepted_input_id??'unknown'} before provider admission. Inspect and recover that exact accepted input without replaying any acknowledged effect.`,
    ...(meta.title?{sessionName:meta.title}:{}),
    actionId:`automatic-role-failover:${session.id}:${attempt}`})
    .then(result=>log('warn','standing_role_provider_handoff_proposed',{role,predecessor:session.id,successor:result.successor,
      handoff_id:result.handoffId,from:sourceProvider,to:targetProvider}))
    .catch(error=>log('error','standing_role_provider_handoff_failed',{role,predecessor:session.id,error:String(error)}))
    .finally(()=>preparing.delete(session.id));
}

