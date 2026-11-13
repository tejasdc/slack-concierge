#!/usr/bin/env bun
import {strict as assert} from "node:assert";
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CacheBackupAdmission,CacheBackupTrace,CACHE_BACKUP_POLICY,readCacheLoad,requireBackupWindow} from "../src/provider-history-cache-admission";
import {cacheObservationContext,foregroundJournalEvidence,knownChildrenAfterCleanup,observeCacheInterval,traceBackupWindow} from "./cache-admission-observation";
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
const reportIndex=process.argv.indexOf("--diagnostic-report"),reportPath=reportIndex<0?undefined:process.argv[reportIndex+1];
if(reportIndex>=0&&(!reportPath||existsSync(reportPath)))throw new Error("Diagnostic output requires a new explicit file path.");
const trace=new CacheBackupTrace(),startedAtMs=Date.now(),contextBefore=reportPath?cacheObservationContext():undefined;
if(reportPath)await observeCacheInterval(trace,"observer_baseline",60_000);
trace.event("phase_start",{phase:"observation_workspace"});
const observation=mkdtempSync(join(tmpdir(),"history-cache-observe-"));
trace.event("phase_end",{phase:"observation_workspace"});
let f:ReturnType<typeof fixture>|undefined,admission:CacheBackupAdmission|undefined,failure:unknown,report:unknown;
let original:Buffer|undefined,originalCachePreserved:boolean|null=null;
try {
  trace.event("phase_start",{phase:"guarded_trial"});
  admission=new CacheBackupAdmission(observation,()=>traceBackupWindow(trace),readCacheLoad,trace);
  await admission.start();
  trace.event("phase_start",{phase:"fixture_preparation"});
  f=fixture();
  original=readFileSync(f.path);
  const repo=join(f.state,"restic"),password=join(f.state,"password");writeFileSync(password,"disposable-fixture-only");
  const command=["restic","-r",repo,"--password-file",password];
  trace.event("phase_end",{phase:"fixture_preparation"});
  trace.event("phase_start",{phase:"repository_init",command:["timeout","--kill-after=2s","30s","restic","-r","<disposable-local-repository>","--password-file","<disposable-password-file>","init"]});
  const init=Bun.spawn(["timeout","--kill-after=2s","30s",...command,"init"],{stdout:"ignore",stderr:"inherit"});
  trace.event("native_start",{operation:"init",pid:init.pid});
  const exited=init.exited.then(code=>{trace.event("native_exit",{operation:"init",pid:init.pid,exitCode:code,signal:init.signalCode});return code;});
  admission.ownNative(()=>{const sent=init.kill("SIGTERM");trace.event("native_signal",{operation:"init",pid:init.pid,signal:"SIGTERM",reason:"admission",sent});});
  try {const code=await exited;admission.check();assert.equal(code,0);}
  finally {const sent=init.kill("SIGTERM");trace.event("native_signal",{operation:"init",pid:init.pid,signal:"SIGTERM",reason:"finalizer",sent});await exited;admission.ownNative();trace.event("phase_end",{phase:"repository_init"});}
  const restic=new HostCacheRestic(command,admission);
  const maintenance=new HistoryCacheMaintenance(f.state,restic,()=>{},f.objects,undefined,admission);
  trace.event("phase_start",{phase:"prepare_backup_and_full_readback"});
  const before=readFileSync(f.path),prepared=await maintenance.prepare(f.session);
  trace.event("phase_end",{phase:"prepare_backup_and_full_readback"});
  const folder=maintenance.batch(prepared.id);
  const snapshot=JSON.parse(readFileSync(join(folder,"backup.json"),"utf8")).snapshot;
  // Reconcile a lost product backup receipt by unique tag, rather than backing up again.
  trace.event("phase_start",{phase:"accepted_snapshot_adoption_check"});
  const adopted=await restic.backup([join(folder,"cache.sqlite"),join(folder,"manifest.json"),f.object],`concierge-history-cache:${prepared.id}`);
  assert.equal(adopted,snapshot);
  assert.deepEqual(readFileSync(f.path),before);
  trace.event("phase_end",{phase:"accepted_snapshot_adoption_check"});
  admission.check();
  const completed=admission.finish();report=completed;admission=undefined;
  assert.ok(completed.samples>=2);assert.equal(completed.status,"completed");
  if(!reportPath)console.log(JSON.stringify({check:"bounded native local Restic proof with actual host/process/device observation",status:"passed",prepared,report:completed}));
  requireBackupWindow();
} catch(error) {failure=error;trace.event("trial_refused",{error:String(error)});}
finally {
  if(admission){report=admission.finish(failure);if(!reportPath)console.log(JSON.stringify({check:"actual host admission probe",status:"refused",report}));}
  if(f&&original){try{originalCachePreserved=readFileSync(f.path).equals(original);}catch{originalCachePreserved=false;}}
  trace.event("phase_end",{phase:"guarded_trial",outcome:failure?"refused":"completed",originalCachePreserved});
  trace.event("phase_start",{phase:"fixture_cleanup"});
  try {f?.cleanup();rmSync(observation,{recursive:true,force:true});trace.event("phase_end",{phase:"fixture_cleanup"});}
  catch(error){failure??=error;trace.event("cleanup_failed",{error:String(error)});}
}
if(reportPath){
  trace.event("known_children_after_cleanup",{children:knownChildrenAfterCleanup(trace),scope:"Sampled identities only; missed descendants and physical quiescence remain unknown."});
  await observeCacheInterval(trace,"post_exit_observation",60_000);
  const endedAtMs=Date.now(),foreground=await foregroundJournalEvidence(startedAtMs,endedAtMs);
  const resticVersion=Bun.spawnSync(["timeout","5s","restic","version"],{stdout:"pipe",stderr:"ignore"});
  writeFileSync(reportPath,JSON.stringify({schema:1,policy:CACHE_BACKUP_POLICY,startedAtMs,endedAtMs,
    outcome:failure?"refused_or_interrupted":"completed",error:failure?String(failure):null,originalCachePreserved,
    trial:report,trace:trace.summary(),contextBefore,contextAfter:cacheObservationContext(),
    resticVersion:resticVersion.exitCode===0?resticVersion.stdout.toString().trim():null,foreground,
    unavailable:{completedDurableResponseLatency:"No supported nonmutating durable-response probe from this runner; private supervisor mount is inaccessible.",
      oldestAcknowledgementAge:"unavailable",durableBacklog:"unavailable",foregroundLatencyBudget:"not established by this diagnostic",
      physicalQuiescence:"not proven by child exit or post-exit observation",causalAttribution:"whole-device counters and sampled process tree do not prove which writer caused activity"}},null,2)+"\n",{flag:"wx",mode:0o600});
}
if(failure)throw failure;
}
console.log("history cache admission fixture passed");
