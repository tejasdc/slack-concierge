/** Search shows bounded previews; exact message bytes stay behind the selected context read. */
const MAX_SEARCH_RESPONSE_BYTES=512*1024;
const MAX_EVIDENCE_PER_SESSION=3;
const MAX_PREVIEW_CHARS=320;

function preview(text:string) {
  return text.length<=MAX_PREVIEW_CHARS?text:`${text.slice(0,MAX_PREVIEW_CHARS-1)}…`;
}

export function boundSearchResponse<T extends {results:any[];coverage:any}>(answer:T):T {
  const results=answer.results.map(result=>{
    const evidence=(result.evidence??[]).slice(0,MAX_EVIDENCE_PER_SESSION).map((item:any)=>{
      const original=typeof item.text==='string'?item.text:'';
      const snippet=preview(typeof item.snippet==='string'?item.snippet:original);
      return {...item,text:original.length<=MAX_PREVIEW_CHARS?original:snippet,snippet,
        ...((original.length>MAX_PREVIEW_CHARS||item.snippet?.length>MAX_PREVIEW_CHARS)?{previewTruncated:true}:{})};
    });
    return {...result,evidence,...((result.evidence?.length??0)>evidence.length?{moreEvidence:result.evidence.length-evidence.length}:{})};
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
