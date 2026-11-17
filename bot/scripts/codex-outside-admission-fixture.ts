import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {ledgerWriteResults} from '../src/ledger-write-results';

const restore=process.argv.includes('--restore');
const root=restore?process.env.CONCIERGE_STATE_DIR!:mkdtempSync(join(tmpdir(),'concierge-outside-admission-'));
process.env.CONCIERGE_STATE_DIR=root;
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=CODEX_RUNTIME_MAINTENANCE_TEST_AUTHORIZATION;
const {db,claimNextQueuedTurn,claimableNotClaimed,holdCodexAdmission,codexAdmissionRecoveryHolds}=await import('../src/state');
const {createNativeSession,retainSessionInput,enqueueSessionInput}=await import('../src/session-inputs');
const recovery={kind:'runner-runtime-maintenance' as const,runner:'fixture-runner',operationId:`runtime:${'a'.repeat(40)}`,
  sourceInputId:'original-source',sourceRunId:'original-run',actionId:'original-action',requiredCommit:'b'.repeat(40)};
const holder=`codex:runner-runtime-maintenance:${recovery.runner}:${recovery.operationId}`;
const second={...recovery,operationId:`runtime:${'c'.repeat(40)}`};
const secondHolder=`codex:runner-runtime-maintenance:${second.runner}:${second.operationId}`;
const restoreModes=['maintenance','activation','unknown','malformed','partial-runtime'];
const claim=()=>claimNextQueuedTurn('outside-admission-fixture');
function queued(name:string,outside:unknown=true){
  const session=createNativeSession('codex',{title:name});
  db.query('UPDATE sessions SET native_metadata_json=? WHERE id=?').run(JSON.stringify({outside}),session.id);
  const input=retainSessionInput({id:name,sessionId:session.id,scope:'outside-admission-fixture',actionId:name,kind:'input',origin:'agent',payload:{text:name}}).input;
  const turn=enqueueSessionInput(input.id);
  assert(turn.turn_id);
  db.query("UPDATE turns SET started_at='2000-01-01 00:00:00' WHERE id=?").run(turn.turn_id);
  return {session:session.id,input:input.id,turn:turn.turn_id};
}
const finish=(turn:number)=>db.query("UPDATE turns SET status='done',ended_at=CURRENT_TIMESTAMP WHERE id=?").run(turn);
function expectClaim(expected:ReturnType<typeof queued>){
  const selected=claim();assert.equal(selected?.turn_id,expected.turn,`outside input ${expected.input} must retain its original eligible turn`);
  assert.equal((db.query('SELECT accepted_input_id FROM turns WHERE id=?').get(selected!.turn_id) as {accepted_input_id:string}).accepted_input_id,expected.input);
  finish(expected.turn);
}
try{
  if(restore){
    // Rows were written in the exact pre-fix schema and recovery shape, then the owner closed.
    const mode=process.argv.at(-1);
    const before=db.query('SELECT holder,recovery_json,created_at_ms FROM codex_admission_holds ORDER BY holder').all();
    assert.equal(before.length,mode==='maintenance'?1:2);
    assert.deepEqual(codexAdmissionRecoveryHolds().find(row=>row.holder===holder)?.recovery,recovery);
    const retained=db.query('SELECT session_id AS session,id AS input,turn_id AS turn FROM session_inputs WHERE id=?').get(`restored-${mode}`) as ReturnType<typeof queued>;
    assert(retained,'the outside input was accepted and queued before owner restart');
    db.query("UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.suspended',0) WHERE id=?").run(retained.session);
    const outside=retained;
    if(mode==='maintenance')expectClaim(outside);
    else{
      assert.equal(claim(),null,`restored ${mode} holder must block outside`);
      holdCodexAdmission(holder,false);
      assert.equal(claim(),null,'settling maintenance cannot release the other durable holder');
    }
    assert.equal(claim(),null,'shared queued work stays held after restore');
    if(mode==='maintenance')assert.deepEqual(db.query('SELECT holder,recovery_json,created_at_ms FROM codex_admission_holds ORDER BY holder').all(),before,'restore must not rewrite operation identity');
    console.log(`PASS: durable pre-fix row restore (${mode}) preserves admission scope and holder custody`);
  }else{
    const shared=queued('shared',false),outside=queued('independent-outside');
    holdCodexAdmission(holder,true,recovery);
    const visible=claimableNotClaimed().map(row=>row.turnId);
    expectClaim(outside);
    assert.deepEqual(visible,[outside.turn],'the stuck-work watch must see the same eligible outside turn as the real queue');
    assert.equal(claim(),null,'shared daemon turns remain blocked');

    const blockers:[string,unknown][]=[
      ['codex:runner-activation:fixture-runner:activation',{kind:'runner-activation',runner:'fixture-runner',account:'fixture-account',operationId:'activation'}],
      ['codex:local-activation',undefined],
      ['codex:runner-rehome:fixture-runner',{kind:'runner-rehome',runner:'fixture-runner'}],
      ['legacy-holder',undefined],['unknown-holder',{kind:'future-kind',runner:'fixture-runner'}],
      [`codex:runner-runtime-maintenance:fixture-runner:forged`,recovery],
      [holder,{...recovery,sourceRunId:''}],
      [holder,{...recovery,requiredCommit:'not-a-full-commit'}],
      [holder,{...recovery,operationId:'unbound'}],
    ];
    for(const [index,[blocker,details]] of blockers.entries()){
      const waiting=queued(`blocked-${index}`);
      holdCodexAdmission(blocker,true,details as any);
      assert.equal(claim(),null,`${blocker} must still block outside`);
      assert.deepEqual(claimableNotClaimed(),[]);
      holdCodexAdmission(blocker,false);
      holdCodexAdmission(holder,true,recovery);
      expectClaim(waiting);
    }
    holdCodexAdmission(secondHolder,true,second);holdCodexAdmission(holder,false);
    const independent=queued('second-runtime-holder');expectClaim(independent);
    assert.equal(claim(),null,'releasing one maintenance holder cannot admit shared work through another');
    holdCodexAdmission(secondHolder,false);holdCodexAdmission(holder,true,recovery);

    const guarded=queued('ordinary-eligibility');
    for(const failure of ['auth_wait','usage_wait']){
      db.query('UPDATE turns SET dispatch_failure_class=? WHERE id=?').run(failure,guarded.turn);
      assert.equal(claim(),null,`${failure} is not bypassed`);
    }
    db.query("UPDATE turns SET dispatch_failure_class=NULL,dispatch_next_attempt_ms=? WHERE id=?").run(Date.now()+60_000,guarded.turn);
    assert.equal(claim(),null,'future retry stays queued');
    db.query('UPDATE turns SET dispatch_next_attempt_ms=0 WHERE id=?').run(guarded.turn);
    db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'canceled'}),guarded.input);
    assert.equal(claim(),null,'Stop/canceled accepted input stays authoritative');
    db.query('UPDATE session_inputs SET receipt_json=NULL WHERE id=?').run(guarded.input);
    db.query("INSERT INTO deployment_drain(singleton,token,owner_pid,owner_boot_id,owner_start_ticks,purpose) VALUES(1,'fixture',1,'fixture','1','worktree-retirement')").run();
    assert.equal(claim(),null,'deployment retirement still holds every new start');
    db.query('DELETE FROM deployment_drain WHERE singleton=1').run();
    db.query('UPDATE global_pause SET paused=1 WHERE singleton=1').run();assert.equal(claim(),null,'Pause all stays authoritative');
    db.query('UPDATE global_pause SET paused=0 WHERE singleton=1').run();
    db.query("UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.suspended',1) WHERE id=?").run(guarded.session);
    assert.equal(claim(),null,'per-session Stop/Pause stays authoritative');
    db.query("UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.suspended',0),status='archived' WHERE id=?").run(guarded.session);
    assert.equal(claim(),null,'archive stays authoritative');
    db.query("UPDATE sessions SET status='active' WHERE id=?").run(guarded.session);
    assert.equal(claimNextQueuedTurn('outside-admission-fixture',Date.now(),[guarded.session]),null,'active-session serialization stays authoritative');
    expectClaim(guarded);
    for(const [index,value] of [1,'true','1',false,null,{}].entries()){
      const untrusted=queued(`malformed-outside-${index}`,value);assert.equal(claim(),null,'only the dispatch host boolean true placement is independent');
      finish(untrusted.turn);
    }
    holdCodexAdmission(holder,false);expectClaim(shared);
    console.log('PASS: real queue and stuck-work watch scope maintenance-only outside admission; combined/account/legacy/unknown holds, independent holders, auth, usage, retry, Pause, archive and serialization remain enforced');

    // Seed the historical SQL table/JSON shape directly in the disposable ledger. No new scope
    // column or migration is needed; the next process must classify this retained row as-is.
    queued('restored-shared',false);
    for(const mode of restoreModes){
      const pending=queued(`restored-${mode}`);
      db.query("UPDATE sessions SET native_metadata_json=json_set(native_metadata_json,'$.suspended',1) WHERE id=?").run(pending.session);
    }
    const insert=db.query('INSERT INTO codex_admission_holds(holder,recovery_json,created_at_ms) VALUES(?,?,?)');
    insert.run(holder,JSON.stringify(recovery),123);
    db.close();
    for(const mode of restoreModes){
      if(mode!=='maintenance'){
        const seed=ledgerWriteResults(new Database(join(root,'state.db'),{readwrite:true}));
        seed.query('DELETE FROM codex_admission_holds WHERE holder<>?').run(holder);
        const value=mode==='activation'?JSON.stringify({kind:'runner-activation',runner:'fixture-runner',account:'fixture-account',operationId:'activation'}):mode==='unknown'?JSON.stringify({kind:'future-kind',runner:'fixture-runner'}):mode==='partial-runtime'?JSON.stringify({...second,sourceInputId:''}):'{';
        seed.query('INSERT OR REPLACE INTO codex_admission_holds(holder,recovery_json,created_at_ms) VALUES(?,?,?)').run(holder,JSON.stringify(recovery),123);
        seed.query('INSERT INTO codex_admission_holds(holder,recovery_json,created_at_ms) VALUES(?,?,?)').run(mode==='partial-runtime'?secondHolder:'durable-blocker',value,456);
        seed.close();
      }
      const child=Bun.spawn([process.execPath,import.meta.path,'--restore',mode],{env:{...process.env},stdout:'pipe',stderr:'pipe'});
      const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      assert.equal(code,0,`${mode}: ${err}`);process.stdout.write(out);
    }
  }
}finally{
  if(restore)db.close();else{try{db.close();}catch{}rmSync(root,{recursive:true,force:true});}
}
