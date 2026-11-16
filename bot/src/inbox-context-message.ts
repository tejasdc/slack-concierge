import type {Database} from 'bun:sqlite';
import type {ProviderHistoryMessage} from './provider-history';
import type {AcceptedSessionInput} from './session-inputs';
import {routedMaterialSource} from './session-routed-material';
import {inboxAttribution} from './inbox-attribution-read';

/** The message event keeps identity and original authorship; the retained input supplies
 * current delivery custody and placement without turning the note into active work. */
export function inboxContextMessage(database:Database,sessionId:number,inputId:string,message:ProviderHistoryMessage) {
  const input=database.query('SELECT * FROM session_inputs WHERE id=? AND session_id=?')
    .get(inputId,sessionId) as AcceptedSessionInput|null;
  if(!input||message.id!==`context:${inputId}`||message.inputId!==inputId||message.responseMode!=='context')return null;
  const payload=JSON.parse(input.payload_json),saved=JSON.parse(input.receipt_json??'{}');
  if(payload.responseMode!=='context')return null;
  const material=routedMaterialSource(database,input);
  const original=material.record;
  const author=original?inboxAttribution(database)({id:original.id,sourceSessionId:original.session_id,role:'user',content:material.text}).author
    :material.author??{kind:'unknown' as const};
  const attachments=(payload.attachments??[]).flatMap((id:string)=>{
    const value=database.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id);
    return value?[value]:[];
  });
  return {...message,author,content:material.text,sourceSessionId:sessionId,submissionId:inputId,attachments,
    ...(payload.replyToMessage?{replyToMessage:payload.replyToMessage}:{}),
    ...(payload.messageThreadRootId?{messageThreadRootId:payload.messageThreadRootId}:{}),
    contextDelivery:{targetSessionId:saved.contextTarget??`concierge:${sessionId}`,
      state:saved.contextDelivery?.state??(saved.contextForward?'pending':'saved'),
      ...(saved.contextDelivery?.requestId?{requestId:saved.contextDelivery.requestId}:{}),
      ...(saved.contextDelivery?.peer?{peer:saved.contextDelivery.peer}:{}),
      ...(saved.contextDelivery?.error?{error:saved.contextDelivery.error}:{})}};
}
