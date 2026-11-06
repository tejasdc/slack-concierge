/** Read-only provider usage collection for runner-owned homes; deliberately imports no owner state. */
import { existsSync } from "node:fs";
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
async function readClaude(): Promise<ProviderUsage> {
  const observedAt = new Date().toISOString();
  if (!existsSync(claudeSwap)) return { observedAt, accounts: [], problem: "claude-swap is not installed on this runner." };
  try {
    const list = JSON.parse(await read(claudeSwap, ["list", "--json"]));
    if (!Array.isArray(list?.accounts)) throw new Error("account list absent");
    const homes = new Map(runnerAccountHomes("claude-code").map(account => [account.account, account.home]));
    const accounts: AccountUsage[] = [];
    for (const account of list.accounts) {
      const label = String(account?.email || account?.alias || `Account ${account?.number ?? "?"}`);
      const hasUsage = account?.usage != null;
      const usage = hasUsage ? account.usage : account?.lastGoodUsage ?? null;
      const status = String(account?.usageStatus ?? "");
      const signedOut = status === "relogin_required" || status === "token_expired";
      // Do not report another machine's saved login as a runner-owned account.
      if (!homes.has(label)) continue;
      accounts.push({ label, plan: null, current: homes.get(label) === join(homedir(), ".claude"),
        windows: claudeWindows(usage), problem: status === "ok" ? null : signedOut
          ? "This account needs signing in again." : usage ? "Showing the last reading; the latest could not be taken." : "Usage could not be read.",
        ...(signedOut ? { signedOut: true } : {}), readAt: iso(hasUsage ? account?.usageFetchedAt : account?.lastGoodFetchedAt) });
    }
    return { observedAt, accounts, problem: null };
  } catch { return { observedAt, accounts: [], problem: "Claude usage could not be read." }; }
}

/** Reads are snapshots only: no owner allowance decision or request state is imported or changed. */
export async function readRunnerProviderAccountReadings(): Promise<Record<"codex" | "claude-code", ProviderUsage>> {
  const [codex, claudeCode] = await Promise.all([readCodex(), readClaude()]);
  return { codex, "claude-code": claudeCode };
}
