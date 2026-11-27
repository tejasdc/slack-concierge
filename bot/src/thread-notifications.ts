import {db} from './state';
import {inboxThreadRoot} from './session-inbox';
import {recordSessionEvent} from './session-inputs';

// The old session promises are deliberately inert. A human request arms one topic until
// an agent message in that topic consumes it in the same transaction as its push event.
export function armThreadNotification(input:{id:string;sessionId:number;kind:string;origin:string;payload:any;mark:'result'|'scheduled'|null}) {
  if(input.mark!=='result'||input.origin!=='human'||!['input','create','inbox-capture'].includes(input.kind))return;
  if(!db.query("SELECT 1 FROM sessions WHERE id=? AND json_extract(native_metadata_json,'$.inbox')=1").get(input.sessionId))return;
  const capture=input.payload?.capture;
  if(capture?.importOnly&&(capture?.source?.metadata?.quoted?.kind!=='human'||capture?.source?.metadata?.intent!=='action'))return;
  db.query('INSERT OR IGNORE INTO inbox_thread_notifications(input_id,inbox_session_id) VALUES(?,?)').run(input.id,input.sessionId);
}

function topic(sessionId:number,root:string):string|null {
  const row=db.query(`SELECT roots.topic_id FROM inbox_topic_roots roots
    JOIN inbox_topics topics ON topics.topic_id=roots.topic_id
    WHERE roots.root_input_id=? AND topics.session_id=?`).get(root,sessionId) as {topic_id:string}|null;
  return row?.topic_id??null;
}

function agentMessage(sessionId:number,root:string,messageId:string):{text:string;sequence:number;payload:any}|null {
  const row=db.query(`SELECT event.kind,event.payload_json,event.sequence,turn.agent_text FROM session_owner_events event
    LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE event.event_id=? AND event.session_id=? AND coalesce(json_extract(event.payload_json,'$.threadRoot'),event.input_id)=? AND event.kind IN ('post','result')`)
    .get(messageId,sessionId,root) as {kind:string;payload_json:string;sequence:number;agent_text:string|null}|null;
  if(!row)return null;
  const payload=JSON.parse(row.payload_json);
  if(row.kind==='post'&&payload.postedBy==='service')return null;
  const text=String(payload.text??row.agent_text??'').trim();
  return text?{text,sequence:row.sequence,payload}:null;
}

export function messageAlreadyNotified(sessionId:number,messageId:string):boolean {
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='needs_you'
    AND json_extract(payload_json,'$.postId')=?
    AND (json_extract(payload_json,'$.requestedNotification')=1 OR json_extract(payload_json,'$.blockingNotification')=1) LIMIT 1`)
    .get(sessionId,messageId);
}

/**
 * One agent turn rings him at most once per thread. On 2026-11-12 the Inbox agent filed an
 * approval question and, eight seconds later in the same turn, posted the same choice in plain
 * words with --notify: two rings, one decision ("I literally got 2 different notifications").
 * The first push of the turn stands; later ones from that turn stay in the thread unrung.
 */
export function threadRangThisRun(sessionId:number,root:string,runId:string|null|undefined):boolean {
  if(!runId)return false;
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE input_id=? AND session_id=? AND kind='needs_you'
    AND json_extract(payload_json,'$.runId')=?
    AND (json_extract(payload_json,'$.requestedNotification')=1 OR json_extract(payload_json,'$.blockingNotification')=1) LIMIT 1`)
    .get(root,sessionId,runId);
}

/** Consumes each covered arm in the transaction that writes its requested notification. */
export function consumeThreadNotification(sessionId:number,root:string,messageId:string,runId:string|null=null):string|null {
  if(messageAlreadyNotified(sessionId,messageId))return null;
  const message=agentMessage(sessionId,root,messageId);
  if(!message)return null;
  const current=topic(sessionId,root);
  if(!current)return null;
  const pending=db.query("SELECT input_id FROM inbox_thread_notifications WHERE inbox_session_id=? AND consumed_by_message_id IS NULL ORDER BY created_at,input_id")
    .all(sessionId) as {input_id:string}[];
  const rang=runId?db.query(`SELECT MAX(sequence) AS sequence FROM session_owner_events WHERE session_id=? AND input_id=? AND kind='needs_you' AND json_extract(payload_json,'$.runId')=? AND (json_extract(payload_json,'$.requestedNotification')=1 OR json_extract(payload_json,'$.blockingNotification')=1)`).get(sessionId,root,runId) as {sequence:number|null}:null;
  let first:string|null=null;
  for(const row of pending){
    if(db.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(row.input_id))continue;
    const admission=db.query(`SELECT MIN(sequence) AS sequence FROM session_owner_events
      WHERE session_id=? AND input_id=? AND kind IN ('accepted','inbox_capture')`).get(sessionId,row.input_id) as {sequence:number|null};
    if(admission.sequence===null||admission.sequence>=message.sequence||rang?.sequence!=null&&admission.sequence<=rang.sequence)continue;
    {
      const requestId=message.payload.requestId;
      if(typeof requestId==='string'){
        const direct=message.payload.replyToMessage?.messageId===row.input_id
          ||!!db.query(`SELECT 1 FROM session_communication_requests WHERE request_id=? AND source_input_id=? UNION ALL SELECT 1 FROM session_peer_requests WHERE request_id=? AND source_input_id=?`).get(requestId,row.input_id,requestId,row.input_id);
        const linked=!!db.query(`SELECT 1 FROM inbox_requests WHERE EXISTS(SELECT 1 FROM json_each(sources_json) source WHERE json_extract(source.value,'$.inputId')=?) AND EXISTS(SELECT 1 FROM json_each(dispatches_json) dispatch WHERE json_extract(dispatch.value,'$.requestId')=?)`).get(row.input_id,requestId);
        if(!direct&&!linked)continue;
      }else if(dispatchedFromInput(row.input_id))continue;
    }
    const askingRoot=inboxThreadRoot(sessionId,row.input_id);
    if(!askingRoot||topic(sessionId,askingRoot)!==current)continue;
    const changed=db.query('UPDATE inbox_thread_notifications SET consumed_by_message_id=?,consumed_at=CURRENT_TIMESTAMP WHERE input_id=? AND consumed_by_message_id IS NULL')
      .run(messageId,row.input_id);
    if(changed.changes&&!first)first=row.input_id;
  }
  return first;
}

export function hasPendingThreadNotification(sessionId:number,root:string):boolean {
  const current=topic(sessionId,root);
  if(!current)return false;
  const pending=db.query("SELECT input_id FROM inbox_thread_notifications WHERE inbox_session_id=? AND consumed_by_message_id IS NULL")
    .all(sessionId) as {input_id:string}[];
  return pending.some(row=>{
    if(db.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(row.input_id))return false;
    const askingRoot=inboxThreadRoot(sessionId,row.input_id);
    return !!askingRoot&&topic(sessionId,askingRoot)===current;
  });
}

export function dispatchedFromInput(inputId:string):boolean {
  // A follower's copy of his message (action follow:…) is not work dispatched from it.
  return !!db.query(`SELECT 1 FROM session_communication_requests WHERE outcome IS NULL AND (source_input_id=? OR thread_root_input_id=?) AND action_id NOT LIKE 'follow:%'
    UNION ALL SELECT 1 FROM session_peer_requests WHERE outcome IS NULL AND (source_input_id=? OR thread_root_input_id=?) AND action_id NOT LIKE 'follow:%'
    UNION ALL SELECT 1 FROM inbox_requests obligations, json_each(obligations.dispatches_json) dispatch
      WHERE EXISTS(SELECT 1 FROM json_each(obligations.sources_json) source WHERE json_extract(source.value,'$.inputId')=?)
      AND (EXISTS(SELECT 1 FROM session_communication_requests work WHERE work.request_id=json_extract(dispatch.value,'$.requestId') AND work.outcome IS NULL)
        OR EXISTS(SELECT 1 FROM session_peer_requests work WHERE work.request_id=json_extract(dispatch.value,'$.requestId') AND work.outcome IS NULL)) LIMIT 1`)
    .get(inputId,inputId,inputId,inputId,inputId);
}

/** Only an explicit reconciliation of the current checked final may pass an earlier turn ring. */
function checkedCompletionRecovery(sessionId:number,root:string,messageId:string,runId:string|null,eventId:string):boolean {
  const row=db.query(`SELECT event.request_id,event.payload_json,request.target_session_id,request.source_session_id,
      request.outcome,request.result_json
    FROM session_communication_events event JOIN session_communication_requests request ON request.request_id=event.request_id
    WHERE event.event_id=? AND event.kind='final' AND event.superseded_by_event_id IS NULL`).get(eventId) as
    {request_id:string;payload_json:string;target_session_id:number;source_session_id:number;outcome:string|null;result_json:string|null}|null;
  if(!row||row.source_session_id!==sessionId||row.outcome!=='answered'||!row.result_json)return false;
  const result=JSON.parse(row.result_json),payload=JSON.parse(row.payload_json);
  if(result.event_id!==eventId||payload.final!==true||payload.notify!==true||payload.workDisposition!=='completed'
    ||payload.responding_session_id!==`concierge:${row.target_session_id}`||!runId||payload.source?.run_id!==runId
    ||typeof payload.source?.input_id!=='string'||typeof payload.closingLine!=='string'
    ||!payload.closingLine.startsWith('Completed · Checked on the real system: ')
    ||!payload.closingLine.slice('Completed · Checked on the real system: '.length).trim())return false;
  const source=db.query(`SELECT input.session_id,turn.native_run_id FROM session_inputs input
    JOIN turns turn ON turn.id=input.turn_id AND turn.session_id=input.session_id WHERE input.id=?`)
    .get(payload.source.input_id) as {session_id:number;native_run_id:string|null}|null;
  if(!source||source.session_id!==row.target_session_id||source.native_run_id!==runId)return false;
  const closure=db.query(`SELECT coalesce(json_extract(payload_json,'$.threadRoot'),input_id) AS root,payload_json FROM session_owner_events
    WHERE event_id=? AND session_id=? AND kind='answer_closure'`).get(`post:closure:${eventId}`,sessionId) as {root:string|null;payload_json:string}|null;
  const details=closure?JSON.parse(closure.payload_json):null;
  if(!closure?.root||details?.postId!==messageId||details.requestId!==row.request_id
    ||details.closingLine!==payload.closingLine||!topic(sessionId,closure.root)
    ||topic(sessionId,closure.root)!==topic(sessionId,root))return false;
  const post=agentMessage(sessionId,root,messageId);
  if(!post||post.payload.postedBySession!==payload.responding_session_id)return false;
  let postSource=post.payload.answerSource;
  if(!postSource&&typeof post.payload.answerGroup==='string'){
    const original=db.query("SELECT event_id,payload_json FROM session_owner_events WHERE event_id=? AND session_id=? AND kind='post'")
      .get(post.payload.answerGroup,sessionId) as {event_id:string;payload_json:string}|null;
    const originalPayload=original?JSON.parse(original.payload_json):null;
    if(original?.event_id.startsWith('post:forward:')
      &&messageId===`post:forward:shared:${original.event_id.slice('post:forward:'.length)}:${topic(sessionId,root)}`
      &&originalPayload.postedBySession===payload.responding_session_id)postSource=originalPayload.answerSource;
  }
  return postSource?.inputId===payload.source.input_id&&postSource?.runId===runId;
}

/** An explicitly notified post carries its own words and consumes any open topic arm. */
export function notifyAgentPost(sessionId:number,root:string,messageId:string,text:string,force=true,runId:string|null=null,checkedCompletionEventId?:string):void {
  if(!text.trim())throw new Error('--notify requires words in the message being posted.');
  if(agentMessage(sessionId,root,messageId)?.text!==text.trim())throw new Error('--notify requires the exact words of an existing agent post.');
  db.transaction(()=>{
    const completionRecovery=checkedCompletionEventId!==undefined
      ? force&&checkedCompletionRecovery(sessionId,root,messageId,runId,checkedCompletionEventId) : false;
    if(checkedCompletionEventId!==undefined&&!completionRecovery)throw new Error('Notification recovery requires the exact accepted checked final and post custody.');
    const eventId=`needs_you:requested:${messageId}`;
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return;
    if(messageAlreadyNotified(sessionId,messageId))return;
    // A later accepted human request may ring again even in the same agent run.
    const asking=consumeThreadNotification(sessionId,root,messageId,runId);
    if(threadRangThisRun(sessionId,root,runId)&&!asking&&!completionRecovery)return;
    if(!force&&!asking)return;
    recordSessionEvent({eventId,sessionId,inputId:root,kind:'needs_you',payload:{outcome:'response',question:text.trim().slice(0,2000),
      inputId:root,postId:messageId,requestedNotification:true,...(asking?{notificationInputId:asking}:{}),...(runId?{runId}:{}),
      ...(completionRecovery?{completionReplyEventId:checkedCompletionEventId}:{})}});
  })();
}
