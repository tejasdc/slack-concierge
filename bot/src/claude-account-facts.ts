/**
 * What a Claude account includes beyond its allowance bars: the plan tier, its usage credits
 * (the pay-as-you-go balance that carries Claude and Claude Code past a limit) and the monthly
 * API credits a Max plan grants to its linked Console organization.
 *
 * Tejas, 2026-10-13: "I also added the API credits on my chann.app account, so both accounts
 * should accrue these API credits … It would be useful to build that into our dashboard too, so
 * we understand how much of the API credits we're using, if that information is available from
 * the same source we use for the usage here, or if Anthropic provides it directly."
 *
 * Where each fact comes from, from Anthropic's own words (checked 2026-10-13):
 *
 * - The plan tier and billing day come from `GET /api/oauth/profile` on the same OAuth login
 *   the usage bars are read with (`organization.rate_limit_tier`, `subscription_created_at`).
 * - Usage credits come from the same `GET /api/oauth/usage` the bars come from: its `spend`
 *   block carries the monthly cap, what was used this month, whether it is on and why not.
 *   support.claude.com article 12429409: credits are prepaid in Settings > Usage and bill
 *   usage beyond the plan at API rates; monthly API credits do not apply to them.
 * - Monthly API credits (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers):
 *   $100 a month on Max 5x and $200 on Max 20x, claimed by linking one Console organization
 *   from claude.ai Settings > Billing; they arrive each billing cycle shortly after the plan
 *   payment, expire at the end of that cycle with no rollover, show in the Console under
 *   Settings > Billing > Promotional credits, cover the API, Managed Agents, the Agent SDK and
 *   the playground, and never cover Claude Code or extra usage in the apps. **No API returns
 *   the credit balance.** What the Admin API does publish is the organization's cost report
 *   (`GET /v1/organizations/cost_report`, an Admin API key or another org-wide key; workspace
 *   keys refused), so spend this cycle is readable once a key for the linked organization is
 *   filed, and the remaining credit is the grant minus that spend while the organization holds
 *   only these credits. The key is delivered through the credential portal to the fixed path
 *   below and read here only in memory.
 *
 * Reading never signs in, refreshes or rewrites a login: an expired access token simply means
 * no fresh facts, and the last good ones are kept with their time. The usage endpoint has a
 * polling budget shared across every reader of the account (claude-swap already polls it), so
 * facts are refreshed every thirty minutes, not with every three-minute bar reading.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log";
import { accountHome, credentialPath, currentAccount, listProfiles } from "./provider-accounts";

export type UsageCreditsFacts = Readonly<{
  line: string;
  enabled: boolean;
  usedUsd: number | null;
  capUsd: number | null;
  balanceUsd: number | null;
}>;

export type ApiCreditsFacts = Readonly<{
  line: string;
  monthlyUsd: number | null;
  renewsAt: string | null;
  spentUsd: number | null;
  spentAsOf: string | null;
  source: "anthropic-cost-report" | "plan-tier" | null;
}>;

export type ClaudeAccountFacts = Readonly<{
  plan: string | null;
  usageCredits: UsageCreditsFacts | null;
  apiCredits: ApiCreditsFacts | null;
  readAt: string;
}>;

/** How often the facts are re-read per account; the bars are read far more often than this. */
export const FACTS_REFRESH_MS = 30 * 60_000;
const CALL_TIMEOUT_MS = 10_000;
/** Where the credential portal installs an Admin API key for an account's Console organization. */
export const ADMIN_KEY_DIR = "/root/.local/state/credential-portal/credentials/anthropic-admin-api";

const MONTHLY_API_CREDIT_USD: Readonly<Record<string, number>> = { "Max 5x": 100, "Max 20x": 200 };

export function planName(tier: unknown, hasMax: boolean, hasPro: boolean): string | null {
  const text = typeof tier === "string" ? tier : "";
  const match = /max_(\d+)x/.exec(text);
  if (match) return `Max ${match[1]}x`;
  if (hasMax) return "Max";
  if (hasPro || /pro/.test(text)) return "Pro";
  return text ? text.replace(/^default_claude_/, "").replace(/_/g, " ") : null;
}

/** The slug the portal and the key file use for an account address. */
export function adminKeySlug(account: string): string {
  return account.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function adminKeyPath(account: string): string {
  return join(ADMIN_KEY_DIR, `${adminKeySlug(account)}.json`);
}

/** The next and previous billing instants from the day of the month the subscription started. */
export function billingCycle(subscriptionCreatedAt: string | null, nowMs: number): { startMs: number; nextMs: number } | null {
  const created = subscriptionCreatedAt ? Date.parse(subscriptionCreatedAt) : NaN;
  if (!Number.isFinite(created)) return null;
  const start = new Date(created);
  const day = start.getUTCDate(), hour = start.getUTCHours(), minute = start.getUTCMinutes();
  const now = new Date(nowMs);
  // The cycle that contains now: the billing day this month if it has passed, else last month's.
  const onDay = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(day, last), hour, minute);
  };
  let startMs = onDay(now.getUTCFullYear(), now.getUTCMonth());
  if (startMs > nowMs) startMs = onDay(now.getUTCFullYear(), now.getUTCMonth() - 1);
  const after = new Date(startMs);
  const nextMs = onDay(after.getUTCFullYear(), after.getUTCMonth() + 1);
  return { startMs, nextMs };
}

const money = (usd: number) => `$${usd.toFixed(usd % 1 ? 2 : 0)}`;

export function usageCreditsFacts(spend: any): UsageCreditsFacts | null {
  if (!spend || typeof spend !== "object") return null;
  const minor = (block: any) => typeof block?.amount_minor === "number" && Number.isFinite(block.amount_minor)
    ? block.amount_minor / 10 ** (typeof block.exponent === "number" ? block.exponent : 2) : null;
  const enabled = spend.enabled === true;
  const usedUsd = minor(spend.used), capUsd = minor(spend.limit), balanceUsd = minor(spend.balance);
  const reason = typeof spend.disabled_reason === "string" ? spend.disabled_reason.replace(/_/g, " ") : null;
  const line = enabled
    ? `Usage credits: on; ${usedUsd !== null ? `${money(usedUsd)} used this month` : "use this month not reported"}`
      + (capUsd !== null ? ` of a ${money(capUsd)} monthly cap` : "")
      + (balanceUsd !== null ? `; ${money(balanceUsd)} left` : "") + "."
    : capUsd === null && usedUsd === null
      ? "Usage credits: never turned on."
      : `Usage credits: off${reason ? ` (${reason})` : ""}` + (capUsd !== null ? `; monthly cap ${money(capUsd)}` : "") + ".";
  return { line, enabled, usedUsd, capUsd, balanceUsd };
}

/** The Admin API's cost report for one billing cycle, summed in dollars; null when unreadable. */
async function costThisCycle(key: string, startMs: number, nowMs: number): Promise<number | null> {
  let total = 0, page: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const query = new URLSearchParams({ starting_at: new Date(startMs).toISOString(), ending_at: new Date(nowMs).toISOString(), bucket_width: "1d", limit: "31" });
    if (page) query.set("page", page);
    const response = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${query}`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "Concierge/1.0 (https://thnkr.ing)" },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) { log("warn", "anthropic_cost_report_refused", { status: response.status }); return null; }
    const body = await response.json() as any;
    for (const bucket of body?.data ?? [])
      for (const row of bucket?.results ?? []) {
        const cents = Number(row?.amount);
        if (Number.isFinite(cents)) total += cents;
      }
    if (!body?.has_more || !body?.next_page) break;
    page = String(body.next_page);
  }
  return Math.round(total) / 100;
}

async function readAdminKey(account: string): Promise<string | null> {
  const path = adminKeyPath(account);
  if (!existsSync(path)) return null;
  try {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    const key = stored?.token ?? stored?.fields?.token ?? stored?.values?.token;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch { return null; }
}

async function apiCreditsFacts(plan: string | null, subscriptionCreatedAt: string | null, account: string, nowMs: number,
  when: (ms: number) => string): Promise<ApiCreditsFacts> {
  const monthlyUsd = plan ? MONTHLY_API_CREDIT_USD[plan] ?? null : null;
  if (monthlyUsd === null)
    return { line: "API credits: none on this plan (Max 5x and 20x include them).", monthlyUsd: null, renewsAt: null, spentUsd: null, spentAsOf: null, source: null };
  const cycle = billingCycle(subscriptionCreatedAt, nowMs);
  const renewsAt = cycle ? new Date(cycle.nextMs).toISOString() : null;
  const key = await readAdminKey(account);
  let spentUsd: number | null = null;
  if (key && cycle) {
    try { spentUsd = await costThisCycle(key, cycle.startMs, nowMs); }
    catch (error) { log("warn", "anthropic_cost_report_failed", { error_name: (error as Error)?.name ?? "Error" }); }
  }
  const head = `API credits: ${money(monthlyUsd)} a month on ${plan}, in the linked Console organization`;
  const spend = spentUsd !== null
    ? `; ${money(spentUsd)} spent this cycle as of ${when(nowMs)} (Anthropic's cost report)${money(Math.max(0, monthlyUsd - spentUsd)) ? `, about ${money(Math.max(0, monthlyUsd - spentUsd))} left if nothing else was bought` : ""}`
    : key ? "; spend could not be read from Anthropic's cost report just now"
    : "; spend not readable until an Admin API key for that organization is filed";
  const renews = renewsAt ? `; renews ${when(cycle!.nextMs)}` : "";
  return { line: `${head}${spend}${renews}.`, monthlyUsd, renewsAt, spentUsd,
    spentAsOf: spentUsd !== null ? new Date(nowMs).toISOString() : null,
    source: spentUsd !== null ? "anthropic-cost-report" : "plan-tier" };
}

/** The credential file of the login this machine holds for an account, without copying it. */
function claudeCredentialFor(account: string): string | null {
  const profile = listProfiles("claude-code").find(entry => entry.label === account);
  if (profile) {
    const path = join(accountHome("claude-code", profile.id), ".credentials.json");
    if (existsSync(path)) return path;
  }
  if (currentAccount("claude-code")?.label === account && existsSync(credentialPath("claude-code"))) return credentialPath("claude-code");
  return null;
}

function liveAccessToken(path: string): string | null {
  try {
    const oauth = JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth;
    const token = oauth?.accessToken, expiresAt = Number(oauth?.expiresAt);
    if (typeof token !== "string" || !token) return null;
    // An expired token is not refreshed here: that is Claude's own job when it next runs.
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000) return null;
    return token;
  } catch { return null; }
}

async function oauthGet(token: string, path: string): Promise<any> {
  const response = await fetch(`https://api.anthropic.com${path}`, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "Concierge/1.0 (https://thnkr.ing)" },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const cache = new Map<string, ClaudeAccountFacts>();

/** Fresh facts when due and readable, else the last good ones, else null. Never throws. */
export async function claudeAccountFacts(account: string, when: (ms: number) => string, nowMs = Date.now()): Promise<ClaudeAccountFacts | null> {
  const kept = cache.get(account) ?? null;
  if (kept && nowMs - Date.parse(kept.readAt) < FACTS_REFRESH_MS) return kept;
  const path = claudeCredentialFor(account);
  const token = path ? liveAccessToken(path) : null;
  if (!token) {
    // Said in the log, never silently: a row with no plan or credit lines is otherwise undiagnosable.
    log("info", "claude_account_facts_no_live_login", { credential_found: path !== null, kept: kept !== null });
    return kept;
  }
  try {
    const [profile, usage] = await Promise.all([oauthGet(token, "/api/oauth/profile"), oauthGet(token, "/api/oauth/usage")]);
    const organization = profile?.organization ?? {};
    const plan = planName(organization.rate_limit_tier, profile?.account?.has_claude_max === true, profile?.account?.has_claude_pro === true);
    const facts: ClaudeAccountFacts = {
      plan,
      usageCredits: usageCreditsFacts(usage?.spend),
      apiCredits: await apiCreditsFacts(plan, typeof organization.subscription_created_at === "string" ? organization.subscription_created_at : null, account, nowMs, when),
      readAt: new Date(nowMs).toISOString(),
    };
    cache.set(account, facts);
    return facts;
  } catch (error) {
    log("info", "claude_account_facts_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return kept;
  }
}
