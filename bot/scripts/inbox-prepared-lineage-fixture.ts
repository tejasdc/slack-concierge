import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {runFixtureChild} from './fixture-child';
import {INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION} from '../src/test-authorizations';

// The real worker upgrades an existing on-disk projection and then consumes new links.
// Every write, including intentional pre-upgrade corruption, belongs to this scratch state.
if(process.argv[2]!=='--child'){
  const root=mkdtempSync(join(tmpdir(),'concierge-prepared-lineage-'));
  try{
    console.log(JSON.stringify(await runFixtureChild({command:process.execPath,args:[import.meta.path,'--child'],deadlineMs:60_000,
      fixture:'inbox-prepared-lineage',env:{...process.env,CONCIERGE_STATE_DIR:root,
        CONCIERGE_CAPTURE_STATE_DIR:join(root,'capture'),CONCIERGE_TEST_MODE:'1',
        CONCIERGE_TEST_AUTHORIZATION:INBOX_UNFILED_ACROSS_ROUTERS_TEST_AUTHORIZATION}})));
  }finally{rmSync(root,{recursive:true,force:true});}
}else{
  const root=process.env.CONCIERGE_STATE_DIR!;
  const [{db},{createNativeSession,retainSessionInput,recordSessionEvent},{inboxThreadRoot}]=await Promise.all([
    import('../src/state'),import('../src/session-inputs'),import('../src/session-inbox')]);
  const former=createNativeSession('codex',{title:'Former Inbox',inbox:true});
  const current=createNativeSession('codex',{title:'Current Inbox',inbox:true,standingRole:'inbox'});
  const input=(sessionId:number,id:string,reply?:string)=>{
    retainSessionInput({id,sessionId,scope:'surface:thinkering',actionId:id,kind:'input',origin:'human',
      payload:{text:id,...(reply?{replyToMessage:{kind:'message',sessionId:`concierge:${sessionId}`,messageId:reply}}:{})}});
    recordSessionEvent({sessionId,eventId:`accepted:${id}`,inputId:id,kind:'accepted',payload:{}});
  };
  const link=(sessionId:number,id:string,target:string,attached=true)=>recordSessionEvent({sessionId,
    eventId:`link:${id}:${crypto.randomUUID()}`,inputId:id,kind:'thread_link',
    payload:{root:target,thread:target,attached,routedBy:{sessionId:`concierge:${sessionId}`}}});
  input(former.id,'placed-root');input(current.id,'other-root');input(current.id,'truly-unfiled');
  // More than the upgrade's 100-row page, each independently stranded by the old resolver.
  for(let i=0;i<105;i++){input(former.id,`old-${i}`);link(current.id,`old-${i}`,'placed-root');}
  input(current.id,'successor-reply','old-0');
  input(former.id,'empty-orphan');link(current.id,'empty-orphan','placed-root');
  input(former.id,'restart-parent');
  for(let i=0;i<125;i++)input(current.id,`restart-child-${i}`,'restart-parent');
  db.query('INSERT INTO inbox_topic_roots(root_input_id,topic_id) VALUES(?,?)')
    .run('placed-root','topic:placed');
  let worker:ReturnType<typeof Bun.spawn>|null=null,prepared:Database|null=null,errors='',logs='';
  let streams:Promise<void>[]=[];
  const start=(interrupt=false)=>{
    const preload=interrupt?['--preload',join(import.meta.dir,'inbox-projection-interruption-preload.ts')]:[];
    worker=Bun.spawn([process.execPath,...preload,join(import.meta.dir,'../src/presentation-message-worker.ts')],
      {env:{...process.env,...(interrupt?{CONCIERGE_FIXTURE_INTERRUPT_ROOT:'restart-parent'}:{})},stdout:'pipe',stderr:'pipe'});
    streams=[new Response(worker.stderr as ReadableStream).text().then(text=>{errors+=text;}),
      new Response(worker.stdout as ReadableStream).text().then(text=>{logs+=text;})];
  };
  const stop=async()=>{if(worker){worker.kill('SIGKILL');await worker.exited;await Promise.all(streams);worker=null;}};
  const wait=async(predicate:()=>boolean,label:string)=>{
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline){
      if(worker?.exitCode!==null)throw new Error(`Worker exited during ${label}: ${errors}`);
      if(!prepared&&existsSync(join(root,'presentation.db'))){prepared=new Database(join(root,'presentation.db'));prepared.exec('PRAGMA busy_timeout=5000');}
      if(prepared?.query("SELECT 1 FROM sqlite_master WHERE name='presentation_message_meta'").get()&&predicate())return;
      await Bun.sleep(20);
    }
    throw new Error(`Timed out: ${label}: ${errors}`);
  };
  const meta=()=>prepared!.query('SELECT * FROM presentation_message_meta WHERE singleton=1').get() as any;
  const checkpoint=async()=>{
    const head=(db.query('SELECT MAX(sequence) AS head FROM presentation_change_log').get() as {head:number}).head;
    await wait(()=>{
      const receipt=prepared!.query('SELECT ready,source_head FROM presentation_receipt_meta WHERE singleton=1').get() as any;
      return meta()?.ready&&meta().source_head>=head&&receipt?.ready&&receipt.source_head>=head;
    },'source checkpoint');
  };
  const row=(id:string)=>prepared!.query(`SELECT root_input_id AS root,topic_id AS topic FROM presentation_messages
    WHERE generation=? AND message_id=?`).get(meta().generation,id) as {root:string;topic:string|null};
  const waiting=()=>prepared!.query('SELECT root_id FROM presentation_topic_roots WHERE generation=? AND unfiled=1 ORDER BY root_id')
    .all(meta().generation).map((row:any)=>row.root_id);
  const checkSortingCount=()=>assert.equal((prepared!.query('SELECT count FROM presentation_topic_sorting WHERE generation=?')
    .get(meta().generation) as {count:number}).count,waiting().length,'Sorting count agrees with retained unfiled roots');
  const display=(id:string)=>JSON.parse((prepared!.query(`SELECT display_json FROM presentation_message_display d
    JOIN presentation_messages m USING(generation,event_sequence) WHERE m.generation=? AND m.message_id=?`)
    .get(meta().generation,id) as {display_json:string}).display_json);
  const receipt=(id:string)=>JSON.parse((prepared!.query(`SELECT receipt_json FROM presentation_receipts
    WHERE generation=(SELECT generation FROM presentation_receipt_meta WHERE singleton=1) AND input_id=?`)
    .get(id) as {receipt_json:string}).receipt_json);
  try{
    start();await checkpoint();
    assert.equal(row('old-0').root,'placed-root','Initial successor-authored link');
    assert.equal(row('successor-reply').root,'placed-root','Recursive reply follows earlier router');
    assert.equal(inboxThreadRoot(current.id,'successor-reply'),row('successor-reply').root);
    assert.equal(display('old-0').replyToMessage?.messageId,'placed-root');
    assert.equal(receipt('old-0').replyToMessage?.messageId,'placed-root','Initial receipt follows successor placement');
    await stop();
    const generation=meta().generation;
    // Restore exactly the old projection's false waiting roots, without changing the ledger
    // or appending a change event. Only the versioned worker upgrade can correct them.
    prepared!.exec(`UPDATE presentation_messages SET root_input_id=message_id,topic_id=NULL WHERE message_id LIKE 'old-%';
      UPDATE presentation_message_display SET display_json=json_remove(display_json,'$.replyToMessage','$.routedBy')
        WHERE event_sequence IN (SELECT event_sequence FROM presentation_messages WHERE message_id LIKE 'old-%');
      UPDATE presentation_receipts SET receipt_json=json_set(receipt_json,'$.replyToMessage',NULL,'$.routedBy',NULL)
        WHERE input_id LIKE 'old-%';
      UPDATE presentation_receipt_meta SET projection_revision='pre-lineage-fixture';
      UPDATE presentation_messages SET topic_id='topic:stale' WHERE message_id='placed-root';
      UPDATE presentation_message_meta SET inbox_lineage_roots_version=1;
      UPDATE presentation_worker_lease SET heartbeat_ms=0;`);
    const {PreparedTopics}=await import('../src/prepared-topics');
    const topics=new PreparedTopics(db,prepared!);
    for(let i=0;i<105;i++)topics.updateRoot(generation,`old-${i}`);
    // A previous committed remap already removed the last message member, but left its
    // old human sorting summary behind. Message-only migration cannot discover this row.
    const columns=(prepared!.query('PRAGMA table_info(presentation_topic_roots)').all() as {name:string}[]).map(row=>row.name);
    prepared!.query(`INSERT INTO presentation_topic_roots(${columns.join(',')}) SELECT
      ${columns.map(name=>name==='root_id'?'?':name).join(',')} FROM presentation_topic_roots
      WHERE generation=? AND root_id='old-0'`).run('empty-orphan',generation);
    assert.equal((prepared!.query('SELECT COUNT(*) AS n FROM presentation_messages WHERE root_input_id=?')
      .get('empty-orphan') as {n:number}).n,0);
    assert.equal(waiting().filter(id=>id.startsWith('old-')).length,105);
    const sourceCount=(db.query('SELECT COUNT(*) AS count FROM session_owner_events').get() as {count:number}).count;
    start();await wait(()=>meta().inbox_lineage_roots_version>=2,'versioned upgrade from already-v1 installation');
    await wait(()=>(prepared!.query('SELECT projection_revision FROM presentation_receipt_meta WHERE singleton=1')
      .get() as {projection_revision:string}).projection_revision!=='pre-lineage-fixture','bounded receipt revision upgrade');
    assert.equal(meta().generation,generation,'Upgrade must retain the active generation');
    assert.equal(waiting().filter(id=>id.startsWith('old-')).length,0,'Upgrade removes phantom waiting roots');
    assert.ok(!waiting().includes('empty-orphan'),'Upgrade removes a zero-member orphan sorting root');
    assert.deepEqual(row('placed-root'),{root:'placed-root',topic:'topic:placed'},'Upgrade fixes same-root cached topic');
    checkSortingCount();
    assert.ok(waiting().includes('truly-unfiled'));
    for(let i=0;i<105;i++)assert.deepEqual(row(`old-${i}`),{root:'placed-root',topic:'topic:placed'});
    assert.equal(display('old-0').replyToMessage?.messageId,'placed-root','Upgrade repairs stale routed display');
    assert.equal(receipt('old-0').replyToMessage?.messageId,'placed-root','Receipt revision repairs existing routed receipt');
    assert.equal((db.query('SELECT COUNT(*) AS count FROM session_owner_events').get() as {count:number}).count,sourceCount);
    link(former.id,'old-0','placed-root',false);await checkpoint();
    assert.equal(row('old-0').root,'old-0','Latest detach beats successor attachment');
    assert.equal(row('successor-reply').root,'old-0','Descendant follows detach');
    assert.ok(waiting().includes('old-0'));
    assert.equal(display('old-0').routedBy,undefined);
    assert.equal(receipt('old-0').routedBy,null,'Detached receipt clears routing attribution');
    assert.equal(receipt('old-0').replyToMessage,null);
    link(current.id,'old-0','other-root');await checkpoint();
    assert.equal(row('old-0').root,'other-root','Latest successor relink wins');
    assert.equal(row('successor-reply').root,'other-root');
    assert.equal(display('old-0').replyToMessage?.messageId,'other-root');
    assert.equal(receipt('old-0').replyToMessage?.messageId,'other-root','Incremental receipt follows relink');
    assert.ok(!waiting().includes('old-0'));
    input(current.id,'new-successor-reply','old-1');await checkpoint();
    assert.equal(row('new-successor-reply').root,'placed-root','Incremental new reply crosses lineage');
    assert.ok(waiting().includes('truly-unfiled'));
    // Interrupt the real worker after its first committed 100-member remap page. The
    // accepted parent has moved, but 26 descendants remain under its original root.
    await stop();
    prepared!.exec('UPDATE presentation_worker_lease SET heartbeat_ms=0');
    link(current.id,'restart-parent','placed-root');
    const beforeRestartCount=(db.query('SELECT COUNT(*) AS n FROM session_owner_events').get() as {n:number}).n;
    start(true);await wait(()=>existsSync(join(root,'remap-committed.json')),'committed partial remap barrier');
    const interrupted=JSON.parse(readFileSync(join(root,'remap-committed.json'),'utf8'));
    assert.equal(interrupted.parent_root,'placed-root');assert.equal(interrupted.remaining,26);
    await stop();
    assert.ok(prepared!.query(`SELECT 1 FROM presentation_message_root_work WHERE generation=? AND root_input_id=?
      AND after_sequence>0`).get(generation,'restart-parent'),'Committed old-root continuation remains durable');
    prepared!.exec('UPDATE presentation_worker_lease SET heartbeat_ms=0');
    start();await checkpoint();
    assert.equal(meta().generation,generation);
    for(let i=0;i<125;i++)assert.equal(row(`restart-child-${i}`).root,'placed-root','Resumed descendant follows the moved parent');
    assert.ok(!waiting().includes('restart-parent'),'Resumed remap removes its empty old sorting summary');
    assert.equal((prepared!.query('SELECT COUNT(*) AS n FROM presentation_message_root_work WHERE generation=?')
      .get(generation) as {n:number}).n,0);
    assert.equal((db.query('SELECT COUNT(*) AS n FROM session_owner_events').get() as {n:number}).n,beforeRestartCount);
    await stop();prepared!.exec('UPDATE presentation_worker_lease SET heartbeat_ms=0');start();await checkpoint();
    assert.ok(!waiting().includes('restart-parent'),'Ordinary second restart preserves cleanup');
    assert.ok(!waiting().includes('empty-orphan'));
    assert.ok(waiting().includes('truly-unfiled'));
    checkSortingCount();
    await stop();
    const observations=logs.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
    const upgrade=observations.find(row=>row.event==='presentation_inbox_lineage_upgrade'&&row.version===2);
    assert.equal(upgrade?.orphan_roots_removed,1,'Completion log counts the orphan sweep');
    assert.ok(upgrade.root_summaries_examined>0&&upgrade.topics_updated>0);
    const removed=observations.find(row=>row.event==='presentation_inbox_empty_root_removed'&&row.root==='empty-orphan');
    assert.equal(removed?.resolved_root,'placed-root','Content-free orphan diagnostic retains exact canonical target');
    console.log(JSON.stringify({fixture:'inbox-prepared-lineage',status:'passed',upgraded:105,
      initial:true,existingUpgrade:true,orphanCleanup:true,sameRootTopic:true,interruptionResume:true,
      detach:true,relink:true,recursiveReply:true,canonicalUntouched:true}));
  }finally{await stop();prepared?.close();db.close();}
}
