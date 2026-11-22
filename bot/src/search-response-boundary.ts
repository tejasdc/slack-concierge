/** Search shows bounded previews; exact message bytes stay behind the selected context read. */
import {peerCatalogueView} from './peer-catalogue-view';
const MAX_SEARCH_RESPONSE_BYTES=512*1024;
const MAX_EVIDENCE_PER_SESSION=3;
const MAX_PREVIEW_CHARS=320;

/**
 * An agent searches with up to eight concepts, each a quoted phrase ("Unknown Pleasures",
 * "signal register"). They travel as one query string, one concept per line: a release that
 * predates concepts reads the line breaks as spaces, so a peer on either release still answers.
 * Joining them with spaces made every word of every concept a required word of one message,
 * so only messages retelling the search itself matched (2026-11-22, tejas.nyc's visualization).
 */
export const conceptQuery=(concepts:string[])=>concepts.map(concept=>concept.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
export const queryConcepts=(query:string)=>{
  const concepts=query.split('\n').map(concept=>concept.replace(/\s+/g,' ').trim()).filter(Boolean);
  return [...new Set(concepts)].slice(0,8);
};

function preview(text:string) {
  return text.length<=MAX_PREVIEW_CHARS?text:`${text.slice(0,MAX_PREVIEW_CHARS-1)}…`;
}

export function boundSearchResponse<T extends {results:any[];coverage:any}>(answer:T):T {
  const results=answer.results.map(result=>{
    const raw=result.session;
    const session=raw?.peer&&!raw.capabilities
      ?peerCatalogueView(raw,raw.peer,raw.availability??{state:'archived-only',reachable:false,note:'This search has only a stored session summary.'},Date.parse(raw.lastSeenAt??raw.updatedAt??''))
      :raw;
    const evidence=(result.evidence??[]).slice(0,MAX_EVIDENCE_PER_SESSION).map((item:any)=>{
      const original=typeof item.text==='string'?item.text:'';
      const snippet=preview(typeof item.snippet==='string'?item.snippet:original);
      return {...item,text:original.length<=MAX_PREVIEW_CHARS?original:snippet,snippet,
        ...((original.length>MAX_PREVIEW_CHARS||item.snippet?.length>MAX_PREVIEW_CHARS)?{previewTruncated:true}:{})};
    });
    return {...result,session,evidence,...((result.evidence?.length??0)>evidence.length?{moreEvidence:result.evidence.length-evidence.length}:{})};
  });
  let response:any={...answer,results};
  let omitted=0;
  while(results.length&&Buffer.byteLength(JSON.stringify(response))>MAX_SEARCH_RESPONSE_BYTES){results.pop();omitted++;
    response={...answer,results,coverage:{...answer.coverage,complete:false,
      reason:[answer.coverage?.reason,`${omitted} search candidates omitted by the response size limit.`].filter(Boolean).join(' '),
      omissions:[...(answer.coverage?.omissions??[]),`${omitted} search candidates omitted by the response size limit; narrow the query.`]}};
  }
  if(Buffer.byteLength(JSON.stringify(response))>MAX_SEARCH_RESPONSE_BYTES)
    response={results:[],coverage:{complete:false,indexedAt:null,sources:0,reason:'Search metadata exceeded the response size limit; narrow the query.',
      refresh:[],omissions:['Search metadata exceeded the response size limit; narrow the query.']}};
  return response as T;
}
