import assert from 'node:assert/strict';
import {macSurfaceRefusal,RETIREMENT_FILE_MENU_PROGRAM,RETIREMENT_NEW_WINDOW_PROGRAM,UPDATE_BOUNDED_AX_PROGRAM,UPDATE_WORKSPACE_COMMAND,UPDATE_FIRST_TAP_COMMAND} from '../src/mac-surface-policy';
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
const webAppNeed={kind:'mac-app',why:'Inspect the already-open thnkr.ing web app com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792 page faf63877-6536-4ac6-86e9-5d63e03d3369, directly authorized by Tejas.',humanInputId:'f66f15dd-e251-4537-a9cd-347d0548434b',effectScope:'work'};
const updateNeed={kind:'mac-app',why:'Inspect exact bundle com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792 page faf63877-6536-4ac6-86e9-5d63e03d3369 and install ready 0d90186f update safely',effectScope:'work',updateAuthorization:true};
const currentUpdateNeed={kind:'mac-app',why:'Open Workspace menu in com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792 current board 94504c60-2b34-4fda-ba23-c20a6a71d7df',effectScope:'work',updateAuthorization:true};
const currentTapNeed={...currentUpdateNeed,why:currentUpdateNeed.why.replace('Open Workspace menu','Press Update now once')};
const nativeCall=(command:string,need:typeof currentUpdateNeed)=>
  macSurfaceRefusal({command,need,platform:'darwin',toolName:'exec_command',toolInput:{cmd:command}});
assert.equal(nativeCall(UPDATE_WORKSPACE_COMMAND,currentUpdateNeed),null);
assert.equal(nativeCall(UPDATE_FIRST_TAP_COMMAND,currentTapNeed),null);
for(const need of [{...currentUpdateNeed,effectScope:'informational'},
  {...currentUpdateNeed,updateAuthorization:false},
  {...currentUpdateNeed,why:currentUpdateNeed.why.replace('94504c60-2b34-4fda-ba23-c20a6a71d7df','other board')},
  {...currentUpdateNeed,why:currentUpdateNeed.why.replace('Workspace menu','other menu')}])
  assert.ok(nativeCall(UPDATE_WORKSPACE_COMMAND,need));
assert.ok(nativeCall(UPDATE_FIRST_TAP_COMMAND,currentUpdateNeed));
assert.ok(nativeCall(UPDATE_WORKSPACE_COMMAND,currentTapNeed));
assert.ok(nativeCall(`${UPDATE_WORKSPACE_COMMAND}; /usr/bin/open -a Safari`,currentUpdateNeed));
assert.ok(nativeCall(UPDATE_WORKSPACE_COMMAND.replace('open-workspace','update-now'),currentUpdateNeed));
const helperPath='"$CONCIERGE_ROUTER_BOT_DIR/scripts/mac-update-ax.swift"';
for(const command of [
  `shasum -a 256 ${helperPath}`,
  `stat -f %Sp ${helperPath}`,
  `swiftc -typecheck ${helperPath}`,
]) {
  assert.equal(check(command,'mac-file'),null);
  assert.ok(check(`${command}; ${UPDATE_WORKSPACE_COMMAND}`,'mac-file'));
}
assert.ok(check(`swift ${helperPath} update-now`,'mac-file'));
assert.equal(macSurfaceRefusal({command:null,need:currentUpdateNeed,platform:'darwin',toolName:'functions.exec',
  toolInput:{code:`const r=await tools.exec_command({cmd:'${UPDATE_WORKSPACE_COMMAND}'});text(r.output);`}}),null);
const updateCall='var thnkrUpdateInspectionApp = await cua.getApp("com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792"); await thnkrUpdateInspectionApp.getAXStateAndScreenshot()';
assert.equal(macSurfaceRefusal({command:null,need:updateNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:updateCall}}),null);
assert.equal(macSurfaceRefusal({command:null,need:updateNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:UPDATE_BOUNDED_AX_PROGRAM}}),null);
for(const need of [{...updateNeed,updateAuthorization:false},{...updateNeed,effectScope:'informational'},{...updateNeed,why:updateNeed.why.replace('0d90186f','other build')},webAppNeed])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:UPDATE_BOUNDED_AX_PROGRAM}}));
for(const code of [UPDATE_BOUNDED_AX_PROGRAM.replace('getAXState({emit:false,disableDiffing:true})','getAXState()'),
  UPDATE_BOUNDED_AX_PROGRAM.replace('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792','Safari'),
  `${UPDATE_BOUNDED_AX_PROGRAM}\nawait cua.getApp('Safari');`])
  assert.ok(macSurfaceRefusal({command:null,need:updateNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}));
{
  const privateDraft='private draft words '.repeat(20000);
  const state=`Window: "thnkr.ing", App: Thinkering.\n0 standard window thnkr.ing, ID: WebAppWindow-Thinkering\nURL: https://thnkr.ing/boards?board=94504c60\n1 Update now\n2 Update anyway\n3 Unsaved note ${privateDraft}\n4 Recording\n0d90186f`;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const emitted:string[]=[];
  const appOptions:unknown[]=[];
  const outputResult=await new AsyncFunction('cua','nodeRepl',UPDATE_BOUNDED_AX_PROGRAM)(
    {getApp:async(_bundle:string,options:unknown)=>{appOptions.push(options);return {getAXState:async()=>state}}},
    {write:(value:string)=>emitted.push(value)});
  assert.equal(outputResult,undefined);
  assert.deepEqual(appOptions,[{emit:false}]);
  assert.equal(emitted.length,1);
  const output=JSON.parse(emitted[0]);
  assert.deepEqual(output.urls,['https://thnkr.ing/boards?board=94504c60']);
  assert.equal(output.windowCount,1);
  assert.equal(output.updateNowCount,1);
  assert.equal(output.updateAnywayCount,1);
  assert.equal(output.unsavedCount,1);
  assert.equal(output.offerRevisionCount,1);
  assert.ok(JSON.stringify(output).length<1000);
  assert.ok(!JSON.stringify(output).includes(privateDraft.slice(0,100)));
}
const formerUpdateProgram='var thnkrUpdateApp = await cua.getApp("com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792"); var state = await thnkrUpdateApp.getAXState({disableDiffing:true}); await thnkrUpdateApp.click(3);';
assert.match(macSurfaceRefusal({command:null,need:updateNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:formerUpdateProgram}})??'',/Update now remains refused/);
for(const need of [{...updateNeed,updateAuthorization:false},{...updateNeed,effectScope:'informational'},{...updateNeed,why:updateNeed.why.replace('0d90186f','other build')},webAppNeed])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:formerUpdateProgram}}));
assert.ok(macSurfaceRefusal({command:null,need:updateNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getApp("Safari")'}}));
const canvasNeed={...webAppNeed,humanInputId:'capture:7bad480ccf4350922acb3ac750cc0ba0b7a990f596acd92b5fe98403f6f0e7a0'};
const recoveryNeed={...webAppNeed,humanInputId:'capture:5b6622afea9fe89950abaf423874a4b1e48a0c92420527f40a9570643d5ece8b'};
const retirementNeed={kind:'mac-app',why:'Inspect only com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792 current thnkr.ing window and normal File menu for second-window delivery of authorized exact53 retirement',humanInputId:'capture:2a296c24ca627e68981feab3c3e56a32b3e43cf317d0eb545ee4cab23801270b',effectScope:'work'};
const retirementCall="var thnkrMenuApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792');";
const retirementRead="var thnkrRetirementInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrRetirementInspectionApp.getAXStateAndScreenshot()";
for(const code of [retirementCall,retirementRead])
  assert.equal(macSurfaceRefusal({command:null,need:retirementNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),null);
assert.equal(macSurfaceRefusal({command:null,need:retirementNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_FILE_MENU_PROGRAM}}),null);
const retirementNewWindowNeed={...retirementNeed,why:`${retirementNeed.why}; select native New Window`};
assert.equal(macSurfaceRefusal({command:null,need:retirementNewWindowNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_NEW_WINDOW_PROGRAM}}),null);
const unlockedRetirementNeed={...retirementNewWindowNeed,humanInputId:'1ba89166-c732-481b-b53a-e77e85ba93ba'};
const currentUnlockRetirementNeed={...retirementNewWindowNeed,humanInputId:'a806ad0a-a0d8-4f72-b603-b245c95de638'};
for(const need of [unlockedRetirementNeed,currentUnlockRetirementNeed])
  for(const code of [retirementCall,retirementRead,RETIREMENT_FILE_MENU_PROGRAM,RETIREMENT_NEW_WINDOW_PROGRAM])
    assert.equal(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),null);
for(const need of [unlockedRetirementNeed,currentUnlockRetirementNeed])
  for(const code of ["await cua.getApp('Safari')",'await cua.getState()',"await cua.getApp('com.apple.Safari.WebApp.other')", "await thnkrRetirementNewWindowApp.click(2)"])
    assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
assert.ok(macSurfaceRefusal({command:null,need:{...unlockedRetirementNeed,effectScope:'informational'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_NEW_WINDOW_PROGRAM}}));
assert.ok(macSurfaceRefusal({command:null,need:{...currentUnlockRetirementNeed,effectScope:'informational'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_NEW_WINDOW_PROGRAM}}));
for(const need of [retirementNeed,{...retirementNewWindowNeed,effectScope:'informational'},
  {...retirementNewWindowNeed,humanInputId:'capture:other'},
  {...retirementNewWindowNeed,why:retirementNewWindowNeed.why.replace('exact53 retirement','old recovery')},
  {...retirementNewWindowNeed,why:retirementNewWindowNeed.why.replace('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792','com.apple.Safari.WebApp.other')}])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_NEW_WINDOW_PROGRAM}}));
for(const code of [RETIREMENT_NEW_WINDOW_PROGRAM.replace('New Window$/gm','Close Window$/gm'),
  RETIREMENT_NEW_WINDOW_PROGRAM.replace('getAXState({disableDiffing:true})','getAXState()'),
  `${RETIREMENT_NEW_WINDOW_PROGRAM}\nawait thnkrRetirementNewWindowApp.click(1);`])
  assert.ok(macSurfaceRefusal({command:null,need:retirementNewWindowNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}));
{
  const clicks:number[]=[];
  const app={getAXState:async()=>`Window: "thnkr.ing", App: Thinkering.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t2 New Window\n\t\t3 Close Window`,click:async(index:number)=>{clicks.push(index);},getAXStateAndScreenshot:async()=>({state:'after'})};
  await new Function('cua',`return (async()=>{${RETIREMENT_NEW_WINDOW_PROGRAM}})()` )({getApp:async()=>app});
  assert.deepEqual(clicks,[2]);
  for(const menu of [`Window: "thnkr.ing", App: Thinkering.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t2 Close Window`,
    `Window: "Safari", App: Safari.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t2 New Window`]) {
    const refusedClicks:number[]=[];
    const wrongApp={...app,getAXState:async()=>menu,click:async(index:number)=>{refusedClicks.push(index);}};
    await assert.rejects(new Function('cua',`return (async()=>{${RETIREMENT_NEW_WINDOW_PROGRAM}})()` )({getApp:async()=>wrongApp}));
    assert.deepEqual(refusedClicks,[]);
  }
}
for(const code of [RETIREMENT_FILE_MENU_PROGRAM.replace('File$/gm','Edit$/gm'),
  RETIREMENT_FILE_MENU_PROGRAM.replace('getAXState({disableDiffing:true})','getAXState()'),
  `${RETIREMENT_FILE_MENU_PROGRAM}\nawait thnkrRetirementMenuApp.click(1);`])
  assert.ok(macSurfaceRefusal({command:null,need:retirementNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}));
assert.ok(macSurfaceRefusal({command:null,need:{...retirementNeed,why:retirementNeed.why.replace('File menu','window controls')},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_FILE_MENU_PROGRAM}}));
const menuState='Window: "thnkr.ing"\n0 standard window thnkr.ing, ID: WebAppWindow-Thinkering, Secondary Actions: Raise\n197 menu bar\n\t198 Thinkering\n\t199 File\n\t200 Edit\n';
const runMenuProgram=async(state:string)=>{
  const clicks:number[]=[];
  const app={getAXState:async()=>state,click:async(target:number)=>{clicks.push(target);}};
  await new Function('cua',`return (async()=>{${RETIREMENT_FILE_MENU_PROGRAM}})()` )({getApp:async()=>app});
  return clicks;
};
assert.deepEqual(await runMenuProgram(menuState),[199]);
await assert.rejects(runMenuProgram(menuState.replace('199 File','199 Edit')));
await assert.rejects(runMenuProgram(menuState.replace('200 Edit','200 File')));
await assert.rejects(runMenuProgram(menuState.replace('197 menu bar','197 group')));
await assert.rejects(runMenuProgram(`${menuState}201 standard window thnkr.ing, ID: WebAppWindow-Thinkering\n`));
for(const need of [webAppNeed,canvasNeed])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_FILE_MENU_PROGRAM}}));
for(const code of ["await cua.getApp('Safari')",'await cua.getState()',"await cua.getApp('com.apple.Safari.WebApp.other')",
  'await thnkrMenuApp.getAXState()',"await thnkrMenuApp.click(42)","await thnkrMenuApp.pressKey('super+r')",
  "var thnkrRetirementInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrRetirementInspectionApp.click(42)",
  "var thnkrRetirementInspectionApp = await cua.getApp('Safari'); await thnkrRetirementInspectionApp.getAXState()",
  "var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.pressKey('alt+super+i')"])
  assert.ok(macSurfaceRefusal({command:null,need:retirementNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
for(const need of [retirementNeed,recoveryNeed])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'functions.exec',toolInput:{code:'await tools.mcp__cua_repl__js({code:"await cua.getState()"})'}}));
for(const need of [webAppNeed,canvasNeed,recoveryNeed])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:RETIREMENT_NEW_WINDOW_PROGRAM}}));
for(const need of [{...retirementNeed,effectScope:'informational'},
  {...retirementNeed,humanInputId:'capture:other'},
  {...retirementNeed,why:retirementNeed.why.replace('exact53 retirement','old recovery')},
  {...retirementNeed,why:retirementNeed.why.replace('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792','com.apple.Safari.WebApp.other')},
  {...retirementNeed,why:`${webAppNeed.why} Open Web Inspector.`}])
  for(const code of [retirementCall,retirementRead])
    assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
for(const need of [{...retirementNeed,effectScope:'informational'},
  {...retirementNeed,why:'Inspect this app without a retirement purpose'},
  {...retirementNeed,why:`${webAppNeed.why} Open Web Inspector.`}])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await cua.getState()'}}));
const webInspectorNeed={...webAppNeed,why:`${webAppNeed.why} Open Web Inspector on that exact app to inspect reachable unsaved editor state.`};
const webInspectorOpen=`var thnkrInspectorApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrInspectorApp.pressKey('alt+super+i')`;
for(const need of [unlockedRetirementNeed,currentUnlockRetirementNeed])
  for(const code of ['await app.getAXState()',webInspectorOpen])
    assert.ok(macSurfaceRefusal({command:null,need:{...need,why:`${webAppNeed.why} exact53 retirement`},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
const webAppCall="let app = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792');";
assert.equal(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}}),null);
assert.equal(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:'await app.getAXState()'}}),null);
for(const need of [canvasNeed,recoveryNeed])for(const code of [webAppCall,...['getAXState','getAXStateAndScreenshot','getScreenshot'].map(method=>
  `var thnkrCanvasInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrCanvasInspectionApp.${method}()` )])
  assert.equal(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),null);
for(const need of [canvasNeed,recoveryNeed])for(const code of ["await cua.getApp('Safari')","await cua.getApp('Google Chrome')",'await cua.getState()',
  'await app.getAXState()','await app.getScreenshot()','await app.click(42)',"await app.pressKey('super+r')",
  `${webAppCall} await app.getScreenshot()`,
  "var thnkrCanvasInspectionApp = await cua.getApp('Safari'); await thnkrCanvasInspectionApp.getAXState()",
  "var thnkrCanvasInspectionApp = await cua.getApp('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792'); await thnkrCanvasInspectionApp.click(42)"])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code}}),code);
for(const need of [{...canvasNeed,why:'Inspect the exact app without a page ID'},
  {...canvasNeed,why:canvasNeed.why.replace('com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792','com.apple.Safari.WebApp.other')},
  {...recoveryNeed,effectScope:'informational'},
  {...recoveryNeed,effectScope:''},
  {...recoveryNeed,humanInputId:''}])
  assert.ok(macSurfaceRefusal({command:null,need,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}}));
assert.equal(macSurfaceRefusal({command:null,need:webInspectorNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webInspectorOpen}}),null);
assert.ok(macSurfaceRefusal({command:null,need:{...recoveryNeed,why:`${recoveryNeed.why} Open Web Inspector.`},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webInspectorOpen}}));
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
assert.match(macSurfaceRefusal({command:null,need:{...webAppNeed,effectScope:'informational'},platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Safari')"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:'mac-app',platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Thinkering')"}})??'',/personal browser/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:"await cua.getApp('Thinkering')"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'mcp__cua_repl__js',toolInput:{code:webAppCall+" await cua.getApp('Safari');"}})??'',/exact thnkr.ing web app/);
assert.match(macSurfaceRefusal({command:null,need:webAppNeed,platform:'darwin',toolName:'functions.exec',toolInput:{code:`await tools.mcp__cua_repl__js({code:${JSON.stringify(webAppCall)}})`}})??'',/exact bundle and page IDs/);
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
  'Can you unlock the Mac so the agent can continue? Can you copy the eight notes?',
  'Can you open Safari on your Mac?', 'Can you open Gmail on your phone?',
  'Can you launch Chrome on my laptop?', 'Can you start the deploy on the server?'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),false,question);
for(const question of ['Can you unlock your Mac so the agent can continue?',
  'Can you unlock the Mac so the agent can read the app?',
  'Can you unlock your physical Mac?','Can you take a photo of the paper?',
  'Can you open KOReader once on your Kindle Oasis?',
  'Can you open KOReader on Kindle?',
  'Could you start the companion app on the watch?',
  'Can you unlock your iPhone?','Please unlock your iPhone.',
  'Please unlock your iPhone. The device check reached it and reported that it is locked. I will handle the app inspection; the other repair work continues.'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),true,question);
for(const question of ['Please unlock your iPhone. Then open the app.',
  'Please unlock your iPhone. Open Settings and tap Save.',
  'Please unlock your iPhone. Can you copy the notes?',
  'Please unlock your iPhone and open the app.',
  'Please unlock your iPhone. The app needs you to tap Save.',
  'Please open Gmail on your iPhone.'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),false,question);
for(const question of ['Can you open KOReader and copy a book on your Kindle Oasis?',
  'Can you open KOReader on your Kindle Oasis? Then send me a screenshot?'])
  assert.equal(deviceQuestionNamesPhysicalPrerequisite(question),false,question);
console.log('Mac surface policy refused the unsafe actions and kept server and read-only work available.');
