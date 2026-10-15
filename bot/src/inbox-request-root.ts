import type {Database} from 'bun:sqlite';

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

/** Thread custody discharges delivery; waking the asker is a separate, explicit effect. */
export function returnsToRequester(request:{thread_root_input_id:string|null;payload_json:string}):boolean {
  const payload=JSON.parse(request.payload_json);
  return payload.returnToRequester===true||(!request.thread_root_input_id&&!payload.forwardedReply);
}

/** The queue and live dispatcher refuse old copies before reconciliation withdraws them. */
export function threadOnlyReturnInputSql(input:string):string {
  return `${input}.origin='service' AND (${input}.id LIKE 'return:%' OR ${input}.id LIKE 'question-overdue:%') AND (${[
    'session_communication_requests','session_peer_requests',
  ].map(table=>`EXISTS (SELECT 1 FROM ${table} request WHERE request.request_id=${input}.request_id
    AND request.source_session_id=${input}.session_id
    AND (request.thread_root_input_id IS NOT NULL OR json_extract(request.payload_json,'$.forwardedReply') IS NOT NULL
      OR json_extract(request.payload_json,'$.routedMessage') IS NOT NULL)
    AND coalesce(json_extract(request.payload_json,'$.returnToRequester'),0)<>1)`).join(' OR ')})`;
}

/** The request's own placed root owns its answer, even if the sender named another thread. */
export function inboxRequestRoot(database:Database,requestId:string,originalRoot:string|null):string|null {
  const request=(database.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(requestId)
    ??database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=?').get(requestId)) as {payload_json:string}|null;
  const forwarded=request?JSON.parse(request.payload_json)?.forwardedReply?.inboxInputId:null;
  if(typeof forwarded==='string'){
    const route=database.query("SELECT kind,payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 1")
      .get(forwarded) as {kind:string;payload_json:string}|null;
    if(route?.kind==='topic_route')return JSON.parse(route.payload_json).destinationMessageId;
  }
  const ownRoot=`request:${requestId}`;
  if(database.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(ownRoot))return ownRoot;
  return originalRoot;
}
