import {CodexAppServerClient} from './codex-app-server-client';
import {releaseWorkerPath} from './release-worker';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Provider='claude-code'|'codex';
type Location={project:string|null;path:string};
type Services={
  resolveHome:(provider:Provider,account:string)=>string|null;
  resolveProject:(project:string|null,path:string)=>Promise<string>;
  runClaudeFork?:(input:{home:string;cwd:string;sessionUUID:string;boundary:string})=>Promise<string>;
  codexClient?:()=>CodexAppServerClient;
};

function identity(value:unknown){
  if(typeof value!=='string'||!UUID.test(value))throw new Error('INVALID_PROVIDER_FORK_IDENTITY');
  return value;
}
function projectLocation(value:unknown):Location{
  if(!value||typeof value!=='object')throw new Error('INVALID_PROVIDER_FORK_PROJECT');
  const row=value as any;
  if(row.project!==null&&(typeof row.project!=='string'||!row.project.trim()||row.project.length>512||row.project.includes('/')||row.project.includes('\\'))
    ||typeof row.path!=='string'||row.path.length>4096||row.path.startsWith('/')||row.path.includes('\\')
    ||row.path.split('/').some((part:string)=>part==='..'))throw new Error('INVALID_PROVIDER_FORK_PROJECT');
  return {project:row.project,path:row.path};
}
async function defaultClaudeFork(input:{home:string;cwd:string;sessionUUID:string;boundary:string}):Promise<string>{
  const worker=releaseWorkerPath('provider-fork-worker');
  const child=Bun.spawn([process.execPath,'run',worker,input.sessionUUID,input.boundary],{
    cwd:input.cwd,env:{...process.env,CLAUDE_CONFIG_DIR:input.home},stdout:'pipe',stderr:'ignore',stdin:'ignore'});
  const timer=setTimeout(()=>child.kill(),120_000);
  try{
    const [stdout,code]=await Promise.all([new Response(child.stdout).text(),child.exited]);
    if(code!==0)throw new Error('PROVIDER_FORK_FAILED');
    const result=JSON.parse(stdout);
    return identity(result?.sessionUUID);
  }catch(error){if(error instanceof Error&&error.message==='PROVIDER_FORK_FAILED')throw error;throw new Error('PROVIDER_FORK_RESULT_INVALID');}
  finally{clearTimeout(timer);}
}
async function codexAccount(client:CodexAppServerClient,account:string){
  const result=await client.request('account/read',{refreshToken:true},{requestTimeoutMs:20_000});
  if(result?.account?.email!==account)throw new Error('PROVIDER_FORK_ACCOUNT_MISMATCH');
}
async function codexFork(client:CodexAppServerClient,input:{account:string;cwd:string;additionalDirs:string[];sessionUUID:string;boundary:string;threadSource:string}):Promise<string>{
  await codexAccount(client,input.account);
  const roots=[...new Set([input.cwd,...input.additionalDirs])];
  const response=await client.request('thread/fork',{
    threadId:input.sessionUUID,cwd:input.cwd,runtimeWorkspaceRoots:roots,
    approvalPolicy:'never',sandbox:'danger-full-access',deferGoalContinuation:true,excludeTurns:true,
    lastTurnId:input.boundary,threadSource:input.threadSource,
  },{untilDisconnect:true});
  const forked=identity(response?.thread?.id);
  if(forked===input.sessionUUID)throw new Error('PROVIDER_FORK_IDENTITY_MISMATCH');
  return forked;
}
async function findCodexForks(client:CodexAppServerClient,input:{account:string;cwd:string;sessionUUID:string;threadSource:string}):Promise<string[]>{
  await codexAccount(client,input.account);
  const found=new Set<string>();let cursor:string|null=null;const seen=new Set<string>();
  do{
    const response=await client.request('thread/list',{
      sourceKinds:['vscode'],cwd:input.cwd,limit:100,cursor,sortKey:'created_at',sortDirection:'desc',
    },{untilDisconnect:true});
    for(const thread of response?.data||[]){
      if(thread?.forkedFromId===input.sessionUUID&&thread?.threadSource===input.threadSource&&typeof thread?.id==='string')found.add(identity(thread.id));
    }
    cursor=typeof response?.nextCursor==='string'&&response.nextCursor?response.nextCursor:null;
    if(cursor&&seen.has(cursor))throw new Error('PROVIDER_FORK_HISTORY_DID_NOT_ADVANCE');
    if(cursor)seen.add(cursor);
  }while(cursor);
  return [...found];
}

/** Executes only exact native fork operations with runner-local account and project resolution. */
export async function serveRunnerProviderForkCall(method:string,params:any,services:Services):Promise<unknown>{
  if(method!=='provider-fork.execute'&&method!=='provider-fork.find')throw new Error('UNKNOWN_PROVIDER_FORK_OPERATION');
  const provider=params?.provider;
  if(provider!=='claude-code'&&provider!=='codex')throw new Error('INVALID_PROVIDER_FORK_PROVIDER');
  const sessionUUID=identity(params.sessionUUID),account=params.account,boundary=method==='provider-fork.execute'?params.boundary:null;
  if(typeof account!=='string'||!account.trim()||account.length>320)throw new Error('INVALID_PROVIDER_FORK_ACCOUNT');
  if(method==='provider-fork.execute'&&(typeof boundary!=='string'||!boundary.trim()||boundary.length>512))throw new Error('INVALID_PROVIDER_FORK_BOUNDARY');
  const threadSource=params.threadSource;
  if(typeof threadSource!=='string'||!/^concierge-native-fork:[0-9a-f-]{36}$/i.test(threadSource))throw new Error('INVALID_PROVIDER_FORK_SOURCE');
  const home=services.resolveHome(provider,account);
  if(!home)throw new Error('PROVIDER_ACCOUNT_HOME_UNAVAILABLE');
  const location=projectLocation(params.location);
  if(location.project===null&&location.path!=='')throw new Error('INVALID_PROVIDER_FORK_PROJECT');
  const cwd=await services.resolveProject(location.project,location.path);
  const additional=params.additionalLocations??[];
  if(!Array.isArray(additional)||additional.length>64)throw new Error('INVALID_PROVIDER_FORK_ADDITIONAL_PROJECTS');
  const additionalDirs=await Promise.all(additional.map(async value=>{
    const resolved=projectLocation(value);return services.resolveProject(resolved.project,resolved.path);
  }));
  if(provider==='claude-code'){
    if(method!=='provider-fork.execute')throw new Error('UNSUPPORTED_PROVIDER_FORK_RECOVERY');
    const result=await (services.runClaudeFork??defaultClaudeFork)({home,cwd,sessionUUID,boundary:boundary!});
    return {sessionUUID:result};
  }
  const client=services.codexClient?.()??new CodexAppServerClient();
  try{
    if(method==='provider-fork.find')return {sessionUUIDs:await findCodexForks(client,{account,cwd,sessionUUID,threadSource})};
    try{
      const forked=await codexFork(client,{account,cwd,additionalDirs,sessionUUID,boundary,threadSource});
      return {sessionUUID:forked};
    }catch(error){
      if(error instanceof Error&&error.message==='PROVIDER_FORK_ACCOUNT_MISMATCH')
        return {status:'rejected',reason:'The running Codex App Server has a different account; no fork was started.'};
      throw error;
    }
  }finally{await client.close().catch(()=>{});}
}
