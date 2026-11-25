import {db,claimNextQueuedTurn,executionChanged,getClaudePreferredModel,getSessionById,globalPauseHoldsSession,paceLapsedUsageHolds,settleTurnDependencies,type QueuedTurnClaimRow} from './state';
import {enqueueSessionInput,getAcceptedSessionInput,nativeRunId,queueTurnContinuation,recordSessionEvent,retainSessionInput,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {providerAccountUsage} from './provider-account-usage';
import {usageForecasts} from './provider-usage-forecast';
import type {AccountIdentityProvider} from './provider-accounts';
import {savedWorkAccountRooms} from './provider-account-dispatch';
import {includedAllowanceWindows} from './account-allowance-observation';
import {chooseAccountForTurn} from './provider-account-choice';
import {log,errorFields} from './log';
import {API_CREDITS_ACCOUNT,apiRouteRunnerHasKey,apiCreditsConfigured,apiCreditsCycle,apiCreditsNextGrantAt,apiRouteDecision} from './claude-api-route';
import {holdsInbox} from './inbox-session-pin';
import {endRepeatingScheduleForInput} from './request-liveness';
import {savedStartAt} from './saved-start-time';
import {inQuietHours,localParts,nextQuietEnd,quietOnlyAdmits,QUIET_STOP_MARGIN_MS} from './quiet-hours';
import {localDayGap,nextDailyWallClock,validDailyWallClock,type DailyWallClock} from './daily-wall-clock';
export {savedStartAt} from './saved-start-time';

export type SavedKind='scheduled'|'banked';
export type SavedTurn={id:number;session_id:number;status:string;saved_kind:SavedKind;saved_at_ms:number;saved_expires_at_ms:number|null;saved_manual_start:number;
  saved_quiet_only:number;
  saved_repeat_ms:number|null;saved_root_id:number|null;saved_sequence:number|null;saved_fire_at_ms:number|null;
  saved_daily_time:string|null;saved_time_zone:string|null;
  saved_account:string|null;saved_window:string|null;saved_boundary_ms:number|null;dispatch_next_attempt_ms:number|null;dispatch_failure_class:string|null;
  saved_alerted_at_ms:number|null;accepted_input_id:string|null;saved_wait_reason?:string|null};

const DAY=24*60*60_000, HOUR=60*60_000;
export type SavedWorkSettings={quiet_start_hour:number;quiet_end_hour:number;reserve_percent:number;wait_days:number;time_zone:string};
export function savedWorkSettings():SavedWorkSettings {
  return db.query('SELECT quiet_start_hour,quiet_end_hour,reserve_percent,wait_days,time_zone FROM saved_work_settings WHERE singleton=1').get() as SavedWorkSettings;
}
export function changeSavedWorkSettings(value:Partial<SavedWorkSettings>):SavedWorkSettings {
  const before=savedWorkSettings(),next={...before,...value};
  if(!Number.isInteger(next.quiet_start_hour)||next.quiet_start_hour<0||next.quiet_start_hour>23||
    !Number.isInteger(next.quiet_end_hour)||next.quiet_end_hour<0||next.quiet_end_hour>23||
    next.quiet_start_hour===next.quiet_end_hour||!Number.isInteger(next.reserve_percent)||
    next.reserve_percent<0||next.reserve_percent>=100||!Number.isInteger(next.wait_days)||
    next.wait_days<1||next.wait_days>365||typeof next.time_zone!=='string')throw new Error('Invalid saved work settings.');
  try {new Intl.DateTimeFormat('en-US',{timeZone:next.time_zone});}
  catch {throw new Error('Choose a valid time zone.');}
  db.query(`UPDATE saved_work_settings SET quiet_start_hour=?,quiet_end_hour=?,reserve_percent=?,wait_days=?,time_zone=? WHERE singleton=1`)
    .run(next.quiet_start_hour,next.quiet_end_hour,next.reserve_percent,next.wait_days,next.time_zone);
  if(next.wait_days!==before.wait_days)db.query(`UPDATE turns SET saved_expires_at_ms=saved_at_ms+? WHERE saved_kind='banked' AND status='queued'`)
    .run(next.wait_days*DAY);
  reconsiderBankedWork();
  return next;
}

/** The first turn exists while it waits. Later inputs join this session's ordinary FIFO. */
/**
 * `continuationOf` names the one turn that may already exist in this session: the banked run a
 * boundary stopped, whose work continues as a new message. Without it the ownership rule below
 * refused every continuation, the whole resume rolled back, and a run a Concierge update
 * interrupted was left with no continuation at all.
 */
export function saveQueuedTurn(turnId:number,kind:SavedKind,atMs?:number,expiresAtMs?:number,repeatEveryMs?:number,continuationOf?:number,standingRole?:string,quietOnly=false,daily?:DailyWallClock):void {
  const now=Date.now();
  if(quietOnly&&kind!=='banked')throw new Error('Quiet-only work must be banked.');
  if(kind==='scheduled'&&(!Number.isFinite(atMs)||atMs!<=now))throw new Error('Schedule a future instant.');
  if(expiresAtMs!==undefined&&(!Number.isFinite(expiresAtMs)||expiresAtMs<=(atMs??now)))throw new Error('Expiry must follow the scheduled time.');
  if(repeatEveryMs!==undefined&&(kind!=='scheduled'||!Number.isSafeInteger(repeatEveryMs)||repeatEveryMs<60_000))throw new Error('Repeat interval must be at least one minute.');
  if(daily&&(!validDailyWallClock(daily)||kind!=='scheduled'||repeatEveryMs!==DAY||atMs!==nextDailyWallClock(now,daily)))
    throw new Error('Daily local time must match the next scheduled instant.');
  db.transaction(()=>{
    const turn=db.query('SELECT session_id,status,saved_kind FROM turns WHERE id=?').get(turnId) as {session_id:number;status:string;saved_kind:string|null}|null;
    if(!turn||turn.status!=='queued'||turn.saved_kind)throw new Error('Only a new queued turn can be saved.');
    if(!standingRole){
      const other=db.query('SELECT 1 FROM turns WHERE session_id=? AND id<>? AND id IS NOT ? LIMIT 1')
        .get(turn.session_id,turnId,continuationOf??null);
      if(other)throw new Error('Saved work needs its own session.');
    }else if(repeatEveryMs){
      const existing=db.query(`SELECT id FROM turns WHERE session_id=? AND id<>? AND status='queued'
        AND saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL ORDER BY id LIMIT 1`)
        .get(turn.session_id,turnId) as {id:number}|null;
      if(existing)throw new Error(`The ${standingRole} role already has repeating schedule ${existing.id} queued. Change its time in Thinkering Saved work, or cancel it with sessions saved cancel ${existing.id} before scheduling another.`);
    }
    const inherited=continuationOf?savedTurn(continuationOf)?.saved_quiet_only===1:false;
    const next=kind==='scheduled'?atMs!:null;
    db.query(`UPDATE turns SET saved_kind=?,saved_at_ms=?,saved_expires_at_ms=?,dispatch_failure_class=NULL,dispatch_next_attempt_ms=?,
      saved_fire_at_ms=?,saved_repeat_ms=?,saved_root_id=?,saved_sequence=?,saved_quiet_only=?,saved_daily_time=?,saved_time_zone=? WHERE id=?`)
      .run(kind,now,kind==='scheduled'?expiresAtMs??null:now+savedWorkSettings().wait_days*DAY,next,next,
        repeatEveryMs??null,repeatEveryMs?turnId:null,repeatEveryMs?0:null,quietOnly||inherited?1:0,daily?.time??null,daily?.timeZone??null,turnId);
  })();
  executionChanged();
}

function localOffset(ms:number,settings:SavedWorkSettings) {
  const p=localParts(ms,settings);
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ms/1000)*1000;
}
const quiet=inQuietHours;
function nextQuietStart(now:number,settings:SavedWorkSettings):number {
  const p=localParts(now,settings);
  for(let day=0;day<3;day++) {
    const wall=Date.UTC(p.year,p.month-1,p.day+day,settings.quiet_start_hour);
    let candidate=wall-localOffset(wall,settings);
    candidate=wall-localOffset(candidate,settings);
    if(candidate>now)return candidate;
  }
  return now+DAY;
}
export function quietOnlyCutoff(now:number,settings=savedWorkSettings()){return nextQuietEnd(now,settings)-QUIET_STOP_MARGIN_MS;}
const savedRows=()=>db.query("SELECT * FROM turns WHERE saved_kind IS NOT NULL AND status='queued' ORDER BY id").all() as SavedTurn[];

/**
 * Why a queued banked turn is not starting, in words the asking agent can act on. Stored on the
 * turn and logged when it changes, because on 2026-11-12 a quiet-only job had waited seven nights
 * and nothing recorded which of its conditions had held it.
 */
export type BankedWait='eligible_not_claimed'|'no_usage_reading'|'stale_usage_reading'|'no_allowance_room'
  |'window_runs_out_first'|'other_work_running'|'outside_quiet_hours'|'waiting_for_reset';
export const BANKED_WAIT_WORDS:Record<BankedWait,string>={
  eligible_not_claimed:'it was eligible to start but the queue did not take it (another unattended banked job was running, or a pause or Concierge update held the queue)',
  no_usage_reading:'Concierge had no current allowance reading for its provider',
  stale_usage_reading:'every account reading for its provider was stale, and banked work never runs on a reading Concierge cannot trust',
  no_allowance_room:'no account had allowance left above the saved-work reserve',
  window_runs_out_first:'an account had room, but every window it could spend is forecast to be used up by his own work before it resets, so there is nothing about to lapse',
  // Retained for rows stored before 2026-11-25, when banked work stopped waiting for an idle
  // fleet. Nothing writes it now; a notice about an older waiting job still needs its words.
  other_work_running:'other agent work was running or queued, and generic banked work waited for an idle fleet',
  outside_quiet_hours:'it was outside the quiet hours',
  waiting_for_reset:'it is waiting until its allowance window is close to resetting',
};

/**
 * Whether a banked Claude turn runs on the API credit. A session already on the route always does
 * while credit is left; another takes the route only before its first conversation exists and in the
 * cycle's last week (unspent credit is lost at expiry; subscription windows renew anyway).
 */
const API_BANKED_MODELS=new Set(['claude-opus-5-5','claude-sonnet-5-5']);
export function bankedApiRoute(session:NonNullable<ReturnType<typeof getSessionById>>,model:string|null,now:number):{expiresAt:number;reason:string}|null {
  const metadata=sessionMetadata(session);
  const cycle=apiCreditsCycle(db,now);
  if(metadata.claudeRoute==='api-credits'){
    const decision=apiRouteDecision('overflow',cycle,now,apiCreditsConfigured());
    return decision.use?{expiresAt:cycle.expiresAt,reason:'this session runs on the API credit'}:null;
  }
  if(session.agent_session_uuid!==null||holdsInbox(session)||metadata.standingRole||metadata.inbox||metadata.repairAgent
    ||metadata.outside||!apiRouteRunnerHasKey(metadata.providerRunner)||metadata.providerAccount||!model||!API_BANKED_MODELS.has(model))return null;
  const decision=apiRouteDecision('banked',cycle,now,apiCreditsConfigured());
  return decision.use?{expiresAt:cycle.expiresAt,reason:decision.reason}:null;
}

/** Forecast and reachability are read outside the claim. Only changed instants are written. */
export function reconsiderBankedWork(now=Date.now()):number {
  const settings=savedWorkSettings();let changed=0;
  for(const row of savedRows().filter(row=>row.saved_kind==='banked')) {
    if(row.saved_manual_start)continue;
    if(row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now)continue;
    const session=getSessionById(row.session_id);
    if(!session||!['codex','claude-code','antigravity'].includes(session.provider_id))continue;
    const provider=session.provider_id as AccountIdentityProvider;
    const usage=providerAccountUsage(provider);
    const model=provider==='claude-code'
      ?getClaudePreferredModel(row.session_id,row.id)??sessionMetadata(session).model??null:undefined;
    const api=provider==='claude-code'?bankedApiRoute(session,model??null,now):null;
    if(api){
      // The API credit has no allowance window or reserve: it lapses at the cycle's
      // expiry whatever else runs, so the run is bounded by that expiry (claude-api-route.ts).
      const quietOnly=row.saved_quiet_only===1;
      const eligible=!quietOnly||quietOnlyAdmits(now,settings);
      const next=eligible?0:nextQuietStart(now,settings),boundary=eligible?api.expiresAt:null;
      const wait:BankedWait=eligible?'eligible_not_claimed':'outside_quiet_hours';
      if(eligible&&sessionMetadata(session).claudeRoute!=='api-credits'){
        updateSessionMetadata(session.id,{claudeRoute:'api-credits'});
        recordSessionEvent({eventId:`claude-route:${row.id}`,sessionId:session.id,turnId:row.id,
          kind:'claude_route',payload:{route:'api-credits',why:'banked',reason:api.reason}});
        log('info','claude_api_route_chosen',{turn_id:row.id,session_id:session.id,why:'banked',reason:api.reason});
      }
      if(row.saved_wait_reason!==wait)db.query("UPDATE turns SET saved_wait_reason=? WHERE id=? AND status='queued' AND saved_kind='banked'").run(wait,row.id);
      if(row.dispatch_next_attempt_ms===next&&row.saved_account===(eligible?API_CREDITS_ACCOUNT:null)
        &&row.saved_window===(eligible?API_CREDITS_ACCOUNT:null)&&row.saved_boundary_ms===boundary)continue;
      changed+=db.query(`UPDATE turns SET dispatch_next_attempt_ms=?,saved_account=?,saved_window=?,saved_boundary_ms=?
        WHERE id=? AND status='queued' AND saved_kind='banked'`).run(next,eligible?API_CREDITS_ACCOUNT:null,eligible?API_CREDITS_ACCOUNT:null,boundary,row.id).changes;
      continue;
    }
    // An API-route session never binds a subscription account, even when its credit is spent: it
    // waits for the next grant (or a manual start, which ends plainly if the credit is still gone).
    if(provider==='claude-code'&&sessionMetadata(session).claudeRoute==='api-credits'){
      const wait:BankedWait='no_allowance_room';
      if(row.saved_wait_reason!==wait)db.query("UPDATE turns SET saved_wait_reason=? WHERE id=? AND status='queued' AND saved_kind='banked'").run(wait,row.id);
      const next=apiCreditsNextGrantAt(now);
      if(row.saved_account===null&&row.saved_window===null&&row.saved_boundary_ms===null&&row.dispatch_next_attempt_ms===next)continue;
      changed+=db.query(`UPDATE turns SET dispatch_next_attempt_ms=?,saved_account=NULL,saved_window=NULL,saved_boundary_ms=NULL
        WHERE id=? AND status='queued' AND saved_kind='banked'`).run(next,row.id).changes;
      continue;
    }
    const rooms=usage?savedWorkAccountRooms(provider,usage,now,model):[];
    const quietOnly=row.saved_quiet_only===1;
    const reserve=settings.reserve_percent;
    /** Room means a fresh reading of that account with its tightest window above the reserve. */
    const hasRoom=(label:string)=>{
      const room=rooms.find(item=>item.account===label);
      return !!room&&!room.problem&&room.tightestUsedPercent!==null&&room.tightestUsedPercent<100-reserve;
    };
    // "The forecast says the window reaches its reset unspent" is the waste banking exists to
    // prevent, and a fresh reading with no projected exhaustion is exactly that evidence. Until
    // 2026-11-25 this demanded a *positive* projection instead (`source!=='unknown'`, or the
    // provider's own `willLastToReset`), which an account nobody is spending can never produce:
    // no consumption means no rate, so no projection. Every generic banked item therefore waited
    // for evidence its own idleness made impossible, and all three in the bank expired unused
    // while two accounts sat at 0% and 6% of their weeks. Claude lost the other escape on
    // 2026-11-01, when account usage moved to each account's own login, which reports no
    // `willLastToReset` at all. A stale reading is still refused, by `hasRoom`: a reading that is
    // not fresh carries no percentage.
    const candidate=usage?usageForecasts(provider).filter(window=>window.resetsAt
      &&usage.accounts.some(account=>account.label===window.account
        &&includedAllowanceWindows(provider,account,model).some(item=>item.name===window.window))
      && chooseAccountForTurn({accounts:rooms,bound:{account:window.account,reason:'spending-this-window'},prefer:null}).account===window.account
      && !window.runsOutBeforeReset && window.usedPercent<100-reserve
      && hasRoom(window.account)
      && (quietOnly||Date.parse(window.resetsAt)>=now+HOUR))
      .sort((a,b)=>Date.parse(a.resetsAt!)-Date.parse(b.resetsAt!))[0]:null;
    const account=candidate?.account??null;
    const reset=candidate?Date.parse(candidate.resetsAt!):null;
    // No banked work waits for an idle fleet. Quiet-only work stopped doing so on 2026-11-12,
    // because some standing agent is always running overnight; generic banked work was left with
    // it and so never ran either — the gate counts every queued ordinary turn fleet-wide, so one
    // waiting item anywhere holds the whole bank. What protects his own work is the reserve, the
    // choice of the account whose allowance lapses first, and the timing: outside his quiet hours
    // generic banked work only runs in the last two hours before that window resets, when the
    // allowance really is about to vanish. The design said as much: "At 3pm, idleness predicts
    // nothing. What protects him at 3pm is therefore not the clock but the reserve."
    const timely=quietOnly?quietOnlyAdmits(now,settings):quiet(now,settings)||(reset!==null&&reset-now<=2*HOUR);
    const eligible=!!candidate&&timely;
    const readable=rooms.some(room=>!room.problem&&room.tightestUsedPercent!==null);
    const wait:BankedWait=eligible?'eligible_not_claimed'
      :!usage?'no_usage_reading'
      :!readable?'stale_usage_reading'
      :!candidate?(rooms.some(room=>hasRoom(room.account))?'window_runs_out_first':'no_allowance_room')
      :quietOnly?'outside_quiet_hours':'waiting_for_reset';
    const next=eligible?0:quietOnly?nextQuietStart(now,settings):reset!==null?Math.min(nextQuietStart(now,settings),Math.max(now+60_000,reset-2*HOUR))
      :row.dispatch_next_attempt_ms!==null&&row.dispatch_next_attempt_ms>now+3*60_000?row.dispatch_next_attempt_ms:null;
    const boundary=eligible?(quietOnly?quietOnlyCutoff(now,settings):reset):null;
    // After the quiet window closes, keep the reason that held it during the window: that is what
    // the missed-window notice reports, and "it was outside the quiet hours" would explain nothing.
    if(row.saved_wait_reason!==wait&&!(quietOnly&&wait==='outside_quiet_hours'&&row.saved_wait_reason)){
      db.query("UPDATE turns SET saved_wait_reason=? WHERE id=? AND status='queued' AND saved_kind='banked'").run(wait,row.id);
      log('info','banked_work_wait',{turn_id:row.id,session_id:`concierge:${row.session_id}`,quiet_only:quietOnly,
        reason:wait,previous:row.saved_wait_reason,account:candidate?.account??null,window:candidate?.window??null});
    }
    if(row.dispatch_next_attempt_ms===next&&row.saved_account===(eligible?account:null)
      &&row.saved_window===(eligible?candidate!.window:null)&&row.saved_boundary_ms===boundary)continue;
    const result=db.query(`UPDATE turns SET dispatch_next_attempt_ms=?,saved_account=?,saved_window=?,saved_boundary_ms=?
      WHERE id=? AND status='queued' AND saved_kind='banked'`).run(next,eligible?account:null,eligible?candidate!.window:null,boundary,row.id);
    changed+=result.changes;
  }
  if(changed)executionChanged();
  return changed;
}

/**
 * The asking agent hears, once per quiet window, that its quiet-only job did not start and why,
 * so a job never reaches its expiry silently. The notice is an overdue event on the request that
 * banked the job; the request delivery wakes the asker with it and withdraws it if the request
 * settles first.
 */
export function noticeMissedQuietWindows(now=Date.now()):number {
  const settings=savedWorkSettings();let noticed=0;
  const inWindow=quietOnlyAdmits(now,settings);
  // The most recent morning cutoff at or before now.
  const cutoff=nextQuietEnd(now-DAY,settings)-QUIET_STOP_MARGIN_MS;
  const windowJustEnded=!inWindow&&cutoff<=now&&now-cutoff<DAY;
  const rows=db.query(`SELECT * FROM turns WHERE saved_kind='banked' AND saved_quiet_only=1 AND status='queued'
    AND saved_manual_start=0`).all() as SavedTurn[];
  for(const row of rows){
    const expired=row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now;
    // A window counts only when the job was waiting for most of it and had not expired by its end.
    const missedWindow=windowJustEnded&&row.saved_at_ms<cutoff-60*60_000
      &&(row.saved_expires_at_ms===null||row.saved_expires_at_ms>cutoff);
    if(!expired&&!missedWindow)continue;
    const reason=(row.saved_wait_reason??'eligible_not_claimed') as BankedWait;
    const why=BANKED_WAIT_WORDS[reason]??reason;
    const nextOpen=nextQuietStart(now,settings);
    const gone=row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=nextOpen;
    const last=gone||row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=quietOnlyCutoff(nextOpen+1,settings);
    const text=expired
      ?`Its quiet-only banked job (turn ${row.id}) expired at ${new Date(row.saved_expires_at_ms!).toISOString()} without starting; the last recorded reason was that ${why}. Start it with sessions saved start ${row.id} during quiet hours, or bank it again.`
      :`Its quiet-only banked job (turn ${row.id}) did not start in the quiet window that ended ${new Date(cutoff).toISOString()}, because ${why}.`
      +(gone?` It expires ${new Date(row.saved_expires_at_ms!).toISOString()}, before the next quiet window opens: start it with sessions saved start ${row.id} during quiet hours, or bank it again.`
        :` It will try again from ${new Date(nextOpen).toISOString()}${row.saved_expires_at_ms!==null?` until it expires ${new Date(row.saved_expires_at_ms).toISOString()}`:''}.`
          +(last?' That next quiet window is its last chance; if the reason above will not clear by then, start it yourself during quiet hours or bank it again.':''));
    const key=expired?`quiet-expired:${row.id}`:`quiet-window-missed:${row.id}:${cutoff}`;
    // A continuation turn carries a service input whose ancestry leads to the banking request.
    const request=row.accepted_input_id?db.query(`WITH RECURSIVE ancestry(id,source_input_id) AS (
        SELECT id,source_input_id FROM session_inputs WHERE id=?
        UNION
        SELECT parent.id,parent.source_input_id FROM session_inputs parent JOIN ancestry child ON parent.id=child.source_input_id
      ) SELECT request.request_id FROM ancestry JOIN session_communication_requests request ON request.target_input_id=ancestry.id
      WHERE request.outcome IS NULL ORDER BY request.rowid DESC LIMIT 1`).get(row.accepted_input_id) as {request_id:string}|null:null;
    if(!request){
      // Nobody asked through a request (a job banked by hand); the expiry alert in
      // inspectSavedWork still reaches Tejas.
      log('warn','quiet_window_missed_without_request',{turn_id:row.id,session_id:`concierge:${row.session_id}`,reason,expired});
      continue;
    }
    const inserted=db.query(`INSERT OR IGNORE INTO session_communication_events(event_id,request_id,kind,action_key,payload_json,created_at_ms)
      VALUES(?,?,'overdue',?,?,?)`).run(key,request.request_id,key,JSON.stringify({text,held:true,savedWorkWait:{turnId:row.id,reason,expired}}),now);
    if(inserted.changes){
      noticed++;
      log('warn','quiet_window_missed',{turn_id:row.id,request_id:request.request_id,reason,last_window:last,expired});
    }
  }
  if(noticed)executionChanged();
  return noticed;
}

/** A declined or boundary-yielded banked run remains saved without a retry failure. */
export function yieldBankedTurn(turnId:number,owner:string,nextMs=Date.now()+3*60_000):boolean {
  const result=db.query(`UPDATE turns SET status='queued',owner_instance_id=NULL,
    dispatch_failure_class=NULL,dispatch_next_attempt_ms=?,saved_account=NULL,saved_window=NULL,saved_boundary_ms=NULL,
    ended_at=NULL
    WHERE id=? AND owner_instance_id=? AND status='running' AND saved_kind='banked'
      -- A Stop he asked for must stay stopped. The same cancellation arrives here whether the
      -- system paused its own work at a boundary or he pressed Stop, and only this tells them
      -- apart: without it his Stop is discarded on the next claim and a manually started run
      -- restarts itself minutes later, spending the allowance he just declined.
      AND stop_requested_at IS NULL
      AND provider_admission_intended_at IS NULL`).run(nextMs,turnId,owner);
  if(result.changes)executionChanged();
  return !!result.changes;
}

export function resumeBankedAfterYield(turnId:number,reason:'allowance_boundary'|'deployment_boundary'|'quiet_boundary'):boolean {
  // An admitted provider may already have pushed or deployed, so its opening input is never
  // queued again. The stopped turn is kept as the record of what happened, and the work
  // continues as a new message that says where it got to — which is what the entry point
  // below is for. Its ordering requirement is satisfied by construction: this runs after the
  // turn has ended, and a source without an end is refused, leaving the run held.
  const changed=db.transaction(()=>{
    const row=savedTurn(turnId);
    if(!row||row.status!=='cancelled'||!row.accepted_input_id){
      if(row?.status!=='running'&&row?.status!=='delivering')db.query('UPDATE turns SET saved_yield_reason=NULL WHERE id=?').run(turnId);
      return false;
    }
    const question=reason==='quiet_boundary'
      ?'Quiet-only banked work stopped before morning. Check what the agent completed before deciding how to continue.'
      :reason==='deployment_boundary'
      ?'Banked work stopped for a deployment after it started. Check what the agent completed before deciding how to continue.'
      :'Banked work stopped at its allowance boundary after it started. Check what the agent completed before deciding how to continue.';
    db.query(`UPDATE turns SET agent_text=COALESCE(agent_text,?) WHERE id=? AND status='cancelled'`).run(question,turnId);
    // Deliberately not an attention declaration. A boundary stop happens at 3am, and a
    // needs_you here reaches the notifier and wakes him for something he cannot act on
    // until morning. The design says a banked run leaves a record, not a notification;
    // the row reads it from this event and the retained text above.
    // Key by (turn, reason) so the same turn can fire for a quiet boundary and a deployment
    // boundary separately. Same class as the 2026-11-19 event-identity incident.
    recordSessionEvent({eventId:`saved-yield:${turnId}:${reason}`,sessionId:row.session_id,inputId:row.accepted_input_id,
      turnId,kind:'saved_control',payload:{action:'stopped_at_boundary',reason,text:question}});
    // Continue with new words, never a replay: this run may already have pushed or deployed.
    // The entry point refuses a source it cannot safely continue — a deliberate human Stop, a
    // session that has moved on, a status it does not accept — and a refusal is not a failure
    // here: the run stays held for him, which is what happened before this existed.
    const continued=queueTurnContinuation(turnId,{kind:'boundary',
      detail:reason==='quiet_boundary'?'the quiet work window was ending':reason==='deployment_boundary'?'a Concierge update was waiting':'the allowance it was spending reset',
      ...(row.dispatch_next_attempt_ms?{waitUntilMs:row.dispatch_next_attempt_ms}:{})});
    // A continuation of banked work is still banked work: without this it would be ordinary
    // work that simply runs at its time, unbound to an account and outside the reserve.
    if(continued?.turn_id&&!savedTurn(continued.turn_id))saveQueuedTurn(continued.turn_id,'banked',undefined,undefined,undefined,turnId);
    // No continuation (a human Stop, a withdrawn request, a session that moved on): the pause is
    // not carried on after all, so its request settles as the cancellation it is.
    if(!continued?.turn_id)db.query('UPDATE turns SET saved_yield_reason=NULL WHERE id=?').run(turnId);
    return true;
  })();
  executionChanged();
  return changed;
}

export function updateSavedTurn(turnId:number,action:string,body:Record<string,unknown>) {
  if(!Number.isSafeInteger(turnId)||turnId<1)throw new Error('Name an exact saved turn.');
  if(!['start','time','schedule','drop','daily'].includes(action))throw new Error('Choose start, time, schedule, daily or drop.');
  const actionId=body.clientActionId;
  if(typeof actionId!=='string'||!actionId.trim())throw new Error('Stable client action identity required.');
  const eventId=`saved-control:${turnId}:${actionId}`;
  const result=db.transaction(()=>{
    const prior=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
    if(prior) {
      const kept=JSON.parse(prior.payload_json);
      if(action==='daily'&&(kept.action!=='daily'||kept.time!==body.time||kept.timeZone!==body.timeZone))
        throw new Error('This action ID already names a different saved-work change.');
      return {turn:savedTurn(turnId)};
    }
    const row=savedTurn(turnId);
    if(!row||row.status!=='queued')throw new Error('This saved work is no longer waiting.');
    if(action==='daily') {
      if(typeof body.time!=='string'||typeof body.timeZone!=='string'||!validDailyWallClock({time:body.time,timeZone:body.timeZone}))
        throw new Error('Name a valid HH:MM time and IANA time zone.');
      const daily={time:body.time,timeZone:body.timeZone};
      if(row.saved_kind!=='scheduled'||row.saved_repeat_ms===null||row.saved_root_id===null||row.saved_manual_start)
        throw new Error('Only a queued repeating schedule can move to daily local time.');
      const latest=db.query('SELECT id FROM turns WHERE saved_root_id=? ORDER BY saved_sequence DESC LIMIT 1')
        .get(row.saved_root_id) as {id:number}|null;
      if(latest?.id!==row.id||repeatingScheduleEnded(row.saved_root_id,row.id))
        throw new Error('This repeating schedule is no longer active.');
      const at=nextDailyWallClock(Date.now(),daily);
      db.query('UPDATE turns SET saved_daily_time=?,saved_time_zone=? WHERE id=?')
        .run(daily.time,daily.timeZone,row.saved_root_id);
      db.query(`UPDATE turns SET saved_daily_time=?,saved_time_zone=?,saved_fire_at_ms=?,dispatch_next_attempt_ms=?
        WHERE id=? AND status='queued'`).run(daily.time,daily.timeZone,at,at,row.id);
      if(row.accepted_input_id)db.query(`UPDATE session_communication_requests SET due_at_ms=?
        WHERE target_input_id=? AND outcome IS NULL`).run(at+15*60_000,row.accepted_input_id);
    } else if(action==='time'||action==='schedule') {
    if(row.saved_quiet_only)throw new Error('Quiet-only work cannot be converted to a daytime schedule. Drop it and create an explicitly scheduled request.');
    if(action==='time'&&row.saved_kind!=='scheduled')throw new Error('Use schedule to convert banked work into scheduled work.');
    if(action==='schedule'&&row.saved_kind!=='banked')throw new Error('Only banked work can be converted into a schedule.');
    const at=body.atMs;
    if(typeof at!=='number'||!Number.isFinite(at)||at<=Date.now())throw new Error('Name a future time.');
    const expires=body.expiresAtMs;
    if(expires!==undefined&&(typeof expires!=='number'||!Number.isFinite(expires)||expires<=at))throw new Error('Expiry must follow the scheduled time.');
    const expiry=expires??(row.saved_daily_time?row.saved_expires_at_ms:null);
    if(action==='time'&&row.saved_daily_time&&row.saved_time_zone) {
      const local=localParts(at,{time_zone:row.saved_time_zone});
      const time=`${String(local.hour).padStart(2,'0')}:${String(local.minute).padStart(2,'0')}`;
      db.query('UPDATE turns SET saved_daily_time=? WHERE id=?').run(time,row.saved_root_id);
      db.query('UPDATE turns SET saved_daily_time=? WHERE id=?').run(time,turnId);
    }
    db.query(`UPDATE turns SET saved_kind='scheduled',dispatch_next_attempt_ms=?,saved_fire_at_ms=?,saved_expires_at_ms=?,saved_account=NULL,
      saved_window=NULL,saved_boundary_ms=NULL,saved_alerted_at_ms=NULL,saved_manual_start=0 WHERE id=? AND status='queued'`).run(at,at,expiry,turnId);
    // A repeating schedule's end lives on its first firing; changing it here changes the whole schedule's end.
    if(row.saved_root_id!==null&&row.saved_root_id!==turnId)
      db.query('UPDATE turns SET saved_expires_at_ms=? WHERE id=?').run(expiry,row.saved_root_id);
    } else if(action==='start') {
    if(row.saved_quiet_only&&!quietOnlyAdmits(Date.now(),savedWorkSettings()))
      throw new Error('Quiet-only work can start only during its quiet window, before the morning cutoff.');
    db.query(`UPDATE turns SET saved_manual_start=1,dispatch_next_attempt_ms=0,saved_account=NULL,saved_window=NULL,saved_boundary_ms=NULL
      WHERE id=? AND status='queued'`).run(turnId);
    } else {
      const cancelingSessionId=body.cancelingSessionId;
      const reason=typeof cancelingSessionId==='number'&&Number.isSafeInteger(cancelingSessionId)
        ?`Agent session concierge:${cancelingSessionId} canceled this saved work.`:'Tejas dropped this saved work.';
      const canceled=db.query(`UPDATE turns SET status='cancelled',agent_text=?,ended_at=CURRENT_TIMESTAMP
        WHERE id=? AND session_id=? AND status='queued' AND saved_kind IS NOT NULL`).run(reason,turnId,row.session_id);
      if(canceled.changes!==1)throw new Error('The exact saved turn changed before cancellation.');
      settleTurnDependencies(turnId);
      if(row.accepted_input_id){
        const prior=db.query('SELECT receipt_json FROM session_inputs WHERE id=? AND turn_id=?').get(row.accepted_input_id,turnId) as {receipt_json:string|null}|null;
        if(!prior)throw new Error('The exact scheduled input changed before cancellation.');
        db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id=?')
          .run(JSON.stringify({...(prior.receipt_json?JSON.parse(prior.receipt_json):{}),state:'canceled',reason:'saved_work_drop',turnId,
            cancelingSessionId:typeof cancelingSessionId==='number'?cancelingSessionId:null,
            cancelingInputId:body.cancelingInputId??null,cancelingRunId:body.cancelingRunId??null}),row.accepted_input_id,turnId);
      }
    }
    const session=getSessionById(row.session_id);
    if(session){const meta=sessionMetadata(session);const needs=(meta.needs??[]).filter(need=>need.eventId!==`saved-work-alert:${turnId}`);
      if(needs.length!==(meta.needs??[]).length)updateSessionMetadata(session.id,{needs});}
    recordSessionEvent({eventId,sessionId:row.session_id,inputId:row.accepted_input_id,turnId,kind:'saved_control',payload:{action,fromKind:row.saved_kind,toKind:savedTurn(turnId)?.saved_kind,atMs:body.atMs??null,
      ...(action==='daily'?{time:body.time,timeZone:body.timeZone}:{}),
      ...(action==='drop'?{reason:'saved_work_drop',cancelingSessionId:body.cancelingSessionId??null,
        cancelingInputId:body.cancelingInputId??null,cancelingRunId:body.cancelingRunId??null}:{})}});
    return {turn:savedTurn(turnId)};
  })();
  executionChanged();
  return result;
}

/** Existing attention state is durable; each saved item is alerted at most once. */
export function settleMissedScheduledWork(now=Date.now()):number {
  let settled=0;
  for(const row of savedRows().filter(row=>row.saved_kind==='scheduled'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now&&!globalPauseHoldsSession(row.session_id))) {
    const changed=db.transaction(()=>{
      const result=db.query(`UPDATE turns SET status='error',agent_text='Scheduled work missed its expiry.',ended_at=CURRENT_TIMESTAMP
        WHERE id=? AND status='queued'`).run(row.id);
      if(!result.changes)return false;
      if(row.accepted_input_id)db.query(`UPDATE session_inputs SET receipt_json=json_set(COALESCE(receipt_json,'{}'),'$.state','failed',
        '$.error','Scheduled work missed its expiry.') WHERE id=?`).run(row.accepted_input_id);
      recordSessionEvent({eventId:`saved-expired:${row.id}`,sessionId:row.session_id,inputId:row.accepted_input_id,
        turnId:row.id,kind:'saved_control',payload:{action:'missed_expiry'}});
      return true;
    })();
    if(changed)settled++;
  }
  if(settled)executionChanged();
  return settled;
}

export function inspectSavedWork(now=Date.now(),lateMs=5*60_000):number {
  let alerts=0;
  settleMissedScheduledWork(now);
  if(paceLapsedUsageHolds(now))executionChanged();
  // Two indexed reads, never one OR: the combined statement could use neither partial index, so every
  // usage reading scanned the whole turns table on the owner's loop (docs/incidents/2026-11-17-saved-work-inspection-scanned-every-turn.md).
  // A missed row that was already alerted needs nothing further, so the index leaves it out.
  const missedUnalerted=db.query(`SELECT * FROM turns INDEXED BY saved_work_missed_unalerted WHERE saved_kind='scheduled' AND status='error'
    AND saved_alerted_at_ms IS NULL AND saved_expires_at_ms IS NOT NULL AND saved_expires_at_ms<=? ORDER BY id`).all(now) as SavedTurn[];
  const rows=[...savedRows(),...missedUnalerted].sort((left,right)=>left.id-right.id);
  for(const row of rows) {
    if(globalPauseHoldsSession(row.session_id))continue;
    const missed=row.saved_kind==='scheduled'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now;
    const late=row.saved_kind==='scheduled'&&row.dispatch_next_attempt_ms!==null&&row.dispatch_next_attempt_ms+lateMs<=now;
    const expired=row.saved_kind==='banked'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now;
    if(!late&&!expired&&!missed||row.saved_alerted_at_ms!==null)continue;
    const didAlert=db.transaction(()=>{
      const changed=db.query('UPDATE turns SET saved_alerted_at_ms=? WHERE id=? AND saved_alerted_at_ms IS NULL').run(now,row.id);
      if(!changed.changes)return false;
      const session=getSessionById(row.session_id);if(!session)return false;
      const meta=sessionMetadata(session),generation=(meta.generation??0)+1;
      // The reason is part of the question: three banked items expired saying only "found no safe
      // allowance window" while three accounts had room, so the sentence gave him no way to see a
      // defect rather than a full week (2026-11-25).
      const because=row.saved_wait_reason&&row.saved_wait_reason in BANKED_WAIT_WORDS
        ?` The last reason it recorded was that ${BANKED_WAIT_WORDS[row.saved_wait_reason as BankedWait]}.`:'';
      const question=expired?row.saved_quiet_only
        ?`This quiet-only banked work expired without running.${because} Start it during quiet hours or drop it.`
        :`This banked work expired without running.${because} Start it now, schedule it, or drop it.`
        :missed?'This scheduled work missed its expiry. Create a new schedule to run it later.'
        :'This scheduled work is past its time and remains queued. Check the deployment hold or an earlier parked turn.';
      const eventId=`saved-work-alert:${row.id}`,inputId=row.accepted_input_id??`saved:${row.id}`;
      updateSessionMetadata(session.id,{generation,needs:[...(meta.needs??[]),{outcome:'needs_you',generation,inputId,question,at:new Date(now).toISOString(),runId:nativeRunId(row.id),eventId}]});
      recordSessionEvent({eventId,sessionId:session.id,inputId:row.accepted_input_id,turnId:row.id,kind:'needs_you',payload:{outcome:'needs_you',question,inputId,generation,savedKind:row.saved_kind,needEventId:eventId}});
      return true;
    })();
    if(didAlert)alerts++;
  }
  return alerts;
}

export function savedTurn(turnId:number):SavedTurn|null {
  return db.query('SELECT * FROM turns WHERE id=? AND saved_kind IS NOT NULL').get(turnId) as SavedTurn|null;
}
/**
 * The saved turn a session is *currently* waiting on, and nothing else. A session that once
 * held saved work and has since run it is an ordinary session again: keeping the finished row
 * here made `savedWork` non-null forever, which silently removed that session's running
 * indicator for the rest of its life.
 */
export function savedSessionTurn(sessionId:number):SavedTurn|null {
  return db.query(`SELECT * FROM turns WHERE session_id=? AND saved_kind IS NOT NULL
    AND status='queued' ORDER BY id DESC LIMIT 1`).get(sessionId) as SavedTurn|null;
}
export function waitingSavedWork():SavedTurn[] {return savedRows();}

/**
 * One future firing per repeating session. A stable root/sequence prevents replay after restart.
 *
 * The latest firing of a schedule places the next one as soon as it is due or has left the
 * queue by any path, whatever started it, so a firing a claim took first still has a successor.
 * A firing records its own instant because the claim clears its dispatch time.
 * A queued firing in a paused session remains held for an explicit resume. A completed
 * firing does not place a successor after its session is archived or suspended.
 */
export function advanceRepeatingSchedules(now=Date.now()):number {
  let advanced=0;
  const due=db.query(`SELECT latest.* FROM turns root
    JOIN turns latest ON latest.id=(SELECT firing.id FROM turns firing
      WHERE firing.saved_root_id=root.id ORDER BY firing.saved_sequence DESC LIMIT 1)
    WHERE root.saved_kind='scheduled' AND root.saved_repeat_ms IS NOT NULL
    AND root.saved_root_id=root.id AND root.saved_sequence=0
    AND ((latest.status='queued' AND latest.dispatch_next_attempt_ms<=?) OR (latest.status<>'queued' AND latest.saved_fire_at_ms IS NOT NULL))
    AND (latest.status<>'queued' OR EXISTS (SELECT 1 FROM sessions session WHERE session.id=latest.session_id
      AND session.status<>'archived' AND COALESCE(json_extract(session.native_metadata_json,'$.suspended'),0)=0))
    ORDER BY latest.id`).all(now) as SavedTurn[];
  for(const row of due) {
    // One broken schedule must not stop the claim that every other session's work waits on.
    try {db.transaction(()=>{
      const current=savedTurn(row.id);
      if(!current||current.saved_repeat_ms===null||current.saved_root_id===null||current.saved_sequence===null)return;
      const left=current.status!=='queued';
      if(repeatingScheduleEnded(current.saved_root_id,current.id)) {
        // A schedule ended while this firing waited (a cancellation recorded on another path)
        // withdraws it through the same revocation as a cancelled request.
        if(!left){const rootInput=(db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(current.saved_root_id) as {accepted_input_id:string|null}|null)?.accepted_input_id;
          if(rootInput)endRepeatingScheduleForInput(rootInput);}
        return;
      }
      if(left&&db.query(`SELECT 1 FROM sessions WHERE id=? AND (status='archived'
        OR COALESCE(json_extract(native_metadata_json,'$.suspended'),0)<>0)`).get(current.session_id))return;
      const interval=current.saved_repeat_ms,root=current.saved_root_id;
      const firedAt=current.saved_fire_at_ms??current.dispatch_next_attempt_ms!;
      const daily=current.saved_daily_time&&current.saved_time_zone
        ?{time:current.saved_daily_time,timeZone:current.saved_time_zone}:null;
      let nextAt=firedAt+(Math.max(1,Math.floor((now-firedAt)/interval)+1))*interval;
      if(daily) {
        nextAt=nextDailyWallClock(Math.max(now,firedAt),daily);
        // A missed firing admitted late already produces today's digest. Do not book a
        // second one for the same local date if its normal hour is still ahead.
        if(localDayGap(firedAt,now,daily.timeZone)>0&&localDayGap(now,nextAt,daily.timeZone)===0)
          nextAt=nextDailyWallClock(nextAt,daily);
      }
      const nextSequence=current.saved_sequence+(daily
        ?Math.max(1,localDayGap(firedAt,nextAt,daily.timeZone))
        :Math.max(1,Math.floor((now-firedAt)/interval)+1));
      // A repeating schedule's expiry is when the whole schedule ends, kept on its first firing.
      // Firings booked before 2026-11-11 carried a copy pushed one interval later each time, so the
      // end never arrived (Lenny's refund watch fired for days past it); a queued one of those is
      // withdrawn here when it comes due.
      const end=(db.query('SELECT saved_expires_at_ms FROM turns WHERE id=?').get(root) as {saved_expires_at_ms:number|null}|null)?.saved_expires_at_ms??null;
      if(end!==null&&(firedAt>=end||nextAt>=end)) {
        // The last firing before the end still runs; the schedule ends once it has left the queue.
        if(!left&&firedAt<end)return;
        const rootInput=(db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(root) as {accepted_input_id:string|null}|null)?.accepted_input_id;
        if(rootInput)endRepeatingScheduleForInput(rootInput,'This repeating schedule reached its expiry.');
        return;
      }
      const skippedBetween=nextSequence-current.saved_sequence-1;
      const prior=!left&&db.query(`SELECT 1 FROM turns WHERE saved_root_id=? AND id<? AND status IN ('queued','running','delivering') LIMIT 1`)
        .get(root,current.id);
      if(prior) {
        db.query(`UPDATE turns SET status='cancelled',agent_text='Skipped because the previous firing was still in progress.',ended_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='queued'`).run(current.id);
        if(current.accepted_input_id)db.query(`UPDATE session_inputs SET receipt_json=json_set(COALESCE(receipt_json,'{}'),
          '$.state','canceled','$.reason','schedule_overlap','$.turnId',?,
          '$.error','Skipped because the previous firing was still in progress.') WHERE id=?`).run(current.id,current.accepted_input_id);
        recordSessionEvent({eventId:`saved-repeat-skip:${root}:${current.saved_sequence}`,sessionId:current.session_id,
          inputId:current.accepted_input_id,turnId:current.id,kind:'saved_control',payload:{action:'skipped_overlap',sequence:current.saved_sequence}});
      }
      if(skippedBetween)recordSessionEvent({eventId:`saved-repeat-missed:${root}:${current.saved_sequence}`,sessionId:current.session_id,
        inputId:current.accepted_input_id,turnId:current.id,kind:'saved_control',payload:{action:'skipped_missed_firings',count:skippedBetween}});
      if(db.query('SELECT 1 FROM turns WHERE saved_root_id=? AND saved_sequence=?').get(root,nextSequence))return;
      const original=db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(root) as {accepted_input_id:string|null}|null;
      const source=original?.accepted_input_id?getAcceptedSessionInput(original.accepted_input_id):null;
      if(!source)throw new Error('Repeating schedule lost its retained source input.');
      const first=JSON.parse(source.payload_json);
      const payload=source.kind==='create'?first.firstInput:first;
      const request=source.request_id?db.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?')
        .get(source.request_id) as {payload_json:string}|null:null;
      const text=request?JSON.parse(request.payload_json).text:payload.text;
      const input=retainSessionInput({id:`saved-repeat:${root}:${nextSequence}`,sessionId:current.session_id,
        scope:`saved-repeat:${root}`,actionId:String(nextSequence),kind:'input',origin:source.origin,
        payload:{text,...(payload.attachments?{attachments:payload.attachments}:{})}}).input;
      const queued=enqueueSessionInput(input.id);
      if(queued.turn_id===null)throw new Error('Repeating firing could not enter its session queue.');
      db.query(`UPDATE turns SET saved_kind='scheduled',saved_at_ms=?,saved_expires_at_ms=?,dispatch_next_attempt_ms=?,saved_fire_at_ms=?,
        saved_repeat_ms=?,saved_root_id=?,saved_sequence=?,saved_daily_time=?,saved_time_zone=? WHERE id=? AND status='queued'`)
        .run(now,end,nextAt,nextAt,interval,root,nextSequence,daily?.time??null,daily?.timeZone??null,queued.turn_id);
      advanced++;
    })();} catch(error) {log('error','saved_repeat_advance_failed',{turn_id:row.id,...errorFields(error)});}
  }
  if(advanced)executionChanged();
  return advanced;
}

/**
 * Whether a repeating schedule has been ended: dropped in Saved work (recorded on its latest
 * firing), ended through its request, or its creating request withdrawn. Every later firing is
 * its own input that the request never names, so the request alone cannot reach them; this is
 * the one place the booking step asks (2026-11-06: a cancelled 15-minute schedule kept firing).
 */
function repeatingScheduleEnded(root:number,latestId:number):boolean {
  if(db.query(`SELECT 1 FROM session_owner_events WHERE turn_id=? AND kind='saved_control'
    AND json_extract(payload_json,'$.action') IN ('drop','schedule_ended')`).get(latestId))return true;
  return !!db.query(`SELECT 1 FROM turns root JOIN session_inputs input ON input.id=root.accepted_input_id
    JOIN session_communication_requests request ON request.request_id=input.request_id
    WHERE root.id=? AND request.outcome='canceled'`).get(root);
}

/** The repeating schedule this accepted input started, with its firings still queued; null for any other input. */
export function repeatingScheduleOf(inputId:string):{root:number;queued:{id:number;session_id:number;accepted_input_id:string}[]}|null {
  const root=db.query(`SELECT id FROM turns WHERE accepted_input_id=? AND saved_kind='scheduled'
    AND saved_repeat_ms IS NOT NULL AND saved_root_id=id`).get(inputId) as {id:number}|null;
  if(!root)return null;
  return {root:root.id,queued:db.query(`SELECT id,session_id,accepted_input_id FROM turns WHERE saved_root_id=? AND status='queued'
    AND accepted_input_id IS NOT NULL ORDER BY id`).all(root.id) as {id:number;session_id:number;accepted_input_id:string}[]};
}

/** Records, once, on the schedule's latest firing that it has ended, so no later firing is booked. */
export function markRepeatingScheduleEnded(root:number,reason:string,withdrawn:number):void {
  const eventId=`saved-repeat-ended:${root}`;
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return;
  const latest=db.query('SELECT id,session_id,accepted_input_id FROM turns WHERE saved_root_id=? ORDER BY saved_sequence DESC LIMIT 1')
    .get(root) as {id:number;session_id:number;accepted_input_id:string|null};
  recordSessionEvent({eventId,sessionId:latest.session_id,inputId:latest.accepted_input_id,turnId:latest.id,
    kind:'saved_control',payload:{action:'schedule_ended',reason,withdrawn}});
}

/** Run the saved-work clock once before a queue wake drains claims. */
export function prepareSavedWorkForClaims():void {
  const now=Date.now();
  advanceRepeatingSchedules(now);
  settleMissedScheduledWork(now);
  if(paceLapsedUsageHolds(now))executionChanged();
}

/** A single-claim entrance for callers outside the wake-driven coordinator. */
export function claimQueuedTurnWithSavedWork(ownerInstanceId:string,activeSessionIds:readonly number[]):QueuedTurnClaimRow|null {
  prepareSavedWorkForClaims();
  const now=Date.now();
  return claimNextQueuedTurn(ownerInstanceId,now,activeSessionIds);
}
