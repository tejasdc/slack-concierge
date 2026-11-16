import type {Database} from 'bun:sqlite';
import {PROMPT_ANSWER_REMINDER_MS} from './prompt-answer-policy';

type Asked={kind?:string;topicId:string;questionId?:string;id?:string;owner?:any;sources?:string[]};
const parse=(raw:string|null|undefined)=>{try{return JSON.parse(raw??'{}');}catch{return {};}};

/** A retained question names its dispatch. Older questions may use their exact obligation's
 * source link, but a shared thread or several attempts never chooses an answer for them. */
export function askedDispatch(db:Database,question:Asked):string|null {
 if(question.kind!=='asked')return null;
 const explicit=question.owner?.dispatchRequestId;
 if(typeof explicit==='string'&&explicit)return explicit;
 const sources=question.sources??[];
 if(!sources.length)return null;
 const rows=db.query(`SELECT dispatches_json FROM inbox_requests WHERE topic_id=?
  AND EXISTS(SELECT 1 FROM json_each(inbox_requests.sources_json) source
   WHERE json_extract(source.value,'$.inputId') IN (SELECT value FROM json_each(?)))`).all(question.topicId,JSON.stringify(sources)) as {dispatches_json:string}[];
 const ids=new Set<string>();
 for(const row of rows)for(const dispatch of JSON.parse(row.dispatches_json))
  if(typeof dispatch.requestId==='string')ids.add(dispatch.requestId);
 return ids.size===1?[...ids][0]!:null;
}

/** Semantic answer evidence is shared by recovery diagnostics and question projections. */
export const ANSWERING_POST_SQL=`(coalesce(json_extract(payload_json,'$.postedBy'),'')<>'service' AND
 (json_extract(payload_json,'$.answersQuestion')=1
 OR (json_extract(payload_json,'$.replyKind')='final' AND json_extract(payload_json,'$.workDisposition')='completed')))`;

export function askedAnswerPostIds(db:Database,question:Asked,sessionIds:number[]):string[]{
 if(!sessionIds.length)return [];
 const dispatch=askedDispatch(db,question),sources=question.sources??[];
 const followups=dispatch?sources.slice(1):sources;
 const expanded=new Set(followups);
 for(const id of followups){
  const routes=db.query(`SELECT payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route')
   AND (event_id=? OR json_extract(payload_json,'$.sourceMessageId')=?) LIMIT 2`).all(id,id) as {payload_json:string}[];
  if(routes.length===1){const route=parse(routes[0]!.payload_json);for(const key of ['sourceMessageId','destinationMessageId'])if(typeof route[key]==='string')expanded.add(route[key]);}
 }
 return (db.query(`SELECT event_id FROM session_owner_events WHERE session_id IN (${sessionIds.map(()=>'?').join(',')})
  AND kind='post' AND ((?<>'' AND json_extract(payload_json,'$.requestId')=?)
   OR json_extract(payload_json,'$.replyToMessage.messageId') IN (SELECT value FROM json_each(?)))
  AND ${ANSWERING_POST_SQL} ORDER BY sequence`).all(...sessionIds,dispatch??'',dispatch??'',JSON.stringify([...expanded])) as {event_id:string}[]).map(row=>row.event_id);
}

function request(db:Database,id:string){
 const local=db.query(`SELECT request_id,payload_json,outcome,result_json,created_at_ms,due_at_ms,
  prompt_answered_at_ms,prompt_reminded_at_ms,overdue_at_ms,stalled_at_ms,target_input_id
  FROM session_communication_requests WHERE request_id=?`).get(id) as any;
 if(local)return {...local,table:'session_communication_requests',events:'session_communication_events',peer:null};
 const remote=db.query(`SELECT request_id,payload_json,outcome,result_json,created_at_ms,due_at_ms,
  prompt_answered_at_ms,prompt_reminded_at_ms,overdue_at_ms,stalled_at_ms,remote_status_json,peer,status
  FROM session_peer_requests WHERE request_id=?`).get(id) as any;
 return remote?{...remote,table:'session_peer_requests',events:'session_peer_events'}:null;
}

/** Called only by the canonical writer after accepting an asked-question/link mutation.
 * Existing answer events settle the clock; this never dispatches or replays the original work. */
export function requireAskedAnswer(db:Database,question:Asked):boolean {
 const id=askedDispatch(db,question);if(!id)return false;
 const row=request(db,id);if(!row||row.outcome)return false;
 const payload=parse(row.payload_json);
 if(payload.promptAnswer)return false;
 const answer=db.query(`SELECT created_at_ms FROM ${row.events} WHERE request_id=? AND superseded_by_event_id IS NULL
  AND (kind='final' OR json_extract(payload_json,'$.answersQuestion')=1) ORDER BY created_at_ms LIMIT 1`).get(id) as {created_at_ms:number}|null;
 const questionId=question.questionId??question.id;if(!questionId)return false;
 db.query(`UPDATE ${row.table} SET payload_json=json_set(payload_json,'$.promptAnswer',1,
  '$.promptAnswerQuestionId',?,'$.promptAnswerRequiredAtMs',?),
  prompt_answered_at_ms=coalesce(prompt_answered_at_ms,?),
  overdue_at_ms=CASE WHEN ? IS NULL THEN NULL ELSE overdue_at_ms END,
  due_at_ms=CASE WHEN ? IS NULL THEN min(due_at_ms,?) ELSE due_at_ms END
  WHERE request_id=? AND outcome IS NULL`).run(questionId??null,Date.now(),answer?.created_at_ms??null,
   answer?.created_at_ms??null,answer?.created_at_ms??null,row.created_at_ms+PROMPT_ANSWER_REMINDER_MS,id);
 return true;
}

export function reconcileAskedAnswerClocks(db:Database):void {
 for(const row of db.query("SELECT question_id,topic_id,owner_json,sources_json FROM inbox_questions WHERE kind='asked' AND state IN ('open','partial')").all() as any[])
  requireAskedAnswer(db,{kind:'asked',questionId:row.question_id,topicId:row.topic_id,owner:parse(row.owner_json),sources:JSON.parse(row.sources_json)});
}

/** Publish words, not a second status vocabulary for every client to reconstruct. */
export function askedAnswerStatus(db:Database,question:Asked,answered:boolean):{text:string;delayed:boolean}|undefined {
 if(question.kind!=='asked')return undefined;
 if(answered)return {text:'Answered',delayed:false};
 const id=askedDispatch(db,question);
 if(!id)return {text:'Waiting for an agent to be assigned to this question',delayed:false};
 const row=request(db,id);
 if(!row)return {text:'The original request record is unavailable; the question is still recorded',delayed:false};
 const result=parse(row.result_json),payload=parse(row.payload_json);
 if(result.workDisposition==='needs_decision'||row.outcome==='decision_needed')
  return {text:typeof result.summary==='string'&&result.summary.trim()?`Waiting on you: ${result.summary.trim()}`:'Waiting on your answer in the original thread',delayed:false};
 if(row.outcome)return {text:row.outcome==='answered'?'An answer was recorded; its delivery to this question is unconfirmed'
  :row.outcome==='canceled'?'The attempt was stopped; the question remains recorded':'The answer attempt ended; recovery is still owed',delayed:false};
 for(const dependency of Array.isArray(payload.after)?payload.after:[]){
  const prior=request(db,String(dependency));
  if(prior&&prior.outcome!=='answered'){
   const label=parse(prior.payload_json).summary;
   return {text:prior.outcome?`Waiting on unfinished prerequisite${typeof label==='string'?`: ${label}`:''}`
    :`Waiting for an earlier request${typeof label==='string'?`: ${label}`:''}`,delayed:false};
  }
 }
 if(row.peer){
  const remote=parse(row.remote_status_json);
  if(remote.hold?.message)return {text:String(remote.hold.message),delayed:false};
  if(row.status==='queued_offline')return {text:`Waiting for ${row.peer} to reconnect`,delayed:false};
  if(payload.promptAnswerQuestionId&&!payload.promptAnswerPeerAcknowledged)
   return {text:`${row.overdue_at_ms!==null?'Answer delayed; waiting for':'Waiting for an answer from'} ${row.peer==='mac'?'your Mac':row.peer}`,delayed:row.overdue_at_ms!==null};
 }else if(row.target_input_id){
  const input=db.query('SELECT input.receipt_json,turn.status FROM session_inputs input LEFT JOIN turns turn ON turn.id=input.turn_id WHERE input.id=?')
    .get(row.target_input_id) as {receipt_json:string|null;status:string|null}|null;
  const detail=parse(input?.receipt_json).statusDetail;
  if((input?.status===null||input?.status==='queued')&&typeof detail?.message==='string'&&detail.message)return {text:detail.message,delayed:false};
 }
 if(row.stalled_at_ms!==null)return {text:'No answer has arrived; the original request needs recovery',delayed:true};
 if(row.overdue_at_ms!==null)return {text:'Answer delayed; the original request is still open',delayed:true};
 if(row.prompt_reminded_at_ms!==null)return {text:'Waiting for an answer; the agent has been reminded',delayed:false};
 return {text:'Waiting for an answer',delayed:false};
}
