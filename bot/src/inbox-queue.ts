import type {Database} from 'bun:sqlite';

export type WaitingInboxInput={inputId:string;captureId:string|null;text:string;createdAt:string;position:number;origin:'human'|'agent'};
type Row={turn_id:number;queue_priority:number;input_id:string;capture_id:string|null;text:string;created_at:string;origin:'human'|'agent'};

function position(cursor:string|null):{priority:number;id:number;position:number}|null {
  if(!cursor)return null;
  try {
    const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
    if(Array.isArray(value)&&value.length===3&&value.every(item=>Number.isSafeInteger(item)&&item>=0))
      return {priority:value[0],id:value[1],position:value[2]};
  } catch {}
  throw new Error('Invalid Inbox queue position.');
}

/** Exact retained human inputs and attributed outside captures still waiting for provider admission. */
export function inboxQueuePage(source:Database,sessionId:number,cursor:string|null=null,limit=50) {
  const after=position(cursor),size=Math.max(1,Math.min(50,Math.trunc(limit)));
  const rows=source.query(`SELECT turn.id AS turn_id,turn.queue_priority,input.id AS input_id,
      json_extract(input.payload_json,'$.capture.id') AS capture_id,
      substr(json_extract(input.payload_json,'$.text'),1,180) AS text,input.created_at,input.origin
    FROM turns turn JOIN session_inputs input ON input.id=turn.accepted_input_id
    WHERE turn.session_id=? AND turn.status='queued' AND turn.turn_kind='native'
      AND turn.saved_kind IS NULL AND turn.owner_instance_id IS NULL
      AND turn.provider_admission_intended_at IS NULL AND turn.provider_started_at IS NULL
      AND turn.provider_turn_id IS NULL AND turn.provider_input_acknowledged_at IS NULL
      AND input.kind='input' AND (input.origin='human' OR (input.origin='agent'
        AND json_extract(input.payload_json,'$.capture.source.kind')='outside-agent'))
      AND input.steering_id IS NULL AND input.receipt_json IS NULL
      AND (? IS NULL OR turn.queue_priority<? OR (turn.queue_priority=? AND turn.id>?))
    ORDER BY turn.queue_priority DESC,turn.id LIMIT ?`).all(sessionId,after?.priority??null,
      after?.priority??0,after?.priority??0,after?.id??0,size+1) as Row[];
  const page=rows.slice(0,size),offset=after?.position??0;
  const items:WaitingInboxInput[]=page.map((row,index)=>({inputId:row.input_id,captureId:row.capture_id,
    text:row.text??'',createdAt:row.created_at,position:offset+index+1,origin:row.origin}));
  const last=page.at(-1);
  const nextCursor=rows.length>size&&last
    ?Buffer.from(JSON.stringify([last.queue_priority,last.turn_id,offset+page.length])).toString('base64url'):null;
  const active=source.query(`SELECT turn.native_run_id AS run_id,turn.accepted_input_id AS input_id
    FROM turns turn WHERE turn.session_id=? AND turn.status='running' AND turn.stop_requested_at IS NULL
      AND turn.provider_input_acknowledged_at IS NOT NULL
    ORDER BY turn.id DESC LIMIT 1`).get(sessionId) as {run_id:string;input_id:string|null}|null;
  return {items,nextCursor,active:active?{runId:active.run_id,inputId:active.input_id}:null};
}
