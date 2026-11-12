import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureUsageLedgerSnapshot,encodeUsageSnapshot} from '../src/usage-breakdown-ledger-snapshot';
import {collectRunnerUsageReports} from '../src/provider-usage-report-client';
import {serveProviderUsageBreakdownCall} from '../src/runner-provider-usage-breakdown';

const root=await mkdtemp(join(tmpdir(),'provider-usage-report-check-'));
try{
  const home=join(root,'provider-home'),projects=join(home,'projects','-usage-fixture');
  const nativeId='0192a345-6789-7abc-8def-0123456789ab';
  const secondHome=join(root,'second-home'),secondProjects=join(secondHome,'projects','-usage-fixture');
  const secondNativeId='0192a345-6789-7abc-8def-0123456789ac';
  await mkdir(projects,{recursive:true});
  await mkdir(secondProjects,{recursive:true});
  const count=Number(process.env.USAGE_REPORT_FIXTURE_ROWS??2001),at=new Date().toISOString();
  const lines=Array.from({length:count},(_,index)=>JSON.stringify({type:'assistant',timestamp:at,
    message:{id:`record-${index}`,model:'claude-opus-5-5',usage:{input_tokens:17,cache_creation_input_tokens:0,
      cache_read_input_tokens:5,output_tokens:7}}})).join('\n')+'\n';
  await writeFile(join(projects,`${nativeId}.jsonl`),lines);
  await writeFile(join(secondProjects,`${secondNativeId}.jsonl`),lines.split('\n').slice(0,3).join('\n')+'\n');
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,agent_session_uuid TEXT,provider_id TEXT,native_metadata_json TEXT,last_turn_at TEXT);
    CREATE TABLE turns(id INTEGER PRIMARY KEY,session_id INTEGER,status TEXT,provider_turn_id TEXT,provider_started_at TEXT,ended_at TEXT,
      saved_kind TEXT,saved_repeat_ms INTEGER,saved_root_id INTEGER,saved_sequence INTEGER,saved_fire_at_ms INTEGER,provider_duration_ms INTEGER,accepted_input_id TEXT);
    CREATE TABLE session_communication_requests(target_input_id TEXT,topic_root_input_id TEXT,thread_root_input_id TEXT,created_at_ms INTEGER);
    CREATE TABLE inbox_topic_roots(root_input_id TEXT PRIMARY KEY,topic_id TEXT);
    CREATE TABLE session_owner_events(sequence INTEGER PRIMARY KEY,session_id INTEGER,turn_id INTEGER,kind TEXT,payload_json TEXT,created_at TEXT,input_id TEXT);
    CREATE TABLE saved_work_settings(singleton INTEGER PRIMARY KEY,time_zone TEXT);`);
  const started=new Date(Date.now()-60_000).toISOString().slice(0,19).replace('T',' ');
  db.query('INSERT INTO sessions(id,agent_session_uuid,provider_id,native_metadata_json) VALUES(1,?,?,?)').run(nativeId,'claude-code',JSON.stringify({title:'Usage fixture',project:'/workspace/usage-fixture'}));
  db.query('INSERT INTO turns(id,session_id,status,provider_started_at,accepted_input_id) VALUES(1,1,?,?,?)').run('running',started,'request:one');
  db.query('INSERT INTO session_owner_events(sequence,session_id,turn_id,kind,payload_json,created_at) VALUES(1,1,1,?,?,?)').run('account',JSON.stringify({account:'fixture@example.test'}),started);
  db.query('INSERT INTO sessions(id,agent_session_uuid,provider_id,native_metadata_json) VALUES(2,?,?,?)').run(secondNativeId,'claude-code',JSON.stringify({title:'Second fixture',project:'/workspace/usage-fixture'}));
  db.query('INSERT INTO turns(id,session_id,status,provider_started_at,accepted_input_id) VALUES(2,2,?,?,?)').run('running',started,'request:two');
  db.query('INSERT INTO inbox_topic_roots VALUES(?,?)').run('capture:shared','topic:shared');
  db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?)').run('request:one','capture:shared',null,Date.now());
  db.query('INSERT INTO session_communication_requests VALUES(?,?,?,?)').run('request:two','capture:shared',null,Date.now());
  db.query('INSERT INTO session_owner_events(sequence,session_id,turn_id,kind,payload_json,created_at) VALUES(2,2,2,?,?,?)').run('account',JSON.stringify({account:'second@example.test'}),started);
  db.query('INSERT INTO saved_work_settings VALUES(1,?)').run('America/New_York');
  const snapshot=encodeUsageSnapshot(captureUsageLedgerSnapshot(db,Date.now()-7*86400_000));db.close();
  let calls=0;
  const result=await collectRunnerUsageReports(new Map([['fixture',new Set(['claude-code' as const])],['second',new Set(['claude-code' as const])]]),snapshot,
    async(runner,method,params)=>{
      calls++;
      if(method!=='provider-usage-breakdown.report')throw new Error(`raw record page requested: ${method}`);
      const selected=runner==='fixture'?{account:'fixture@example.test',home}:{account:'second@example.test',home:secondHome};
      return serveProviderUsageBreakdownCall(method,params,join(root,runner),()=>[selected]);
    });
  const account=result.week.accounts.find((value:any)=>value.account==='fixture@example.test');
  const other=result.week.accounts.find((value:any)=>value.account==='second@example.test');
  if(calls!==2||result.week.callMix.totalCalls!==count+3||account?.bySession?.[0]?.sessionId!==1
    ||account?.callMix.totalCalls!==count||result.week.cacheDiagnostics.callCount!==count+3
    ||other?.bySession?.[0]?.sessionId!==2||other?.callMix.totalCalls!==3
    ||result.week.cacheDiagnostics.calls.length>100||result.week.cacheDiagnostics.turns[0]?.turnId!==1
    ||result.week.attributionBuckets.length!==2
    ||result.week.attributionBuckets.some((bucket:any)=>bucket.topicId!=='topic:shared'))
    throw new Error('bounded report lost account, session, call mix or cache diagnostics');
  console.log(`two runner report calls returned ${count+3} attributed calls with bounded diagnostics`);
}finally{await rm(root,{recursive:true,force:true});}
