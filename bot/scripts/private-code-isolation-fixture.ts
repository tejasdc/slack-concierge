#!/usr/bin/env bun
/** Verifies the private-code boundary before application imports are permitted. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {privateCodeHomeMountArgs,privateCodeCommand,privateDatabaseCommand} from '../src/private-database-command';

assert.equal(process.env.CONCIERGE_PRIVATE_CODE_BOUNDARY_VERIFIED,'1',
  'Fixture must start only after the private-code preflight succeeds.');
assert.ok(['masked','absent'].includes(process.env.CONCIERGE_PRIVATE_DATABASE_MASK_VERIFIED??''),'canonical directory mask must be positively verified or absent');
assert.equal(process.env.HOME??null,JSON.parse(process.env.CONCIERGE_PRIVATE_CODE_HOME_ORIGINAL??'null'),
  'The process HOME value must remain unchanged.');
assert.equal(homedir(),process.env.HOME??homedir(),
  'The visible HOME path must still name the active home directory.');
const codexHome=join(homedir(),'.codex');
assert.ok(statSync(codexHome).isDirectory());
assert.deepEqual(readdirSync(codexHome),[],'Codex private data must be hidden before imports.');
for(const name of ['CONCIERGE_CODEX_APP_SERVER_SOCKET','CONCIERGE_CODEX_RUNNER','CONCIERGE_CODEX_EXECUTABLE',
  'CONCIERGE_CODEX_CLI','CONCIERGE_CODEX_BIN','CODEX_CLI','CODEX_HOME','CODEX_SYSTEM_DIR','CONCIERGE_CODEX_SYSTEM_DIR'])
  assert.equal(process.env[name],undefined,`Inherited Codex selector must be cleared: ${name}`);

const blocked=JSON.parse(process.env.CONCIERGE_PRIVATE_BLOCKED_EXECUTABLES??'[]') as string[];
assert.ok(blocked.length>0,'At least one service/process-control executable must be resolved and blocked.');
for(const executable of blocked){
  assert.ok(existsSync(executable),`Expected blocked executable path to remain present: ${executable}`);
  const attempt=spawnSync(executable,['--concierge-private-boundary-denial'],{encoding:'utf8',timeout:2_000});
  assert.equal(attempt.error,undefined,`Blocked executable launch must return normally: ${executable}`);
  assert.notEqual(attempt.status,0,`Blocked executable must refuse through the false replacement: ${executable}`);
  assert.equal(attempt.signal,null,`Blocked executable must not leave a child running: ${executable}`);
  assert.equal(attempt.stdout,'');
  assert.equal(attempt.stderr,'');
}
const unmountAttempt=spawnSync('/usr/bin/umount',[codexHome],{encoding:'utf8',timeout:2_000});
assert.equal(unmountAttempt.error,undefined,'The capability refusal probe must complete.');
assert.notEqual(unmountAttempt.status,0,'The fixture must not be able to uncover Codex data by unmounting its mask.');
assert.deepEqual(readdirSync(codexHome),[],'The private Codex mount remains intact after the refusal probe.');
const effectiveCapabilities=BigInt(`0x${/CapEff:\s+([0-9a-f]+)/i.exec(await Bun.file('/proc/self/status').text())?.[1]??'0'}`);
assert.notEqual(effectiveCapabilities&(1n<<21n),0n,'The fixture retains its existing private-namespace mount capability; inherited masks provide the refusal.');

// The private-code launcher sets this only after its mount, executable, env and
// namespace checks. Fixture-owned endpoints may be introduced after this point.
const fixtureSocket=join(process.env.CONCIERGE_PRIVATE_CODE_STATE??'', 'fixture-owned.sock');
process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET=fixtureSocket;
assert.equal(process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET,fixtureSocket);
delete process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET;
// Initial emptiness proves the root hides real data. Subsequent fixture-owned
// files do not change that exact mounted object or require another user namespace.
const ownedCodexMarker=join(codexHome,'fixture-owned-reuse-marker');
writeFileSync(ownedCodexMarker,'owned-only');
try{
 const original=[process.execPath,'-e','process.exit(0)'];
 const fixtureContext={...process.env,CONCIERGE_CODEX_APP_SERVER_SOCKET:fixtureSocket};
 const reused=privateCodeCommand(original,fixtureContext);
 try{assert.deepEqual(reused.command,original,'exact root boundary is reused after owned writes');
  assert.equal(reused.environment.CONCIERGE_CODEX_APP_SERVER_SOCKET,fixtureSocket,'verified descendants retain fixture-owned endpoint context');}finally{reused.cleanup();}
 assert.deepEqual(privateDatabaseCommand(original,true),original);
 assert.deepEqual(privateDatabaseCommand(original,false),original);
}finally{rmSync(ownedCodexMarker);}
const privateState=process.env.CONCIERGE_PRIVATE_CODE_STATE;
assert.ok(privateState);
const absentHome=join(privateState,'home-without-codex');
mkdirSync(absentHome,{recursive:true});
assert.equal(existsSync(join(absentHome,'.codex')),false);
const absentHomeMounts=privateCodeHomeMountArgs(absentHome);
try{
  const probe=spawnSync('/usr/bin/bwrap',['--die-with-parent','--bind','/','/','--dev','/dev',
    ...absentHomeMounts.args,'--','/usr/bin/python3','-I','-S','-c',
    'import os,sys; p=sys.argv[1]+"/.codex"; mounts=[x.split() for x in open("/proc/self/mountinfo")]; assert os.path.isdir(p) and not os.listdir(p); assert any(x[4]==p and x[x.index("-")+1]=="tmpfs" for x in mounts)',absentHome],
    {encoding:'utf8',timeout:3_000});
  assert.equal(probe.error,undefined,`Absent-home overlay probe starts: ${probe.error}`);
  assert.equal(probe.status,0,`Absent-home overlay probe passes: ${probe.stderr}`);
  assert.equal(existsSync(join(absentHome,'.codex')),false,'Private .codex mountpoint must not create a host-side directory.');
}finally{absentHomeMounts.cleanup();rmSync(absentHome,{recursive:true,force:true});}
const maskHome=join(privateState,'home-with-owned-protected-masks');
const maskedDirectory=join(maskHome,'.local/state/concierge'),maskedBacking=join(maskHome,'workspace/owned-backing.img');
mkdirSync(maskedDirectory,{recursive:true});mkdirSync(join(maskHome,'workspace'));
writeFileSync(join(maskedDirectory,'owned.sentinel'),'owned fixture data that must be hidden');
writeFileSync(maskedBacking,'owned backing data that must be hidden');
const nullIdentity=statSync('/dev/null'),maskHomeMounts=privateCodeHomeMountArgs(maskHome);
try{
 const protectedMasks=['--tmpfs',maskedDirectory,'--chmod','000',maskedDirectory,'--ro-bind','/dev/null',maskedBacking];
 const proofArgs=['--','/usr/bin/python3','-I','-S','-c',
  ['import os,stat,sys,json','d,b=sys.argv[1:3]','expected=tuple(map(int,sys.argv[3:5]))',
   'ds=os.stat(d); bs=os.stat(b)',
   'print(json.dumps({"directoryMode":oct(stat.S_IMODE(ds.st_mode)),"backingIdentity":[bs.st_dev,bs.st_ino],"backingIsCharacter":stat.S_ISCHR(bs.st_mode)}),flush=True)',
   'assert stat.S_IMODE(ds.st_mode)==0',
   'assert (bs.st_dev,bs.st_ino)==expected and stat.S_ISCHR(bs.st_mode)',
   'try: assert open(b,"rb").read()==b""','except PermissionError: pass',
   'blocked=False','try: open(d+"/owned.sentinel","rb").read()',
   'except (PermissionError,FileNotFoundError): blocked=True','assert blocked',
   'rows=[r.split() for r in open("/proc/self/mountinfo")]',
   'assert any(r[4]==d and r[r.index("-")+1]=="tmpfs" for r in rows)',
   'assert any(r[4]==b for r in rows)','print("owned-directory-and-backing-masks-preserved")'].join('\n'),
  maskedDirectory,maskedBacking,String(nullIdentity.dev),String(nullIdentity.ino)];
 const old=spawnSync('/usr/bin/bwrap',['--die-with-parent','--bind','/','/','--dev','/dev',...protectedMasks,...maskHomeMounts.args,...proofArgs],{encoding:'utf8',timeout:3_000});
 assert.equal(old.error,undefined);assert.notEqual(old.status,0,'old mask-before-layout ordering must fail the owned protection proof');
 const oldMetadata=JSON.parse(old.stdout.split('\n').find(line=>line.startsWith('{'))!);
 assert.notEqual(oldMetadata.directoryMode,'0o0');assert.equal(oldMetadata.backingIsCharacter,false);
 assert.notDeepEqual(oldMetadata.backingIdentity,[nullIdentity.dev,nullIdentity.ino]);
 console.log(JSON.stringify({fixture:'private-code-owned-mask-negative',oldOrderingAfterHomeRebind:oldMetadata,childExit:old.status,scope:'owned scratch sentinel only; no production data read'}));
 const proof=spawnSync('/usr/bin/bwrap',['--die-with-parent','--bind','/','/','--dev','/dev',...maskHomeMounts.args,...protectedMasks,...proofArgs],{encoding:'utf8',timeout:3_000});
 assert.equal(proof.error,undefined);assert.equal(proof.status,0,proof.stderr);
 assert.match(proof.stdout,/owned-directory-and-backing-masks-preserved/);
}finally{maskHomeMounts.cleanup();rmSync(maskHome,{recursive:true,force:true});}
console.log(JSON.stringify({
  boundaryVerified:true,
  homeUnchanged:true,
  codexHomeHidden:true,
  pidNamespace:process.pid,
  procPid1Visible:existsSync('/proc/1/status'),
  blockedExecutables:blocked.length,
  denialAttempts:blocked.length,
  unmountRefused:true,
  privateNamespaceMountCapabilityRetained:true,
  absentCodexHomeDoesNotCreateHostPath:true,
  protectedDirectoryAndBackingMasksSurviveHomeRebind:true,
  oldMaskBeforeHomeRebindRejected:true,
  fixtureEndpointAfterBarrier:true,
}));
