import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {START_PACE_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {HOOK_DISPATCH_MARKER} from '../src/hook-pins';

const root=mkdtempSync(join(tmpdir(),'concierge-mac-worktree-gate-'));
process.env.CONCIERGE_STATE_DIR=root;
process.env.CONCIERGE_CAPTURE_STATE_DIR=join(root,'capture');
process.env.CONCIERGE_TEST_MODE='1';
process.env.CONCIERGE_TEST_AUTHORIZATION=START_PACE_TEST_AUTHORIZATION;
process.env.CODEX_SYSTEM_DIR=join(root,'fixture-codex-system');
mkdirSync(join(process.env.CODEX_SYSTEM_DIR,'hooks'),{recursive:true});
for(const name of ['concierge-owed-reply','concierge-history-guard'])
  writeFileSync(join(process.env.CODEX_SYSTEM_DIR,'hooks',name),HOOK_DISPATCH_MARKER);
const [{db,claimNextQueuedTurn,clearAbandonedDrain,survivableRunKinds},{createNativeSession,retainSessionInput,enqueueSessionInput}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs')]);
const command=(...args:string[])=>{
  const result=spawnSync(process.execPath,[join(import.meta.dir,'drain-status.ts'),...args],
    {env:process.env,encoding:'utf8',timeout:20_000});
  assert.equal(result.status,0,result.stdout+result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
};
try{
  const session=createNativeSession('codex',{title:'Disposable retirement gate fixture',cwd:root});
  const input=retainSessionInput({id:'fixture:retirement-input',sessionId:session.id,scope:'fixture',
    actionId:'retirement-input',kind:'input',origin:'agent',payload:{text:'Disposable held work'}}).input;
  enqueueSessionInput(input.id);
  const turn=db.query('SELECT id FROM turns WHERE session_id=?').get(session.id).id;
  db.query(`INSERT INTO executions(execution_id,turn_id,dispatch_attempt,session_id,provider,
    host_protocol,supervisor,directory,processor_json,state,adopted_live,created_at_ms,updated_at_ms)
    VALUES('fixture-survival',?,1,?,'codex',1,'codex-daemon',?,'{}','released',1,1,1)`).run(turn,session.id,root);
  assert.ok(survivableRunKinds().providers.includes('codex'),'fixture has actual survivable Codex admission evidence');
  const claimed=command('claim','--worktree-retirement','--owner-pid',String(process.pid));
  assert.equal(db.query('SELECT purpose FROM deployment_drain').get().purpose,'worktree-retirement');
  assert.equal(claimNextQueuedTurn('fixture-owner'),null,'retirement gate holds even survivable provider starts');
  command('release',claimed.token);
  assert.equal(db.query('SELECT count(*) AS n FROM deployment_drain').get().n,0);
  assert.ok(claimNextQueuedTurn('fixture-owner'),'same queued work can start after release');
  const normal=command('claim','--owner-pid',String(process.pid));
  assert.equal(db.query('SELECT purpose FROM deployment_drain').get().purpose,'restart','default update purpose stays unchanged');
  const second=createNativeSession('codex',{title:'Ordinary restart survivor',cwd:root});
  const next=retainSessionInput({id:'fixture:ordinary-survivor',sessionId:second.id,scope:'fixture',
    actionId:'ordinary-survivor',kind:'input',origin:'agent',payload:{text:'Disposable survivor'}}).input;
  enqueueSessionInput(next.id);
  assert.ok(claimNextQueuedTurn('fixture-owner'),'ordinary restart still admits a proven survivable provider');
  command('release',normal.token);
  const stale=command('claim','--worktree-retirement','--owner-pid',String(process.pid));
  clearAbandonedDrain(()=>false);
  assert.equal(db.query('SELECT count(*) AS n FROM deployment_drain').get().n,0,'existing stale-owner recovery also clears maintenance');
  console.log('PASS: real claim/release holds queued admission, releases it, preserves default update purpose and stale-owner recovery');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
