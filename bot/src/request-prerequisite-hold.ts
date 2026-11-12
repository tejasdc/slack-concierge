import {db} from './state';
import {HOLDING_OUTCOMES} from './session-inputs';
import {inboxRequestRoot} from './inbox-request-root';

type PrerequisiteRow={request_id:string;source_session_id:number;source_input_id:string|null;outcome:string|null;result_json:string|null;thread_root_input_id:string|null;payload_json:string};

const requestRow=(id:string)=>db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(id) as PrerequisiteRow|null;

/**
 * The prerequisite holding this request for its requester's decision, if any. An
 * outcome without confirmed success waits for that decision, but a request the
 * requester asked after the outcome had reached it is the decision: holding it would
 * wait for a choice already made, with nothing left that could release it.
 *
 * Request delivery and the obligations inventory share this one reading, so a request
 * the worker cannot answer is never listed as work the worker can do (request
 * 5d979d7f sat 52 days in a worker's obligations while only its requester could act).
 */
export function heldPrerequisite(request:{request_id:string;source_input_id:string|null;payload_json:string},
  dependencies=((JSON.parse(request.payload_json).after??[]) as string[]).map(id=>requestRow(id)).filter((row):row is PrerequisiteRow=>!!row)):PrerequisiteRow|null {
  const ask=db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(`request:${request.request_id}`) as {sequence:number}|null;
  return dependencies.find(dependency=>{
    if(!HOLDING_OUTCOMES.includes(dependency.outcome??''))return false;
    const resultEventId=JSON.parse(dependency.result_json??'{}').event_id;
    const directPost=resultEventId?db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(`post:forward:${resultEventId}`) as {sequence:number}|null:null;
    const declared=resultEventId?db.query('SELECT payload_json FROM session_communication_events WHERE event_id=?').get(resultEventId) as {payload_json:string}|null:null;
    const group=declared?JSON.parse(declared.payload_json).answerGroup:null;
    const root=inboxRequestRoot(db,dependency.request_id,dependency.thread_root_input_id);
    const groupedPost=!directPost&&typeof group==='string'&&root
      ?db.query(`SELECT sequence FROM session_owner_events WHERE session_id=? AND coalesce(json_extract(payload_json,'$.threadRoot'),input_id)=? AND kind='post'
        AND json_extract(payload_json,'$.answerGroup')=? ORDER BY sequence LIMIT 1`)
        .get(dependency.source_session_id,root,group) as {sequence:number}|null:null;
    const answerPost=!directPost&&!groupedPost&&root
      ?db.query(`SELECT sequence FROM session_owner_events WHERE session_id=? AND coalesce(json_extract(payload_json,'$.threadRoot'),input_id)=? AND kind='post'
        AND json_extract(payload_json,'$.requestId')=? ORDER BY sequence DESC LIMIT 1`)
        .get(dependency.source_session_id,root,dependency.request_id) as {sequence:number}|null:null;
    const postSequence=(directPost??groupedPost??answerPost)?.sequence;
    if(ask&&postSequence!==undefined&&postSequence<=ask.sequence)return false;
    return !db.query(`SELECT 1 FROM session_inputs outcome JOIN session_inputs ask ON ask.id=?
      WHERE outcome.id=? AND outcome.session_id=ask.session_id AND outcome.rowid<=ask.rowid`)
      .get(request.source_input_id,`return:${resultEventId}`);
  })??null;
}

/**
 * Why a request has not reached its recipient yet, in words for whichever side reads it.
 * Null once its accepted input belongs to a turn: from then on the recipient can reply.
 */
export function undeliveredRequestState(request:{request_id:string;source_session_id:number;source_input_id:string|null;target_input_id:string|null;payload_json:string}):
  {delivered:false;canReply:false;waitingOn:string;nextMove:string;heldBy?:{request:string;outcome:string}}|null {
  if(!request.target_input_id)return null;
  const input=db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(request.target_input_id) as {turn_id:number|null}|null;
  if(!input||input.turn_id!==null)return null;
  const requester=`concierge:${request.source_session_id}`;
  const held=heldPrerequisite(request);
  if(held)return {delivered:false,canReply:false,waitingOn:requester,heldBy:{request:held.request_id,outcome:held.outcome!},
    nextMove:`Held for ${requester}'s decision: earlier request ${held.request_id} ended ${held.outcome} without a confirmed result. Only the requester can release it, by cancelling this request or asking again without that prerequisite. The recipient cannot reply to it.`};
  const payload=JSON.parse(request.payload_json) as {after?:string[];pace?:string[]};
  if((payload.after?.length??0)+(payload.pace?.length??0)>0)
    return {delivered:false,canReply:false,waitingOn:'earlier requests',
      nextMove:'Not delivered yet: it waits behind earlier requests from the same requester and arrives on its own when they settle. The recipient cannot reply to it until then.'};
  return {delivered:false,canReply:false,waitingOn:'admission',
    nextMove:'Not delivered yet: the recipient session has not started a run for it (paused, busy or waiting for admission). It arrives on its own; the recipient cannot reply to it until then.'};
}
