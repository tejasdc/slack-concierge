/** Exercises the installer's generated machine wrapper without touching machine settings. */
import {mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const root=mkdtempSync(join(tmpdir(),'concierge-live-copy-hook-'));
const bun=process.execPath;
function run(command:string,args:string[],env:Record<string,string>={}) {
  const result=Bun.spawnSync([command,...args],{env:{...process.env,...env},stdout:'pipe',stderr:'pipe'});
  if(result.exitCode!==0)throw new Error(`${command} exited ${result.exitCode}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
function check(condition:unknown,message:string):asserts condition {if(!condition)throw new Error(message);}
try {
  const installer=readFileSync(resolve(import.meta.dir,'../../scripts/install-codex-stop-hook.sh'),'utf8');
  const start=installer.indexOf('write_wrapper() {');
  const end=installer.indexOf('\n}\nwrite_wrapper "$hook"',start);
  check(start>=0&&end>start,'installer write_wrapper function not found');
  const wrapperFunction=installer.slice(start,end+2);
  const release=join(root,'release-a');
  const bot=join(release,'control/bot');
  const scriptDir=join(bot,'scripts');
  mkdirSync(scriptDir,{recursive:true});
  const guard=join(scriptDir,'live-store-copy-guard.js');
  const build=Bun.spawnSync([bun,'build',resolve(import.meta.dir,'live-store-copy-guard.ts'),'--target','bun','--outfile',guard],{stdout:'pipe',stderr:'pipe'});
  check(build.exitCode===0,`guard bundle failed: ${build.stderr.toString()}`);
  const current=join(root,'current');
  symlinkSync(release,current);
  const old=join(root,'old/bot');
  mkdirSync(join(old,'scripts'),{recursive:true});
  writeFileSync(join(old,'scripts/history-guard.js'),`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'PINNED_OLD_SEMANTIC'}})+'\\n');`);
  const destination=join(root,'concierge-history-guard');
  const template=join(root,'template');
  const env={marker:'# test installer',dispatch:'# dispatch: per-run v2',tmp:template,bot:join(current,'control/bot'),suffix:'js',current_guard:guard,state:join(root,'state'),bun,guard:destination};
  run('bash',['-c',`${wrapperFunction}\nwrite_wrapper "$guard" history-guard "fixture" "" ""`],env);
  const wrapper=readFileSync(destination,'utf8');
  check(wrapper.includes(guard),'wrapper did not pin physical guard path');
  const execute=(command:string)=>{
    const input=JSON.stringify({tool_name:'Bash',tool_input:{command},cwd:root});
    const inputPath=join(root,'hook-input.json');
    writeFileSync(inputPath,input);
    const output=Bun.spawnSync([destination],{env:{...process.env,CONCIERGE_ROUTER_BOT_DIR:old},stdin:Bun.file(inputPath),stdout:'pipe',stderr:'pipe'});
    check(output.exitCode===0,`wrapper failed: ${output.stderr.toString()}`);
    return JSON.parse(output.stdout.toString()).hookSpecificOutput;
  };
  check(execute('echo safe').additionalContext==='PINNED_OLD_SEMANTIC','benign command did not reach pinned semantic hook');
  const raw='sqlite3 /root/.local/state/'+'concierge/state.db "'+'.back'+'up /tmp/raw.db"';
  check(execute(raw).permissionDecision==='deny','current machine policy did not deny raw live copy');
  const releaseB=join(root,'release-b');
  mkdirSync(join(releaseB,'control/bot/scripts'),{recursive:true});
  renameSync(current,join(root,'former-current'));
  symlinkSync(releaseB,current);
  check(execute(raw).permissionDecision==='deny','rollback symlink lost installed guard');
  renameSync(guard,`${guard}.hidden`);
  check(execute('echo safe').permissionDecision==='deny','missing current guard did not fail closed');
  console.log('PASS actual generated wrapper: benign pinned dispatch, raw copy refusal, rollback pin, missing-guard denial');
} finally {rmSync(root,{recursive:true,force:true});}
