import {db} from './state';
import type {ProviderHistoryMessage} from './provider-history';

function iso(value:unknown):string|undefined {
  if(typeof value!=='string'||!value)return undefined;
  const timestamp=/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)?value.replace(' ','T')+'Z':value;
  const parsed=Date.parse(timestamp);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():undefined;
}

function resultModel(turn:any):string|undefined {
  if(!turn?.outbound_text)return undefined;
  if(turn.turn_kind==='native') {
    try {
      const envelope=JSON.parse(turn.outbound_text);
      if(envelope.version===1&&envelope.result?.text===turn.agent_text&&typeof envelope.result.model==='string')return envelope.result.model;
    } catch { /* Older turns may not retain a native result envelope. */ }
    return undefined;
  }
  // This final footer is composed by the delivery owner from the provider result.
  const footer=/\n\n_model: ([^\n]+?) - cwd: [^\n]*_$/.exec(turn.outbound_text);
  return footer?.[1]&&footer[1]!=='unknown'?footer[1]:undefined;
}

const messageKey=(sessionId:number,message:ProviderHistoryMessage)=>JSON.stringify([sessionId,message.id,message.turnId??null,message.role]);
type MessageEntry={sessionId:number;message:ProviderHistoryMessage};
export type SessionMessageMetadataProjection=(sessionId:number,message:ProviderHistoryMessage)=>ProviderHistoryMessage;

/** One batch per history page or event flush; no mutable cache or cross-session fallback. */
export function sessionMessageMetadataProjection(entries:readonly MessageEntry[]):SessionMessageMetadataProjection {
  if(!entries.length)return (_sessionId,message)=>message;
  const requested=JSON.stringify([...new Map(entries.map(({sessionId,message})=>[messageKey(sessionId,message),
    {sessionId,id:message.id,turnId:message.turnId??null,role:message.role}])).values()]);
  const rows=db.query(`SELECT event.session_id,event.created_at,event.turn_id,event.payload_json
    FROM session_owner_events event JOIN json_each(?) requested
      ON event.session_id=json_extract(requested.value,'$.sessionId')
      AND json_extract(event.payload_json,'$.message.id')=json_extract(requested.value,'$.id')
      AND json_extract(event.payload_json,'$.message.turnId') IS json_extract(requested.value,'$.turnId')
      AND json_extract(event.payload_json,'$.message.role')=json_extract(requested.value,'$.role')
    WHERE event.kind='message' ORDER BY event.sequence`).all(requested) as any[];
  const eventsByMessage=new Map<string,any[]>();
  for(const row of rows){const message=JSON.parse(row.payload_json).message;const key=messageKey(row.session_id,message);const events=eventsByMessage.get(key)??[];events.push({...row,message});eventsByMessage.set(key,events);}
  const eventTurnIds=JSON.stringify([...new Set(rows.flatMap(row=>row.turn_id==null?[]:[row.turn_id]))]);
  const turns=db.query(`SELECT id,session_id,provider_turn_id,turn_kind,outbound_text,agent_text,provider_model,reasoning_effort,started_at,ended_at,provider_input_acknowledged_at,provider_duration_ms,status FROM turns
    WHERE id IN (SELECT value FROM json_each(?)) OR (session_id,provider_turn_id) IN
      (SELECT json_extract(value,'$.sessionId'),json_extract(value,'$.turnId') FROM json_each(?) WHERE json_extract(value,'$.turnId') IS NOT NULL)`)
    .all(eventTurnIds,requested) as any[];
  const turnsById=new Map(turns.map(turn=>[turn.id,turn]));
  const turnsByProvider=new Map<string,any[]>();
  for(const turn of turns){const key=JSON.stringify([turn.session_id,turn.provider_turn_id]);const found=turnsByProvider.get(key)??[];found.push(turn);turnsByProvider.set(key,found);}
  return (sessionId,message)=>{
    const events=eventsByMessage.get(messageKey(sessionId,message))??[];
    const turnIds=[...new Set(events.flatMap(event=>event.turn_id==null?[]:[event.turn_id]))];
    const candidates=turnIds.length===1?[turnsById.get(turnIds[0])].filter(turn=>turn?.session_id===sessionId)
      :turnIds.length===0&&message.turnId?turnsByProvider.get(JSON.stringify([sessionId,message.turnId]))??[]:[];
    const base=withMetadata(message,events,candidates);
    const reactions=(db.query('SELECT emoji FROM session_message_reactions WHERE session_id=? AND message_id=? ORDER BY emoji').all(sessionId,message.id) as {emoji:string}[]).map(row=>row.emoji);
    const saved=!!db.query('SELECT 1 FROM session_saved_messages WHERE session_id=? AND message_id=?').get(sessionId,message.id);
    return {...base,marks:{reactions,saved}};
  };
}

/** Display metadata joins only the exact retained message/turn, never current session settings. */
function withMetadata(message:ProviderHistoryMessage,events:any[],turns:any[]):ProviderHistoryMessage {
  const turn=turns.length===1?turns[0]:null;
  const retained=events.map(event=>event.message).find(value=>value.model&&value.content===message.content);
  const createdAt=iso(message.createdAt)??iso(events[0]?.created_at);
  const model=message.model??retained?.model??resultModel(turn);
  const effort=message.reasoningEffort??retained?.reasoningEffort??turn?.reasoning_effort;
  return {...message,
    ...(turn?{timing:{startedAt:iso(turn.started_at)??null,endedAt:iso(turn.ended_at)??null,workStartedAt:iso(turn.provider_input_acknowledged_at)??null,running:['running','delivering'].includes(turn.status),workMs:turn.provider_duration_ms??null}}:{}),
    ...(createdAt?{createdAt,timestampSource:message.createdAt?message.timestampSource??'provider':'received'}:{}),
    ...(message.role!=='user'?{
      ...(model?{model,modelSource:message.model?message.modelSource??'provider':retained?.model?retained.modelSource??'provider':'run'}:{}),
      ...(!model&&turn?.provider_model?{requestedModel:turn.provider_model}:{}),
      ...(effort?{reasoningEffort:effort,reasoningEffortSource:message.reasoningEffort?message.reasoningEffortSource??'provider':retained?.reasoningEffort?retained.reasoningEffortSource??'provider':'requested'}:{}),
    }:{}),
  };
}
