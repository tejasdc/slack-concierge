/** Account binding for fresh Claude CLI work launched from a Concierge agent shell. */
import {realpathSync} from 'node:fs';
import {delimiter,isAbsolute,join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {requestApiResponse} from './router-request-client';

const args=process.argv.slice(2);
const wrapper=realpathSync(join(import.meta.dir,'claude'));
function actualClaude():string {
  const specified=process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE;
  if(specified&&isAbsolute(specified)&&realpathSync(specified)!==wrapper)return specified;
  for(const directory of (process.env.PATH??'').split(delimiter)){
    if(!directory)continue;
    const candidate=join(directory,'claude');
    try {if(realpathSync(candidate)!==wrapper)return candidate;}catch{}
  }
  throw new Error('The installed Claude Code executable was not found.');
}
const executable=actualClaude();
const firstCommandArg=args.find(arg=>arg!=='--dangerously-skip-permissions');
const passthrough=['auth','config','doctor','update','mcp','plugin','agents'].includes(firstCommandArg??'')
  || args.some(arg=>['--version','-v','--help','-h'].includes(arg))
  || args.some(arg=>arg==='--resume'||arg==='-r'||arg==='--continue'||arg==='-c'||arg==='--fork-session'||arg==='--agent-id')
  || process.env.CONCIERGE_CLAUDE_ACCOUNT_PIN==='1';
const model=(()=>{for(let i=0;i<args.length;i++){
  if(args[i]==='--model')return args[i+1]??null;
  if(args[i]?.startsWith('--model='))return args[i]!.slice('--model='.length);
}return null;})();
const environment={...process.env};
if(!passthrough){
  for(const name of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']){
    if(environment[name])throw new Error(`Claude account selection refused a competing ${name} credential or provider setting. Explicitly pin an intentional route.`);
  }
  const response=await requestApiResponse(`/sessions/v1/auth/claude-launch-choice${model?`?model=${encodeURIComponent(model)}`:''}`);
  if(!response.ok){
    const refusal=response.result?.error;
    const reason=typeof refusal?.message==='string'?refusal.message
      :typeof response.result?.detail==='string'?response.result.detail
      :'Concierge could not select a Claude account.';
    throw new Error(reason);
  }
  const choice=response.result?.choice as {account?:unknown;home?:unknown}|null;
  if(choice&&typeof choice.account!=='string')throw new Error('Concierge returned an invalid Claude account choice.');
  if(choice?.home!==null&&choice?.home!==undefined&&typeof choice.home!=='string')throw new Error('Concierge returned an invalid Claude account home.');
  if(choice?.home)environment.CLAUDE_CONFIG_DIR=choice.home;
  else delete environment.CLAUDE_CONFIG_DIR;
  if(choice?.account){
    // The directory is only a proposed route. Claude itself confirms the effective login.
    const status=spawnSync(executable,['auth','status'],{env:environment,encoding:'utf8',timeout:15_000});
    let identity: {loggedIn?:boolean;authMethod?:string;apiProvider?:string;email?:string;configDirectory?:string};
    try{identity=JSON.parse(status.stdout??'');}catch{throw new Error('Claude could not confirm the selected account.');}
    if(status.status!==0||!identity.loggedIn||identity.authMethod!=='claude.ai'||identity.apiProvider!=='firstParty'
      ||identity.email!==choice.account||!identity.configDirectory
      ||realpathSync(identity.configDirectory)!==realpathSync(choice.home??join(process.env.HOME??'', '.claude'))){
      throw new Error('Claude authenticated with a different account than Concierge selected.');
    }
  }
}
const child=spawn(executable,args,{env:environment,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>child.kill(signal));
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=signal?128+(signal==='SIGINT'?2:15):(code??1);});
