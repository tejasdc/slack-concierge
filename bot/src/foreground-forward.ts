/** Streaming transport only: this module must never import storage or application owners. */
export async function forwardPrivateRequest(request:Request,socket:string,signal:AbortSignal):Promise<Response> {
  const url=new URL(request.url);
  const headers=new Headers(request.headers);
  // The private destination is selected by the caller, never by a supplied Host header.
  headers.delete('host');
  headers.delete('connection');
  const response=await fetch(`http://localhost${url.pathname}${url.search}`,{
    unix:socket,method:request.method,headers,body:request.body,
    signal,redirect:'manual',decompress:false,
  });
  return new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers});
}

export function unavailable(code:string,message:string) {
  return Response.json({error:{code,message}},{status:503,headers:{'cache-control':'no-store'}});
}

/** The gateway uses its existing private transport; Node bridge discovery stays outside it. */
export async function forwardCodexMutationGate(body:unknown,socket:string):Promise<any> {
  const response=await forwardPrivateRequest(new Request('http://localhost/session-communication/codex-mutation-gate',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
  }),socket,AbortSignal.timeout(5000));
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Mutation authority response is unconfirmed.');
  const chunks:Uint8Array[]=[];
  let length=0;
  try {
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>64*1024)throw new Error('Mutation authority response exceeded its contract.');
      chunks.push(value);
    }
  } finally {await reader.cancel();reader.releaseLock();}
  if(response.status!==200)throw new Error('Mutation authority refused the request.');
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
