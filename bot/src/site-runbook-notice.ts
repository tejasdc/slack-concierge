/**
 * Tells an agent about a website's runbook just before it opens that website in a browser, so it
 * starts from what earlier agents learned (sign-in, what refuses agents, the steps that work)
 * instead of rediscovering it. The runbooks and their lookup command belong to the
 * `website-runbooks` skill; this module only notices the browser call and phrases the answer.
 * Built 2026-10-06 for the website-runbooks work (Inbox capture 7b0dae00). It never blocks a
 * call, and a missing lookup command says nothing.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type RunbookLookup = { found: boolean; path: string | null; domain: string | null; access: string | null; summary: string | null };

const BROWSER_OPEN = /\bagent-browser\b[^\n;&|]*?\s(?:open|goto|navigate)\s+((?:-\S+\s+)*)(['"]?)([^\s'"]+)\2/g;
const MCP_NAVIGATION = /^mcp__.*(?:navigate|new_page|open_url|goto)/i;

/** The URLs a tool call is about to open in a browser: agent-browser in a shell, or an MCP navigation. */
export function browsedUrls(toolName: string, input: Record<string, any>, command: string | null): string[] {
  if (MCP_NAVIGATION.test(toolName ?? '')) return typeof input.url === 'string' ? [input.url] : [];
  if (!command || !command.includes('agent-browser')) return [];
  return [...command.matchAll(BROWSER_OPEN)].map(match => match[3]);
}

/** The host a URL names, or null for anything that is not a public website. */
export function publicHost(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host.includes('.') || host.includes(':')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|ts\.net|test|example)$/.test(host)) return null;
  // His own apps: agents test them all the time, and their notes live in their own repositories.
  if (/(?:^|\.)(?:thnkr\.ing|tejas\.nyc)$/.test(host)) return null;
  return host.replace(/^www\./, '');
}

export function noticeFor(host: string, lookup: RunbookLookup): string {
  const domain = lookup.domain ?? host;
  if (!lookup.found) return `No runbook for ${domain} yet; write one from the website-runbooks skill's template when you finish.`;
  const notice = `Runbook for ${domain} (access: ${lookup.access ?? 'untested'}): ${lookup.path} - ${lookup.summary ?? ''}`.trimEnd().replace(/\.$/, '');
  return lookup.access === 'blocked'
    ? `STOP: ${domain} is BLOCKED for agents. ${notice}. Read it before continuing; do not browse this site until it says how.`
    : `${notice}. Read it before continuing.`;
}

function lookupCommand(): string {
  return process.env.SITE_RUNBOOK_COMMAND || join(homedir(), 'workspace/skills/website-runbooks-skill/bin/site-runbook');
}

function lookup(host: string): RunbookLookup | null {
  const command = lookupCommand();
  if (!existsSync(command)) return null;
  const result = Bun.spawnSync([command, '--json', host], { stdout: 'pipe', stderr: 'ignore', timeout: 5000 });
  if (result.exitCode !== 0 && result.exitCode !== 3) return null;
  try { return JSON.parse(result.stdout.toString()) as RunbookLookup; } catch { return null; }
}

/**
 * Claims the first notice for this domain in this provider session. Creating the marker is the
 * claim, so the two copies of the hook Claude runs (machine settings and Concierge's own) agree.
 */
function firstTimeInSession(sessionId: unknown, host: string): boolean {
  if (typeof sessionId !== 'string' || !sessionId) return true;
  const dir = join(tmpdir(), 'site-runbook-notices', sessionId.replace(/[^\w.-]/g, '_'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, host), '', { flag: 'wx' });
    return true;
  } catch { return false; }
}

/** The notices to show the agent before this call, at most one per domain per session. */
export function siteRunbookNotices(hook: Record<string, any>, command: string | null): string[] {
  const hosts = [...new Set(browsedUrls(hook.tool_name, hook.tool_input ?? {}, command).map(publicHost).filter((host): host is string => !!host))];
  const notices: string[] = [];
  for (const host of hosts) {
    if (!existsSync(lookupCommand())) return [];
    if (!firstTimeInSession(hook.session_id, host)) continue;
    const found = lookup(host);
    if (found) notices.push(noticeFor(host, found));
  }
  return notices;
}
