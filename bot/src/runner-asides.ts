import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';

type AsideRequest={operationId:string;provider:'claude-code'|'codex';account:string|null;spendAccount:string|null;sessionUuid:string;
  project:string|null;path:string;model:string|null;running:boolean;prompt:string};
type AsideAnswer={answer:string;model:string|null;durationMs:number};
type Home={account:string|null;home:string|null;transcript:string};
type Services={botDir:string;bunPath:string;resolveCwd:(project:string|null,path:string)=>Promise<string>;
  findHome:(provider:'claude-code'|'codex',account:string|null,sessionUuid:string)=>Home|null;
  accountHome:(provider:'claude-code'|'codex',account:string)=>string|null};
const retained=new Map<string,{promise:Promise<AsideAnswer>;at:number;digest:string}>();

/** True only when both names resolve to one existing physical file. */
export function samePhysicalFile(left:string,right:string):boolean{
  try{return realpathSync(left)===realpathSync(right);}catch{return false;}
}

export function serveRunnerAside(params:unknown,services:Services):Promise<AsideAnswer>{
  const input=params as AsideRequest;
  if(!input||typeof input.operationId!=='string'||!/^[A-Za-z0-9:_-]{8,160}$/.test(input.operationId)
    ||!['claude-code','codex'].includes(input.provider)||input.account!==null&&typeof input.account!=='string'
    ||input.spendAccount!==null&&typeof input.spendAccount!=='string'
    ||typeof input.sessionUuid!=='string'||!/^[0-9a-f-]{36}$/i.test(input.sessionUuid)
    ||input.project!==null&&typeof input.project!=='string'||typeof input.path!=='string'
    ||input.model!==null&&typeof input.model!=='string'||typeof input.running!=='boolean'
    ||typeof input.prompt!=='string'||input.prompt.length>100_000)throw new Error('INVALID_ASIDE_REQUEST');
  const now=Date.now();for(const [id,item] of retained)if(now-item.at>10*60_000)retained.delete(id);
  const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const prior=retained.get(input.operationId);if(prior){if(prior.digest!==digest)throw new Error('ASIDE_OPERATION_CONFLICT');return prior.promise;}
  const promise=(async()=>{
    const found=services.findHome(input.provider,input.account,input.sessionUuid);
    if(!found)throw new Error('The exact provider conversation is unavailable on this runner.');
    if(typeof found.home!=='string')
      throw new Error(input.provider==='claude-code'
        ?'The exact Claude account for this conversation is not bound on this runner.'
        :'The exact provider account for this conversation is not bound on this runner.');
    const spendHome=input.provider==='claude-code'&&input.spendAccount
      ?services.accountHome('claude-code',input.spendAccount):found.home;
    if(!spendHome)throw new Error('The account selected for the side question is unavailable on this runner.');
    const cwd=await services.resolveCwd(input.project,input.path);
    const installed=join(services.botDir,'scripts','runner-aside-worker.js');
    const worker=existsSync(installed)?installed:join(services.botDir,'scripts','runner-aside-worker.ts');
    const env={...process.env,...(input.provider==='claude-code'
      ?{CLAUDE_CONFIG_DIR:found.home,CONCIERGE_ASIDE_SPEND_HOME:spendHome}:{CODEX_HOME:found.home})};
    delete env.CONCIERGE_STATE_DIR;
    return new Promise<AsideAnswer>((resolve,reject)=>{
      const child=spawn(services.bunPath,[worker],{cwd,env,stdio:['pipe','pipe','pipe']});
      let stdout='',stderr='';
      const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();
        reject(new Error('The side question timed out on its runner.'));},190_000);
      child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{stdout=(stdout+chunk).slice(-1_000_000);});
      child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr=(stderr+chunk).slice(-2_000);});
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{
        clearTimeout(timer);if(code!==0)return reject(new Error(stderr||'The side question could not be answered.'));
        try{const value=JSON.parse(stdout);if(typeof value.answer!=='string'||typeof value.durationMs!=='number')throw new Error();
          resolve(value as AsideAnswer);}catch{reject(new Error('INVALID_ASIDE_ANSWER'));}
      });
      child.stdin.end(JSON.stringify({provider:input.provider,sessionUuid:input.sessionUuid,cwd,model:input.model,
        running:input.running,prompt:input.prompt}));
    });
  })();
  retained.set(input.operationId,{promise,at:now,digest});
  return promise;
}
