import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from 'bun:sqlite';
import {ledgerWriteResults} from '../src/ledger-write-results';
import {ProviderHistoryPageClient} from '../src/provider-history-page-client';

const scratch=mkdtempSync(join(tmpdir(),'history-retirement-'));
const path=join(scratch,'helper.ts');
// A synchronous SQLite operation and slow termination live in the helper's Bun registry.
writeFileSync(path,`import {Database} from 'bun:sqlite';
const db=new Database(':memory:');
const descendant=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)']);
process.on('SIGTERM',()=>{const until=Date.now()+5000;while(Date.now()<until)db.query('select 1').get();process.exit(0);});
process.on('message',m=>{if(m.operation==='prepare')return;process.send({id:m.id,result:{pid:process.pid,descendant:descendant.pid}});});`);
const ledger=ledgerWriteResults(new Database(join(scratch,'ledger.sqlite')));
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE custody(id TEXT PRIMARY KEY,value TEXT)');
const work={operation:'page' as const,sessionId:'concierge:1',cwd:scratch,cursor:null,limit:1,after:null};
const client=new ProviderHistoryPageClient(path,500);
try{
  const {pid,descendant}=await client.request(work) as {pid:number;descendant:number};
  // Timed-out work still belongs to the same live child.
  await assert.rejects(client.request({...work,operation:'prepare',thread:'abcdefgh'}),/STILL_PREPARING/);
  assert.equal((await client.request(work) as any).pid,pid);
  const pending=client.request({...work,operation:'prepare',thread:'abcdefgh'});
  const rejected=assert.rejects(pending,/STOPPED/);
  const started=performance.now();let retired=false;
  const closing=client.close().then(()=>{retired=true;});
  client.warm();client.prepareCodexWindow(1,'abcdefgh');
  await assert.rejects(client.request(work),/STOPPED/);
  await rejected;
  let writes=0,maxWrite=0;
  while(!retired){
    const start=performance.now();
    ledger.query('INSERT INTO custody VALUES(?,?)').run(`request:${writes}`,`result:${writes}`);
    maxWrite=Math.max(maxWrite,performance.now()-start);writes++;
    await Bun.sleep(10);
  }
  await closing;await client.close();
  assert.ok(performance.now()-started>=1900,'real multi-second retirement must finish before ownership is released');
  assert.ok(writes>20,'durable acceptance continues throughout retirement');
  assert.ok(maxWrite<1000,`durable write stalled ${maxWrite}ms`);
  assert.throws(()=>process.kill(pid,0));
  // Exited grandchildren can briefly remain zombies under the host reaper.
  try{assert.equal((await Bun.file(`/proc/${descendant}/stat`).text()).split(') ')[1].split(' ')[0],'Z');}catch(error){if((error as any).code!=='ENOENT')throw error;}
  ledger.close();
  const reopened=new Database(join(scratch,'ledger.sqlite'),{readonly:true});
  assert.equal((reopened.query('select count(*) as n from custody').get() as any).n,writes);
  assert.equal((reopened.query('select value from custody where id=?').get('request:0') as any).value,'result:0');
  reopened.close();
  console.log(JSON.stringify({writes,maxWrite,retirementMs:performance.now()-started,exactReadback:true}));
}finally{await client.close();try{ledger.close();}catch{}rmSync(scratch,{recursive:true,force:true});}
