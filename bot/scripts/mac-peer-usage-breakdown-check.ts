import {Database} from 'bun:sqlite';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const root=await mkdtemp(join(tmpdir(),'mac-peer-usage-check-'));
try{
  const home=join(root,'home'),state=join(root,'state'),projects=join(home,'.claude','projects','-usage-fixture');
  await mkdir(projects,{recursive:true});
  await mkdir(state,{recursive:true});
  const nativeId='0192a345-6789-7abc-8def-0123456789ab';
  const now=new Date(),started=new Date(now.getTime()-60_000).toISOString().slice(0,19).replace('T',' ');
  await writeFile(join(projects,`${nativeId}.jsonl`),JSON.stringify({type:'assistant',timestamp:now.toISOString(),
    message:{id:'mac-local-call',model:'claude-opus-5-5',usage:{input_tokens:17,cache_creation_input_tokens:0,
      cache_read_input_tokens:5,output_tokens:7}}})+'\n');
  const db=new Database(join(state,'state.db'));
  db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,agent_session_uuid TEXT,provider_id TEXT,native_metadata_json TEXT,last_turn_at TEXT);
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,provider_turn_id TEXT,provider_started_at TEXT,ended_at TEXT,
      saved_kind TEXT,saved_repeat_ms INTEGER,saved_root_id INTEGER,saved_sequence INTEGER,saved_fire_at_ms INTEGER,provider_duration_ms INTEGER);
    CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,turn_id INTEGER,kind TEXT,payload_json TEXT,created_at TEXT);
    CREATE TABLE saved_work_settings(singleton INTEGER PRIMARY KEY,time_zone TEXT);`);
  db.query('INSERT INTO sessions(id,agent_session_uuid,provider_id,native_metadata_json,last_turn_at) VALUES(1,?,?,?,?)')
    .run(nativeId,'claude-code',JSON.stringify({title:'Mac usage fixture',project:'/workspace/usage-fixture'}),started);
  db.query('INSERT INTO turns(id,session_id,status,provider_started_at) VALUES(1,1,?,?)').run('running',started);
  db.query('INSERT INTO session_owner_events VALUES(1,1,1,?,?,?)').run('account',JSON.stringify({account:'fixture@example.test'}),started);
  db.query('INSERT INTO saved_work_settings VALUES(1,?)').run('America/New_York');
  db.close();

  const reader=join(import.meta.dir,'usage-breakdown-reader.ts');
  const run=async(peer:string)=>{
    const env={...process.env,HOME:home,CONCIERGE_STATE_DIR:state,CONCIERGE_PEER_NAME:peer,
      USAGE_BREAKDOWN_LEDGER:join(state,'state.db'),USAGE_BREAKDOWN_CACHE:join(state,`${peer}-usage.db`)};
    delete env.CONCIERGE_TURN_RUNNER;delete env.CONCIERGE_CODEX_RUNNER;
    const child=spawn(process.execPath,[reader,'--both'],{env,stdio:['ignore','pipe','pipe']});
    let output='',error='';
    child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);
    child.stderr.setEncoding('utf8').on('data',chunk=>error+=chunk);
    const code=await new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('close',value=>resolve(value??-1));});
    return {code,output,error};
  };
  const mac=await run('mac');
  if(mac.code!==0)throw new Error(`Mac local usage scan failed: ${mac.error}`);
  const result=JSON.parse(mac.output);
  const account=result.today.accounts.find((value:any)=>value.account==='fixture@example.test');
  if(result.today.callMix.totalCalls!==1||account?.bySession?.[0]?.sessionId!==1)
    throw new Error('Mac local session history did not reach Who used it');
  const cloud=await run('cloud');
  if(cloud.code===0||!cloud.error.includes('NO_PROVIDER_USAGE_RUNNERS_CONFIGURED'))
    throw new Error('An unconfigured cloud owner silently used Mac local transcripts');

  const staleAt=new Date(Date.now()-60*60_000).toISOString();
  const latestPath=join(state,'usage-breakdown-latest.json');
  await writeFile(latestPath,JSON.stringify({computedAt:staleAt,both:{today:{period:'today',accounts:[]},week:{period:'week',accounts:[]}}}));
  process.env.HOME=home;process.env.CONCIERGE_STATE_DIR=state;process.env.CONCIERGE_PEER_NAME='mac';
  process.env.USAGE_BREAKDOWN_LEDGER=join(state,'state.db');process.env.USAGE_BREAKDOWN_CACHE=join(state,'mac-usage.db');
  delete process.env.CONCIERGE_TURN_RUNNER;delete process.env.CONCIERGE_CODEX_RUNNER;
  const {usageBreakdown}=await import('../src/usage-breakdown');
  const old=await usageBreakdown('today') as {computedAt:string;stale:boolean};
  if(!old.stale||old.computedAt!==staleAt)throw new Error('Old usage result was presented as current');
  let fresh=false;
  for(let attempt=0;attempt<100;attempt++){
    const published=JSON.parse(await readFile(latestPath,'utf8')) as {computedAt:string};
    if(published.computedAt!==staleAt){fresh=true;break;}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const current=await usageBreakdown('today') as {stale:boolean;callMix:{totalCalls:number}};
  if(!fresh||current.stale||current.callMix.totalCalls!==1)
    throw new Error('Mac local usage did not replace the stale published report');
  console.log('Mac peer local usage refreshed its session and marked old data stale; unconfigured cloud owner still refuses the scan');
}finally{await rm(root,{recursive:true,force:true});}
