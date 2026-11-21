import {thinkeringRequest} from './thinkering-capability-target';
import {log} from './log';

/**
 * Pebble's own app transcribes the ring before Concierge sees it, so its words skipped the
 * correction every other voice capture gets: thnkr.ing's learned names and hand list (Imbue,
 * thnkr.ing, Blygger …). On 2026-11-20/21 that left his contact names misheard in the Inbox
 * [decision: fix-transcripts-before-forwarding]. This sends the words through thnkr.ing's
 * correction route and returns what the Inbox should read. It never throws and never holds a
 * capture past its bound: any failure returns the original words unchanged.
 */
const PATH='/app/captures/vocabulary/correct';
const TIMEOUT_MS=2_000;
const LIMIT=262_144;

export type Correction={heard:string;term:string};

function ask(text:string,captureId:string,agentSource?:{inputId:string;runId:string}):Promise<{text:string;corrections:Correction[]}>{
  return new Promise((resolve,reject)=>{
    const body=Buffer.from(JSON.stringify({text,captureId}));
    const headers:Record<string,string|number>={'content-type':'application/json','content-length':body.length,
      'x-agent-why':'Correct a Pebble note with his learned names before the Inbox reads it'};
    if(agentSource)headers['x-concierge-agent-source']=`${agentSource.inputId} ${agentSource.runId}`;
    const request=thinkeringRequest(PATH,{method:'POST',timeout:TIMEOUT_MS,headers},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size>LIMIT)response.destroy(new Error('too large'));else chunks.push(part);});
      response.once('error',reject);
      response.once('end',()=>{
        if(response.statusCode!==200)return reject(new Error(`status ${response.statusCode}`));
        try{
          const answer=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {text?:unknown;corrections?:unknown};
          if(typeof answer.text!=='string'||!answer.text.trim())return reject(new Error('no text'));
          const corrections=(Array.isArray(answer.corrections)?answer.corrections:[])
            .flatMap(entry=>{const e=entry as {heard?:unknown;term?:unknown};
              return typeof e?.heard==='string'&&typeof e?.term==='string'&&e.heard.trim()&&e.term.trim()?[{heard:e.heard.trim(),term:e.term.trim()}]:[];});
          resolve({text:answer.text,corrections});
        }catch(error){reject(error);}
      });
    });
    request.once('timeout',()=>request.destroy(new Error('timeout')));
    request.once('error',reject);
    request.end(body);
  });
}

/** The words the Inbox reads: corrected, with the original wording noted when anything changed. */
export function renderCorrected(corrected:string,corrections:readonly Correction[]):string{
  if(!corrections.length)return corrected;
  const seen=new Set<string>();
  const notes=corrections.filter(c=>{const key=`${c.heard}→${c.term}`;if(seen.has(key))return false;seen.add(key);return true;})
    .map(c=>`${c.heard} → ${c.term}`);
  return `${corrected}\n\n(heard: ${notes.join('; ')})`;
}

export async function correctPebbleText(text:string,captureId:string,agentSource?:{inputId:string;runId:string}):Promise<string>{
  const started=Date.now();
  try{
    const answer=await ask(text,captureId,agentSource);
    // An answer with no recorded corrections but different words would change them silently.
    if(!answer.corrections.length)return text;
    log('info','pebble_capture_corrected',{corrections:answer.corrections.length,ms:Date.now()-started});
    return renderCorrected(answer.text,answer.corrections);
  }catch(error){
    log('warn','pebble_capture_correction_unavailable',{ms:Date.now()-started,reason:error instanceof Error?error.message.slice(0,60):'failed'});
    return text;
  }
}
