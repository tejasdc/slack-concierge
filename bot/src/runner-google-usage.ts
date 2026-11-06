/** Google subscription quota read on its owning runner; no owner ledger or credential imports. */
import {existsSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {resolveProviderAlias} from './aliases';
import {assertRunnerGoogleCreditPolicy} from './runner-google-policy';

type Window={name:string;usedPercent:number;resetsAt:string|null;willLastToReset:null;runsOutAt:null};
type Usage={observedAt:string;accounts:{label:string;plan:string|null;current:true;windows:Window[];problem:string|null;readAt:string|null}[];problem:string|null};
function iso(value:unknown):string|null{if(typeof value!=='string'||!value)return null;const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toISOString():null;}
function executable():string{
  assertRunnerGoogleCreditPolicy();
  const configured=process.env.CONCIERGE_ANTIGRAVITY_EXECUTABLE||'agy';
  const found=configured.includes('/')?configured:Bun.which(configured)|| (existsSync(join(homedir(),'.local/bin',configured))?join(homedir(),'.local/bin',configured):null);
  if(!found||!existsSync(found))throw new Error("The Google agent CLI is not installed on this runner.");
  return found;
}
async function capture(command:string,args:string[],timeoutMs:number){
  const child=Bun.spawn([command,...args],{env:{...process.env,AGY_CLI_DISABLE_AUTO_UPDATE:'true'},cwd:homedir(),stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  try{const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return {stdout,stderr,code};}
  finally{clearTimeout(timer);}
}
const unavailable=(observedAt:string,problem:string):Usage=>({observedAt,accounts:[],problem});
export async function readRunnerGoogleUsage():Promise<Usage>{
  const observedAt=new Date().toISOString();
  let command:string;try{command=executable();}catch(error){return unavailable(observedAt,error instanceof Error?error.message:"Google's credit setting could not be verified.");}
  let preflight;try{preflight=await capture(command,['--output-format','json','models'],15_000);}catch{return unavailable(observedAt,"Google's sign-in state could not be checked.");}
  if(preflight.code!==0)return unavailable(observedAt,/please sign in|authentication required/i.test(preflight.stderr)?"Sign in to the Google agent on this runner to show its allowance.":"Google's sign-in state could not be checked.");
  let offered:unknown;try{offered=JSON.parse(preflight.stdout)?.command?.data?.models;}catch{return unavailable(observedAt,"Google's offered models could not be read.");}
  const model=resolveProviderAlias('google').model;
  if(!Array.isArray(offered)||!model||!offered.some((item:any)=>item?.id===model))return unavailable(observedAt,"Google's selected model is not currently offered.");
  let result;try{result=await capture(command,['-p','/usage','--output-format','json'],25_000);}catch{return unavailable(observedAt,"Google's allowance could not be read.");}
  if(result.code!==0)return unavailable(observedAt,/authentication required|please sign in|not logged in/i.test(result.stderr)?"Sign in to the Google agent on this runner to show its allowance.":"Google's allowance could not be read.");
  let payload:any;try{payload=JSON.parse(result.stdout);}catch{return unavailable(observedAt,'Google returned an unreadable allowance.');}
  if(payload?.command?.name!=='usage')return unavailable(observedAt,'Google did not confirm a quota reading.');
  const groups=payload?.command?.data?.groups;if(!Array.isArray(groups))return unavailable(observedAt,'Google returned no verified allowance groups.');
  const buckets=groups.flatMap((group:any)=>Array.isArray(group?.buckets)?group.buckets:[]);
  const windows:Window[]=[];
  for(const [id,name] of [['gemini-5h','Gemini · 5-hour'],['gemini-weekly','Gemini · weekly']] as const){
    const bucket=buckets.find((item:any)=>item?.id===id),remaining=bucket?.remaining_fraction;
    if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0||remaining>1)continue;
    windows.push({name,usedPercent:(1-remaining)*100,resetsAt:iso(bucket?.reset_time),willLastToReset:null,runsOutAt:null});
  }
  if(windows.length!==2)return unavailable(observedAt,'Google did not report both Gemini allowance windows.');
  const family=/^gemini-[\d.]+-([a-z]+)/.exec(model)?.[1];
  if(family&&!['flash','pro'].includes(family)){
    const own=buckets.filter((item:any)=>typeof item?.id==='string'&&item.id.startsWith(`gemini-${family}-`));
    if(!own.length)return unavailable(observedAt,`Google reported no allowance for ${model}.`);
    for(const bucket of own){
      const remaining=bucket?.remaining_fraction;if(typeof remaining!=='number'||!Number.isFinite(remaining)||remaining<0||remaining>1)return unavailable(observedAt,`Google returned an unreadable allowance for ${model}.`);
      const label=family[0]!.toUpperCase()+family.slice(1);
      windows.push({name:`${label} · ${bucket.window==='5h'?'5-hour':bucket.window==='weekly'?'weekly':String(bucket.window??'limit')}`,usedPercent:(1-remaining)*100,resetsAt:iso(bucket?.reset_time),willLastToReset:null,runsOutAt:null});
    }
  }
  const identityFile=process.env.CONCIERGE_ANTIGRAVITY_IDENTITY_DIR||join(homedir(),'.local/state/concierge');
  let identity:any={};try{identity=JSON.parse(readFileSync(join(identityFile,'antigravity-identity.json'),'utf8'));}catch{}
  const statusAt=iso(identity.observedAt),fresh=statusAt!==null&&Date.parse(statusAt)>=Date.now()-6*60_000;
  const email=[payload?.command?.data?.email,payload?.command?.data?.account?.email,payload?.data?.email,payload?.email].find((value:unknown)=>typeof value==='string'&&/.+@.+\..+/.test(value));
  const account=typeof email==='string'?email:fresh?identity.email:null;
  if(fresh&&typeof email==='string'&&typeof identity.email==='string'&&email.toLowerCase()!==identity.email.toLowerCase())return unavailable(observedAt,"Google's account identity changed; its allowance needs a fresh sign-in check.");
  if(typeof account!=='string'||!/^.+@.+\..+$/.test(account))return unavailable(observedAt,'Google reported allowance but did not identify the signed-in account.');
  const plan=[payload?.command?.data?.subscription?.plan,payload?.command?.data?.plan_tier,payload?.plan_tier,fresh?identity.plan:null].find((value:unknown)=>typeof value==='string'&&value.trim());
  return {observedAt,accounts:[{label:account,plan:typeof plan==='string'?plan:null,current:true,windows,problem:null,readAt:observedAt}],problem:null};
}
