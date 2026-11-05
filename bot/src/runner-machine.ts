/**
 * What names a machine in an agent's environment, and who supplies it (docs/architecture/RUNNERS.md).
 *
 * The owner never sends its own folders to a runner: the state folder, the helper release, Bun and
 * the helpers' place on `PATH` are always the runner's. The runner fills them in for Claude turns
 * (runner.ts `turnEnvironment`) and for Codex threads on the way through its relay
 * (`rewriteRelayedCodexRequest`), so both agents find `router-actions.sh` on any machine.
 *
 * Where the owner is lives in one file in the runner's state folder (`connection.env`), not in an
 * agent's environment: a Codex thread keeps its first turn's shell settings for its whole life, so an
 * address written there would outlive the owner's move to its own server. Helpers read the file
 * each time (router-request-client.ts, scripts/thinkering).
 */
import {mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** Variables whose value is a path on the machine that runs the agent. */
export const MACHINE_PATH_KEYS=['PATH','CONCIERGE_STATE_DIR','CONCIERGE_STATE_DB','CONCIERGE_ROUTER_BOT_DIR','CONCIERGE_BUN_BIN'] as const;

/** The owner's half: its own folders are left out of anything a runner will run. */
export function withoutMachinePaths(environment:Record<string,string>):Record<string,string> {
  const kept={...environment};
  for(const key of MACHINE_PATH_KEYS)delete kept[key];
  return kept;
}

export type RunnerMachine={botDir:string;stateDir:string;bunPath:string;runnerName:string;basePath:string};

/** The runner's half: this machine's folders, with its helpers first on `PATH`. */
export function runnerMachineEnvironment(machine:RunnerMachine,runPath='',ownerScripts:string|null=null):Record<string,string> {
  const run=runPath.split(':').filter(part=>part&&part!==ownerScripts);
  return {
    PATH:[join(machine.botDir,'scripts'),...new Set([...run,...machine.basePath.split(':').filter(Boolean)])].join(':'),
    CONCIERGE_STATE_DIR:machine.stateDir,
    CONCIERGE_STATE_DB:join(machine.stateDir,'no-ledger-on-a-runner.db'),
    CONCIERGE_ROUTER_BOT_DIR:machine.botDir,
    CONCIERGE_BUN_BIN:machine.bunPath,
    // The helpers find this runner's connection file (below) through it.
    CONCIERGE_RUNNER_STATE:machine.stateDir,
    CONCIERGE_RUNNER_NAME:machine.runnerName,
  };
}

export type RunnerConnection={ownerUrl:string;tokenFile:string;thinkeringUrl:string|null};
const CONNECTION_FILE='connection.env';
const CONNECTION_KEYS={ownerUrl:'CONCIERGE_OWNER_URL',tokenFile:'CONCIERGE_RUNNER_TOKEN_FILE',thinkeringUrl:'THINKERING_CAPABILITY_URL'} as const;

/** Written by the runner at each start, so a configuration change reaches every running thread. */
export function writeRunnerConnection(stateDir:string,connection:RunnerConnection) {
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const lines=Object.entries(CONNECTION_KEYS).flatMap(([field,key])=>{
    const value=connection[field as keyof RunnerConnection];
    if(value&&/[\r\n]/.test(value))throw new Error(`runner connection ${key} holds a line break`);
    return value?[`${key}=${value}`]:[];
  });
  const target=join(stateDir,CONNECTION_FILE);
  writeFileSync(`${target}.tmp`,`${lines.join('\n')}\n`,{mode:0o600});
  renameSync(`${target}.tmp`,target);
}

/** The runner's current connection for a helper whose environment names a runner, or null. */
export function readRunnerConnection(environment:NodeJS.ProcessEnv=process.env):Partial<RunnerConnection>|null {
  const stateDir=environment.CONCIERGE_RUNNER_STATE?.trim();
  if(!stateDir)return null;
  let text:string;
  try{text=readFileSync(join(stateDir,CONNECTION_FILE),'utf8');}catch{return null;}
  const values=new Map(text.split('\n').map(line=>{const at=line.indexOf('=');return at>0?[line.slice(0,at),line.slice(at+1)] as const:null;}).filter(Boolean) as [string,string][]);
  const connection:Partial<RunnerConnection>={};
  for(const [field,key] of Object.entries(CONNECTION_KEYS)){const value=values.get(key)?.trim();if(value)(connection as any)[field]=value;}
  return connection.ownerUrl?connection:null;
}

/**
 * One message from the owner to this runner's Codex App Server, as the relay passes it. A thread's
 * shell settings get this runner's folders, and a `turn/start` names the thread whose hooks must run
 * this runner's helpers (`pinThread`). Anything else, and anything that is not a JSON-RPC request,
 * passes byte for byte. Only owner-to-App-Server messages come here; the streamed answers do not.
 */
export function rewriteRelayedCodexRequest(text:string,machine:RunnerMachine):{text:string;pinThread:string|null} {
  // Cheap test first: most owner messages are small requests that need nothing.
  if(!text.includes('"shell_environment_policy"')&&!text.includes('"turn/start"'))return {text,pinThread:null};
  let message:any;
  try{message=JSON.parse(text);}catch{return {text,pinThread:null};}
  if(!message||typeof message!=='object'||typeof message.method!=='string')return {text,pinThread:null};
  const pinThread=message.method==='turn/start'&&typeof message.params?.threadId==='string'?message.params.threadId:null;
  const set=message.params?.config?.shell_environment_policy?.set;
  if(!set||typeof set!=='object')return {text,pinThread};
  message.params.config.shell_environment_policy.set={...set,...runnerMachineEnvironment(machine,typeof set.PATH==='string'?set.PATH:'')};
  return {text:JSON.stringify(message),pinThread};
}
