import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {chmodSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Credentials an agent presents to the owner's network entrance instead of reaching a socket file
 * on the owner's own disk (docs/architecture/RUNNERS.md, "Agents reach the owner over HTTPS").
 *
 * A token names one principal and when it stops working:
 * - `run`: the agent of one turn. The owner mints it when the run starts and passes it in the
 *   run's environment; it ends with the execution host's own lifetime (seven days) plus a day.
 * - `runner`: a whole runner machine, for callers that carry no per-run environment (hooks the
 *   shared Codex App Server runs with its own environment).
 *
 * Verification needs only the key, so the gateway process checks a token without opening the
 * ledger, and the runner never holds the key: it receives finished tokens from the owner.
 * The token authorizes what the local socket authorizes today; the owner's existing
 * source-input/run checks still decide every action (agents are never handcuffed further).
 */
export type AgentPrincipal={kind:'run';turnId:number;sessionId:number}|{kind:'runner';runner:string};
export type VerifiedAgent=AgentPrincipal&{expiresAtMs:number};

const PREFIX='cat1';
export const RUN_TOKEN_LIFETIME_MS=8*24*60*60*1000;
export const RUNNER_TOKEN_LIFETIME_MS=90*24*60*60*1000;

const encode=(value:Buffer|string)=>Buffer.from(value).toString('base64url');
const sign=(key:Buffer,body:string)=>createHmac('sha256',key).update(`${PREFIX}.${body}`).digest();

/** The owner's signing key for agent tokens; created once, readable only by its user. */
export function agentTokenKey(stateDir:string):Buffer {
  const path=join(stateDir,'agent-token.key');
  if(!existsSync(path)) {
    try {writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}
    catch(error){if((error as {code?:string}).code!=='EEXIST')throw error;}
  }
  chmodSync(path,0o600);
  const key=Buffer.from(readFileSync(path,'utf8').trim(),'hex');
  if(key.length!==32)throw new Error('The agent token key is unreadable.');
  return key;
}

export function mintAgentToken(key:Buffer,principal:AgentPrincipal,nowMs=Date.now()):string {
  const lifetime=principal.kind==='run'?RUN_TOKEN_LIFETIME_MS:RUNNER_TOKEN_LIFETIME_MS;
  const body=encode(JSON.stringify({...principal,exp:nowMs+lifetime}));
  return `${PREFIX}.${body}.${encode(sign(key,body))}`;
}

/** The principal a presented token proves, or null when it is malformed, forged or expired. */
export function verifyAgentToken(key:Buffer,token:string,nowMs=Date.now()):VerifiedAgent|null {
  const parts=token.split('.');
  if(parts.length!==3||parts[0]!==PREFIX)return null;
  const [,body,signature]=parts as [string,string,string];
  const expected=sign(key,body),presented=Buffer.from(signature,'base64url');
  if(presented.length!==expected.length||!timingSafeEqual(presented,expected))return null;
  let claims:any;
  try{claims=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{return null;}
  if(typeof claims?.exp!=='number'||claims.exp<=nowMs)return null;
  if(claims.kind==='run'&&Number.isSafeInteger(claims.turnId)&&Number.isSafeInteger(claims.sessionId))
    return {kind:'run',turnId:claims.turnId,sessionId:claims.sessionId,expiresAtMs:claims.exp};
  if(claims.kind==='runner'&&typeof claims.runner==='string'&&/^[a-z][a-z0-9-]{1,40}$/.test(claims.runner))
    return {kind:'runner',runner:claims.runner,expiresAtMs:claims.exp};
  return null;
}

/** How a verified principal is named to the owner on the forwarded request. */
export function agentPrincipalHeader(agent:VerifiedAgent):string {
  return agent.kind==='run'?`run:${agent.sessionId}:${agent.turnId}`:`runner:${agent.runner}`;
}

let ownerKey:{dir:string;key:Buffer}|null=null;
/**
 * What a run's environment carries so its helpers reach this owner over the network: the owner's
 * address and the run's token, only when `CONCIERGE_AGENT_API_URL` names that address (the
 * app-server move sets it). Otherwise nothing: helpers keep the local socket, and no unused
 * bearer credential sits in agents' environments and transcripts.
 */
export function agentRunEnvironment(principal:{turnId:number;sessionId:number},
  environment:NodeJS.ProcessEnv=process.env):Record<string,string> {
  const dir=environment.CONCIERGE_STATE_DIR?.trim();
  const url=environment.CONCIERGE_AGENT_API_URL?.trim();
  if(!dir||!url)return {};
  if(ownerKey?.dir!==dir)ownerKey={dir,key:agentTokenKey(dir)};
  return {CONCIERGE_AGENT_TOKEN:mintAgentToken(ownerKey.key,{kind:'run',...principal}),CONCIERGE_OWNER_URL:url};
}
