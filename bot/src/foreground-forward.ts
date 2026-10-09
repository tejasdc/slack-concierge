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
