const CHROME_CONTROL=/claude[-_]in[-_]chrome/i;
const COMPUTER_CONTROL=/cua[_-]?repl|computer[._-]?use|skycomputeruse/i;
export const AUTHORIZED_WEB_APP='com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792';
export const AUTHORIZED_PAGE='faf63877-6536-4ac6-86e9-5d63e03d3369';
export const AUTHORIZED_UPDATE_BOARD='94504c60-2b34-4fda-ba23-c20a6a71d7df';
export const UPDATE_WORKSPACE_COMMAND='"$CONCIERGE_ROUTER_BOT_DIR/scripts/mac-update-ax.swift" open-workspace';
export const UPDATE_FIRST_TAP_COMMAND='"$CONCIERGE_ROUTER_BOT_DIR/scripts/mac-update-ax.swift" update-now';
const UPDATE_HELPER_PATH='"$CONCIERGE_ROUTER_BOT_DIR/scripts/mac-update-ax.swift"';
const UPDATE_HELPER_READ_COMMANDS=new Set([
  `shasum -a 256 ${UPDATE_HELPER_PATH}`,
  `stat -f %Sp ${UPDATE_HELPER_PATH}`,
  `swiftc -typecheck ${UPDATE_HELPER_PATH}`,
]);
export const AUTHORIZING_HUMAN_INPUT='f66f15dd-e251-4537-a9cd-347d0548434b';
export const CANVAS_AUTHORIZING_HUMAN_INPUT='capture:7bad480ccf4350922acb3ac750cc0ba0b7a990f596acd92b5fe98403f6f0e7a0';
export const RETIREMENT_AUTHORIZING_HUMAN_INPUT='capture:2a296c24ca627e68981feab3c3e56a32b3e43cf317d0eb545ee4cab23801270b';
export const RETIREMENT_UNLOCK_HUMAN_INPUT='1ba89166-c732-481b-b53a-e77e85ba93ba';
export const RETIREMENT_CURRENT_UNLOCK_HUMAN_INPUT='a806ad0a-a0d8-4f72-b603-b245c95de638';
export const UPDATE_BOUNDED_AX_PROGRAM=String.raw`await (async () => {
const app = await cua.getApp("${AUTHORIZED_WEB_APP}", {emit:false});
const state = await app.getAXState({emit:false,disableDiffing:true});
const lines = state.split('\n');
const count = (pattern) => lines.filter((line) => pattern.test(line)).length;
const urls = [...new Set(state.match(/https?:\/\/thnkr\.ing\/[^\s"<>]*/g) ?? [])].slice(0,3).map((url) => url.slice(0,320));
nodeRepl.write(JSON.stringify({length:state.length,lineCount:lines.length,windowCount:count(/standard window thnkr\.ing, ID: WebAppWindow-Thinkering/),urls,updateNowCount:count(/\bUpdate now\b/i),updateAnywayCount:count(/\bUpdate anyway\b/i),unsavedCount:count(/\bunsaved\b/i),stillSavingCount:count(/\bstill being saved\b/i),recordingCount:count(/\brecording\b/i),deepWorkCount:count(/\bDeep work\b/i),offerRevisionCount:count(/0d90186f/i)}));
})()`;
export const RETIREMENT_FILE_MENU_PROGRAM=String.raw`var thnkrRetirementMenuApp = await cua.getApp("${AUTHORIZED_WEB_APP}");
var thnkrRetirementMenuState = await thnkrRetirementMenuApp.getAXState({disableDiffing:true});
var thnkrRetirementWindowLines = thnkrRetirementMenuState.match(/^\d+ standard window thnkr\.ing, ID: WebAppWindow-Thinkering(?:,.*)?$/gm) ?? [];
var thnkrRetirementMenuBarBlocks = [...thnkrRetirementMenuState.matchAll(/^\d+ menu bar\n((?:\t\d+ [^\n]*\n)*)/gm)];
var thnkrRetirementFileMenuMatches = thnkrRetirementMenuBarBlocks.flatMap(([, children]) => [...children.matchAll(/^\t(\d+) File$/gm)]);
if (thnkrRetirementWindowLines.length !== 1 || thnkrRetirementMenuBarBlocks.length !== 1 || thnkrRetirementFileMenuMatches.length !== 1) throw new Error("Exact thnkr.ing File menu not found");
await thnkrRetirementMenuApp.click(Number(thnkrRetirementFileMenuMatches[0][1]));
await thnkrRetirementMenuApp.getAXState({disableDiffing:true});`;
export const RETIREMENT_NEW_WINDOW_PROGRAM=String.raw`var thnkrRetirementNewWindowApp = await cua.getApp("${AUTHORIZED_WEB_APP}");
var thnkrRetirementOpenFileState = await thnkrRetirementNewWindowApp.getAXState({disableDiffing:true});
var thnkrRetirementFileMenuMatches = [...thnkrRetirementOpenFileState.matchAll(/^0 File, Secondary Actions: Cancel, Pick\n\t\d+ menu Secondary Actions: Cancel\n\t\t(\d+) New Window$/gm)];
if (!thnkrRetirementOpenFileState.startsWith('Window: "thnkr.ing", App: Thinkering.\n') || thnkrRetirementFileMenuMatches.length !== 1) throw new Error("Exact thnkr.ing File > New Window item not found");
await thnkrRetirementNewWindowApp.click(Number(thnkrRetirementFileMenuMatches[0][1]));
await thnkrRetirementNewWindowApp.getAXStateAndScreenshot({disableDiffing:true});`;

type RecordedNeed=string|{kind:string;why?:string;humanInputId?:string;effectScope?:string;updateAuthorization?:boolean};

function authorizedUpdateNeed(need:RecordedNeed,toolName:string):need is Exclude<RecordedNeed,string> {
  return typeof need!=='string'&&need.kind==='mac-app'&&need.updateAuthorization===true
    &&need.effectScope==='work'&&typeof need.why==='string'
    &&need.why.includes(AUTHORIZED_WEB_APP)
    &&((need.why.includes(AUTHORIZED_PAGE)&&need.why.includes('0d90186f'))
      ||need.why.includes(AUTHORIZED_UPDATE_BOARD))
    &&COMPUTER_CONTROL.test(toolName);
}

function authorizedNativeUpdateCommand(need:RecordedNeed,command:string):boolean {
  if(typeof need==='string'||need.kind!=='mac-app'||need.updateAuthorization!==true
      ||need.effectScope!=='work'||typeof need.why!=='string'
      ||!need.why.includes(AUTHORIZED_WEB_APP)||!need.why.includes(AUTHORIZED_UPDATE_BOARD))return false;
  if(command===UPDATE_WORKSPACE_COMMAND)return need.why.includes('Workspace menu');
  if(command===UPDATE_FIRST_TAP_COMMAND)return need.why.includes('Update now');
  return false;
}

function retirementHumanInput(id:string|undefined):boolean {
  return id===RETIREMENT_AUTHORIZING_HUMAN_INPUT
    ||id===RETIREMENT_UNLOCK_HUMAN_INPUT
    ||id===RETIREMENT_CURRENT_UNLOCK_HUMAN_INPUT;
}

function authorizedWebAppNeed(need:RecordedNeed,toolName:string):need is Exclude<RecordedNeed,string> {
  return typeof need!=='string'&&need.kind==='mac-app'
    &&typeof need.humanInputId==='string'&&need.humanInputId.length>0
    &&!retirementHumanInput(need.humanInputId)&&need.effectScope==='work'
    &&typeof need.why==='string'&&need.why.includes(AUTHORIZED_WEB_APP)&&need.why.includes(AUTHORIZED_PAGE)
    &&COMPUTER_CONTROL.test(toolName);
}

function authorizedRetirementInspectionNeed(need:RecordedNeed,toolName:string):need is Exclude<RecordedNeed,string> {
  return typeof need!=='string'&&need.kind==='mac-app'
    &&retirementHumanInput(need.humanInputId)&&need.effectScope==='work'
    &&typeof need.why==='string'&&need.why.includes(AUTHORIZED_WEB_APP)
    &&need.why.includes('exact53 retirement')&&COMPUTER_CONTROL.test(toolName);
}

function authorizedCurrentWebAppNeed(need:RecordedNeed,toolName:string):boolean {
  return authorizedWebAppNeed(need,toolName)||authorizedRetirementInspectionNeed(need,toolName)||authorizedUpdateNeed(need,toolName);
}

function authorizedRetirementFileMenuOpen(need:RecordedNeed,toolName:string,code:string):boolean {
  return authorizedRetirementInspectionNeed(need,toolName)&&need.why.includes('File menu')
    &&code===RETIREMENT_FILE_MENU_PROGRAM;
}

function authorizedRetirementNewWindowOpen(need:RecordedNeed,toolName:string,code:string):boolean {
  return authorizedRetirementInspectionNeed(need,toolName)&&need.why.includes('New Window')
    &&code===RETIREMENT_NEW_WINDOW_PROGRAM;
}

function restrictedWebAppTask(need:RecordedNeed,toolName:string,toolInput:unknown):need is Exclude<RecordedNeed,string> {
  return typeof need!=='string'&&macComputerUseCall(toolName,toolInput)
    &&((typeof need.why==='string'&&need.why.includes(AUTHORIZED_WEB_APP))
      ||need.humanInputId===AUTHORIZING_HUMAN_INPUT
      ||need.humanInputId===CANVAS_AUTHORIZING_HUMAN_INPUT
      ||retirementHumanInput(need.humanInputId)||need.updateAuthorization===true);
}

function exactWebAppSelector():string {
  const quoted=AUTHORIZED_WEB_APP.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return `cua\\.getApp\\(\\s*(['"])${quoted}\\1\\s*\\)`;
}

function authorizedWebAppInspection(need:RecordedNeed,toolName:string,code:string):boolean {
  if(!authorizedCurrentWebAppNeed(need,toolName))return false;
  return new RegExp(`^\\s*(?:(?:let|const|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*)?await\\s+${exactWebAppSelector()}\\s*;?\\s*$`).test(code);
}

function authorizedWebAppRead(need:RecordedNeed,toolName:string,code:string):boolean {
  if(!authorizedWebAppNeed(need,toolName)||need.humanInputId!==AUTHORIZING_HUMAN_INPUT)return false;
  return /^\s*await\s+app\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\(\s*\)\s*;?\s*$/.test(code);
}

function authorizedScopedRead(need:RecordedNeed,toolName:string,code:string):boolean {
  if(!authorizedCurrentWebAppNeed(need,toolName))return false;
  const handle=authorizedRetirementInspectionNeed(need,toolName)?'thnkrRetirementInspectionApp'
    :authorizedUpdateNeed(need,toolName)?'thnkrUpdateInspectionApp':'thnkrCanvasInspectionApp';
  return new RegExp(`^\\s*var\\s+${handle}\\s*=\\s*await\\s+${exactWebAppSelector()}\\s*;\\s*await\\s+${handle}\\.(?:getAXState|getAXStateAndScreenshot|getScreenshot)\\(\\s*\\)\\s*;?\\s*$`).test(code);
}

function authorizedUpdateBoundedRead(need:RecordedNeed,toolName:string,code:string):boolean {
  return authorizedUpdateNeed(need,toolName)&&code===UPDATE_BOUNDED_AX_PROGRAM;
}

function authorizedWebAppInspectorOpen(need:RecordedNeed,toolName:string,code:string):boolean {
  if(!authorizedWebAppNeed(need,toolName)||need.humanInputId!==AUTHORIZING_HUMAN_INPUT||!/\bWeb Inspector\b/i.test(need.why))return false;
  return new RegExp(`^\\s*var\\s+thnkrInspectorApp\\s*=\\s*await\\s+${exactWebAppSelector()}\\s*;\\s*await\\s+thnkrInspectorApp\\.pressKey\\(\\s*(['"])alt\\+super\\+i\\2\\s*\\)\\s*;?\\s*$`).test(code);
}

function namedToolCall(name:RegExp,code:string):boolean {
  return new RegExp(`\\btools\\.[\\w$]*(?:${name.source})[\\w$]*\\s*\\(`,'i').test(code);
}

export function macComputerUseCall(toolName:string,toolInput:unknown):boolean {
  const details=toolInput&&typeof toolInput==='object'?toolInput as Record<string,unknown>:{};
  const code=typeof details.code==='string'?details.code:'';
  return COMPUTER_CONTROL.test(toolName)||namedToolCall(COMPUTER_CONTROL,code);
}

/** Refuse common agent tool paths that would take over Tejas's Mac desktop. */
export function macSurfaceRefusal(input:{command:string|null;toolName:string;toolInput:unknown;need:RecordedNeed;platform:string}):string|null {
  const {command,toolName,toolInput,need,platform}=input;
  const raw=command??'';
  const tool=toolName.toLowerCase();
  if(platform==='darwin'&&/playwright|agent.browser|browser_run_code|browser_navigate|chrome[_-]?devtools/i.test(tool))
    return 'Direct agent browser control on Tejas’s Mac is refused. Use the server, or the isolated Mac browser after a recorded server failure.';
  const details=toolInput&&typeof toolInput==='object'?toolInput as Record<string,unknown>:{};
  const code=typeof details.code==='string'?details.code:'';
  const kind=typeof need==='string'?need:need.kind;
  if(platform==='darwin'&&macComputerUseCall(toolName,toolInput)
      &&restrictedWebAppTask(need,toolName,toolInput)
      &&!authorizedWebAppInspection(need,toolName,code)&&!authorizedWebAppRead(need,toolName,code)
      &&!authorizedScopedRead(need,toolName,code)
      &&!authorizedUpdateBoundedRead(need,toolName,code)
      &&!authorizedWebAppInspectorOpen(need,toolName,code)
      &&!authorizedRetirementFileMenuOpen(need,toolName,code)
      &&!authorizedRetirementNewWindowOpen(need,toolName,code)
      ) {
    if(!authorizedCurrentWebAppNeed(need,toolName))return !COMPUTER_CONTROL.test(toolName)
      ? 'This Safari web app needs an active Mac-app request naming its exact bundle and page IDs, followed by a direct Computer Use getApp call for that bundle. Reissue the request with Tejas’s authorization; do not ask him to copy the app’s contents.'
      : retirementHumanInput(need.humanInputId)
      ? 'This current-window retirement inspection needs an active Mac-app work request naming the exact thnkr.ing bundle and exact53 retirement, followed by a direct Computer Use getApp call for that bundle.'
      : need.humanInputId===AUTHORIZING_HUMAN_INPUT||need.humanInputId===CANVAS_AUTHORIZING_HUMAN_INPUT
      ? 'This human work authorization covers only passive inspection of the exact thnkr.ing web app. Select its bundle again in the same Computer Use program as each read; Inspector, input, other apps and whole-screen calls remain refused.'
      : 'This Safari web app needs an active Mac-app request naming its exact bundle and page IDs, followed by a direct Computer Use getApp call for that bundle. Reissue the request with Tejas’s authorization; do not ask him to copy the app’s contents.';
    return authorizedUpdateNeed(need,toolName)
      ? 'This work request covers passive inspection of the exact thnkr.ing app. Update now remains refused because Computer Use cannot prove the current page and ready release or bind the click to a stable control; other clicks and reloads remain refused.'
      : authorizedRetirementInspectionNeed(need,toolName)
      ? 'This human work authorization covers exact thnkr.ing app reads, guarded File-menu inspection, and guarded New Window selection when the recorded need names it. Other apps, page input, reload and whole-screen calls remain refused.'
      : typeof need!=='string'&&need.humanInputId!==AUTHORIZING_HUMAN_INPUT
      ? 'This human work authorization covers only passive inspection of the exact thnkr.ing web app. Select its bundle again in the same Computer Use program as each read; Inspector, input, other apps and whole-screen calls remain refused.'
      : 'This authorization covers the exact thnkr.ing web app: passive inspection, or opening Web Inspector with the exact-bundle shortcut when that action is named in the recorded Mac-app need. Other app, browser, page input and whole-screen actions remain refused.';
  }
  if(platform==='darwin'&&(CHROME_CONTROL.test(tool)||namedToolCall(CHROME_CONTROL,code)))
    return 'Claude in Chrome controls Tejas’s personal Chrome. Run the website on the server, or use the isolated Mac browser after a recorded server failure.';
  if(platform==='darwin'&&macComputerUseCall(toolName,toolInput)&&kind!=='provider-renewal'
      &&/\b(?:Google Chrome|Chrome|Safari|Thinkering)\b/i.test(code)
      &&!authorizedWebAppInspection(need,toolName,code)&&!authorizedScopedRead(need,toolName,code)
      &&!authorizedUpdateBoundedRead(need,toolName,code)
      &&!authorizedWebAppInspectorOpen(need,toolName,code)&&!authorizedRetirementFileMenuOpen(need,toolName,code)
      &&!authorizedRetirementNewWindowOpen(need,toolName,code))
    return code.includes('com.apple.Safari.WebApp.')
      ? 'This Safari web app needs an active Mac-app request naming its exact bundle and page IDs, followed by a direct Computer Use getApp call for that bundle. Reissue the request with Tejas’s authorization; do not ask him to copy the app’s contents.'
      : 'Computer Use cannot target Tejas’s personal browser. Run the website on the server, or use the isolated Mac browser after a recorded server failure.';
  if(platform==='darwin'&&macComputerUseCall(toolName,toolInput)
      &&!['ios-native','mac-app','mac-screen','human-mac','provider-renewal'].includes(kind))
    return 'Mac Computer Use needs an accepted Mac app, screen, native iOS, or explicit Mac need on this request.';
  if(/^(?:read|grep|glob|notebookread)$/i.test(toolName))return null;
  if(/^(?:rg|grep|sed|cat|ls|head|tail|find|ps|stat|git\s+diff)\b/i.test(raw.trim())
      && !/[;&|`\n]|\$\(/.test(raw))return null;
  if(code&&/\btools\.[\w$]*(?:browser|playwright|chrome[_-]?devtools)[\w$]*\s*\(/i.test(code))
    return 'Direct agent browser control on Tejas’s Mac is refused. Use the server, or the isolated Mac browser after a recorded server failure.';
  const nestedCommands=code.match(/tools\.exec_command\s*\(/g)??[];
  if(code&&!nestedCommands.length)return null;
  const literalCommands=[...code.matchAll(/tools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)];
  if(platform==='darwin'&&nestedCommands.length&&(literalCommands.length!==nestedCommands.length
      ||literalCommands.some(match=>match[1]==='`'&&match[2]?.includes('${'))))
    return 'Dynamic shell commands on Tejas’s Mac need a direct tool call so the foreground and browser guard can inspect the exact action.';
  const source=code?literalCommands.map(match=>match[2]).join('\n'):raw;
  if(platform==='darwin'&&source.includes('mac-update-ax.swift'))
    return UPDATE_HELPER_READ_COMMANDS.has(source)||authorizedNativeUpdateCommand(need,source)?null
      :'The current Thinkering update helper requires the exact attested work request and its fixed single-action command.';
  if(/^(?:rg|grep|sed|cat|ls|head|tail|find|ps|stat|git\s+diff)\b/i.test(source.trim())
      && !/[;&|`\n]|\$\(/.test(source))return null;
  const remote=/\bssh\b[^\n]{0,400}\btejasdc@(?:100\.90\.183\.122|[\w.-]+)\b/i.test(source);
  if(platform!=='darwin'&&!remote)return null;
  if(remote&&/\bagent-browser\s+(?!skills\b)(?:--[^\s]+\s+)*(?:open|click|fill|type|connect|tab|eval|snapshot|screenshot)\b|\bplaywright\s+(?:open|codegen|test)\b/i.test(source))
    return 'Browser control through SSH to Tejas’s Mac is refused. Send a recorded browser-fallback request to the Mac owner.';
  const action='(?:^|[;&|]\\s*|\\n\\s*)(?:sudo\\s+|env\\s+[^;|\\n]*?\\s+)?';
  const browserCli=new RegExp(action+'(?:(?:(?:npx|bunx)\\s+)?(?:[^\\s;|]+/)?agent-browser\\b(?!\\s+skills\\b)|(?:(?:npx|bunx)\\s+)?playwright\\s+(?:open|codegen|test)\\b|(?:[^\\s;|]+/)?chrome(?:-canary)?\\b)','i');
  const chrome=/\b(?:Google Chrome\.app|Google Chrome|connectOverCDP|--remote-debugging-(?:port|pipe))\b/i;
  const focus=new RegExp(action+'(?:/usr/bin/)?open\\s+(?!-g(?:\\s|$))[^\\n;|]+','i');
  const simulatorUi=new RegExp(action+'(?:/usr/bin/)?open\\s+[^\\n;|]*\\bSimulator(?:\\.app)?\\b','i');
  const appControl=/\b(?:osascript|cliclick|pyautogui|cua_repl|computer\.use|skycomputeruse)\b/i;
  const simulator=/\b(?:xcrun\s+simctl\s+(?:boot|launch|io|ui|create|install|push|openurl)|safaridriver\b|scripts\/ios-look\.mjs\b)/i;
  if(/computer|desktop|screen/i.test(tool)&&!/(?:screenshot|read)/i.test(tool)&&!COMPUTER_CONTROL.test(tool))
    return 'Mac desktop control is refused because it can take focus. Use a background Mac capability for a specific Mac-only need.';
  if(browserCli.test(source)||chrome.test(source)||simulatorUi.test(source))
    return 'Direct browser and foreground Chrome or Simulator use on Tejas’s Mac is refused. Run ordinary checks on the server; a recorded server failure can use the isolated Mac browser without desktop focus.';
  if(focus.test(source)||appControl.test(source)&&/\bactivate\b|\b(?:Chrome|Safari|Simulator)\b/i.test(source))
    return 'A Mac agent cannot take the foreground app or control Tejas’s browser. Use a background Mac action for the exact Mac-only task.';
  if(new RegExp(action+'(?:/usr/bin/)?open\\s+-g\\b','i').test(source)&&!kind)
    return 'A background Mac app launch needs an accepted Mac-only reason on this exact request.';
  if(simulator.test(source)&&kind!=='ios-native')
    return 'Simulator and iOS Safari automation require an accepted Mac-only iOS need on this exact request. Ordinary phone-size checks run on the server.';
  return null;
}
