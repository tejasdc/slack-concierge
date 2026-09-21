#!/usr/bin/env bun
/**
 * One-time repair (2026-09-21) of the Inbox's open questions filed under a returned answer
 * instead of the thread that answer belongs to. Re-keys each open need to its thread root
 * with inboxThreadRoot, then drops a need when, after it was asked, Tejas replied in that
 * thread or a later turn declared an outcome for that thread. Keeps the latest open need
 * per thread, as a declaration does. dismissedGeneration is never touched.
 *
 *   bun bot/scripts/repair-inbox-needs.ts          # dry run: prints what would change
 *   bun bot/scripts/repair-inbox-needs.ts --apply  # applies it
 */
import {db,getSessionById} from '../src/state';
import {sessionMetadata,updateSessionMetadata} from '../src/session-inputs';
import {inboxSession,inboxThreadRoot} from '../src/session-inbox';
import type {OpenNeed} from '../src/session-turn-outcome';

const apply=process.argv.includes('--apply');
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
for(const entry of dropped)console.log(`DROP gen ${entry.need.generation} [${entry.root}] ${entry.why}: ${entry.need.question.slice(0,90)}`);
for(const need of next)console.log(`KEEP gen ${need.generation} [${need.inputId}]: ${need.question.slice(0,90)}`);
console.log(`${needs.length} open before, ${next.length} after, ${dropped.length} dropped${apply?'':' (dry run)'}`);
if(apply)db.transaction(()=>{
  const current=sessionMetadata(getSessionById(session.id)!);
  if(JSON.stringify(current.needs??[])!==JSON.stringify(needs))throw new Error('Open needs changed while repairing; run again.');
  updateSessionMetadata(session.id,{needs:next});
})();
