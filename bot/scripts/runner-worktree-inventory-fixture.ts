/** Actual owner machine-call client/server and project handler; isolated Lab, identity and
 * transcript-home association stand in for the gateway, runner process and account credentials. */
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,openSync,writeSync,closeSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=mkdtempSync(join(tmpdir(),'runner-worktree-inventory-'));
process.env.CONCIERGE_STATE_DIR=scratch;process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_RUNNER_STATE=join(scratch,'runner');process.env.CONCIERGE_WORKSPACE_ROOT=join(scratch,'workspace');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION=IMPLEMENTATION_EDIT_GATE_TEST_AUTHORIZATION;
process.env.CONCIERGE_CODEX_RUNNER='fixture-runner';
const project=join(process.env.CONCIERGE_WORKSPACE_ROOT,'example-project');mkdirSync(project,{recursive:true});
writeFileSync(join(project,'AGENTS.md'),'Fixture project\n');
const git=(...args:string[])=>execFileSync('git',['-C',project,...args],{stdio:'pipe'});
git('init','--quiet');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','--quiet','-m','fixture');
const worktree=join(project,'.wt','linked-feature');git('worktree','add','--quiet','--detach',worktree,'HEAD');
writeFileSync(join(worktree,'dirty.txt'),'retained change\n');
const nativeId='01234567-89ab-cdef-0123-456789abcdef';
const transcript=join(scratch,`rollout-fixture-${nativeId}.jsonl`);
// Sparse filler keeps disk use low but requires the scanner to cross the former 64 MiB limit.
const fd=openSync(transcript,'w');
const transcriptBytes=119_714_180;
const finalRecord=Buffer.from(JSON.stringify({cwd:worktree})+'\n');
writeSync(fd,finalRecord,0,finalRecord.length,transcriptBytes-finalRecord.length);
closeSync(fd);
const labKey=join(scratch,'lab.key');writeFileSync(labKey,'fixture-key');process.env.THINKERING_AGENT_TEST_KEY_FILE=labKey;
const lab=Bun.serve({port:0,fetch:()=>Response.json({threads:[]})});process.env.THINKERING_ORIGIN_URL=`http://127.0.0.1:${lab.port}`;
if(process.argv.includes('--baseline')) {
  const original=execFileSync('git',['show','4abc40e5fe13ca31d4001958f644ad159ef56d29:bot/src/runner-projects.ts'],{cwd:join(import.meta.dir,'../..'),encoding:'utf8'});
  Bun.plugin({name:'original-project-handler',setup(builder){builder.onLoad({filter:/\/runner-projects\.ts$/},()=>({contents:original,loader:'ts'}));}});
}
const {serveProjectCall,referencedWorktreePaths}=await import('../src/runner-projects');
const {serveRunnerMachineCalls,runnerMachineCall,closeRunnerMachineCalls,RunnerMachineCallError}=await import('../src/runner-machine-calls');
const {db}=await import('../src/state');
const {createNativeSession,updateSessionMetadata,retainSessionInput,enqueueSessionInput,nativeRunId}=await import('../src/session-inputs');
const {handoffObligations,stageRecoveryHandoff,commitRecoveryHandoff}=await import('../src/session-handoff');
const answeringRunner={runnerName:'fixture-runner',implementationSha256:'fixture-implementation',helperSha256:'fixture-helpers'};
let mode='success';const calls:{method:string;params:any}[]=[];
const handler=async(method:string,params:any)=>{
  calls.push({method,params});
  if(mode==='resolution-error'&&method==='projects.resolve')throw Object.assign(new Error('Fixture project association missing'),{code:'PROJECT_ASSOCIATION'});
  if(mode==='parse-error'&&method==='projects.worktrees')return {items:null,transcriptAvailable:true};
  return serveProjectCall(method,params,{findProviderSessionHome:(_provider,account,id)=>{
    assert.equal(id,nativeId);assert.equal(account,'fixture-account');
    return mode==='transcript-error'?null:{account,home:scratch,transcript};
  }});
};
type Data={onmessage?:(event:{data:string})=>void};
const machine=Bun.serve<Data>({unix:join(scratch,'requests.sock'),
  fetch:(request,server)=>server.upgrade(request,{data:{}})?undefined:new Response('WebSocket required',{status:400}),
  websocket:{open(socket){
    const adapter={send:(text:string)=>socket.send(text),set onmessage(value:Data['onmessage']){socket.data.onmessage=value;}};
    serveRunnerMachineCalls(adapter as unknown as WebSocket,handler,answeringRunner);
  },message(socket,message){socket.data.onmessage?.({data:String(message)});}}});
try {
  const session=createNativeSession('codex',{title:'runner inventory fixture',purpose:'develop',origin:'native',cwd:project,
    project,projectName:'example-project',projectPath:'',providerAccount:'fixture-account',providerRunner:'fixture-runner',model:'gpt-6-astra',reasoningEffort:'medium'});
  db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(nativeId,session.id);
  const actor=retainSessionInput({id:'fixture-actor',sessionId:session.id,scope:'fixture',actionId:'actor',kind:'input',origin:'agent',payload:{text:'inspect inventory'}}).input;
  enqueueSessionInput(actor.id);const turnId=Number((db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(actor.id) as any).turn_id);
  db.query("UPDATE turns SET status='done' WHERE id=?").run(turnId);
  const source={inputId:actor.id,runId:nativeRunId(turnId)};
  const reminder=retainSessionInput({id:'fixture-reminder',sessionId:session.id,scope:'fixture',actionId:'reminder',kind:'request',origin:'service',requestId:'fixture-request',payload:{text:'retained reminder'}}).input;
  const preservedSource=join(scratch,'preserved-source.jsonl');writeFileSync(preservedSource,'retained source');
  const startRss=process.memoryUsage().rss;
  const positive=await handoffObligations(session.id,undefined,source);
  assert.deepEqual(positive.omissions,[]);
  assert.equal(positive.items.some(item=>item.kind==='worktree'&&item.ref===worktree&&Number(item.uncommittedFiles)>0),true);
  const rssGrowth=process.memoryUsage().rss-startRss;
  assert.ok(rssGrowth<64*1024*1024,`stream read grew RSS by ${rssGrowth} bytes`);
  console.log(JSON.stringify({case:'transcript-over-64MiB',scannedFileBytes:transcriptBytes,rssGrowthBytes:rssGrowth,verdict:'pass'}));
  assert.equal(calls.find(call=>call.method==='projects.worktrees')?.params.sessionUUID,nativeId);
  let observed:any=null;await runnerMachineCall('fixture-runner','projects.list',{},undefined,identity=>{observed=identity;});
  assert.deepEqual(observed,answeringRunner);
  // A path split at a stream boundary matches; a neighboring path with the same prefix does not.
  const boundary=join(scratch,'boundary.jsonl'),boundaryFd=openSync(boundary,'w');
  writeSync(boundaryFd,Buffer.from(`${worktree}-neighbor "${worktree}"`),0,Buffer.byteLength(`${worktree}-neighbor "${worktree}"`),64*1024-7);closeSync(boundaryFd);
  assert.deepEqual(await referencedWorktreePaths(boundary,[worktree,project]),[worktree]);
  writeFileSync(boundary,`${worktree}-neighbor`);assert.deepEqual(await referencedWorktreePaths(boundary,[worktree]),[]);
  writeFileSync(boundary,worktree);assert.deepEqual(await referencedWorktreePaths(boundary,[worktree]),[worktree]);
  for(const [failureMode,expectedPhase,message] of [
    ['resolution-error','project-resolution','Fixture project association missing'],
    ['transcript-error','runner-worktree-query','unavailable or ambiguous'],
    ['parse-error','worktree-response-parse','malformed projects.worktrees'],
  ]) {
    mode=failureMode!;
    const failed=await handoffObligations(session.id,undefined,source);
    assert.equal(failed.items.some(item=>item.kind==='worktree'),false);
    assert.equal(failed.omissions.length,1);
    const facts=JSON.parse(failed.omissions[0]!.slice('Runner worktree inventory failed: '.length));
    assert.equal(facts.phase,expectedPhase);assert.match(facts.error.message,new RegExp(message!));
    assert.equal(facts.runnerSelection,'metadata');assert.equal(facts.retainedRunner,'fixture-runner');
    assert.equal(facts.nativeConversationId,nativeId);assert.equal(facts.retainedAccount,'fixture-account');
    assert.deepEqual(facts.answeringRunner,answeringRunner);
    if(failureMode==='resolution-error')assert.equal(facts.error.code,'PROJECT_ASSOCIATION');
    if(failureMode==='transcript-error')assert.equal(facts.error.phase,'provider-transcript-resolution');
    await assert.rejects(()=>stageRecoveryHandoff({actorSession:session.id,...source,predecessorId:session.id,actionId:`refuse-${failureMode}`,
      reason:'fixture',selectedInputId:reminder.id,preservedSourcePath:preservedSource}),/unresolved omissions/);
    assert.equal((db.query('SELECT COUNT(*) AS n FROM session_handoffs WHERE predecessor_session_id=?').get(session.id) as any).n,0);
  }
  mode='success';
  // Omitted metadata selects the configured Codex runner; explicit null uses the original local path.
  updateSessionMetadata(session.id,{providerRunner:undefined});
  mode='parse-error';const fallback=await handoffObligations(session.id,undefined,source);
  const fallbackFacts=JSON.parse(fallback.omissions[0]!.slice('Runner worktree inventory failed: '.length));
  assert.equal(fallbackFacts.runnerSelection,'codex-config-fallback');assert.equal(fallbackFacts.retainedRunner,'undefined');
  updateSessionMetadata(session.id,{providerRunner:null});const before=calls.length;
  await handoffObligations(session.id,undefined,source);assert.equal(calls.length,before,'explicit null cannot fall back to the configured runner');
  // A previously staged inventory must still refuse commitment when the current runner response fails.
  mode='success';updateSessionMetadata(session.id,{providerRunner:'fixture-runner'});
  const staged=await stageRecoveryHandoff({actorSession:session.id,...source,predecessorId:session.id,actionId:'stage',reason:'fixture',selectedInputId:reminder.id,preservedSourcePath:preservedSource});
  const successorId=Number(staged.successor.split(':')[1]);
  const placement=retainSessionInput({id:'fixture-placement',sessionId:successorId,scope:`custody:${reminder.id}`,actionId:'placement',kind:'input',origin:'service',payload:{text:'retained reminder'}}).input;
  const placementTurn=Number((db.query("INSERT INTO turns(session_id,user_text,status,turn_kind,accepted_input_id) VALUES(?,'retained reminder','queued','native',?) RETURNING id").get(successorId,placement.id) as any).id);
  db.query('UPDATE session_inputs SET turn_id=? WHERE id=?').run(placementTurn,placement.id);
  db.query(`INSERT INTO codex_custody_successors(canonical_input_id,predecessor_session_id,successor_session_id,handoff_id,placement_input_id,placement_turn_id,request_id,source_input_id,source_run_id,state,plan_json,snapshot_json)
    VALUES(?,?,?,?,?,?,?,?,?,'staged','{}',?)`).run(reminder.id,session.id,successorId,staged.handoffId,placement.id,placementTurn,'fixture-request',actor.id,source.runId,JSON.stringify({path:preservedSource}));
  mode='parse-error';
  await assert.rejects(()=>commitRecoveryHandoff({actorSession:session.id,...source,handoffId:staged.handoffId,digest:staged.digest,placementInputId:placement.id,placementTurnId:placementTurn,validateAuthority:()=>{}}),/unresolved omissions/);
  assert.equal((db.query('SELECT state FROM session_handoffs WHERE id=?').get(staged.handoffId) as any).state,'proposed');
  assert.equal((db.query('SELECT state FROM codex_custody_successors WHERE canonical_input_id=?').get(reminder.id) as any).state,'staged');
  assert.equal((db.query('SELECT agent_session_uuid FROM sessions WHERE id=?').get(successorId) as any).agent_session_uuid,null);
  assert.equal((db.query('SELECT status FROM turns WHERE id=?').get(placementTurn) as any).status,'queued');
  mode='transcript-error';
  await assert.rejects(()=>runnerMachineCall('fixture-runner','projects.worktrees',{project:'example-project',provider:'codex',sessionUUID:nativeId,account:'fixture-account'}),
    error=>error instanceof RunnerMachineCallError&&error.phase==='provider-transcript-resolution'&&error.answeringRunner?.implementationSha256==='fixture-implementation');
  console.log('runner-worktree-inventory fixture passed: streaming exact conversation, real machine call/project handler, phase/code/implementation retention, null-vs-undefined, resolution/parse refusal before custody commitment');
} finally {closeRunnerMachineCalls();machine.stop(true);lab.stop(true);db.close();rmSync(scratch,{recursive:true,force:true});}
