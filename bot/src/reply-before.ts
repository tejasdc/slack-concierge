/**
 * The "What came before" lead a first reply carries when its request arrived with earlier work
 * (request-history.ts). The reply shown to the asker and in his thread includes it; a reader that
 * needs only the replying agent's own words (an organizer's placement JSON) removes it here, so
 * the wording has one home. The 2026-11-05 `project new` refusal (request 18be9df9) came from the
 * placement gate reading the lead as part of the organizer's decision.
 */
export function withBefore(before:string,text:string){
  return `What came before: ${before}${text.trim()?`\n\n${text}`:''}`;
}

/** The replying agent's own words in a recorded reply: its body without the required lead. */
export function replyOwnWords(payload:{replyBody?:unknown;before?:unknown}):string|null {
  if(typeof payload.replyBody!=='string')return null;
  if(typeof payload.before!=='string'||!payload.before)return payload.replyBody;
  const lead=withBefore(payload.before,'');
  if(!payload.replyBody.startsWith(lead))return payload.replyBody;
  return payload.replyBody.slice(lead.length).replace(/^\n\n/,'');
}

/**
 * One JSON object in an agent's answer: the whole body, or the single object it contains among
 * prose or a fenced block. Exactly one candidate object is accepted; several are ambiguous.
 */
export function oneJsonObject(text:string):unknown {
  try{return JSON.parse(text);}catch{}
  const found:unknown[]=[];
  for(let start=text.indexOf('{');start>=0;){
    let depth=0,inString=false,escaped=false,end=-1;
    for(let i=start;i<text.length;i++){
      const c=text[i];
      if(inString){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')inString=false;continue;}
      if(c==='"')inString=true;
      else if(c==='{')depth++;
      else if(c==='}'&&--depth===0){end=i;break;}
    }
    if(end<0)break;
    try{const value=JSON.parse(text.slice(start,end+1));if(value&&typeof value==='object'&&!Array.isArray(value))found.push(value);}catch{}
    start=text.indexOf('{',end+1);
  }
  if(found.length!==1)throw new Error('Expected exactly one JSON object.');
  return found[0];
}
