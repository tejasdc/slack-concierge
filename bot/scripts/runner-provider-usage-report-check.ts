import {Database} from 'bun:sqlite';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
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
    message:{id:`record-${index}`,model:'claude-fable-5-2',content:index===0
      ?[{type:'tool_use',id:'edit-main',name:'Edit',input:{file_path:'example.ts'}},
        {type:'tool_use',id:'read-main',name:'Read',input:{file_path:'example.ts'}}]:[],
      usage:{input_tokens:17,cache_creation_input_tokens:0,
      cache_read_input_tokens:5,output_tokens:7}}})).join('\n')+'\n';
  await writeFile(join(projects,`${nativeId}.jsonl`),lines);
  const mirroredProjects=join(home,'projects','-mirrored-usage-fixture');
  await mkdir(mirroredProjects,{recursive:true});
  await writeFile(join(mirroredProjects,`${nativeId}.jsonl`),JSON.stringify({type:'assistant',timestamp:at,
    message:{id:'mirrored-record',model:'claude-opus-5-5',content:[{type:'tool_use',id:'edit-main',name:'Edit',input:{file_path:'example.ts'}}]}})+'\n');
  const helpers=join(projects,nativeId,'subagents');await mkdir(helpers,{recursive:true});
  await writeFile(join(helpers,'agent-fixture.jsonl'),JSON.stringify({type:'assistant',timestamp:at,
    message:{id:'helper-record',model:'claude-sonnet-5-5',content:[{type:'tool_use',id:'edit-helper',name:'Write',input:{file_path:'helper.ts'}}],
      usage:{input_tokens:3,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:2}}})+'\n');
  await writeFile(join(secondProjects,`${secondNativeId}.jsonl`),lines.split('\n').slice(0,3).join('\n')+'\n');
  const web=(id:string)=>JSON.stringify({type:'assistant',timestamp:at,message:{id,model:'claude-opus-5-5',
    content:[{type:'tool_use',id,name:'WebSearch',input:{}}]}})+'\n';
  await writeFile(join(projects,`${nativeId}.jsonl`),lines+web('web-first'));
  await writeFile(join(secondProjects,`${nativeId}.jsonl`),web('web-second'));
  await writeFile(join(secondProjects,`${secondNativeId}.jsonl`),lines.split('\n').slice(0,3).join('\n')+'\n'+web('web-other'));
  await writeFile(join(secondProjects,'0192a345-6789-7abc-8def-0123456789ad.jsonl'),web('web-unattributed'));
  // Server account homes link their transcript folder to one shared folder.
  const linkedHome=join(root,'linked-home');await mkdir(linkedHome,{recursive:true});
  await symlink(join(home,'projects'),join(linkedHome,'projects'));
  // A real copy of one conversation under another folder of the same runner.
  const copiedProjects=join(root,'copy-home','projects','-usage-fixture');await mkdir(copiedProjects,{recursive:true});
  await writeFile(join(copiedProjects,`${nativeId}.jsonl`),lines.split('\n').slice(1,5).join('\n')+'\n');
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
  const old=new Date(Date.now()-9*86400_000).toISOString().slice(0,19).replace('T',' ');
  const escalation=db.query('INSERT INTO session_owner_events(sequence,session_id,turn_id,kind,payload_json,created_at) VALUES(?,?,NULL,?,?,?)');
  escalation.run(3,1,'model_escalation',JSON.stringify({model:'claude-fable-5-2'}),old);
  escalation.run(4,2,'model_escalation',JSON.stringify({model:'gpt-6-astra'}),old);
  escalation.run(5,2,'model_escalation',JSON.stringify({model:'gpt-6-astra'}),started);
  db.query('INSERT INTO saved_work_settings VALUES(1,?)').run('America/New_York');
  const captured=captureUsageLedgerSnapshot(db,Date.now()-7*86400_000);
  if(!captured.events.some(row=>row.sequence===3))throw new Error('snapshot lost prior session authorization');
  const snapshot=encodeUsageSnapshot(captured);db.close();
  let calls=0;
  const result=await collectRunnerUsageReports(new Map([['fixture',new Set(['claude-code' as const])],['second',new Set(['claude-code' as const])]]),snapshot,
    async(runner,method,params)=>{
      calls++;
      if(method!=='provider-usage-breakdown.report')throw new Error(`raw record page requested: ${method}`);
      const selected=runner==='fixture'?{account:'fixture@example.test',home}:{account:'second@example.test',home:secondHome};
      return serveProviderUsageBreakdownCall(method,params,join(root,runner),()=>runner==='fixture'
        ?[selected,{account:'linked@example.test',home:linkedHome},{account:'copy@example.test',home:join(root,'copy-home')}]:[selected]);
    });
  const account=result.week.accounts.find((value:any)=>value.account==='fixture@example.test');
  const other=result.week.accounts.find((value:any)=>value.account==='second@example.test');
  if(result.week.escalations.count!==1||result.week.escalations.byModel['gpt-6-astra']!==1
    ||result.week.escalations.unexplainedCalls!==3||account?.bySession?.[0]?.unexplainedTopModelCalls!==0
    ||other?.bySession?.[0]?.unexplainedTopModelCalls!==3)
    throw new Error('prior session/model authorization did not explain only its own calls without a new escalation');
  if(calls!==2||result.week.callMix.totalCalls!==count+4||account?.bySession?.[0]?.sessionId!==1
    ||account?.callMix.totalCalls!==count+1||result.week.cacheDiagnostics.callCount!==count+4
    ||other?.bySession?.[0]?.sessionId!==2||other?.callMix.totalCalls!==3
    ||result.week.editMix.totalEdits!==3||result.week.editMix.helperEdits!==1
    ||account?.bySession?.[0]?.editMix?.totalEdits!==2
    ||account?.bySession?.[0]?.editMix?.byModel?.find((model:any)=>model.model==='claude-sonnet-5-5')?.helperEdits!==1
    ||other?.bySession?.[0]?.editMix?.mainEdits!==1
    ||result.week.directTopModelWeb.total!==4
    ||result.week.directTopModelWeb.bySession.length!==2
    ||result.week.directTopModelWeb.bySession.find((row:any)=>row.sessionId===1)?.calls!==2
    ||result.week.directTopModelWeb.bySession.find((row:any)=>row.sessionId===2)?.calls!==1
    ||result.week.cacheDiagnostics.calls.length>100||result.week.cacheDiagnostics.turns[0]?.turnId!==1
    ||result.week.attributionBuckets.length!==4
    ||result.week.attributionBuckets.some((bucket:any)=>bucket.topicId!=='topic:shared'))
    throw new Error('bounded report lost account, session, call mix or cache diagnostics');
  console.log(`two runner report calls returned ${count+4} attributed calls and split edit counts with bounded diagnostics`);
}finally{await rm(root,{recursive:true,force:true});}
