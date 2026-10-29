import type {Database} from 'bun:sqlite';
import {routeTitle} from './inbox-request-root';

export type MessageRouteReceipt={topicId?:string;sessionId?:string;messageId:string;title:string;delivery:'pending'|'delivered'|'failed'};

/** The source message can have several independently addressed destination messages. */
export function messageRouteReceipts(database:Database,sourceMessageId:string):MessageRouteReceipt[]{
  const rows=database.query(`SELECT payload_json FROM session_owner_events
    WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=?
    ORDER BY sequence`).all(sourceMessageId) as {payload_json:string}[];
  return rows.map(row=>{
    const route=JSON.parse(row.payload_json);
    const peer=route.requestId?database.query('SELECT delivery_json,outcome FROM session_peer_requests WHERE request_id=?')
      .get(route.requestId) as {delivery_json:string|null;outcome:string|null}|null:null;
    return {messageId:route.destinationMessageId,
      ...(route.topicId?{topicId:route.topicId}:{}),
      ...(route.destinationSessionId?{sessionId:route.destinationSessionId}:{}),
      title:routeTitle(database,route.topicId,route.destinationSessionId),
      delivery:peer?.delivery_json?(peer.outcome?'failed':'pending'):'delivered'} as MessageRouteReceipt;
  });
}
