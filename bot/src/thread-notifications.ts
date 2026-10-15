import {db} from './state';
import {inboxThreadRoot} from './session-inbox';
import {recordSessionEvent} from './session-inputs';

// The old session promises are deliberately inert. A human request arms one topic until
// an agent message in that topic consumes it in the same transaction as its push event.
export function armThreadNotification(input:{id:string;sessionId:number;kind:string;origin:string;payload:any;mark:'result'|'scheduled'|null}) {
  if(input.mark!=='result'||input.origin!=='human'||!['input','create','inbox-capture'].includes(input.kind))return;
  if(!db.query("SELECT 1 FROM sessions WHERE id=? AND json_extract(native_metadata_json,'$.inbox')=1").get(input.sessionId))return;
  const capture=input.payload?.capture;
  if(capture?.importOnly&&capture?.source?.metadata?.quoted?.kind!=='human')return;
  db.query('INSERT OR IGNORE INTO inbox_thread_notifications(input_id,inbox_session_id) VALUES(?,?)').run(input.id,input.sessionId);
}

function topic(sessionId:number,root:string):string|null {
  const row=db.query(`SELECT roots.topic_id FROM inbox_topic_roots roots
    JOIN inbox_topics topics ON topics.topic_id=roots.topic_id
    WHERE roots.root_input_id=? AND topics.session_id=?`).get(root,sessionId) as {topic_id:string}|null;
  return row?.topic_id??null;
}

function agentMessage(sessionId:number,root:string,messageId:string):{text:string;sequence:number}|null {
  const row=db.query(`SELECT event.kind,event.payload_json,event.sequence,turn.agent_text FROM session_owner_events event
    LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE event.event_id=? AND event.session_id=? AND coalesce(json_extract(event.payload_json,'$.threadRoot'),event.input_id)=? AND event.kind IN ('post','result')`)
    .get(messageId,sessionId,root) as {kind:string;payload_json:string;sequence:number;agent_text:string|null}|null;
  if(!row)return null;
  const payload=JSON.parse(row.payload_json);
  if(row.kind==='post'&&payload.postedBy==='service')return null;
  const text=String(payload.text??row.agent_text??'').trim();
  return text?{text,sequence:row.sequence}:null;
}

export function messageAlreadyNotified(sessionId:number,messageId:string):boolean {
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='needs_you'
    AND json_extract(payload_json,'$.postId')=? AND json_extract(payload_json,'$.requestedNotification')=1 LIMIT 1`)
    .get(sessionId,messageId);
}

/** Consumes all pending requests in this topic. A later human request inserts a new arm. */
export function consumeThreadNotification(sessionId:number,root:string,messageId:string):string|null {
  if(messageAlreadyNotified(sessionId,messageId))return null;
  const message=agentMessage(sessionId,root,messageId);
  if(!message)return null;
  const current=topic(sessionId,root);
  if(!current)return null;
  const pending=db.query("SELECT input_id FROM inbox_thread_notifications WHERE inbox_session_id=? AND consumed_by_message_id IS NULL ORDER BY created_at,input_id")
    .all(sessionId) as {input_id:string}[];
  let first:string|null=null;
  for(const row of pending){
    if(db.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(row.input_id))continue;
    const admission=db.query(`SELECT MIN(sequence) AS sequence FROM session_owner_events
      WHERE session_id=? AND input_id=? AND kind IN ('accepted','inbox_capture')`).get(sessionId,row.input_id) as {sequence:number|null};
    if(admission.sequence===null||admission.sequence>=message.sequence)continue;
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
  return !!db.query('SELECT 1 FROM session_communication_requests WHERE source_input_id=? LIMIT 1').get(inputId)
    ||!!db.query('SELECT 1 FROM session_peer_requests WHERE source_input_id=? LIMIT 1').get(inputId);
}

/** An explicitly notified post carries its own words and consumes any open topic arm. */
export function notifyAgentPost(sessionId:number,root:string,messageId:string,text:string,force=true):void {
  if(!text.trim())throw new Error('--notify requires words in the message being posted.');
  if(agentMessage(sessionId,root,messageId)?.text!==text.trim())throw new Error('--notify requires the exact words of an existing agent post.');
  db.transaction(()=>{
    const eventId=`needs_you:requested:${messageId}`;
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return;
    if(messageAlreadyNotified(sessionId,messageId))return;
    const asking=consumeThreadNotification(sessionId,root,messageId);
    if(!force&&!asking)return;
    recordSessionEvent({eventId,sessionId,inputId:root,kind:'needs_you',payload:{outcome:'response',question:text.trim().slice(0,2000),
      inputId:root,postId:messageId,requestedNotification:true,...(asking?{notificationInputId:asking}:{})}});
  })();
}
