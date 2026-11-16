import {db,getSessionById,type SessionRow} from './state';
import {getAcceptedSessionInput,sessionInputProvenance,sessionMetadata} from './session-inputs';
import {containsHumanChoice} from './model-escalation-custody';

export const INBOX_PIN_REFUSAL='The Inbox stays in its current Claude Code conversation. Only Tejas’s explicit instruction to move the Inbox can replace it; account exhaustion waits or changes Claude accounts in the same conversation.';

export function holdsInbox(session:SessionRow):boolean {
  const meta=sessionMetadata(session);
  return meta.standingRole==='inbox';
}

/** Authority comes from retained human words, never the agent's reason or a provider choice. */
export function humanAuthorizedInboxMove(inputId:string|undefined,target:{id?:number;provider?:string}):boolean {
  const source=inputId?getAcceptedSessionInput(inputId):null;
  if(!source)return false;
  const humanId=source.origin==='human'?source.id:sessionInputProvenance(source)?.originatingHuman?.inputId;
  const human=humanId?getAcceptedSessionInput(humanId):null;
  if(!human||human.origin!=='human')return false;
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=? LIMIT 1').get(`inbox-pin-override:${human.id}`))return false;
  const words=JSON.parse(human.payload_json).text;
  if(typeof words!=='string')return false;
  // Require both the Inbox and the exact destination in a directive. "Use Codex for this
  // repair", "unless I ask", and quoted agent text do not authorize a router transfer.
  const destinations=[...(target.id?[`(?:concierge:|session\\s+)${target.id}\\b`]:[]),
    ...(target.provider==='claude-code'?['Claude(?: Code)?\\b']:target.provider==='codex'?['Codex\\b']:[])];
  if(!destinations.length)return false;
  const directive=new RegExp(`^\\s*(?:please\\s+)?(?:move|switch|transfer|rebind|bind|pin|handoff|hand over)\\s+(?:my\\s+|the\\s+)?Inbox(?:\\s+router)?\\s+(?:over\\s+)?to\\s+(?:the\\s+)?(?:${destinations.join('|')})`,'i');
  return (words.match(/(?:\d\.\d|[^.!?;])+[.!?;]?/g)??[]).some(statement=>{
    // A direct polite request is still his instruction; an inquiry about how to move is not.
    const greeting=statement.replace(/^\s*hey[,\s]+/i,'');
    const polite=/^\s*(?:can|could|would|will)\s+you\s+/i;
    const direct=polite.test(greeting)?greeting.replace(polite,'').replace(/\?\s*$/,'.'):greeting;
    return containsHumanChoice(direct,directive);
  });
}

export function inboxMoveHumanInput(inputId:string):string|null {
  const source=getAcceptedSessionInput(inputId);
  return source?(source.origin==='human'?source.id:sessionInputProvenance(source)?.originatingHuman?.inputId??null):null;
}

/** Called before proposal and again inside the final transfer transaction. */
export function assertInboxMove(source:SessionRow,target:{id?:number;provider?:string},inputId?:string):void {
  if(holdsInbox(source)&&source.id!==target.id&&!humanAuthorizedInboxMove(inputId,target))throw new Error(INBOX_PIN_REFUSAL);
}

export function currentInboxHolder():SessionRow|null {
  return db.query(`SELECT * FROM sessions WHERE json_extract(native_metadata_json,'$.standingRole')='inbox'
    ORDER BY id DESC LIMIT 1`).get() as SessionRow|null;
}
