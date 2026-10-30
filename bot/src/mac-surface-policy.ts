/** Refuse common agent tool paths that would take over Tejas's Mac desktop. */
export function macSurfaceRefusal(input:{command:string|null;toolName:string;toolInput:unknown;need:string;platform:string}):string|null {
  const {command,toolName,toolInput,need,platform}=input;
  const raw=command??'';
  const tool=toolName.toLowerCase();
  if(platform==='darwin'&&/playwright|agent.browser|browser_run_code|browser_navigate/i.test(tool))
    return 'Agent browser use on Tejas’s Mac is refused. Run desktop and phone-size browser checks on the server.';
  const details=toolInput&&typeof toolInput==='object'?toolInput as Record<string,unknown>:{};
  const code=typeof details.code==='string'?details.code:'';
  if(/^(?:read|grep|glob|notebookread)$/i.test(toolName))return null;
  if(/^(?:rg|grep|sed|cat|ls|head|tail|find|ps|stat|git\s+diff)\b/i.test(raw.trim())
      && !/[;&|`\n]|\$\(/.test(raw))return null;
  if(code&&/\btools\.[\w$]*(?:browser|playwright)[\w$]*\s*\(/i.test(code))
    return 'Agent browser use on Tejas’s Mac is refused. Run desktop and phone-size browser checks on the server.';
  const nestedCommands=code.match(/tools\.exec_command\s*\(/g)??[];
  if(code&&!nestedCommands.length)return null;
  const literalCommands=[...code.matchAll(/tools\.exec_command\s*\(\s*\{\s*cmd\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)];
  if(platform==='darwin'&&nestedCommands.length&&(literalCommands.length!==nestedCommands.length
      ||literalCommands.some(match=>match[1]==='`'&&match[2]?.includes('${'))))
    return 'Dynamic shell commands on Tejas’s Mac need a direct tool call so the foreground and browser guard can inspect the exact action.';
  const source=code?literalCommands.map(match=>match[2]).join('\n'):raw;
  if(/^(?:rg|grep|sed|cat|ls|head|tail|find|ps|stat|git\s+diff)\b/i.test(source.trim())
      && !/[;&|`\n]|\$\(/.test(source))return null;
  const remote=/\bssh\b[^\n]{0,400}\btejasdc@(?:100\.90\.183\.122|[\w.-]+)\b/i.test(source);
  if(platform!=='darwin'&&!remote)return null;
  const action='(?:^|[;&|]\\s*|\\n\\s*)(?:sudo\\s+|env\\s+[^;|\\n]*?\\s+)?';
  const browserCli=new RegExp(action+'(?:(?:(?:npx|bunx)\\s+)?(?:[^\\s;|]+/)?agent-browser\\b(?!\\s+skills\\b)|(?:(?:npx|bunx)\\s+)?playwright\\s+(?:open|codegen|test)\\b|(?:[^\\s;|]+/)?chrome(?:-canary)?\\b)','i');
  const chrome=/\b(?:Google Chrome\.app|Google Chrome|connectOverCDP|--remote-debugging-(?:port|pipe))\b/i;
  const focus=new RegExp(action+'(?:/usr/bin/)?open\\s+(?!-g(?:\\s|$))[^\\n;|]+','i');
  const simulatorUi=new RegExp(action+'(?:/usr/bin/)?open\\s+[^\\n;|]*\\bSimulator(?:\\.app)?\\b','i');
  const appControl=/\b(?:osascript|cliclick|pyautogui|cua_repl|computer\.use|skycomputeruse)\b/i;
  const simulator=/\b(?:xcrun\s+simctl\s+(?:boot|launch|io|ui|create|install|push|openurl)|safaridriver\b|scripts\/ios-look\.mjs\b)/i;
  if(/computer|desktop|screen/i.test(tool)&&!/(?:screenshot|read)/i.test(tool))
    return 'Mac desktop control is refused because it can take focus. Use a background Mac capability for a specific Mac-only need.';
  if(browserCli.test(source)||chrome.test(source)||simulatorUi.test(source))
    return 'Agent browser and foreground Chrome or Simulator use on Tejas’s Mac is refused. Run ordinary browser and phone-size checks on the server; use a background iOS check only for native Safari touch behavior.';
  if(focus.test(source)||appControl.test(source)&&/\bactivate\b|\b(?:Chrome|Safari|Simulator)\b/i.test(source))
    return 'A Mac agent cannot take the foreground app or control Tejas’s browser. Use a background Mac action for the exact Mac-only task.';
  if(new RegExp(action+'(?:/usr/bin/)?open\\s+-g\\b','i').test(source)&&!need)
    return 'A background Mac app launch needs an accepted Mac-only reason on this exact request.';
  if(simulator.test(source)&&need!=='ios-native')
    return 'Simulator and iOS Safari automation require an accepted Mac-only iOS need on this exact request. Ordinary phone-size checks run on the server.';
  return null;
}
