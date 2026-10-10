/** Current-install pre-effect check. Running agents keep their pinned semantic hooks,
 * while the machine wrapper reads this release's raw-live-copy policy on every command. */
import {toolCommand} from '../src/history-rewrite-policy';
import {liveStoreCopyRefusal} from '../src/live-store-copy-policy';
import {homedir} from 'node:os';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';

function canonical(path:string){try{return realpathSync(path);}catch{return resolve(path);}}
function inheritedLiveState(){
  const live=canonical(resolve(homedir(),'.local/state/concierge'));
  return [process.env.CONCIERGE_STATE_DIR,process.env.CONCIERGE_STATE_DB]
    .some(path=>typeof path==='string'&&path.length>0&&(canonical(path)===live||canonical(path).startsWith(live+'/')));
}
function privateEntrance(command:string){
  const path=process.env.CONCIERGE_PRIVATE_CODE_PATH;
  const bun=process.env.CONCIERGE_PRIVATE_CODE_BUN;
  if(!path||!bun||/[;&|<>`$()\n\r]/.test(command))return false;
  const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`^\\s*['"]?${escape(bun)}['"]?\\s+run\\s+['"]?${escape(path)}['"]?\\s+--\\s+\\S.*$`).test(command);
}
function routerCommand(command:string){
  if(/[;&|<>`$\n\r]/.test(command))return false;
  return /^\s*(?:(?:\/[^\s]+\/)?(?:bash|zsh|sh)\s+)?(?:[^\s]*\/)?router-actions\.sh(?:\s+.*)?$/.test(command);
}
function codeLaunch(command:string){
  // Literal shell commands and router CLI access remain available. These forms launch
  // code or package scripts that can import a ledger before a fixture creates scratch state.
  if(routerCommand(command))return false;
  const prefix='(?:[A-Za-z_]\\w*=\\S+\\s+|timeout\\s+\\d+\\s+|env\\s+|command\\s+)*';
  const entrance='(?:^|[;&|]\\s*|\\(\\s*)'+prefix;
  return new RegExp(entrance+'(?:[^\\s;&|]*\\/)?(?:bun|node|python[\\d.]*|npm|npx|tsx|ts-node)\\s+(?!--?(?:version|help|v|h)(?:\\s|$))\\S','i').test(command)
    || new RegExp(entrance+'(?:[^\\s;&|]*\\/)?(?:bash|zsh|sh)\\s+(?:-c\\b|[^\\s;&|]+\\.sh\\b)','i').test(command)
    || new RegExp(entrance+'(?:\\.\\.?\\/|\\/)[^\\s;&|]+\\.(?:sh|py|[cm]?[jt]s)\\b','i').test(command);
}

let hook: any;
try { hook=JSON.parse((await Bun.stdin.text())||'{}'); } catch { process.exit(0); }
const input=hook.tool_input??{};
const command=toolCommand(input);
const cwd=[input.workdir,hook.cwd].find(dir=>typeof dir==='string'&&dir)||process.cwd();
const reason=liveStoreCopyRefusal(command,cwd);
if(reason)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}})+'\n');
else if(command&&inheritedLiveState()&&codeLaunch(command)&&!privateEntrance(command)){
  const privatePath=process.env.CONCIERGE_PRIVATE_CODE_PATH;
  const bun=process.env.CONCIERGE_PRIVATE_CODE_BUN;
  const instruction=privatePath&&bun?`Run the check through: ${bun} run ${privatePath} -- <command> [args...]`:'Reinstall the Concierge machine hooks to get the private check command.';
  process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:`Refused: this code launch inherits the live Concierge ledger setting and could open it before creating scratch state. ${instruction}`}})+'\n');
}
