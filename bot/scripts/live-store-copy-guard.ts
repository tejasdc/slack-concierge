/** Current-install pre-effect check. Running agents keep their pinned semantic hooks,
 * while the machine wrapper reads this release's raw-live-copy policy on every command. */
import {toolCommand} from '../src/history-rewrite-policy';
import {liveStoreCopyRefusal} from '../src/live-store-copy-policy';

let hook: any;
try { hook=JSON.parse((await Bun.stdin.text())||'{}'); } catch { process.exit(0); }
const input=hook.tool_input??{};
const command=toolCommand(input);
const cwd=[input.workdir,hook.cwd].find(dir=>typeof dir==='string'&&dir)||process.cwd();
const reason=liveStoreCopyRefusal(command,cwd);
if(reason)process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}})+'\n');
