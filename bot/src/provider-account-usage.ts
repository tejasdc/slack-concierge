import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db, moveUsageHoldsEarlier, releaseUsageContinuationHolds } from "./state";
import { log } from "./log";
import { earliestRoomAt, recordUsageReading, usageReadingIsUrgent, withAgentsAccountCurrent } from "./provider-usage-forecast";
import { peerSettings } from "./session-peers";
import { cachedUsageLimit, claudeAccountCachedReset, releaseUsageHeldWork, usageAttempt } from "./provider-usage";
import { ACCOUNT_READING_MAX_AGE_MS, listProfiles, setAntigravityAccountInUse, type AccountIdentityProvider, type ProviderKey } from "./provider-accounts";
import {accountReadingFresh,chooseAccountObservation,includedAllowanceWindows,accountCanTakeWork} from './account-allowance-observation';
import { claudeEveryAccountClearsAt, claudeHeldWorkCanRun, proveClaudeHomesAhead, requestMissingClaudeHomes } from "./provider-account-dispatch";
import { needSignInRenewal } from "./signin-renewal";
import { accountUsageTable } from "./provider-usage-tables";
import { antigravityExecutable } from "./antigravity";
import { claudeAccountFacts, claudeCredentialVersion, claudeWindowsFromOwnLogin, renewClaudeOwnLoginForUsage, type ApiCreditsFacts, type UsageCreditsFacts } from "./claude-account-facts";
import type { ResetAdvice } from "./provider-reset-facts";
import { noticeTime } from "./notice-time";
import { resolveProviderAlias } from "./aliases";
import { renewSavedCodexLogin } from './codex-saved-login-renewal';

/**
 * Usage limits for every account of a provider, not only the one agents use.
 *
 * Reading never signs in or switches. Codex accounts each live in
 * their own Codex home: the agents' home plus one folder per extra account under
 * ~/.codex-accounts. CodexBar reads a home's usage with its stored access token and
 * never refreshes or rewrites it; an expired saved login is renewed by Codex itself in
 * its own home. Claude accounts come from claude-swap, which keeps
 * each account's credentials and reads their usage without switching the active one.
 *
 * Both tools are optional: a missing tool leaves that provider's list empty with a
 * reason instead of failing the providers read.
 */

export type UsageWindow = Readonly<{
  name: string;
  usedPercent: number;
  /** Provider duration, when supplied; slot position does not name a Codex window. */
  durationMinutes?: number | null;
  resetsAt: string | null;
  willLastToReset: boolean | null;
  runsOutAt: string | null;
}>;

/**
 * A banked allowance reset OpenAI has granted this account, waiting to be used.
 *
 * These are finite, they are given out occasionally rather than earned, and they lapse
 * thirty days after they are granted with no refund — so one that is never mentioned is
 * one that is simply lost. Both accounts were carrying one, granted 2026-09-22, and
 * nothing had ever said so: the reading that carried it was fetched every half hour and
 * this field was dropped on the floor.
 *
 * Anthropic has no equivalent to read. It has the idea — Claude's own copy offers
 * "Use your limit reset to reset it now" — but there is no per-account list of grants with
 * ids, grant times and expiries the way OpenAI publishes one, so nothing here pretends to
 * detect one.
 */
export type ResetCredits = Readonly<{
  available: number;
  /** The one that lapses first, which is the only expiry worth acting on. */
  expiresAt: string | null;
  title: string | null;
}>;

export type AccountUsage = Readonly<{
  label: string;
  plan: string | null;
  current: boolean;
  windows: readonly UsageWindow[];
  problem: string | null;
  /** True when the provider refused this account's sign-in (expired, reused or revoked). */
  signedOut?: boolean;
  /** Absent where the provider grants no such thing, which is everywhere but Codex. */
  resetCredits?: ResetCredits | null;
  /** Read by the other machine for this same account, because this one cannot read it. */
  viaPeer?: boolean;
  /** Peer provenance; account identity was matched by label, not by a credential subject. */
  sourcePeer?: string;
  peerMatch?: 'label-only';
  /**
   * When the reading tool last got these numbers from the provider, where it says so.
   * A forecast is a rate, so it has to know whether it is being handed a fresh number or
   * a remembered one; without this a cached reading would flatten the line and hide a
   * climb. Absent where the tool does not report it.
   */
  readAt?: string | null;
  /** Accounts view: source observation and measured window room, with unknown distinct from
   * spent. Room does not prove model admission, sign-in, or authorization to spend credits. */
  allowance?: Readonly<{ observedAt: string | null; evaluatedAt: string; validUntil: string | null;
    status: 'current' | 'old' | 'unknown' | 'unreadable'; hasRoom: boolean | null }>;
  /**
   * What a reset would do for this account right now, written for the row and for agents;
   * attached at read time by `withResetAdvice`, never stored, because it says how long is left.
   */
  resetAdvice?: ResetAdvice | null;
  /** Pay-as-you-go credits from the same reading as the bars: Claude usage credits, or the Codex credit balance. */
  usageCredits?: UsageCreditsFacts | null;
  /** Claude only: the monthly API credits a Max plan grants its linked Console organization. */
  apiCredits?: ApiCreditsFacts | null;
}>;

export type ProviderUsage = Readonly<{
  observedAt: string;
  accounts: readonly AccountUsage[];
  problem: string | null;
  /** A reading is running right now, so an account without one is being fetched, not absent. */
  refreshing?: boolean;
}>;

const LOCAL_BIN = join(homedir(), ".local", "bin");

/**
 * Where a reading tool actually is, rather than where the box happens to keep it.
 *
 * Both paths used to be single Linux absolutes, so on the Mac — which has CodexBar, at
 * `/opt/homebrew/bin/codexbar` — the existence check failed and the surface told him
 * "CodexBar is not installed on this host" about a tool that was installed and working.
 * He read his Mac's accounts page showing nothing for either provider and said so
 * (2026-09-23). A tool is looked up where each platform puts it, and on PATH, before it is
 * called absent.
 */
function resolveTool(override: string | undefined, candidates: string[]): string {
  const named = override?.trim();
  if (named) return named;
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => join(dir, candidates[0]!.split("/").pop()!));
  return [...candidates, ...onPath].find(existsSync) ?? candidates[0]!;
}

const CODEXBAR = resolveTool(process.env.CONCIERGE_CODEXBAR, [
  "/root/tools/codexbar-cli/codexbar", "/opt/homebrew/bin/codexbar", "/usr/local/bin/codexbar",
  join(LOCAL_BIN, "codexbar"), "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI",
]);
const CSWAP = resolveTool(process.env.CONCIERGE_CSWAP, [
  join(LOCAL_BIN, "cswap"), "/opt/homebrew/bin/cswap", "/usr/local/bin/cswap",
]);
const CODEX_ACCOUNTS = join(homedir(), ".codex-accounts");
const AGENT_CODEX_HOME = join(homedir(), ".codex");
const READ_TIMEOUT_MS = 90_000;
/**
 * How stale the numbers on his screen are allowed to be.
 *
 * Half an hour was chosen when these readings only decorated a dialog, and it is far too
 * coarse for what they are used for now: a five-hour window can go from comfortable to
 * spent inside one pass, so he was reading a number that had already stopped being true
 * ("30 minutes is not going to cut it", 2026-09-23).
 *
 * Three minutes is affordable because a reading is cheap and local: measured on the box, a
 * Codex account costs about two seconds and the whole Claude list about one, so a pass over
 * every account is a few seconds of one short-lived process against each provider's limits
 * endpoint. None of it is a model call, so none of it spends the allowance it reports.
 */
export const USAGE_REFRESH_MS = 3 * 60_000;
/** Near a limit, where a rate has to be visible before the wall rather than after it. */
export const USAGE_URGENT_REFRESH_MS = 60_000;

if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS provider_account_usage (
  provider TEXT PRIMARY KEY CHECK (provider IN ('codex', 'claude-code')),
  observed_at TEXT NOT NULL,
  usage_json TEXT NOT NULL
)`);
// Keep the installed Claude/Codex table intact; Google's snapshot has an additive home.
if (process.env.CONCIERGE_READ_WORKER !== "1") db.exec(`CREATE TABLE IF NOT EXISTS antigravity_account_usage (
  provider TEXT PRIMARY KEY CHECK (provider = 'antigravity'),
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
  // Named below by the caller, which drops what it cannot name.
  const plan = identity.plan ? (CODEX_PLAN[identity.plan] ?? identity.plan) : null;
  let row: any;
  try { row = JSON.parse(await run(CODEXBAR, ["usage", "--provider", "codex", "--format", "json"], { CODEX_HOME: home }))[0]; }
  catch { return { label, plan, current: agents, windows: [], problem: "Usage could not be read." }; }
  if (row?.error) {
    const message = String(row.error.message ?? "");
    if(!agents&&/token_expired/i.test(message)){
      const renewal=renewSavedCodexLogin(home,label,()=>{
        // A renewal may finish before the pass that noticed expiry has stored its result.
        // Wait for that pass to settle so the new reading cannot join and then disappear.
        void (inFlight??Promise.resolve()).catch(()=>{}).then(()=>scheduleProviderAccountUsageRefresh()).catch(()=>{});
      });
      if(renewal==='signed_out')return {label,plan,current:false,windows:[],signedOut:true,
        problem:'This saved Codex sign-in was refused by Codex. It needs signing in again.'};
      if(renewal!=='no_refresh_token')return {label,plan,current:false,windows:[],problem:renewal==='pending'
        ?'Saved Codex sign-in renewal is pending; usage cannot yet be read.'
        :'Saved Codex sign-in could not be renewed. Usage is unavailable; sign in again if it stays this way.'};
    }
    // A refused sign-in is not a failed reading: the account cannot run anything until it is
    // signed in again. On 2026-10-06 all three of the server's Codex sign-ins answered
    // "token_expired" while Accounts still listed them as signed in.
    const signedOut = /token_revoked|invalidated oauth token|token_expired|refresh_token_reused|401 Unauthorized/i.test(message);
    return { label, plan, current: agents, windows: [], ...(signedOut ? { signedOut: true } : {}),
      problem: signedOut ? "This sign-in stopped working. It needs signing in again." : "Usage could not be read." };
  }
  const usage = row?.usage ?? {}, pace = row?.pace ?? {};
  const windows: UsageWindow[] = [];
  const add = (slot: string, window: any, windowPace: any) => {
    const used = percent(window?.usedPercent);
    if (used === null) return;
    const durationMinutes = Number.isSafeInteger(window?.windowMinutes) && window.windowMinutes > 0
      ? window.windowMinutes as number : null;
    const name = durationMinutes === 300 ? "5-hour" : durationMinutes === 10080 ? "Weekly"
      : durationMinutes !== null ? `${durationMinutes}-minute allowance` : `${slot} allowance (duration unknown)`;
    windows.push({ name, durationMinutes, usedPercent: used, resetsAt: iso(window?.resetsAt),
      willLastToReset: typeof windowPace?.willLastToReset === "boolean" ? windowPace.willLastToReset : null,
      runsOutAt: windowPace?.willLastToReset === false ? runsOut(windowPace?.etaSeconds) : null });
  };
  add("5-hour", usage.primary, pace.primary);
  add("Weekly", usage.secondary, pace.secondary);
  return { label, plan: plan ?? (usage.loginMethod ? (CODEX_PLAN[usage.loginMethod] ?? usage.loginMethod) : null),
    current: agents, windows, problem: null, readAt: iso(usage.updatedAt),
    resetCredits: resetCredits(usage.codexResetCredits), usageCredits: codexCredits(row?.credits) };
}

/** The ChatGPT credit balance the same reading reports (OpenAI's "Extra usage" pool). The
 * reading carries no expiry, so none is stated; a grant's expiry lives only in OpenAI's email. */
function codexCredits(block: any): UsageCreditsFacts | null {
  if (block?.balanceReadSucceeded !== true || typeof block?.remaining !== "number" || !Number.isFinite(block.remaining)) return null;
  const left = Math.floor(block.remaining).toLocaleString("en-US");
  const enabled = block.creditsAvailable === true && block.remaining > 0;
  return { line: enabled ? `Codex credits: ${left} left for use beyond the plan's limits.` : `Codex credits: ${left} left, not currently usable.`,
    enabled, observedAt:iso(block.updatedAt), usedUsd: null, capUsd: null, balanceUsd: null };
}

/** Only the grants that can still be used; a spent or lapsed one is not an opportunity. */
function resetCredits(block: any): ResetCredits | null {
  const credits = (Array.isArray(block?.credits) ? block.credits : [])
    .filter((credit: any) => String(credit?.status ?? "") === "available");
  if (!credits.length) return null;
  const expiries = credits.map((credit: any) => iso(credit?.expires_at)).filter(Boolean) as string[];
  return {
    available: credits.length,
    expiresAt: expiries.sort()[0] ?? null,
    title: typeof credits[0]?.title === "string" && credits[0].title ? credits[0].title : null,
  };
}

async function readCodex(): Promise<ProviderUsage> {
  if (!existsSync(CODEXBAR)) return { observedAt: new Date().toISOString(), accounts: [], problem: "CodexBar is not installed on this host." };
  const seen = new Set<string>(), accounts: AccountUsage[] = [];
  for (const { home, agents } of codexHomes()) {
    const email = codexIdentity(home).email;
    // The agents' home wins: a saved folder holding the same account is a stale copy.
    if (email && seen.has(email)) continue;
    if (email) seen.add(email);
    // A reading that cannot say whose account it is has nothing to tell him: he was shown a
    // box headed "Agents' account" saying only that its usage could not be read, about an
    // account it could not name and he could not act on (2026-09-22).
    if (!email) continue;
    accounts.push(await codexAccount(home, agents));
  }
  return { observedAt: new Date().toISOString(), accounts, problem: null };
}

/**
 * One Claude account's windows read from its own login, at most once per OWN_LOGIN_INTERVAL_MS (inside
 * the six minutes a reading counts as fresh), doubling the gap after each failure up to
 * OWN_LOGIN_MAX_BACKOFF_MS. Between reads, or when a read fails, the account keeps its last good
 * windows with the time they were taken, as a good reading whose age is its time. Read every three minutes with no memory, a 429 from
 * Anthropic blanked hey@tejas.nyc, then his only Claude account with room (2026-11-03).
 */
const OWN_LOGIN_INTERVAL_MS = 5 * 60_000;
const OWN_LOGIN_MAX_BACKOFF_MS = 30 * 60_000;
const ownLoginPacing = new Map<string, { nextAtMs: number; failures: number; credentialVersion: string | null }>();
async function pacedOwnLoginWindows(label: string, previous: AccountUsage | undefined):
    Promise<{ windows: UsageWindow[]; readAt: string | null; problem: string | null; fresh: boolean } | null> {
  const kept = previous && previous.windows.length && previous.readAt
    ? { windows: [...previous.windows], readAt: previous.readAt } : null;
  // A kept reading counts as good only while it is younger than the longest gap between reads; older,
  // the login may be dead (no token reads the same as a refusal), so it says so and stops counting as room.
  const keptProblem = kept && Date.now() - Date.parse(kept.readAt) <= OWN_LOGIN_MAX_BACKOFF_MS
    ? null : "Showing the last reading; the latest could not be taken.";
  const credentialVersion = claudeCredentialVersion(label);
  const pacing = ownLoginPacing.get(label) ?? { nextAtMs: 0, failures: 0, credentialVersion };
  renewClaudeOwnLoginForUsage(label);
  // A kept reading is a good one whose time says how old it is, so the work router can still use it.
  if (credentialVersion === pacing.credentialVersion && Date.now() < pacing.nextAtMs)
    return kept ? { ...kept, problem: keptProblem, fresh: false } : null;
  const own = await claudeWindowsFromOwnLogin(label);
  if (own) {
    ownLoginPacing.set(label, { nextAtMs: Date.now() + OWN_LOGIN_INTERVAL_MS, failures: 0, credentialVersion });
    return { windows: own.map(window => ({ ...window, resetsAt: iso(window.resetsAt), willLastToReset: null, runsOutAt: null })),
      readAt: new Date().toISOString(), problem: null, fresh: true };
  }
  const failures = credentialVersion === pacing.credentialVersion ? pacing.failures + 1 : 1;
  ownLoginPacing.set(label, { failures,
    nextAtMs: Date.now() + Math.min(OWN_LOGIN_INTERVAL_MS * 2 ** (failures - 1), OWN_LOGIN_MAX_BACKOFF_MS), credentialVersion });
  return kept ? { ...kept, problem: keptProblem, fresh: false } : null;
}

async function readClaude(): Promise<ProviderUsage> {
  if (!existsSync(CSWAP)) return { observedAt: new Date().toISOString(), accounts: [], problem: "claude-swap is not installed on this host." };
  // `list` checks every managed account that is due under claude-swap's shared
  // per-account poll plan. `status` checks only the terminal-active account, which
  // need not be the account a Concierge execution is spending. Keep the tool's
  // per-account fetch timestamp: its cache can serve an older reading on failure.
  let list: any;
  try { list = JSON.parse(await run(CSWAP, ["list", "--json"])); }
  catch { return { observedAt: new Date().toISOString(), accounts: [], problem: "Claude usage could not be read." }; }
  if (!Array.isArray(list?.accounts))
    return { observedAt: new Date().toISOString(), accounts: [], problem: "Claude usage could not be read." };
  const accounts: AccountUsage[] = [];
  const previous = new Map((providerAccountUsage("claude-code")?.accounts ?? []).map(account => [account.label, account] as const));
  for (const account of list.accounts) {
    const hasCurrentUsage = account?.usage != null;
    const usage = hasCurrentUsage ? account.usage : account?.lastGoodUsage ?? null;
    const readAt = iso(hasCurrentUsage ? account?.usageFetchedAt : account?.lastGoodFetchedAt);
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
    let problem: string | null = status === "ok" ? null
      : status === "relogin_required" || status === "token_expired" ? "This account needs signing in again."
        : usage ? "Showing the last reading; the latest could not be taken." : "Usage could not be read.";
    // The address is the stable join between the login, its home and these readings.
    // A claude-swap alias is only a display name and can differ from the home name.
    const label = String(account?.email || account?.alias || `Account ${account?.number ?? "?"}`);
    let readAtNow = readAt;
    if (status !== "ok") {
      // claude-swap's own copy of this login can die while the real one works; read the real one.
      const own = await pacedOwnLoginWindows(label, previous.get(label));
      if (own) {
        windows.splice(0, windows.length, ...own.windows);
        // A fresh read from the real login clears claude-swap's warning (such as a sign-in needed), and so
        // does a kept reading that such a read had already cleared; a warning claude-swap set stays.
        if (own.fresh || (own.problem === null && previous.get(label)?.problem === null)) problem = null;
        readAtNow = own.readAt;
      }
    }
    // Plan tier and credits ride on the same login the bars come from; a login whose token
    // has lapsed keeps its last facts, and a never-read one simply has none yet.
    const facts = await claudeAccountFacts(label, ms => noticeTime(db, ms));
    accounts.push({ label, plan: facts?.plan ?? null, current: account?.active === true, windows, problem, readAt: readAtNow,
      usageCredits: facts?.usageCredits ?? null, apiCredits: facts?.apiCredits ?? null });
  }
  // claude-swap knows only the accounts added to it, and adding one copies its login, which dies the
  // first time the original renews. Every account Concierge keeps a home for is read from that home's
  // own login instead: hey@tejas.nyc, signed in through Accounts on 2026-11-03, was never in claude-swap's
  // list, so it was missing from every reading and nothing could see its room.
  for (const profile of listProfiles("claude-code")) {
    if (!profile.signedIn || !profile.label || accounts.some(account => account.label === profile.label)) continue;
    const own = await pacedOwnLoginWindows(profile.label, previous.get(profile.label));
    const facts = await claudeAccountFacts(profile.label, ms => noticeTime(db, ms));
    accounts.push({ label: profile.label, plan: facts?.plan ?? null, current: false,
      windows: own?.windows ?? [], problem: own ? own.problem : "Usage could not be read.", readAt: own?.readAt ?? null,
      usageCredits: facts?.usageCredits ?? null, apiCredits: facts?.apiCredits ?? null });
  }
  return { observedAt: new Date().toISOString(), accounts, problem: null };
}

/** The subscription's quota is read through Google's own CLI, without an agent turn. */
async function readAntigravity(): Promise<ProviderUsage> {
  const observedAt = new Date().toISOString();
  const unavailable = (problem: string): ProviderUsage => ({ observedAt, accounts: [], problem });
  let executable: string;
  try { executable = antigravityExecutable(); }
  catch (error) { return unavailable(error instanceof Error ? error.message : "The Google agent CLI is unavailable."); }
  const capture = async (args: string[], timeoutMs: number) => {
    const child = Bun.spawn([executable, ...args], {
      env: { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      cwd: homedir(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { stdout, stderr, code };
    } finally { clearTimeout(timer); }
  };
  // /usage starts an interactive OAuth flow even with closed stdin. The models subcommand
  // refuses an unsigned account promptly, so it is the noninteractive sign-in gate.
  let preflight: Awaited<ReturnType<typeof capture>>;
  try { preflight = await capture(["--output-format", "json", "models"], 15_000); }
  catch { return unavailable("Google's sign-in state could not be checked."); }
  if (preflight.code !== 0) return unavailable(/please sign in|authentication required/i.test(preflight.stderr)
    ? "Sign in to the Google agent on this machine to show its allowance."
    : "Google's sign-in state could not be checked.");
  // The same preflight that proves sign-in also proves the configured model is still
  // offered. Google withdrew the previous alias while quota remained available.
  let offeredModels: unknown;
  try { offeredModels = JSON.parse(preflight.stdout)?.command?.data?.models; }
  catch { return unavailable("Google's offered models could not be read."); }
  const selectedModel = resolveProviderAlias('google').model;
  if (!Array.isArray(offeredModels) || !selectedModel ||
    !offeredModels.some((model: any) => model?.id === selectedModel))
    return unavailable("Google's selected model is not currently offered.");
  let stdout = "", stderr = "", code = -1;
  try { ({ stdout, stderr, code } = await capture(["-p", "/usage", "--output-format", "json"], 25_000)); }
  catch { return unavailable("Google's allowance could not be read."); }
  if (code !== 0) return unavailable(/authentication required|please sign in|not logged in/i.test(stderr)
    ? "Sign in to the Google agent on this machine to show its allowance."
    : "Google's allowance could not be read.");
  let payload: any;
  try { payload = JSON.parse(stdout); }
  catch { return unavailable("Google returned an unreadable allowance."); }
  if (payload?.command?.name !== "usage") return unavailable("Google did not confirm a quota reading.");
  const groups = payload?.command?.data?.groups;
  if (!Array.isArray(groups)) return unavailable("Google returned no verified allowance groups.");
  const buckets = groups.flatMap((group: any) => Array.isArray(group?.buckets) ? group.buckets : []);
  const windows: UsageWindow[] = [];
  for (const [id, name] of [["gemini-5h", "Gemini · 5-hour"], ["gemini-weekly", "Gemini · weekly"]] as const) {
    const bucket = buckets.find((item: any) => item?.id === id);
    const remaining = bucket?.remaining_fraction;
    if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
    windows.push({ name, usedPercent: (1 - remaining) * 100, resetsAt: iso(bucket?.reset_time),
      willLastToReset: null, runsOutAt: null });
  }
  if (windows.length !== 2) return unavailable("Google did not report both Gemini allowance windows.");
  // Gemini 4 Argon has its own allowance group ("Argon quota is separate"), with bucket ids like
  // `gemini-argon-wtu-weekly`. The shared Gemini group above covers Flash and Pro only. On
  // 2026-10-31 the Argon weekly limit was spent while the shared group showed 0.75% used, so every
  // small task went to Google and was refused. The selected model's own buckets count too.
  const family = /^gemini-[\d.]+-([a-z]+)/.exec(selectedModel)?.[1];
  if (family && !["flash", "pro"].includes(family)) {
    const own = buckets.filter((item: any) => typeof item?.id === "string" && item.id.startsWith(`gemini-${family}-`));
    if (!own.length) return unavailable(`Google reported no allowance for ${selectedModel}.`);
    for (const bucket of own) {
      const remaining = bucket?.remaining_fraction;
      if (typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1)
        return unavailable(`Google returned an unreadable allowance for ${selectedModel}.`);
      const label = family[0].toUpperCase() + family.slice(1);
      windows.push({ name: `${label} · ${bucket.window === "5h" ? "5-hour" : bucket.window === "weekly" ? "weekly" : String(bucket.window ?? "limit")}`,
        usedPercent: (1 - remaining) * 100, resetsAt: iso(bucket?.reset_time), willLastToReset: null, runsOutAt: null });
    }
  }
  // An account label must come from Google's own reply. Guessing from the browser's
  // Google account would let a different CLI login inherit this account's capacity.
  let statusIdentity: { email?: unknown; plan?: unknown; observedAt?: unknown } = {};
  const defaultIdentityDir = process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/concierge") : join(homedir(), ".local/state/concierge");
  try { statusIdentity = JSON.parse(readFileSync(join(process.env.CONCIERGE_ANTIGRAVITY_IDENTITY_DIR ??
    defaultIdentityDir, "antigravity-identity.json"), "utf8")); }
  catch { /* a headless quota reply may still identify its own account */ }
  const statusAt = iso(statusIdentity.observedAt);
  const statusFresh = statusAt !== null && Date.parse(statusAt) >= Date.now() - ACCOUNT_READING_MAX_AGE_MS;
  const envelopeEmail = [payload?.command?.data?.email, payload?.command?.data?.account?.email,
    payload?.data?.email, payload?.email].find((value: unknown) => typeof value === "string" && /.+@.+\..+/.test(value));
  const email = typeof envelopeEmail === "string" ? envelopeEmail : statusFresh ? statusIdentity.email : null;
  if (statusFresh && typeof envelopeEmail === "string" && typeof statusIdentity.email === "string"
    && envelopeEmail.toLowerCase() !== statusIdentity.email.toLowerCase())
    return unavailable("Google's account identity changed; its allowance needs a fresh sign-in check.");
  if (typeof email !== "string" || !/^[^@]+@[^@]+\.[^@]+$/.test(email))
    return unavailable("Google reported allowance but did not identify the signed-in account.");
  const plan = [payload?.command?.data?.subscription?.plan, payload?.command?.data?.plan_tier,
    payload?.plan_tier, statusFresh ? statusIdentity.plan : null].find((value: unknown) => typeof value === "string" && value.trim());
  return { observedAt, accounts: [{ label: email, plan: typeof plan === "string" ? plan : null,
    current: true, windows, problem: null, readAt: observedAt }], problem: null };
}

// Whether a reading is happening right now, so a surface can say "checking" instead of
// showing an account with nothing under it. One pass at a time: a second request while one
// runs joins it rather than starting a competing read of the same accounts.
let inFlight: Promise<void> | null = null;

export function usageRefreshing(): boolean { return inFlight !== null; }

/**
 * Read usage now, because the set of accounts just changed. A newly signed-in account has
 * no reading at all until something asks for one, and waiting for the half-hourly pass
 * left Tejas looking at an account with no usage line and no way to tell whether it was
 * loading, empty or broken (2026-09-22).
 */
export function scheduleProviderAccountUsageRefresh(): Promise<void> {
  if (!inFlight) inFlight = refreshProviderAccountUsage().finally(() => { inFlight = null; });
  return inFlight;
}

/**
 * Keeps reading, on its own clock, and says what it saw before anyone hits a wall.
 *
 * Three minutes keeps the six-minute account readings usable for Automatic choices.
 * The interval tightens to one minute near a limit. A reading costs one short-lived
 * process against a local cache, so the dense period is cheap and bounded.
 *
 * This used to live only in the Slack-enabled composition, which meant an instance running
 * the native-only runtime — the Mac — read account usage only when a credential changed,
 * and never on a timer at all, while spending the same account.
 */
export function startProviderUsageWatch(options: { stopped: () => boolean; onReading?: () => void; urgent?: () => boolean }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    timer = null;
    if (options.stopped()) return;
    try { await scheduleProviderAccountUsageRefresh(); } catch { /* the next pass tries again */ }
    try { options.onReading?.(); } catch { /* a notice must never stop the readings */ }
    arm();
  };
  const arm = () => {
    if (timer || options.stopped()) return;
    let urgent = false;
    try { urgent = usageReadingIsUrgent()||!!options.urgent?.(); } catch { urgent = false; }
    timer = setTimeout(() => void tick(), urgent ? USAGE_URGENT_REFRESH_MS : USAGE_REFRESH_MS);
    timer.unref?.();
  };
  const first = setTimeout(() => void tick(), 30_000);
  first.unref?.();
  return () => { if (timer) clearTimeout(timer); clearTimeout(first); timer = null; };
}

/**
 * The same account's reading, taken by the other machine.
 *
 * A usage allowance belongs to an account, not to a host, so an account that appears on
 * both machines has one true set of numbers and it does not matter which instance managed
 * to read them. Where this machine cannot read an account — the Mac has no claude-swap —
 * the peer's reading for that exact account is shown rather than a blank, which is what he
 * asked for: one reading, shown wherever the account appears, with no second reader
 * installed anywhere.
 *
 * A peer-sourced account is never passed on again (`viaPeer`), so two instances filling
 * each other's gaps cannot loop or launder a stale number through a third hop.
 */
async function peerAccounts(provider: ProviderKey): Promise<AccountUsage[]> {
  let settings;
  try { settings = peerSettings(); } catch { return []; }
  if (!settings.token || !settings.peers.length) return [];
  const found: AccountUsage[] = [];
  for (const peer of settings.peers) {
    try {
      const response = await fetch(`${peer.url}/sessions/v1/auth/providers?machine=${encodeURIComponent(peer.name)}`, {
        headers: { authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const body = await response.json() as any;
      const views = Array.isArray(body) ? body : (body?.providers ?? []);
      for (const view of views) {
        if (view?.provider !== provider) continue;
        for (const account of view?.usage?.accounts ?? [])
          if (account?.label && !account.viaPeer && account.windows?.length) {
            // A source host's rendered eligibility is point-in-time UI data. The receiving
            // host recomputes it from readAt when its own Accounts page is read.
            const {allowance:_renderedAllowance,...source}=account;
            found.push({...source,current:false,viaPeer:true,sourcePeer:peer.name,peerMatch:'label-only'});
          }
      }
    } catch { /* an unreachable peer simply contributes nothing */ }
  }
  return found;
}

export async function refreshProviderAccountUsage(): Promise<void> {
  for (const [provider, read] of [["codex", readCodex], ["claude-code", readClaude]] as const) {
    try {
      let usage = await read();
      // The provider's source time chooses between two observations for the same label.
      // A fresh peer reading may replace a stale local cache; a fresh local one stays local.
      // The join is label-only and retained as such, never described as credential proof.
      // Claude accounts added on the other machine must be discoverable even when every
      // local login reads successfully. Otherwise two freshly exhausted Mac accounts hide
      // a newly added server account from the Mac's local sign-in repair path.
      const borrowed=provider === "claude-code" || usage.problem||!usage.accounts.length
        ||usage.accounts.some(account=>!accountReadingFresh(provider,usage,account))
        ?await peerAccounts(provider):[];
      if (borrowed.length) {
        const merged = new Map(usage.accounts.map(account=>[account.label,account]));
        for (const account of borrowed) {
          const local=merged.get(account.label);
          merged.set(account.label,local?chooseAccountObservation(provider,usage,local,account):account);
        }
        usage={...usage,accounts:[...merged.values()],problem:[...merged.values()].some(account=>account.windows.length)
          ?null:usage.problem};
      }
      db.query(`INSERT INTO ${accountUsageTable(provider)} (provider, observed_at, usage_json) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at, usage_json = excluded.usage_json`)
        .run(provider, usage.observedAt, JSON.stringify(usage));
      // Keeping the reading is what makes a rate possible. Until 2026-09-23 only the latest
      // one was kept, so there was no series to see a climb in and no way to warn early.
      recordUsageReading(provider, usage);
      // Claude's reader can temporarily activate another login in the terminal's folder.
      // Only this machine's agent selection is an account change for queued work.
      const agentUsage=withAgentsAccountCurrent(provider,usage);
      releaseIfAccountChanged(provider, agentUsage);
      if (provider === "claude-code") proveClaudeHomesAhead(usage.accounts.map(account => account.label));
      // A sign-in the provider refused is renewed through the Mac's browser, once per episode.
      for (const account of usage.accounts) if (account.signedOut) needSignInRenewal(provider, account.label, "its usage could not be read because the sign-in stopped working");
      const current=agentUsage.accounts.find(account=>account.current);
      // A provider-wide release has no turn model. It needs evidence across every Claude
      // window; an Opus-only reading cannot wake a Fable hold.
      const activeWindows=current?includedAllowanceWindows(provider,current,null):[];
      const activeHasRoom=!!current && accountReadingFresh(provider,usage,current,Date.now(),undefined,null) && activeWindows.length>0
        && accountCanTakeWork(provider,current,null)
        &&(provider!=='claude-code'||!claudeAccountCachedReset(current.label,null))
        &&(provider!=='codex'||!cachedUsageLimit(usageAttempt('codex',undefined,current.label)));
      // A percentage drop cannot identify which window caused a model-specific refusal.
      // The exact model's success, a manual clear, or its stated reset retires that cache.
      const claudeCanDispatch=provider==='claude-code'&&claudeHeldWorkCanRun(null);
      if(provider==='claude-code'&&!claudeCanDispatch&&db.query(`SELECT 1 FROM turns
        JOIN sessions ON sessions.id=turns.session_id
        WHERE sessions.provider_id='claude-code' AND turns.status='queued'
          AND turns.dispatch_hold='usage' LIMIT 1`).get())requestMissingClaudeHomes(null);
      if(activeHasRoom || claudeCanDispatch)
        releaseUsageContinuationHolds(provider);
      if(claudeCanDispatch)releaseUsageHeldWork('claude-code','usable_account_observed');
      if(provider==='codex'&&activeHasRoom&&!cachedUsageLimit(usageAttempt('codex')))
        releaseUsageHeldWork('codex','usable_account_observed');
      // Still none with room: held work waits only until the first account frees up, by this reading.
      const firstRoomAt=provider==='claude-code'?claudeEveryAccountClearsAt(null):earliestRoomAt(provider);
      if(firstRoomAt!==null&&firstRoomAt>Date.now()){
        const moved=moveUsageHoldsEarlier(provider,firstRoomAt);
        if(moved)log("info","provider_usage_hold_moved_earlier",{provider,moved,until:new Date(firstRoomAt).toISOString()});
      }
      log("info", "provider_account_usage_observed", { provider, accounts: usage.accounts.length,
        unreadable: usage.accounts.filter(account => account.problem).length, problem: !!usage.problem });
    } catch (error) {
      log("warn", "provider_account_usage_failed", { provider, error_name: (error as Error)?.name ?? "Error" });
    }
  }
  // Google's credential exists only in the CLI's own store. No peer reading can grant this
  // machine permission to launch, and an unreadable current answer never revives old quota.
  try {
    const provider = "antigravity";
    const usage = await readAntigravity();
    db.query(`INSERT INTO ${accountUsageTable(provider)} (provider, observed_at, usage_json) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET observed_at=excluded.observed_at, usage_json=excluded.usage_json`)
      .run(provider, usage.observedAt, JSON.stringify(usage));
    const account = usage.accounts.find(item => item.current && !item.problem) ?? null;
    setAntigravityAccountInUse(account ? { email: account.label, plan: account.plan } : null);
    recordUsageReading(provider, usage);
    if (account) {
      const { releaseAuthHold } = await import("./provider-activation");
      releaseAuthHold(provider, "interval");
      // A refusal Google gave after this reading's kind of "room" outranks the reading (see
      // rememberModelCapacityRefusal in turn execution); its memory expires on its own.
      const { anyModelRefused } = await import("./provider-model-capacity");
      if (accountReadingFresh(provider,usage,account) && account.windows.length >= 2 && account.windows.every(window => window.usedPercent < 100)
        && !anyModelRefused(provider)) {
        releaseUsageContinuationHolds(provider);
        releaseUsageHeldWork(provider, "usable_account_observed");
      } else {
        const firstRoomAt = earliestRoomAt(provider);
        if (firstRoomAt !== null && firstRoomAt > Date.now()) moveUsageHoldsEarlier(provider, firstRoomAt);
      }
    }
    log("info", "provider_account_usage_observed", { provider, accounts: usage.accounts.length,
      unreadable: account ? 0 : 1, problem: !!usage.problem });
  } catch (error) {
    setAntigravityAccountInUse(null);
    log("warn", "provider_account_usage_failed", { provider: "antigravity", error_name: (error as Error)?.name ?? "Error" });
  }
}

/**
 * Work held for an account that is no longer the one in use should not keep waiting.
 *
 * A usage hold parks a turn until the exhausted account refills. Signing in to a different
 * account makes that wait pointless — but only a switch made through the app ran the
 * activation step that releases it. Tejas signed his Mac in at the command line on
 * 2026-09-23 and its work went on waiting for the old account's 21:10 refill while a fresh
 * account sat idle: "why the fuck do you think waiting until 5:10 is okay on my MacBook?"
 * So the hold re-checks whoever is actually signed in, on every reading, however the
 * sign-in changed.
 *
 * It releases only onto an account with room. An account that is itself spent leaves the
 * wait in place, because waiting is then the correct state.
 */
const accountInUse = new Map<ProviderKey, string>();
function releaseIfAccountChanged(provider: ProviderKey, usage: ProviderUsage): void {
  const current = usage.accounts.find(account => account.current);
  if (!current?.label || !accountReadingFresh(provider,usage,current,Date.now(),undefined,null)
    || !includedAllowanceWindows(provider,current,null).length) return;
  const previous = accountInUse.get(provider);
  accountInUse.set(provider, current.label);
  if (previous === undefined || previous === current.label) return;
  if (!accountCanTakeWork(provider,current,null)
    ||provider==='claude-code'&&!!claudeAccountCachedReset(current.label,null)
    ||provider==='codex'&&!!cachedUsageLimit(usageAttempt('codex',undefined,current.label))) {
    log("info", "provider_account_changed_still_spent", { provider });
    return;
  }
  const released = releaseUsageHeldWork(provider);
  log("warn", "provider_account_changed_released_hold", { provider, released });
}

/** The account names in the stored reading, with nothing derived from which account is in use. */
export function storedProviderAccountLabels(provider: ProviderKey): string[] {
  const row = db.query(`SELECT usage_json FROM ${accountUsageTable(provider)} WHERE provider = ?`)
    .get(provider) as { usage_json: string } | null;
  if (!row) return [];
  try { return ((JSON.parse(row.usage_json) as ProviderUsage).accounts ?? []).flatMap(account => account.label ? [account.label] : []); }
  catch { return []; }
}

export function providerAccountUsage(provider: AccountIdentityProvider): ProviderUsage | null {
  const row = db.query(`SELECT usage_json FROM ${accountUsageTable(provider)} WHERE provider = ?`)
    .get(provider) as { usage_json: string } | null;
  if (!row) return null;
  try { return { ...withAgentsAccountCurrent(provider, JSON.parse(row.usage_json) as ProviderUsage), refreshing: usageRefreshing() }; }
  catch (error) {
    // Said out loud: this catch once hid a stack overflow from an account-list cycle for hours
    // while every Accounts read froze the owner (2026-10-08).
    log("error", "provider_account_usage_unreadable", { provider, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    return null;
  }
}
