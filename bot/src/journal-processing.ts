import {createHash} from 'node:crypto';
import {db} from './state';
import {getAcceptedSessionInput} from './session-inputs';

export type JournalReview = {rootId:string;revision:string;disposition:'context-only'|'actionable';reason:string;items:{lineId:string;quote:string;offset?:number;classification:'explicit-request'|'actionable-reason';title:string;reason:string;existingRequestId?:string}[]};
export function journalPortionIdentity(root:string,line:string,quote:string) {
  return createHash('sha256').update(JSON.stringify([root,line,quote])).digest('hex');
}
export function validateJournalReview(review:JournalReview,source:any) {
  if(!review||typeof review.rootId!=='string'||!review.revision||!review.reason?.trim()||!Array.isArray(review.items)
    ||!['context-only','actionable'].includes(review.disposition)
    ||(review.disposition==='context-only'?review.items.length!==0:review.items.length===0))throw new Error('Invalid journal review disposition.');
  if(source?.rootId!==review.rootId||source?.sourceRoot?.objectId!==review.rootId||source.sourceRoot.revision!==review.revision
    ||!source.sourceRoot.actor?.id||!source.sourceRoot.actor?.kind||!Array.isArray(source.lines))throw new Error('Journal source revision and actor proof required.');
  if(source.lines.some((line:any)=>!line.revision||!line.actor?.id||!line.actor?.kind))throw new Error("Every journal line requires revision and actor proof.");
  const seen=new Set<string>();
  return review.items.map(item=>{
    const line=source.lines.find((line:any)=>line.objectId===item.lineId);
    if(!line?.revision||!line.actor?.id||!line.actor?.kind||!Number.isFinite(Date.parse(line.at))
      ||typeof item.quote!=='string'||!item.quote.trim()||(typeof line.text!=='string'||!line.text.includes(item.quote)|| (item.offset===undefined?line.text.indexOf(item.quote)!==line.text.lastIndexOf(item.quote):(!Number.isInteger(item.offset)||item.offset<0||line.text.slice(item.offset,item.offset+item.quote.length)!==item.quote)))
      ||!['explicit-request','actionable-reason'].includes(item.classification)||!item.title?.trim()||item.title.length>200||!item.reason?.trim())throw new Error('An actionable portion needs its exact current source line, located quote, actor and revision.');
    if(item.classification==='explicit-request'&&line.actor.kind!=='human')throw new Error('Agent or imported text cannot become a human request; use an agent-authored reason for assessment.');
    const id=journalPortionIdentity(review.rootId,item.lineId,item.quote);
    if(seen.has(id))throw new Error('Duplicate journal portion.');seen.add(id);
    return {id,item,line};
  });
}
export function pendingJournalProcessing(inputId:string,runId?:string):string|null {
  const accepted=getAcceptedSessionInput(inputId);
  const obligation=accepted&&JSON.parse(accepted.payload_json).journalProcessing;
  if(!obligation)return null;
  const receipt=db.query("SELECT 1 FROM session_inputs WHERE source_input_id=? AND kind='journal-review' AND json_extract(receipt_json,'$.state')='completed' LIMIT 1").get(inputId);
  return receipt?null:`Process ${obligation.rootId}: sessions journal-review --review-file <JSON-path> --source-input '${inputId}' --source-run ${runId?`'${runId}'`:'<this-run>'} --action-id <stable-id>. Tracker observations alone do not complete processing.`;
}
