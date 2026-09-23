import { db } from "./state";
// Types only, so the reader can record into this module without the two importing each
// other at runtime; the stored snapshot is read back from its table directly below.
import type { AccountUsage, ProviderUsage } from "./provider-account-usage";
import type { ProviderKey } from "./provider-accounts";

/**
 * Seeing a usage wall coming, instead of discovering it by hitting one.
 *
 * The readings were already being taken every half hour and were only ever drawn on the
 * Provider accounts screen — the commit that added them says so: "so the Provider accounts
 * dialog can show them". Nothing read them back. On 2026-09-22 that cost Tejas an evening:
 * the account ran out at 23:51, and the reading taken at 23:36 had every number needed to
 * say it was about to.
 *
 * Two kinds of forecast, and the difference matters because only one of them is ours:
 *
 * - The provider forecasts the weekly window itself (`willLastToReset`, a projected
 *   exhaustion instant). Where it does, that number is used as given.
 * - It forecasts nothing for the five-hour window — the one that actually broke — so that
 *   one is projected here from our own readings: a straight line through the samples taken
 *   since this window began. A straight line assumes the current pace continues, which is
 *   exactly what a burst of agent work does not do. So a forecast carries how many samples
 *   it rests on and over what span, and the words shown to anyone say it assumes the pace
 *   holds. It is a heads-up, never a countdown.
 *
 * Nothing here gates or reroutes a dispatch. It answers "how much is left and when does it
 * run out", and the router decides what to do with that.
 */

db.exec(`CREATE TABLE IF NOT EXISTS provider_usage_readings (
  provider       TEXT    NOT NULL,
  account        TEXT    NOT NULL,
  window_name    TEXT    NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  used_percent   REAL    NOT NULL,
  resets_at_ms   INTEGER,
  PRIMARY KEY (provider, account, window_name, observed_at_ms)
)`);

/** Samples kept per window: a day of five-minute readings, far more than a line needs. */
const KEEP_SAMPLES = 300;
/** Below this the readings are noise rather than a rate. */
const MIN_SPAN_MS = 8 * 60_000;
const MIN_RATE_PER_HOUR = 0.5;
/** How close to the wall is worth telling someone about. */
export const WARN_LEAD_MS = 60 * 60_000;

export type ForecastSource = "provider" | "observed" | "unknown";
export type UsageForecast = Readonly<{
  provider: ProviderKey;
  account: string;
  current: boolean;
  window: string;
  usedPercent: number;
  resetsAt: string | null;
  /** When this window is expected to be spent, or null when nothing can say. */
  exhaustsAt: string | null;
  source: ForecastSource;
  minutesLeft: number | null;
  /** True only when an exhaustion instant is known and falls before the window resets. */
  runsOutBeforeReset: boolean;
  ratePerHour: number | null;
  samples: number;
  spanMinutes: number | null;
  observedAt: string;
}>;

type Sample = { observed_at_ms: number; used_percent: number; resets_at_ms: number | null };

const at = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

/** The latest stored reading, read from its own table so this module owes the reader nothing. */
function storedUsage(provider: ProviderKey): ProviderUsage | null {
  const row = db.query("SELECT usage_json FROM provider_account_usage WHERE provider = ?")
    .get(provider) as { usage_json: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.usage_json) as ProviderUsage; } catch { return null; }
}

/**
 * Keeps this pass's numbers so a later pass can see a rate. Only windows the provider
 * names a percentage for are kept; an unreadable account contributes nothing rather than
 * a zero, because a zero would read as "plenty left".
 */
export function recordUsageReading(provider: ProviderKey, usage: ProviderUsage): void {
  const passAt = at(usage.observedAt) ?? Date.now();
  db.transaction(() => {
    for (const account of usage.accounts) {
      if (account.problem) continue;
      // When the tool says when it actually got these numbers, that is the sample's time:
      // a remembered reading recorded as if it were fresh would flatten a real climb.
      const observedAt = at(account.readAt) ?? passAt;
      for (const window of account.windows) {
        db.query(`INSERT OR REPLACE INTO provider_usage_readings
          (provider, account, window_name, observed_at_ms, used_percent, resets_at_ms) VALUES (?,?,?,?,?,?)`)
          .run(provider, account.label, window.name, observedAt, window.usedPercent, at(window.resetsAt));
        db.query(`DELETE FROM provider_usage_readings
          WHERE provider=? AND account=? AND window_name=? AND observed_at_ms NOT IN (
            SELECT observed_at_ms FROM provider_usage_readings
            WHERE provider=? AND account=? AND window_name=? ORDER BY observed_at_ms DESC LIMIT ?)`)
          .run(provider, account.label, window.name, provider, account.label, window.name, KEEP_SAMPLES);
      }
    }
  })();
}

/**
 * The samples that belong to the window running now. A window that reset starts again from
 * a lower percentage, so anything at or before the last drop belongs to a spent window and
 * would flatten the line; a changed reset instant means the same thing.
 */
function currentWindowSamples(provider: ProviderKey, account: string, window: string, resetsAtMs: number | null): Sample[] {
  const rows = db.query(`SELECT observed_at_ms, used_percent, resets_at_ms FROM provider_usage_readings
    WHERE provider=? AND account=? AND window_name=? ORDER BY observed_at_ms`)
    .all(provider, account, window) as Sample[];
  let start = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index]!.used_percent < rows[index - 1]!.used_percent
      || rows[index]!.resets_at_ms !== rows[index - 1]!.resets_at_ms) start = index;
  }
  const live = rows.slice(start);
  return resetsAtMs === null ? live : live.filter(row => row.resets_at_ms === resetsAtMs);
}

function forecastWindow(provider: ProviderKey, account: AccountUsage, window: AccountUsage["windows"][number],
  observedAt: string): UsageForecast {
  const now = Date.now();
  const resetsAtMs = at(window.resetsAt);
  const samples = currentWindowSamples(provider, account.label, window.name, resetsAtMs);
  const first = samples[0], last = samples.at(-1);
  const spanMs = first && last ? last.observed_at_ms - first.observed_at_ms : 0;
  const climbed = first && last ? last.used_percent - first.used_percent : 0;
  const ratePerHour = spanMs >= MIN_SPAN_MS && climbed > 0 ? (climbed / spanMs) * 3_600_000 : null;

  // The provider's own projection wins where it makes one: it sees the account's whole
  // history, and these readings only see what this machine has watched.
  const providerExhausts = window.willLastToReset === false ? at(window.runsOutAt) : null;
  const observedExhausts = ratePerHour !== null && ratePerHour >= MIN_RATE_PER_HOUR && window.usedPercent < 100
    ? now + ((100 - window.usedPercent) / ratePerHour) * 3_600_000
    : ratePerHour !== null && window.usedPercent >= 100 ? now : null;
  const exhaustsMs = providerExhausts ?? observedExhausts;
  const source: ForecastSource = providerExhausts !== null ? "provider" : observedExhausts !== null ? "observed" : "unknown";

  return {
    provider, account: account.label, current: account.current, window: window.name,
    usedPercent: window.usedPercent, resetsAt: window.resetsAt,
    exhaustsAt: exhaustsMs === null ? null : new Date(exhaustsMs).toISOString(),
    source,
    minutesLeft: exhaustsMs === null ? null : Math.round((exhaustsMs - now) / 60_000),
    runsOutBeforeReset: exhaustsMs !== null && resetsAtMs !== null && exhaustsMs < resetsAtMs,
    ratePerHour: ratePerHour === null ? null : Math.round(ratePerHour * 10) / 10,
    samples: samples.length,
    spanMinutes: spanMs > 0 ? Math.round(spanMs / 60_000) : null,
    observedAt,
  };
}

/** Every window of every account of one provider, forecast from the latest reading. */
export function usageForecasts(provider: ProviderKey): UsageForecast[] {
  const usage = storedUsage(provider);
  if (!usage) return [];
  return usage.accounts.flatMap(account => account.problem ? []
    : account.windows.map(window => forecastWindow(provider, account, window, usage.observedAt)));
}

/** The one window closest to stopping work on the account the agents are actually using. */
export function tightestCurrentWindow(provider: ProviderKey): UsageForecast | null {
  const running = usageForecasts(provider).filter(forecast => forecast.current && forecast.runsOutBeforeReset);
  if (!running.length) return null;
  return running.reduce((closest, forecast) =>
    (forecast.minutesLeft ?? Infinity) < (closest.minutesLeft ?? Infinity) ? forecast : closest);
}

/** Accounts on this machine whose windows all still have room, at the last reading. */
export function accountsWithRoom(provider: ProviderKey): string[] {
  const usage = storedUsage(provider);
  if (!usage) return [];
  return usage.accounts
    .filter(account => !account.current && !account.problem && account.windows.length
      && account.windows.every(window => window.usedPercent < 100))
    .map(account => account.label);
}

/**
 * What a dispatcher needs to decide where to send the next piece of work, without doing
 * any arithmetic of its own. It states what it knows and how it knows it; it recommends
 * nothing and changes nothing.
 */
export function usageSignal(provider: ProviderKey) {
  const usage = storedUsage(provider);
  const tightest = tightestCurrentWindow(provider);
  const spare = accountsWithRoom(provider);
  return {
    provider,
    observedAt: usage?.observedAt ?? null,
    problem: usage?.problem ?? null,
    currentAccount: usage?.accounts.find(account => account.current)?.label ?? null,
    // Null means nothing on the current account is projected to run out before it resets.
    closestWall: tightest && {
      window: tightest.window, usedPercent: tightest.usedPercent, minutesLeft: tightest.minutesLeft,
      exhaustsAt: tightest.exhaustsAt, resetsAt: tightest.resetsAt, source: tightest.source,
      ratePerHour: tightest.ratePerHour, samples: tightest.samples, spanMinutes: tightest.spanMinutes,
    },
    accountsWithRoom: spare,
    // Banked resets, so the router and any agent can see them rather than only Tejas on the
    // Accounts page. A reset belongs to the account, so it is listed per account.
    resets: (usage?.accounts ?? []).flatMap(account => account.resetCredits?.available
      ? [{ account: account.label, available: account.resetCredits.available,
           expiresAt: account.resetCredits.expiresAt ?? null }] : []),
    resetsBasis: "A reset is spent automatically only when work has actually stopped and no "
      + "other account of this provider has room; otherwise it waits for Tejas. Nothing an "
      + "agent does spends one.",
    forecasts: usageForecasts(provider),
    basis: "A forecast assumes the pace of the last readings continues. Agent work arrives in "
      + "bursts, so treat it as a heads-up and not a countdown. 'provider' is the provider's own "
      + "projection; 'observed' is a straight line through this machine's readings.",
  };
}

/**
 * Whether the readings are close enough to a wall that they should be taken more often.
 * Half-hourly is plenty while there is room and far too coarse to give an hour's warning on
 * a five-hour window; this is what makes an early warning possible at all.
 */
export function usageReadingIsUrgent(): boolean {
  for (const provider of ["claude-code", "codex"] as const) {
    const usage = storedUsage(provider);
    for (const account of usage?.accounts ?? []) {
      if (!account.current || account.problem) continue;
      for (const window of account.windows) {
        const resetsAtMs = at(window.resetsAt);
        if (window.usedPercent >= 60 && (resetsAtMs === null || resetsAtMs - Date.now() > 10 * 60_000)) return true;
      }
    }
  }
  return false;
}

/**
 * What a session should be told when the account it is running on is getting low, in the
 * words it needs to act on: the numbers, how they were arrived at, and where the room
 * actually is. Null when that provider is not close to a wall.
 *
 * It asks rather than instructs, on purpose. Tejas settled this on 2026-09-23: "we don't
 * have to switch to our cheaper model suddenly … the sessions who are working on it can be
 * informed. And notified and say, hey, the session is running low. Are you making sure that
 * you're using the intelligence intelligently?" A running session keeps its own model —
 * that rule is unchanged — and what actually spends an allowance is a session choosing to
 * do bounded work itself instead of handing it down, which no model switch can fix and
 * which the session is the only one in a position to judge.
 *
 * It names the other provider too, because both credentials are on this machine and both
 * readings exist: a Claude session low on Claude should be told which Codex models have
 * room, and the reverse. Handing work down to the provider that has room is the point.
 */
export function usagePressureBrief(provider: ProviderKey): string | null {
  const tight = tightestCurrentWindow(provider);
  if (!tight || tight.minutesLeft === null || tight.minutesLeft * 60_000 > WARN_LEAD_MS) return null;
  const other: ProviderKey = provider === "codex" ? "claude-code" : "codex";
  const name = (key: ProviderKey) => key === "codex" ? "Codex" : "Claude";
  const basis = tight.source === "provider"
    ? `${name(provider)}'s own projection`
    : `this machine's readings (${tight.samples} in the last ${tight.spanMinutes ?? 0} minutes, climbing about ${tight.ratePerHour ?? 0}% an hour)`;
  const elsewhere = tightestCurrentWindow(other);
  const otherRoom = elsewhere === null
    ? `${name(other)} has room on the account in use`
    : elsewhere.minutesLeft === null
      ? `${name(other)}'s headroom is unknown`
      : `${name(other)} is also close to a wall (about ${elsewhere.minutesLeft} minutes)`;
  const spare = accountsWithRoom(provider);
  const banked = (storedUsage(provider)?.accounts ?? []).flatMap(account => account.resetCredits?.available
    ? [{ account: account.label, available: account.resetCredits.available }] : []);
  return [
    `Budget: the ${name(provider)} account this session runs on is ${tight.usedPercent}% through its ${tight.window} window`
      + ` and, by ${basis}, is expected to run out in about ${Math.max(0, tight.minutesLeft)} minutes`
      + (tight.resetsAt ? `, before it refills at ${tight.resetsAt}` : "") + ".",
    "This is a forecast from a rate, not a countdown: a burst of work arrives faster than any line through past readings predicts, and a quiet spell never arrives at all.",
    `Nothing about this session changes — your model and your work are untouched, and no one is switching anything under you.`,
    `What it is worth asking yourself: are you spending your own turns on work that has a fixed acceptance criterion and could be handed down? ${otherRoom}, so hand that work to the provider that has room rather than only to your own provider's smaller models.`,
    spare.length ? `Other accounts on this machine with room, if Tejas switches: ${spare.join(", ")}.` : "",
    banked.length
      ? `Banked resets on this provider: ${banked.map(entry => `${entry.account} (${entry.available})`).join(", ")}.`
        + " One is spent automatically if work actually stops and no account has room, so there is nothing for you to do about it."
      : "",
    "Do not stop, hand off or abandon what you are doing because of this. It is information.",
  ].filter(Boolean).join(" ");
}
