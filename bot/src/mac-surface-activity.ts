/** Actions likely to put an agent in front of the Mac's user, observed from provider tool calls. */
export type MacSurfaceActivity = Readonly<{ key: string; action: string; remoteMac?: boolean }>;

function commandText(value: unknown): string {
  if (typeof value === 'string') {
    // Codex may report the executed command as one shell-wrapped string.
    return value.replace(/^\s*(?:\/[^\s]+\/)?(?:bash|zsh|sh)\s+-[a-z]*c\s+['"]?/i, '');
  }
  if (Array.isArray(value)) {
    const words = value.map(String);
    return words.some(word => /^-[a-z]*c$/.test(word)) ? words.at(-1) || '' : words.join(' ');
  }
  return '';
}

function safeName(value: string): string {
  return value.split('/').at(-1)?.replace(/[^a-zA-Z0-9 ._-]/g, '').slice(0, 60) || 'software';
}

export function macSurfaceActivity(toolName: string, input: unknown): MacSurfaceActivity | null {
  const details = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const argumentsValue = typeof details.arguments === 'string'
    ? (() => { try { const parsed: unknown = JSON.parse(details.arguments); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; } })()
    : details.arguments && typeof details.arguments === 'object'
      ? details.arguments as Record<string, unknown> : {};
  const inputValue = details.input && typeof details.input === 'object'
    ? details.input as Record<string, unknown> : {};
  const parsedCommand = Array.isArray(details.parsed_cmd)
    ? details.parsed_cmd.find(part => part && typeof part === 'object' && typeof part.cmd === 'string')?.cmd
    : undefined;
  const command = commandText(parsedCommand ?? details.command ?? details.cmd);
  const code = command || commandText(details.code ?? argumentsValue.code ?? inputValue.code
    ?? argumentsValue.command ?? inputValue.command ?? details.input);
  const tool = toolName.toLowerCase();
  if (/playwright|agent.browser|browser_run_code|browser_navigate/i.test(tool))
    return {key:'agent-browser',action:'Running an agent browser on the Mac'};
  // Server agents can surface a macOS prompt through SSH without starting a Mac
  // Concierge turn. Observe the outgoing tool call before it runs, using the same
  // session event and phone notice as an action made by a Mac agent.
  const sshMac = /\bssh\b[\s\S]{0,600}\btejasdc@(?:100\.90\.183\.122|[\w.-]+)\b/i;
  const remoteInvocation = tool.includes('functions.exec')
    ? /\bexec_command\s*\(\s*\{[\s\S]{0,120}?\bcmd\s*:\s*['"`]\s*ssh\b[\s\S]{0,600}\btejasdc@(?:100\.90\.183\.122|[\w.-]+)\b/i.test(code)
    : /exec|bash|shell|command|(?:^|\/)zsh$|(?:^|\/)sh$/i.test(tool) && /^\s*ssh\b/i.test(code) && sshMac.test(code);
  if (remoteInvocation) {
    if (/\bosascript\b|\bSystem Events\b/i.test(code))
      return {key:'ssh-app-control',action:'Using AppleScript on the Mac over SSH',remoteMac:true};
    if (/\b(?:mac-screenshot|mac-capture|screencapture)\b/i.test(code))
      return {key:'ssh-screen-capture',action:'Capturing the Mac screen over SSH',remoteMac:true};
    if (/\b(?:brew|mas|pip3?|npm|uv)\s+install\b/i.test(code))
      return {key:'ssh-install',action:'Installing software on the Mac over SSH',remoteMac:true};
    if (/\blaunchctl\s+(?:bootstrap|load|enable)\b/i.test(code))
      return {key:'ssh-background-item',action:'Adding a Mac background item over SSH',remoteMac:true};
    return {key:'ssh-command',action:'Running a command on the Mac over SSH',remoteMac:true};
  }
  const start = '(?:^|[;&|]\\s*|\\n\\s*)(?:sudo\\s+)?';
  const install = new RegExp(start+'(?:/opt/homebrew/bin/)?(?:brew\\s+install(?:\\s+--cask)?|mas\\s+install|uv\\s+tool\\s+install|pip(?:3)?\\s+install|npm\\s+install\\s+-g)\\s+([\\w./-]+)','i').exec(code);
  if (install) {
    const name = safeName(install[1]!);
    return { key: `install:${name.toLowerCase()}`, action: `Installing ${name}` };
  }
  if (new RegExp(start+'(?:/bin/)?launchctl\\s+(?:bootstrap|load|enable)\\b','i').test(code))
    return { key: 'background-item', action: 'Adding a Mac background item' };
  if (/\bxcrun\s+simctl\s+(?:boot|launch|io|ui|create|install|push|openurl)\b|\bsafaridriver\b|\bscripts\/ios-look\.mjs\b/i.test(code))
    return {key:'ios-simulator',action:'Using the iPhone Simulator on the Mac'};
  if (/\bagent-browser\b|\bplaywright\s+(?:open|codegen|test)\b/i.test(code)
    && !/^\s*(?:rg|grep|sed|cat|git\s+diff)\b/.test(code))
    return {key:'agent-browser',action:'Running an agent browser on the Mac'};
  if (/--remote-debugging-(?:port|pipe)\b|\bconnectOverCDP\b/i.test(code) && !/^\s*(?:rg|grep|sed|cat|git\s+diff)\b/.test(code))
    return { key: 'chrome-debugging', action: 'Opening Chrome with debugging access' };
  if (new RegExp(start+'(?:[^\\s]+/)?(?:mac-screenshot|mac-capture|screencapture)\\b','i').test(code))
    return { key: 'screen-capture', action: 'Capturing a Mac window or screen' };
  if (new RegExp(start+'(?:/usr/bin/)?osascript\\b','i').test(code) || /cua_repl|computer.use|skycomputeruse/i.test(tool))
    return { key: 'app-control', action: 'Controlling or inspecting a Mac app' };
  const launched = new RegExp(start+'(?:/usr/bin/)?open\\s+-a\\s+(?:[\\\'"]?/Applications/)?([^\\\'"\\s/]+(?:\\s[^\\\'"/]+)?\\.app)','i').exec(code);
  if (launched) {
    const name = safeName(launched[1]!.replace(/\.app$/i, ''));
    return { key: `open:${name.toLowerCase()}`, action: `Opening ${name} on the Mac` };
  }
  return null;
}
