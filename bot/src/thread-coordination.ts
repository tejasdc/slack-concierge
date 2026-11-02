import {db} from './state';
import {authorSessionOf} from './session-presence';
import {preparedInboxDisplays,preparedThreadCoordinationKeys} from './presentation-message-reader';
import {readPrivateCoordinationRows} from './thread-coordination-read';

type RequestRow={payload_json:string;source_input_id:string|null;status:string;outcome:string|null};
type ActivityRow={event_id:string;kind:string;payload_json:string;created_at_ms:number};
const stamp=(value:string)=>/(?:Z|[+-]\d\d:?\d\d)$/i.test(value)?value:value+'Z';
const activity=(requestId:string,table:'session_communication_events'|'session_peer_events')=>
  (db.query(`SELECT event_id,kind,payload_json,created_at_ms FROM ${table}
    WHERE request_id=? ORDER BY rowid DESC LIMIT 3`).all(requestId) as ActivityRow[])
    .reverse().map(row=>{const value=JSON.parse(row.payload_json);return {id:row.event_id,at:new Date(row.created_at_ms).toISOString(),
      kind:row.kind,summary:typeof value.summary==='string'?value.summary:null,
      text:typeof value.text==='string'&&Buffer.byteLength(value.text)<=1024?value.text:null};});

function privateCoordination(topicId:string,cursor:string|null,limit:number){
  const {rows:page,nextCursor}=readPrivateCoordinationRows(db,topicId,cursor,limit);
  return {items:page.map(row=>{const body=JSON.parse(row.payload),fromId=`concierge:${row.fromSession}`,
    toId=row.peer?`${row.peer}:${row.remoteSession?.replace(/^.*:/,'')}`:`concierge:${row.toSession}`;
    const from=authorSessionOf(db,fromId),to=authorSessionOf(db,toId);
    const fullText=typeof body.text==='string'?body.text:'';
    return {id:`request:${row.id}`,at:new Date(row.at).toISOString(),kind:'coordination' as const,
      actor:{name:from?.title??from?.agentName??'Agent',sessionId:fromId},
      recipient:{name:to?.title??to?.agentName??'Agent',sessionId:toId},
      summary:typeof body.summary==='string'&&body.summary.trim()?body.summary:'Agent coordination',
      requestId:row.id,sourceInputId:row.sourceInputId,state:row.outcome??row.status,
      activity:activity(row.id,row.peer?'session_peer_events':'session_communication_events'),
      fullText:Buffer.byteLength(fullText)<=8192?fullText:null,detailRef:{requestId:row.id}};
  }),nextCursor,
    coverage:{complete:true}};
}

/** A bounded work lane. The exact request receipt remains the detail entrance. */
export function threadCoordination(topicId:string,cursor:string|null,limit:number,mode:'visible'|'private'='visible'){
  if(mode==='private')return privateCoordination(topicId,cursor,limit);
  const head=(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM session_owner_events').get() as {n:number}).n;
  const page=preparedThreadCoordinationKeys(topicId,limit,cursor,head);
  const displays=preparedInboxDisplays(page.keys);
  if(displays.some(value=>value===null))return {items:[],nextCursor:null,coverage:{complete:false,code:'presentation_indexing',
    retryAfterMs:1000,appliedSequence:page.coverage.appliedSequence}};
  const items=page.keys.map((key,index)=>{
    const display=displays[index] as Record<string,any>;
    if(key.messageId.startsWith('post:earlier-work:'))return {
      id:key.messageId,at:display.createdAt,kind:'suggestion' as const,
      actor:{name:'Concierge',sessionId:null},summary:'Earlier work related to this message',
      sourceInputId:display.inputId??null,requestId:null,
      fullText:display.content,detailRef:display.detailRef??null,
    };
    const requestId=key.messageId.slice('request:'.length);
    const event=db.query('SELECT payload_json,created_at FROM session_owner_events WHERE event_id=?')
      .get(key.messageId) as {payload_json:string;created_at:string}|null;
    const eventBody=event?JSON.parse(event.payload_json):{};
    const localRequest=db.query('SELECT payload_json,source_input_id,status,outcome FROM session_communication_requests WHERE request_id=?')
      .get(requestId) as RequestRow|null;
    const request=localRequest??db.query('SELECT payload_json,source_input_id,status,outcome FROM session_peer_requests WHERE request_id=?')
      .get(requestId) as RequestRow|null;
    const body=request?JSON.parse(request.payload_json):{};
    const recipient=typeof eventBody.targetSessionId==='string'?authorSessionOf(db,eventBody.targetSessionId):null;
    const name=recipient?.title??recipient?.agentName??'Agent';
    const fullText=typeof body.text==='string'?body.text:'';
    return {id:key.messageId,at:display.createdAt??(event?stamp(event.created_at):null),kind:'handoff' as const,
      actor:{name,sessionId:eventBody.targetSessionId??null},
      summary:typeof body.summary==='string'&&body.summary.trim()?body.summary:display.content,
      requestId,sourceInputId:request?.source_input_id??null,
      state:request?.outcome??request?.status??'unknown',
      activity:activity(requestId,localRequest?'session_communication_events':'session_peer_events'),
      fullText:Buffer.byteLength(fullText)<=8192?fullText:null,
      detailRef:{requestId},
    };
  });
  return {items,nextCursor:page.nextCursor,coverage:page.coverage};
}
