import {strict as assert} from 'node:assert';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';

/** Actual canonical mutations and a separate production projection worker, all under /tmp.
 * Called by the existing presentation release gate as well as directly for diagnosis. */
export async function checkTopicProjectionLifecycle(){
 const root=await mkdtemp(join(tmpdir(),'concierge-topic-projection-'));
 const child=spawn(process.execPath,[import.meta.path,'--child',root],{env:{...process.env,
  CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622',
  CONCIERGE_STATE_DIR:root,CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture')},stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',chunk=>{output=(output+chunk).slice(-8000);});child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-8000);});
 const timeout=setTimeout(()=>child.kill('SIGKILL'),45_000);
 try{const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,`Topic projection lifecycle failed: ${errors}\n${output}`);
  const result=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(row=>row.fixture==='topic-projection-lifecycle');
  assert.ok(result,'Topic lifecycle did not publish its checkpoints');return result;
 }
 finally{clearTimeout(timeout);await rm(root,{recursive:true,force:true});}
}

async function lifecycle(root:string){
 assert.equal(process.env.CONCIERGE_TEST_MODE,'1');assert.equal(process.env.CONCIERGE_STATE_DIR,root);
 await mkdir(join(root,'slack-inbox','.git'),{recursive:true});await writeFile(join(root,'slack-inbox','AGENTS.md'),'Synthetic fixture; no provider work.');
 const [{SessionOwner},{createNativeSession},{db}]=await Promise.all([import('../src/session-owner'),import('../src/session-inputs'),import('../src/state')]);
 createNativeSession('claude-code',{title:'Projection fixture',cwd:root});
 const owner=new SessionOwner({available:()=>true,wake:()=>{},steer:()=>false,stop:async()=>false},root);
 let worker:ChildProcess|null=null,errors='',prepared:Database|null=null;
 const start=()=>{errors='';worker=spawn('setpriv',['--pdeathsig','KILL',process.execPath,join(import.meta.dir,'../src/presentation-message-worker.ts')],{env:process.env,stdio:['ignore','ignore','pipe']});worker.stderr!.on('data',chunk=>{errors=(errors+chunk).slice(-8000);});};
 const stop=async()=>{if(!worker)return;const prior=worker;worker=null;const exited=new Promise(resolve=>prior.once('exit',resolve));prior.kill('SIGKILL');await exited;};
 const checkpoint=async()=>{
  const head=(db.query('SELECT COALESCE(MAX(sequence),0) AS head FROM presentation_change_log').get() as {head:number}).head;
  // A killed worker's existing lease expires after ten seconds; observe actual recovery.
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline){
   assert.ok(!errors.includes('presentation_message_worker_failed'),errors);
   if(!prepared&&existsSync(join(root,'presentation.db'))){prepared=new Database(join(root,'presentation.db'),{readonly:true});prepared.exec('PRAGMA busy_timeout=5000');}
   if(prepared?.query("SELECT 1 FROM sqlite_master WHERE name='presentation_message_meta'").get()){
    const meta=prepared.query('SELECT ready,source_head,generation FROM presentation_message_meta WHERE singleton=1').get() as {ready:number;source_head:number;generation:number}|null;
    if(meta?.ready&&meta.source_head>=head)return meta;
   }
   await Bun.sleep(20);
  }
  throw new Error(`Projection did not reach canonical head ${head}: ${errors}`);
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
  start();await checkpoint();
  const capture=owner.acceptInboxCapture({source:{kind:'thinkering',id:'projection-root',recordedAt:'2026-10-08T00:00:00Z'},text:'Synthetic topic root',importOnly:true});
  const created=await mutate('/inbox/topics',{clientActionId:'projection-create',title:'Before rename',roots:[capture.operation.id]});
  const topicId=created.topic.topicId;assert.ok(topicId);
  const initial=await checkpoint(),first=snapshot(topicId,initial.generation);assert.equal(first.summary.title,'Before rename');
  await mutate('/inbox/topics/'+encodeURIComponent(topicId)+'/actions',{clientActionId:'projection-rename',action:{kind:'rename',title:'After rename'}});
  const updated=await checkpoint(),second=snapshot(topicId,updated.generation);assert.equal(second.summary.title,'After rename');assert.notEqual(second.hash,first.hash);assert.ok(second.history.length>first.history.length);
  await stop();
  await mutate('/inbox/topics/'+encodeURIComponent(topicId)+'/actions',{clientActionId:'projection-closed',action:{kind:'close',reason:'Synthetic closure while worker stopped'}});
  start();const resumed=await checkpoint(),third=snapshot(topicId,resumed.generation);assert.equal(third.summary.state,'closed');assert.notEqual(third.hash,second.hash);assert.ok(third.history.length>second.history.length);
  assert.ok(resumed.source_head>updated.source_head);console.log(JSON.stringify({fixture:'topic-projection-lifecycle',createdHead:initial.source_head,updatedHead:updated.source_head,restartedHead:resumed.source_head,historyRows:third.history.length}));
 }finally{await stop();prepared?.close();}
}
if(import.meta.main){
 if(process.argv[2]==='--child')lifecycle(process.argv[3]!).then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
 else console.log(JSON.stringify(await checkTopicProjectionLifecycle()));
}
