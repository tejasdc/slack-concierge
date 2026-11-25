import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The Claude API-credit route (docs/architecture/PROVIDER-USAGE.md#claude-api-credit-route).
 *
 * Anthropic grants the `tejas` Console organization a monthly promotional "API credit (Ultra)" that
 * covers the Agent SDK and the API but never Claude Code subscription use. A Claude session on this
 * route runs the same `claude` binary Concierge always runs, with the Console API key and the Agent
 * SDK entrypoint, so its tokens are billed to that credit instead of a subscription allowance.
 *
 * A route is a property of the session fixed when it is created (or, for overflow and banked work,
 * before its first provider conversation exists). A subscription conversation never becomes an API
 * one, and an API conversation never moves to a subscription account.
 */

/** The account label every API-route turn records, and the binding a resumed shell reads. */
export const API_CREDITS_ACCOUNT = "api-credits";
export type ClaudeRoute = "api-credits";

/**
 * Its own Claude configuration folder. The leading dot keeps it out of every account-folder scan
 * (those skip dot entries), and its transcripts stay here so an exact resume finds them.
 */
export function apiCreditsConfigDir(home = process.env.HOME || homedir()): string {
  return join(home, ".claude-accounts", ".api-credits");
}

/** Root-only file the credential portal wrote; the key is read into memory per launch and never logged. */
export const API_CREDITS_KEY_FILE = "/root/.local/state/credential-portal/credentials/anthropic-api/api-key.json";

export class ApiCreditsUnavailableError extends Error {}

function readApiKey(path: string): string {
  if (!existsSync(path)) throw new ApiCreditsUnavailableError(
    "The Console API key for the API-credit route is missing on this machine, so this API-credit session cannot start.");
  let key: unknown;
  try { key = JSON.parse(readFileSync(path, "utf8"))?.api_key; } catch { key = null; }
  if (typeof key !== "string" || !key.startsWith("sk-ant-")) throw new ApiCreditsUnavailableError(
    "The stored Console API key for the API-credit route is unreadable, so this API-credit session cannot start.");
  return key;
}

/**
 * The launch environment of an API-route turn. `CLAUDE_CODE_ENTRYPOINT=sdk-ts` is what the Agent SDK
 * sets when it spawns this same binary; it makes these runs Agent SDK runs, which the credit covers.
 * `CONCIERGE_CLAUDE_ROUTE` tells the agent's own shell launcher that the key belongs to this turn,
 * so a fresh `claude` started from the agent's shell drops it and stays on the subscription accounts.
 *
 * `CONCIERGE_CLAUDE_ACCOUNT_PIN` is deliberately not set: managed turns start the Claude binary
 * directly, and the variable would be inherited by the agent's shell, where it makes every nested
 * `claude` skip account selection and silently spend the key.
 */
export function apiCreditsEnvironment(options: { keyFile?: string; home?: string } = {}): Record<string, string> {
  const configDir = apiCreditsConfigDir(options.home);
  const key = readApiKey(options.keyFile ?? API_CREDITS_KEY_FILE);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return { ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CONCIERGE_CLAUDE_ROUTE: API_CREDITS_ACCOUNT };
}

/** Whether the key exists here; the overflow and banked rules never pick a route that cannot launch. */
export function apiCreditsConfigured(keyFile = API_CREDITS_KEY_FILE): boolean {
  try { readApiKey(keyFile); return true; } catch { return false; }
}

// ---- The credit cycle --------------------------------------------------------------------------

/**
 * Observed in the Console (Settings → Billing, https://platform.claude.com/settings/billing) on
 * 2026-11-25: "API credit (Ultra)", $200, granted Oct 22 and Nov 22; the Nov 22 grant expires
 * Dec 24, 7:00 PM ET (Dec 25 00:00 UTC). October's expired unused. No API reads the balance, so the
 * Console stays the authority and these constants are its observed schedule.
 */
export const API_CREDITS_GRANT_DAY = 22;
export const API_CREDITS_LIFETIME_DAYS = 32;
export const API_CREDITS_BUDGET_USD = 200;
export const API_CREDITS_CONSOLE_URL = "https://platform.claude.com/settings/billing";
/** Below this Concierge stops choosing the route by itself; a Claude Opus turn can cost a few dollars. */
export const API_CREDITS_FLOOR_USD = 5;
/** Banked work takes the route only in the last week, when unspent credit is about to be lost. */
export const API_CREDITS_BANKED_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type ApiCreditsCycle = { grantedAt: number; expiresAt: number; budgetUsd: number; spentUsd: number; remainingUsd: number };

/** The grant in force at `now`: the latest 22nd (UTC) not after it. */
export function apiCreditsGrant(now: number): { grantedAt: number; expiresAt: number } {
  const date = new Date(now);
  let year = date.getUTCFullYear(), month = date.getUTCMonth();
  if (date.getUTCDate() < API_CREDITS_GRANT_DAY) { month -= 1; if (month < 0) { month = 11; year -= 1; } }
  const grantedAt = Date.UTC(year, month, API_CREDITS_GRANT_DAY);
  // The Console's expiry is the end of the 32nd day after the grant date: Nov 22 → Dec 24, 7 PM ET.
  const expiresAt = Date.UTC(year, month, API_CREDITS_GRANT_DAY + API_CREDITS_LIFETIME_DAYS + 1);
  return { grantedAt, expiresAt };
}

export function ensureApiCreditSpendTable(db: Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS claude_api_credit_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  turn_id INTEGER,
  conversation_uuid TEXT,
  reported_total_usd REAL NOT NULL,
  delta_usd REAL NOT NULL,
  recorded_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS claude_api_credit_spend_time ON claude_api_credit_spend(recorded_at_ms);
CREATE INDEX IF NOT EXISTS claude_api_credit_spend_conversation ON claude_api_credit_spend(conversation_uuid, id);`);
}

/**
 * Record one result's `total_cost_usd`. Claude reports that figure cumulatively for the conversation,
 * including across resumes (2026-11-25: a resumed Haiku call reported its own tokens plus the first
 * call's). The spend is the increase over the previous reading of the same conversation; a lower
 * reading means Claude restarted its count, and the whole reading is new spend.
 */
export function recordApiCreditSpend(db: Database, input: { sessionId: number; turnId: number | null; conversationUuid: string | null; totalUsd: number; nowMs?: number }): number {
  if (!Number.isFinite(input.totalUsd) || input.totalUsd < 0) return 0;
  const previous = input.conversationUuid
    ? db.query("SELECT reported_total_usd FROM claude_api_credit_spend WHERE conversation_uuid=? ORDER BY id DESC LIMIT 1").get(input.conversationUuid) as { reported_total_usd: number } | null
    : null;
  const delta = previous && input.totalUsd >= previous.reported_total_usd ? input.totalUsd - previous.reported_total_usd : input.totalUsd;
  if (previous && delta === 0) return 0;
  db.query(`INSERT INTO claude_api_credit_spend (session_id,turn_id,conversation_uuid,reported_total_usd,delta_usd,recorded_at_ms)
    VALUES (?,?,?,?,?,?)`).run(input.sessionId, input.turnId, input.conversationUuid, input.totalUsd, delta, input.nowMs ?? Date.now());
  return delta;
}

export function apiCreditsCycle(db: Database, now = Date.now()): ApiCreditsCycle {
  const { grantedAt, expiresAt } = apiCreditsGrant(now);
  const spentUsd = (db.query("SELECT coalesce(sum(delta_usd),0) AS spent FROM claude_api_credit_spend WHERE recorded_at_ms>=?").get(grantedAt) as { spent: number }).spent;
  return { grantedAt, expiresAt, budgetUsd: API_CREDITS_BUDGET_USD, spentUsd, remainingUsd: Math.max(0, API_CREDITS_BUDGET_USD - spentUsd) };
}

/** What a session's whole recorded spend on the route is. */
export function apiCreditsSessionSpend(db: Database, sessionId: number): number {
  return (db.query("SELECT coalesce(sum(delta_usd),0) AS spent FROM claude_api_credit_spend WHERE session_id=?").get(sessionId) as { spent: number }).spent;
}

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export function formatEasternInstant(ms: number): string {
  return `${ET.format(new Date(ms)).replace(/\s(?=[AP]M$)/, " ")} ET`;
}

/** The one line beside the Claude accounts. */
export function apiCreditsLine(cycle: ApiCreditsCycle): string {
  return `API credits route: $${cycle.spentUsd.toFixed(2)} of $${cycle.budgetUsd} spent this cycle by Concierge (Console is the authority); expires ${formatEasternInstant(cycle.expiresAt)}`;
}

// ---- When Concierge chooses the route by itself ------------------------------------------------

export type ApiRouteDecision = { use: true; reason: string } | { use: false; reason: string };

/**
 * Banked work: only in the last week of a cycle with credit left, because unspent credit is lost at
 * expiry while subscription windows renew anyway. Overflow: whenever credit is left, because the
 * alternative is holding the work until a subscription account frees up.
 */
export function apiRouteDecision(kind: "banked" | "overflow", cycle: ApiCreditsCycle, now: number, configured = true): ApiRouteDecision {
  if (!configured) return { use: false, reason: "the Console API key is not on this machine" };
  if (now >= cycle.expiresAt) return { use: false, reason: "this credit cycle has expired" };
  if (cycle.remainingUsd <= API_CREDITS_FLOOR_USD)
    return { use: false, reason: `only $${cycle.remainingUsd.toFixed(2)} of the month's API credit is left by Concierge's count` };
  if (kind === "banked" && cycle.expiresAt - now > API_CREDITS_BANKED_WINDOW_MS)
    return { use: false, reason: "the API credit does not expire within 7 days, so banked work waits for subscription room" };
  return kind === "banked"
    ? { use: true, reason: `banked work spends the API credit that expires ${formatEasternInstant(cycle.expiresAt)} ($${cycle.remainingUsd.toFixed(2)} left by Concierge's count)` }
    : { use: true, reason: `every subscription Claude account is out of room; the API credit has $${cycle.remainingUsd.toFixed(2)} left by Concierge's count` };
}

// ---- Refusals ----------------------------------------------------------------------------------

/** Anthropic's words when the organization's credit is gone ("Your credit balance is too low …"). */
export function isApiCreditRefusal(message: string): boolean {
  return /credit balance is too low|insufficient (?:credit|balance)|purchase credits|plans? (?:&|and) billing/i.test(message);
}
/** The key itself refused (revoked, wrong organization). Not a sign-in: nothing on a Mac can renew it. */
export function isApiKeyRefusal(message: string): boolean {
  return /invalid x-api-key|invalid api key|authentication_error/i.test(message);
}

export function apiCreditsSpentMessage(now: number, detail = ""): string {
  const granted = new Date(apiCreditsGrant(now).grantedAt);
  const nextGrant = new Date(Date.UTC(granted.getUTCFullYear(), granted.getUTCMonth() + 1, API_CREDITS_GRANT_DAY));
  const day = nextGrant.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric" });
  return `This session runs on the monthly Anthropic API credit, and Anthropic says that credit is spent for this cycle. `
    + `Nothing moves it to a subscription account; the next grant is expected on ${day}. `
    + `Start a new session on another alias to continue now.${detail ? ` ${detail}` : ""}`;
}
