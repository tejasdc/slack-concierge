#!/usr/bin/env bun
import {strict as assert} from "node:assert";
import {chmodSync,copyFileSync,existsSync,linkSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {check,rowsAt} from "./history-cache-maintenance-fixture";
import {HistoryCacheMaintenance} from "../src/provider-history-cache-maintenance";
import {TrustedRootReleaseManager,releaseFileSetDigest} from "../src/deployment-release";
import FORMAT from "../src/provider-history-cache-format.json";

if(process.argv[2]==="--crash") {
  const [state,id,objects,point,operation]=process.argv.slice(3);
  const maintenance=new HistoryCacheMaintenance(state!,{backup:async()=>{throw new Error("unexpected backup");},
    readback:async()=>{throw new Error("unexpected readback");}},()=>{},objects!,stage=>{if(stage===point)process.exit(73);});
  if(operation==="restore")await maintenance.restore(id!);else await maintenance.migrate(id!);
  throw new Error("crash checkpoint was never reached");
}

const failures: string[] = [];
async function regression(name: string, run: Parameters<typeof check>[1]) {
  try { await check(name, run); }
  catch (error) { failures.push(name); console.error(JSON.stringify({check:name,status:"failed",error:String(error)})); }
}
await regression("pre-rename intent resumes the exact prepared generation", async f => {
  const prepared = await f.maintenance.prepare(f.session); await f.maintenance.queue(prepared.id);
  await f.maintenance.migrate(prepared.id);
  const folder = f.maintenance.batch(prepared.id), intended = readFileSync(f.path);
  // Construct the exact durable crash image: intent plus staged generation,
  // original published inode, original checkpoint, no completion receipt.
  const intent=JSON.parse(readFileSync(join(folder,"conversion.json"),"utf8"));
  copyFileSync(f.path, join(folder,intent.prepared));
  unlinkSync(f.path); linkSync(join(folder,"cache.sqlite"),f.path);
  writeFileSync(f.path+".verified.json",f.status); unlinkSync(join(folder,"result.json"));
  const result = await f.maintenance.applyPending() as any;
  assert.notEqual(result.status,"skipped_changed_generation");
  assert.deepEqual(readFileSync(f.path),intended);
});
await regression("an interrupted pre-intent staged copy cannot strand or authorize its batch",async f=>{
  const original=readFileSync(f.path),prepared=await f.maintenance.prepare(f.session);
  const folder=f.maintenance.batch(prepared.id);
  // This fixed filename stranded the prior implementation before intent existed.
  writeFileSync(join(folder,"converted.sqlite"),"partial, unaccepted bytes");
  const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,"conversion_staged","migrate"],
    {stdout:"ignore",stderr:"inherit"});
  assert.equal(await child.exited,73);
  assert.deepEqual(readFileSync(f.path),original);
  assert.equal(existsSync(join(folder,"conversion.json")),false);
  const result=await f.maintenance.migrate(prepared.id);
  assert.equal(result.changed,true);assert.deepEqual(rowsAt(f),f.rows);
  assert.ok(result.retainedStagingAllocatedBytes>0);
  assert.equal(result.netAllocatedSavedBytes,result.allocatedSavedBytes-result.retainedPinAllocatedBytes-result.retainedStagingAllocatedBytes);
  assert.equal(readFileSync(join(folder,"converted.sqlite"),"utf8"),"partial, unaccepted bytes");
});
await regression("post-rename interruption is completed rather than reported skipped", async f => {
  const prepared = await f.maintenance.prepare(f.session); await f.maintenance.queue(prepared.id);
  await f.maintenance.migrate(prepared.id);
  const folder=f.maintenance.batch(prepared.id), intended=readFileSync(f.path);
  unlinkSync(join(folder,"result.json")); writeFileSync(f.path+".verified.json",f.status);
  const result=await f.maintenance.applyPending() as any;
  assert.equal(result.changed,true);
  assert.deepEqual(readFileSync(f.path),intended);
  assert.equal(JSON.parse(readFileSync(f.path+".verified.json","utf8")).generation.startsWith("object-"),true);
  assert.equal(JSON.parse(readFileSync(join(folder,"result.json"),"utf8")).changed,true);
});
await regression("rollback retry completes the sidecar after original-cache rename", async f => {
  const prepared=await f.maintenance.prepare(f.session); await f.maintenance.migrate(prepared.id);
  const folder=f.maintenance.batch(prepared.id);
  unlinkSync(f.path); linkSync(join(folder,"cache.sqlite"),f.path);
  await f.maintenance.restore(prepared.id);
  assert.equal(readFileSync(f.path+".verified.json","utf8"),f.status);
});
for(const point of ["conversion_intent","conversion_published","conversion_sidecar","conversion_result"]) {
  await regression(`process exit at ${point} resumes the exact operation`,async f=>{
    const prepared=await f.maintenance.prepare(f.session);await f.maintenance.queue(prepared.id);
    const folder=f.maintenance.batch(prepared.id);
    // Queue claim is durable before the child dies, as in apply-pending.
    renameSync(join(f.maintenance.root,"pending.json"),join(f.maintenance.root,"attempt.json"));
    const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,point,"migrate"],
      {stdout:"ignore",stderr:"inherit"});
    assert.equal(await child.exited,73);
    const intent=JSON.parse(readFileSync(join(folder,"conversion.json"),"utf8"));
    const result=await f.maintenance.applyPending() as any;
    assert.equal(result.changed,true);
    assert.equal(createHash("sha256").update(readFileSync(f.path)).digest("hex"),intent.after.sha256);
    assert.deepEqual(rowsAt(f),f.rows);
    assert.equal(JSON.parse(readFileSync(f.path+".verified.json","utf8")).generation.startsWith("object-"),true);
    assert.equal(existsSync(join(f.maintenance.root,"attempt.json")),false);
    assert.equal((await f.maintenance.applyPending() as any).status,"no_pending_batch");
  });
}
for(const point of ["restore_published","restore_sidecar"]) {
  await regression(`process exit at ${point} completes rollback without another rename`,async f=>{
    const original=readFileSync(f.path),prepared=await f.maintenance.prepare(f.session);
    await f.maintenance.migrate(prepared.id);
    const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,point,"restore"],
      {stdout:"ignore",stderr:"inherit"});
    assert.equal(await child.exited,73);
    const {lstatSync}=await import("node:fs"),inode=lstatSync(f.path).ino;
    await f.maintenance.restore(prepared.id);
    assert.equal(lstatSync(f.path).ino,inode);
    assert.deepEqual(readFileSync(f.path),original);
    assert.equal(readFileSync(f.path+".verified.json","utf8"),f.status);
  });
}
for(const failure of ["backup_active","source_changed","object_missing"]) {
  await regression(`optional ${failure} is retained once and does not retry every release`,async f=>{
    const original=readFileSync(f.path),prepared=await f.maintenance.prepare(f.session);
    await f.maintenance.queue(prepared.id);
    if(failure==="source_changed")writeFileSync(f.source,"changed\n");
    if(failure==="object_missing")unlinkSync(f.object);
    const maintenance=failure==="backup_active"?new HistoryCacheMaintenance(f.state,f.restic,()=>{throw new Error("backup_active");},f.objects):f.maintenance;
    const result=await maintenance.applyPending() as any;
    assert.equal(result.status,"failed_optional_conversion");
    assert.equal(f.maintenance.status(prepared.id).failures.length,1);
    assert.deepEqual(readFileSync(f.path),original);
    assert.equal((await maintenance.applyPending() as any).status,"no_pending_batch");
    assert.equal(existsSync(join(f.maintenance.batch(prepared.id),"cache.sqlite")),true);
  });
}
await regression("published conversion with a missing object rolls back instead of replaying",async f=>{
  const original=readFileSync(f.path),prepared=await f.maintenance.prepare(f.session);await f.maintenance.queue(prepared.id);
  const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,"conversion_published","migrate"],
    {stdout:"ignore",stderr:"inherit"});assert.equal(await child.exited,73);
  unlinkSync(f.object);
  const result=await f.maintenance.applyPending() as any;
  assert.equal(result.status,"failed_optional_conversion");assert.equal(result.rollback,"restored_original");
  assert.deepEqual(readFileSync(f.path),original);assert.equal(readFileSync(f.path+".verified.json","utf8"),f.status);
  await assert.rejects(f.maintenance.migrate(prepared.id),/CONVERSION_ROLLED_BACK/);
});
await regression("an explicitly requeued published intent finishes through normal optional maintenance",async f=>{
  const prepared=await f.maintenance.prepare(f.session);
  const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,"conversion_published","migrate"],
    {stdout:"ignore",stderr:"inherit"});assert.equal(await child.exited,73);
  await f.maintenance.queue(prepared.id);await f.maintenance.queue(prepared.id);
  const result=await f.maintenance.applyPending() as any;
  assert.equal(result.changed,true);assert.equal(result.recovered,true);
  assert.deepEqual(rowsAt(f),f.rows);
});
await regression("an interrupted rollback takes precedence over an unfinished conversion attempt",async f=>{
  const original=readFileSync(f.path),prepared=await f.maintenance.prepare(f.session);await f.maintenance.queue(prepared.id);
  await f.maintenance.migrate(prepared.id);
  const child=Bun.spawn([process.execPath,import.meta.path,"--crash",f.state,prepared.id,f.objects,"restore_published","restore"],
    {stdout:"ignore",stderr:"inherit"});assert.equal(await child.exited,73);
  const result=await f.maintenance.applyPending() as any;
  assert.equal(result.status,"failed_optional_conversion");assert.equal(result.rollback,"restored_original");
  assert.deepEqual(readFileSync(f.path),original);assert.equal(readFileSync(f.path+".verified.json","utf8"),f.status);
});

await regression("actual deployment helper isolates an actual nonblocking maintenance lock failure",async f=>{
  const prepared=await f.maintenance.prepare(f.session);await f.maintenance.queue(prepared.id);
  const holder=Bun.spawn(["flock",join(f.maintenance.root,"operation.lock"),"python3","-c",
    "import sys; print('locked',flush=True); sys.stdin.read()"],{stdin:"pipe",stdout:"pipe",stderr:"inherit"});
  try {
    const reader=holder.stdout.getReader();assert.ok((await reader.read()).value?.length);reader.releaseLock();
    const fake=join(f.state,"fixture-bun.py"),resumed=join(f.state,"resumed"),repaired=join(f.state,"repaired");
    writeFileSync(fake,`#!/usr/bin/env python3
import json,os,subprocess,sys
if sys.argv[-1]=='lkg': print(json.dumps({'artifact_path':os.environ['FIXTURE_ARTIFACT']}))
elif 'check-readers' in sys.argv: print('{}')
else: sys.exit(subprocess.call([os.environ['FIXTURE_REAL_BUN'],os.environ['FIXTURE_MAINTENANCE'],'apply-pending']))
`);chmodSync(fake,0o700);
    const shell=Bun.spawn(["bash","-ec",'source "$FIXTURE_DEPLOY"; CANDIDATE_ARTIFACT_PATH="$FIXTURE_ARTIFACT"; trap \'touch "$FIXTURE_REPAIR"; exit 99\' ERR; run_optional_history_cache; touch "$FIXTURE_RESUMED"'],
      {env:{...process.env,CONCIERGE_STATE_DIR:f.state,CONCIERGE_BUN_BIN:fake,FIXTURE_REAL_BUN:process.execPath,
        FIXTURE_MAINTENANCE:join(import.meta.dir,"../src/provider-history-cache-maintenance.ts"),
        FIXTURE_DEPLOY:join(import.meta.dir,"deploy.sh"),FIXTURE_ARTIFACT:f.state,FIXTURE_REPAIR:repaired,FIXTURE_RESUMED:resumed},
        stdout:"pipe",stderr:"pipe"});
    const stderr=await new Response(shell.stderr).text();
    assert.equal(await shell.exited,0,stderr);assert.ok(existsSync(resumed));assert.equal(existsSync(repaired),false);
    assert.match(readFileSync(join(f.maintenance.root,"deployment-attempts.jsonl"),"utf8"),/history_cache_optional_deferred/);
    assert.ok(existsSync(join(f.maintenance.root,"pending.json")),"the lock loser cannot alter the active writer queue");
  } finally {await holder.stdin.end();await holder.exited;}
});

await regression("sealed release activation and rollback refuse an incompatible reader until full-row materialization",async f=>{
  const releaseRoot=join(f.state,"release-root");mkdirSync(join(releaseRoot,"releases"),{recursive:true});
  const hash=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
  function seal(supports:boolean,control=supports) {
    const stage=join(releaseRoot,"releases",`.reader-${supports}-${control}`);mkdirSync(join(stage,"control"),{recursive:true});
    const files:Record<string,string>={};
    for(const name of ["control/deploy.sh","control/deployment-repair.js","control/release-manager.js",
      "control/deployment-launcher.sh","control/deployment-control-launcher.sh",...(supports?["control/history-cache-format.json"]:[]),
      ...(control?["control/history-cache-control-format.json"]:[])]) {
      const text=name.endsWith(".json")?JSON.stringify(FORMAT):"sealed fixture";
      writeFileSync(join(stage,name),text,{mode:0o444});files[name]=hash(text);
    }
    const unsigned={format:2 as const,git_commit:"a".repeat(40),control_git_commit:"b".repeat(40),
      source_tree_digest:hash("source"),control_source_tree_digest:hash("control"),runtime_digest:releaseFileSetDigest(stage,Object.keys(files)),
      compatibility_digest:hash("compatibility"),files};
    const artifact_digest=hash(JSON.stringify(unsigned)),path=join(releaseRoot,"releases",artifact_digest);
    writeFileSync(join(stage,"manifest.json"),JSON.stringify({...unsigned,artifact_digest}),{mode:0o444});
    chmodSync(join(stage,"control"),0o555);chmodSync(stage,0o555);renameSync(stage,path);return path;
  }
  const compatible=seal(true),old=seal(false),manager=new TrustedRootReleaseManager({repositoryRoot:f.state,releaseRoot,
    installRoot:join(f.state,"install"),bunExecutable:process.execPath,historyCacheStateDirectory:f.state});
  manager.activate(compatible);manager.activateControl(compatible);
  const prepared=await f.maintenance.prepare(f.session);await f.maintenance.migrate(prepared.id);
  assert.throws(()=>manager.restore(old),/READER_NOT_PROVEN/);
  assert.throws(()=>manager.activateControl(old),/READER_NOT_PROVEN/);
  assert.equal(manager.currentArtifactPath(),compatible);assert.equal(manager.controlArtifactPath(),compatible);
  const oldAppNewControl=seal(false,true),newAppOldControl=seal(true,false);
  assert.throws(()=>manager.activate(oldAppNewControl),/READER_NOT_PROVEN/);
  assert.throws(()=>manager.restore(newAppOldControl),/READER_NOT_PROVEN/);
  assert.equal(manager.currentArtifactPath(),compatible,"controller preflight must precede either restore pointer");
  manager.activateControl(oldAppNewControl); // New control is safe; its older application never starts.
  assert.equal(manager.currentArtifactPath(),compatible);
  manager.activateControl(compatible);
  manager.restore(compatible);
  await f.maintenance.materialize(f.session);
  manager.restore(old);assert.equal(manager.currentArtifactPath(),old);
});
await regression("real hybrid preparation binds reader capability to the application commit",async f=>{
  const source=join(f.state,"hybrid-source");mkdirSync(join(source,"bot/src"),{recursive:true});mkdirSync(join(source,"bot/scripts"),{recursive:true});
  mkdirSync(join(source,"bot/node_modules"),{recursive:true});
  const files=["bot/src/index.ts","bot/src/state.ts","bot/src/capture-state.ts","bot/src/deployment-state.ts",
    "bot/src/codex-app-server-bridge.mjs","bot/scripts/rename-exchange.py","bot/scripts/deployment-repair.ts",
    "bot/scripts/release-manager.ts","bot/scripts/deploy.sh"];
  for(const path of files)writeFileSync(join(source,path),`fixture ${path}`);
  const declaration={format:1,controlBundles:{"control/deployment-repair.js":"bot/scripts/deployment-repair.ts",
    "control/release-manager.js":"bot/scripts/release-manager.ts"},controlFiles:{"control/deploy.sh":"bot/scripts/deploy.sh"} as Record<string,string>,applicationBundles:[]};
  const declare=()=>writeFileSync(join(source,"bot/src/deployment-artifact-files.json"),JSON.stringify(declaration));declare();
  const git=(...args:string[])=>{
    const result=Bun.spawnSync(["git","-C",source,...args],{stdout:"pipe",stderr:"pipe"});
    assert.equal(result.exitCode,0,result.stderr.toString());return result.stdout.toString().trim();
  };
  git("init","-q");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");
  git("add",".");git("commit","-qm","Fixture old application\n\nUpdate-note: Disposable fixture.\n\nFailure-record: none");
  const old=git("rev-parse","HEAD");
  writeFileSync(join(source,"bot/src/provider-history-cache-format.json"),JSON.stringify(FORMAT));
  declaration.controlFiles["control/history-cache-format.json"]="bot/src/provider-history-cache-format.json";
  declaration.controlFiles["control/history-cache-control-format.json"]="bot/src/provider-history-cache-format.json";declare();
  git("add",".");git("commit","-qm","Fixture compatible application and control\n\nUpdate-note: Disposable fixture.\n\nFailure-record: none");
  const modern=git("rev-parse","HEAD");
  const manager=new TrustedRootReleaseManager({repositoryRoot:source,releaseRoot:join(f.state,"hybrid-releases"),installRoot:join(f.state,"install"),bunExecutable:process.execPath},
    {spawn:(command,options={})=>Bun.spawnSync(command,{cwd:options.cwd,stdin:options.stdin,stdout:"pipe",stderr:"pipe"}),
      build:async(entry,output)=>{mkdirSync(join(output,".."),{recursive:true});writeFileSync(output,readFileSync(entry));}});
  const oldApp=await manager.prepare("hybrid-old-app",old,modern);
  assert.equal(existsSync(join(oldApp.artifactPath,"control/history-cache-format.json")),false);
  assert.equal(existsSync(join(oldApp.artifactPath,"control/history-cache-control-format.json")),true);
  const oldControl=await manager.prepare("hybrid-old-control",modern,old);
  assert.equal(existsSync(join(oldControl.artifactPath,"control/history-cache-format.json")),true);
  assert.equal(existsSync(join(oldControl.artifactPath,"control/history-cache-control-format.json")),false);
  assert.equal((await import("node:fs")).lstatSync(oldControl.artifactPath).mode&0o777,0o555,"publication must remain sealed");
  assert.equal((await import("node:fs")).readdirSync(join(f.state,"hybrid-releases/releases")).some(name=>name.startsWith(".preparing-")),false);
});
if(failures.length)throw new Error(`history cache crash regressions: ${failures.join(", ")}`);
console.log("history cache crash fixture passed");
