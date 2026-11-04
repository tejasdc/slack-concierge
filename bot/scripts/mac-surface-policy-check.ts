import assert from 'node:assert/strict';
import {macSurfaceRefusal} from '../src/mac-surface-policy';
import {parseMachineNeed} from '../src/machine-need';
import {deviceQuestionNamesPhysicalPrerequisite} from '../src/agent-reachable-app-question';

const check=(command:string,need='',platform='darwin',toolName='Bash')=>
  macSurfaceRefusal({command,need,platform,toolName,toolInput:{command}});

assert.equal(parseMachineNeed('ios-native:iPhone Safari selection handles after touch').kind,'ios-native');
assert.throws(()=>parseMachineNeed('browser:phone-size layout'));
assert.throws(()=>parseMachineNeed('provider-renewal:claimed by an ordinary agent'));
assert.throws(()=>parseMachineNeed('browser-fallback:Server portal blocked after login'));
assert.equal(parseMachineNeed('browser-fallback:Server portal blocked after login',{
  url:'https://bosse.managebuilding.com/Resident/portal/login',
  failure:'Observed a location-specific access refusal after the server sign-in completed.'
}).serverAttempt?.url,'https://bosse.managebuilding.com');
assert.throws(()=>parseMachineNeed('browser-fallback:Server portal blocked after login',{
  url:'https://bosse.managebuilding.com',failure:'it failed'
}));
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
assert.match(macSurfaceRefusal({command:null,need:'browser-fallback',platform:'darwin',toolName:'mcp__chrome_devtools__navigate_page',toolInput:{url:'https://bosse.managebuilding.com'}})??'',/refused/);
assert.match(macSurfaceRefusal({command:null,need:'browser-fallback',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__chrome_devtools__navigate_page({url:"https://bosse.managebuilding.com"})'}})??'',/refused/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getState()'}})??'',/accepted Mac/);
assert.match(macSurfaceRefusal({command:null,need:'mac-file',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Voice Memos")'}})??'',/accepted Mac/);
assert.equal(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Voice Memos")'}}),null);
const webAppNeed={kind:'mac-app',why:'Inspect the already-open thnkr.ing web app com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792 page faf63877-6536-4ac6-86e9-5d63e03d3369, directly authorized by Tejas.',humanInputId:'f66f15dd-e251-4537-a9cd-347d0548434b'};
const canvasNeed={...webAppNeed,humanInputId:'capture:7bad480ccf4350922acb3ac750cc0ba0b7a990f596acd92b5fe98403f6f0e7a0'};
const webInspectorNeed={...webAppNeed,why:`${webAppNeed.why} Open Web Inspector on that exact app to inspect reachable unsaved editor state.`};
const webInspectorOpen=`var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.pressKey('alt+super+i')`;
const webAppCall="let app = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792');";
assert.equal(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}}),null);
assert.equal(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await app.getAXState()'}}),null);
for(const code of [webAppCall,...['getAXState','getAXStateAndScreenshot','getScreenshot'].map(method=>
  `var thnkrCanvasInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrCanvasInspectionApp.${method}()` )])
  assert.equal(macSurfaceRefusal({command:null,need:canvasNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),null);
for(const code of ["await cua.getApp('Safari')","await cua.getApp('Google Chrome')",'await cua.getState()',
  'await app.getAXState()','await app.getScreenshot()','await app.click(42)',"await app.pressKey('super+r')",
  `${webAppCall} await app.getScreenshot()`,
  "var thnkrCanvasInspectionApp = await cua.getApp('Safari'); await thnkrCanvasInspectionApp.getAXState()",
  "var thnkrCanvasInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrCanvasInspectionApp.click(42)"])
  assert.ok(macSurfaceRefusal({command:null,need:canvasNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
for(const need of [{...canvasNeed,why:'Inspect the exact app without a page ID'},
  {...canvasNeed,why:canvasNeed.why.replace('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792','com.apple.Safari.WebApp.other')},
  {...canvasNeed,humanInputId:'capture:another-human-input'}])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}}));
assert.equal(macSurfaceRefusal({command:null,need:webInspectorNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webInspectorOpen}}),null);
assert.ok(macSurfaceRefusal({command:null,need:{...canvasNeed,why:`${canvasNeed.why} Open Web Inspector.`},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webInspectorOpen}}));
assert.equal(macSurfaceRefusal({command:null,need:webInspectorNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:`var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.pressKey("alt+super+i")`}}),null);
for(const need of [webAppNeed,{...webInspectorNeed,humanInputId:'other-human'},{...webInspectorNeed,why:'Open Web Inspector'}])
  assert.match(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webInspectorOpen}})??'',/exact|only|authorization|bundle|page/i);
for(const code of [
  `var thnkrInspectorApp = await cua.getApp('Safari'); await thnkrInspectorApp.pressKey('alt+super+i')`,
  `var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.pressKey('super+r')`,
  `var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.click(42)`,
  `${webInspectorOpen}; await thnkrInspectorApp.getAXState()`,
  `await app.pressKey('alt+super+i')`,
  `let app = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await app.pressKey('alt+super+i')`,
]) assert.ok(macSurfaceRefusal({command:null,need:webInspectorNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}));
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getState()'}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Firefox")'}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:{...webAppNeed,why:'Inspect the Mac app'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Firefox")'}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}})??'',/exact bundle and page IDs/);
assert.match(macSurfaceRefusal({command:null,need:{kind:'mac-app',why:'Inspect the already-open thnkr.ing app com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}})??'',/exact bundle and page IDs/);
assert.match(macSurfaceRefusal({command:null,need:{...webAppNeed,humanInputId:'another-human-request'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}})??'',/exact bundle and page IDs/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Safari')"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Thinkering')"}})??'',/personal browser/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Thinkering')"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall+" await cua.getApp('Safari');"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'functions.exec',toolInput:{code:`await tools.mcp__cua_repl__js({code:${JSON.stringify(webAppCall)}})`}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Google Chrome")'}})??'',/personal browser/);
assert.equal(macSurfaceRefusal({command:null,need:'provider-renewal',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Google Chrome")'}}),null);
assert.match(macSurfaceRefusal({command:null,need:'provider-renewal',platform:'darwin',toolName:'mcp__claude-in-chrome__navigate',toolInput:{url:'https://claude.ai'}})??'',/personal Chrome/);
assert.equal(macSurfaceRefusal({command:null,need:'mac-screen',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getState()'}}),null);
assert.match(macSurfaceRefusal({command:null,need:'browser-fallback',platform:'darwin',toolName:'mcp__claude-in-chrome__navigate',toolInput:{url:'https://bosse.managebuilding.com'}})??'',/personal Chrome/);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__claude-in-chrome__read_page',toolInput:{}})??'',/personal Chrome/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__cua_repl__js({code:"await cua.getState()"})'}})??'',/accepted Mac/);
assert.equal(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__cua_repl__js({code:"await cua.getApp(\\"Voice Memos\\")"})'}}),null);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__claude_in_chrome__navigate({url:"https://bosse.managebuilding.com"})'}})??'',/personal Chrome/);
assert.equal(check('bun run bot/scripts/mac-browser-fallback.sh open https://bosse.managebuilding.com','browser-fallback'),null);
assert.match(check('ssh tejasdc@100.90.183.122 open -a "Google Chrome" https://thnkr.ing','','linux')??'',/refused/);
assert.match(check('ssh tejasdc@100.90.183.122 agent-browser open https://thnkr.ing','','linux')??'',/recorded browser-fallback/);
assert.equal(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const patch="Google Chrome"; await tools.apply_patch(patch)'}}),null);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.exec_command({cmd:"agent-browser open https://thnkr.ing"})'}})??'',/server/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__plugin_playwright_playwright__browser_navigate({url:"https://thnkr.ing"})'}})??'',/server/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const cmd="open -a Google Chrome https://thnkr.ing"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const cmd="xcrun simctl boot ABC"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
assert.match(macSurfaceRefusal({command:null,need:'',platform:'darwin',toolName:'functions.exec',toolInput:{code:'const metadata={cmd:"rg docs"}; const cmd="open -a Google Chrome"; await tools.exec_command({cmd})'}})??'',/Dynamic shell/);
for(const question of ['Can you click the button in the app?','Can you open Safari?','Can you enter the code in the web app?',
  'Can you sign in to the website?','Can you recover the eight notes in thnkr.ing?',
  'Can you unlock the Mac and copy the notes from the app?','Can you unlock the Mac and copy the eight notes?',
  'Can you unlock your Mac, then click Save?','Can you unlock your physical Mac and click Save?',
  'Can you unlock the Mac and scroll the app?',
  'Can you unlock your Mac so I can inspect the app? Then can you click Save?',
  'Can you unlock the Mac so the agent can continue? Can you copy the eight notes?'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),false,question);
for(const question of ['Can you unlock your Mac so the agent can continue?',
  'Can you unlock the Mac so the agent can read the app?',
  'Can you unlock your physical Mac?','Can you take a photo of the paper?'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),true,question);
console.log('Mac surface policy refused the unsafe actions and kept server and read-only work available.');
