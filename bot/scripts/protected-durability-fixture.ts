#!/usr/bin/env bun
import {strict as assert} from 'node:assert';
import {mkdtempSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProtectedDurabilityObservation,protectedDurability} from '../src/protected-durability-observation';
import {DURABILITY_OBSERVER_POLICY,durabilityObservationCommand,numericDurabilitySnapshot,observeProtectedDurability,readProtectedDurability} from '../src/provider-history-durability-observer';
import {CACHE_BACKUP_POLICY} from '../src/provider-history-cache-admission';
import {PROTECTED_DURABILITY_TEST_AUTHORIZATION} from '../src/test-authorizations';
import {protectedOwnerReceipt} from '../src/protected-owner-receipt';
import {installLedgerBarrier} from '../src/ledger-durability-barrier';

const check=(name:string,run:()=>unknown)=>Promise.resolve().then(run).then(()=>console.log(JSON.stringify({check:name,status:'passed'})));
if(process.argv[2]==='--blocked-observer'||process.argv[2]==='--blocked-observer-child'){
  process.on('SIGTERM',()=>{});
  if(process.argv[2]==='--blocked-observer'){
    const child=Bun.spawn([process.execPath,import.meta.path,'--blocked-observer-child'],{stdout:'inherit',stderr:'inherit'});
    console.log(JSON.stringify({parent:process.pid,child:child.pid}));
  } else console.log(JSON.stringify({ready:process.pid}));
  await new Promise(()=>{});
}
if(process.argv[2]==='--native-owner'){
  const {db}=await import('../src/state-database');
  const {startLedgerDurability,ledgerDurabilityCounters}=await import('../src/ledger-durability');
  const {ledgerDurable}=await import('../src/ledger-durability-barrier');
  db.exec('CREATE TABLE fixture(value INTEGER)');db.exec('INSERT INTO fixture VALUES(1)');
  startLedgerDurability(process.env.CONCIERGE_STATE_DIR!);
  const until=performance.now()+5000;
  while(ledgerDurabilityCounters().mode!=='deferred'){
    if(performance.now()>until)throw new Error('Disposable sync worker did not become ready');await Bun.sleep(5);
  }
  const receipt=protectedDurability.begin('owner_receipt');
  db.exec('INSERT INTO fixture VALUES(2)');
  const first=ledgerDurable({kind:'owner_receipt',id:'PRIVATE_SENTINEL',observation:receipt});
  // First target is already dispatched; the later mutation needs its own covering sync.
  await Promise.resolve();
  db.exec('INSERT INTO fixture VALUES(3)');
  const second=ledgerDurable({kind:'provider_input',id:'PRIVATE_SENTINEL'});
  await Promise.all([first,second]);receipt.finish(receipt.proof);
  await ledgerDurable({kind:'provider_input'});
  const snapshot=protectedDurability.snapshot();
  assert.equal(snapshot.installed,1);assert.equal(snapshot.lanes.owner_receipt.completed,1);
  assert.equal(snapshot.lanes.provider_input.completed,2);assert.equal(snapshot.lanes.provider_input.alreadyCovered,1);
  assert.equal(snapshot.lanes.owner_receipt.confirmedSync,1);assert.equal(snapshot.lanes.provider_input.confirmedSync,1);
  assert.equal(snapshot.lanes.owner_receipt.outstanding,0);assert.equal(snapshot.lanes.provider_input.outstanding,0);
  assert.ok(ledgerDurabilityCounters().syncs>=2);
  assert.equal((db.query('SELECT count(*) AS n FROM fixture').get() as any).n,3);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_SENTINEL'));
  numericDurabilitySnapshot(snapshot);
  console.log(JSON.stringify({check:'actual disposable WAL sync releases both covered targets and records already-covered completion',status:'passed'}));
  process.exit(0);
}

await check('preexisting ages, between-poll completions, failure accounting and immutable read snapshots',()=>{
  let now=10;const meter=new ProtectedDurabilityObservation(()=>now);meter.installed=1;
  const old=meter.begin('owner_receipt');now=110;
  const before=meter.snapshot();assert.equal(before.lanes.owner_receipt.oldestOutstandingMs,100);
  const quick=meter.begin('provider_input');now=125;quick.finish(2);now=140;old.finish(1);
  const failure=meter.begin('provider_input');now=150;failure.finish(4);failure.finish(4);
  const after=meter.snapshot();assert.equal(after.lanes.owner_receipt.details[0]!.durationMs,130);
  assert.deepEqual(after.lanes.provider_input.details.map(x=>[x.durationMs,x.outcome]),[[15,2],[10,4]]);
  assert.equal(after.lanes.provider_input.entered,2);assert.equal(after.lanes.provider_input.completed,1);
  assert.equal(after.lanes.provider_input.failed,1);assert.equal(after.lanes.provider_input.outstanding,0);
  assert.equal(before.lanes.owner_receipt.outstanding,1);assert.equal(before.lanes.owner_receipt.details.length,0);
  const numeric=(x:any):boolean=>x===null||typeof x==='number'||(typeof x==='object'&&Object.values(x).every(numeric));
  assert.ok(numeric(numericDurabilitySnapshot(after)));
});
await check('real receipt wrapper starts before handling, waits for coverage, and preserves failed handler results',async()=>{
  const before=protectedDurability.snapshot().lanes.owner_receipt;
  let release!:()=>void,returned=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const uninstall=installLedgerBarrier(async context=>{await held;context!.observation!.proof=2;});
  try {
    const pending=protectedOwnerReceipt(async()=>{
      assert.equal(protectedDurability.snapshot().lanes.owner_receipt.entered,before.entered+1);return 42;
    },'PRIVATE_SENTINEL').then(result=>{returned=true;return result;});
    await Promise.resolve();assert.equal(returned,false);
    assert.equal(protectedDurability.snapshot().lanes.owner_receipt.outstanding,1);
    release();assert.equal(await pending,42);
    const error=new Error('PRIVATE_SENTINEL');
    await assert.rejects(protectedOwnerReceipt(async()=>{throw error;}),actual=>actual===error);
    const after=protectedDurability.snapshot().lanes.owner_receipt;
    assert.equal(after.completed-before.completed,1);assert.equal(after.failed-before.failed,1);assert.equal(after.outstanding,0);
    assert.ok(!JSON.stringify(after).includes('PRIVATE_SENTINEL'));
  } finally {uninstall();}
});
await check('bounded starts/details never hold foreground completion and loss remains explicit',()=>{
  let now=1;const meter=new ProtectedDurabilityObservation(()=>now,2,1);meter.installed=1;
  const first=meter.begin('provider_input'),lost=meter.begin('provider_input');now=20;
  const start=meter.snapshot().lanes.provider_input;
  assert.equal(start.outstanding,2);assert.equal(start.unknownOutstanding,1);assert.equal(start.oldestOutstandingMs,null);
  first.finish(2);lost.finish(2);meter.begin('provider_input').finish(1);
  const end=meter.snapshot().lanes.provider_input;
  assert.equal(end.completed,3);assert.equal(end.outstanding,0);assert.equal(end.detailDropped,1);assert.equal(end.startsDropped,1);
  assert.equal(end.maxDurationMs,19);assert.equal(end.accountingValid,1);
  assert.deepEqual(end.details.map(x=>x.sequence),[2,3]);
});
await check('observer retains durations between polls, reconciles preexisting work and strips private fields',async()=>{
  let now=10;const meter=new ProtectedDurabilityObservation(()=>now);meter.installed=1;
  const old=meter.begin('owner_receipt');let reads=0;
  const report=await observeProtectedDurability(1000,async()=>{
    if(reads++){const quick=meter.begin('provider_input');now+=15;quick.finish(2);old.finish(2);}
    return {...meter.snapshot(),private:'PRIVATE_SENTINEL'};
  },()=>now,async ms=>{now+=ms;});
  assert.equal(report.coverageValid,1);assert.equal(report.accounting.owner_receipt.initialOutstanding,1);
  assert.equal(report.accounting.owner_receipt.completed,1);assert.equal(report.accounting.provider_input.entered,1);
  assert.equal(report.frames[1].lanes.provider_input.details[0].durationMs,15);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_SENTINEL'));assert.equal(report.externalResponseLatencyMeasured,0);
});
await check('outage, restart, stale snapshot and lost completion detail invalidate evidence without failing operations',async()=>{
  for(const mode of ['outage','restart','stale','overflow','old-first']){
    let now=1,reads=0;const meter=new ProtectedDurabilityObservation(()=>now,2);meter.installed=1;
    let cached:any;
    const report=await observeProtectedDurability(1000,async()=>{
      if(reads++===0){cached=meter.snapshot();if(mode==='old-first')cached.sampledWallMs-=10000;return cached;}
      if(mode==='outage')throw new Error('PRIVATE_SENTINEL');
      if(mode==='restart')return {...meter.snapshot(),epoch:meter.epoch+1};
      if(mode==='stale')return cached;
      for(let i=0;i<3;i++)meter.begin('provider_input').finish(2);
      return meter.snapshot();
    },()=>now,async ms=>{now+=ms;});
    assert.equal(report.coverageValid,0,mode);assert.ok(!JSON.stringify(report).includes('PRIVATE_SENTINEL'));
    assert.equal(meter.snapshot().lanes.provider_input.outstanding,0);
  }
});
await check('one report covers seven-minute exposure plus sample alignment and read overhead within fixed retention',async()=>{
  let now=1,reads=0;const meter=new ProtectedDurabilityObservation(()=>now);meter.installed=1;
  const report=await observeProtectedDurability(DURABILITY_OBSERVER_POLICY.maxDurationMs,async()=>{
    now+=reads++===0?1900:25;return meter.snapshot();
  },()=>now,async ms=>{now+=ms;});
  assert.equal(report.coverageValid,1);assert.equal(report.spanValid,1);assert.equal(report.deadlineExceeded,0);
  assert.ok(report.coverageDurationMs!>=DURABILITY_OBSERVER_POLICY.maxDurationMs);
  assert.ok(report.coverageDurationMs!>=7*60*1000+30000);
  assert.ok(report.frames.length<=512);assert.equal(report.dropped,0);
  assert.ok(report.endedMs-report.startedMs<DURABILITY_OBSERVER_POLICY.collectionMaxMs);
  assert.equal(CACHE_BACKUP_POLICY.maxMs,300000);assert.equal(CACHE_BACKUP_POLICY.maxDiskBusyPercent,50);
  const command=durabilityObservationCommand('bun','fixture',DURABILITY_OBSERVER_POLICY.maxDurationMs);
  assert.equal(command[2],`${DURABILITY_OBSERVER_POLICY.commandMaxMs/1000}s`);
  await assert.rejects(observeProtectedDurability(DURABILITY_OBSERVER_POLICY.maxDurationMs+1,async()=>meter.snapshot()));
});
await check('insufficient owner span and collection deadline overrun fail closed',async()=>{
  for(const overrun of [false,true]){
    let now=1,ownerNow=1;const meter=new ProtectedDurabilityObservation(()=>ownerNow);meter.installed=1;
    const report=await observeProtectedDurability(1000,async()=>{
      if(now>1&&overrun)now+=DURABILITY_OBSERVER_POLICY.collectionMaxMs;
      ownerNow+=0.001;return meter.snapshot();
    },()=>now,async ms=>{now+=ms;});
    assert.equal(report.spanValid,0);assert.equal(report.coverageValid,0);assert.equal(report.deadlineExceeded,1);
    assert.ok(report.coverageDurationMs!<report.durationMs);
  }
});
await check('native observation deadline reaps its TERM-resistant process group',async()=>{
  const command=durabilityObservationCommand(process.execPath,import.meta.path,1);
  // Accelerate only the disposable timer; exercise the production command/group shape and kill grace.
  command[2]='0.5s';command.splice(-2,2,'--blocked-observer');
  const child=Bun.spawn(command,{stdout:'pipe',stderr:'pipe'});
  const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
  assert.notEqual(await child.exited,0,await stderr);
  const lines=(await stdout).trim().split('\n').map(line=>JSON.parse(line));
  const pids=lines.find(line=>line.parent);assert.ok(pids);assert.ok(lines.some(line=>line.ready===pids.child));
  // Reaped group children may briefly be zombies awaiting init; neither may still execute.
  for(const pid of [pids.parent,pids.child]){
    const stat=`/proc/${pid}/stat`;
    if(existsSync(stat))assert.match(await Bun.file(stat).text(),/\) Z /);
  }
});
await check('fixed private socket read and actual bounded command create no maintenance files or ledger',async()=>{
  const root=mkdtempSync(join(tmpdir(),'protected-durability-'));
  const meter=new ProtectedDurabilityObservation();meter.installed=1;
  const server=Bun.serve({unix:join(root,'request-owner.sock'),fetch:request=>{
    assert.equal(request.method,'GET');assert.equal(new URL(request.url).pathname,'/supervisor/durability');
    return Response.json({...meter.snapshot(),private:'PRIVATE_SENTINEL'});
  }});
  try {
    const response=await readProtectedDurability(root);assert.equal(response.installed,1);
    assert.deepEqual(readdirSync(root),['request-owner.sock']);
    const build=await Bun.build({entrypoints:[join(import.meta.dir,'../src/provider-history-cache-maintenance.ts')],target:'bun'});
    assert.ok(build.success,build.logs.map(String).join('\n'));
    const bundled=join(root,'history-cache.js');await Bun.write(bundled,build.outputs[0]!);
    const child=Bun.spawn([process.execPath,bundled,'observe-durability','1000'],
      {env:{...process.env,CONCIERGE_STATE_DIR:root},stdout:'pipe',stderr:'pipe'});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    assert.equal(await child.exited,0,await stderr);
    const report=JSON.parse((await stdout).trim());assert.equal(report.coverageValid,1);
    assert.equal(report.accounting.owner_receipt.trafficObserved,0);assert.equal(report.accounting.provider_input.trafficObserved,0);
    assert.deepEqual(readdirSync(root).sort(),['history-cache.js','request-owner.sock']);
  } finally {await server.stop(true);rmSync(root,{recursive:true,force:true});}
});
await check('actual deferred sync integration uses only its disposable owned database',async()=>{
  const root=mkdtempSync(join(tmpdir(),'protected-durability-native-'));
  try {
    const child=Bun.spawn([process.execPath,import.meta.path,'--native-owner'],{env:{...process.env,
      CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:PROTECTED_DURABILITY_TEST_AUTHORIZATION,
      CONCIERGE_STATE_DIR:root},stdout:'pipe',stderr:'pipe'});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    assert.equal(await child.exited,0,await stderr);assert.match(await stdout,/actual disposable WAL sync/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
