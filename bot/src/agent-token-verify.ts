import {createHmac,timingSafeEqual} from 'node:crypto';

/**
 * Signed credentials an agent or runner presents to the owner's network entrance
 * (docs/architecture/RUNNERS.md). Pure: no file or ledger access, so the front-door gateway
 * verifies tokens inside its storage-free boundary. Key files live in `agent-run-tokens.ts`.
 *
 * - `run`: the agent of one turn; ends with the execution host's own lifetime (seven days) plus a day.
 * - `runner`: a whole runner machine, also for callers without per-run environment (hooks the
 *   shared Codex App Server runs).
 */
export type AgentPrincipal={kind:'run';turnId:number;sessionId:number}|{kind:'runner';runner:string};
export type VerifiedAgent=AgentPrincipal&{expiresAtMs:number};

const PREFIX='cat1';
export const RUN_TOKEN_LIFETIME_MS=8*24*60*60*1000;
export const RUNNER_TOKEN_LIFETIME_MS=90*24*60*60*1000;

const encode=(value:Buffer|string)=>Buffer.from(value).toString('base64url');
const sign=(key:Buffer,body:string)=>createHmac('sha256',key).update(`${PREFIX}.${body}`).digest();

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

