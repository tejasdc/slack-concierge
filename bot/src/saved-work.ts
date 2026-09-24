import {db,executionChanged,getSessionById} from './state';
import {enqueueSessionInput,getAcceptedSessionInput,nativeRunId,queueTurnContinuation,recordSessionEvent,retainSessionInput,sessionMetadata,updateSessionMetadata} from './session-inputs';
import {providerAccountUsage} from './provider-account-usage';
import {usageForecasts} from './provider-usage-forecast';
import type {ProviderKey} from './provider-accounts';
import {savedWorkAccountRooms} from './provider-account-dispatch';
import {chooseAccountForTurn} from './provider-account-choice';

export type SavedKind='scheduled'|'banked';
export type SavedTurn={id:number;session_id:number;status:string;saved_kind:SavedKind;saved_at_ms:number;saved_expires_at_ms:number|null;saved_manual_start:number;
  saved_repeat_ms:number|null;saved_root_id:number|null;saved_sequence:number|null;
  saved_account:string|null;saved_window:string|null;saved_boundary_ms:number|null;dispatch_next_attempt_ms:number|null;dispatch_failure_class:string|null;
  saved_alerted_at_ms:number|null;accepted_input_id:string|null};

export function savedStartAt(turn:SavedTurn):string|null {
  return turn.saved_kind==='scheduled'&&turn.dispatch_failure_class!=='backoff'&&turn.dispatch_next_attempt_ms
    ?new Date(turn.dispatch_next_attempt_ms).toISOString():null;
}

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
export function saveQueuedTurn(turnId:number,kind:SavedKind,atMs?:number,expiresAtMs?:number,repeatEveryMs?:number):void {
  const now=Date.now();
  if(kind==='scheduled'&&(!Number.isFinite(atMs)||atMs!<=now))throw new Error('Schedule a future instant.');
  if(expiresAtMs!==undefined&&(!Number.isFinite(expiresAtMs)||expiresAtMs<=(atMs??now)))throw new Error('Expiry must follow the scheduled time.');
  if(repeatEveryMs!==undefined&&(kind!=='scheduled'||!Number.isSafeInteger(repeatEveryMs)||repeatEveryMs<60_000))throw new Error('Repeat interval must be at least one minute.');
  db.transaction(()=>{
    const turn=db.query('SELECT session_id,status,saved_kind FROM turns WHERE id=?').get(turnId) as {session_id:number;status:string;saved_kind:string|null}|null;
    if(!turn||turn.status!=='queued'||turn.saved_kind)throw new Error('Only a new queued turn can be saved.');
    const other=db.query('SELECT 1 FROM turns WHERE session_id=? AND id<>? LIMIT 1').get(turn.session_id,turnId);
    if(other)throw new Error('Saved work needs its own session.');
    const next=kind==='scheduled'?atMs!:null;
    db.query(`UPDATE turns SET saved_kind=?,saved_at_ms=?,saved_expires_at_ms=?,dispatch_failure_class=NULL,dispatch_next_attempt_ms=?,
      saved_repeat_ms=?,saved_root_id=?,saved_sequence=? WHERE id=?`)
      .run(kind,now,kind==='scheduled'?expiresAtMs??null:now+savedWorkSettings().wait_days*DAY,next,
        repeatEveryMs??null,repeatEveryMs?turnId:null,repeatEveryMs?0:null,turnId);
  })();
  executionChanged();
}

function localParts(ms:number,settings:SavedWorkSettings) {
  const clock=new Intl.DateTimeFormat('en-US',{timeZone:settings.time_zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',hourCycle:'h23',minute:'numeric',second:'numeric'});
  const parts=Object.fromEntries(clock.formatToParts(new Date(ms)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));
  return {year:parts.year!,month:parts.month!,day:parts.day!,hour:parts.hour!,minute:parts.minute!,second:parts.second!};
}
function localOffset(ms:number,settings:SavedWorkSettings) {
  const p=localParts(ms,settings);
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ms/1000)*1000;
}
function quiet(now:number,settings:SavedWorkSettings):boolean {
  const hour=localParts(now,settings).hour;
  return settings.quiet_start_hour<settings.quiet_end_hour
    ?hour>=settings.quiet_start_hour&&hour<settings.quiet_end_hour
    :hour>=settings.quiet_start_hour||hour<settings.quiet_end_hour;
}
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
const fleetBusy=(savedSessionId:number)=>!!db.query(`SELECT 1 FROM turns WHERE session_id<>?
  AND (status IN ('running','delivering') OR (status='queued' AND saved_kind IS NULL)) LIMIT 1`).get(savedSessionId);
const savedRows=()=>db.query("SELECT * FROM turns WHERE saved_kind IS NOT NULL AND status='queued' ORDER BY id").all() as SavedTurn[];

/** Forecast and reachability are read outside the claim. Only changed instants are written. */
export function reconsiderBankedWork(now=Date.now()):number {
  const settings=savedWorkSettings();let changed=0;
  for(const row of savedRows().filter(row=>row.saved_kind==='banked')) {
    if(row.saved_manual_start)continue;
    if(row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now)continue;
    const session=getSessionById(row.session_id);
    if(!session||!['codex','claude-code'].includes(session.provider_id))continue;
    const provider=session.provider_id as ProviderKey;
    const usage=providerAccountUsage(provider);
    const rooms=usage?savedWorkAccountRooms(provider,usage,now):[];
    const candidate=usage?usageForecasts(provider).filter(window=>window.resetsAt
      && chooseAccountForTurn({accounts:rooms,bound:{account:window.account,reason:'spending-this-window'},prefer:null}).account===window.account
      && (usage.accounts.find(item=>item.label===window.account)?.windows.find(item=>item.name===window.window)?.willLastToReset===true
        ||window.source!=='unknown'&&!window.runsOutBeforeReset)
      && !window.runsOutBeforeReset&&window.usedPercent<100-settings.reserve_percent
      && (rooms.find(room=>room.account===window.account)?.tightestUsedPercent??100)<100-settings.reserve_percent
      && Date.parse(window.resetsAt)>=now+HOUR)
      .sort((a,b)=>Date.parse(a.resetsAt!)-Date.parse(b.resetsAt!))[0]:null;
    const account=candidate?.account??null;
    const reset=candidate?Date.parse(candidate.resetsAt!):null;
    const eligible=!!candidate&&!fleetBusy(row.session_id)&&(quiet(now,settings)||reset!-now<=2*HOUR);
    const next=eligible?0:reset!==null?Math.min(nextQuietStart(now,settings),Math.max(now+60_000,reset-2*HOUR))
      :row.dispatch_next_attempt_ms!==null&&row.dispatch_next_attempt_ms>now+3*60_000?row.dispatch_next_attempt_ms:null;
    const boundary=eligible?reset:null;
    if(row.dispatch_next_attempt_ms===next&&row.saved_account===(eligible?account:null)
      &&row.saved_window===(eligible?candidate!.window:null)&&row.saved_boundary_ms===boundary)continue;
    const result=db.query(`UPDATE turns SET dispatch_next_attempt_ms=?,saved_account=?,saved_window=?,saved_boundary_ms=?
      WHERE id=? AND status='queued' AND saved_kind='banked'`).run(next,eligible?account:null,eligible?candidate!.window:null,boundary,row.id);
    changed+=result.changes;
  }
  if(changed)executionChanged();
  return changed;
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

export function resumeBankedAfterYield(turnId:number,reason:'allowance_boundary'|'deployment_boundary'):boolean {
  // An admitted provider may already have pushed or deployed, so its opening input is never
  // queued again. The stopped turn is kept as the record of what happened, and the work
  // continues as a new message that says where it got to — which is what the entry point
  // below is for. Its ordering requirement is satisfied by construction: this runs after the
  // turn has ended, and a source without an end is refused, leaving the run held.
  const changed=db.transaction(()=>{
    const row=savedTurn(turnId);
    if(!row||row.status!=='cancelled'||!row.accepted_input_id)return false;
    const question=reason==='deployment_boundary'
      ?'Banked work stopped for a deployment after it started. Check what the agent completed before deciding how to continue.'
      :'Banked work stopped at its allowance boundary after it started. Check what the agent completed before deciding how to continue.';
    db.query(`UPDATE turns SET agent_text=COALESCE(agent_text,?) WHERE id=? AND status='cancelled'`).run(question,turnId);
    // Deliberately not an attention declaration. A boundary stop happens at 3am, and a
    // needs_you here reaches the notifier and wakes him for something he cannot act on
    // until morning. The design says a banked run leaves a record, not a notification;
    // the row reads it from this event and the retained text above.
    recordSessionEvent({eventId:`saved-yield:${turnId}`,sessionId:row.session_id,inputId:row.accepted_input_id,
      turnId,kind:'saved_control',payload:{action:'stopped_at_boundary',reason,text:question}});
    // Continue with new words, never a replay: this run may already have pushed or deployed.
    // The entry point refuses a source it cannot safely continue — a deliberate human Stop, a
    // session that has moved on, a status it does not accept — and a refusal is not a failure
    // here: the run stays held for him, which is what happened before this existed.
    const continued=queueTurnContinuation(turnId,{kind:'boundary',
      detail:reason==='deployment_boundary'?'a Concierge update was waiting':'the allowance it was spending reset',
      ...(row.dispatch_next_attempt_ms?{waitUntilMs:row.dispatch_next_attempt_ms}:{})});
    // A continuation of banked work is still banked work: without this it would be ordinary
    // work that simply runs at its time, unbound to an account and outside the reserve.
    if(continued?.turn_id)saveQueuedTurn(continued.turn_id,'banked');
    return true;
  })();
  return changed;
}

export function updateSavedTurn(turnId:number,action:string,body:Record<string,unknown>) {
  if(!Number.isSafeInteger(turnId)||turnId<1)throw new Error('Name an exact saved turn.');
  if(!['start','time','schedule','drop'].includes(action))throw new Error('Choose start, time, schedule or drop.');
  const actionId=body.clientActionId;
  if(typeof actionId!=='string'||!actionId.trim())throw new Error('Stable client action identity required.');
  const eventId=`saved-control:${turnId}:${actionId}`;
  const result=db.transaction(()=>{
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return {turn:savedTurn(turnId)};
    const row=savedTurn(turnId);
    if(!row||row.status!=='queued')throw new Error('This saved work is no longer waiting.');
    if(action==='time'||action==='schedule') {
    if(action==='time'&&row.saved_kind!=='scheduled')throw new Error('Use schedule to convert banked work into scheduled work.');
    if(action==='schedule'&&row.saved_kind!=='banked')throw new Error('Only banked work can be converted into a schedule.');
    const at=body.atMs;
    if(typeof at!=='number'||!Number.isFinite(at)||at<=Date.now())throw new Error('Name a future time.');
    const expires=body.expiresAtMs;
    if(expires!==undefined&&(typeof expires!=='number'||!Number.isFinite(expires)||expires<=at))throw new Error('Expiry must follow the scheduled time.');
    db.query(`UPDATE turns SET saved_kind='scheduled',dispatch_next_attempt_ms=?,saved_expires_at_ms=?,saved_account=NULL,
      saved_window=NULL,saved_boundary_ms=NULL,saved_alerted_at_ms=NULL,saved_manual_start=0 WHERE id=? AND status='queued'`).run(at,expires??null,turnId);
    } else if(action==='start') {
    db.query(`UPDATE turns SET saved_manual_start=1,dispatch_next_attempt_ms=0,saved_account=NULL,saved_window=NULL,saved_boundary_ms=NULL
      WHERE id=? AND status='queued'`).run(turnId);
    } else {
      db.query(`UPDATE turns SET status='cancelled',agent_text='Dropped by Tejas.',ended_at=CURRENT_TIMESTAMP
        WHERE session_id=? AND status='queued'`).run(row.session_id);
      db.query(`UPDATE session_inputs SET receipt_json=json_set(COALESCE(receipt_json,'{}'),'$.state','canceled')
        WHERE session_id=? AND turn_id IN (SELECT id FROM turns WHERE session_id=? AND status='cancelled')`).run(row.session_id,row.session_id);
    }
    const session=getSessionById(row.session_id);
    if(session){const meta=sessionMetadata(session);const needs=(meta.needs??[]).filter(need=>need.eventId!==`saved-work-alert:${turnId}`);
      if(needs.length!==(meta.needs??[]).length)updateSessionMetadata(session.id,{needs});}
    recordSessionEvent({eventId,sessionId:row.session_id,inputId:row.accepted_input_id,turnId,kind:'saved_control',payload:{action,fromKind:row.saved_kind,toKind:savedTurn(turnId)?.saved_kind,atMs:body.atMs??null}});
    return {turn:savedTurn(turnId)};
  })();
  executionChanged();
  return result;
}

/** Existing attention state is durable; each saved item is alerted at most once. */
export function settleMissedScheduledWork(now=Date.now()):number {
  let settled=0;
  for(const row of savedRows().filter(row=>row.saved_kind==='scheduled'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now)) {
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
  const rows=db.query(`SELECT * FROM turns WHERE saved_kind IS NOT NULL AND
    (status='queued' OR (status='error' AND saved_kind='scheduled' AND saved_expires_at_ms<=?)) ORDER BY id`).all(now) as SavedTurn[];
  for(const row of rows) {
    const missed=row.saved_kind==='scheduled'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now;
    const late=row.saved_kind==='scheduled'&&row.dispatch_next_attempt_ms!==null&&row.dispatch_next_attempt_ms+lateMs<=now;
    const expired=row.saved_kind==='banked'&&row.saved_expires_at_ms!==null&&row.saved_expires_at_ms<=now;
    if(!late&&!expired&&!missed||row.saved_alerted_at_ms!==null)continue;
    const didAlert=db.transaction(()=>{
      const changed=db.query('UPDATE turns SET saved_alerted_at_ms=? WHERE id=? AND saved_alerted_at_ms IS NULL').run(now,row.id);
      if(!changed.changes)return false;
      const session=getSessionById(row.session_id);if(!session)return false;
      const meta=sessionMetadata(session),generation=(meta.generation??0)+1;
      const question=expired?'This banked work found no safe allowance window. Start it now, schedule it, or drop it.'
        :missed?'This scheduled work missed its expiry. Create a new schedule to run it later.'
        :'This scheduled work is past its time and remains queued. Check the deployment hold or an earlier parked turn.';
      const eventId=`saved-work-alert:${row.id}`,inputId=row.accepted_input_id??`saved:${row.id}`;
      updateSessionMetadata(session.id,{generation,needs:[...(meta.needs??[]),{outcome:'needs_you',generation,inputId,question,at:new Date(now).toISOString(),runId:nativeRunId(row.id),eventId}]});
      recordSessionEvent({eventId,sessionId:session.id,inputId:row.accepted_input_id,turnId:row.id,kind:'needs_you',payload:{outcome:'needs_you',question,inputId,generation,savedKind:row.saved_kind}});
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

/** One future firing per repeating session. A stable root/sequence prevents replay after restart. */
export function advanceRepeatingSchedules(now=Date.now()):number {
  let advanced=0;
  const due=db.query(`SELECT * FROM turns WHERE saved_kind='scheduled' AND saved_repeat_ms IS NOT NULL
    AND status='queued' AND dispatch_next_attempt_ms<=? ORDER BY id`).all(now) as SavedTurn[];
  for(const row of due) {
    db.transaction(()=>{
      const current=savedTurn(row.id);
      if(!current||current.status!=='queued'||current.saved_repeat_ms===null||current.saved_root_id===null||current.saved_sequence===null)return;
      const interval=current.saved_repeat_ms,root=current.saved_root_id;
      const nextSequence=current.saved_sequence+Math.max(1,Math.floor((now-current.dispatch_next_attempt_ms!)/interval)+1);
      const nextAt=current.dispatch_next_attempt_ms!+(nextSequence-current.saved_sequence)*interval;
      const skippedBetween=nextSequence-current.saved_sequence-1;
      const prior=db.query(`SELECT 1 FROM turns WHERE saved_root_id=? AND id<? AND status IN ('queued','running','delivering') LIMIT 1`)
        .get(root,current.id);
      if(prior) {
        db.query(`UPDATE turns SET status='cancelled',agent_text='Skipped because the previous firing was still in progress.',ended_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='queued'`).run(current.id);
        if(current.accepted_input_id)db.query(`UPDATE session_inputs SET receipt_json=json_set(COALESCE(receipt_json,'{}'),
          '$.state','canceled','$.error','Skipped because the previous firing was still in progress.') WHERE id=?`).run(current.accepted_input_id);
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
      const expiry=current.saved_expires_at_ms===null?null:nextAt+(current.saved_expires_at_ms-current.dispatch_next_attempt_ms!);
      db.query(`UPDATE turns SET saved_kind='scheduled',saved_at_ms=?,saved_expires_at_ms=?,dispatch_next_attempt_ms=?,
        saved_repeat_ms=?,saved_root_id=?,saved_sequence=? WHERE id=? AND status='queued'`)
        .run(now,expiry,nextAt,interval,root,nextSequence,queued.turn_id);
      advanced++;
    })();
  }
  if(advanced)executionChanged();
  return advanced;
}
