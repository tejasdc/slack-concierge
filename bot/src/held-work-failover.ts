import {db,getSessionById,type SessionRow} from './state';
import {newWorkCapacity,capacityCanStart,type AutomaticProvider} from './provider-start-choice';
import {AUTOMATIC_PROVIDER_ALIASES,aliasKeepingTier,normalizeReasoningEffort} from './aliases';
import {nativeRunId,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {proposeHandoff,queuedWorkMovable,withdrawHandoff} from './session-handoff';
import {log} from './log';
import {automaticMoveRefusal,type MoveKindRefusal} from './automatic-move-kind';

/**
 * Moves agent sessions whose queued work their provider cannot start (its allowance is spent or a
 * confirmed usage wall holds the work) to an automatic provider with room, through the ordinary
 * provider-change handoff: the successor reads the inventory, accepts it, and only replay-safe
 * queued inputs move. Until 2026-11-11 only the Inbox did this; about 38 Codex sessions holding his
 * open requests sat queued for a day and a half while Claude had room, and the Diwali session was
 * moved by hand.
 *
 * Pace: at most FAILOVER_IN_FLIGHT moved sessions work at once, and a pass proposes at most that many.
 * On 2026-11-06 37 sessions starting together froze the owner for 51 s (incident 474d66cd); the
 * usage reading that runs a pass comes every few minutes, so moves trickle.
 * Headroom: no new move once the receiving provider's measured use reaches RECEIVER_STOP_PERCENT, so
 * the last account with room is not spent dry by moved backlog. The rest waits for its own reset.
 */
export const FAILOVER_IN_FLIGHT=2;
export const RECEIVER_STOP_PERCENT=75;
/** A proposal its successor has not accepted by then, with nothing left running there, is withdrawn. */
export const UNACCEPTED_PROPOSAL_MS=30*60_000;
/** A withdrawn or unmovable session is not tried again for this long, so it never blocks the queue. */
export const RETRY_AFTER_MS=6*60*60_000;
const ACTION_PREFIX='automatic-held-failover:';

const automatic=Object.keys(AUTOMATIC_PROVIDER_ALIASES) as AutomaticProvider[];
let passing=false;
/** Proposals whose inventory read is still running, before their handoff row exists. */
let preparing=0;

type Candidate={id:number;oldest_turn_id:number;owes_inbox:number};

function sourceCannotStart(session:SessionRow):boolean {
  const capacity=newWorkCapacity(session.provider_id as AutomaticProvider,Date.now(),session.provider_id==='claude-code');
  const exhausted=!!capacity&&capacity.used>=100&&!capacity.paidCredits;
  const usageHeld=!!db.query(`SELECT 1 FROM turns WHERE session_id=? AND status='queued' AND dispatch_hold='usage' LIMIT 1`).get(session.id);
  return exhausted||(usageHeld&&(!capacity||!capacityCanStart(capacity)));
}

/** A provider the session may move to: automatic, not its own, with room below the stop line. Google
 * only for a session the owner itself started as a small task, matching automatic choice. */
function receiver(session:SessionRow):{target:NonNullable<ReturnType<typeof newWorkCapacity>>|null;reason:'no_receiver'|'receiver_above_stop'|null} {
  const small=!!sessionMetadata(session).automaticSmallTask;
  const startable=automatic.filter(provider=>provider!==session.provider_id&&(provider!=='antigravity'||small))
    .map(provider=>newWorkCapacity(provider))
    .filter((room):room is NonNullable<typeof room>=>!!room&&capacityCanStart(room));
  // The receiver with the most room across its accounts, not merely the roomiest single account.
  const target=startable.filter(room=>room.used<RECEIVER_STOP_PERCENT)
    .sort((a,b)=>Number(a.provider==='antigravity')-Number(b.provider==='antigravity')||b.providerRoom-a.providerRoom||a.used-b.used)[0]??null;
  return {target,reason:target?null:startable.length?'receiver_above_stop':'no_receiver'};
}

/**
 * Pinned means Tejas himself chose this session's provider or model: the owner recorded it at creation
 * (providerChosenBy), or, for sessions made before that record, his own create named a provider or model,
 * or his model control cleared Automatic's choice. An agent-passed --provider, the owner's own transfers
 * and handoff successors are not his choice and may move. PINNED_SQL must match this rule.
 */
export const PINNED_SQL=`(COALESCE(json_extract(session.native_metadata_json,'$.providerChosenBy'),'')='tejas'
  OR json_extract(session.native_metadata_json,'$.automaticProviderChoice') IS 0
  OR EXISTS (SELECT 1 FROM session_inputs made WHERE made.session_id=session.id AND made.kind='create' AND made.origin='human'
    AND (COALESCE(json_extract(made.payload_json,'$.provider'),'auto')<>'auto' OR json_extract(made.payload_json,'$.model') IS NOT NULL)))`;

export function pinned(session:SessionRow):boolean {
  const meta=sessionMetadata(session);
  return meta.providerChosenBy==='tejas'||meta.automaticProviderChoice===false
    ||!!db.query(`SELECT 1 FROM session_inputs made WHERE made.session_id=? AND made.kind='create' AND made.origin='human'
      AND (COALESCE(json_extract(made.payload_json,'$.provider'),'auto')<>'auto' OR json_extract(made.payload_json,'$.model') IS NOT NULL) LIMIT 1`).get(session.id);
}

/** At most one skip line per session and reason in this window, in memory: a restart may repeat one. */
const SKIP_LOG_WINDOW_MS=30*60_000;
const skipLogged=new Map<string,number>();
type SkipReason='pinned'|'source_can_start'|'no_receiver'|'receiver_above_stop'|'busy'|'unmovable'|MoveKindRefusal;
function logSkip(sessionId:number,reason:SkipReason):void {
  const key=`${sessionId}:${reason}`,now=Date.now();
  if((skipLogged.get(key)??0)+SKIP_LOG_WINDOW_MS>now)return;
  if(skipLogged.size>2000)for(const [k,at] of skipLogged)if(at+SKIP_LOG_WINDOW_MS<=now)skipLogged.delete(k);
  skipLogged.set(key,now);
  log('info','held_work_failover_skipped',{session_id:sessionId,reason});
}

function eligible(session:SessionRow|null):session is SessionRow {
  if(!session||session.status==='archived'||!automatic.includes(session.provider_id as AutomaticProvider))return false;
  const meta=sessionMetadata(session);
  // His own provider or model choice stays: only a session whose provider the owner picked moves.
  // The Inbox and every standing role move by standing-role-provider-failover.ts; a paused or
  // consultation-only session holds.
  if(meta.automaticProviderChoice!==true||meta.inbox||meta.inboxRole||meta.repairAgent||meta.standingRole
    ||meta.suspended||meta.interactionPolicy==='consultation-only')return false;
  const skipped=typeof meta.heldFailoverSkipUntil==='number'?meta.heldFailoverSkipUntil:0;
  return skipped<=Date.now();
}

/** Withdraw automatic proposals the successor did not accept in time and is not working on now. A brief
 * still queued (its own provider held, say) counts as not working, so a proposal never pins the pace. */
function settleUnacceptedProposals():void {
  const stale=db.query(`SELECT handoff.id,handoff.predecessor_session_id,handoff.successor_session_id FROM session_handoffs handoff
    WHERE handoff.state='proposed' AND handoff.action_id LIKE ? AND handoff.created_at<=datetime('now',?)
      AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id=handoff.successor_session_id AND status IN ('running','delivering'))`)
    .all(`${ACTION_PREFIX}%`,`-${Math.round(UNACCEPTED_PROPOSAL_MS/1000)} seconds`) as {id:string;predecessor_session_id:number;successor_session_id:number}[];
  for(const row of stale){
    try{
      withdrawHandoff({actorSession:row.predecessor_session_id,handoffId:row.id});
      updateSessionMetadata(row.predecessor_session_id,{heldFailoverSkipUntil:Date.now()+RETRY_AFTER_MS});
      log('warn','held_work_failover_withdrawn',{handoff_id:row.id,predecessor:row.predecessor_session_id,successor:row.successor_session_id});
    }catch(error){log('error','held_work_failover_withdraw_failed',{handoff_id:row.id,error:String(error)});}
  }
}

/** Moved sessions still working: a proposal not yet settled, or a successor still running or able to run
 * the work the move carried (its handoff brief and moved inputs, all retained under the handoff's scope).
 * A successor's later, unrelated work does not count: on 2026-11-16 a session moved on Nov 11 held one
 * of the two slots for five days just by being busy, so Codex's wall moved one session instead of
 * thirteen. A successor whose own provider later ran out holds its queue and no longer counts either. */
function inFlight():number {
  return preparing+(db.query(`SELECT count(*) AS count FROM session_handoffs handoff WHERE handoff.action_id LIKE ?
    AND (handoff.state='proposed' OR (handoff.state='accepted' AND EXISTS (SELECT 1 FROM turns turn
      JOIN session_inputs carried ON carried.id=turn.accepted_input_id AND carried.scope='handoff:'||handoff.id
      WHERE turn.session_id=handoff.successor_session_id AND (turn.status IN ('running','delivering')
        OR (turn.status='queued' AND COALESCE(turn.dispatch_hold,'')<>'usage')))))`)
    .get(`${ACTION_PREFIX}%`) as {count:number}).count;
}

/**
 * Sessions holding queued work, those the Inbox dispatched his open requests to first, then the
 * longest waiting. The Inbox has no structured due date, so a dated deadline cannot be ranked
 * separately from the request itself.
 */
function candidates():Candidate[] {
  return db.query(`SELECT turn.session_id AS id,MIN(turn.id) AS oldest_turn_id,
      EXISTS (SELECT 1 FROM session_communication_requests request
        JOIN inbox_requests inbox ON inbox.state='open'
        JOIN json_each(inbox.dispatches_json) dispatch ON json_extract(dispatch.value,'$.requestId')=request.request_id
        WHERE request.target_session_id=turn.session_id AND request.outcome IS NULL) AS owes_inbox
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE turn.status='queued' AND session.status<>'archived' AND session.provider_id IN ('claude-code','codex','antigravity')
      AND NOT ${PINNED_SQL}
      AND COALESCE(json_extract(session.native_metadata_json,'$.inbox'),0)=0
      AND COALESCE(json_extract(session.native_metadata_json,'$.inboxRole'),'')=''
      AND COALESCE(json_extract(session.native_metadata_json,'$.repairAgent'),0)=0
      AND COALESCE(json_extract(session.native_metadata_json,'$.standingRole'),'')=''
      AND COALESCE(json_extract(session.native_metadata_json,'$.suspended'),0)=0
      AND COALESCE(json_extract(session.native_metadata_json,'$.heldFailoverSkipUntil'),0)<=?
      AND NOT EXISTS (SELECT 1 FROM turns busy WHERE busy.session_id=turn.session_id
        AND busy.status IN ('running','delivering','parked','interrupted','delivery_parked'))
      AND NOT EXISTS (SELECT 1 FROM session_handoffs WHERE predecessor_session_id=turn.session_id AND state IN ('proposed','accepted'))
    GROUP BY turn.session_id ORDER BY owes_inbox DESC,oldest_turn_id LIMIT 40`).all(Date.now()) as Candidate[];
}

/** One paced pass. Runs on the owner after each provider usage reading. */
export function moveHeldWork():number {
  if(passing)return 0;
  passing=true;
  try{
    settleUnacceptedProposals();
    let room=FAILOVER_IN_FLIGHT-inFlight();
    let proposed=0;
    logPinnedHeld();
    for(const candidate of room>0?candidates():[]){
      if(room<=0)break;
      try{if(considerCandidate(candidate)){room--;proposed++;}}
      catch(error){
        // One session's bad record must not stop the pass or sit first in every later one.
        try{updateSessionMetadata(candidate.id,{heldFailoverSkipUntil:Date.now()+RETRY_AFTER_MS});}catch{}
        log('error','held_work_failover_candidate_failed',{session_id:candidate.id,error:String(error)});
      }
    }
    return proposed;
  }catch(error){
    // A failed pass must not stop the other work that follows a usage reading.
    log('error','held_work_failover_pass_failed',{error:String(error)});return 0;
  }finally{passing=false;}
}

/** Pinned sessions are filtered out of the page so they cannot fill it; their wait is still named once. */
function logPinnedHeld():void {
  const rows=db.query(`SELECT DISTINCT turn.session_id AS id FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE turn.status='queued' AND session.status<>'archived' AND session.provider_id IN ('claude-code','codex','antigravity')
      AND ${PINNED_SQL} LIMIT 40`).all() as {id:number}[];
  for(const row of rows){
    const session=getSessionById(row.id);
    if(session&&eligible(session)&&sourceCannotStart(session))logSkip(row.id,'pinned');
  }
}

function considerCandidate(candidate:Candidate):boolean {
    const session=getSessionById(candidate.id);
    if(!eligible(session))return false;
    // Only coding work moves by itself; a discussion, brainstorm, design or Lab session waits for its
    // own provider (automatic-move-kind.ts).
    const kind=automaticMoveRefusal(session);
    if(kind){logSkip(session.id,kind);return false;}
    if(!sourceCannotStart(session)){logSkip(session.id,'source_can_start');return false;}
    if(db.query(`SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','parked','interrupted','delivery_parked') LIMIT 1`).get(session.id)){logSkip(session.id,'busy');return false;}
    const {target,reason}=receiver(session);
    if(!target){logSkip(session.id,reason!);return false;} // Nothing has room above the stop line for this session; it keeps waiting.
    const {movable}=queuedWorkMovable(session.id);
    if(!movable){
      // An input that may have reached its provider settles where it is; try again later.
      updateSessionMetadata(session.id,{heldFailoverSkipUntil:Date.now()+RETRY_AFTER_MS});
      log('info','held_work_failover_unmovable',{session_id:session.id});
      logSkip(session.id,'unmovable');
      return false;
    }
    const source=db.query(`SELECT input.id,turn.id AS turn_id,turn.native_run_id FROM session_inputs input
      JOIN turns turn ON turn.id=input.turn_id WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
      ORDER BY turn.id DESC LIMIT 1`).get(session.id) as {id:string;turn_id:number;native_run_id:string|null}|null;
    if(!source)return false;
    const sourceProvider=session.provider_id;
    // Mark first so the next pass does not propose twice while this one awaits its inventory.
    updateSessionMetadata(session.id,{heldFailoverSkipUntil:Date.now()+UNACCEPTED_PROPOSAL_MS});
    // Each attempt has its own action: a withdrawn proposal's identity would otherwise return the
    // withdrawn row as a duplicate and the session would never move again.
    const attempt=(db.query(`SELECT count(*) AS count FROM session_handoffs WHERE predecessor_session_id=? AND action_id LIKE ?`)
      .get(session.id,`${ACTION_PREFIX}%`) as {count:number}).count+1;
    // The successor keeps the predecessor's model tier and, where its provider takes one, its effort.
    const meta=sessionMetadata(session);
    const sourceModel=meta.model??(db.query(`SELECT provider_model FROM turns WHERE session_id=? AND provider_model IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(session.id) as {provider_model:string}|null)?.provider_model??null;
    const successorAlias=aliasKeepingTier(target.provider,sourceModel);
    const successorEffort=target.provider!=='antigravity'&&meta.reasoningEffort?normalizeReasoningEffort(meta.reasoningEffort):null;
    preparing++;
    void proposeHandoff({actorSession:session.id,inputId:source.id,runId:source.native_run_id??nativeRunId(source.turn_id),
      predecessorId:session.id,provider:successorAlias,...(successorEffort?{effort:successorEffort}:{}),
      reason:`${sourceProvider} has no allowance to start this session's queued work and ${target.provider} has room. Continue it through the exact handoff inventory; only inputs that never reached ${sourceProvider} move.`,
      actionId:`${ACTION_PREFIX}${session.id}:${attempt}`})
      .then(result=>{
        // The successor's provider was also the owner's choice, so it can move again later.
        const successor=Number(String(result.successor).slice('concierge:'.length));
        if(successor)updateSessionMetadata(successor,{automaticProviderChoice:true});
        log('warn','held_work_failover_proposed',{predecessor:session.id,successor:result.successor,handoff_id:result.handoffId,
          from:sourceProvider,to:target.provider,receiver_used:target.used,owes_inbox:!!candidate.owes_inbox});
      })
      .catch(error=>log('error','held_work_failover_failed',{predecessor:session.id,error:String(error)}))
      .finally(()=>{preparing--;});
    return true;
}
