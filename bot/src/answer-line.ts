/**
 * The line he reads on his Lock Screen and on the reading item: the answer itself, from the TL;DR
 * written to him. It used to be the first sentence after "TL;DR:", so an answer that opened with a
 * numbered list reached his phone as "1." and one that opened "Probably not." as just that
 * (2026-10-08, 3:27 PM: "single line, single sentence, single word notifications"). Now list
 * markers are dropped and sentences are kept until the line says something, within what a
 * notification shows. The reply's own summary is written to the agent that asked, about him, so it
 * is not used here.
 */
export function answerLine(value:string,limit=240):string {
  const body=value.replace(/^\s*TL;DR:\s*/i,'').trim();
  const block=body.split(/\n\s*\n/).find(part=>part.trim())??'';
  const flat=block.split('\n').map(line=>line.replace(/^\s*(?:\d+[.)]|[-*•])\s+/,'').replace(/\*\*|__|`/g,'').trim())
    .filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
  let line='';
  for(const sentence of flat.split(/(?<=[.!?])\s+/)) {
    const next=(line+' '+sentence.trim()).trim();
    if(next.length>limit) {
      // A short opener ("Done and live.") needs the sentence after it even when that one is long.
      if(line.length<80){const cut=next.lastIndexOf(' ',limit-1);line=next.slice(0,cut>line.length?cut:limit-1)+'…';}
      break;
    }
    line=next;
    if(line.length>=80)break;
  }
  if(!line)line=flat.length>limit?flat.slice(0,flat.lastIndexOf(' ',limit-1)>0?flat.lastIndexOf(' ',limit-1):limit-1)+'…':flat;
  return line;
}

/**
 * Why a line meant for his Lock Screen is a fragment, or null when it says something: at least four
 * words once a list number or bullet is set aside. "1." and "Probably not." are what reached him.
 */
export function fragmentReason(value:string):string|null {
  const words=value.replace(/^\s*(?:\d+[.)]|[-*•])\s*/,'').trim().split(/\s+/).filter(word=>/[A-Za-z0-9]/.test(word));
  return words.length<4?`"${value.trim()}" is a fragment: a line on his Lock Screen has to say the answer itself, in at least a short sentence.`:null;
}
