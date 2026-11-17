/** Exercise the source-bound repair-home command against a controlled runner transport. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import * as os from 'node:os';
import {mkdirSync,writeFileSync} from 'node:fs';
import {mock} from 'bun:test';

const state=await mkdtemp(join(os.tmpdir(),'concierge-native-home-repair-'));
const workspace=join(state,'workspace'),projectRoot=join(workspace,'life-logistics'),privateHome=join(state,'provider-home');
mkdirSync(privateHome,{recursive:true});
mkdirSync(join(projectRoot,'.git'),{recursive:true});writeFileSync(join(projectRoot,'AGENTS.md'),'fixture project');
process.env.CONCIERGE_STATE_DIR=state;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(state,'capture');
process.env.CONCIERGE_TEST_MODE='1';
mock.module('node:os',()=>({...os,homedir:()=>privateHome}));
const {NATIVE_HOME_REPAIR_TEST_AUTHORIZATION}=await import('../src/test-authorizations');
process.env.CONCIERGE_TEST_AUTHORIZATION=NATIVE_HOME_REPAIR_TEST_AUTHORIZATION;
let resolution:'unique'|'shared'|'missing'|'ambiguous'='unique';
let unavailable=false,mutateAtStat:(()=>void)|null=null;
let raceMode:'success-first'|'failure-first'|null=null,statCalls=0;
let firstProofStarted:(()=>void)|null=null,secondProofStarted:(()=>void)|null=null,releaseFirstProof:(()=>void)|null=null,releaseSecondProof:(()=>void)|null=null;
mock.module('../src/runner-machine-calls',()=>({
  RunnerUnreachableError:class RunnerUnreachableError extends Error{},
  RunnerCallNotSentError:class RunnerCallNotSentError extends Error{},
  RunnerMachineCallError:class RunnerMachineCallError extends Error{},
  runnerMachineCall:async(_runner:string,method:string,params:any)=>{
  if(unavailable)throw new Error('fixture runner unreachable');
  if(method==='projects.locate')return {project:'life-logistics',path:'',cwd:projectRoot};
  if(method==='accounts.transcript')return {account:resolution==='unique'?'writer@example.com':null,resolution};
  if(method==='accounts.validate')return {available:params.account==='writer@example.com'};
  if(method==='provider-history.claude.transcript.stat'){
    if(raceMode){
      const call=++statCalls;
      if(call===1)firstProofStarted?.();
      if(call===2)secondProofStarted?.();
      if(raceMode==='success-first'&&call===2){await new Promise<void>(resolve=>releaseSecondProof=resolve);throw new Error('the duplicate proof failed late');}
      if(raceMode==='failure-first'&&call===1){await new Promise<void>(resolve=>releaseFirstProof=resolve);return {sourceIdentity:'a'.repeat(64),size:1234,mtimeMs:1};}
      if(raceMode==='failure-first'&&call===2)throw new Error('the duplicate proof failed first');
    }
    mutateAtStat?.();mutateAtStat=null;return {sourceIdentity:'a'.repeat(64),size:1234,mtimeMs:1};
  }
  throw new Error(`unexpected fixture runner method ${method}`);
}}));

const [{db,getSessionById,claimNextQueuedTurn,markTurnProviderAdmissionIntended,acknowledgeTurnProviderInput},
  {createNativeSession,bindSessionProvider,retainSessionInput,enqueueSessionInput,nativeRunId,sessionMetadata,updateSessionMetadata},
  {SessionOwner,sessionAddress},{SessionCommunicationCoordinator},{requestApiHandler},{parseRouterSessionsArgs}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/session-owner'),import('../src/session-communication'),
  import('../src/routed-request-api'),import('./router-sessions')]);
const owner=new SessionOwner({available:()=>true,wake(){},steer(){return false},async stop(){return false}} as any,workspace);
const communication=new SessionCommunicationCoordinator({owner,isOwnerAlive:()=>true,onError:error=>{throw error;}});
owner.communication=communication;communication.start();
const route=requestApiHandler(null,null,communication,owner);
const actorSession=createNativeSession('codex',{title:'Fixture repair actor',summary:undefined});
const sourceInput=retainSessionInput({sessionId:actorSession.id,scope:'fixture',actionId:'actor-work',kind:'input',origin:'human',payload:{text:'Repair the fixture home.'}}).input;
enqueueSessionInput(sourceInput.id);
const claim=claimNextQueuedTurn('native-home-repair-fixture')!;
assert.ok(claim);
assert.equal(markTurnProviderAdmissionIntended(claim.turn_id,'native-home-repair-fixture',claim.dispatch_attempt),true);
acknowledgeTurnProviderInput(claim.turn_id,'native-home-repair-fixture',claim.dispatch_attempt,[]);
const source={input_id:sourceInput.id,run_id:nativeRunId(claim.turn_id)};
const createTarget=(action:string)=>{
  const target=createNativeSession('claude-code',{title:`Fixture ${action}`,summary:undefined,projectName:'life-logistics',projectPath:'',cwd:projectRoot,claudeAccount:'writer@example.com'});
  bindSessionProvider(target.id,'claude-code',`12345678-1234-4123-8123-${String(target.id).padStart(12,'0')}`);
  return getSessionById(target.id)!;
};
const invoke=async(target:any,action:string,project='life-logistics')=>{
  const parsed=parseRouterSessionsArgs(['repair-home',sessionAddress(target),'--runner','ax41','--project',project,
    '--source-input',source.input_id,'--source-run',source.run_id,'--action-id',action]);
  assert.equal(parsed.operation,'repair-home');
  const response=await route(new Request('http://owner/session-communication/repair-home',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(parsed.body)}));
  return {status:response.status,body:await response.json() as any};
};
try{
  const target=createTarget('success');
  const beforeView=owner.view(target);
  assert.equal(beforeView.messageableForAgents,false,'an unbound native UUID is not advertised as agent-messageable');
  assert.equal(beforeView.capabilities.send,true,'the human composer remains writable while home is unknown');
  const beforeRequests=(db.query('SELECT count(*) AS n FROM session_communication_requests WHERE target_session_id=?').get(target.id) as {n:number}).n;
  await assert.rejects(()=>communication.ask({source,action_id:'ask-before-repair',address:sessionAddress(target),requestedEffect:'informational',text:'Do not admit work without a known home.'}),
    /not currently messageable|home/i,'the real communication ask path refuses before admission');
  assert.equal((db.query('SELECT count(*) AS n FROM session_communication_requests WHERE target_session_id=?').get(target.id) as {n:number}).n,beforeRequests);
  const first=await invoke(target,'repair-success'),duplicate=await invoke(target,'repair-success');
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.home,'ax41');
  assert.equal(first.body.evidence.uuid,target.agent_session_uuid);
  assert.equal(first.body.evidence.transcriptResolution,'unique');
  assert.equal(first.body.evidence.account,'writer@example.com');
  assert.equal(first.body.evidence.authorityInputId,source.input_id);
  assert.deepEqual(duplicate.body,first.body,'a same-action retry returns the exact saved result');
  assert.equal(sessionMetadata(getSessionById(target.id)!).providerRunner,'ax41');
  assert.equal(owner.view(getSessionById(target.id)!).messageableForAgents,true);
  assert.equal(owner.view(getSessionById(target.id)!).capabilities.send,true);
  await communication.ask({source,action_id:'ask-after-repair',address:sessionAddress(getSessionById(target.id)!),requestedEffect:'informational',text:'Read the repaired native conversation.'});
  assert.equal((db.query('SELECT count(*) AS n FROM session_communication_requests WHERE target_session_id=?').get(target.id) as {n:number}).n,beforeRequests+1,
    'a fresh informational ask is admitted after the exact home has been repaired');
  assert.equal(db.query("SELECT count(*) AS n FROM session_owner_events WHERE session_id=? AND kind='native_home_repaired'").get(target.id)?.n,1);
  assert.equal((await invoke(target,'repair-success','another-project')).status,400,'a changed payload conflicts with the retained action');

  for(const mode of ['success-first','failure-first'] as const){
    raceMode=mode;statCalls=0;const concurrent=createTarget(mode);
    let firstStartedResolve!:()=>void,secondStartedResolve!:()=>void;
    const firstStarted=new Promise<void>(resolve=>firstStartedResolve=resolve),secondStarted=new Promise<void>(resolve=>secondStartedResolve=resolve);
    firstProofStarted=firstStartedResolve;secondProofStarted=secondStartedResolve;
    let first:Promise<{status:number;body:any}>,second:Promise<{status:number;body:any}>;
    if(mode==='success-first'){
      first=invoke(concurrent,`repair-${mode}`);second=invoke(concurrent,`repair-${mode}`);
      await secondStarted;const firstResult=await first;assert.equal(firstResult.status,200);
      releaseSecondProof?.();
    }else{
      first=invoke(concurrent,`repair-${mode}`);await firstStarted;
      second=invoke(concurrent,`repair-${mode}`);const failedFirst=await second;assert.notEqual(failedFirst.status,200);
      releaseFirstProof?.();
    }
    const pair=[await first,await second];
    const saved=sessionMetadata(getSessionById(concurrent.id)!);
    if(mode==='success-first'){
      assert.deepEqual(pair[0].body,pair[1].body,'a late failed duplicate cannot overwrite the first successful result');
      assert.equal(saved.providerRunner,'ax41');
    }else{
      assert.equal(Object.hasOwn(saved,'providerRunner'),false,'a later successful proof cannot replace the first failed terminal result');
      assert.ok(pair.every(result=>result.status!==200));
    }
    raceMode=null;firstProofStarted=null;secondProofStarted=null;releaseFirstProof=null;releaseSecondProof=null;
  }

  for(const mode of ['missing','ambiguous'] as const){
    resolution=mode;const refused=createTarget(mode),result=await invoke(refused,`repair-${mode}`);
    assert.notEqual(result.status,200,`${mode} transcript must refuse`);
    assert.equal(Object.hasOwn(sessionMetadata(getSessionById(refused.id)!), 'providerRunner'),false);
  }
  resolution='unique';unavailable=true;
  const unreachable=createTarget('unreachable'),unreachableResult=await invoke(unreachable,'repair-unreachable');
  assert.notEqual(unreachableResult.status,200);
  assert.equal(Object.hasOwn(sessionMetadata(getSessionById(unreachable.id)!), 'providerRunner'),false);
  const moveUnknown=parseRouterSessionsArgs(['move',sessionAddress(unreachable),'--project','life-logistics','--source-input',source.input_id,
    '--source-run',source.run_id,'--action-id','move-unknown']);
  const moveRefused=await route(new Request('http://owner/session-communication/move',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(moveUnknown.body)}));
  assert.notEqual(moveRefused.status,200,'a move cannot guess the home of an unknown native UUID');
  assert.equal(Object.hasOwn(sessionMetadata(getSessionById(unreachable.id)!), 'providerRunner'),false);
  unavailable=false;

  const stale=createTarget('stale');
  mutateAtStat=()=>updateSessionMetadata(stale.id,{suspended:true});
  const staleResult=await invoke(stale,'repair-stale');
  assert.notEqual(staleResult.status,200,'state changed during async proof must refuse');
  assert.equal(Object.hasOwn(sessionMetadata(getSessionById(stale.id)!), 'providerRunner'),false);

  const local=createTarget('local'),localMeta=sessionMetadata(local),localUuid=local.agent_session_uuid!;
  const localDir=join(privateHome,'.claude','projects',projectRoot.replace(/[^a-zA-Z0-9]/g,'-')),localFile=join(localDir,`${localUuid}.jsonl`);
  mkdirSync(localDir,{recursive:true});
  {
    writeFileSync(localFile,JSON.stringify({sessionId:localUuid,uuid:localUuid})+'\n');
    const localParsed=parseRouterSessionsArgs(['repair-home',sessionAddress(local),'--local','--project','life-logistics',
      '--source-input',source.input_id,'--source-run',source.run_id,'--action-id','repair-local']);
    const localResponse=await route(new Request('http://owner/session-communication/repair-home',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(localParsed.body)}));
    const localResult=await localResponse.json() as any;
    assert.equal(localResponse.status,200,JSON.stringify(localResult));
    const savedLocal=sessionMetadata(getSessionById(local.id)!);
    assert.equal(Object.hasOwn(savedLocal,'providerRunner'),true,'local custody is pinned explicitly');
    assert.equal(savedLocal.providerRunner,null);
    assert.equal(Object.hasOwn(localMeta,'providerRunner'),false,'fixture began without a saved local home');
    mkdirSync(join(projectRoot,'moved'),{recursive:true});
    const moved=await owner.prepareSessionProjectLocation(getSessionById(local.id)!,'life-logistics/moved');
    assert.equal(moved.runner,null,'explicit local home resolves project moves locally');
    owner.moveSession(local.id,'life-logistics/moved',moved);
    assert.equal(sessionMetadata(getSessionById(local.id)!).providerRunner,null,'a project move preserves the explicit local binding');
  }
  console.log('native home repair: command boundary, source authority, runner/local proof, refusal, move fence, both terminal races, idempotency, and agent-messageability fixture passed');
}finally{await communication.stop();await rm(state,{recursive:true,force:true});}
