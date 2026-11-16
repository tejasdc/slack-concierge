import type {Database} from 'bun:sqlite';
import {PROMPT_ANSWER_REMINDER_MS,PROMPT_ANSWER_OVERDUE_MS} from './prompt-answer-policy';

type Asked={kind?:string;topicId:string;questionId?:string;id?:string;owner?:any;sources?:string[];answer?:any};
const parse=(raw:string|null|undefined)=>{try{return JSON.parse(raw??'{}');}catch{return {};}};

/** A retained question names its dispatch. Older questions may use their exact obligation's
 * source link, but a shared thread or several attempts never chooses an answer for them. */
export function askedDispatch(db:Database,question:Asked):string|null {
 const found=askedDispatchCandidates(db,question);
 return found.length===1?found[0]!:null;
}

/** Every dispatch this question may belong to: its named one, or all exact obligation links.
 * Callers distinguish none (a direct answer may still reply to the source) from several
 * (the shared source must never pick one of them). */
function askedDispatchCandidates(db:Database,question:Asked):string[] {
 if(question.kind!=='asked')return [];
 const explicit=question.owner?.dispatchRequestId;
 if(typeof explicit==='string'&&explicit)return [explicit];
 const sources=question.sources??[];
 if(!sources.length)return [];
 const rows=db.query(`SELECT dispatches_json FROM inbox_requests WHERE topic_id=?
  AND EXISTS(SELECT 1 FROM json_each(inbox_requests.sources_json) source
   WHERE json_extract(source.value,'$.inputId') IN (SELECT value FROM json_each(?)))`).all(question.topicId,JSON.stringify(sources)) as {dispatches_json:string}[];
 const ids=new Set<string>();
 for(const row of rows)for(const dispatch of JSON.parse(row.dispatches_json))
  if(typeof dispatch.requestId==='string')ids.add(dispatch.requestId);
 return [...ids];
}

/** The route a message belongs to. An exact route event wins, then a `request:<id>` source's
 * own route, then a unique source match (several never choose), then the destination. */
export function routeForMessage(source:Database,messageId:unknown):{destinationMessageId?:string;sourceMessageId?:string}|null{
 if(typeof messageId!=='string'||!messageId.trim())return null;
 const id=messageId.trim();
 let row:{payload_json:string}|null=null;
 if(id.startsWith('topic-change:')||id.startsWith('session-route:')){
  row=source.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND kind IN ('topic_route','session_route')").get(id) as {payload_json:string}|null;
 }
 if(!row&&id.startsWith('request:')){
  row=source.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND kind='session_route'").get(`session-route:${id.slice('request:'.length)}`) as {payload_json:string}|null;
 }
 if(!row){
  const routes=source.query("SELECT payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 2")
   .all(id) as {payload_json:string}[];
  if(routes.length>1)return null;
  row=routes[0]??null;
 }
 if(!row){
  row=source.query("SELECT payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.destinationMessageId')=? ORDER BY sequence DESC LIMIT 1").get(id) as {payload_json:string}|null;
 }
 return row?JSON.parse(row.payload_json):null;
}

/** Legacy candidate classification for report diagnostics; never settlement evidence. */
export const ANSWERING_POST_SQL=`(coalesce(json_extract(payload_json,'$.postedBy'),'')<>'service' AND
 (json_extract(payload_json,'$.answersQuestion')=1
 OR (json_extract(payload_json,'$.replyKind')='final' AND json_extract(payload_json,'$.workDisposition')='completed')))`;

export function askedAnswerPostIds(db:Database,question:Asked,sessionIds:number[]):string[]{
 if(!sessionIds.length)return [];
 const questionId=question.questionId??question.id;
 if(!questionId)return [];
 const retained=db.query('SELECT answer_json FROM inbox_questions WHERE question_id=? AND topic_id=?').get(questionId,question.topicId) as {answer_json:string|null}|null;
 const evidence=parse(retained?.answer_json);
 if(typeof evidence.postId!=='string'||evidence.questionId!==questionId)return [];
 const post=db.query('SELECT session_id FROM session_owner_events WHERE event_id=?').get(evidence.postId) as {session_id:number}|null;
 if(!post||!sessionIds.includes(post.session_id))return [];
 try{askedAnswerEvidence(db,question,evidence.postId);return [evidence.postId];}catch{return [];}
}

function questionsForDispatch(db:Database,requestId:string):any[]{
 return (db.query(`SELECT question_id,topic_id,owner_json,sources_json,answer_json FROM inbox_questions q
  WHERE kind='asked' AND (json_extract(owner_json,'$.dispatchRequestId')=?
   OR (json_extract(owner_json,'$.dispatchRequestId') IS NULL AND EXISTS(
    SELECT 1 FROM inbox_requests r,json_each(r.dispatches_json) d
    WHERE r.topic_id=q.topic_id AND json_extract(d.value,'$.requestId')=?
     AND EXISTS(SELECT 1 FROM json_each(r.sources_json) s,json_each(q.sources_json) qs
      WHERE json_extract(s.value,'$.inputId')=qs.value))))`).all(requestId,requestId) as any[])
  .filter(row=>askedDispatch(db,{kind:'asked',topicId:row.topic_id,owner:parse(row.owner_json),sources:parse(row.sources_json)})===requestId);
}

/** Tracked questions, rather than a request-wide declaration, own answer settlement. */
export function hasTrackedAskedQuestions(db:Database,requestId:string):boolean {
 return questionsForDispatch(db,requestId).length>0;
}

/** Validate a retained post against the exact dispatch or source. No prose classification. */
export function askedAnswerEvidence(db:Database,question:Asked,postId:string){
 const row=db.query("SELECT payload_json FROM session_owner_events WHERE event_id=? AND kind='post'").get(postId) as {payload_json:string}|null;
 const post=parse(row?.payload_json),candidates=askedDispatchCandidates(db,question);
 const dispatch=candidates.length===1?candidates[0]!:null;
 const sources=question.sources??[];
 const allowedSources=new Set(candidates.length?sources.slice(1):sources);
 for(const source of [...allowedSources]){
  const route=routeForMessage(db,source);
  if(route)for(const id of [route.sourceMessageId,route.destinationMessageId])if(id)allowedSources.add(id);
 }
 if(!row||!['agent','owner-forward'].includes(post.postedBy)||typeof post.text!=='string'||!post.text.trim()
  ||!(dispatch&&post.requestId===dispatch||allowedSources.has(post.replyToMessage?.messageId)))
  throw new Error('The answer must name a retained agent post for this exact question dispatch or source.');
 return {questionId:question.questionId??question.id,postId,requestId:dispatch,respondingSessionId:post.postedBySession??null};
}

export function settleAskedAnswerClock(db:Database,question:Asked):void {
 const id=askedDispatch(db,question);if(!id)return;
 const others=questionsForDispatch(db,id).filter(row=>row.question_id!==(question.questionId??question.id));
 if(others.some(row=>parse(row.answer_json).questionId!==row.question_id||!parse(row.answer_json).postId))return;
 const row=request(db,id);if(!row)return;
 db.query(`UPDATE ${row.table} SET prompt_answered_at_ms=coalesce(prompt_answered_at_ms,?) WHERE request_id=?`).run(Date.now(),id);
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
 const questionId=question.questionId??question.id;if(!questionId)return false;
 const retained=db.query('SELECT answer_json FROM inbox_questions WHERE question_id=?').get(questionId) as {answer_json:string|null}|null;
 const evidence=parse(retained?.answer_json);
 if(evidence.questionId===questionId&&evidence.postId)return false;
 if(payload.promptAnswer){
  if(row.prompt_answered_at_ms!==null)db.query(`UPDATE ${row.table} SET prompt_answered_at_ms=NULL,due_at_ms=min(due_at_ms,?) WHERE request_id=?`).run(row.created_at_ms+PROMPT_ANSWER_REMINDER_MS,id);
  return false;
 }
 db.query(`UPDATE ${row.table} SET payload_json=json_set(payload_json,'$.promptAnswer',1,
  '$.promptAnswerQuestionId',?,'$.promptAnswerRequiredAtMs',?),
  prompt_answered_at_ms=NULL,due_at_ms=min(due_at_ms,?) WHERE request_id=? AND outcome IS NULL`)
  .run(questionId,Date.now(),row.created_at_ms+PROMPT_ANSWER_REMINDER_MS,id);
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
  :row.outcome==='canceled'?'The attempt was stopped; the question remains recorded':'The answer attempt ended; recovery is still owed',delayed:Date.now()-row.created_at_ms>=PROMPT_ANSWER_OVERDUE_MS};
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
