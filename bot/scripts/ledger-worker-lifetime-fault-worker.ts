import {Database} from 'bun:sqlite';
import {parentPort,workerData} from 'node:worker_threads';
import {existsSync,writeFileSync} from 'node:fs';
const setup=workerData as any,root=setup.fixtureRoot,mode=setup.fixtureMode;
if(setup.role==='checkpoint'){
 const prepare=Database.prototype.prepare,close=Database.prototype.close;
 const installed=new WeakSet<Database>();let failedPrime=false,failedFinalize=false,refused=false;
 Database.prototype.prepare=function(sql:any,...args:any[]){
  if(!installed.has(this)){
   this.loadExtension(root+'/close-witness.so','sqlite3_closewitness_init');
   const witness=prepare.call(this,'SELECT fixture_register_close(?)');
   try{witness.get(root+'/'+setup.workerId+'.native-close');}finally{witness.finalize();}
   installed.add(this);
  }
  if(mode==='caught-prime'&&!failedPrime&&/^PRAGMA main.user_version =/.test(sql)){failedPrime=true;throw Error('controlled caught primer failure');}
  const prepared=Reflect.apply(prepare,this,[sql,...args]);
  if(mode==='finalize-failure'&&sql==='PRAGMA wal_checkpoint(RESTART)'){
   const finalize=prepared.finalize.bind(prepared);
   prepared.finalize=()=>{if(!failedFinalize){failedFinalize=true;writeFileSync(root+'/finalize.refused','private statement retained');throw Error('controlled statement finalize failure');}return finalize();};
  }
  return prepared;
 } as any;
 Database.prototype.close=function(force?:boolean){
  if(['close-refusal','uncaught-close-refusal','own-exit-close-refusal'].includes(mode)&&!refused){refused=true;writeFileSync(root+'/close.refused','native close not entered');throw Error('controlled private close refusal');}
  const result=close.call(this,force);
  if(!existsSync(root+'/'+setup.workerId+'.native-close'))throw Error('SQLite native deallocation witness missing');
  return result;
 };
}
await import('../src/ledger-durability-worker');
parentPort!.on('message',message=>{
 if(message.kind==='fixture-own-error')throw Error('controlled uncaught checkpoint error');
 if(message.kind==='fixture-own-exit')process.exit(1);
});
