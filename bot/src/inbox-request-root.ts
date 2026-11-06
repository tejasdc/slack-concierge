import type {Database} from 'bun:sqlite';

/** A routed topic root is an event address; its retained action input owns FK custody. */
export function topicRouteAnchor(database:Database,sessionId:number,root:string):string|null {
  const row=database.query("SELECT input_id FROM session_owner_events WHERE session_id=? AND event_id=? AND kind='topic_route'")
    .get(sessionId,root) as {input_id:string|null}|null;
  return row?.input_id??null;
}

export function routeTitle(database:Database,topicId:string|null|undefined,sessionId:string|null|undefined):string {
  if(topicId)return (database.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(topicId) as {title:string}|null)?.title??topicId;
  if(!sessionId)return 'session';
  const peer=sessionId.match(/^([^/]+)\/(concierge:\d+)$/);
  if(peer){
    const catalogue=database.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(peer[1]!,peer[2]!) as {view_json:string}|null;
    return catalogue?JSON.parse(catalogue.view_json)?.title??sessionId:sessionId;
  }
  const id=sessionId.match(/^concierge:(\d+)$/)?.[1];
  if(!id)return sessionId;
  const local=database.query("SELECT json_extract(native_metadata_json,'$.title') AS title FROM sessions WHERE id=?").get(Number(id)) as {title:string|null}|null;
  return local?.title??sessionId;
}

/** The input that caused a request, distinct from the older message named for its answer. */
export function requestPromptInputId(database:Database,requestId:string,sourceSessionId:number):string|null {
  const row=(database.query('SELECT source_input_id AS id FROM session_communication_requests WHERE request_id=? AND source_session_id=?')
    .get(requestId,sourceSessionId)
    ??database.query('SELECT source_input_id AS id FROM session_peer_requests WHERE request_id=? AND source_session_id=?')
      .get(requestId,sourceSessionId)) as {id:string|null}|null;
  return row?.id??null;
}

/** Thread custody discharges ordinary success; unresolved or failed work returns to its asker. */
export function returnsToRequester(request:{thread_root_input_id:string|null;payload_json:string},event?:{kind:string;payload_json:string}):boolean {
  const payload=JSON.parse(request.payload_json);
  const result=event?JSON.parse(event.payload_json):null;
  const handBack=event?.kind==='final'?result.handBack:null;
  const stoppedByTejas=result?.output?.stoppedBy==='tejas';
  const unresolved=event?.kind==='overdue'||event?.kind==='final'&&!stoppedByTejas&&(
    result.workDisposition==='failed'||result.workDisposition==='needs_decision'
    ||payload.requestedEffect==='work'&&result.workDisposition===undefined
    ||result.stalled===true
    ||typeof result.outcome==='string'&&result.outcome!=='answered');
  return payload.returnToRequester===true||handBack==='not-my-subject'||handBack==='too-loaded'
    ||unresolved||(!request.thread_root_input_id&&!payload.forwardedReply);
}

/** The queue and live dispatcher refuse old copies before reconciliation withdraws them. */
export function threadOnlyReturnInputSql(input:string):string {
  return `${input}.origin='service' AND (${input}.id LIKE 'return:%' OR ${input}.id LIKE 'question-overdue:%') AND (${[
    'session_communication_requests','session_peer_requests',
  ].map(table=>`EXISTS (SELECT 1 FROM ${table} request WHERE request.request_id=${input}.request_id
    AND request.source_session_id=${input}.session_id
    AND (request.thread_root_input_id IS NOT NULL OR json_extract(request.payload_json,'$.forwardedReply') IS NOT NULL
      OR json_extract(request.payload_json,'$.routedMessage') IS NOT NULL)
    AND coalesce(json_extract(request.payload_json,'$.returnToRequester'),0)<>1
    AND NOT EXISTS (SELECT 1 FROM ${table.replace('requests','events')} event
      WHERE ${input}.id='return:'||event.event_id AND event.request_id=request.request_id AND (
        event.kind='overdue' OR event.kind='final'
          AND coalesce(json_extract(event.payload_json,'$.output.stoppedBy'),'')<>'tejas'
          AND (json_extract(event.payload_json,'$.handBack') IN ('not-my-subject','too-loaded')
            OR json_extract(event.payload_json,'$.workDisposition') IN ('failed','needs_decision')
            OR json_extract(request.payload_json,'$.requestedEffect')='work'
              AND json_extract(event.payload_json,'$.workDisposition') IS NULL
            OR coalesce(json_extract(event.payload_json,'$.stalled'),0)=1
            OR json_type(event.payload_json,'$.outcome')='text'
              AND json_extract(event.payload_json,'$.outcome')<>'answered'))))`).join(' OR ')})`;
}

/** The request's own placed root owns its answer, even if the sender named another thread. */
export function inboxRequestRoot(database:Database,requestId:string,originalRoot:string|null):string|null {
  const request=(database.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(requestId)
    ??database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=?').get(requestId)) as {payload_json:string}|null;
  const forwarded=request?JSON.parse(request.payload_json)?.forwardedReply?.inboxInputId:null;
  if(typeof forwarded==='string'){
    const routes=database.query("SELECT kind,payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 2")
      .all(forwarded) as {kind:string;payload_json:string}[];
    if(routes.length===1&&routes[0]?.kind==='topic_route')return JSON.parse(routes[0].payload_json).destinationMessageId;
  }
  const ownRoot=`request:${requestId}`;
  if(database.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(ownRoot))return ownRoot;
  return originalRoot;
}
