import type {Database} from 'bun:sqlite';

export type PublicRequestRow={request_id:string;summary:string|null;preview:string|null;source_input_id:string|null;
  source_session_id:number;status:string;outcome:string|null};

/** One page's local and peer requests, bounded by the page's exact identities. */
export function readPublicRequestRows(database:Database,requestIds:string[]){
  const local=new Map<string,PublicRequestRow>(),peer=new Map<string,PublicRequestRow>();
  if(!requestIds.length)return {local,peer};
  const placeholders=requestIds.map(()=>'?').join(',');
  const localRows=database.query(`SELECT request_id,
    substr(json_extract(payload_json,'$.summary'),1,200) AS summary,
    CASE WHEN length(CAST(json_extract(payload_json,'$.text') AS BLOB))<=8192
      THEN json_extract(payload_json,'$.text') END AS preview,
    source_input_id,source_session_id,status,outcome
    FROM session_communication_requests WHERE request_id IN (${placeholders}) LIMIT ?`)
    .all(...requestIds,requestIds.length) as PublicRequestRow[];
  const peerRows=database.query(`SELECT request_id,
    substr(json_extract(payload_json,'$.summary'),1,200) AS summary,
    CASE WHEN length(CAST(json_extract(payload_json,'$.text') AS BLOB))<=8192
      THEN json_extract(payload_json,'$.text') END AS preview,
    source_input_id,source_session_id,status,outcome
    FROM session_peer_requests WHERE request_id IN (${placeholders}) LIMIT ?`)
    .all(...requestIds,requestIds.length) as PublicRequestRow[];
  for(const row of localRows)local.set(row.request_id,row);
  for(const row of peerRows)peer.set(row.request_id,row);
  return {local,peer};
}

/** Canceled request sources are read together, with the same page bound. */
export function readCanceledSourceOrigins(database:Database,sourceIds:string[]){
  const origins=new Map<string,string>();
  if(!sourceIds.length)return origins;
  const placeholders=sourceIds.map(()=>'?').join(',');
  const rows=database.query(`SELECT id,origin FROM session_inputs WHERE id IN (${placeholders}) LIMIT ?`)
    .all(...sourceIds,sourceIds.length) as {id:string;origin:string}[];
  for(const row of rows)origins.set(row.id,row.origin);
  return origins;
}

type ActivityRow={event_id:string;kind:string;summary:string|null;text:string|null;stopped_by:string|null;created_at_ms:number};
/** The work pane never loads a full reply body; its exact receipt is the detail entrance. */
export function readCoordinationActivity(database:Database,requestId:string,table:'session_communication_events'|'session_peer_events'){
  return (database.query(`SELECT event_id,kind,substr(json_extract(payload_json,'$.summary'),1,200) AS summary,
    CASE WHEN length(CAST(json_extract(payload_json,'$.text') AS BLOB))<=1024
      THEN json_extract(payload_json,'$.text') END AS text,
    json_extract(payload_json,'$.output.stoppedBy') AS stopped_by,created_at_ms FROM ${table}
    WHERE request_id=? ORDER BY rowid DESC LIMIT 3`).all(requestId) as ActivityRow[])
    .reverse().map(row=>({id:row.event_id,at:new Date(row.created_at_ms).toISOString(),
      kind:row.kind,summary:row.summary,text:row.text,stoppedBy:row.stopped_by==='tejas'?'tejas':null}));
}

/** Indexed, bounded read of work associated with a thread through its source task. */
export function readPrivateCoordinationRows(database:Database,topicId:string,cursor:string|null,limit:number){
  const [at,id]=cursor?.split('|')??[String(Number.MAX_SAFE_INTEGER),'~'];
  const position=Number(at);
  if(!Number.isSafeInteger(position)||position<=0||!id)throw new Error('INVALID_PRESENTATION_CURSOR');
  type Row={id:string;at:number;summary:string|null;preview:string|null;sourceInputId:string|null;fromSession:number;
    toSession:number|null;peer:string|null;remoteSession:string|null;status:string;outcome:string|null};
  const rows=database.query(`SELECT id,at,summary,preview,sourceInputId,fromSession,toSession,peer,remoteSession,status,outcome FROM (
    SELECT request.request_id AS id,request.created_at_ms AS at,
      substr(json_extract(request.payload_json,'$.summary'),1,200) AS summary,
      CASE WHEN length(CAST(json_extract(request.payload_json,'$.text') AS BLOB))<=8192
        THEN json_extract(request.payload_json,'$.text') END AS preview,
      request.source_input_id AS sourceInputId,request.source_session_id AS fromSession,
      request.target_session_id AS toSession,NULL AS peer,NULL AS remoteSession,request.status,request.outcome
    FROM inbox_topic_roots roots JOIN session_communication_requests request
      ON request.topic_root_input_id=roots.root_input_id
    WHERE roots.topic_id=? AND request.thread_root_input_id IS NULL
      AND (request.created_at_ms,request.request_id)<(?,?)
    UNION ALL
    SELECT request.request_id AS id,request.created_at_ms AS at,
      substr(json_extract(request.payload_json,'$.summary'),1,200) AS summary,
      CASE WHEN length(CAST(json_extract(request.payload_json,'$.text') AS BLOB))<=8192
        THEN json_extract(request.payload_json,'$.text') END AS preview,
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
