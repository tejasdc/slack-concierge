import type {Database} from 'bun:sqlite';

/** Indexed, bounded read of work associated with a thread through its source task. */
export function readPrivateCoordinationRows(database:Database,topicId:string,cursor:string|null,limit:number){
  const [at,id]=cursor?.split('|')??[String(Number.MAX_SAFE_INTEGER),'~'];
  const position=Number(at);
  if(!Number.isSafeInteger(position)||position<=0||!id)throw new Error('INVALID_PRESENTATION_CURSOR');
  type Row={id:string;at:number;payload:string;sourceInputId:string|null;fromSession:number;
    toSession:number|null;peer:string|null;remoteSession:string|null;status:string;outcome:string|null};
  const rows=database.query(`SELECT id,at,payload,sourceInputId,fromSession,toSession,peer,remoteSession,status,outcome FROM (
    SELECT request.request_id AS id,request.created_at_ms AS at,request.payload_json AS payload,
      request.source_input_id AS sourceInputId,request.source_session_id AS fromSession,
      request.target_session_id AS toSession,NULL AS peer,NULL AS remoteSession,request.status,request.outcome
    FROM inbox_topic_roots roots JOIN session_communication_requests request
      ON request.topic_root_input_id=roots.root_input_id
    WHERE roots.topic_id=? AND request.thread_root_input_id IS NULL
      AND (request.created_at_ms,request.request_id)<(?,?)
    UNION ALL
    SELECT request.request_id AS id,request.created_at_ms AS at,request.payload_json AS payload,
      request.source_input_id AS sourceInputId,request.source_session_id AS fromSession,
      NULL AS toSession,request.peer,request.remote_session_id AS remoteSession,request.status,request.outcome
    FROM inbox_topic_roots roots JOIN session_peer_requests request
      ON request.topic_root_input_id=roots.root_input_id
    WHERE roots.topic_id=? AND request.thread_root_input_id IS NULL
      AND (request.created_at_ms,request.request_id)<(?,?)
  ) ORDER BY at DESC,id DESC LIMIT ?`)
    .all(topicId,position,id,topicId,position,id,limit+1) as Row[];
  return {rows:rows.slice(0,limit),nextCursor:rows.length>limit?`${rows[limit-1]!.at}|${rows[limit-1]!.id}`:null};
}
