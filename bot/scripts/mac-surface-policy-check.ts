import assert from 'node:assert/strict';
import {macSurfaceRefusal} from '../src/mac-surface-policy';
import {parseMachineNeed} from '../src/machine-need';

const check=(command:string,need='',platform='darwin',toolName='Bash')=>
  macSurfaceRefusal({command,need,platform,toolName,toolInput:{command}});

assert.equal(parseMachineNeed('ios-native:iPhone Safari selection handles after touch').kind,'ios-native');
assert.throws(()=>parseMachineNeed('browser:phone-size layout'));
assert.throws(()=>parseMachineNeed('Simulator'));
assert.match(check('agent-browser open https://thnkr.ing')??'',/server/);
assert.match(check('npx agent-browser open https://thnkr.ing')??'',/server/);
assert.match(check('open -a "Google Chrome" https://thnkr.ing','ios-native')??'',/refused/);
assert.match(check('open -a Simulator')??'',/refused/);
assert.match(check('xcrun simctl boot ABC')??'',/accepted Mac-only iOS need/);
assert.equal(check('xcrun simctl boot ABC','ios-native'),null);
assert.match(check('open -a Xcode')??'',/foreground/);
assert.equal(check('open -g -a Xcode','mac-app'),null);
assert.equal(check('rg -n Chrome docs'),null);
assert.match(check('rg -n Chrome docs | agent-browser open https://thnkr.ing')??'',/server/);
assert.equal(check('agent-browser open https://thnkr.ing','','linux'),null);
assert.match(macSurfaceRefusal({command:null,need:'ios-native',platform:'darwin',toolName:'mcp__plugin_playwright_playwright__browser_run_code_unsafe',toolInput:{code:'async page => page.goto("https://thnkr.ing")'}})??'',/server/);
assert.match(check('ssh tejasdc@100.90.183.122 open -a "Google Chrome" https://thnkr.ing','','linux')??'',/refused/);
assert.equal(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const patch="Google Chrome"; await tools.apply_patch(patch)'}}),null);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.exec_command({cmd:"agent-browser open https://thnkr.ing"})'}})??'',/server/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__plugin_playwright_playwright__browser_navigate({url:"https://thnkr.ing"})'}})??'',/server/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const cmd="open -a Google Chrome https://thnkr.ing"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const cmd="xcrun simctl boot ABC"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const metadata={cmd:"rg docs"}; const cmd="open -a Google Chrome"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
console.log('Mac surface policy refused the unsafe actions and kept server and read-only work available.');
