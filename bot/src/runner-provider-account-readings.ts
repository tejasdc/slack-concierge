/** Read-only provider usage collection for runner-owned homes; deliberately imports no owner state. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runnerAccountHomes } from "./runner-provider-accounts";

type UsageWindow = { name: string; usedPercent: number; durationMinutes?: number | null; resetsAt: string | null;
  willLastToReset: boolean | null; runsOutAt: string | null };
type AccountUsage = { label: string; plan: string | null; current: boolean; windows: UsageWindow[];
  problem: string | null; signedOut?: boolean; readAt?: string | null };
type ProviderUsage = { observedAt: string; accounts: AccountUsage[]; problem: string | null };
const LOCAL_BIN = join(homedir(), ".local", "bin");
const codexBar = findTool(process.env.CONCIERGE_CODEXBAR, ["/root/tools/codexbar-cli/codexbar", "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar", join(LOCAL_BIN, "codexbar"), "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"]);
const claudeSwap = findTool(process.env.CONCIERGE_CSWAP, [join(LOCAL_BIN, "cswap"), "/opt/homebrew/bin/cswap", "/usr/local/bin/cswap"]);

function findTool(override: string | undefined, candidates: string[]): string {
  if (override?.trim()) return override.trim();
  const names = (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => join(dir, candidates[0]!.split("/").pop()!));
  return [...candidates, ...names].find(existsSync) ?? candidates[0]!;
}
function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}
async function read(command: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn([command, ...args], { env: { ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH ?? ""}`, ...env },
    stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 90_000);
  try { const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]); return stdout; }
  finally { clearTimeout(timer); }
}
function codexPlan(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const names: Record<string, string> = { pro: "Pro", prolite: "Pro Lite", plus: "Plus", team: "Team", business: "Business" };
  return names[value] ?? value;
}
function codexWindows(row: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (slot: string, block: any, pace: any) => {
    const usedPercent = percent(block?.usedPercent);
    if (usedPercent === null) return;
    const durationMinutes = Number.isSafeInteger(block?.windowMinutes) && block.windowMinutes > 0 ? block.windowMinutes : null;
    const name = durationMinutes === 300 ? "5-hour" : durationMinutes === 10080 ? "Weekly"
      : durationMinutes ? `${durationMinutes}-minute allowance` : `${slot} allowance (duration unknown)`;
    const eta = pace?.willLastToReset === false && Number.isFinite(pace?.etaSeconds) && pace.etaSeconds > 0
      ? new Date(Date.now() + pace.etaSeconds * 1000).toISOString() : null;
    windows.push({ name, durationMinutes, usedPercent, resetsAt: iso(block?.resetsAt),
      willLastToReset: typeof pace?.willLastToReset === "boolean" ? pace.willLastToReset : null, runsOutAt: eta });
  };
  add("5-hour", row?.usage?.primary, row?.pace?.primary);
  add("Weekly", row?.usage?.secondary, row?.pace?.secondary);
  return windows;
}
async function readCodex(): Promise<ProviderUsage> {
  const observedAt = new Date().toISOString();
  if (!existsSync(codexBar)) return { observedAt, accounts: [], problem: "CodexBar is not installed on this runner." };
  const homes = runnerAccountHomes("codex");
  const accounts: AccountUsage[] = [];
  for (const { account: label, home } of homes) {
    try {
      const rows = JSON.parse(await read(codexBar, ["usage", "--provider", "codex", "--format", "json"], { CODEX_HOME: home }));
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row?.error) {
        const message = String(row.error.message ?? "");
        const signedOut = /token_revoked|invalidated oauth token|token_expired|refresh_token_reused|401 Unauthorized/i.test(message);
        accounts.push({ label, plan: codexPlan(row?.usage?.loginMethod), current: home === join(homedir(), ".codex"), windows: [],
          problem: signedOut ? "This sign-in stopped working. It needs signing in again." : "Usage could not be read.", ...(signedOut ? { signedOut: true } : {}) });
        continue;
      }
      accounts.push({ label, plan: codexPlan(row?.usage?.loginMethod), current: home === join(homedir(), ".codex"),
        windows: codexWindows(row), problem: null, readAt: iso(row?.usage?.updatedAt) });
    } catch { accounts.push({ label, plan: null, current: home === join(homedir(), ".codex"), windows: [], problem: "Usage could not be read." }); }
  }
  return { observedAt, accounts, problem: null };
}

function claudeWindows(usage: any): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (name: string, window: any) => {
    const usedPercent = percent(window?.pct);
    if (usedPercent === null) return;
    windows.push({ name, usedPercent, resetsAt: iso(window?.resetsAt),
      willLastToReset: typeof window?.willLastToReset === "boolean" ? window.willLastToReset : null,
      runsOutAt: window?.willLastToReset === false ? iso(window?.projectedExhaustionAt) : null });
  };
  add("5-hour", usage?.fiveHour); add("Weekly", usage?.sevenDay);
  for (const window of Array.isArray(usage?.scoped) ? usage.scoped : [])
    add(`Weekly · ${typeof window?.name === "string" && window.name ? `${window.name} only` : "one model"}`, window);
  return windows;
}
const ownClaudeReads = new Map<string, { version: string; nextAt: number; windows: UsageWindow[] | null; readAt: string | null }>();

/** The runner launches from this home. claude-swap's separate copy can report an old refusal after
 * Accounts has filed a working login here, so a fresh own-home answer takes precedence. */
async function ownClaudeWindows(home: string): Promise<{ windows: UsageWindow[]; readAt: string } | null> {
  const path = join(home, ".credentials.json");
  let version: string;
  try { const stat = statSync(path); version = `${stat.mtimeMs}:${stat.size}`; }
  catch { return null; }
  const prior = ownClaudeReads.get(home);
  if (prior?.version === version && Date.now() < prior.nextAt)
    return prior.windows && prior.readAt ? { windows: prior.windows, readAt: prior.readAt } : null;
  let windows: UsageWindow[] | null = null;
  let readAt: string | null = null;
  try {
    const token = JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token) {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "Concierge/1.0 (https://thnkr.ing)" },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) {
        const usage: any = await response.json();
        windows = [];
        const add = (name: string, block: any) => {
          const usedPercent = percent(block?.utilization);
          if (usedPercent === null) return;
          windows!.push({ name, usedPercent, resetsAt: iso(block?.resets_at), willLastToReset: null, runsOutAt: null });
        };
        add("5-hour", usage?.five_hour);
        add("Weekly", usage?.seven_day);
        for (const limit of Array.isArray(usage?.limits) ? usage.limits : [])
          if (limit?.kind === "weekly_scoped" && typeof limit?.scope?.model?.display_name === "string")
            add(`Weekly · ${limit.scope.model.display_name} only`, { utilization: limit.percent, resets_at: limit.resets_at });
        readAt = new Date().toISOString();
      }
    }
  } catch { /* A failed read cannot invalidate the sign-in or the last provider reading. */ }
  ownClaudeReads.set(home, { version, nextAt: Date.now() + 5 * 60_000, windows, readAt });
  return windows && readAt ? { windows, readAt } : null;
}
/** Whether this home's own Claude login still holds a refresh token that has not expired. */
function ownLoginRefreshable(home: string): boolean {
  try {
    const login = JSON.parse(readFileSync(join(home, ".credentials.json"), "utf8"))?.claudeAiOauth;
    if (typeof login?.refreshToken !== "string" || !login.refreshToken) return false;
    const until = Number(login.refreshTokenExpiresAt);
    return !Number.isFinite(until) || until > Date.now();
  } catch { return false; }
}
async function readClaude(): Promise<ProviderUsage> {
  const observedAt = new Date().toISOString();
  const homes = new Map(runnerAccountHomes("claude-code").map(account => [account.account, account.home]));
  const listed = await readClaudeSwapAccounts(homes);
  const accounts = listed.accounts;
  // claude-swap knows only the accounts added to it; an account signed in through Accounts has its own
  // runner home and is never added there (adding copies the login, which dies when the original renews).
  // Every signed-in home it does not list is read from that home's own login, as the owner's reader has
  // done since 2026-11-03: hey@tejas.nyc was missing from the runner's reading after usage moved here.
  for (const [label, home] of homes) {
    if (accounts.some(account => account.label === label)) continue;
    const own = await ownClaudeWindows(home);
    accounts.push({ label, plan: null, current: home === join(homedir(), ".claude"), windows: own?.windows ?? [],
      problem: own ? null : "Usage could not be read.", readAt: own?.readAt ?? null });
  }
  return { observedAt, accounts, problem: accounts.length ? null : listed.problem };
}
async function readClaudeSwapAccounts(homes: Map<string, string>): Promise<{ accounts: AccountUsage[]; problem: string | null }> {
  if (!existsSync(claudeSwap)) return { accounts: [], problem: "claude-swap is not installed on this runner." };
  try {
    const list = JSON.parse(await read(claudeSwap, ["list", "--json"]));
    if (!Array.isArray(list?.accounts)) throw new Error("account list absent");
    const accounts: AccountUsage[] = [];
    for (const account of list.accounts) {
      const label = String(account?.email || account?.alias || `Account ${account?.number ?? "?"}`);
      const hasUsage = account?.usage != null;
      const usage = hasUsage ? account.usage : account?.lastGoodUsage ?? null;
      const status = String(account?.usageStatus ?? "");
      // Do not report another machine's saved login as a runner-owned account.
      const home = homes.get(label);
      if (!home) continue;
      const own = status === "ok" ? null : await ownClaudeWindows(home);
      // claude-swap's status describes its own copy of the login, which goes stale when the real one
      // renews; token_expired only means a deferred refresh. The runner launches from its own home, so
      // that home's refresh token decides: on 2026-11-13 a routine access-token expiry made the own
      // read fail, claude-swap's stale copy said relogin_required, and the Mac's browser agent was sent
      // to renew a login whose refresh token was valid for three more weeks. A refresh token the
      // provider revoked early is caught by the refused turn that uses it.
      const signedOut = !own && status === "relogin_required" && !ownLoginRefreshable(home);
      accounts.push({ label, plan: null, current: homes.get(label) === join(homedir(), ".claude"),
        windows: own?.windows ?? claudeWindows(usage), problem: own || status === "ok" ? null : signedOut
          ? "This account needs signing in again." : usage ? "Showing the last reading; the latest could not be taken." : "Usage could not be read.",
        ...(signedOut ? { signedOut: true } : {}), readAt: own?.readAt ?? iso(hasUsage ? account?.usageFetchedAt : account?.lastGoodFetchedAt) });
    }
    return { accounts, problem: null };
  } catch { return { accounts: [], problem: "Claude usage could not be read." }; }
}

/** Reads are snapshots only: no owner allowance decision or request state is imported or changed. */
export async function readRunnerProviderAccountReadings(): Promise<Record<"codex" | "claude-code", ProviderUsage>> {
  const [codex, claudeCode] = await Promise.all([readCodex(), readClaude()]);
  return { codex, "claude-code": claudeCode };
}
