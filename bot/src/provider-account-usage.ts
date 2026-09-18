import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./state";
import { log } from "./log";
import type { ProviderKey } from "./provider-accounts";

/**
 * Usage limits for every account of a provider, not only the one agents use.
 *
 * Reading never signs in, switches or renews anything. Codex accounts each live in
 * their own Codex home: the agents' home plus one folder per extra account under
 * ~/.codex-accounts. CodexBar reads a home's usage with its stored access token and
 * never refreshes or rewrites it. Claude accounts come from claude-swap, which keeps
 * each account's credentials and reads their usage without switching the active one.
 *
 * Both tools are optional: a missing tool leaves that provider's list empty with a
 * reason instead of failing the providers read.
 */

export type UsageWindow = Readonly<{
  name: string;
  usedPercent: number;
  resetsAt: string | null;
  willLastToReset: boolean | null;
  runsOutAt: string | null;
}>;

export type AccountUsage = Readonly<{
  label: string;
  plan: string | null;
  current: boolean;
  windows: readonly UsageWindow[];
  problem: string | null;
}>;

export type ProviderUsage = Readonly<{
  observedAt: string;
  accounts: readonly AccountUsage[];
  problem: string | null;
}>;

const LOCAL_BIN = join(homedir(), ".local", "bin");
const CODEXBAR = process.env.CONCIERGE_CODEXBAR ?? "/root/tools/codexbar-cli/codexbar";
const CSWAP = process.env.CONCIERGE_CSWAP ?? join(LOCAL_BIN, "cswap");
const CODEX_ACCOUNTS = join(homedir(), ".codex-accounts");
const AGENT_CODEX_HOME = join(homedir(), ".codex");
const READ_TIMEOUT_MS = 90_000;
export const USAGE_REFRESH_MS = 30 * 60_000;

db.exec(`CREATE TABLE IF NOT EXISTS provider_account_usage (
  provider TEXT PRIMARY KEY CHECK (provider IN ('codex', 'claude-code')),
  observed_at TEXT NOT NULL,
  usage_json TEXT NOT NULL
)`);

async function run(command: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    env: { ...process.env, PATH: `${LOCAL_BIN}:${process.env.PATH ?? ""}`, ...env },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const timer = setTimeout(() => child.kill(), READ_TIMEOUT_MS);
  try {
    const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return stdout;
  } finally { clearTimeout(timer); }
}

function iso(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function runsOut(etaSeconds: unknown): string | null {
  return typeof etaSeconds === "number" && Number.isFinite(etaSeconds) && etaSeconds > 0
    ? new Date(Date.now() + etaSeconds * 1000).toISOString() : null;
}

function codexHomes(): { home: string; agents: boolean }[] {
  const homes = [{ home: AGENT_CODEX_HOME, agents: true }];
  if (!existsSync(CODEX_ACCOUNTS)) return homes;
  for (const name of readdirSync(CODEX_ACCOUNTS).sort()) {
    const home = join(CODEX_ACCOUNTS, name);
    if (existsSync(join(home, "auth.json"))) homes.push({ home, agents: false });
  }
  return homes;
}

/** Email and plan from a home's id token, used only to label and de-duplicate accounts. */
function codexIdentity(home: string): { email: string | null; plan: string | null } {
  try {
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
    const payload = String(auth?.tokens?.id_token ?? "").split(".")[1] ?? "";
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return { email: claims?.email ?? null, plan: claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null };
  } catch { return { email: null, plan: null }; }
}

const CODEX_PLAN: Record<string, string> = { pro: "Pro", prolite: "Pro Lite", plus: "Plus", team: "Team", business: "Business" };

async function codexAccount(home: string, agents: boolean): Promise<AccountUsage> {
  const identity = codexIdentity(home);
  const label = identity.email ?? (agents ? "Agents' account" : home.split("/").pop()!);
  const plan = identity.plan ? (CODEX_PLAN[identity.plan] ?? identity.plan) : null;
  let row: any;
  try { row = JSON.parse(await run(CODEXBAR, ["usage", "--provider", "codex", "--format", "json"], { CODEX_HOME: home }))[0]; }
  catch { return { label, plan, current: agents, windows: [], problem: "Usage could not be read." }; }
  if (row?.error) {
    const revoked = /token_revoked|invalidated oauth token/i.test(String(row.error.message ?? ""));
    return { label, plan, current: agents, windows: [],
      problem: revoked ? "OpenAI ended this sign-in. It needs signing in again." : "Usage could not be read." };
  }
  const usage = row?.usage ?? {}, pace = row?.pace ?? {};
  const windows: UsageWindow[] = [];
  const add = (name: string, window: any, windowPace: any) => {
    const used = percent(window?.usedPercent);
    if (used === null) return;
    windows.push({ name, usedPercent: used, resetsAt: iso(window?.resetsAt),
      willLastToReset: typeof windowPace?.willLastToReset === "boolean" ? windowPace.willLastToReset : null,
      runsOutAt: windowPace?.willLastToReset === false ? runsOut(windowPace?.etaSeconds) : null });
  };
  add("5-hour", usage.primary, pace.primary);
  add("Weekly", usage.secondary, pace.secondary);
  return { label, plan: plan ?? (usage.loginMethod ? (CODEX_PLAN[usage.loginMethod] ?? usage.loginMethod) : null),
    current: agents, windows, problem: null };
}

async function readCodex(): Promise<ProviderUsage> {
  if (!existsSync(CODEXBAR)) return { observedAt: new Date().toISOString(), accounts: [], problem: "CodexBar is not installed on this host." };
  const seen = new Set<string>(), accounts: AccountUsage[] = [];
  for (const { home, agents } of codexHomes()) {
    const email = codexIdentity(home).email;
    // The agents' home wins: a saved folder holding the same account is a stale copy.
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    accounts.push(await codexAccount(home, agents));
  }
  return { observedAt: new Date().toISOString(), accounts, problem: null };
}

async function readClaude(): Promise<ProviderUsage> {
  if (!existsSync(CSWAP)) return { observedAt: new Date().toISOString(), accounts: [], problem: "claude-swap is not installed on this host." };
  let list: any;
  try { list = JSON.parse(await run(CSWAP, ["list", "--json"])); }
  catch { return { observedAt: new Date().toISOString(), accounts: [], problem: "Claude usage could not be read." }; }
  const accounts: AccountUsage[] = [];
  for (const account of Array.isArray(list?.accounts) ? list.accounts : []) {
    const usage = account?.usage ?? account?.lastGoodUsage ?? null;
    const windows: UsageWindow[] = [];
    const add = (name: string, window: any) => {
      const used = percent(window?.pct);
      if (used === null) return;
      windows.push({ name, usedPercent: used, resetsAt: iso(window?.resetsAt),
        willLastToReset: typeof window?.willLastToReset === "boolean" ? window.willLastToReset : null,
        runsOutAt: window?.willLastToReset === false ? iso(window?.projectedExhaustionAt) : null });
    };
    add("5-hour", usage?.fiveHour);
    add("Weekly", usage?.sevenDay);
    // claude-swap lists model-specific weekly limits as an array carrying the model's name.
    for (const window of Array.isArray(usage?.scoped) ? usage.scoped : [])
      add(`Weekly · ${typeof window?.name === "string" && window.name ? `${window.name} only` : "one model"}`, window);
    const status = String(account?.usageStatus ?? "");
    const problem = status === "ok" ? null
      : status === "relogin_required" || status === "token_expired" ? "This account needs signing in again."
        : usage ? "Showing the last reading; the latest could not be taken." : "Usage could not be read.";
    accounts.push({ label: String(account?.alias || account?.email || `Account ${account?.number ?? "?"}`),
      plan: null, current: account?.active === true, windows, problem });
  }
  return { observedAt: new Date().toISOString(), accounts, problem: null };
}

export async function refreshProviderAccountUsage(): Promise<void> {
  for (const [provider, read] of [["codex", readCodex], ["claude-code", readClaude]] as const) {
    try {
      const usage = await read();
      db.query(`INSERT INTO provider_account_usage (provider, observed_at, usage_json) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at, usage_json = excluded.usage_json`)
        .run(provider, usage.observedAt, JSON.stringify(usage));
      log("info", "provider_account_usage_observed", { provider, accounts: usage.accounts.length,
        unreadable: usage.accounts.filter(account => account.problem).length, problem: !!usage.problem });
    } catch (error) {
      log("warn", "provider_account_usage_failed", { provider, error_name: (error as Error)?.name ?? "Error" });
    }
  }
}

export function providerAccountUsage(provider: ProviderKey): ProviderUsage | null {
  const row = db.query("SELECT usage_json FROM provider_account_usage WHERE provider = ?")
    .get(provider) as { usage_json: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.usage_json) as ProviderUsage; } catch { return null; }
}
