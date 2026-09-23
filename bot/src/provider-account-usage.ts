import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./state";
import { log } from "./log";
import { recordUsageReading, usageReadingIsUrgent } from "./provider-usage-forecast";
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
  /** Absent where the provider grants no such thing, which is everywhere but Codex. */
  resetCredits?: ResetCredits | null;
  /**
   * When the reading tool last got these numbers from the provider, where it says so.
   * A forecast is a rate, so it has to know whether it is being handed a fresh number or
   * a remembered one; without this a cached reading would flatten the line and hide a
   * climb. Absent where the tool does not report it.
   */
  readAt?: string | null;
}>;

export type ProviderUsage = Readonly<{
  observedAt: string;
  accounts: readonly AccountUsage[];
  problem: string | null;
  /** A reading is running right now, so an account without one is being fetched, not absent. */
  refreshing?: boolean;
}>;

const LOCAL_BIN = join(homedir(), ".local", "bin");
const CODEXBAR = process.env.CONCIERGE_CODEXBAR ?? "/root/tools/codexbar-cli/codexbar";
const CSWAP = process.env.CONCIERGE_CSWAP ?? join(LOCAL_BIN, "cswap");
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
  // Named below by the caller, which drops what it cannot name.
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
    current: agents, windows, problem: null, resetCredits: resetCredits(usage.codexResetCredits) };
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

async function readClaude(): Promise<ProviderUsage> {
  if (!existsSync(CSWAP)) return { observedAt: new Date().toISOString(), accounts: [], problem: "claude-swap is not installed on this host." };
  // `list` answers from claude-swap's own usage cache and will happily serve a reading
  // minutes old without going to claude.ai, so tightening our interval alone would have
  // changed nothing: measured on the box, `list` reported 18% while the account was really
  // at 25%. `status` fetches the active account and writes that cache, so asking for it
  // first is what makes the list that follows current. It is the account being spent, so it
  // is the one whose number has to be right; the others are idle and barely move.
  try { await run(CSWAP, ["status", "--json"]); } catch { /* the list below still answers */ }
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
      plan: null, current: account?.active === true, windows, problem, readAt: iso(account?.usageFetchedAt) });
  }
  return { observedAt: new Date().toISOString(), accounts, problem: null };
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
 * Half-hourly is the right cadence while there is room, and far too coarse near a limit: an
 * hour's warning on a five-hour window needs more than two samples to draw a line through.
 * So the interval tightens to five minutes once a window on the account in use is more than
 * about halfway through, and relaxes again afterwards. A reading costs one short-lived
 * process against a local cache, so the dense period is cheap and bounded.
 *
 * This used to live only in the Slack-enabled composition, which meant an instance running
 * the native-only runtime — the Mac — read account usage only when a credential changed,
 * and never on a timer at all, while spending the same account.
 */
export function startProviderUsageWatch(options: { stopped: () => boolean; onReading?: () => void }) {
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
    try { urgent = usageReadingIsUrgent(); } catch { urgent = false; }
    timer = setTimeout(() => void tick(), urgent ? USAGE_URGENT_REFRESH_MS : USAGE_REFRESH_MS);
    timer.unref?.();
  };
  const first = setTimeout(() => void tick(), 30_000);
  first.unref?.();
  return () => { if (timer) clearTimeout(timer); clearTimeout(first); timer = null; };
}

export async function refreshProviderAccountUsage(): Promise<void> {
  for (const [provider, read] of [["codex", readCodex], ["claude-code", readClaude]] as const) {
    try {
      const usage = await read();
      db.query(`INSERT INTO provider_account_usage (provider, observed_at, usage_json) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET observed_at = excluded.observed_at, usage_json = excluded.usage_json`)
        .run(provider, usage.observedAt, JSON.stringify(usage));
      // Keeping the reading is what makes a rate possible. Until 2026-09-23 only the latest
      // one was kept, so there was no series to see a climb in and no way to warn early.
      recordUsageReading(provider, usage);
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
  try { return { ...(JSON.parse(row.usage_json) as ProviderUsage), refreshing: usageRefreshing() }; }
  catch { return null; }
}
