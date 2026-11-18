import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {thinkeringRequest} from './thinkering-capability-target';
import {awaitingOutside} from './storage-observation';
import {HELD_RESOLUTION_KINDS,HELD_RESOLUTION_STATES,HELD_RESOLUTION_COMPLETIONS,type HeldMessageResolution,type HeldMessageSnapshot} from './held-message-resolution';

/** One exact, bounded read over Concierge's existing authenticated product transport. No retry. */
export async function readHeldMessageSnapshot(resolution:HeldMessageResolution,sessionId:number,allowResolved=false):Promise<HeldMessageSnapshot> {
  const value=await awaitingOutside(()=>new Promise<unknown>((resolve,reject)=>{
    let finished=false;
    const fail=(error:Error)=>{if(!finished){finished=true;reject(error);}};
    const request=thinkeringRequest(`/session-capabilities/messages/held-resolutions/${encodeURIComponent(resolution.id)}`,
      {method:'GET',headers:{connection:'close'}},response=>{
        const chunks:Buffer[]=[];let bytes=0;
        response.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>128*1024){response.destroy();fail(new Error('Held resolution response exceeded 128KiB.'));}else chunks.push(Buffer.from(chunk));});
        response.on('error',()=>fail(new Error('Held resolution read disconnected.')));
        response.on('aborted',()=>fail(new Error('Held resolution response was interrupted.')));
        response.on('close',()=>{if(!response.complete)fail(new Error('Held resolution response ended before its full body.'));});
        response.on('end',()=>{
          if(finished)return;
          if(response.statusCode!==200){fail(new Error(`Held resolution read refused (HTTP ${response.statusCode??0}).`));return;}
          try {const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));finished=true;resolve(body);}
          catch{fail(new Error('Held resolution read returned invalid JSON.'));}
        });
      });
    const timer=setTimeout(()=>request.destroy(new Error('Held resolution read deadline.')),5000);
    request.once('close',()=>clearTimeout(timer));
    request.on('error',()=>fail(new Error('Held resolution product read unavailable; no admission or retry.')));
    request.end();
  }));
  const snapshot=value as HeldMessageSnapshot;
  const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
  if(!snapshot||snapshot.version!==1||snapshot.id!==resolution.id||snapshot.callerSession!==`concierge:${sessionId}`
    ||!HELD_RESOLUTION_STATES.includes(snapshot.state)
    ||(snapshot.state==='resolved'?(!allowResolved||snapshot.eligible!==false):snapshot.eligible!==true||snapshot.consumed!==false)
    ||!HELD_RESOLUTION_KINDS.includes(snapshot.resolutionKind)
    ||(['originalRequestId','taskId','messageId','sourceInputId','failedReadingId','failedReadingSha256'] as const)
      .some(key=>snapshot[key]!==resolution[key])
    ||snapshot.failedReadingFormat!=='assessment-manifest-v1'
    ||typeof snapshot.failedReadingJson!=='string'||snapshot.failedReadingJson.length>64000
    ||digest(snapshot.failedReadingJson)!==snapshot.failedReadingSha256
    ||!/^[a-f0-9]{64}$/.test(snapshot.contextHash)||!/^[a-f0-9]{64}$/.test(snapshot.envelopeHash)
    ||digest(JSON.stringify(['send-resolution',snapshot.taskId,snapshot.failedReadingId]))!==snapshot.id
    ||typeof snapshot.reason!=='string'||!snapshot.reason.trim()||snapshot.reason.length>4000
    ||(snapshot.question!==null&&(typeof snapshot.question!=='string'||snapshot.question.length>4000))
    ||(snapshot.supportingQuote!==null&&(typeof snapshot.supportingQuote!=='string'||snapshot.supportingQuote.length>4000))
    ||(snapshot.quoteSourceInputId!==null&&(typeof snapshot.quoteSourceInputId!=='string'||!snapshot.quoteSourceInputId.trim()||snapshot.quoteSourceInputId.length>500))
    ||snapshot.resolutionKind==='human-choice'&&(!snapshot.question?.trim()||!snapshot.supportingQuote?.trim()||!snapshot.quoteSourceInputId))
    throw new Error('The current product task, exact reading bytes or resolution identity does not match.');
  let manifest:any;try{manifest=JSON.parse(snapshot.failedReadingJson);}catch{throw new Error('The retained assessment manifest is not valid JSON.');}
  if(manifest?.format!=='send-resolution-assessment-v1'||manifest.reading?.id!==snapshot.failedReadingId
    ||!/^[a-f0-9]{64}$/.test(manifest.reading?.sha256)||manifest.contextHash!==snapshot.contextHash||manifest.envelopeHash!==snapshot.envelopeHash
    ||!isDeepStrictEqual(manifest.assessment,{kind:snapshot.resolutionKind,reason:snapshot.reason,question:snapshot.question,
      supportingQuote:snapshot.supportingQuote,quoteSourceInputId:snapshot.quoteSourceInputId})
    ||!manifest.receipt||typeof manifest.receipt!=='object'||Array.isArray(manifest.receipt)
    ||!Array.isArray(manifest.artifacts)||manifest.artifacts.some((artifact:any)=>typeof artifact?.id!=='string'||!artifact.id||!/^[a-f0-9]{64}$/.test(artifact.sha256)))
    throw new Error('The compact assessment manifest does not match its pinned full-reading, context, envelope or assessment.');
  if(snapshot.state==='resolved'){
    const completion=snapshot.completion;
    if(!completion||!HELD_RESOLUTION_COMPLETIONS.includes(completion.kind)||typeof completion.receiptId!=='string'||!completion.receiptId.trim()
      ||completion.receiptId.length>500||completion.messageId!==snapshot.messageId||!/^[a-f0-9]{64}$/.test(completion.envelopeHash)
      ||completion.kind==='consumed'&&snapshot.consumed!==true||completion.kind!=='consumed'&&snapshot.consumed!==false)
      throw new Error('A resolved product task needs its exact revision/withdrawal/consumed-effect receipt.');
  }
  return snapshot;
}
