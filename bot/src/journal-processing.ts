import {createHash} from 'node:crypto';
import {db} from './state';
import {getAcceptedSessionInput,humanAuthored} from './session-inputs';
import {reportSourceChain} from './agent-report-reads';

export function existingJournalRequestEvidence(requestId:string,rootId:string,lineId:string,quote:string,location?:{offset:number;occurrence:number},lineText?:string) {
  const inbox=db.query('SELECT sources_json FROM inbox_requests WHERE request_id=?').get(requestId) as {sources_json:string}|null;
  const request=db.query('SELECT request_id FROM session_communication_requests WHERE request_id=?').get(requestId);
  if(!inbox&&!request)throw new Error('JOURNAL_EXISTING_RELATION_UNCONFIRMED: the named request is not retained; do not replay an uncertain effect.');
  const sourceIds=new Set<string>(inbox?JSON.parse(inbox.sources_json).map((source:{inputId:string})=>source.inputId):[]);
  const chain=request?reportSourceChain(db,requestId):null;
  if(chain){
    for(const hop of chain.hops)sourceIds.add(hop.id);
    for(const id of chain.carriedReports)sourceIds.add(id);
    for(const link of chain.inboxLinks)for(const source of link.sources)sourceIds.add(source.inputId);
  }
  for(const id of sourceIds){
    const input=getAcceptedSessionInput(id);if(!input)continue;
    const payload=JSON.parse(input.payload_json),journal=payload.capture?.source?.metadata?.journal;
    const version=createHash('sha256').update(input.payload_json).digest('hex');
    if(journal?.rootId===rootId&&journal.lineId===lineId&&typeof journal.quote==='string'&&journal.quote.includes(quote)
      &&(!location||(journal.quote===quote?(journal.occurrence??0)===location.occurrence:
        typeof journal.offset==='number'&&location.offset>=journal.offset&&journal.quote.slice(location.offset-journal.offset,location.offset-journal.offset+quote.length)===quote)))
      return {method:'journal-source-metadata',requestId,inputId:id,version,rootId,lineId,quote,location,journal};
    if(humanAuthored(input)&&typeof payload.text==='string'&&payload.text.includes(quote)
      &&(!location||!lineText||lineText.indexOf(quote)===lineText.lastIndexOf(quote)||payload.text.includes(lineText)))
      return {method:'legacy-human-source-chain',requestId,inputId:id,version,quote,location,offset:location&&lineText&&payload.text.includes(lineText)?payload.text.indexOf(lineText)+location.offset:payload.text.indexOf(quote),sourceAt:input.created_at,association:chain?{hops:chain.hops.map(hop=>({id:hop.id,sourceInput:hop.sourceInput,sourceRun:hop.sourceRun})),carriedReports:chain.carriedReports,inboxLinks:chain.inboxLinks.filter(link=>link.sources.some(source=>source.inputId===id)).map(link=>({requestId:link.inboxRequestId,topicId:link.topicId,inputId:id}))}:{inboxRequestId:requestId,inputId:id}};
  }
  throw new Error('JOURNAL_EXISTING_RELATION_UNCONFIRMED: the retained request source does not contain this journal quote; do not replay an uncertain effect.');
}

export type JournalReview = {rootId:string;revision:string;sourceVersion:string;disposition:'context-only'|'actionable';reason:string;items:{lineId:string;quote:string;offset?:number;classification:'explicit-request'|'actionable-reason';title:string;reason:string;existingRequestId?:string}[]};
export function journalPortionIdentity(root:string,line:string,quote:string,occurrence=0) {
  // The first occurrence keeps the identity used when the quote was unique. Ordinals
  // distinguish repeated words without coupling work identity to unrelated edits or offsets.
  return createHash('sha256').update(JSON.stringify(occurrence===0?[root,line,quote]:[root,line,quote,occurrence])).digest('hex');
}
export function validateJournalReview(review:JournalReview,source:any) {
  if(!review||typeof review.rootId!=='string'||!review.revision||!review.reason?.trim()||!Array.isArray(review.items)
    ||!['context-only','actionable'].includes(review.disposition)
    ||(review.disposition==='context-only'?review.items.length!==0:review.items.length===0))throw new Error('Invalid journal review disposition.');
  if(typeof review.sourceVersion!=='string'||!review.sourceVersion||source?.sourceVersion!==review.sourceVersion)throw new Error("Journal complete source version is missing or stale.");
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
    const offset=item.offset??line.text.indexOf(item.quote);
    let occurrence=0;
    for(let start=line.text.indexOf(item.quote);start>=0&&start<offset;start=line.text.indexOf(item.quote,start+1))occurrence++;
    const location={offset,occurrence};
    const id=journalPortionIdentity(review.rootId,item.lineId,item.quote,occurrence);
    if(seen.has(id))throw new Error('Duplicate journal portion.');seen.add(id);
    return {id,item,line,location};
  });
}
export function pendingJournalProcessing(inputId:string,runId?:string):string|null {
  const accepted=getAcceptedSessionInput(inputId);
  const obligation=accepted&&JSON.parse(accepted.payload_json).journalProcessing;
  if(!obligation)return null;
  const receipt=db.query("SELECT 1 FROM session_inputs WHERE source_input_id=? AND kind='journal-review' AND json_extract(receipt_json,'$.state')='completed' LIMIT 1").get(inputId);
  return receipt?null:`Process ${obligation.rootId}: sessions journal-review --review-file <JSON-path> --source-input '${inputId}' --source-run ${runId?`'${runId}'`:'<this-run>'} --action-id <stable-id>. Tracker observations alone do not complete processing.`;
}
