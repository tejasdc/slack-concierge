import {spawnSync} from 'node:child_process';

const TICKET_URL='http://x/agent-browser/ticket';
const CAPABILITY_SOCKET='/run/thinkering/session-capabilities.sock';

function shellQuote(value:string):string {return `'${value.replaceAll("'", "'\\''")}'`;}

export function parseMacBrowserTicketResponse(output:string,now=Date.now()):string {
  const ending=output.match(/\n(\d{3})$/);
  if(!ending||ending[1]!=='200')throw new Error(`thnkr.ing refused this agent browser ticket (${ending?.[1]??'no HTTP status'}).`);
  let payload:unknown;
  try {payload=JSON.parse(output.slice(0,ending.index));}
  catch {throw new Error('thnkr.ing returned an invalid agent browser ticket.');}
  if(!payload||typeof payload!=='object')throw new Error('thnkr.ing returned an invalid agent browser ticket.');
  const {ticket,expiresAt}=payload as {ticket?:unknown;expiresAt?:unknown};
  const expires=typeof expiresAt==='string'?Date.parse(expiresAt):NaN;
  if(typeof ticket!=='string'||!ticket.startsWith('thnk-agent-browser-v1.')||ticket.length>8192||
      !Number.isFinite(expires)||expires<=now+5_000)
    throw new Error('thnkr.ing returned an invalid or expired agent browser ticket.');
  return ticket;
}

/** The Mac has no thnkr.ing socket or run token; its documented path is SSH to the server socket. */
export function requestMacBrowserTicket(inputId:string,runId:string):string {
  if(/[\r\n]/.test(inputId)||/[\r\n]/.test(runId))throw new Error('The accepted agent source is invalid.');
  const header=`X-Concierge-Agent-Source: ${inputId} ${runId}`;
  const remote=`curl -sS --max-time 15 --unix-socket ${shellQuote(CAPABILITY_SOCKET)} `+
    `-X POST -H ${shellQuote(header)} -w ${shellQuote('\n%{http_code}')} ${shellQuote(TICKET_URL)}`;
  const result=spawnSync('/usr/bin/ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5','remote-box',remote],{
    encoding:'utf8',timeout:20_000,maxBuffer:16_384
  });
  if(result.error||result.status!==0)throw new Error('The Mac could not obtain a verified thnkr.ing browser ticket.');
  return parseMacBrowserTicketResponse(result.stdout);
}
