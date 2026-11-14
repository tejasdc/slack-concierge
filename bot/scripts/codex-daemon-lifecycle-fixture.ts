import assert from 'node:assert/strict';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {beginCodexDaemonLifecycle} from '../src/codex-daemon-lifecycle';
import {CODEX_DAEMON_LIFECYCLE_METHOD,initializeCodexMutationFenceSchema,grantCodexMutationPermit,consumeCodexMutationPermit,
  acquireCodexThreadMutationFence,stopCodexThreadMutationFence,recordCodexMutationResponse,reconcileCodexMutationIntent,
  rejectCodexMutationBeforeForward} from '../src/codex-mutation-fence';

// Physical SQLite contention uses separate Bun fixture processes, never Codex.
// Both children announce readiness before the parent opens their stdin barrier.
if(process.argv[2]==='--lifecycle-worker'){
  const child=new Database(process.argv[3]!);child.exec('PRAGMA busy_timeout=5000');
  const command=JSON.parse(process.argv[4]!);
  process.stdout.write('READY\n');await Bun.stdin.text();
  const result=command.kind==='lifecycle'
    ?beginCodexDaemonLifecycle(child,{operationId:command.id,paramsDigest:createHash('sha256').update(JSON.stringify({operation:command.id})).digest('hex'),nowMs:2})
    :command.kind==='fence'?acquireCodexThreadMutationFence(child,{acceptedInputId:`accepted:${command.id}`,runId:`run:${command.id}`,
      dispatchAttempt:1,fenceId:`fence:${command.id}`,threadId:`thread:${command.id}`,nowMs:2})
      :consumeCodexMutationPermit(child,{permitId:`native:${command.id}`,intentId:`native:${command.id}`,
        paramsDigest:createHash('sha256').update(JSON.stringify(command.id)).digest('hex'),nowMs:2});
  child.close();process.stdout.write(JSON.stringify(result));process.exit(0);
}

const scratch=mkdtempSync(join(tmpdir(),'codex-daemon-lifecycle-fixture-')),opened:Database[]=[];
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let serial=0;
function clients(){
  const file=join(scratch,`${++serial}.db`),left=new Database(file),right=new Database(file);
  left.exec('PRAGMA foreign_keys=ON');right.exec('PRAGMA foreign_keys=ON');
  initializeCodexMutationFenceSchema(left);opened.push(left,right);return {left,right};
}
const owner=(id:string)=>({acceptedInputId:`accepted:${id}`,runId:`run:${id}`,dispatchAttempt:1});
const fence=(db:Database,id:string)=>acquireCodexThreadMutationFence(db,{...owner(id),fenceId:`fence:${id}`,threadId:`thread:${id}`,nowMs:1});
const nativeGrant=(db:Database,id:string)=>grantCodexMutationPermit(db,{permitId:`native:${id}`,threadId:`thread:${id}`,owner:owner(id),
  method:'turn/start',paramsDigest:digest(id),purpose:'ordinary',nowMs:1});
const nativeConsume=(db:Database,id:string)=>consumeCodexMutationPermit(db,{permitId:`native:${id}`,intentId:`native:${id}`,paramsDigest:digest(id),nowMs:2});
const life=(db:Database,id:string,nowMs=2)=>beginCodexDaemonLifecycle(db,{operationId:id,paramsDigest:digest({operation:id}),nowMs});
const settle=(db:Database,intentId:string)=>reconcileCodexMutationIntent(db,{intentId,outcome:'applied',evidenceDigest:digest({source:'fixture-verified-completion',intentId}),nowMs:10});
function barrier(){let release!:()=>void;return {wait:new Promise<void>(resolve=>{release=resolve;}),release:()=>release()};}
async function physicalContenders(file:string,commands:Array<{kind:string;id:string}>){
  const children=commands.map(command=>Bun.spawn([process.execPath,import.meta.path,'--lifecycle-worker',file,JSON.stringify(command)],
    {stdin:'pipe',stdout:'pipe',stderr:'pipe'}));
  const readers=children.map(child=>child.stdout.getReader());
  try {
    await Promise.all(readers.map(async reader=>{
      const first=await reader.read();assert.equal(new TextDecoder().decode(first.value),'READY\n');
    }));
    for(const child of children)child.stdin.end();
    return await Promise.all(children.map(async(child,index)=>{
      const remaining=async()=>{let output='';const decoder=new TextDecoder();
        for(;;){const chunk=await readers[index]!.read();if(chunk.done)break;output+=decoder.decode(chunk.value,{stream:true});}
        return output+decoder.decode();};
      const [stdout,stderr,exit]=await Promise.all([remaining(),new Response(child.stderr).text(),child.exited]);
      assert.equal(exit,0,stderr);return JSON.parse(stdout);
    }));
  }finally{for(const child of children)if(child.exitCode===null)child.kill();}
}
try {
  // Granting permission is not issuing the effect. A lifecycle can win while a
  // previously granted native send waits, but that send must then fail consume.
  {
    const {left,right}=clients(),granted=barrier(),issued=barrier();
    const native=(async()=>{assert.equal(nativeGrant(left,'pending').granted,true);granted.release();await issued.wait;
      const consume=nativeConsume(left,'pending');assert.equal(consume.forward,false);
      assert.equal('reason' in consume?consume.reason:null,'revoked');
      const duplicate=nativeGrant(left,'pending');assert.equal(duplicate.granted,false,'old unused grant cannot bypass lifecycle by duplicate lookup');})();
    const lifecycle=(async()=>{await granted.wait;const begin=life(right,'restart-wins');assert.equal(begin.forward,true);issued.release();
      assert.equal(fence(left,'new-during-lifecycle').acquired,false);return begin;})();
    await Promise.all([native,lifecycle]);
    const completed=await lifecycle;
    recordCodexMutationResponse(right,{intentId:completed.intentId,kind:'accepted',responseDigest:digest('verified-restart-reply'),nowMs:4});
    reconcileCodexMutationIntent(right,{intentId:completed.intentId,outcome:'applied',evidenceDigest:digest('verified-restart-health'),nowMs:5});
    const stale=nativeConsume(left,'pending');
    assert.equal(stale.forward,false);assert.equal('reason'in stale?stale.reason:null,'revoked',
      'a pre-restart grant cannot forward after the lifecycle blocker is reconciled');
  }
  // Reverse order: a prepared lifecycle permit loses to a new thread fence.
  // Fence acquisition revokes its unused global permit; no restart is issued.
  {
    const {left,right}=clients(),prepared=barrier(),fenced=barrier(),id='pending-lifecycle';
    const pending=(async()=>{assert.equal(grantCodexMutationPermit(left,{permitId:id,threadId:'*',owner:owner(id),
      method:CODEX_DAEMON_LIFECYCLE_METHOD,paramsDigest:digest(id),purpose:'ordinary',nowMs:1}).granted,true);
      prepared.release();await fenced.wait;
      const consume=consumeCodexMutationPermit(left,{permitId:id,intentId:id,paramsDigest:digest(id),nowMs:3});
      assert.equal(consume.forward,false);assert.equal('reason' in consume?consume.reason:null,'revoked');})();
    const protect=(async()=>{await prepared.wait;assert.equal(fence(right,'first-fence').acquired,true);fenced.release();})();
    await Promise.all([pending,protect]);
    assert.equal((right.query('SELECT COUNT(*) AS count FROM codex_mutation_intents').get() as any).count,0);
  }
  {
    const {left,right}=clients();
    assert.equal(fence(left,'fence-first').acquired,true);
    const blocked=life(right,'blocked-by-fence');assert.equal(blocked.forward,false);
    assert.equal('reason' in blocked?blocked.reason:null,'thread_fenced');
    stopCodexThreadMutationFence(left,{fenceId:'fence:fence-first',stopActionId:'canonical-stop-before-send',nowMs:3});
    assert.equal(life(right,'after-unused-fence-stop').forward,true,'Stop of an unused fence permits later lifecycle; no issued work is erased');
  }
  {
    const {left,right}=clients();
    assert.equal(nativeGrant(left,'send-a').granted,true);assert.equal(nativeConsume(left,'send-a').forward,true);
    assert.equal(nativeGrant(right,'send-b').granted,true);assert.equal(nativeConsume(right,'send-b').forward,true,
      'ordinary writes to independent threads remain concurrent');
    const blocked=life(right,'blocked-by-send');assert.equal(blocked.forward,false);
    assert.equal('reason' in blocked?blocked.reason:null,'outstanding_mutation');
    recordCodexMutationResponse(left,{intentId:'native:send-a',kind:'accepted',responseDigest:digest('rpc accepted'),nowMs:3});
    assert.equal(life(right,'accepted-is-not-terminal').forward,false,'an RPC receipt is still an unresolved native effect');
    settle(left,'native:send-a');assert.equal(life(right,'other-send-remains').forward,false);
    settle(right,'native:send-b');assert.equal(life(right,'after-verified-sends').forward,true);
  }
  // A stopped fence still blocks lifecycle while an issued start is uncertain.
  {
    const {left,right}=clients(),id='stopped-issued';assert.equal(fence(left,id).acquired,true);
    assert.equal(grantCodexMutationPermit(left,{permitId:id,threadId:`thread:${id}`,owner:owner(id),method:'turn/start',
      paramsDigest:digest(id),purpose:'fenced_recovery',fenceId:`fence:${id}`,nowMs:2}).granted,true);
    assert.equal(consumeCodexMutationPermit(left,{permitId:id,intentId:id,paramsDigest:digest(id),nowMs:3}).forward,true);
    stopCodexThreadMutationFence(left,{fenceId:`fence:${id}`,stopActionId:'stop-issued',nowMs:4});
    assert.equal(life(right,'stop-cannot-erase-issued').forward,false);
    settle(left,id);assert.equal(life(right,'after-source-terminal').forward,true);
  }
  // The first durable global intent wins across independent DB clients. No
  // timeout, retry, Stop or pre-forward rejection releases an issued lifecycle.
  {
    const {left,right}=clients();
    assert.equal(fence(left,'old-unused').acquired,true);
    stopCodexThreadMutationFence(left,{fenceId:'fence:old-unused',stopActionId:'old-stop',nowMs:1});
    const start=barrier();
    const choices=[(async()=>{await start.wait;return life(left,'lifecycle-one');})(),
      (async()=>{await start.wait;return life(right,'lifecycle-two');})()];
    start.release();const results=await Promise.all(choices);
    assert.equal(results.filter(result=>result.forward).length,1);
    const winner=results.find(result=>result.forward)!;
    recordCodexMutationResponse(left,{intentId:winner.intentId,kind:'transport_ambiguous',responseDigest:digest('lost response'),nowMs:3});
    stopCodexThreadMutationFence(right,{fenceId:'fence:old-unused',stopActionId:'old-stop',nowMs:4});
    assert.equal(nativeGrant(right,'after-uncertainty').granted,false);
    assert.equal(fence(right,'after-uncertainty').acquired,false);
    assert.equal(life(right,'timeout-does-not-release',Number.MAX_SAFE_INTEGER).forward,false);
    assert.throws(()=>rejectCodexMutationBeforeForward(left,{permitId:winner.permitId,reasonDigest:digest('pretend no send'),nowMs:5}),/issued mutation/);
    assert.equal((right.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(winner.intentId) as any).state,'ambiguous');
    settle(left,winner.intentId);
    const duplicateId=winner.intentId.slice('daemon-lifecycle:'.length);
    const duplicate=life(right,duplicateId);assert.equal(duplicate.forward,false);
    assert.equal('reason' in duplicate?duplicate.reason:null,'already_issued','reconciled operation cannot be replayed');
    assert.equal(fence(right,'after-verified-lifecycle').acquired,true);
  }
  {
    const {left,right}=clients(),start=barrier();
    const calls=[(async()=>{await start.wait;return life(left,'same-operation');})(),(async()=>{await start.wait;return life(right,'same-operation');})()];
    start.release();const results=await Promise.all(calls);
    assert.equal(results.filter(result=>result.forward).length,1);
    assert.equal((right.query('SELECT COUNT(*) AS count FROM codex_mutation_intents').get() as any).count,1);
    assert.throws(()=>beginCodexDaemonLifecycle(right,{operationId:'same-operation',paramsDigest:digest('different-effect'),nowMs:3}),/conflicts/);
  }
  {
    const {left}=clients();
    const invalid=grantCodexMutationPermit(left,{permitId:'bad-scope',threadId:'a-thread',owner:owner('bad'),
      method:CODEX_DAEMON_LIFECYCLE_METHOD,paramsDigest:digest('bad'),purpose:'ordinary',nowMs:1});
    assert.equal(invalid.granted,false);assert.equal('reason' in invalid?invalid.reason:null,'daemon_lifecycle_scope_invalid');
  }
  {
    const {left}=clients(),file=(left.query('PRAGMA database_list').get() as any).file;
    const [lifecycle,protect]=await physicalContenders(file,[{kind:'lifecycle',id:'physical-lifecycle'},{kind:'fence',id:'physical-fence'}]);
    assert.equal(Number(lifecycle.forward)+Number(protect.acquired),1,'physical processes cannot issue lifecycle and acquire a fence together');
  }
  {
    const {left}=clients(),file=(left.query('PRAGMA database_list').get() as any).file;
    assert.equal(nativeGrant(left,'physical-send').granted,true);
    const [lifecycle,native]=await physicalContenders(file,[{kind:'lifecycle',id:'physical-lifecycle-send'},{kind:'consume',id:'physical-send'}]);
    assert.equal(Number(lifecycle.forward)+Number(native.forward),1,'physical processes cannot forward lifecycle and a native send together');
  }
  console.log('Codex daemon lifecycle: same ledger global exclusion, two-client barrier orders, outstanding sends/fences, durable ambiguity and exact-operation dedup passed');
} finally {for(const database of opened)database.close();rmSync(scratch,{recursive:true,force:true});}
