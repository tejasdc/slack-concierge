import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {ProviderLoginManager} from '../src/auth-login';
import {enableLedgerAdmission,maintainLedger,ledgerAdmissionSnapshot,assertLedgerSegment} from '../src/ledger-admission';

if(!process.env.CONCIERGE_PRIVATE_CODE_STATE)throw Error('Use the existing isolated private-code entrance.');
process.env.CONCIERGE_TEST_MODE='1';process.env.CONCIERGE_TEST_AUTHORIZATION='responsive-system-b1eed622';
const {CaptureDeliveryWorker}=await import('../src/capture-delivery-worker');
const deferred=()=>{let resolve=()=>{};const promise=new Promise<void>(yes=>resolve=yes);return{promise,resolve};};
enableLedgerAdmission();
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('owned-login-ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
const ready=deferred(),exited=deferred(),killed=deferred();
let childError='',releaseLogin=()=>{},loginMaintenance:Promise<void>|null=null,deadline:ReturnType<typeof setTimeout>|undefined;
child.stdout.on('data',chunk=>{if(String(chunk).includes('owned-login-ready'))ready.resolve();});child.stderr.on('data',chunk=>childError+=String(chunk));
child.once('close',()=>exited.resolve());
const signal=child.kill.bind(child);
child.kill=((name:any)=>{
 const result=signal(name);
 if(name==='SIGTERM')assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');
 if(name==='SIGKILL'){assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');killed.resolve();}
 return result;
}) as typeof child.kill;
try{
 const bounded=new Promise<never>((_resolve,reject)=>deadline=setTimeout(()=>reject(Error('Owned login cleanup did not finish: '+childError)),7000));
 await Promise.race([ready.promise,bounded]);
 let announced=0,stopped=false;
 const manager=new ProviderLoginManager({onPendingChanged:()=>{assertLedgerSegment();announced++;}});
 (manager as any).pending.set('synthetic',{process:child,exited:exited.promise,expiry:null});
 loginMaintenance=maintainLedger(()=>new Promise<void>(resolve=>releaseLogin=resolve));await Bun.sleep(0);
 const stopping=manager.stop().then(()=>stopped=true);
 await Promise.race([killed.promise,bounded]);
 await exited.promise;assert.equal(child.signalCode,'SIGKILL');
 assert.equal(announced,0);assert.equal(stopped,false);
 releaseLogin();await loginMaintenance;loginMaintenance=null;await stopping;assert.equal(announced,1);
}finally{
 if(deadline)clearTimeout(deadline);
 if(child.exitCode===null&&child.signalCode===null)signal('SIGKILL');
 await exited.promise;releaseLogin();if(loginMaintenance)await loginMaintenance;
}

const claiming=deferred(),aborted=deferred();
let resumed=()=>{},captureMaintenance:Promise<void>|null=null;
const worker=new CaptureDeliveryWorker({queueUrl:'http://fixture.invalid',queueToken:'scratch-only',
 fetch:((_url:any,input:any)=>new Promise((_resolve,reject)=>{
  claiming.resolve();input.signal.addEventListener('abort',()=>{aborted.resolve();reject(input.signal.reason);},{once:true});
 })) as typeof fetch});
try{
 await worker.start();await claiming.promise;
 captureMaintenance=maintainLedger(()=>new Promise<void>(resolve=>resumed=resolve));await Bun.sleep(0);
 let completed=false;const stopping=worker.stop().then(()=>completed=true);
 assert.equal((worker as any).stopController.signal.aborted,true,'actual stop aborts the outstanding claim immediately');
 await aborted.promise;assert.equal(ledgerAdmissionSnapshot().phase,'maintenance');assert.equal(completed,false,'accepted running work remains owned until its admitted continuation finishes');
 resumed();await captureMaintenance;captureMaintenance=null;await stopping;
 assert.equal(worker.status().available,false);
}finally{resumed();if(captureMaintenance)await captureMaintenance;await worker.stop();}
console.log(JSON.stringify({fixture:'ledger-native-control-cleanup',loginTermIgnored:true,maintenanceBeforeStop:true,mixedAnnouncementRetainedUntilResume:true,existingGraceSigkillBeforeResume:true,
 captureClaimAbortBeforeResume:true,captureRunningJoinedAfterResume:true,
 boundary:'actual managers and owned synthetic process/claim; no signin, capture event, provider or production endpoint'}));
