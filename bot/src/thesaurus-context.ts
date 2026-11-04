import {spawn} from 'node:child_process';
import {request as httpRequest} from 'node:http';
import {log} from './log';

/**
 * Tejas's own thesaurus lives in Thinkering (packages/core/src/thesaurus.ts there): his terms and
 * what they mean to him. Before every agent turn Concierge hands it the turn's words and puts the
 * ready answer beside them, so an agent reads his meaning for "Kodiak loop" (his spoken CoDIAK)
 * instead of guessing. Matching and wording stay in Thinkering; this only carries the text over.
 * Asked for on 2026-11-02 after an agent could not define CoDIAK with Engelbart in the same message.
 */
const SOCKET = process.env.THINKERING_SESSION_CAPABILITY_SOCKET || '/run/thinkering/session-capabilities.sock';
// A local socket answers in milliseconds; the Mac crosses SSH to the server, where the thesaurus is.
const LOCAL_MS = 1_500, MAC_MS = 6_000;
const LIMIT = 1_048_576;
const UNREAD = 'Tejas’s own thesaurus (his meanings for his terms) could not be read for this message.';
// How to look a word up is Thinkering's wording, kept from its last answer rather than copied here,
// so a turn whose lookup failed still says how to reach the thesaurus once one has succeeded.
let lastLookup:string|null=null;

function overSocket(body:Buffer):Promise<string>{
  return new Promise((resolve,reject)=>{
    const request=httpRequest({socketPath:SOCKET,path:'/thesaurus/mentions',method:'POST',timeout:LOCAL_MS,
      headers:{'content-type':'application/json','content-length':body.length}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size>LIMIT)response.destroy(new Error('too large'));else chunks.push(part);});
      response.once('error',reject);
      response.once('end',()=>response.statusCode===200?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error(`status ${response.statusCode}`)));
    });
    request.once('timeout',()=>request.destroy(new Error('timeout')));
    request.once('error',reject);
    request.end(body);
  });
}

function overSsh(body:Buffer):Promise<string>{
  return new Promise((resolve,reject)=>{
    const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=4','remote-box',
      `curl -sf --max-time 3 --unix-socket ${SOCKET} -H content-type:application/json --data-binary @- http://x/thesaurus/mentions`],{stdio:['pipe','pipe','ignore']});
    const chunks:Buffer[]=[];let size=0;
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('timeout'));},MAC_MS);
    child.stdout.on('data',chunk=>{const part=Buffer.from(chunk as Uint8Array);size+=part.length;if(size<=LIMIT)chunks.push(part);});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(new Error(`exit ${code}`));});
    child.stdin.end(body);
  });
}

/** The thesaurus paragraph for this turn's words; never throws and never holds a turn past its bound. */
export async function thesaurusTurnContext(text:string):Promise<string>{
  const started=Date.now();
  try{
    const body=Buffer.from(JSON.stringify({text}));
    const answer=JSON.parse(await (process.platform==='darwin'?overSsh(body):overSocket(body))) as {context?:unknown;mentions?:unknown[];lookup?:unknown};
    if(typeof answer.context!=='string'||!answer.context.trim())throw new Error('no context');
    if(typeof answer.lookup==='string'&&answer.lookup.trim())lastLookup=answer.lookup;
    log('info','thesaurus_turn_context',{mentions:Array.isArray(answer.mentions)?answer.mentions.length:0,ms:Date.now()-started});
    return answer.context;
  }catch(error){
    log('warn','thesaurus_turn_context_unavailable',{ms:Date.now()-started,reason:error instanceof Error?error.message.slice(0,80):'failed'});
    return lastLookup?`${UNREAD} ${lastLookup}`:UNREAD;
  }
}
