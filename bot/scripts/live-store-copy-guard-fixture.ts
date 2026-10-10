/** Exercises the installer's generated machine wrapper without touching machine settings. */
import {mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {homedir} from 'node:os';
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
  const privateCommand=join(scriptDir,'private-code-command.js');
  const privateBuild=Bun.spawnSync([bun,'build',resolve(import.meta.dir,'private-code-command.ts'),'--target','bun','--outfile',privateCommand],{stdout:'pipe',stderr:'pipe'});
  check(privateBuild.exitCode===0,`private command bundle failed: ${privateBuild.stderr.toString()}`);
  const current=join(root,'current');
  symlinkSync(release,current);
  const old=join(root,'old/bot');
  mkdirSync(join(old,'scripts'),{recursive:true});
  writeFileSync(join(old,'scripts/history-guard.js'),`process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:'PINNED_OLD_SEMANTIC'}})+'\\n');`);
  const destination=join(root,'concierge-history-guard');
  const template=join(root,'template');
  const env={marker:'# test installer',dispatch:'# dispatch: per-run v2',tmp:template,bot:join(current,'control/bot'),suffix:'js',current_guard:guard,current_private:privateCommand,state:join(root,'state'),bun,guard:destination};
  run('bash',['-c',`${wrapperFunction}\nwrite_wrapper "$guard" history-guard "fixture" "" ""`],env);
  const wrapper=readFileSync(destination,'utf8');
  check(wrapper.includes(guard),'wrapper did not pin physical guard path');
  const execute=(command:string)=>{
    const input=JSON.stringify({tool_name:'Bash',tool_input:{command},cwd:root});
    const inputPath=join(root,'hook-input.json');
    writeFileSync(inputPath,input);
    const output=Bun.spawnSync([destination],{env:{...process.env,CONCIERGE_ROUTER_BOT_DIR:old,CONCIERGE_STATE_DIR:join(homedir(),'.local/state/'+'concierge')},stdin:Bun.file(inputPath),stdout:'pipe',stderr:'pipe'});
    check(output.exitCode===0,`wrapper failed: ${output.stderr.toString()}`);
    return JSON.parse(output.stdout.toString()).hookSpecificOutput;
  };
  check(execute('echo safe').additionalContext==='PINNED_OLD_SEMANTIC','benign command did not reach pinned semantic hook');
  check(execute('bun run build').permissionDecision==='deny','inherited live build was not refused');
  check(execute('timeout 900 bun run build').permissionDecision==='deny','observed timed build was not refused');
  check(execute('cd /tmp/main-check/bot && timeout 90 bun run scripts/archive-search-retention-check.ts > /tmp/main-archive.log 2>&1').permissionDecision==='deny','observed timed archive check was not refused');
  check(execute('cd /tmp/main-check/bot && PATH=/root/.bun/bin:$PATH timeout 120 bun run scripts/archive-search-retention-check.ts > /tmp/main-archive.log 2>&1').permissionDecision==='deny','observed PATH-prefixed timed archive check was not refused');
  const observed='cd /root/workspace/slack-concierge && git fetch -q && git worktree add -q /tmp/main-check origin/main 2>/dev/null; cd /tmp/main-check/bot && ln -sf /root/workspace/slack-concierge/.wt/ledger-own-fs/bot/node_modules node_modules && PATH=/root/.bun/bin:$PATH timeout 120 bun run scripts/archive-search-retention-check.ts > /tmp/main-archive.log 2>&1; echo "main: $?"; cd /root/workspace/slack-concierge/.wt/ledger-own-fs/bot && PATH=/root/.bun/bin:$PATH timeout 120 bun run scripts/archive-search-retention-check.ts > /tmp/mine-archive.log 2>&1; echo "mine: $?"; grep -v "^ *[0-9]* |" /tmp/mine-archive.log | grep -iE "error|refus|ledger link" | head -5';
  check(execute(observed).permissionDecision==='deny','literal observed multi-command launch was not refused');
  check(execute('bun run scripts/archive-search-retention-check.ts').permissionDecision==='deny','direct code check was not refused');
  check(execute('python3 -c "import json; print(json.loads(\'{}\'))"').additionalContext==='PINNED_OLD_SEMANTIC','Python JSON parsing was refused');
  check(execute('node -e "JSON.parse(\'{}\')"').additionalContext==='PINNED_OLD_SEMANTIC','Node JSON parsing was refused');
  check(execute('bun -e "JSON.parse(\'{}\')"').additionalContext==='PINNED_OLD_SEMANTIC','Bun inline parsing was refused');
  check(execute('/root/.local/bin/router-actions.sh sessions search --source-input example --source-run example -- x | python3 -c "import json,sys; print(json.load(sys.stdin))"').additionalContext==='PINNED_OLD_SEMANTIC','piped router JSON parsing was refused');
  check(execute('sqlite3 -readonly "file:/root/.local/state/concierge/state.db?mode=ro" "SELECT 1"').additionalContext==='PINNED_OLD_SEMANTIC','read-only live query was refused');
  check(execute('/root/workspace/slack-concierge/systemd/router-actions.sh sessions list').additionalContext==='PINNED_OLD_SEMANTIC','router CLI was refused');
  check(execute(`${bun} run ${privateCommand} -- /usr/bin/env`).additionalContext==='PINNED_OLD_SEMANTIC','sealed private command was refused');
  const privateEnv=run(bun,['run',privateCommand,'--','/usr/bin/env'],{CONCIERGE_STATE_DIR:join(homedir(),'.local/state/'+'concierge')});
  check(/CONCIERGE_STATE_DIR=\/tmp\/concierge-private-code-/.test(privateEnv),'private command did not replace inherited live state');
  const canonical=join(homedir(),'.local/state/'+'concierge');
  const probe=`const fs=require('node:fs');try{fs.accessSync(${JSON.stringify(canonical)},fs.constants.R_OK|fs.constants.X_OK);process.exit(11)}catch(error){if(error.code==='EACCES')console.log('hidden');else throw error}`;
  check(run(bun,['run',privateCommand,'--',bun,'-e',probe],{CONCIERGE_STATE_DIR:canonical}).trim()==='hidden','private child could access canonical live state');
  const raw='sqlite3 /root/.local/state/'+'concierge/state.db "'+'.back'+'up /tmp/raw.db"';
  check(execute(raw).permissionDecision==='deny','current machine policy did not deny raw live copy');
  const releaseB=join(root,'release-b');
  mkdirSync(join(releaseB,'control/bot/scripts'),{recursive:true});
  renameSync(current,join(root,'former-current'));
  symlinkSync(releaseB,current);
  check(execute(raw).permissionDecision==='deny','rollback symlink lost installed guard');
  renameSync(guard,`${guard}.hidden`);
  check(execute('echo safe').permissionDecision==='deny','missing current guard did not fail closed');
  console.log('PASS generated wrapper: pinned dispatch, ordinary parsing and read-only queries, inherited-live package check refusal, private entrance, raw copy refusal, rollback pin, missing-guard denial');
} finally {rmSync(root,{recursive:true,force:true});}
