import { db, getSessionById } from "./state";
import { log } from "./log";
import { currentAccount } from "./provider-accounts";
import { modelLabel } from "./provider-outage";
import { inboxSession } from "./session-inbox";
import { WARN_LEAD_MS, accountsWithRoom, tightestCurrentWindow, usagePressureBrief } from "./provider-usage-forecast";
import { nativeRunId } from "./session-inputs";
import { providerAccountUsage } from "./provider-account-usage";
import { decideAutomaticReset, resetUsedSentence } from "./provider-reset-policy";
import type { UsageProvider } from "./provider-usage";

/** A day, in the milliseconds the expiry arithmetic below counts in. */
const DAY_MS = 24 * 60 * 60_000;
/**
 * When to say a banked reset is about to lapse, in days left.
 *
 * Twice, not once: told a week out he has time to plan around it, and told again with two
 * days left he can still act on it, and between them he is not nagged. A grant lapses
 * thirty days after it is given, with no refund, so the alternative to saying it twice is
 * that a silent one is simply lost — which is the whole of what he asked for here.
 */
const EXPIRY_MILESTONES: readonly { days: number; name: string }[] = [
  { days: 7, name: "week" }, { days: 2, name: "final" },
];

export type ResetCreditNotice = Readonly<{ account: string; available: number; expiresAt: string | null }>;

/**
 * The banked reset waiting on the account this provider is actually spending, if any.
 *
 * Only the account in use, because a reset on an account he is not on answers nothing about
 * the wall he is hitting right now.
 */
export function availableResetCredit(provider: UsageProvider): ResetCreditNotice | null {
  const label = currentAccount(provider)?.label ?? null;
  for (const account of providerAccountUsage(provider)?.accounts ?? []) {
    if (label ? account.label !== label : !account.current) continue;
    const credits = account.resetCredits;
    if (!credits?.available) return null;
    return { account: account.label, available: credits.available, expiresAt: credits.expiresAt ?? null };
  }
  return null;
}

/**
 * Telling him, once, when an account's allowance has stopped his work.
 *
 * On the evening of 2026-09-22 his Claude account hit its five-hour limit at 23:51 UTC.
 * Nine of the Inbox's inputs — seven of them the returns that were reporting the outage —
 * were refused in 43 seconds, and nothing said anything to anyone. The allowance reset at
 * 00:30 and the account's other login sat unused all evening with its whole five-hour
 * window free. He found out at 02:14 by asking what had happened to his threads. He was
 * the monitoring system.
 *
 * So this publishes one durable event the moment a usage refusal actually blocks accepted
 * work, on the session whose input was held. Thinkering already turns a `provider_outage`
 * event into a notification on his phone, without a provider turn and without the router
 * being alive — which is exactly what tonight needed, because every Claude path was the
 * thing that was broken.
 *
 * One notice per episode, not per input: the allowance belongs to the account, so the
 * reset instant identifies the episode and the ledger's unique event id does the
 * deduplication. It fires on a real refusal, never on ordinary queueing, and it changes
 * nothing by itself — switching account stays his tap in Provider accounts.
 */

export type UsageHoldNotice = {
  provider: UsageProvider;
  model: string | null;
  turnId: number;
  clearsAtMs: number;
};

type RecordEvent = (event: {
  eventId: string; sessionId: number; inputId?: string | null; turnId?: number | null; kind: string; payload: unknown;
}) => void;

/** How many accepted inputs are waiting on this same reset instant, this one included. */
function heldInputCount(clearsAtMs: number): number {
  const row = db.query(`SELECT count(*) AS held FROM turns
    WHERE status='queued' AND dispatch_failure_class='retryable' AND dispatch_next_attempt_ms=?`)
    .get(clearsAtMs) as { held: number };
  return Math.max(1, row.held);
}

export function noticeUsageHold(input: UsageHoldNotice, record: RecordEvent): void {
  const eventId = `provider-usage-hold:${input.provider}:${input.clearsAtMs}`;
  if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(eventId)) return;
  const turn = db.query("SELECT session_id, accepted_input_id FROM turns WHERE id=?")
    .get(input.turnId) as { session_id: number; accepted_input_id: string | null } | null;
  if (!turn?.accepted_input_id || !getSessionById(turn.session_id)) return;
  const inputId = turn.accepted_input_id;
  try {
    const account = currentAccount(input.provider)?.label ?? null;
    const alternatives = accountsWithRoom(input.provider);
    const held = heldInputCount(input.clearsAtMs);
    record({
      eventId, sessionId: turn.session_id, inputId, turnId: input.turnId,
      kind: "provider_outage",
      payload: {
        inputId, provider: input.provider, model: input.model,
        modelLabel: modelLabel(input.model), status: null, incident: null,
        // No model alternative is offered: a usage allowance belongs to the account, so
        // every model on it is equally out and a model switch would answer nothing.
        alternatives: [],
        usage: {
          account, clearsAt: new Date(input.clearsAtMs).toISOString(),
          heldInputs: held, accountsWithRoom: alternatives,
          // The moment a banked reset is worth most: work is stopped, and this ends it now
          // rather than at the reset instant above.
          resetCredit: availableResetCredit(input.provider),
        },
      },
    });
    // The account name belongs in his app, not in a log line.
    log("warn", "provider_usage_hold_notified", { provider: input.provider, session_id: turn.session_id,
      turn_id: input.turnId, clears_at: new Date(input.clearsAtMs).toISOString(),
      held_inputs: held, accounts_with_room: alternatives.length });
  } catch (error) {
    log("error", "provider_usage_hold_notice_failed", { provider: input.provider, turn_id: input.turnId,
      error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Spends a banked reset, unasked, when work has actually stopped and nothing else can move it.
 *
 * The rule itself is `decideAutomaticReset`, deliberately pure and separate so it can be
 * read and exercised without a provider. This is only the part that has side effects.
 *
 * **One reset can never be spent twice.** Two guards, and the second is the real one:
 *  - Within this instance, the decision is recorded under an event id keyed to the exact
 *    hold episode *before* the attempt, so a second observer of the same episode is refused
 *    by SQLite rather than by timing.
 *  - Across machines, the provider is the lock. Both instances can see the same exhausted
 *    account, and `consume` answers `alreadyRedeemed`, which is treated as "someone already
 *    did it" and not as a failure. Nothing here tries to be clever about which machine goes
 *    first, because the only authority on whether a grant is still there is OpenAI.
 */
export async function useResetIfWorkStopped(input: UsageHoldNotice, record: RecordEvent,
  spend: (account: string) => Promise<{ status: string; detail: string }>,
  afterUse: () => Promise<number>): Promise<void> {
  const provider = input.provider;
  const held=db.query(`SELECT count(*) AS total,sum(CASE WHEN turn.saved_kind='banked' THEN 1 ELSE 0 END) AS banked
    FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE session.provider_id=? AND turn.status='queued' AND turn.dispatch_failure_class='retryable'`)
    .get(provider) as {total:number;banked:number|null};
  if(held.total>0&&held.total===held.banked){
    log('info','provider_reset_not_used',{provider,reason:'only_banked_work_is_held'});
    return;
  }
  const usage = providerAccountUsage(provider);
  const blockedAccount = currentAccount(provider)?.label
    ?? usage?.accounts.find(account => account.current)?.label ?? null;
  const episode = `provider-reset-auto:${provider}:${blockedAccount ?? "unknown"}:${input.clearsAtMs}`;
  const decision = decideAutomaticReset({
    provider, blockedAccount, accountsWithRoom: accountsWithRoom(provider),
    candidates: (usage?.accounts ?? []).flatMap(account => account.resetCredits?.available
      ? [{ account: account.label, available: account.resetCredits.available,
           expiresAt: account.resetCredits.expiresAt ?? null }] : []),
    alreadyDecided: !!db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(episode),
  });
  if (!decision.use) {
    log("info", "provider_reset_not_used", { provider, reason: decision.because });
    return;
  }
  const turn = db.query("SELECT session_id FROM turns WHERE id=?").get(input.turnId) as { session_id: number } | null;
  const session = turn && getSessionById(turn.session_id) ? turn.session_id : inboxSession()?.id;
  if (!session) return;
  try {
    // Recorded before the attempt, so this episode can never be attempted a second time
    // even if what follows throws or the process dies mid-call.
    record({ eventId: episode, sessionId: session, kind: "provider_reset_attempt",
      payload: { provider, account: decision.account, because: decision.because } });
  } catch { return; }
  const outcome = await spend(decision.account);
  if (outcome.status === "failed") {
    log("warn", "provider_reset_auto_failed", { provider, account_known: true });
    return;
  }
  // Awaited so the remaining count below is read after the account was re-read, not before.
  const released = await afterUse();
  const after = providerAccountUsage(provider)?.accounts.find(account => account.label === decision.account);
  const remaining = after?.resetCredits?.available ?? 0;
  record({
    eventId: `${episode}:used`, sessionId: session, kind: "provider_outage",
    payload: {
      inputId: null, provider, model: null, modelLabel: provider === "codex" ? "Codex" : "Claude",
      status: null, incident: null, alternatives: [],
      usage: {
        account: decision.account, clearsAt: null, heldInputs: 0, accountsWithRoom: [],
        // What makes this a report of something already done rather than an offer.
        resetUsed: {
          account: decision.account, remaining, releasedInputs: released,
          nextExpiresAt: after?.resetCredits?.expiresAt ?? null,
          summary: resetUsedSentence({ account: decision.account, remaining, releasedInputs: released,
            nextExpiresAt: after?.resetCredits?.expiresAt ?? null }),
        },
      },
    },
  });
  log("warn", "provider_reset_used_automatically", { provider, remaining, released_inputs: released });
}

/**
 * One allowance period, named by a reset instant that wobbles.
 *
 * The same jitter that silenced the forecast would, once it started firing, break the other
 * half: these ids are what stop a notice repeating, and an id built from a reset instant
 * that moves by milliseconds is a different id every reading. Rounding to the minute keeps
 * one id per period while staying far finer than any real window.
 */
const allowancePeriod = (resetsAt: string) => Math.round(Date.parse(resetsAt) / 60_000);

/** A window's name in words, because "5-hour" is a field name and not a sentence. */
function windowLabel(name: string): string {
  if (name === "5-hour") return "five-hour window";
  if (name === "Weekly") return "weekly allowance";
  const scoped = name.match(/^Weekly · (.+?) only$/);
  return scoped ? `weekly allowance for ${scoped[1]}` : name;
}

/**
 * Says it before it happens.
 *
 * He asked for this in his own words after the 2026-09-22 outage: "the system should be
 * notified 30 minutes before, like 50 minutes before one hour before, it should know that
 * like, oh, we're running out of credit". The numbers were always there; nothing read them.
 *
 * One notice per window per allowance period — the reset instant identifies the period, so
 * the ledger's unique event id does the deduplication and a window cannot nag. It fires
 * only for the account the agents are actually on, only when the forecast says that window
 * runs out before it refills, and only inside the last hour, so it is a handful of
 * notifications a week rather than a running commentary. It changes nothing by itself.
 */
export function publishUsageForecastNotices(record: RecordEvent): void {
  const inbox = inboxSession();
  if (!inbox) return;
  for (const provider of ["claude-code", "codex"] as const) {
    let forecast;
    try { forecast = tightestCurrentWindow(provider); } catch { continue; }
    if (!forecast || forecast.minutesLeft === null || !forecast.resetsAt) continue;
    if (forecast.minutesLeft * 60_000 > WARN_LEAD_MS) continue;
    const eventId = `provider-usage-forecast:${provider}:${forecast.window}:${allowancePeriod(forecast.resetsAt)}`;
    if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(eventId)) continue;
    try {
      const spare = accountsWithRoom(provider);
      record({
        eventId, sessionId: inbox.id, kind: "provider_outage",
        payload: {
          inputId: null, provider, model: null, modelLabel: provider === "codex" ? "Codex" : "Claude",
          status: null, incident: null, alternatives: [],
          usage: {
            account: currentAccount(provider)?.label ?? null,
            clearsAt: forecast.resetsAt, heldInputs: 0, accountsWithRoom: spare,
            // He asked to be told "this is running low, maybe use a reset now" — so it rides
            // on the notice that already says he is running low, rather than arriving as a
            // second alert about the same moment.
            resetCredit: availableResetCredit(provider),
            // What makes this a warning rather than a report of a stop that already happened.
            predicted: {
              window: forecast.window, windowLabel: windowLabel(forecast.window),
              usedPercent: forecast.usedPercent, exhaustsAt: forecast.exhaustsAt,
              minutesLeft: forecast.minutesLeft, source: forecast.source,
              ratePerHour: forecast.ratePerHour, samples: forecast.samples, spanMinutes: forecast.spanMinutes,
            },
          },
        },
      });
      log("warn", "provider_usage_forecast_notified", { provider, window: forecast.window,
        used_percent: forecast.usedPercent, minutes_left: forecast.minutesLeft, source: forecast.source,
        samples: forecast.samples, span_minutes: forecast.spanMinutes, accounts_with_room: spare.length });
    } catch (error) {
      log("error", "provider_usage_forecast_notice_failed", { provider,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Says a banked reset is about to lapse, whether or not anything is running low.
 *
 * The notice above only fires when an account is under pressure, and a reset can perfectly
 * well expire during a quiet fortnight in which nothing ever gets close to a limit. That is
 * the case he named — "at the very least we should not let them go to waste" — so this
 * watches the expiry itself and is the reason the guarantee holds rather than usually
 * holding.
 *
 * Every account is checked, not only the one in use: a grant belongs to an account, and one
 * sitting on the account he is not currently on is exactly the one nothing else would
 * mention. One notice per credit per milestone, keyed by the expiry instant, so the pass
 * that runs every few minutes cannot turn a deadline into a drumbeat.
 */
export function publishExpiringResetNotices(record: RecordEvent): void {
  const inbox = inboxSession();
  if (!inbox) return;
  const now = Date.now();
  for (const provider of ["codex", "claude-code"] as const) {
    for (const account of providerAccountUsage(provider)?.accounts ?? []) {
      const credits = account.resetCredits;
      if (!credits?.available || !credits.expiresAt) continue;
      const expiresAtMs = Date.parse(credits.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
      const daysLeft = (expiresAtMs - now) / DAY_MS;
      const milestone = EXPIRY_MILESTONES.find(step => daysLeft <= step.days);
      if (!milestone) continue;
      const eventId = `provider-reset-expiring:${provider}:${expiresAtMs}:${milestone.name}`;
      if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(eventId)) continue;
      try {
        record({
          eventId, sessionId: inbox.id, kind: "provider_outage",
          payload: {
            inputId: null, provider, model: null,
            modelLabel: provider === "codex" ? "Codex" : "Claude",
            status: null, incident: null, alternatives: [],
            usage: {
              account: account.label, clearsAt: null, heldInputs: 0, accountsWithRoom: [],
              resetCredit: { account: account.label, available: credits.available, expiresAt: credits.expiresAt },
              // What makes this about a deadline rather than about running out.
              resetExpiring: { expiresAt: credits.expiresAt, daysLeft: Math.max(0, Math.round(daysLeft)),
                milestone: milestone.name, title: credits.title ?? null },
            },
          },
        });
        log("warn", "provider_reset_credit_expiring", { provider, milestone: milestone.name,
          days_left: Math.round(daysLeft), available: credits.available, expires_at: credits.expiresAt });
      } catch (error) {
        log("error", "provider_reset_credit_notice_failed", { provider,
          error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

/**
 * Tells the sessions that are working right now that their account is getting low.
 *
 * A session that started its turn while the account was already low reads the situation in
 * its own per-turn context and costs nothing extra. This is for the other case, and it is
 * the one that matters: a session an hour into a long run, spending the allowance, with no
 * reason to look anything up. It gets told inside that run.
 *
 * Three guarantees, because a notice about spending must not itself spend:
 *  - It is pinned to the exact live run (`delivery:'steer'` with that run's id), so it can
 *    never start a turn on an idle session. If the run ends first, the notice fails and is
 *    not retried into a queue.
 *  - One per session per allowance period, keyed by the window's reset instant, so a
 *    tightening window cannot turn into a stream a session learns to skip.
 *  - It informs and asks; it instructs nothing. The session keeps its model and its work.
 */
export function briefRunningSessions(admit: (input: {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string; sourceRunId: string;
  requestId: string; text: string; delivery: "steer";
}) => unknown): void {
  for (const provider of ["claude-code", "codex"] as const) {
    let brief: string | null = null;
    let tight;
    try {
      tight = tightestCurrentWindow(provider);
      brief = usagePressureBrief(provider);
    } catch { continue; }
    if (!brief || !tight?.resetsAt) continue;
    const episode = `${provider}:${tight.window}:${allowancePeriod(tight.resetsAt)}`;
    const running = db.query(`SELECT turn.id AS turn_id, turn.session_id FROM turns turn
      JOIN sessions session ON session.id = turn.session_id
      WHERE turn.status = 'running' AND turn.stop_requested_at IS NULL AND turn.turn_kind = 'native'
        AND session.provider_id = ?`).all(provider) as { turn_id: number; session_id: number }[];
    for (const run of running) {
      const inputId = `budget:${episode}:${run.session_id}`;
      if (db.query("SELECT 1 FROM session_inputs WHERE id = ?").get(inputId)) continue;
      try {
        admit({ sessionId: run.session_id, inputId, origin: "service", sourceInputId: `budget:${episode}`,
          sourceRunId: nativeRunId(run.turn_id), requestId: inputId, delivery: "steer",
          text: `${brief}\n\nThis is a service notice about the account, not a request and not new authority. No reply is owed.` });
        log("info", "provider_usage_session_briefed", { provider, session_id: run.session_id,
          turn_id: run.turn_id, window: tight.window, minutes_left: tight.minutesLeft });
      } catch (error) {
        // A run that ended between the query and the admission is the ordinary case here.
        log("info", "provider_usage_session_brief_skipped", { provider, session_id: run.session_id,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
