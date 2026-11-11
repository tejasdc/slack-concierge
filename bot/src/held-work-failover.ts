import {db,getSessionById,type SessionRow} from './state';
import {newWorkCapacity,capacityCanStart,type AutomaticProvider} from './provider-start-choice';
import {AUTOMATIC_PROVIDER_ALIASES} from './aliases';
import {nativeRunId,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {proposeHandoff,queuedWorkMovable,withdrawHandoff} from './session-handoff';
import {log} from './log';

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

type Candidate={id:number;oldest_turn_id:number;owes_inbox:number};

function sourceCannotStart(session:SessionRow):boolean {
  const capacity=newWorkCapacity(session.provider_id as AutomaticProvider,Date.now(),session.provider_id==='claude-code');
  const exhausted=!!capacity&&capacity.used>=100&&!capacity.paidCredits;
  const usageHeld=!!db.query(`SELECT 1 FROM turns WHERE session_id=? AND status='queued' AND dispatch_hold='usage' LIMIT 1`).get(session.id);
  return exhausted||(usageHeld&&(!capacity||!capacityCanStart(capacity)));
}

/** A provider the session may move to: automatic, not its own, with room below the stop line. Google
 * only for a session the owner itself started as a small task, matching automatic choice. */
function receiver(session:SessionRow) {
  const small=!!sessionMetadata(session).automaticSmallTask;
  return automatic.filter(provider=>provider!==session.provider_id&&(provider!=='antigravity'||small))
    .map(provider=>newWorkCapacity(provider))
    .filter((room):room is NonNullable<typeof room>=>!!room&&capacityCanStart(room)&&room.used<RECEIVER_STOP_PERCENT)
    .sort((a,b)=>Number(a.provider==='antigravity')-Number(b.provider==='antigravity')||a.used-b.used)[0]??null;
}

function eligible(session:SessionRow|null):session is SessionRow {
  if(!session||session.status==='archived'||!automatic.includes(session.provider_id as AutomaticProvider))return false;
  const meta=sessionMetadata(session);
  // His own provider or model choice stays: only a session whose provider the owner picked moves.
  // The Inbox and standing roles have their own failover; a paused or consultation-only session holds.
  if(meta.automaticProviderChoice!==true||meta.inbox||meta.inboxRole||meta.repairAgent||meta.standingRole
    ||meta.suspended||meta.interactionPolicy==='consultation-only')return false;
  const skipped=typeof meta.heldFailoverSkipUntil==='number'?meta.heldFailoverSkipUntil:0;
  return skipped<=Date.now();
}

/** Withdraw automatic proposals the successor did not accept and is no longer working on. */
function settleUnacceptedProposals():void {
  const stale=db.query(`SELECT handoff.id,handoff.predecessor_session_id,handoff.successor_session_id FROM session_handoffs handoff
    WHERE handoff.state='proposed' AND handoff.action_id LIKE ? AND handoff.created_at<=datetime('now',?)
      AND NOT EXISTS (SELECT 1 FROM turns WHERE session_id=handoff.successor_session_id AND status IN ('queued','running','delivering'))`)
    .all(`${ACTION_PREFIX}%`,`-${Math.round(UNACCEPTED_PROPOSAL_MS/1000)} seconds`) as {id:string;predecessor_session_id:number;successor_session_id:number}[];
  for(const row of stale){
    try{
      withdrawHandoff({actorSession:row.predecessor_session_id,handoffId:row.id});
      updateSessionMetadata(row.predecessor_session_id,{heldFailoverSkipUntil:Date.now()+RETRY_AFTER_MS});
      log('warn','held_work_failover_withdrawn',{handoff_id:row.id,predecessor:row.predecessor_session_id,successor:row.successor_session_id});
    }catch(error){log('error','held_work_failover_withdraw_failed',{handoff_id:row.id,error:String(error)});}
  }
}

/** Moved sessions still working: a proposal not yet settled, or a successor with work it can run. A
 * successor whose own provider later ran out holds its queue and no longer counts against the pace. */
function inFlight():number {
  return (db.query(`SELECT count(*) AS count FROM session_handoffs handoff WHERE handoff.action_id LIKE ?
    AND (handoff.state='proposed' OR (handoff.state='accepted' AND EXISTS (SELECT 1 FROM turns
      WHERE session_id=handoff.successor_session_id AND (status IN ('running','delivering')
        OR (status='queued' AND COALESCE(dispatch_hold,'')<>'usage')))))`)
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
      AND NOT EXISTS (SELECT 1 FROM session_handoffs WHERE predecessor_session_id=turn.session_id AND state IN ('proposed','accepted'))
    GROUP BY turn.session_id ORDER BY owes_inbox DESC,oldest_turn_id LIMIT 40`).all() as Candidate[];
}

/** One paced pass. Runs on the owner after each provider usage reading. */
export function moveHeldWork():number {
  if(passing)return 0;
  passing=true;
  try{
    settleUnacceptedProposals();
    let room=FAILOVER_IN_FLIGHT-inFlight();
    let proposed=0;
    for(const candidate of room>0?candidates():[]){
      if(room<=0)break;
      const session=getSessionById(candidate.id);
      if(!eligible(session)||!sourceCannotStart(session))continue;
      if(db.query(`SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','parked','interrupted','delivery_parked') LIMIT 1`).get(session.id))continue;
      const target=receiver(session);
      if(!target)continue; // Nothing has room above the stop line for this session; it keeps waiting.
      const {movable}=queuedWorkMovable(session.id);
      if(!movable){
        // An input that may have reached its provider settles where it is; try again later.
        updateSessionMetadata(session.id,{heldFailoverSkipUntil:Date.now()+RETRY_AFTER_MS});
        log('info','held_work_failover_unmovable',{session_id:session.id});
        continue;
      }
      const source=db.query(`SELECT input.id,turn.id AS turn_id,turn.native_run_id FROM session_inputs input
        JOIN turns turn ON turn.id=input.turn_id WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
        ORDER BY turn.id DESC LIMIT 1`).get(session.id) as {id:string;turn_id:number;native_run_id:string|null}|null;
      if(!source)continue;
      const sourceProvider=session.provider_id;
      room--;proposed++;
      // Mark first so the next pass does not propose twice while this one awaits its inventory.
      updateSessionMetadata(session.id,{heldFailoverSkipUntil:Date.now()+UNACCEPTED_PROPOSAL_MS});
      void proposeHandoff({actorSession:session.id,inputId:source.id,runId:source.native_run_id??nativeRunId(source.turn_id),
        predecessorId:session.id,provider:AUTOMATIC_PROVIDER_ALIASES[target.provider],
        reason:`${sourceProvider} has no allowance to start this session's queued work and ${target.provider} has room. Continue it through the exact handoff inventory; only inputs that never reached ${sourceProvider} move.`,
        actionId:`${ACTION_PREFIX}${session.id}:${source.id}`})
        .then(result=>{
          // The successor's provider was also the owner's choice, so it can move again later.
          const successor=Number(String(result.successor).slice('concierge:'.length));
          if(successor)updateSessionMetadata(successor,{automaticProviderChoice:true});
          log('warn','held_work_failover_proposed',{predecessor:session.id,successor:result.successor,handoff_id:result.handoffId,
            from:sourceProvider,to:target.provider,receiver_used:target.used,owes_inbox:!!candidate.owes_inbox});
        })
        .catch(error=>log('error','held_work_failover_failed',{predecessor:session.id,error:String(error)}));
    }
    return proposed;
  }catch(error){
    // A failed pass must not stop the other work that follows a usage reading.
    log('error','held_work_failover_pass_failed',{error:String(error)});return 0;
  }finally{passing=false;}
}
