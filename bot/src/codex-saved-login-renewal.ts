import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANAGED_CODEX } from './codex-daemon-file-limit';
import { log } from './log';

const inFlight = new Set<string>();
let switching = false;
const retries = new Map<string,{version:string|null;failures:number;nextAt:number;signedOut?:boolean}>();

/** A move can touch both the incoming and outgoing homes, so the guard is machine-wide. */
export function beginCodexAccountSwitch():(()=>void)|null {
  if(inFlight.size||switching)return null;
  switching=true;
  return ()=>{switching=false;};
}

function version(home:string):string|null {
  try {
    const stat=statSync(join(home,'auth.json'),{bigint:true});
    return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
  } catch { return null; }
}

function canRefresh(home:string):boolean {
  try { return !!JSON.parse(readFileSync(join(home,'auth.json'),'utf8'))?.tokens?.refresh_token; }
  catch { return false; }
}

/** Codex, in the saved home's own process, renews its token. Concierge never copies or rewrites it. */
function refreshThroughCodex(home:string,email:string):Promise<'renewed'|'signed_out'|'failed'> {
  return new Promise(resolve=>{
    const child=spawn(MANAGED_CODEX,['app-server','--stdio'],{
      env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
    child.stdin.on('error',()=>{});
    let done=false,buffer='',result:'renewed'|'signed_out'|'failed'='failed';
    let hardStop:ReturnType<typeof setTimeout>|null=null;
    const finish=(outcome:'renewed'|'signed_out'|'failed')=>{
      if(done)return;
      done=true;
      result=outcome;
      clearTimeout(deadline);
      child.stdin.end();
      child.kill();
      hardStop=setTimeout(()=>child.kill('SIGKILL'),2_000);
    };
    const deadline=setTimeout(()=>finish('failed'),45_000);
    child.once('error',()=>finish('failed'));
    child.once('close',()=>{
      clearTimeout(deadline);
      if(hardStop)clearTimeout(hardStop);
      resolve(result);
    });
    child.stdout.on('data',(chunk:Buffer)=>{
      if(done)return;
      buffer+=chunk.toString('utf8');
      for(let newline=buffer.indexOf('\n');newline>=0;newline=buffer.indexOf('\n')){
        if(done)break;
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        let message:any;
        try {message=JSON.parse(line);} catch {continue;}
        if(message?.id==='init'&&message.result){
          child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
          child.stdin.write(JSON.stringify({id:'account',method:'account/read',params:{refreshToken:true}})+'\n');
        }
        if(message?.id==='init'&&message.error)finish('failed');
        if(message?.id==='account'){
          const error=String(message.error?.message??'');
          finish(message.result?.account?.email===email?'renewed'
            :/refresh_token_reused|token_revoked|invalidated oauth token|invalid_grant/i.test(error)?'signed_out':'failed');
        }
      }
      // A diagnostic response must never grow without bound in the owner process.
      if(buffer.length>64_000)finish('failed');
    });
    child.stdin.write(JSON.stringify({id:'init',method:'initialize',params:{
      clientInfo:{name:'concierge_usage',title:'Concierge Usage',version:'1.0'},
      capabilities:{experimentalApi:true,requestAttestation:false},
    }})+'\n');
  });
}

/** An unreadable saved login never counts as room; only a provider refusal proves sign-out. */
export function renewSavedCodexLogin(home:string,email:string,onSettled:()=>void):'pending'|'unavailable'|'signed_out'|'no_refresh_token' {
  if(inFlight.has(home)||switching)return 'pending';
  if(!canRefresh(home))return 'no_refresh_token';
  const current=version(home),retry=retries.get(home);
  if(retry?.version===current&&retry.signedOut)return 'signed_out';
  // A retry delay is still an unreadable saved login, not proof it is signed out.
  if(retry?.version===current&&Date.now()<retry.nextAt)return retry.failures>=3?'unavailable':'pending';
  if(retry?.version===current&&retry.failures>=3)return 'unavailable';
  const failures=retry?.version===current?retry.failures+1:1;
  retries.set(home,{version:current,failures,
    nextAt:Date.now()+Math.min(5*60_000*2**(failures-1),30*60_000)});
  inFlight.add(home);
  void refreshThroughCodex(home,email).then(outcome=>{
    const changed=version(home)!==current;
    if(outcome==='renewed'&&changed)retries.delete(home);
    else if(outcome==='signed_out'&&!changed)retries.set(home,{version:current,failures,nextAt:0,signedOut:true});
    onSettled();
    log('info','codex_saved_login_renewal',{account:email,outcome:outcome==='renewed'&&changed?'renewed':outcome==='signed_out'?'signed_out':'failed'});
  }).catch(error=>log('warn','codex_saved_login_renewal_failed',{
    account:email,error_name:error instanceof Error?error.name:'Error',
  })).finally(()=>inFlight.delete(home));
  return 'pending';
}
