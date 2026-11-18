import type {Database} from 'bun:sqlite';
import {codexAdmissionHoldFact} from './codex-admission-holds';
import {holdIsStartPace} from './start-pace';
import {snoozeReason} from './snooze';
import {workingThrough,type CurrentWorker} from './topic-current-workers';
import {latestWorkerProgress} from './worker-progress';

/**
 * Where one open request stands, computed once, for every surface (docs/plans/2026-11-16-request-standing.md).
 * A request has exactly one displayed holder and one state; "nothing will wake it" is the `quiet`
 * and `stalled` state, which the quiet clock acts on. The live topic list and the prepared worker
 * both call this, so the two copies of the thread's work value cannot disagree about it.
 * `text` never embeds a clock time: times travel in `since` and `until` and the web app composes them.
 */
export const QUIET_WAKE_MS=60*60_000;
/** Quiet wakes with no word after the first before the request is stalled for the Inbox router to reassign. */
export const QUIET_WAKES_BEFORE_STALL=3;
/** At most this many quiet wakes start agent turns in any window, so a backlog after an install or outage is worked through gradually. */
export const QUIET_WAKES_PER_WINDOW=3;
export const QUIET_WAKE_WINDOW_MS=10*60_000;

export type StandingState='working'|'waiting'|'held'|'quiet'|'stalled';
export type StandingPerson={sessionId:string;title:string};
export type RequestStanding={requestId:string;holder:StandingPerson;movedFrom:StandingPerson[];state:StandingState;text:string;
 since:string|null;until:string|null;progress:{text:string;at:string}|null;remindedAt:string|null};

const parse=(text:string|null|undefined):any=>{try{return text?JSON.parse(text):null;}catch{return null;}};
const iso=(ms:number|null|undefined)=>typeof ms==='number'&&Number.isFinite(ms)?new Date(ms).toISOString():null;
const peerAddress=(peer:string,id:string)=>`${peer}:${String(id).replace(/^concierge:/,'')}`;

function localTitle(source:Database,id:number):string{
 const row=source.query('SELECT native_metadata_json FROM sessions WHERE id=?').get(id) as {native_metadata_json:string}|null;
 return parse(row?.native_metadata_json)?.title||'Agent session';
}
function peerTitle(source:Database,peer:string,remote:string):string{
 const row=source.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(peer,remote) as {view_json:string}|null;
 return parse(row?.view_json)?.title||`${peer} session`;
}

type Row={request_id:string;target_session_id:number;target_input_id:string|null;outcome:string|null;stalled_at_ms:number|null;created_at_ms:number;quiet_reminded_at_ms:number|null};

/** Predecessors this request was handed off from, oldest first, followed from the current holder backwards. */
function movedFrom(source:Database,requestId:string):StandingPerson[]{
 const moves=source.query(`SELECT item.from_session_id AS from_id,item.to_session_id AS to_id FROM session_handoff_items item
  JOIN session_handoffs handoff ON handoff.id=item.handoff_id WHERE item.ref=? AND item.kind='owed' AND handoff.state='accepted'
  ORDER BY handoff.accepted_at,handoff.rowid`).all(requestId) as {from_id:number;to_id:number}[];
 return moves.filter(move=>move.from_id!==move.to_id).map(move=>({sessionId:`concierge:${move.from_id}`,title:localTitle(source,move.from_id)}));
}

/** The last time anyone said anything on this request: its creation, a progress or final reply, the holder ending a turn, or the last quiet wake. */
export function requestLastWordMs(source:Database,row:Pick<Row,'request_id'|'target_session_id'|'created_at_ms'|'quiet_reminded_at_ms'>):number{
 const event=source.query("SELECT max(created_at_ms) AS at FROM session_communication_events WHERE request_id=? AND kind IN ('progress','final')").get(row.request_id) as {at:number|null};
 const turn=source.query('SELECT ended_at FROM turns WHERE session_id=? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(row.target_session_id) as {ended_at:string}|null;
 const ended=turn?.ended_at?Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(turn.ended_at)?turn.ended_at:`${turn.ended_at.replace(' ','T')}Z`):NaN;
 return Math.max(row.created_at_ms,event.at??0,Number.isNaN(ended)?0:ended,row.quiet_reminded_at_ms??0);
}

/** What holds the holder's next turn back, in one plain line, or null when nothing but the queue does. The wording follows `receiptStatusFromFacts`. */
function heldWords(turn:{dispatch_hold:string|null;dispatch_failure_class:string|null;dispatch_next_attempt_ms:number|null;saved_kind:string|null;saved_fire_at_ms:number|null}):{words:string;untilMs:number|null}|null{
 const next=turn.dispatch_next_attempt_ms??turn.saved_fire_at_ms??null;
 const untilMs=next!==null?next:null;
 const snoozed=snoozeReason(turn.dispatch_hold);
 if(snoozed!==null)return {words:`Snoozed: ${snoozed}`,untilMs};
 if(turn.saved_kind==='scheduled'&&turn.dispatch_failure_class!=='backoff')return {words:'Scheduled to continue',untilMs};
 if(turn.saved_kind==='banked'&&turn.dispatch_failure_class!=='backoff')return {words:'Waiting for a safe allowance window',untilMs:null};
 if(turn.dispatch_failure_class==='chosen_time')return {words:'Waiting for the time the agent chose',untilMs};
 if(turn.dispatch_failure_class==='auth_wait')return {words:'Waiting for the account to sign in',untilMs:null};
 if(turn.dispatch_failure_class==='usage_wait'||turn.dispatch_hold==='usage')return {words:'Waiting for provider usage to free up',untilMs};
 if(turn.dispatch_failure_class==='backoff')return {words:holdIsStartPace(turn.dispatch_hold)||turn.dispatch_hold==='release_pace'?'Waiting its turn to start':'Retrying after a provider problem',untilMs};
 return null;
}

/** A Codex-wide admission hold retained in the ledger (account switch, update or repair) holding this session's next turn. */
function codexAdmissionWords(source:Database,sessionId:number):{words:string;untilMs:number|null}|null{
 const session=source.query('SELECT provider_id,native_metadata_json FROM sessions WHERE id=?').get(sessionId) as {provider_id:string;native_metadata_json:string}|null;
 if(session?.provider_id!=='codex')return null;
 const hold=codexAdmissionHoldFact(source,!!parse(session.native_metadata_json)?.outside);
 if(!hold)return null;
 return {words:hold.kind==='runner-activation'?'Waiting for Codex to finish switching accounts':hold.kind==='runner-runtime-maintenance'?'Waiting for Codex to finish updating'
  :'Waiting for Codex to take new work again',untilMs:hold.clearsAtMs};
}

function stalledReason(source:Database,requestId:string):string|null{
 const event=source.query("SELECT payload_json FROM session_communication_events WHERE request_id=? AND kind='overdue' AND json_extract(payload_json,'$.stalled')=1 ORDER BY rowid DESC LIMIT 1").get(requestId) as {payload_json:string}|null;
 const reason=parse(event?.payload_json)?.reason;
 return typeof reason==='string'&&reason?reason.replace(/\s+/g,' ').slice(0,160):null;
}

/** A request the holder sent and still waits on, or a watch its own partial reply named. */
function dependencies(source:Database,holder:number,requestId:string):{agents:StandingPerson[];requestIds:string[];peers:number}{
 const agents:StandingPerson[]=[],requestIds:string[]=[];
 for(const row of source.query('SELECT request_id,target_session_id AS target FROM session_communication_requests WHERE source_session_id=? AND outcome IS NULL ORDER BY created_at_ms DESC').all(holder) as {request_id:string;target:number}[]){
  agents.push({sessionId:`concierge:${row.target}`,title:localTitle(source,row.target)});requestIds.push(row.request_id);
 }
 let peers=0;
 for(const row of source.query("SELECT peer,remote_session_id AS remote FROM session_peer_requests WHERE source_session_id=? AND outcome IS NULL AND json_extract(payload_json,'$.responseMode') IS NOT 'context' ORDER BY created_at_ms DESC").all(holder) as {peer:string;remote:string}[])
  {agents.push({sessionId:peerAddress(row.peer,row.remote),title:peerTitle(source,row.peer,row.remote)});peers++;}
 return {agents,requestIds,peers};
}

/**
 * A watch that will wake this holder by itself: accepted or observing, owned by the holder session, with a deadline still
 * ahead and no gap in its coverage. The one this request's own partial reply named comes first, else any live watch of the
 * holder (many agents wait without naming it). It wakes the session when it fires, fails or expires, so a request held on
 * it is not quiet. A gap in coverage is not a live watch.
 */
export function liveWatchOf(source:Database,holder:number,requestId:string,nowMs:number):{deadlineMs:number;label:string}|null{
 const row=source.query(`SELECT watch.deadline_ms,watch.condition_json,
   coalesce(watch.series_id,watch.watch_id) IN (SELECT coalesce(named.series_id,named.watch_id) FROM session_communication_events reply
    JOIN watches named ON named.watch_id=json_extract(reply.payload_json,'$.waitingOnWatch') WHERE reply.request_id=? AND reply.kind='progress') AS named
  FROM watches watch WHERE watch.session_id=? AND watch.state IN ('accepted','observing') AND watch.deadline_ms>? AND watch.gaps_json IN ('[]','')
  ORDER BY named DESC,watch.deadline_ms ASC LIMIT 1`).get(requestId,holder,nowMs) as {deadline_ms:number;condition_json:string}|null;
 return row?{deadlineMs:row.deadline_ms,label:/slack-concierge-deployment/.test(row.condition_json)?'a Concierge release':'something it is watching'}:null;
}


/** The standing of one open local or peer communication request, or null when it is not open. */
export function requestStanding(source:Database,requestId:string,nowMs:number):RequestStanding|null{
 const local=source.query('SELECT request_id,target_session_id,target_input_id,outcome,stalled_at_ms,created_at_ms,quiet_reminded_at_ms FROM session_communication_requests WHERE request_id=?').get(requestId) as Row|null;
 if(local){
  if(local.outcome)return null;
  const holder:StandingPerson={sessionId:`concierge:${local.target_session_id}`,title:localTitle(source,local.target_session_id)};
  const progress=latestWorkerProgress(source,requestId);
  const lastWord=requestLastWordMs(source,local);
  const base={requestId,holder,movedFrom:movedFrom(source,requestId),progress,remindedAt:iso(local.quiet_reminded_at_ms),since:iso(lastWord),until:null as string|null};
  if(local.stalled_at_ms!==null){
   const reason=stalledReason(source,requestId);
   return {...base,state:'stalled',text:reason?`Stopped without finishing: ${reason}`:'Stopped without finishing',since:iso(local.stalled_at_ms)};
  }
  const running=!!source.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering')").get(local.target_session_id);
  if(!running){
   const queued=source.query("SELECT dispatch_hold,dispatch_failure_class,dispatch_next_attempt_ms,saved_kind,saved_fire_at_ms FROM turns WHERE session_id=? AND status='queued' ORDER BY id LIMIT 1").get(local.target_session_id) as any;
   const held=queued?heldWords(queued)??codexAdmissionWords(source,local.target_session_id):null;
   if(held)return {...base,state:'held',text:held.words,until:held.untilMs!==null&&held.untilMs>nowMs?iso(held.untilMs):null};
  }
  const chain=workingThrough(source,local.target_session_id);
  if(chain){
   const last=chain[chain.length-1]!;
   return {...base,state:'working',text:last===local.target_session_id?'Working now':`Working through ${localTitle(source,last)}`};
  }
  const watch=liveWatchOf(source,local.target_session_id,requestId,nowMs);
  if(watch)return {...base,state:'waiting',text:`Waiting for ${watch.label}`,until:iso(watch.deadlineMs)};
  const waitingOn=dependencies(source,local.target_session_id,requestId);
  if(waitingOn.agents.length){
   const [first,...others]=waitingOn.agents;
   return {...base,state:'waiting',text:`Waiting on ${first!.title}${others.length?` and ${others.length} other${others.length===1?'':'s'}`:''} · no word from ${others.length?'them':'it'}`};
  }
  return {...base,state:'quiet',text:'No word yet'};
 }
 const peer=source.query('SELECT request_id,peer,remote_session_id,outcome,stalled_at_ms,created_at_ms FROM session_peer_requests WHERE request_id=?').get(requestId) as
  {peer:string;remote_session_id:string;outcome:string|null;stalled_at_ms:number|null;created_at_ms:number}|null;
 if(!peer||peer.outcome)return null;
 const holder={sessionId:peerAddress(peer.peer,peer.remote_session_id),title:peerTitle(source,peer.peer,peer.remote_session_id)};
 // A peer instance keeps its own turns, so a peer request stays "working" here exactly as a direct peer dispatch already does.
 return {requestId,holder,movedFrom:[],state:peer.stalled_at_ms!==null?'stalled':'working',text:peer.stalled_at_ms!==null?'Stopped without finishing':'Working now',
  since:iso(peer.stalled_at_ms??peer.created_at_ms),until:null,progress:null,remindedAt:null};
}

/** Open communication and peer requests whose current target is this session. */
export function heldRequests(source:Database,sessionId:number):{count:number;oldestAt:string}|null{
 const local=source.query('SELECT count(*) AS count,min(created_at_ms) AS oldest FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL').get(sessionId) as {count:number;oldest:number|null};
 const peer=source.query('SELECT count(*) AS count,min(created_at_ms) AS oldest FROM session_peer_deliveries WHERE target_session_id=? AND closed_at_ms IS NULL').get(sessionId) as {count:number;oldest:number|null};
 const count=local.count+peer.count;
 if(!count)return null;
 const oldest=Math.min(local.oldest??Infinity,peer.oldest??Infinity);
 return {count,oldestAt:new Date(oldest).toISOString()};
}

/** Wording of the one service input the quiet clock sends the holder. */
export function quietWakeText(standing:RequestStanding,requestLabel:string,minutesQuiet:number):string{
 return `${requestLabel} has had no word for ${minutesQuiet} minutes and is still open. Its standing now: ${standing.text}. `
  +'Continue it, chase or replace what it waits on, or close it with a final reply (completed, failed, or hand it back).';
}

/** The standing of every open delivery listed under the thread's open requests. */
export function openRequestStandings(source:Database,requests:readonly {state:string;dispatches?:readonly any[]}[],nowMs:number):Map<string,RequestStanding>{
 const found=new Map<string,RequestStanding>();
 for(const request of requests){if(request.state!=='open')continue;
  for(const dispatch of request.dispatches??[]){
   const id=String(dispatch?.requestId??'');if(!id||found.has(id))continue;
   const standing=requestStanding(source,id,nowMs);if(standing)found.set(id,standing);
  }
 }
 return found;
}

/**
 * The thread's work value once its current workers and the open requests' standings are known:
 * `worker_working` while any open request is being worked, else `worker_waiting` with the first
 * standing in words. Null when the thread has no open request and nobody at work.
 */
const GROUP_ORDER=['stopped','waiting','held','working'] as const;
const groupOf=(worker:CurrentWorker)=>!worker.standing?'working':worker.standing.state==='stalled'?'stopped':worker.standing.state==='held'?'held'
 :worker.standing.state==='working'?'working':'waiting';

export function workerWork(current:CurrentWorker[],standings:Map<string,RequestStanding>){
 const covered=new Set(current.map(worker=>worker.requestId));
 // Every open request keeps its own entry: a waiting one is not dropped because another one works.
 const workers:CurrentWorker[]=[...current,...[...standings.values()].filter(standing=>!covered.has(standing.requestId)).map(standing=>({
  sessionId:standing.holder.sessionId as string|null,title:standing.holder.title,progress:standing.progress,requestId:standing.requestId,standing:standing as RequestStanding|null}))];
 if(!workers.length)return null;
 const counts=new Map<string,number>();
 for(const worker of workers)counts.set(groupOf(worker),(counts.get(groupOf(worker))??0)+1);
 // A stopped request is never hidden behind a working one: mixed states are counted, worst first.
 const mixed=counts.size>1?GROUP_ORDER.filter(group=>counts.has(group)).map(group=>`${counts.get(group)} ${group}`).join(' · '):null;
 if(counts.has('working'))
  return {kind:'worker_working' as const,text:mixed??(workers.length===1?`With ${workers[0]!.title}`:`With ${workers.length} agents`),sessionId:workers[0]!.sessionId,workers};
 const first=workers[0]!;
 return {kind:'worker_waiting' as const,text:mixed??`${first.title} · ${first.standing!.text}`,sessionId:first.sessionId,workers};
}

/** The standing of any request id: from the thread's own open requests, else computed (a routed request the thread does not list). */
export const standingFinder=(source:Database,standings:Map<string,RequestStanding>,nowMs:number)=>
 (requestId:string)=>standings.get(requestId)??requestStanding(source,requestId,nowMs);

/**
 * Whether what a waiting request waits on is itself stuck, so waking the holder cannot wait for the hour:
 * every request the holder sent is neither working nor held (its own standing is quiet or stalled), or a
 * watch its partial reply named is no longer observing. A dependency that is working or held, a peer
 * request, or a watch still observing keeps the hour.
 */
export function dependencyStuck(source:Database,requestId:string,standing:RequestStanding,nowMs:number):boolean{
 const row=source.query('SELECT target_session_id FROM session_communication_requests WHERE request_id=?').get(requestId) as {target_session_id:number}|null;
 if(!row)return false;
 if(standing.state==='waiting'){
  if(liveWatchOf(source,row.target_session_id,requestId,nowMs))return false;
  const waitingOn=dependencies(source,row.target_session_id,requestId);
  if(!waitingOn.agents.length)return false;
  if(waitingOn.peers)return false;
  return waitingOn.requestIds.every(id=>{const dep=requestStanding(source,id,nowMs);return !dep||dep.state==='quiet'||dep.state==='stalled';});
 }
 if(standing.state==='quiet'){
  const named=source.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='progress' AND json_extract(payload_json,'$.waitingOnWatch') IS NOT NULL LIMIT 1").get(requestId);
  return !!named&&!liveWatchOf(source,row.target_session_id,requestId,nowMs);
 }
 return false;
}

/** Whether a request the holder sent settled with a final reply after `sinceMs`: a dependency it waited on moved. */
export function dependencySettledSince(source:Database,holder:number,sinceMs:number):boolean{
 return !!source.query(`SELECT 1 FROM session_communication_events event JOIN session_communication_requests request ON request.request_id=event.request_id
  WHERE request.source_session_id=? AND event.kind='final' AND event.superseded_by_event_id IS NULL AND event.created_at_ms>? LIMIT 1`).get(holder,sinceMs);
}

export type InputRefusal={since:string;count:number;lastTurnId:number;reason:string};
/** A single empty or unacknowledged turn happens transiently (an owner restart); three in a row do not. */
export const INPUT_REFUSAL_THRESHOLD=3;
const STREAK_SCAN_LIMIT=200;

/**
 * Derived, never stored: set while the session's most recent turns that reached the provider all ended
 * without it taking their input. Keyed on columns closing a turn never rewrites: closing overwrites
 * agent_text and a cancelled request retires its turns, so the CODEX_INPUT_NOT_ACKNOWLEDGED text alone
 * is erased (concierge:8245, 2026-11-16). A turn breaks the streak when its input was acknowledged; it
 * counts as refused when unacknowledged and either a provider turn exists or the text still says so,
 * unless Stop was requested. Turns that never reached the provider, and a Stop before acknowledgement,
 * neither count nor break. Reads turns_session_latest (session_id, id DESC).
 */
export function inputRefusalStreak(source:Database,sessionId:number):InputRefusal|null{
 // Runs for every session view, so a healthy session reads only its latest three relevant turns; the
 // wider scan that counts the streak runs only once all three are refused.
 const latest=(limit:number)=>source.query(`SELECT id,COALESCE(ended_at,started_at) AS at,
   provider_input_acknowledged_at IS NULL AS refused
  FROM turns INDEXED BY turns_session_latest WHERE session_id=? AND status IN ('done','parked','error','cancelled')
   AND (provider_input_acknowledged_at IS NOT NULL
    OR ((provider_turn_id IS NOT NULL OR agent_text LIKE 'CODEX_INPUT_NOT_ACKNOWLEDGED:%') AND stop_requested_at IS NULL))
  ORDER BY id DESC LIMIT ?`)
  .all(sessionId,limit) as {id:number;at:string;refused:number}[];
 const head=latest(INPUT_REFUSAL_THRESHOLD);
 if(head.length<INPUT_REFUSAL_THRESHOLD||head.some(row=>row.refused!==1))return null;
 const rows=latest(STREAK_SCAN_LIMIT);
 let count=0;
 while(count<rows.length&&rows[count]!.refused===1)count++;
 if(count<INPUT_REFUSAL_THRESHOLD)return null;
 const since=new Date(/Z$|[+-]\d\d:?\d\d$/.test(rows[count-1]!.at)?rows[count-1]!.at:rows[count-1]!.at.replace(' ','T')+'Z').toISOString();
 const reason=`Cannot take messages: its last ${count} turns since ${since.slice(0,10)} ended without taking their input (Codex never acknowledged it). `
  +'Send this work to another session, or recover it with sessions codex-recover or a handoff.';
 return {since,count,lastTurnId:rows[0]!.id,reason};
}
