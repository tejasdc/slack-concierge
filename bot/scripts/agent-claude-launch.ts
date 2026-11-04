/** Account binding for fresh Claude CLI work launched from a Concierge agent shell. */
import {accessSync,constants,existsSync,realpathSync,readlinkSync,watch} from 'node:fs';
import {dirname,delimiter,isAbsolute,join,resolve,sep} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {requestApiResponse} from './router-request-client';

const args=process.argv.slice(2);
const wrapper=realpathSync(join(import.meta.dir,'claude'));
if(process.env.CONCIERGE_CLAUDE_LAUNCH_PARENT_PID===String(process.ppid)){
  throw new Error('A Concierge Claude launcher tried to start another Concierge Claude launcher.');
}
function candidates():string[] {
  const specified=process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE;
  if(specified){
    if(!isAbsolute(specified))throw new Error('The configured Claude Code executable path must be absolute.');
    return [specified];
  }
  return (process.env.PATH??'').split(delimiter).filter(Boolean).map(directory=>join(directory,'claude'));
}
function discoverClaude(paths:string[]):string|null {
  for(const candidate of paths){
    try {
      const resolved=realpathSync(candidate);
      // Agent shells can retain an earlier installed release in PATH. Every
      // release has its own wrapper path, and none is the Claude executable.
      if(resolved===wrapper||resolved.endsWith(`${sep}bot${sep}scripts${sep}claude`))continue;
      accessSync(candidate,constants.X_OK);
      return candidate;
    }catch{}
  }
  return null;
}
function nearestExistingDirectory(path:string):string {
  let directory=dirname(path);
  while(!existsSync(directory))directory=dirname(directory);
  return directory;
}
async function actualClaude():Promise<string> {
  const paths=candidates();
  const found=discoverClaude(paths);
  if(found)return found;
  console.error('Claude Code executable is unavailable; waiting for installation to finish.');
  // npm can remove the global command while replacing its package. Watch the
  // command and any broken symlink target so a launch during that window resumes.
  const started=Date.now();
  const deadline=started+120_000;
  while(Date.now()<deadline){
    const directories=new Set(paths.map(nearestExistingDirectory));
    for(const candidate of paths){
      try {
        const target=readlinkSync(candidate);
        directories.add(nearestExistingDirectory(resolve(dirname(candidate),target)));
      }catch{}
    }
    const changed=await new Promise<boolean>(resolveChange=>{
      const watchers:ReturnType<typeof watch>[]=[];
      let timer:ReturnType<typeof setTimeout>;
      let settled=false;
      const finish=(value:boolean)=>{
        if(settled)return;
        settled=true;
        clearTimeout(timer);
        for(const watcher of watchers)watcher.close();
        resolveChange(value);
      };
      timer=setTimeout(()=>finish(false),Math.max(0,deadline-Date.now()));
      for(const directory of directories){
        try {
          const watcher=watch(directory,()=>finish(true));
          watcher.on('error',()=>finish(true));
          watchers.push(watcher);
        }catch{}
      }
      // Close the scan-to-watch race: installation may have completed while
      // the watchers were being registered.
      if(discoverClaude(paths))finish(true);
    });
    const installed=discoverClaude(paths);
    if(installed){
      console.error(`Claude Code executable became available after ${Date.now()-started} ms: ${installed}`);
      return installed;
    }
    if(!changed)break;
  }
  throw new Error(`The installed Claude Code executable was not found after waiting for installation. Checked: ${paths.join(', ')||'(empty PATH)'}`);
}
const executable=await actualClaude();
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
// Scope the guard to our immediate child. Claude Code may later launch its own
// nested agent command, which must remain allowed under a different parent.
environment.CONCIERGE_CLAUDE_LAUNCH_PARENT_PID=String(process.pid);
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
