#!/usr/bin/env bun
// Approve one Claude Code paste-code sign-in in Tejas's own Chrome session.
// Input is one JSON object on stdin: {"url":"...","account":"..."}.
// stdout is exactly one JSON result; the OAuth URL and code never enter logs or argv.

type Request = { url: string; account: string };
type Result = { ok: true; account: string; code: string }
  | { ok: true; account: string; profile: string; authorized: false }
  | { ok: false; reason: string };

const CLIENT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CALLBACK = "https://platform.claude.com/oauth/code/callback";
const PROFILES = ["Default", "Profile 1"] as const;
const argumentsPassed = process.argv.slice(2);
const dryRun = argumentsPassed.length === 1 && argumentsPassed[0] === "--dry-run";

function validRequest(value: unknown): Request {
  if (!value || typeof value !== "object") throw Error("invalid input");
  const input = value as Record<string, unknown>;
  if (typeof input.url !== "string" || typeof input.account !== "string") throw Error("invalid input");
  if (!["tejastej.dc@gmail.com", "tejas@chann.app"].includes(input.account)) throw Error("unsupported account");
  if (input.url.length > 8192 || /[\u0000-\u001f\u007f]/.test(input.url)) throw Error("invalid input");
  const url = new URL(input.url);
  const p = url.searchParams;
  if (url.protocol !== "https:" || url.port || url.hostname !== "claude.ai" || url.pathname !== "/oauth/authorize"
    || url.username || url.password || url.hash
    || p.get("client_id") !== CLIENT || p.get("response_type") !== "code"
    || p.get("code") !== "true" || p.get("redirect_uri") !== CALLBACK
    || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")
    || !p.get("state") || [...p.keys()].some(key => !["client_id", "response_type", "code", "redirect_uri", "code_challenge_method", "code_challenge", "state", "scope"].includes(key))) {
    throw Error("not a Claude Code paste-code sign-in link");
  }
  if ([...new Set(p.keys())].some(key => p.getAll(key).length !== 1)) throw Error("not a Claude Code paste-code sign-in link");
  return { url: input.url, account: input.account };
}

function appleString(value: string): string {
  // AppleScript text literals cannot contain newlines or unescaped delimiters.
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "").replaceAll("\r", "")}"`;
}

async function apple(script: string): Promise<string> {
  const proc = Bun.spawn(["/usr/bin/osascript", "-"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(script);
  proc.stdin.end();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 12_000);
  try {
    const [status, output] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    if (timedOut) throw Error("Chrome did not answer: turn on Google Chrome under thnkr.ing in System Settings, Privacy & Security, Automation");
    if (status !== 0) throw Error("macOS refused control of Chrome: turn on Google Chrome under thnkr.ing in System Settings, Privacy & Security, Automation");
    return output.trim();
  } finally { clearTimeout(timeout); }
}

async function markedTab(marker: string): Promise<{ windowId: string; tab: string } | null> {
  const result = await apple(`tell application "Google Chrome"
repeat with w in every window
  repeat with t in every tab of w
    if URL of t is ${appleString(marker)} then return (id of w as text) & "|" & (id of t as text)
  end repeat
end repeat
return ""
end tell`);
  const match = /^(\d+)\|(\d+)$/.exec(result);
  return match ? { windowId: match[1], tab: match[2] } : null;
}

async function newWindow(profile: string, marker: string): Promise<{ windowId: string; tab: string }> {
  // The launched process passes a profile name and blank page only. The sign-in URL is set
  // later over Apple Events, so it never appears in a process list or another Chrome tab.
  const proc = Bun.spawn(["/usr/bin/open", "-a", "Google Chrome", "--args", `--profile-directory=${profile}`, "--new-window", marker], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  const openTimeout = setTimeout(() => proc.kill("SIGKILL"), 5_000);
  try {
    if (await proc.exited !== 0) throw Error("Chrome did not open a new profile window");
  } finally { clearTimeout(openTimeout); }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tab = await markedTab(marker);
    if (tab) return tab;
    await Bun.sleep(200);
  }
  throw Error("Chrome did not open a new profile window");
}

async function tabUrl(windowId: string, tab: string): Promise<string> {
  return apple(`tell application "Google Chrome" to return URL of tab id ${tab} of window id ${windowId}`);
}

async function setTabUrl(windowId: string, tab: string, url: string): Promise<void> {
  await apple(`tell application "Google Chrome" to set URL of tab id ${tab} of window id ${windowId} to ${appleString(url)}`);
}

async function javascript(windowId: string, tab: string, js: string): Promise<string> {
  return apple(`tell application "Google Chrome" to execute tab id ${tab} of window id ${windowId} javascript ${appleString(js)}`);
}

async function closeOwnTab(windowId: string, tab: string): Promise<void> {
  // Both IDs came from the newly created window. If either disappeared, never substitute
  // an active tab or front window: another tab may now occupy that position.
  const current = await apple(`tell application "Google Chrome" to return id of tab id ${tab} of window id ${windowId}`);
  if (current === tab) await apple(`tell application "Google Chrome" to close tab id ${tab} of window id ${windowId}`);
}

const ACCOUNT_JS = `(() => {
  if (location.origin !== 'https://claude.ai' || location.pathname !== '/oauth/authorize') return JSON.stringify({state:'other'});
  const heading = [...document.querySelectorAll('h1,h2')].some(el => el.textContent?.trim() === 'Claude Code would like to connect to your Claude chat account');
  const accounts = [...document.querySelectorAll('div.text-muted')].map(el => el.textContent?.trim() || '').filter(v => /^Logged in as /i.test(v));
  const buttons = [...document.querySelectorAll('button')].filter(el => el.textContent?.trim() === 'Authorize' && !el.disabled);
  return JSON.stringify({state: heading && accounts.length === 1 && buttons.length === 1 ? 'ready' : 'changed', account: accounts.length === 1 ? accounts[0].slice('Logged in as '.length).trim() : ''});
})()`;

const AUTHORIZE_JS = `(() => {
  if (location.href !== new URL(__URL_LITERAL__).href) return 'changed';
  const heading = [...document.querySelectorAll('h1,h2')].some(el => el.textContent?.trim() === 'Claude Code would like to connect to your Claude chat account');
  const accounts = [...document.querySelectorAll('div.text-muted')].map(el => el.textContent?.trim() || '').filter(v => /^Logged in as /i.test(v));
  const buttons = [...document.querySelectorAll('button')].filter(el => el.textContent?.trim() === 'Authorize' && !el.disabled);
  if (!heading || accounts.length !== 1 || accounts[0] !== 'Logged in as __ACCOUNT__' || buttons.length !== 1) return 'changed';
  buttons[0].click(); return 'clicked';
})()`;

async function main(): Promise<Result> {
  if (argumentsPassed.length > 1 || (argumentsPassed.length === 1 && !dryRun)) return { ok: false, reason: "usage: approve-claude-signin [--dry-run]" };
  let request: Request;
  try { request = validRequest(JSON.parse(await Bun.stdin.text())); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, reason: ["unsupported account", "not a Claude Code paste-code sign-in link"].includes(message) ? message : "invalid input" };
  }
  let reason = "The expected account is not signed in to Claude in Chrome";
  for (const profile of PROFILES) {
    let windowId = "", tab = "";
    let approvalAttempted = false;
    let creationAttempted = false;
    const marker = `about:blank#concierge-signin-${crypto.randomUUID()}`;
    try {
      await markedTab(marker); // Check Automation before creating a tab.
      creationAttempted = true;
      ({ windowId, tab } = await newWindow(profile, marker));
      await setTabUrl(windowId, tab, request.url);
      let observed: {state: string; account?: string} | undefined;
      const pageDeadline = Date.now() + 9_000;
      while (Date.now() < pageDeadline) {
        observed = JSON.parse(await javascript(windowId, tab, ACCOUNT_JS));
        if (observed?.state === "ready") break;
        await Bun.sleep(300);
      }
      if (observed?.state !== "ready") { reason = "Claude's authorize page changed or did not load"; continue; }
      if (observed.account !== request.account) continue;
      if (dryRun) return { ok: true, account: request.account, profile, authorized: false };
      approvalAttempted = true;
      const click = await javascript(windowId, tab, AUTHORIZE_JS.replace("__ACCOUNT__", request.account).replace("__URL_LITERAL__", JSON.stringify(request.url)));
      if (click !== "clicked") throw Error("Claude's authorize page changed before approval");
      const expectedState = new URL(request.url).searchParams.get("state");
      const callbackDeadline = Date.now() + 12_000;
      while (Date.now() < callbackDeadline) {
        const page = await tabUrl(windowId, tab);
        const callback = new URL(page);
        if (callback.origin + callback.pathname === CALLBACK) {
          if (callback.searchParams.get("state") !== expectedState) throw Error("Claude callback state did not match this sign-in");
          const codes = callback.searchParams.getAll("code");
          if (codes.length === 1 && codes[0].length >= 20 && codes[0].length <= 8192) {
            return { ok: true, account: request.account, code: codes[0] };
          }
          throw Error("Claude callback had no single authorization code");
        }
        await Bun.sleep(300);
      }
      throw Error("Claude did not show a single paste code");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      reason = [
        "macOS refused control of Chrome: turn on Google Chrome under thnkr.ing in System Settings, Privacy & Security, Automation",
        "Chrome did not answer: turn on Google Chrome under thnkr.ing in System Settings, Privacy & Security, Automation",
        "Chrome did not open a new profile window",
        "Claude's authorize page changed before approval",
        "Claude callback state did not match this sign-in",
        "Claude callback had no single authorization code",
        "Claude did not show a single paste code",
      ].includes(message) ? message : "Chrome approval failed";
      if (approvalAttempted || /^(Chrome did not answer|macOS refused control of Chrome)/.test(reason)) break;
    } finally {
      if (creationAttempted) {
        if (!windowId || !tab) ({ windowId, tab } = await markedTab(marker) || { windowId: "", tab: "" });
        if (windowId && tab) await closeOwnTab(windowId, tab);
      }
    }
  }
  return { ok: false, reason };
}

const result = await main().catch((): Result => ({ ok: false, reason: "The tab could not be closed; inspect the Chrome window opened for this sign-in" }));
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.ok ? 0 : 1;
