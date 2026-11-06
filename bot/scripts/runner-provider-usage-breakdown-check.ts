import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {collectRunnerUsageRecords,type RemoteUsageRecord} from '../src/provider-usage-breakdown-client';

const root=await mkdtemp(join(tmpdir(),'provider-usage-check-'));
try{
  const home=join(root,'claude-home'),projects=join(home,'projects','-workspace-usage-fixture');
  const transcript=join(projects,'0192a345-6789-7abc-8def-0123456789ab.jsonl');
  await mkdir(projects,{recursive:true});
  const row=(id:string)=>JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),version:'2.1.0',message:{id,model:'claude-opus-5-5',usage:{input_tokens:17,cache_creation_input_tokens:3,cache_creation:{ephemeral_1h_input_tokens:1},cache_read_input_tokens:5,output_tokens:7}}})+'\n';
  await writeFile(transcript,row('record-one')+row('record-two'));
  const reader=join(import.meta.dir,'usage-breakdown-reader.ts'),cache=join(root,'runner-cache.db');
  const env={...process.env,USAGE_BREAKDOWN_CACHE:cache,CONCIERGE_RUNNER_STATE:root,
    USAGE_BREAKDOWN_PROVIDER_ROOTS:JSON.stringify([{provider:'claude-code',account:'tejas@example.test',home}])};
  const sinceMs=Date.now()-7*86400_000;
  const run=async(cursor:string|null)=>{
    const args=['run',reader,'--provider-page',JSON.stringify({cursor,providers:['claude-code'],limit:1,sinceMs})];
    const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
    child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
    const code=await new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('close',value=>resolve(value??-1));});
    if(code!==0)throw new Error(stderr||`runner page exited ${code}`);
    return JSON.parse(stdout);
  };
  const first=await run(null);
  if(first.records.length!==1||!first.nextCursor||first.records[0].firstUsage!==true
    ||first.records[0].sourceAccount!=='tejas@example.test')throw new Error('first bounded page did not preserve account and first-call metadata');
  if(JSON.stringify(first).includes(home)||JSON.stringify(first).includes(transcript))throw new Error('provider home path escaped in page');
  await writeFile(transcript,row('record-one')+row('record-two')+row('record-three'));
  const second=await run(first.nextCursor);
  if(second.records.length!==1||second.records[0].recordId!=='record-two'||second.nextCursor!==null)
    throw new Error('stable cursor duplicated or admitted a post-snapshot record');
  if(first.snapshotMaxRowid!==second.snapshotMaxRowid)throw new Error('snapshot high-water mark changed');

  const remoteRow:RemoteUsageRecord={sourceId:'a'.repeat(64),recordId:'remote-1',provider:'claude-code',conversation:'session-1',helper:false,
    atMs:Date.now(),model:'claude-opus-5-5',input:17,cacheWrite:2,cacheWrite1h:1,cacheRead:5,output:7,providerTurnId:null,
    clientVersion:'2.1.0',sourceAccount:'tejas@example.test',parentThreadId:null,firstUsage:true,boundaries:[]};
  const requests:any[]=[];
  const collected=await collectRunnerUsageRecords('ax41',['claude-code'],sinceMs,async(_runner,_method,params)=>{
    requests.push(params);
    return params.cursor===null?{snapshotMaxRowid:10,records:[remoteRow],nextCursor:'second-page'}
      :{snapshotMaxRowid:10,records:[],nextCursor:null};
  });
  if(collected.length!==1||requests.length!==2||requests[1].cursor!=='second-page'||requests.some(request=>request.sinceMs!==sinceMs))
    throw new Error('owner collector did not preserve the fixed report snapshot');
  let unavailable=false;
  try{await collectRunnerUsageRecords('ax41',['claude-code'],sinceMs,async()=>{throw new Error('runner offline');});}
  catch(error){unavailable=(error as Error).message==='runner offline';}
  if(!unavailable)throw new Error('runner failure was hidden from owner refresh');
  console.log('runner provider usage scan uses local homes, path-free bounded pages, first-call metadata, and a stable cursor snapshot');
}finally{await rm(root,{recursive:true,force:true});}
