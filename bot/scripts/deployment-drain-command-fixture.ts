import assert from 'node:assert/strict';
import {mock} from 'bun:test';
import {mkdtempSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Database} from 'bun:sqlite';

if(process.argv[2]==='child'){
 const authority=await import('../src/deployment-launch-authority');
 mock.module('../src/deployment-launch-authority',()=>({...authority,deploymentLedgerMode:async()=>'owner'}));
 class ReadonlyCliDatabase extends Database{
  constructor(path:string,options:any){assert.equal(options?.readonly,true,'serving CLI cannot open a writable ledger');super(path,options);}
 }
 mock.module('bun:sqlite',()=>({Database:ReadonlyCliDatabase}));
 process.argv=[process.execPath,resolve(import.meta.dir,'drain-status.ts'),...process.argv.slice(3)];
 await import('./drain-status');
}else{
 const root=mkdtempSync('/tmp/wal79-drain-commands-');
 Object.assign(process.env,{CONCIERGE_STATE_DIR:root,CONCIERGE_TEST_MODE:'1',CONCIERGE_TEST_AUTHORIZATION:'responsive-system-b1eed622'});
 const {db}=await import('../src/state');
 const admission=await import('../src/ledger-admission');
 const {deploymentDrainCommand}=await import('../src/deployment-drain-commands');
 const fd=openSync(join(root,'state.db-wal'),'r');
 const children:Bun.Subprocess[]=[];
 const until=async(test:()=>boolean)=>{const end=Date.now()+5000;while(!test()){assert.ok(Date.now()<end,'bounded drain fixture');await Bun.sleep(2);}};
 let received=0,consumed=0,releaseReceipt=()=>{},receipt:Promise<void>=Promise.resolve();
 const server=Bun.serve({unix:join(root,'request-owner.sock'),async fetch(request){
  if(new URL(request.url).pathname==='/live')return Response.json({live:true});
  try{
   received++;const input=await request.json();
   const output=await admission.runLedgerSegment(()=>deploymentDrainCommand(input as any));consumed++;
   await receipt;fsyncSync(fd);return Response.json(output);
  }catch(error){return Response.json({error:String(error)},{status:409});}
 }});
 const spawn=(...args:string[])=>{const child=Bun.spawn([process.execPath,import.meta.path,'child',...args],{env:process.env,stdout:'pipe',stderr:'pipe'});children.push(child);return child;};
 const finish=async(child:Bun.Subprocess,code=0)=>{const [actual,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);assert.equal(actual,code,err||out);return JSON.parse(out);};
 let resume=()=>{};
 try{
  admission.enableLedgerAdmission();
  const held=admission.maintainLedger(()=>new Promise<void>(r=>resume=r));await Bun.sleep(0);
  const claimed=spawn('claim','--owner-pid',String(process.pid));await until(()=>received===1||claimed.exitCode!==null);if(claimed.exitCode!==null)await finish(claimed);await Bun.sleep(20);
  assert.equal(consumed,0);assert.equal(claimed.exitCode,null);
  assert.equal((await (await fetch('http://localhost/live',{unix:join(root,'request-owner.sock')} as any)).json() as any).live,true);
  receipt=new Promise<void>(r=>releaseReceipt=r);resume();await held;await until(()=>consumed===1);await Bun.sleep(20);assert.equal(claimed.exitCode,null,'claim response awaits original descriptor receipt');
  releaseReceipt();receipt=Promise.resolve();const claim=await finish(claimed);assert.equal(claim.status,'claimed_drained');assert.equal(claim.claimed,true);
  assert.equal((await finish(spawn('holds',claim.token))).status,'held');
  assert.equal((await finish(spawn('recover'),10)).status,'active');
  const same=await admission.runLedgerSegment(()=>{const identity=db.query('SELECT owner_pid pid,owner_boot_id bootId,owner_start_ticks startTicks FROM deployment_drain').get() as any;return deploymentDrainCommand({operation:'claim',token:claim.token,identity});});assert.equal(same.claimed,true);
  assert.equal((await finish(spawn('release',claim.token))).status,'released');
  assert.equal((await finish(spawn('release',claim.token),1)).status,'error','release retains absent-token refusal');
  assert.equal((await finish(spawn('recover'))).status,'clear');
  await admission.runLedgerSegment(()=>db.query('INSERT INTO deployment_drain(singleton,token,owner_pid,owner_boot_id,owner_start_ticks) VALUES(1,?,?,?,?)').run(claim.token,99999999,'missing-boot','0'));
  assert.equal((await finish(spawn('recover'))).status,'recovered');
  console.log(JSON.stringify({root,received,consumed,readonlyCli:true,claimHeldBeforeConsumption:true,claimHeldBeforeReceipt:true,liveIdentityRetained:true,exactRetryIdempotent:true,absentReleaseRefused:true,deadIdentityRecovered:true}));
 }finally{
  resume();releaseReceipt();for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');await Promise.all(children.map(child=>child.exited));server.stop(true);closeSync(fd);await admission.runLedgerSegment(()=>db.close(true));
 }
}
