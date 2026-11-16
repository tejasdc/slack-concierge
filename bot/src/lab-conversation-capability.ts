import {thinkeringRequest} from './thinkering-capability-target';
import {awaitingOutside} from './storage-observation';
import {LabConversationError} from './lab-conversations';

/** Fixed typed sibling on the existing authenticated capability transport. */
export function labConversationCapability<T>(method:'GET'|'POST',thread:string,operation:'bootstrap'|'context'|'publish'|'binding',input?:Record<string,unknown>,signal?:AbortSignal):Promise<T>{
  const root=`/session-capabilities/lab/records/${encodeURIComponent(thread)}`;
  const path=operation==='bootstrap'?root:operation==='binding'?`${root}/binding`:operation==='publish'?`${root}/responses`:
    `${root}/response-context?${new URLSearchParams(Object.entries(input??{}).map(([key,value])=>[key,String(value)]))}`;
  return awaitingOutside(()=>new Promise<T>((resolve,reject)=>{
    const body=method==='POST'?JSON.stringify(input):null;
    let settled=false;
    const fail=(error:unknown)=>{if(!settled){settled=true;reject(error);}};
    const request=thinkeringRequest(path,{method,headers:{connection:'close',...(body?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{})}},response=>{
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>4*1024*1024){response.destroy();fail(new LabConversationError('The Lab capability response exceeded its bounded context contract.',502,'LAB_CONTEXT_TOO_LARGE'));}else chunks.push(Buffer.from(chunk));});
      response.on('error',()=>fail(new LabConversationError('The Lab capability disconnected before confirming its result.',503,'LAB_CAPABILITY_DISCONNECTED')));
      response.on('end',()=>{
        if(settled)return;
        let value:any;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{fail(new LabConversationError('The Lab capability returned invalid JSON.',502,'LAB_CAPABILITY_PROTOCOL'));return;}
        const status=response.statusCode??503;
        if(status<200||status>=300){fail(new LabConversationError(typeof value?.reason==='string'?value.reason:'The Lab capability refused this operation.',status,typeof value?.error==='string'?value.error:'LAB_CAPABILITY_REFUSED'));return;}
        settled=true;resolve(value as T);
      });
    });
    request.on('error',()=>fail(new LabConversationError('The Lab capability connection did not confirm its result.',503,'LAB_CAPABILITY_DISCONNECTED')));
    const abort=()=>request.destroy(new Error('Lab observation stopped'));
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    request.once('close',()=>signal?.removeEventListener('abort',abort));
    request.setTimeout(20_000,()=>request.destroy(new Error('Lab capability deadline')));
    request.end(body??undefined);
  }));
}
