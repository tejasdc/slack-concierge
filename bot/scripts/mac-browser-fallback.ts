#!/usr/bin/env bun
/** Give an admitted server failure its own headless Mac browser, never a personal profile. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {join} from 'node:path';
import {requestMacBrowserTicket} from '../src/mac-browser-ticket';

function refuse(message:string):never {console.error(message);process.exit(2);}
if(process.platform!=='darwin')refuse('Mac browser fallback runs only on the Mac.');
const inputId=process.env.CONCIERGE_SOURCE_INPUT_ID;
const runId=process.env.CONCIERGE_SOURCE_RUN_ID;
if(!inputId||!runId)refuse('The accepted Mac browser fallback is missing its request or run.');
const userHome=userInfo().homedir;
let origin:string;
try {
  const response=await fetch('http://localhost/sessions/v1/mac-browser-fallback',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({sourceInputId:inputId,sourceRunId:runId}),
    unix:join(userHome,'Library','Application Support','concierge','requests.sock'),signal:AbortSignal.timeout(5000)
  } as RequestInit & {unix:string});
  if(!response.ok)refuse('The Mac owner has no active recorded server failure for this browser.');
  const grant=await response.json() as {origin?:unknown};
  if(typeof grant.origin!=='string')refuse('The Mac owner did not return a fallback website.');
  origin=grant.origin;
} catch {refuse('The Mac owner could not verify this browser fallback.');}
let site:URL;
try {site=new URL(origin);} catch {refuse('The accepted Mac browser website is invalid.');}
if(!['http:','https:'].includes(site.protocol)||site.origin!==origin)
  refuse('The accepted Mac browser website is invalid.');

const args=process.argv.slice(2);
if(!args.length)refuse('Choose an agent-browser action.');
const disallowed=/^(?:--(?:auto-connect|cdp|config|engine|executable-path|headed|profile|provider|session|session-name|state|args|extension|extensions|init-script|allowed-domains|headers)(?:=.*)?|-p)$/i;
if(args.some(arg=>disallowed.test(arg))||['connect','inspect','profiles'].includes(args[0]!)
    ||args[0]==='set'&&args[1]==='headers'
    ||args[0]==='close'&&args.includes('--all'))
  refuse('The Mac fallback browser cannot attach to another browser or change its private profile.');
if(args[0]==='open'){
  let requested:URL;
  try {requested=new URL(args[1]??'');} catch {refuse('Open an absolute website URL.');}
  if(requested.origin!==site.origin)
    refuse('This fallback was admitted for a different website. Record a new server failure for this one.');
}

const key=createHash('sha256').update(`${inputId}\0${runId}\0${origin}`).digest('hex').slice(0,24);
const profile=join(userHome,'Library','Application Support','concierge','browser-fallback',key);
mkdirSync(profile,{recursive:true,mode:0o700});
chmodSync(profile,0o700);
const config=join(profile,'agent-browser.json');
writeFileSync(config,'{}\n',{mode:0o600});
chmodSync(config,0o600);
const env={...process.env};
for(const name of Object.keys(env))if(name.startsWith('AGENT_BROWSER_'))delete env[name];
Object.assign(env,{AGENT_BROWSER_AUTO_CONNECT:'false',AGENT_BROWSER_HEADED:'false',
  AGENT_BROWSER_SESSION:`mac-fallback-${key}`,AGENT_BROWSER_PROFILE:profile,
  AGENT_BROWSER_IDLE_TIMEOUT_MS:'1200000'});
const installed=join(userHome,'.local','share','fnm','aliases','default','bin','agent-browser');
if(!existsSync(installed))refuse('The Mac browser worker needs its managed agent-browser installation.');
let ticket:string|undefined;
if(site.origin==='https://thnkr.ing'&&args[0]==='open'){
  try {ticket=requestMacBrowserTicket(inputId,runId);}
  catch(error) {refuse(error instanceof Error?error.message:'The thnkr.ing browser ticket was unavailable.');}
}
let result:ReturnType<typeof spawnSync>;
try {
  if(ticket)writeFileSync(config,JSON.stringify({headers:JSON.stringify({'X-Thinkering-Agent-Browser':ticket})})+'\n',{mode:0o600});
  result=spawnSync(installed,['--auto-connect','false','--headed','false',
    '--config',config,'--session',`mac-fallback-${key}`,'--profile',profile,...args],{env,stdio:'inherit'});
} finally {
  // The running browser retains its origin header; the bearer need not remain on disk.
  writeFileSync(config,'{}\n',{mode:0o600});
  chmodSync(config,0o600);
}
if(result.error)refuse(`The isolated Mac browser could not start: ${result.error.message}`);
process.exit(result.status??1);
