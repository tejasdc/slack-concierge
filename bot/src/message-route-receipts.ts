import type {Database} from 'bun:sqlite';
import {routeTitle} from './inbox-request-root';

export type MessageRouteReceipt={topicId?:string;sessionId?:string;messageId:string;title:string;delivery:'pending'|'delivered'|'failed';requestId?:string;summary?:string;kind:'thread'|'session'|'new_session'|'reply'};

/** The source message can have several independently addressed destination messages. */
export function messageRouteReceipts(database:Database,sourceMessageId:string):MessageRouteReceipt[]{
  const rows=database.query(`SELECT payload_json FROM session_owner_events
    WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=?
    ORDER BY sequence`).all(sourceMessageId) as {payload_json:string}[];
  return rows.map(row=>{
    const route=JSON.parse(row.payload_json);
    const peer=route.requestId?database.query('SELECT delivery_json,outcome FROM session_peer_requests WHERE request_id=?')
      .get(route.requestId) as {delivery_json:string|null;outcome:string|null}|null:null;
    const request=route.requestId?(database.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?')
      .get(route.requestId)??database.query('SELECT payload_json FROM session_peer_requests WHERE request_id=?').get(route.requestId)) as {payload_json:string}|null:null;
    const brief=request?JSON.parse(request.payload_json):null;
    const summary=brief?.summary;
    return {messageId:route.destinationMessageId,
      ...(route.topicId?{topicId:route.topicId}:{}),
      ...(route.destinationSessionId?{sessionId:route.destinationSessionId}:{}),
      title:routeTitle(database,route.topicId,route.destinationSessionId),
      kind:route.topicId?'thread':route.destinationSessionId?(brief?.provider?'new_session':'session'):'thread',
      ...(typeof route.requestId==='string'?{requestId:route.requestId}:{}),
      ...(typeof summary==='string'&&summary.trim()?{summary:summary.trim().slice(0,240)}:{}),
      delivery:peer?.delivery_json?(peer.outcome?'failed':'pending'):'delivered'} as MessageRouteReceipt;
  });
}

/** A direct thread reply has a durable carrier request but no router turn. It is displayed
 * once under Tejas's message, alongside any distinct topic or session routes. */
export function messageDeliveryReceipts(database:Database,sourceMessageId:string):MessageRouteReceipt[]{
  const routes=messageRouteReceipts(database,sourceMessageId);
  const input=database.query('SELECT receipt_json FROM session_inputs WHERE id=?').get(sourceMessageId) as {receipt_json:string|null}|null;
  const receipt=input?.receipt_json?JSON.parse(input.receipt_json):null;
  const forwardedTo=receipt?.forwardedTo;
  if(typeof forwardedTo?.sessionId!=='string')return routes;
  const local=database.query(`SELECT request_id,target_input_id FROM session_communication_requests
    WHERE source_input_id=? AND action_id=? LIMIT 1`).get(sourceMessageId,`forward:${sourceMessageId}`) as
    {request_id:string;target_input_id:string|null}|null;
  const peer=local?null:database.query(`SELECT request_id,remote_operation_id AS target_input_id,delivery_json,outcome FROM session_peer_requests
    WHERE source_input_id=? AND action_id=? LIMIT 1`).get(sourceMessageId,`forward:${sourceMessageId}`) as
    {request_id:string;target_input_id:string|null;delivery_json:string|null;outcome:string|null}|null;
  const request=local??peer;
  if(!request)return routes;
  return [...routes,{kind:'reply',requestId:request.request_id,sessionId:forwardedTo.sessionId,
    messageId:request.target_input_id??`request:${request.request_id}`,
    title:typeof forwardedTo.title==='string'&&forwardedTo.title?forwardedTo.title:routeTitle(database,null,forwardedTo.sessionId),
    delivery:peer?.delivery_json?(peer.outcome?'failed':'pending'):'delivered'}];
}
