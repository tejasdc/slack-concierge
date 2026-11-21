import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {INBOX_SESSION_PIN_TEST_AUTHORIZATION} from '../src/test-authorizations';

const scratch=process.env.CONCIERGE_PIN_FIXTURE_ROOT??mkdtempSync(join(tmpdir(),'concierge-inbox-pin-'));
if(!process.env.CONCIERGE_PIN_FIXTURE_ROOT){
  mkdirSync(join(scratch,'home'),{recursive:true});
  const result=spawnSync(process.execPath,[Bun.main],{env:{...process.env,HOME:join(scratch,'home'),CONCIERGE_PIN_FIXTURE_ROOT:scratch},stdio:'inherit'});
  rmSync(scratch,{recursive:true,force:true});process.exit(result.status??1);
}
process.env.HOME=join(scratch,'home');
process.env.CONCIERGE_STATE_DIR=join(scratch,'state');
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(scratch,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=INBOX_SESSION_PIN_TEST_AUTHORIZATION;
process.env.CONCIERGE_PEER_NAME='mac'; // No Lab network read in disposable handoff inventory.
process.env.THINKERING_AGENT_TEST_KEY_FILE=join(scratch,'absent-key');
process.env.CONCIERGE_TURN_RUNNERS='marked';

const [{db,getSessionById,claimNextQueuedTurn},inputs,pin,roles,handoff,{SessionOwner},{maybeStartStandingRoleFailover},
  {transferSession},{chooseAccountForTurn},{sharedClaudeHome,chooseClaudeDispatch,claudeAccountWithRoomBesides,markClaudeHomeVerified},
  {selectClaudeAccount},{usageAttempt,recordUsageExhaustion,cachedUsageLimit},{forgetAccountFiles},{runClaudeCodeTurn},
  {ProviderDispatchError,providerRefusalContinuationReason},{executeAgentTurn},{TurnSteeringController}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/inbox-session-pin'),import('../src/standing-agents'),
  import('../src/session-handoff'),import('../src/session-owner'),import('../src/standing-role-provider-failover'),
  import('../src/provider-exhaustion-recovery'),import('../src/provider-account-choice'),import('../src/provider-account-dispatch'),
  import('../src/provider-account-selection'),import('../src/provider-usage'),import('../src/account-files-memo'),
  import('../src/claude-code'),import('../src/provider-failures'),import('../src/turn-execution'),import('../src/steering')]);

try {
  const router=inputs.createNativeSession('claude-code',{title:'Inbox',summary:'Pinned router',inbox:true,inboxRole:'project-router',standingRole:'inbox'});
  inputs.bindSessionProvider(router.id,'claude-code','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const human=(id:string,text:string)=>inputs.retainSessionInput({id,sessionId:router.id,scope:'surface:thinkering',actionId:id,
    kind:'input',origin:'human',payload:{text}}).input;
  const original=human('pin-human','Keep my Inbox router pinned to a session in Claude Code. A single session all the time, unless I specifically ask you to. Shut off all the automatic ways to switch to a Codex session.');
  const agent=inputs.retainSessionInput({id:'pin-agent',sessionId:router.id,scope:'fixture',actionId:'agent',kind:'input',origin:'agent',
    payload:{text:'Move my Inbox router to Codex.'},sourceInputId:original.id}).input;
  for(const source of [undefined,agent.id,original.id])assert.equal(pin.humanAuthorizedInboxMove(source,{provider:'codex'}),false);
  for(const [id,text] of [['negative','Do not move Inbox to Codex.'],['conditional','Move Inbox to Codex if Claude is full.'],
    ['question','Move Inbox to Codex?'],['quote','The agent said: move Inbox to Codex.'],['other-work','Use Codex to repair Inbox.']]){
    assert.equal(pin.humanAuthorizedInboxMove(human(id!,text!).id,{provider:'codex'}),false,text);
  }
  assert.equal(pin.humanAuthorizedInboxMove(human('polite','Hey, can you switch my Inbox to Codex?').id,{provider:'codex'}),true);
  assert.equal(pin.humanAuthorizedInboxMove(human('polite-conditional','Could you move my Inbox to Codex if Claude fills?').id,{provider:'codex'}),false);
  const target=inputs.createNativeSession('codex',{title:'Other session',summary:'An unbound fork may exist',providerRunner:'fixture',projectName:'slack-inbox',projectPath:''});
  assert.throws(()=>roles.takeInboxRouterRole(target.id,inputs.sessionMetadata(router),agent.id),/Inbox stays/);
  assert.throws(()=>inputs.updateSessionMetadata(router.id,{standingRole:null}),/Inbox stays/);
  assert.throws(()=>inputs.updateSessionMetadata(target.id,{standingRole:'inbox'}),/Inbox stays/);
  assert.throws(()=>inputs.createNativeSession('codex',{title:'Replacement',summary:'Forbidden automatic replacement',standingRole:'inbox'}),/Inbox stays/);
  assert.throws(()=>inputs.bindSessionProvider(router.id,'claude-code','ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'),/Inbox stays/);
  await assert.rejects(handoff.proposeHandoff({actorSession:router.id,inputId:agent.id,runId:'fixture-run',predecessorId:router.id,
    provider:'codex',reason:'Claude exhausted',actionId:'agent-move'}),/Inbox stays/);
  const count=()=>Number((db.query('SELECT count(*) AS count FROM sessions').get() as any).count);
  const before=count();
  const queued=inputs.enqueueSessionInput(original.id);
  db.query("UPDATE turns SET dispatch_hold='usage',dispatch_failure_class='usage_wait' WHERE id=?").run(queued.turn_id);
  maybeStartStandingRoleFailover(getSessionById(router.id));
  assert.equal(transferSession(router.id),0);
  const owner=new SessionOwner({available:()=>true,wake:()=>{},stop:async()=>false,steer:()=>false},scratch);
  assert.equal((owner.inbox() as any).session.id,`concierge:${router.id}`);
  assert.equal(count(),before,'held work does not create another router');
  assert.equal(inputs.getAcceptedSessionInput(original.id)?.session_id,router.id,'exact queued input stays');

  // Account choice operates below the conversation: three homes share the same transcript.
  const shared=join(process.env.HOME!,'.claude');
  mkdirSync(join(shared,'projects'),{recursive:true});
  writeFileSync(join(shared,'projects','transcript.jsonl'),'retained conversation');
  const rooms=['one','two','three'].map((account,index)=>{
    const home=join(process.env.HOME!,'.claude-accounts',account);
    mkdirSync(home,{recursive:true});writeFileSync(join(home,'.credentials.json'),JSON.stringify({claudeAiOauth:{refreshToken:`fixture-${account}`}}));
    writeFileSync(join(home,'.account-email'),account);
    assert.equal(sharedClaudeHome(account,home,true),home);
    assert.equal(realpathSync(join(home,'projects')),realpathSync(join(shared,'projects')));
    markClaudeHomeVerified(home);
    return {account,home,tightestUsedPercent:index===0?100:10,weeklyUsedPercent:index===0?100:10,isDefault:false,problem:null};
  });
  const picked=chooseAccountForTurn({accounts:rooms,bound:null,prefer:'one'});
  assert.ok(picked.account&&picked.account!=='one');
  assert.equal(chooseAccountForTurn({accounts:rooms.map(room=>({...room,tightestUsedPercent:100,weeklyUsedPercent:100})),bound:null,prefer:'one'}).account,null);
  const now=new Date().toISOString(),reset=new Date(Date.now()+86_400_000).toISOString();
  const usage={observedAt:now,problem:null,accounts:rooms.map(room=>({label:room.account,plan:'Max',current:false,problem:null,
    windows:[{name:'Weekly',usedPercent:10,resetsAt:reset}]}))};
  db.query('INSERT INTO provider_account_usage(provider,observed_at,usage_json) VALUES(?,?,?)').run('claude-code',now,JSON.stringify(usage));
  selectClaudeAccount('one','one');forgetAccountFiles();
  const selectedUnreadable={...usage,accounts:usage.accounts.map(account=>account.label==='one'
    ?{...account,problem:'The selected account could not be read.',windows:[]}:account)};
  db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(selectedUnreadable),'claude-code');
  assert.equal(claudeAccountWithRoomBesides('one','opus[1m]'),true,
    'a preferred unreadable account cannot hide another launchable account with confirmed room');
  const onlyRefusedHasRoom={...usage,accounts:usage.accounts.map(account=>account.label==='one'?account:
    {...account,windows:[{name:'Weekly',usedPercent:100,resetsAt:reset}]})};
  db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(onlyRefusedHasRoom),'claude-code');
  assert.equal(claudeAccountWithRoomBesides('one','opus[1m]'),false,
    'the refusing account alone cannot support an alternative-room claim');
  db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(usage),'claude-code');
  // The same provider errors on a fresh call and on a resume have different custody.
  const claudeModel='claude-haiku-5-5';
  const resetAt=Date.parse(reset);
  const providerFailure=async(sessionUUID:string|null,resetMs:number)=>{
    const prompt='Fixture input';
    return runClaudeCodeTurn({prompt,cwd:scratch,additionalDirs:[],sessionUUID,model:claudeModel,accountLabel:'one',
      transport:{async run(io){
        const emit=(event:object)=>io.onStdout(JSON.stringify({...event,session_id:sessionUUID??'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'})+'\n');
        emit({type:'system',subtype:'init',model:claudeModel});
        emit(JSON.parse(io.stdin));
        emit({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:Math.floor(resetMs/1000)}});
        emit({type:'result',is_error:true,result:"You've hit your weekly limit"});
        return {code:0,signal:null};
      }},
    }).then(()=>{throw new Error('Expected a Claude refusal');},error=>{
      assert.ok(error instanceof ProviderDispatchError);
      return error;
    });
  };
  const native=getSessionById(router.id)!.agent_session_uuid!;
  for(const refusedReset of [resetAt,resetAt+86_400_000]){
    const refusal=await providerFailure(native,refusedReset);
    assert.equal(refusal.threadScoped,true,'even a matching reset has no account authority when the window has room');
    assert.equal(refusal.clearsAtMs,null);
    assert.equal(cachedUsageLimit(usageAttempt('claude-code',claudeModel,'one')),null,'a resumed refusal does not poison other turns');
  }
  const corroborated={...usage,accounts:usage.accounts.map(account=>account.label==='one'
    ?{...account,windows:[{name:'Weekly',usedPercent:100,resetsAt:reset}]}:account)};
  db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(corroborated),'claude-code');
  const accountRefusal=await providerFailure(native,resetAt);
  assert.equal(accountRefusal.threadScoped,false);
  assert.equal(accountRefusal.clearsAtMs,Math.floor(resetAt/1000)*1000);
  const fresh=await providerFailure(null,resetAt);
  assert.equal(fresh.threadScoped,false);
  assert.ok(cachedUsageLimit(usageAttempt('claude-code',claudeModel,'one')),'fresh bound calls can still establish account limits');
  db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(usage),'claude-code');

  const scoped=providerRefusalContinuationReason('Claude refused to continue this conversation.',null,Date.now(),1)!;
  const ended=inputs.enqueueSessionInput(human('worked-and-refused','Continue the accepted fixture work.').id);
  db.query("UPDATE turns SET status='error', ended_at=CURRENT_TIMESTAMP WHERE id=?").run(ended.turn_id);
  const carrying=inputs.queueTurnContinuation(ended.turn_id!,scoped);
  assert.ok(carrying?.turn_id);
  assert.equal(inputs.queueTurnContinuation(ended.turn_id!,scoped)?.id,carrying.id,'an exact failure has one continuation');
  assert.equal(carrying.source_input_id,ended.id);
  assert.deepEqual(db.query('SELECT dispatch_hold FROM turns WHERE id=?').get(carrying.turn_id),{dispatch_hold:null});
  db.query("UPDATE turns SET status='error', ended_at=CURRENT_TIMESTAMP WHERE id=?").run(carrying.turn_id);
  assert.equal(inputs.queueTurnContinuation(carrying.turn_id,scoped),null,'a failed continuation cannot spawn another one');
  assert.equal(inputs.carryingTurn(ended.turn_id!)?.id,carrying.turn_id);
  const exerciseExactRetry=async(scenario:'second-refusal'|'alternative-disappears'|'stop-after-claim')=>{
    const receiver=inputs.createNativeSession('claude-code',{title:'Claude refusal fixture',cwd:scratch});
    const nativeId=`cccccccc-dddd-eeee-ffff-${String(receiver.id).padStart(12,'a')}`;
    inputs.bindSessionProvider(receiver.id,'claude-code',nativeId);
    const inputId=`claude-exact-retry:${scenario}`;
    const exact=inputs.enqueueSessionInput(inputs.retainSessionInput({id:inputId,kind:'input',origin:'agent',
      sessionId:receiver.id,scope:'fixture',actionId:inputId,payload:{text:'One exact input'}}).input.id);
    db.query('UPDATE turns SET dispatch_attempt=2 WHERE id=?').run(exact.turn_id);
    const launches:(string|undefined)[]=[];
    const runExact=async(beforeProviderAdmission?:()=>void)=>{
      const claim=claimNextQueuedTurn('claude-refusal-fixture');
      assert.equal(claim?.turn_id,exact.turn_id,'the same exact turn remains next');
      const steering=new TurnSteeringController();
      return executeAgentTurn({
        presentation:'native',turnKind:'native',inputId:exact.id,turnId:exact.turn_id!,
        session:getSessionById(receiver.id)!,ownerInstanceId:'claude-refusal-fixture',
        providerId:'claude-code',providerLabel:'Claude Code',model:'opus[1m]',
        cwd:scratch,additionalDirs:[],text:'One exact input',prompt:'One exact input',exactProviderInput:true,
        beforeProviderAdmission,
        steeringController:steering,closeSteering:()=>steering.close(),
        services:{bindProviderSession(){},async deliverResult(){throw new Error('No answer expected');}},
        provider:{id:'claude-code',async fork(){throw new Error('No fork expected');},async run(run){
          assert.equal(run.sessionUUID,nativeId);
          assert.equal(run.prompt,'One exact input');
          launches.push(run.accountLabel);
          run.onProgress?.({type:'started'});
          run.onInputAcknowledged?.();
          throw new ProviderDispatchError({message:scoped.detail,terminalConfirmed:true,threadScoped:true,
            providerSessionId:run.sessionUUID});
        }},
      });
    };
    assert.equal((await runExact()).status,'retry_queued');
    assert.deepEqual(db.query('SELECT dispatch_hold FROM turns WHERE id=?').get(exact.turn_id),{dispatch_hold:null});
    if(scenario==='alternative-disappears'){
      const noAlternative={...usage,accounts:usage.accounts.map(account=>account.label===launches[0]?account:
        {...account,windows:[{name:'Weekly',usedPercent:100,resetsAt:reset}]})};
      db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(noAlternative),'claude-code');
    }
    const stop=scenario==='stop-after-claim'?()=>{
      db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(exact.turn_id);
    }:undefined;
    const result=await runExact(stop);
    db.query('UPDATE provider_account_usage SET usage_json=? WHERE provider=?').run(JSON.stringify(usage),'claude-code');
    if(scenario==='second-refusal'){
      assert.equal(result.status,'error');
      assert.equal(launches.length,2);
      assert.notEqual(launches[0],launches[1],'the bounded retry reaches a different account');
    }else{
      assert.equal(launches.length,1,'a lost alternative or intervening Stop never submits again');
    }
    assert.equal(inputs.getAcceptedSessionInput(exact.id)?.turn_id,exact.turn_id);
    assert.equal(claimNextQueuedTurn('claude-refusal-fixture'),null,'the exact turn no longer blocks the queue');
  };
  for(const scenario of ['second-refusal','alternative-disappears','stop-after-claim'] as const)
    await exerciseExactRetry(scenario);
  const beforeExhaustion=count();
  for(let index=0;index<rooms.length;index++){
    const selected=chooseClaudeDispatch(index===0?'one':rooms[index-1]!.account,1,undefined,'opus[1m]');
    assert.ok(selected,'the real dispatcher selects a home with room');
    recordUsageExhaustion(usageAttempt('claude-code','opus[1m]',selected!.account),Date.now()+86_400_000);
  }
  assert.throws(()=>chooseClaudeDispatch('one',1,undefined,'opus[1m]'),/Every available Claude account is out of room/);
  maybeStartStandingRoleFailover(getSessionById(router.id));
  assert.equal((owner.inbox() as any).session.id,`concierge:${router.id}`);
  assert.equal(count(),beforeExhaustion,'three real dispatcher exhaustion records do not replace Inbox');
  assert.equal(getSessionById(router.id)!.agent_session_uuid,'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

  // An explicit human override can bind a named destination, once, with old lineage retained.
  const override=human('human-bind',`Move my Inbox router to concierge:${target.id}.`);
  roles.bindStandingAgentSession(scratch,'inbox',target,override.id);
  assert.equal(pin.currentInboxHolder()!.id,target.id);
  assert.equal(pin.humanAuthorizedInboxMove(override.id,{provider:'codex',id:target.id}),false,'a consumed human override cannot authorize another move');
  assert.equal(inputs.sessionMetadata(getSessionById(router.id)!).inbox,true);
  assert.throws(()=>roles.takeInboxRouterRole(router.id,inputs.sessionMetadata(target),agent.id),/Inbox stays/);

  // Exercise full ordinary proposal/acceptance using its original human source, not successor words.
  const instruction=inputs.retainSessionInput({id:'human-handoff',sessionId:target.id,scope:'surface:thinkering',actionId:'human-handoff',kind:'input',origin:'human',
    payload:{text:'Move my Inbox router to Claude Code.'}}).input;
  const proposed=await handoff.proposeHandoff({actorSession:target.id,inputId:instruction.id,runId:'fixture',predecessorId:target.id,
    provider:'cc-opus-1m',reason:'Explicit human override',actionId:'human-handoff'});
  const successor=Number(proposed.successor.split(':').at(-1));
  db.query('UPDATE session_handoffs SET requesting_input_id=? WHERE id=?').run(agent.id,proposed.handoffId);
  await assert.rejects(handoff.acceptHandoff({actorSession:successor,inputId:`handoff:${proposed.handoffId}`,runId:'fixture',handoffId:proposed.handoffId,digest:proposed.digest}),/Inbox stays/);
  assert.equal(pin.currentInboxHolder()!.id,target.id,'a pre-install automatic proposal cannot later take over');
  db.query('UPDATE session_handoffs SET requesting_input_id=? WHERE id=?').run(instruction.id,proposed.handoffId);
  const accepted=await handoff.acceptHandoff({actorSession:successor,inputId:`handoff:${proposed.handoffId}`,runId:'fixture',handoffId:proposed.handoffId,digest:proposed.digest});
  assert.equal(accepted.accepted,true,JSON.stringify(accepted));
  assert.equal(pin.currentInboxHolder()!.id,successor);
  assert.equal(getSessionById(successor)!.provider_id,'claude-code');
  console.log('PASS: pinned role, exact queued input, account homes/choice, refusal paths, explicit human bind and full handoff override');
} finally {db.close();rmSync(scratch,{recursive:true,force:true});}
