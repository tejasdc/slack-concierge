import {readFileSync} from 'node:fs';
import {request as httpRequest,type ClientRequest,type IncomingMessage,type RequestOptions} from 'node:http';

/**
 * Where Concierge's own calls to thnkr.ing's capabilities go (docs/architecture/RUNNERS.md,
 * "Concierge's own thnkr.ing calls"). Two places answer the same paths:
 *
 * - thnkr.ing's network entrance (`CONCIERGE_THINKERING_CAPABILITY_URL`, its tailnet address) with
 *   the owner's service token (`CONCIERGE_THINKERING_TOKEN_FILE`), so the owner works from a machine
 *   that does not share thnkr.ing's disk: the app server it is moving to.
 * - the private local socket otherwise, exactly as before.
 *
 * One function decides it, so every caller (ChatGPT runs, native reads, human commands, to-dos,
 * thesaurus) moves together and none is left assuming the socket. The token is read per call: a
 * rotated file takes effect without a restart, and a missing one fails that call, never silently
 * falls back to a socket the next machine will not have.
 */
const DEFAULT_SOCKET='/run/thinkering/session-capabilities.sock';

export type ThinkeringPlace={kind:'network';url:URL;tokenFile:string}|{kind:'socket';socketPath:string};

export function thinkeringPlace(socketPath?:string):ThinkeringPlace{
  const url=process.env.CONCIERGE_THINKERING_CAPABILITY_URL?.trim();
  if(url){
    const tokenFile=process.env.CONCIERGE_THINKERING_TOKEN_FILE?.trim();
    if(!tokenFile)throw new Error('CONCIERGE_THINKERING_CAPABILITY_URL needs CONCIERGE_THINKERING_TOKEN_FILE');
    const parsed=new URL(url);
    if(parsed.protocol!=='http:')throw new Error('thnkr.ing network entrance must be an http: tailnet address');
    return {kind:'network',url:parsed,tokenFile};
  }
  return {kind:'socket',socketPath:socketPath||process.env.THINKERING_SESSION_CAPABILITY_SOCKET||process.env.CONCIERGE_SESSION_CAPABILITY_SOCKET||DEFAULT_SOCKET};
}

/** Whether Concierge can reach thnkr.ing's capabilities at all from here. */
export function thinkeringConfigured(socketPath?:string):boolean{
  return Boolean(process.env.CONCIERGE_THINKERING_CAPABILITY_URL?.trim()||socketPath);
}

/** Node request options for one capability path at the configured place. */
export function thinkeringRequestOptions(path:string,options:Omit<RequestOptions,'path'|'socketPath'|'host'|'hostname'|'port'>,socketPath?:string):RequestOptions{
  const place=thinkeringPlace(socketPath);
  if(place.kind==='socket')return {...options,socketPath:place.socketPath,path};
  const token=readFileSync(place.tokenFile,'utf8').trim();
  if(!token)throw new Error('the thnkr.ing service token file is empty');
  const prefix=place.url.pathname.replace(/\/$/,'');
  return {...options,hostname:place.url.hostname,port:place.url.port||80,path:`${prefix}${path}`,
    headers:{...(options.headers as Record<string,unknown>|undefined),authorization:`Bearer ${token}`} as RequestOptions['headers']};
}

/**
 * `http.request` at the configured place. A token that cannot be read throws here; every caller
 * builds its request inside a Promise executor, so that becomes the call's rejection.
 */
export function thinkeringRequest(path:string,options:Omit<RequestOptions,'path'|'socketPath'|'host'|'hostname'|'port'>,
  onResponse:(response:IncomingMessage)=>void,socketPath?:string):ClientRequest{
  return httpRequest(thinkeringRequestOptions(path,options,socketPath),onResponse);
}
