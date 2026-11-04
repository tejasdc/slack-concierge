import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync,mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const temporaryDirectories:string[]=[];
const launcher=process.argv[2]??join(import.meta.dir,'agent-claude-launch.ts');
function cleanup():void {
  for(const directory of temporaryDirectories.splice(0))rmSync(directory,{recursive:true,force:true});
}

async function launchDuringInstall(createExecutable:(directory:string)=>void,prepare?:(directory:string)=>void):Promise<string> {
  const directory=mkdtempSync(join(tmpdir(),'concierge-claude-install-'));
  temporaryDirectories.push(directory);
  prepare?.(directory);
  const environment={...process.env,PATH:directory};
  delete environment.CONCIERGE_CLAUDE_CODE_EXECUTABLE;
  const child=spawn(process.execPath,['run',launcher,'--version'],{
    env:environment,stdio:['ignore','pipe','pipe'],
  });
  let output='';
  let error='';
  const result=new Promise<{code:number|null}>(resolve=>{
    child.stdout.on('data',chunk=>{output+=chunk.toString();});
    child.stderr.on('data',chunk=>{
      error+=chunk.toString();
      if(error.includes('waiting for installation to finish.') && !created){
        created=true;
        createExecutable(directory);
      }
    });
    child.on('exit',code=>resolve({code}));
  });
  let created=false;
  const timeout=setTimeout(()=>child.kill('SIGKILL'),5_000);
  try {
    const {code}=await result;
    assert.equal(created,true,`launcher did not wait: ${error}`);
    assert.equal(code,0,error);
    assert.match(error,/waiting for installation to finish\./);
    return output.trim();
  } finally {clearTimeout(timeout);}
}

async function checkCreatedCommand():Promise<void> {
  const output=await launchDuringInstall(directory=>{
    const command=join(directory,'claude');
    writeFileSync(command,'#!/bin/sh\nprintf "fixture-version\\n"\n');
    chmodSync(command,0o755);
  });
  assert.equal(output,'fixture-version');
}

async function checkBrokenLink():Promise<void> {
  const targetDirectory=mkdtempSync(join(tmpdir(),'concierge-claude-target-'));
  temporaryDirectories.push(targetDirectory);
  const command=join(targetDirectory,'claude.exe');
  const output=await launchDuringInstall(candidateDirectory=>{
    // The missing link target lives outside PATH, just as npm's package does.
    writeFileSync(command,'#!/bin/sh\nprintf "target-version\\n"\n');
    chmodSync(command,0o755);
  },candidateDirectory=>symlinkSync(command,join(candidateDirectory,'claude')));
  assert.equal(output,'target-version');
}

async function checkMissingTargetParents():Promise<void> {
  const targetDirectory=mkdtempSync(join(tmpdir(),'concierge-claude-new-package-'));
  temporaryDirectories.push(targetDirectory);
  const command=join(targetDirectory,'package','bin','claude.exe');
  const output=await launchDuringInstall(()=>{
    mkdirSync(join(targetDirectory,'package','bin'),{recursive:true});
    writeFileSync(command,'#!/bin/sh\nprintf "nested-version\\n"\n');
    chmodSync(command,0o755);
  },candidateDirectory=>symlinkSync(command,join(candidateDirectory,'claude')));
  assert.equal(output,'nested-version');
}

try {
  await checkCreatedCommand();
  await checkBrokenLink();
  await checkMissingTargetParents();
  console.log('Claude Code launcher recovered after command creation, broken-link repair, and missing target parent creation.');
} finally {cleanup();}
