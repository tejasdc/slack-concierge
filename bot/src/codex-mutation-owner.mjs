import {request} from 'node:http';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';

/** The Node bridge uses the root-private common-owner entrance. The runner relay
 * supplies the same call inside the gateway, where its owner socket is explicit. */
export function codexMutationOwnerGate(body,socketPath){
  const state=process.env.CONCIERGE_STATE_DIR||join(homedir(),'.local/state/concierge');
  const socket=socketPath||join(process.env.CONCIERGE_STATE_DB?dirname(process.env.CONCIERGE_STATE_DB):state,'requests.sock');
  const bytes=JSON.stringify(body);
  return new Promise((resolve,reject)=>{
    const call=request({socketPath:socket,path:'/session-communication/codex-mutation-gate',method:'POST',
      headers:{'content-type':'application/json','content-length':Buffer.byteLength(bytes)}},response=>{
      let text='';response.setEncoding('utf8');
      response.on('data',chunk=>{text+=chunk;if(text.length>64*1024)call.destroy(new Error('Mutation authority response exceeded its contract.'));});
      response.on('end',()=>{try{const result=JSON.parse(text);if(response.statusCode!==200)throw new Error('Mutation authority refused the request.');resolve(result);}catch(error){reject(error);}});
      response.on('error',reject);
    });
    call.setTimeout(5000,()=>call.destroy(new Error('Mutation authority response is unconfirmed.')));
    call.on('error',reject);call.end(bytes);
  });
}
