#!/usr/bin/env bun
/** Real CLI preflight, with disposable homes and no provider request or live trust edits. */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {trustedCodexExecCommand} from '../src/trusted-codex-exec';

const binary=resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: bun bot/scripts/codex-exec-trust-acceptance.ts /absolute/path/to/codex');
const version=spawnSync(binary,['--version'],{encoding:'utf8'});
if(version.status!==0)throw new Error(version.stderr||'Cannot read Codex version.');
const help=spawnSync(binary,['exec','--help'],{encoding:'utf8'});
if(help.status!==0)throw new Error(help.stderr||'Cannot read Codex help.');
const supportsTrust=/^\s+--trust\s*$/m.test(help.stdout);
const rows:object[]=[];
for(const mode of ['raw','fresh','resume','explicit-untrusted'] as const){
  const root=mkdtempSync(join(tmpdir(),'concierge-exec-trust-'));
  try{
    const cwd=join(root,'project'),home=join(root,'home');
    mkdirSync(join(cwd,'.codex'),{recursive:true});mkdirSync(home);
    if(spawnSync('git',['init','-q',cwd]).status!==0)throw new Error('Cannot create disposable project.');
    // A loaded project layer produces this parse error. Otherwise the deliberately
    // absent model provider fails before any authentication or model request.
    writeFileSync(join(cwd,'.codex/config.toml'),'concierge_config_marker = [\n');
    if(mode==='explicit-untrusted')writeFileSync(join(home,'config.toml'),
      `[projects.${JSON.stringify(cwd)}]\ntrust_level = "untrusted"\n`);
    const args=[...(mode==='resume'?['resume']:['-s','workspace-write']),'-m','gpt-6.1-sol',
      '-c','model_provider="concierge_probe_missing"','--ephemeral',
      ...(mode==='resume'?['00000000-0000-0000-0000-000000000001']:[]),'Reply OK.'];
    const command=mode==='raw'?[binary,'exec',...args]:trustedCodexExecCommand(binary,args);
    const result=spawnSync(command[0]!,command.slice(1),{cwd,env:{...process.env,CODEX_HOME:home},
      input:'',encoding:'utf8',timeout:15_000,killSignal:'SIGKILL'});
    if(result.error||result.status!==1)throw new Error(`${mode}: unexpected CLI result: ${result.error??result.stderr}`);
    const projectLoaded=result.stderr.includes('concierge_config_marker');
    const expectedLoaded=supportsTrust&&(mode==='fresh'||mode==='resume');
    if(projectLoaded!==expectedLoaded)throw new Error(`${mode}: project loading mismatch: ${result.stderr}`);
    const explicitRefusal=supportsTrust&&mode==='explicit-untrusted'&&result.stderr.includes('is marked as untrusted');
    if(!projectLoaded&&!explicitRefusal&&!result.stderr.includes('Model provider `concierge_probe_missing` not found'))
      throw new Error(`${mode}: preflight did not reach its expected stop: ${result.stderr}`);
    const saved=existsSync(join(home,'config.toml'))?readFileSync(join(home,'config.toml'),'utf8'):'';
    if(expectedLoaded&&!saved.includes('trust_level = "trusted"'))throw new Error(`${mode}: trust was not saved.`);
    if(mode==='raw'&&saved)throw new Error('Raw isolated run saved trust.');
    if(mode==='explicit-untrusted'&&(!saved.includes('trust_level = "untrusted"')||saved.includes('trust_level = "trusted"')))
      throw new Error('Explicit untrusted choice changed.');
    rows.push({mode,projectLoaded,explicitRefusal,savedTrust:mode==='explicit-untrusted'?'untrusted':saved?'trusted':'none',exit:result.status});
  }finally{rmSync(root,{recursive:true,force:true});}
}
console.log(JSON.stringify({version:version.stdout.trim(),supportsTrust,providerRequests:0,rows},null,2));
