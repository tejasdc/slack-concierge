import {spawn} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';

const MAX_PAGE_BYTES=192*1024;
const MAX_PAGE_RECORDS=100;

function usageReaderPath(){
  const runtimeDir=process.argv[1]?dirname(resolve(process.argv[1])):import.meta.dir;
  const candidates=[join(runtimeDir,'usage-breakdown-reader.js'),join(runtimeDir,'usage-breakdown-reader.ts'),
    join(import.meta.dir,'../scripts/usage-breakdown-reader.ts')];
  const found=candidates.find(path=>existsSync(path));
  if(!found)throw new Error('PROVIDER_USAGE_BREAKDOWN_READER_MISSING');
  return found;
}

async function runProviderPage(stateDir:string,roots:{provider:'claude-code'|'codex';account:string;home:string}[],cursor:string|null,limit:number,providers:('claude-code'|'codex')[],sinceMs:number){
  const reader=usageReaderPath(),cache=join(stateDir,'provider-usage-breakdown.db');
  const child=spawn(process.execPath,[reader,'--provider-page',JSON.stringify({cursor,limit,providers,sinceMs})],{
    env:{...process.env,CONCIERGE_STATE_DIR:stateDir,USAGE_BREAKDOWN_CACHE:cache,
      USAGE_BREAKDOWN_PROVIDER_ROOTS:JSON.stringify(roots)},stdio:['ignore','pipe','pipe']});
  let output='',error='';
  child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{output+=chunk;if(Buffer.byteLength(output)>MAX_PAGE_BYTES+8192)child.kill();});
  child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{if(error.length<4096)error+=chunk.slice(0,4096-error.length);});
  const exit=await new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve(code??-1));});
  if(exit!==0)throw new Error(error||`PROVIDER_USAGE_BREAKDOWN_SCAN_FAILED:${exit}`);
  if(Buffer.byteLength(output)>MAX_PAGE_BYTES+8192)throw new Error('PROVIDER_USAGE_BREAKDOWN_PAGE_TOO_LARGE');
  let result:any;try{result=JSON.parse(output);}catch{throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_REPLY');}
  if(!result||!Number.isSafeInteger(result.snapshotMaxRowid)||!Array.isArray(result.records)||result.records.length>MAX_PAGE_RECORDS
    ||Buffer.byteLength(JSON.stringify(result))>MAX_PAGE_BYTES
    ||result.nextCursor!==null&&typeof result.nextCursor!=='string')throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_REPLY');
  return result;
}

/** Scans registered account homes on this runner and returns path-free, bounded usage records.
 * The caller keeps ledger attribution and asks successive pages with the returned opaque cursor. */
export async function serveProviderUsageBreakdownCall(method:string,params:any,
  stateDir=process.env.CONCIERGE_RUNNER_STATE||join(homedir(),'.local/state/concierge-runner/state'),
  resolveHomes?:(provider:'claude-code'|'codex')=>{account:string;home:string}[]):Promise<unknown>{
  if(method!=='provider-usage-breakdown.page')throw new Error(`unknown provider usage call ${method}`);
  const cursor=params.cursor===undefined?null:params.cursor;
  const limit=params.limit===undefined?MAX_PAGE_RECORDS:params.limit;
  const sinceMs=params.sinceMs;
  const providers=params.providers===undefined?['claude-code','codex']:params.providers;
  if(cursor!==null&&(typeof cursor!=='string'||cursor.length>2048)||!Number.isSafeInteger(limit)||limit<1||limit>MAX_PAGE_RECORDS
    ||!Number.isSafeInteger(sinceMs)||sinceMs<0||sinceMs>Date.now())
    throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_PAGE');
  if(!Array.isArray(providers)||!providers.length||providers.length>2||providers.some(value=>value!=='claude-code'&&value!=='codex'))
    throw new Error('INVALID_PROVIDER_USAGE_BREAKDOWN_PAGE');
  if(!resolveHomes)throw new Error('PROVIDER_USAGE_HOME_RESOLVER_REQUIRED');
  const roots=([...new Set(providers)] as ('claude-code'|'codex')[]).flatMap(provider=>resolveHomes(provider).map(entry=>({provider,account:entry.account,home:entry.home})));
  if(!roots.length)throw new Error('NO_PROVIDER_USAGE_HOMES');
  return runProviderPage(stateDir,roots,cursor,limit,[...new Set(providers)],sinceMs);
}
