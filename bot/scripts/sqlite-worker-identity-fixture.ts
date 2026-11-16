import {strict as assert} from 'node:assert';
import {Worker,parentPort,workerData} from 'node:worker_threads';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {nativeIdentity,sqliteWorkerIdentity} from '../src/sqlite-worker-identity';

if (workerData?.identityFixture) {
  parentPort!.postMessage(sqliteWorkerIdentity);
  parentPort!.on('message',()=>process.exit(0));
} else {
  assert.equal(nativeIdentity('darwin',()=>{throw new Error('must not read proc');}).nativeStatus,'unsupported');
  assert.equal(nativeIdentity('linux',()=>{throw new Error('missing proc');}).nativeStatus,'unavailable');
  const workers:Worker[]=[];
  const dir=mkdtempSync(join(tmpdir(),'sqlite-worker-identity-'));
  const records:any[]=[];
  async function start(path:string,data:unknown) {
    const worker=new Worker(path,{workerData:data,stderr:true});
    workers.push(worker);
    const record=await new Promise<any>((resolve,reject)=>{
      let text='';
      const timer=setTimeout(()=>reject(new Error('identity deadline')),10000);
      worker.once('error',reject);
      worker.stderr!.on('data',chunk=>{
        text+=chunk.toString();
        const lines=text.split('\n');text=lines.pop()!;
        for(const line of lines) { try {const row=JSON.parse(line);if(row.event==='sqlite_worker_identity'){clearTimeout(timer);resolve(row);}}catch{} }
      });
    });
    records.push(record);
    assert.equal(record.pid,process.pid);
    assert.equal(record.nativeStatus,'available');
    assert.notEqual(record.nativeTid,process.pid);
    // Independent kernel readback while the worker is alive: TID and field 22.
    const stat=readFileSync(`/proc/${process.pid}/task/${record.nativeTid}/stat`,'utf8');
    assert.equal(Number(stat.split(' ')[0]),record.nativeTid);
    assert.equal(stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19],record.threadStartTicks);
    assert.equal(record.processStartTicks,readFileSync('/proc/self/stat','utf8').slice(readFileSync('/proc/self/stat','utf8').lastIndexOf(')')+2).trim().split(/\s+/)[19]);
    assert.equal(record.bootId,readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim());
    return {worker,record};
  }
  try {
    for(const name of ['ledger-durability-worker','watch-observation-worker','provider-history-page-worker']) {
      assert.ok(readFileSync(join(import.meta.dir,`../src/${name}.ts`),'utf8').startsWith("import './sqlite-worker-identity';"), `${name} must identify before dependency evaluation`);
    }
    if(process.platform!=='linux') throw new Error('Native readback fixture requires Linux');
    const first=await start(import.meta.path,{identityFixture:true});
    assert.equal(first.record.script,'sqlite-worker-identity-fixture.ts');
    const second=await start(import.meta.path,{identityFixture:true});
    assert.notEqual(first.record.generation,second.record.generation);
    assert.notEqual(first.record.nativeTid,second.record.nativeTid);
    const watch=await start(join(import.meta.dir,'../src/watch-observation-worker.ts'),{stateDir:dir});
    assert.equal(watch.record.role,'watch-observation-worker');
    const bad=join(dir,'ledger.db');
    const db=ledgerWriteResults(new Database(bad));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture(value)');db.close();
    const checkpoint=await start(join(import.meta.dir,'../src/ledger-durability-worker.ts'),{
      role:'checkpoint',databasePath:bad,intervalMs:60000});
    assert.equal(checkpoint.record.role,'ledger-durability-worker:checkpoint');
    writeFileSync(`${bad}-wal`,'');
    const sync=await start(join(import.meta.dir,'../src/ledger-durability-worker.ts'),{role:'sync',databasePath:bad});
    assert.equal(sync.record.role,'ledger-durability-worker:sync');
    assert.equal(new Set(records.map(row=>row.generation)).size,records.length);
    // Refuse ledger opening deliberately: the identity must precede even dependency failure.
    await new Promise<void>((resolve,reject)=>{
      const worker=new Worker(join(import.meta.dir,'../src/provider-history-page-worker.ts'),{
        env:{CONCIERGE_TEST_MODE:'1'},stderr:true});
      workers.push(worker);
      let output='';
      const timer=setTimeout(()=>reject(new Error('page startup deadline')),10000);
      worker.stderr!.on('data',chunk=>{output+=chunk.toString();});
      worker.on('error',error=>{
        clearTimeout(timer);
        try {
          assert.match(String(error),/Refusing to open/);
          const identity=output.split('\n').filter(Boolean).map(line=>JSON.parse(line))
            .find(row=>row.event==='sqlite_worker_identity');
          assert.equal(identity.script,'provider-history-page-worker.ts');
          assert.equal(identity.nativeStatus,'available');
          resolve();
        } catch(error) {reject(error);}
      });
    });
    console.log(JSON.stringify({ok:true,workers:records.length,records}));
  } finally {
    await Promise.all(workers.map(worker=>worker.terminate()));
    rmSync(dir,{recursive:true,force:true});
  }
}
