import {strict as assert} from 'node:assert';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {runFixtureChild} from './fixture-child';

/** Actual canonical mutations and a separate production projection worker, all under /tmp.
 * Called by the existing presentation release gate as well as directly for diagnosis. */
export async function checkTopicProjectionLifecycle(mode='--child'){
 const root=await mkdtemp(join(tmpdir(),'concierge-topic-projection-'));
 try{return await runFixtureChild({command:process.execPath,args:[import.meta.path,mode,root],env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',
  CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture')},deadlineMs:45_000,
  fixture:mode==='--native-child'?'native-owner-projection-lifecycle':'topic-projection-lifecycle'});}
 finally{await rm(root,{recursive:true,force:true});}
}

export const checkNativeOwnerProjectionLifecycle=()=>checkTopicProjectionLifecycle('--native-child');

async function nativeOwnerLifecycle(root:string){
 const started=Date.now();
 const phase=(name:string)=>console.error(JSON.stringify({fixture:'native-owner-projection-lifecycle',phase:name,elapsedMs:Date.now()-started}));
 phase('starting');
 assert.equal(process.env.CONCIERGE_TEST_MODE,'1');assert.equal(process.env.CONCIERGE_STATE_DIR,root);
 const {SessionOwner}=await import('../src/session-owner');
 const {createNativeSession}=await import('../src/session-inputs');
 const {startRoutedRequestApi}=await import('../src/routed-request-api');
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},root);
 createNativeSession('claude-code',{title:'Native worker first card',cwd:root});
 // Inspect only this isolated process's own children, never a machine-wide process search.
 const workers=()=>readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
  .filter(pid=>{try{return readFileSync(`/proc/${pid}/cmdline`,'utf8').includes('presentation-message-worker');}catch{return false;}});
 assert.deepEqual(workers(),[]);
 let server:Awaited<ReturnType<typeof startRoutedRequestApi>>|null=null;
 const read=async()=>{
  const response=await fetch('http://fixture/sessions/v1/presentation/sessions/window?space=everyday',{unix:join(root,'requests.sock')});
  assert.equal(response.status,200);return response.json() as Promise<any>;
 };
 const waitForCards=async(count:number)=>{
  const deadline=Date.now()+20_000;let last:any;
  while(Date.now()<deadline){last=await read();if(last.coverage?.complete&&last.cards?.length===count)return last;await Bun.sleep(20);}
  throw new Error(`Native owner never prepared ${count} cards: ${JSON.stringify(last)}`);
 };
 try{
  // This is the native runtime's real accepting API, with no Slack coordinator or surface.
  phase('starting-owner-api');server=await startRoutedRequestApi(root,null,null,undefined,owner);phase('owner-api-started');
  const initial=await waitForCards(1);assert.equal(initial.cards[0].title,'Native worker first card');phase('first-card-ready');
  const pids=workers();assert.equal(pids.length,1);
  await assert.rejects(startRoutedRequestApi(root,null,null,undefined,owner),/live listener/);
  assert.deepEqual(workers(),pids,'Refused duplicate owner must not spawn another worker');
  createNativeSession('claude-code',{title:'Native worker later card',cwd:root});
  const updated=await waitForCards(2);assert.ok(updated.cards.some((row:any)=>row.title==='Native worker later card'));phase('second-card-ready');
  phase('stopping-owner-api');await Promise.all([server.stop(true),server.stop(true)]);server=null;phase('owner-api-stopped');
  assert.deepEqual(workers(),[],'Awaited owner shutdown must reap its worker');
  console.log(JSON.stringify({fixture:'native-owner-projection-lifecycle',initialCards:1,updatedCards:2,workers:pids.length,duplicateRefused:true,shutdownReaped:true}));
 }finally{phase('cleanup-start');await server?.stop(true);phase('cleanup-finished');}
}

async function lifecycle(root:string){
 const started=Date.now();
 const phase=(name:string)=>console.error(JSON.stringify({fixture:'topic-projection-lifecycle',phase:name,elapsedMs:Date.now()-started}));
 phase('starting');
 assert.equal(process.env.CONCIERGE_TEST_MODE,'1');assert.equal(process.env.CONCIERGE_STATE_DIR,root);
 await mkdir(join(root,'slack-inbox','.git'),{recursive:true});await writeFile(join(root,'slack-inbox','AGENTS.md'),'Synthetic fixture; no provider work.');
 phase('loading-owner');
 const [{SessionOwner},{createNativeSession},{db}]=await Promise.all([import('../src/session-owner'),import('../src/session-inputs'),import('../src/state')]);
 phase('owner-loaded');
 createNativeSession('claude-code',{title:'Projection fixture',cwd:root});
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},root);
 let worker:ChildProcess|null=null,workerDone:Promise<void>|null=null,errors='',prepared:Database|null=null,workerExit='running';
 const start=()=>{errors='';workerExit='running';worker=spawn('setpriv',['--pdeathsig','KILL',process.execPath,join(import.meta.dir,'../src/presentation-message-worker.ts')],{env:process.env,stdio:['ignore','ignore','pipe']});
  const startedWorker=worker;
  workerDone=new Promise<void>(resolve=>startedWorker.once('close',(code,signal)=>{workerExit=`code=${code} signal=${signal}`;resolve();}));
  startedWorker.once('exit',(code,signal)=>{workerExit=`code=${code} signal=${signal}`;});
  startedWorker.once('error',error=>{workerExit=`spawn-error ${error}`;errors=(errors+String(error)).slice(-8000);});
  startedWorker.stderr!.on('data',chunk=>{errors=(errors+chunk).slice(-8000);});phase(`worker-started pid=${worker.pid}`);};
 const stop=async()=>{if(!worker)return;const prior=worker,done=workerDone!;worker=null;workerDone=null;
  if(prior.exitCode===null&&prior.signalCode===null)prior.kill('SIGKILL');await done;phase(`worker-exited ${workerExit}`);};
 const checkpoint=async()=>{
  const head=(db.query('SELECT COALESCE(MAX(sequence),0) AS head FROM presentation_change_log').get() as {head:number}).head;
  // A killed worker's existing lease expires after ten seconds; observe actual recovery.
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
   assert.equal(workerExit,'running',`Projection worker exited: ${workerExit}: ${errors}`);
   assert.ok(!errors.includes('presentation_message_worker_failed'),errors);
   if(!prepared&&existsSync(join(root,'presentation.db'))){prepared=new Database(join(root,'presentation.db'),{readonly:true});prepared.exec('PRAGMA busy_timeout=5000');}
   if(prepared?.query("SELECT 1 FROM sqlite_master WHERE name='presentation_message_meta'").get()){
    const meta=prepared.query('SELECT ready,source_head,generation FROM presentation_message_meta WHERE singleton=1').get() as {ready:number;source_head:number;generation:number}|null;
    if(meta?.ready&&meta.source_head>=head)return meta;
   }
   await Bun.sleep(20);
  }
  throw new Error(`Projection did not reach canonical head ${head}; worker=${workerExit}: ${errors}`);
 };
 const mutate=async(path:string,body:unknown)=>{const response=await owner.handle(new Request('http://fixture/sessions/v1'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));if(!response||response.status>=300)throw new Error(await response?.text()??'Missing owner response');return response.json() as Promise<any>;};
 const snapshot=(topicId:string,generation:number)=>{
  const row=prepared!.query('SELECT summary_json,detail_hash FROM presentation_topics WHERE generation=? AND topic_id=?').get(generation,topicId) as {summary_json:string;detail_hash:string};assert.ok(row);
  const items=prepared!.query("SELECT value_json FROM presentation_topic_items WHERE generation=? AND topic_id=? AND kind='history' ORDER BY sort_key").all(generation,topicId) as {value_json:string}[];assert.ok(items.length>0);
  const chunks=prepared!.query('SELECT text AS content FROM presentation_topic_chunks WHERE hash=? ORDER BY chunk').all(row.detail_hash) as {content:string}[];
  const detail=JSON.parse(chunks.map(row=>row.content).join(''));
  // This topic has no request or question items. Its revision must include every history item.
  const digest=createHash('sha256');for(const item of items)digest.update(item.value_json);
  assert.equal(detail.itemsRevision,digest.digest('hex'));
  return {summary:JSON.parse(row.summary_json),history:items.map(row=>JSON.parse(row.value_json)),hash:row.detail_hash};
 };
 try{
  start();phase('initial-checkpoint');await checkpoint();phase('initial-ready');
  const capture=owner.acceptInboxCapture({source:{kind:'thinkering',id:'projection-root',recordedAt:'2026-10-08T00:00:00Z'},text:'Synthetic topic root',importOnly:true});
  const created=await mutate('/inbox/topics',{clientActionId:'projection-create',title:'Before rename',roots:[capture.operation.id]});
  const topicId=created.topic.topicId;assert.ok(topicId);
  phase('created-checkpoint');const initial=await checkpoint(),first=snapshot(topicId,initial.generation);assert.equal(first.summary.title,'Before rename');phase('created-ready');
  await mutate('/inbox/topics/'+encodeURIComponent(topicId)+'/actions',{clientActionId:'projection-rename',action:{kind:'rename',title:'After rename'}});
  phase('renamed-checkpoint');const updated=await checkpoint(),second=snapshot(topicId,updated.generation);assert.equal(second.summary.title,'After rename');assert.notEqual(second.hash,first.hash);assert.ok(second.history.length>first.history.length);phase('renamed-ready');
  phase('stopping-worker');await stop();phase('worker-stopped');
  await mutate('/inbox/topics/'+encodeURIComponent(topicId)+'/actions',{clientActionId:'projection-closed',action:{kind:'close',reason:'Synthetic closure while worker stopped'}});
  start();phase('restarted-checkpoint');const resumed=await checkpoint(),third=snapshot(topicId,resumed.generation);assert.equal(third.summary.state,'closed');assert.notEqual(third.hash,second.hash);assert.ok(third.history.length>second.history.length);phase('restarted-ready');
  assert.ok(resumed.source_head>updated.source_head);console.log(JSON.stringify({fixture:'topic-projection-lifecycle',createdHead:initial.source_head,updatedHead:updated.source_head,restartedHead:resumed.source_head,historyRows:third.history.length}));
 }finally{phase('cleanup-start');try{await stop();}finally{prepared?.close();phase('cleanup-finished');}}
}
if(import.meta.main){
 if(process.argv[2]==='--native-child')nativeOwnerLifecycle(process.argv[3]!).then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else if(process.argv[2]==='--native')console.log(JSON.stringify(await checkNativeOwnerProjectionLifecycle()));
 else if(process.argv[2]==='--child')lifecycle(process.argv[3]!).then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else console.log(JSON.stringify(await checkTopicProjectionLifecycle()));
}
