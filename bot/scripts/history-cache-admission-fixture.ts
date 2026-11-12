#!/usr/bin/env bun
import {strict as assert} from "node:assert";
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CacheBackupAdmission,CACHE_BACKUP_POLICY,requireBackupWindow} from "../src/provider-history-cache-admission";
import {HistoryCacheMaintenance,HostCacheRestic} from "../src/provider-history-cache-maintenance";
import {check,fixture} from "./history-cache-maintenance-fixture";

const fakeLoad=()=>({at:performance.now(),pressure:0,available:2*1024*1024*1024,
  devices:{fixture:{readBytes:0,writeBytes:0,busyMs:0}},process:{readBytes:0,writeBytes:0,rssBytes:0,cpuTicks:0,processes:1}});

if(process.argv[2]==="--native-blocked") {
  const child=Bun.spawn(["sleep","120"],{stdout:"ignore",stderr:"ignore"});
  writeFileSync(process.argv[3]!,String(child.pid));
  writeFileSync(process.argv[3]+".args",JSON.stringify({args:process.argv,gomax:process.env.GOMAXPROCS,scratch:process.env.TMPDIR}));
  process.on("SIGTERM",()=>{});
  await Bun.sleep(120_000);process.exit(1);
}

if(!process.argv.includes("--observe-host")) {
await check("failed full readback resumes the same accepted snapshot without a new backup",async f=>{
  f.restic.failReadback=true;
  await assert.rejects(f.maintenance.prepare(f.session),/READBACK_FAILED/);
  const id=readdirSync(f.maintenance.root)[0]!,folder=f.maintenance.batch(id);
  const accepted=JSON.parse(readFileSync(join(folder,"backup.json"),"utf8"));
  f.restic.failReadback=false;
  const proved=await f.maintenance.prove(id);
  assert.equal(proved.snapshot,accepted.snapshot);assert.equal(f.restic.snapshots.size,1);
  const repeat=await f.maintenance.prove(id);
  assert.equal(repeat.alreadyProven,true);assert.equal(repeat.snapshot,accepted.snapshot);
});
await check("an observed failed backup cannot be adopted on retry",async f=>{
  f.restic.failBackup=true;await assert.rejects(f.maintenance.prepare(f.session),/backup_failed/);
  const id=readdirSync(f.maintenance.root)[0]!;
  f.restic.failBackup=false;await assert.rejects(f.maintenance.prove(id),/FAILED_NEW_BATCH_REQUIRED/);
  assert.equal(f.restic.snapshots.size,0);
});
await check("unknown backup coverage refuses before creating a cache pin",async f=>{
  const admission=new CacheBackupAdmission(join(f.state,"load"),()=>{throw new Error("backup_unknown");});
  let failure:unknown;
  try {await assert.rejects(admission.start(),/backup_unknown/);failure=new Error("backup_unknown");}
  finally {assert.equal(admission.finish(failure).status,"refused_or_interrupted");}
  assert.equal(existsSync(f.maintenance.root),false);
});
await check("the small-generation limit rejects growth without a bypass flag",async f=>{
  const admission=new CacheBackupAdmission(join(f.state,"load"),()=>{});
  assert.throws(()=>admission.limit(CACHE_BACKUP_POLICY.maxInputBytes+1),/SMALL_TRIAL_ONLY/);
});
await check("excess observed load refuses admission and retains the original cache",async f=>{
  const before=readFileSync(f.path),load=fakeLoad();
  const admission=new CacheBackupAdmission(join(f.state,"load"),()=>{},()=>({...load,pressure:CACHE_BACKUP_POLICY.maxIoPressure+1}));
  let failure:unknown;
  try {await assert.rejects(admission.start(),/LOAD_BUSY/);failure=new Error("HISTORY_BACKUP_LOAD_BUSY");}
  finally {const report=admission.finish(failure);assert.ok(report.peakIoPressure>CACHE_BACKUP_POLICY.maxIoPressure);}
  assert.deepEqual(readFileSync(f.path),before);
});
await check("a mid-command backup collision terminates only the owned native process tree",async f=>{
  const before=readFileSync(f.path),pidFile=join(f.state,"transport-pid"),load=fakeLoad();
  let available=true;
  const admission=new CacheBackupAdmission(join(f.state,"load"),()=>{if(!available)throw new Error("backup_collision");},
    ()=>({...load,at:performance.now(),pressure:0,available:Math.max(load.available,CACHE_BACKUP_POLICY.minAvailableBytes)}));
  let failure:unknown;
  const flip=setTimeout(()=>{available=false;},1500);
  try {
    await admission.start();
    const restic=new HostCacheRestic([process.execPath,import.meta.path,"--native-blocked",pidFile],admission);
    const maintenance=new HistoryCacheMaintenance(f.state,restic,()=>{},f.objects,undefined,admission);
    await assert.rejects(maintenance.prepare(f.session),/backup_collision/);failure=new Error("backup_collision");
  } finally {clearTimeout(flip);admission.finish(failure);}
  assert.ok(existsSync(pidFile));
  const launched=JSON.parse(readFileSync(pidFile+".args","utf8"));
  for(const flag of ["--no-cache","--limit-upload","--limit-download","--pack-size","sftp.connections=1"])assert.ok(launched.args.includes(flag));
  assert.equal(launched.gomax,"1");
  assert.equal(existsSync(launched.scratch),false,"owned native scratch is removed after termination");
  const pid=Number(readFileSync(pidFile,"utf8"));
  if(existsSync(`/proc/${pid}/stat`))assert.match(readFileSync(`/proc/${pid}/stat`,"utf8"),/\) Z /,"transport must not remain running");
  assert.deepEqual(readFileSync(f.path),before);
  const folder=readdirSync(f.maintenance.root).map(name=>join(f.maintenance.root,name)).find(path=>existsSync(join(path,"manifest.json")))!;
  assert.equal(existsSync(join(folder,"receipt.json")),false);assert.equal(existsSync(join(folder,"backup-failed.json")),true);
});
await check("both scheduled backups and unknown timer coverage refuse the window",async()=>{
  const now=Date.now(),units: string[]=[];
  const show=(unit:string)=>{
    units.push(unit);
    return unit.endsWith(".service")?{LoadState:"loaded",ActiveState:"inactive",SubState:"dead",MainPID:"0",ControlPID:"0",Job:""}
      :{LoadState:"loaded",ActiveState:"active",SubState:"waiting",NextElapseUSecRealtime:new Date(now+3600_000).toUTCString()};
  };
  requireBackupWindow(now,show);assert.equal(units.length,4);
  for(const service of CACHE_BACKUP_POLICY.services)assert.throws(()=>requireBackupWindow(now,unit=>unit===service?{...show(unit),ActiveState:"activating",MainPID:"123"}:show(unit)),/BUSY_OR_UNKNOWN/);
  for(const value of ["",new Date(now+60_000).toUTCString()])assert.throws(()=>requireBackupWindow(now,unit=>unit.endsWith(".timer")?{...show(unit),NextElapseUSecRealtime:value}:show(unit)),/WINDOW_UNAVAILABLE/);
});
}

// This is the conservative first measured slice. It uses real host observation,
// native Restic and a disposable local repository, never production credentials.
// A busy/unknown host returns a failed check rather than silently bypassing admission.
if(process.argv.includes("--observe-host")) {
const observation=mkdtempSync(join(tmpdir(),"history-cache-observe-"));
let f:ReturnType<typeof fixture>|undefined,admission:CacheBackupAdmission|undefined,failure:unknown;
try {
  admission=new CacheBackupAdmission(observation);
  await admission.start();
  f=fixture();
  const repo=join(f.state,"restic"),password=join(f.state,"password");writeFileSync(password,"disposable-fixture-only");
  const command=["restic","-r",repo,"--password-file",password];
  const init=Bun.spawn(["timeout","--kill-after=2s","30s",...command,"init"],{stdout:"ignore",stderr:"inherit"});
  admission.ownNative(()=>init.kill("SIGTERM"));
  try {const code=await init.exited;admission.check();assert.equal(code,0);} finally {init.kill("SIGTERM");await init.exited;admission.ownNative();}
  const restic=new HostCacheRestic(command,admission);
  const maintenance=new HistoryCacheMaintenance(f.state,restic,()=>{},f.objects,undefined,admission);
  const before=readFileSync(f.path),prepared=await maintenance.prepare(f.session);
  const folder=maintenance.batch(prepared.id);
  const snapshot=JSON.parse(readFileSync(join(folder,"backup.json"),"utf8")).snapshot;
  // Reconcile a lost product backup receipt by unique tag, rather than backing up again.
  const adopted=await restic.backup([join(folder,"cache.sqlite"),join(folder,"manifest.json"),f.object],`concierge-history-cache:${prepared.id}`);
  assert.equal(adopted,snapshot);
  assert.deepEqual(readFileSync(f.path),before);
  admission.check();
  const report=admission.finish();admission=undefined;
  assert.ok(report.samples>=2);assert.equal(report.status,"completed");
  console.log(JSON.stringify({check:"bounded native local Restic proof with actual host/process/device observation",status:"passed",prepared,report}));
  requireBackupWindow();
} catch(error) {failure=error;throw error;}
finally {
  if(admission)console.log(JSON.stringify({check:"actual host admission probe",status:"refused",report:admission.finish(failure)}));
  f?.cleanup();rmSync(observation,{recursive:true,force:true});
}
}
console.log("history cache admission fixture passed");
