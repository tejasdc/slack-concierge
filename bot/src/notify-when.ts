import {db,executionChanged,getSessionById} from './state';
import type {AcceptedSessionInput} from './session-inputs';
import type {PeerClient} from './session-peers';
import type {SessionOwner} from './session-owner';
import {log,errorFields} from './log';

// A result request is a durable obligation of the exact human input. The owner commits its
// terminal state with the Inbox event that describes it; the notifier consumes that event.
const PROMISE_LIFETIME_MS=14*24*60*60*1000;
type PromiseRow={input_id:string;inbox_session_id:number;thread_root_id:string|null;target_session:string|null;
  pointed_at_ms:number|null;created_at_ms:number;baseline_turn_id:number|null;target_run_id:string|null;conditions:string;summary:string;
  state:'pending'|'fired'|'expired';expires_at_ms:number;last_peer_observed_at_ms:number|null;fired_event_id:string|null;
  peer_cursor:string;peer_candidate_run_id:string|null;peer_candidate_state:string|null;peer_candidate_input_id:string|null;
  peer_registration_crossed:number;peer_selected_input_id:string|null;peer_gap_since_ms:number|null};
const promise=(inputId:string)=>db.query('SELECT * FROM inbox_notification_promises WHERE input_id=?').get(inputId) as PromiseRow|null;
const event=(eventId:string,sessionId:number,inputId:string,kind:string,payload:unknown)=>{
  db.query('INSERT OR IGNORE INTO session_owner_events(event_id,session_id,input_id,kind,payload_json) VALUES(?,?,?,?,?)')
    .run(eventId,sessionId,inputId,kind,JSON.stringify(payload));
  executionChanged();
};
const post=(row:PromiseRow,part:string,text:string)=>event(`notify-when:${part}:${row.input_id}`,row.inbox_session_id,row.input_id,'post',
  {text,postedBy:'service',replyToMessage:{kind:'message',sessionId:`concierge:${row.inbox_session_id}`,messageId:row.thread_root_id??row.input_id}});

export function retainNotificationPromise(input:{id:string;sessionId:number;kind:string;origin:string;payload:any;mark:'result'|'scheduled'|null}){
  if(input.mark!=='result'||input.origin!=='human'||!['input','create','inbox-capture'].includes(input.kind))return;
  const inbox=db.query("SELECT 1 FROM sessions WHERE id=? AND json_extract(native_metadata_json,'$.inbox')=1").get(input.sessionId);
  if(!inbox)return;
  // A saved quotation of an agent's words is not a request from Tejas.
  const capture=input.payload?.capture;
  if(capture?.importOnly&&capture?.source?.metadata?.quoted?.kind!=='human')return;
  const words=String(input.payload?.firstInput?.text??input.payload?.text??'').trim();
  const now=Date.now();
  db.query(`INSERT OR IGNORE INTO inbox_notification_promises
    (input_id,inbox_session_id,conditions,summary,expires_at_ms,created_at_ms,updated_at_ms)
    VALUES(?,?,'answer',?,?,?,?)`).run(input.id,input.sessionId,words.slice(0,240),now+PROMISE_LIFETIME_MS,now,now);
}

/** Called after the human's own Inbox row, so the promise appears in that thread in order. */
export function showNotificationPromise(inputId:string){
  const row=promise(inputId);
  if(row)post(row,'made','Phone notification requested for this message; it will follow the answer in this thread.');
}

export function requestedNotificationInput(inputId:string):boolean{return !!promise(inputId);}
export function notificationPromisePointed(inputId:string):boolean{
  const row=promise(inputId);
  return !!row?.target_session&&row.state!=='expired';
}
export function responseSettlesNotification(inputId:string):boolean{
  const row=promise(inputId);
  return !!row&&row.state==='pending'&&!row.target_session&&row.expires_at_ms>Date.now();
}
export function notificationAnswerEligible(inputId:string):boolean{
  const row=promise(inputId);
  if(!row)return true; // A retained request from before this schema keeps its old delivery path.
  if(row.state==='pending'&&row.expires_at_ms<=Date.now())finish(row,'expired','Phone notification expired before the requested result was observed.');
  return promise(inputId)?.state==='pending';
}
export function notificationPromiseTerminal(inputId:string):boolean{
  const row=promise(inputId);return !!row&&row.state!=='pending';
}
export function notificationPromiseCovered(inputId:string):boolean{
  const row=promise(inputId);
  return !!row?.target_session||!!db.query('SELECT 1 FROM session_communication_requests WHERE source_input_id=? LIMIT 1').get(inputId)
    ||!!db.query('SELECT 1 FROM session_peer_requests WHERE source_input_id=? LIMIT 1').get(inputId);
}

export function pointNotificationPromise(input:{inputId:string;root:string;target:string;conditions:string[];summary:string;
  peerView?:{activeRunId?:string|null;latestRunId?:string|null}|null}){
  const row=promise(input.inputId);
  if(!row||row.state!=='pending'||row.expires_at_ms<=Date.now())throw new Error('This exact human input has no pending phone notification request.');
  const conditions=[...new Set(input.conditions)];
  if(!conditions.length||conditions.some(value=>!['done','needs-you','hold'].includes(value)))
    throw new Error('--on takes done,needs-you,hold (comma separated).');
  if(!input.summary.trim()||input.summary.length>240)throw new Error('--summary takes up to 240 characters from what he asked.');
  const asking=db.query('SELECT payload_json FROM session_inputs WHERE id=?').get(input.inputId) as {payload_json:string}|null;
  const words=asking?JSON.parse(asking.payload_json):null;
  const said=String(words?.firstInput?.text??words?.text??'');
  if(!said.toLocaleLowerCase().includes(input.summary.trim().toLocaleLowerCase()))
    throw new Error('--summary must quote a short contiguous part of the asking human input.');
  const local=/^concierge:([1-9]\d*)$/.exec(input.target);
  const remote=/^([a-z][a-z0-9-]{0,31}):([1-9]\d*)$/.exec(input.target);
  if(!local&&!remote)throw new Error('--session needs an exact concierge:N or peer:N session address.');
  let baselineTurn:number|null=null,targetRun:string|null=null;
  if(local){
    const id=Number(local[1]);
    if(!getSessionById(id))throw new Error('The named session does not exist here.');
    const active=db.query("SELECT id,native_run_id FROM turns WHERE session_id=? AND status IN ('running','delivering') ORDER BY id DESC LIMIT 1").get(id) as {id:number;native_run_id:string|null}|null;
    const waiting=active?null:db.query("SELECT id,native_run_id FROM turns WHERE session_id=? AND status='queued' AND saved_kind IS NULL ORDER BY id LIMIT 1")
      .get(id) as {id:number;native_run_id:string|null}|null;
    const selected=active??waiting;
    baselineTurn=selected?.id??(db.query('SELECT COALESCE(MAX(id),0) AS id FROM turns WHERE session_id=?').get(id) as {id:number}).id;
    targetRun=selected?.native_run_id??null;
  } else {
    const peer=remote![1],remoteId=`concierge:${remote![2]}`;
    const card=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(peer,remoteId) as {view_json:string}|null;
    const view=input.peerView??(card?JSON.parse(card.view_json):null);
    targetRun=typeof view?.activeRunId==='string'?view.activeRunId:null;
  }
  return db.transaction(()=>{
    const current=promise(input.inputId)!;
    if(current.target_session){
      if(current.target_session===input.target&&current.conditions===conditions.join(',')&&current.summary===input.summary.trim())return {inputId:row.input_id,duplicate:true};
      throw new Error('This notification is already pointed at a session; it cannot be silently retargeted.');
    }
    db.query(`UPDATE inbox_notification_promises SET thread_root_id=?,target_session=?,pointed_at_ms=?,baseline_turn_id=?,target_run_id=?,
      conditions=?,summary=?,updated_at_ms=? WHERE input_id=? AND state='pending' AND target_session IS NULL`)
      .run(input.root,input.target,Date.now(),baselineTurn,targetRun,conditions.join(','),input.summary.trim(),Date.now(),input.inputId);
    post({...row,thread_root_id:input.root},'pointed',`Phone notification set for ${input.summary.trim()} (${conditions.join(', ')}).`);
    return {inputId:row.input_id,target:input.target,conditions,duplicate:false};
  })();
}

function finish(row:PromiseRow,state:'fired'|'expired',text:string,sourceEventId?:string){
  db.transaction(()=>{
    const changed=db.query("UPDATE inbox_notification_promises SET state=?,fired_event_id=?,updated_at_ms=? WHERE input_id=? AND state='pending'")
      .run(state,sourceEventId??`notify-when:${state}:${row.input_id}`,Date.now(),row.input_id);
    if(!changed.changes)return;
    post(row,state,text);
    if(state==='fired'&&!sourceEventId){
      event(`needs_you:notify-when:${row.input_id}`,row.inbox_session_id,row.thread_root_id??row.input_id,'needs_you',
        {outcome:'response',question:text,inputId:row.thread_root_id??row.input_id,notificationInputId:row.input_id,
          postId:`notify-when:fired:${row.input_id}`});
    }
  })();
}

/** The ordinary filed answer already emitted its one requested-result event. */
export function settleNotificationByAnswer(inputId:string,sourceEventId:string){
  const row=promise(inputId);
  if(row?.state==='pending')finish(row,'fired','Phone notification fulfilled by the answer in this thread.',sourceEventId);
}

export function reconcileLocalNotificationPromises(owner:SessionOwner,now=Date.now()){
  const rows=db.query(`SELECT * FROM inbox_notification_promises WHERE state='pending'
    AND (target_session LIKE 'concierge:%' OR expires_at_ms<=?) ORDER BY expires_at_ms`).all(now) as PromiseRow[];
  for(const row of rows){
    if(row.expires_at_ms<=now){finish(row,'expired','Phone notification expired before the requested result was observed.');continue;}
    if(!row.target_session?.startsWith('concierge:'))continue;
    const sessionId=Number(row.target_session.slice('concierge:'.length));
    const firstId=(row.baseline_turn_id??0)+(row.target_run_id?0:1);
    const turn=db.query(`SELECT id,status,accepted_input_id FROM turns
      WHERE session_id=? AND id>=? ORDER BY id LIMIT 1`).get(sessionId,firstId) as
      {id:number;status:string;accepted_input_id:string|null}|null;
    if(!turn)continue;
    const conditions=row.conditions.split(',');
    const label=row.summary.replace(/[.?!]+$/,'');
    const retained=turn.accepted_input_id?db.query('SELECT * FROM session_inputs WHERE id=?').get(turn.accepted_input_id) as AcceptedSessionInput|null:null;
    const detail=conditions.includes('hold')&&turn.status==='queued'&&retained?owner.receipt(retained).statusDetail:null;
    if(detail&&['PROVIDER_AUTH_HELD','PROVIDER_USAGE_HELD'].includes(detail.code))
      finish(row,'fired',`${label} is waiting: ${detail.message}`);
    else if(conditions.includes('needs-you')&&db.query("SELECT 1 FROM session_owner_events WHERE turn_id=? AND kind='turn_outcome' AND json_extract(payload_json,'$.outcome')='needs_you' LIMIT 1").get(turn.id))
      finish(row,'fired',`${label} needs your answer.`);
    else if(conditions.includes('done')&&['done','error','cancelled'].includes(turn.status))
      finish(row,'fired',turn.status==='done'?`${label} finished.`:`${label} ended without finishing (${turn.status}).`);
  }
  return rows.length;
}

/** Shared by both the native and adapter compositions; the owner remains the only writer. */
export function startLocalNotificationPromiseWatch(owner:SessionOwner,stopped:()=>boolean){
  const reconcile=()=>{
    if(stopped())return;
    try {reconcileLocalNotificationPromises(owner);} catch(error) {log('error','notify_when_reconciliation_failed',errorFields(error));}
  };
  reconcile();
  const timer=setInterval(reconcile,5_000);
  timer.unref?.();
  return ()=>clearInterval(timer);
}

export function hasPeerNotificationPromises(peer:string){
  return !!db.query("SELECT 1 FROM inbox_notification_promises WHERE target_session LIKE ? AND state='pending' LIMIT 1").get(`${peer}:%`);
}

/** Each peer page is handled with its cursor in the same owner transaction as any firing. */
export async function reconcilePeerNotificationPromises(peer:string,client:PeerClient){
  const rows=db.query("SELECT * FROM inbox_notification_promises WHERE target_session LIKE ? AND state='pending' ORDER BY created_at_ms")
    .all(`${peer}:%`) as PromiseRow[];
  let more=false;
  for(const initial of rows){
    const row=promise(initial.input_id);
    if(!row||row.state!=='pending')continue;
    const localId=`concierge:${row.target_session!.split(':')[1]}`;
    try {
      const page=await client.request<{events:Array<{cursor:string;kind:string;runId:string|null;inputId:string|null;at:string|null;payload:any}>;nextCursor:string|null;hasMore:boolean}>(
        'GET','/sessions/v1/events?'+new URLSearchParams({after:row.peer_cursor,sessionId:localId,kind:'accepted,run,turn_outcome',limit:'100'}),
        undefined,8_000,false);
      const events=Array.isArray(page.events)?page.events:[];
      let targetRun=row.target_run_id,selectedInput=row.peer_selected_input_id;
      let candidateRun=row.peer_candidate_run_id,candidateState=row.peer_candidate_state,candidateInput=row.peer_candidate_input_id;
      let crossed=row.peer_registration_crossed===1;
      let observedNeed=false,observedTerminal:string|null=null;
      for(const entry of events){
        if(!crossed){
          const at=Date.parse(entry.at??'');
          // The peer event timestamp has second precision. Include the boundary second so a
          // run that starts immediately after registration cannot disappear in that rounding.
          if(Number.isFinite(at)&&at+999<(row.pointed_at_ms??row.created_at_ms)){
            if(entry.runId&&entry.kind==='accepted'){candidateRun=entry.runId;candidateState='queued';candidateInput=entry.inputId;}
            if(entry.runId&&entry.kind==='run'){candidateRun=entry.runId;candidateState=String(entry.payload?.run?.state??'');}
            continue;
          }
          crossed=true;
          if(!targetRun&&['queued','running'].includes(candidateState??'')){targetRun=candidateRun;selectedInput=candidateInput;}
        }
        if(!targetRun){
          if(entry.runId&&(entry.kind==='accepted'||entry.kind==='run'&&['queued','running'].includes(String(entry.payload?.run?.state))))targetRun=entry.runId;
        }
        if(!targetRun||entry.runId!==targetRun)continue;
        if(entry.kind==='accepted'&&entry.inputId)selectedInput=entry.inputId;
        if(entry.kind==='turn_outcome'&&entry.payload?.outcome==='needs_you')observedNeed=true;
        if(entry.kind==='run'&&['completed','failed','canceled'].includes(String(entry.payload?.run?.state)))
          observedTerminal=String(entry.payload.run.state);
      }
      if(!crossed&&!page.hasMore&&['queued','running'].includes(candidateState??'')){
        crossed=true;
        if(!targetRun){targetRun=candidateRun;selectedInput=candidateInput;}
      }
      const receipt=selectedInput&&row.conditions.includes('hold')
        ?await client.request<{statusDetail?:{code?:string;message?:string}}>('GET',`/sessions/v1/operations/${encodeURIComponent(selectedInput)}`,undefined,8_000,false).catch(()=>null):null;
      db.transaction(()=>{
        const current=promise(row.input_id);
        if(!current||current.state!=='pending'||current.peer_cursor!==row.peer_cursor)return;
        const now=Date.now();
        db.query(`UPDATE inbox_notification_promises SET peer_cursor=?,target_run_id=?,peer_selected_input_id=?,
          peer_candidate_run_id=?,peer_candidate_state=?,peer_candidate_input_id=?,peer_registration_crossed=?,
          last_peer_observed_at_ms=?,peer_gap_since_ms=NULL,updated_at_ms=? WHERE input_id=?`)
          .run(page.nextCursor??row.peer_cursor,targetRun,selectedInput,candidateRun,candidateState,candidateInput,crossed?1:0,now,now,row.input_id);
        if(current.peer_gap_since_ms)post(current,'gap-ended',`${peer} reconnected; the saved session events are being checked after the observation gap.`);
        const updated=promise(row.input_id)!;
        const label=updated.summary.replace(/[.?!]+$/,'');
        if(updated.conditions.includes('needs-you')&&observedNeed)finish(updated,'fired',`${label} needs your answer.`);
        else if(updated.conditions.includes('hold')&&/^PROVIDER_(?:AUTH|USAGE)_HELD$/.test(receipt?.statusDetail?.code??''))
          finish(updated,'fired',`${label} is waiting: ${receipt?.statusDetail?.message??'an account or usage problem needs attention.'}`);
        else if(updated.conditions.includes('done')&&observedTerminal)
          finish(updated,'fired',observedTerminal==='completed'?`${label} finished.`:`${label} ended without finishing (${observedTerminal}).`);
      })();
      if(page.hasMore)more=true;
    } catch {
      db.transaction(()=>{
        const current=promise(row.input_id);
        if(!current||current.state!=='pending'||current.peer_gap_since_ms)return;
        db.query('UPDATE inbox_notification_promises SET peer_gap_since_ms=?,updated_at_ms=? WHERE input_id=?').run(Date.now(),Date.now(),row.input_id);
        post(current,'gap',`${peer} session observation is unavailable. This phone notification is still waiting; retained events will be checked when the connection resumes.`);
      })();
    }
  }
  return more;
}
