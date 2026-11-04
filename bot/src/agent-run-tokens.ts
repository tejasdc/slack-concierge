import {randomBytes} from 'node:crypto';
import {chmodSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {mintAgentToken} from './agent-token-verify';

export * from './agent-token-verify';

/**
 * The owner's side of agent tokens (docs/architecture/RUNNERS.md): the signing key on its disk and
 * the environment a run receives. Verification, which the gateway needs, is in agent-token-verify.ts.
 * A token authorizes what the local socket authorizes today; the owner's source-input/run checks
 * still decide every action (agents are never handcuffed further).
 */
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
