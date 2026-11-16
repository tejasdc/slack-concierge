import {db,getSessionById,resumeParkedSessionTurn} from './state';
import {sessionMetadata,updateSessionMetadata} from './session-inputs';
import {inboxSession,inboxThreadRoot} from './session-inbox';
import type {OpenNeed} from './session-turn-outcome';


export function repairInboxNeeds(apply:boolean) {
const session=inboxSession();
if(!session)throw new Error('No Inbox session.');
const meta=sessionMetadata(session);
const needs=(meta.needs??[]) as OpenNeed[];
const at=(value:string)=>Date.parse(value.includes('T')?value:value.replace(' ','T')+'Z');
const sequenceOf=(eventId:string)=>(db.query('SELECT sequence FROM session_owner_events WHERE event_id=?').get(eventId) as {sequence:number}|null)?.sequence??0;

const humanReplies=(db.query(`SELECT id,payload_json,created_at FROM session_inputs
  WHERE session_id=? AND origin='human' AND json_extract(payload_json,'$.replyToMessage.messageId') IS NOT NULL`).all(session.id) as any[])
  .map(row=>({id:row.id,at:at(row.created_at),root:inboxThreadRoot(session.id,JSON.parse(row.payload_json).replyToMessage.messageId)}));
const declarations=(db.query(`SELECT sequence,input_id,json_extract(payload_json,'$.outcome') AS outcome FROM session_owner_events
  WHERE session_id=? AND kind='turn_outcome' AND input_id IS NOT NULL`).all(session.id) as any[])
  .filter(row=>row.outcome!=='finished_without_saying')
  .map(row=>({sequence:row.sequence,root:inboxThreadRoot(session.id,row.input_id)}));

const kept=new Map<string,OpenNeed>();
const dropped:{need:OpenNeed;root:string;why:string}[]=[];
for(const need of needs) {
  const root=inboxThreadRoot(session.id,need.inputId)??need.inputId;
  const asked=at(need.at),askedSequence=sequenceOf(need.eventId);
  const reply=humanReplies.find(reply=>reply.root===root&&reply.at>asked);
  const later=declarations.find(declaration=>declaration.root===root&&declaration.sequence>askedSequence);
  if(reply){dropped.push({need,root,why:`he replied in the thread (${reply.id})`});continue;}
  if(later){dropped.push({need,root,why:'a later turn declared for the thread'});continue;}
  const previous=kept.get(root);
  if(previous&&previous.generation>need.generation){dropped.push({need,root,why:'a newer open question in the same thread'});continue;}
  if(previous)dropped.push({need:previous,root,why:'a newer open question in the same thread'});
  kept.set(root,{...need,inputId:root});
}
const next=[...kept.values()].sort((first,second)=>first.generation-second.generation);
if(apply)db.transaction(()=>{
  const current=sessionMetadata(getSessionById(session.id)!);
  if(JSON.stringify(current.needs??[])!==JSON.stringify(needs))throw new Error('Open needs changed while repairing; run again.');
  updateSessionMetadata(session.id,{needs:next});
})();

return {before:needs.length,next,dropped,apply};
}

export function dispatchManualLedgerCommand(input:any):unknown {
 return db.transaction(()=>dispatch(input)).immediate();
}
function dispatch(input:any):unknown {
 switch(input?.operation) {
 case "resume-turn": if(!Number.isSafeInteger(input.turnId)||input.turnId<=0)throw new Error("Invalid turn identity."); return resumeParkedSessionTurn(input.turnId);
 case "clear-stale-account-notices": return {cleared:db.query(`UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.claudeAccountNotice',json('null')) WHERE json_extract(native_metadata_json,'$.claudeAccountNotice') IS NOT NULL`).run().changes};
 case "repair-inbox-needs": return repairInboxNeeds(input.apply===true);
 default: throw new Error("Unknown manual ledger command.");
 }
}
