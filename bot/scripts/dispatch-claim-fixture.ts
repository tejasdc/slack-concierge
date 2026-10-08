import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';

/** Exercise the shipping queue claim with the canonical presentation triggers installed. */
export async function checkDispatchClaim(){
 const state=await mkdtemp(join(tmpdir(),'concierge-dispatch-claim-'));
 try{
  const child=spawn(process.execPath,[import.meta.path,'--child'],{env:{...process.env,
   CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',
   CONCIERGE_STATE_DIR:state,CONCIERGE_CAPTURE_STATE_DIR:join(state,'capture')},stdio:['ignore','pipe','pipe']});
  let output='',errors='';
  child.stdout.on('data',chunk=>{output+=chunk;});
  child.stderr.on('data',chunk=>{errors+=chunk;});
  const timeout=setTimeout(()=>child.kill('SIGKILL'),15_000);
  try{
   const code=await new Promise(resolve=>child.once('exit',resolve));
   assert.equal(code,0,`Canonical queue claim failed: ${errors}\n${output}`);
   const result=JSON.parse(output.trim().split('\n').at(-1)??'null');
   assert.equal(result.fixture,'dispatch-claim');
   return result;
  }finally{clearTimeout(timeout);}
 }finally{await rm(state,{recursive:true,force:true});}
}

async function childFixture(){
 assert.equal(process.env.CONCIERGE_TEST_MODE,'1');
 const [{db},{createNativeSession,retainSessionInput,enqueueSessionInput},
  {claimQueuedTurnWithSavedWork},{SessionTurnQueueCoordinator}]=await Promise.all([
  import('../src/state'),import('../src/session-inputs'),import('../src/saved-work'),import('../src/session-turn-queue')]);
 const session=createNativeSession('codex',{title:'Isolated dispatch claim'});
 const retained=retainSessionInput({sessionId:session.id,scope:'dispatch-claim-fixture',actionId:'one',
  kind:'input',origin:'human',payload:{text:'A queued input whose provider must not start.'}}).input;
 const queued=enqueueSessionInput(retained.id);
 assert.ok(queued.turn_id);
 assert.ok(db.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='presentation_change_turns_update'").get());

 // Record Bun's raw count for diagnosis without requiring a particular runtime bug.
 // Roll back the control write; the actual claim below must still find this queued turn.
 const raw=new Database(join(process.env.CONCIERGE_STATE_DIR!,'state.db'));
 let rawChanges:number,directChanges:number;
 try{
  raw.exec('SAVEPOINT raw_change_control');
  rawChanges=raw.query("UPDATE turns SET status='running' WHERE id=? AND status='queued'").run(queued.turn_id).changes;
  directChanges=(raw.query('SELECT changes() AS count').get() as {count:number}).count;
  raw.exec('ROLLBACK TO raw_change_control; RELEASE raw_change_control');
 }finally{raw.close();}
 assert.equal(directChanges,1);

 const delivered:number[]=[];
 let finish!:()=>void;
 const pending=new Promise<void>(resolve=>{finish=resolve;});
 const owner='dispatch-claim-fixture-owner';
 const queue=new SessionTurnQueueCoordinator({claim:()=>claimQueuedTurnWithSavedWork(owner,[]),
  run:(claim)=>{delivered.push(claim.turn_id);return pending;},shouldStop:()=>false,
  onError:(_claim,error)=>{throw error;},onClaimError:(error)=>{throw error;}});
 try{
  queue.wake();
  queue.wake();
  assert.deepEqual(delivered,[queued.turn_id]);
  const claimed=db.query('SELECT status,owner_instance_id,dispatch_attempt FROM turns WHERE id=?').get(queued.turn_id) as
   {status:string;owner_instance_id:string;dispatch_attempt:number};
  assert.deepEqual(claimed,{status:'running',owner_instance_id:owner,dispatch_attempt:1});
  const unmatched=claimQueuedTurnWithSavedWork(owner,[]);
  assert.equal(unmatched,null,'an already claimed turn cannot dispatch twice');
  const journal=db.query("SELECT COUNT(*) AS count FROM presentation_change_log WHERE source_table='turns' AND turn_id=?")
   .get(queued.turn_id) as {count:number};
  assert.ok(journal.count>=4,'the real journal triggers must have fired on insert and claim');
  console.log(JSON.stringify({fixture:'dispatch-claim',rawChanges,directChanges,dispatches:delivered.length,
   unmatchedClaim:unmatched!==null,journalRows:journal.count}));
 }finally{queue.stop();finish();}
}

if(import.meta.main){
 if(process.argv[2]==='--child')childFixture().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else console.log(JSON.stringify(await checkDispatchClaim()));
}
