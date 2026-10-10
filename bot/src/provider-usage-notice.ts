import { authHeldInputCount, db, getSessionById } from "./state";
import { log } from "./log";
import { currentAccount } from "./provider-accounts";
import { claudeRunsFromOwnHomes, selectedClaudeHome } from "./provider-account-dispatch";
import { modelLabel } from "./provider-outage";
import { inboxSession } from "./session-inbox";
import { NOTICE_AT_PERCENT, WARN_LEAD_MS, accountAvailability, accountsNearlySpent, accountsWithRoom, accountsWithRoomBesides,
  tightestCurrentWindow, type UsageForecast } from "./provider-usage-forecast";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";
import { nativeRunId } from "./session-inputs";
import { providerAccountUsage } from "./provider-account-usage";
import { budgetBriefWithProviderRoom, codexRoomForClaudeDelegation, newWorkCapacity, newWorkHeadroom } from './provider-start-choice';
import { decideAutomaticReset, resetUsedSentence } from "./provider-reset-policy";
import type { UsageProvider } from "./provider-usage";
import type {TurnContinuationReason} from './session-inputs';
import { hostname } from "node:os";

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
  account?: string | null;
};

type RecordEvent = (event: {
  eventId: string; sessionId: number; inputId?: string | null; turnId?: number | null; kind: string; payload: unknown;
}) => void;

/** How many accepted inputs are waiting on this same reset instant, this one included. */
function heldInputCount(clearsAtMs: number): number {
  const row = db.query(`SELECT count(*) AS held FROM turns
    WHERE status='queued' AND dispatch_failure_class='backoff' AND dispatch_next_attempt_ms=?`)
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
    // The account agents run on, never the terminal's login in the main folder.
    const account = (input.provider === "claude-code" && claudeRunsFromOwnHomes() ? selectedClaudeHome()?.label : null)
      ?? currentAccount(input.provider)?.label ?? null;
    const alternatives = accountsWithRoom(input.provider);
    // Each account's own state, so nothing reading this notice has to infer one account's
    // reset from another's: which is out, and until when.
    const accounts = accountAvailability(input.provider).map(room => ({ account: room.account, hasRoom: room.hasRoom,
      freeAt: room.freeAt === null ? null : new Date(room.freeAt).toISOString() }));
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
          heldInputs: held, accountsWithRoom: alternatives, accounts,
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

/** The provider never worked on this input; tell Tejas through the same provider-free courier. */
export function noticeAuthHold(input: {provider: UsageProvider; model:string|null; turnId:number; account:string|null}, record:RecordEvent):void {
  const turn = db.query('SELECT session_id, accepted_input_id FROM turns WHERE id=?')
    .get(input.turnId) as {session_id:number; accepted_input_id:string|null}|null;
  if(!turn?.accepted_input_id || !getSessionById(turn.session_id))return;
  // Agents' account, never the terminal's login in the main folder when accounts have homes.
  const account=input.account??(input.provider==='claude-code'&&claudeRunsFromOwnHomes()?selectedClaudeHome()?.label:null)
    ??currentAccount(input.provider)?.label??'the signed-in account';
  const machine=machineName();
  const head=db.query(`SELECT min(turns.id) AS id FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND turns.dispatch_failure_class='auth_wait' AND sessions.provider_id=?`)
    .get(input.provider) as {id:number|null};
  const episode=`provider-auth-hold:${input.provider}:${head.id??input.turnId}`;
  // The oldest held turn names the episode. Once authentication works, the queue
  // releases it and a later refusal has a new oldest turn and a new notice.
  const previous=db.query(`SELECT 1 FROM session_owner_events WHERE event_id=?`).get(episode);
  if(previous)return;
  const waiting=db.query(`SELECT count(*) AS held FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND sessions.provider_id=?`).get(input.provider) as {held:number};
  const heldInputs=Math.max(authHeldInputCount(input.provider),waiting.held);
  try {
    record({eventId:episode,sessionId:turn.session_id,inputId:turn.accepted_input_id,turnId:input.turnId,
      kind:'provider_outage',payload:{inputId:turn.accepted_input_id,provider:input.provider,
        model:input.model,modelLabel:modelLabel(input.model),status:null,incident:null,alternatives:[],
        auth:{account,machine,heldInputs}}});
    log('warn','provider_auth_hold_notified',{provider:input.provider,machine,held_inputs:heldInputs});
  } catch(error) {
    log('error','provider_auth_hold_notice_failed',{provider:input.provider,turn_id:input.turnId,
      error:error instanceof Error?error.message:String(error)});
  }
}

/** A continuation uses the same provider-free event and episode deduplication as a hold. */
/** The machine as he names it: his notice read "Codex sign-in expired on cortex-docker-users" (2026-10-04). */
function machineName():string { return process.platform==='darwin'?'your Mac':'the server'; }

export function noticeTurnContinuation(input:{provider:UsageProvider;model:string|null;turnId:number;
  reason:TurnContinuationReason;account?:string|null},record:RecordEvent):void {
  if(input.reason.kind!=='provider_refused')return;
  if(input.reason.refusal==='sign_in'){
    noticeAuthHold({...input,account:input.account??null},record);
    return;
  }
  if(input.reason.refusal==='usage' && input.reason.waitUntilMs && input.reason.waitUntilMs>Date.now()){
    noticeUsageHold({...input,clearsAtMs:input.reason.waitUntilMs},record);
    return;
  }
  const turn=db.query('SELECT session_id,accepted_input_id FROM turns WHERE id=?').get(input.turnId) as
    {session_id:number;accepted_input_id:string|null}|null;
  if(!turn?.accepted_input_id || !getSessionById(turn.session_id))return;
  const head=db.query(`SELECT min(turns.id) AS id FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND turns.dispatch_failure_class IN ('usage_wait','backoff')
      AND sessions.provider_id=?`).get(input.provider) as {id:number|null};
  const eventId=`provider-continuation-hold:${input.provider}:${input.reason.refusal}:${head.id??input.turnId}`;
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return;
  const waiting=db.query(`SELECT count(*) AS held FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND sessions.provider_id=?`).get(input.provider) as {held:number};
  try{
    record({eventId,sessionId:turn.session_id,inputId:turn.accepted_input_id,turnId:input.turnId,
      kind:'provider_outage',payload:{inputId:turn.accepted_input_id,provider:input.provider,
        model:input.model,modelLabel:modelLabel(input.model),status:null,incident:null,alternatives:[],
        continuation:{reason:input.reason.refusal,account:input.account??currentAccount(input.provider)?.label??null,
          machine:machineName(),heldInputs:waiting.held,
          clearsAt:input.reason.waitUntilMs?new Date(input.reason.waitUntilMs).toISOString():null}}});
    log('warn','provider_continuation_hold_notified',{provider:input.provider,reason:input.reason.refusal,
      machine:hostname(),held_inputs:waiting.held});
  }catch(error){log('error','provider_continuation_hold_notice_failed',{provider:input.provider,
    error:error instanceof Error?error.message:String(error)});}
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
  const held=db.query(`SELECT turn.saved_kind AS saved_kind FROM turns turn WHERE turn.id=?`).get(input.turnId) as {saved_kind:string|null}|null;
  // Held ordinary work is named by the hold marks the rest of this file uses. It cannot be
  // matched on the clearance instant any more: a usage hold now records no next attempt at
  // all, so an instant comparison found nothing and the reset credit was withheld while his
  // own work sat waiting for it.
  const ordinaryHeld=db.query(`SELECT 1 FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE session.provider_id=? AND turn.status='queued' AND turn.saved_kind IS NOT 'banked'
      AND turn.dispatch_failure_class IN ('usage_wait','backoff') LIMIT 1`)
    .get(provider);
  if(held?.saved_kind==='banked'&&!ordinaryHeld){
    log('info','provider_reset_not_used',{provider,reason:'only_banked_work_is_held'});
    return;
  }
  const usage = providerAccountUsage(provider);
  const blockedAccount = input.account ?? currentAccount(provider)?.label
    ?? usage?.accounts.find(account => account.current)?.label ?? null;
  const episode = `provider-reset-auto:${provider}:${blockedAccount ?? "unknown"}:${input.clearsAtMs}`;
  // The blocked account's own windows, read by what the provider calls them. A window this
  // cannot identify stays null, and null never argues for spending: when the weekly state
  // is unknown the rule refuses, which is the safe direction for something finite.
  const blockedWindows = (usage?.accounts ?? []).find(account => account.label === blockedAccount)?.windows ?? [];
  const named = (match: (name: string) => boolean) =>
    blockedWindows.find(window => match(window.name.toLowerCase()))?.usedPercent ?? null;
  const decision = decideAutomaticReset({
    provider, blockedAccount, accountsWithRoom: blockedAccount ? accountsWithRoomBesides(provider, blockedAccount) : accountsWithRoom(provider),
    candidates: (usage?.accounts ?? []).flatMap(account => account.resetCredits?.available
      ? [{ account: account.label, available: account.resetCredits.available,
           expiresAt: account.resetCredits.expiresAt ?? null }] : []),
    windows: {
      weeklyUsedPercent: named(name => name.includes("week") || name === "7d"),
      fiveHourUsedPercent: named(name => name.includes("5h") || name.includes("5 h") || name.includes("hour") || name.includes("session")),
    },
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
 * Tells him, in his Inbox and on his phone, when an account reaches 90% of a window.
 *
 * Only the level counts: no pace, no forecast, no "will run out around" (Tejas, 2026-10-08,
 * after a pace projection warned him at 21% [decision: usage-notice-only-at-90-percent]). It is a
 * provider-free Inbox notice, because a bare outage event is never shown (2026-10-07). One per
 * account per window per allowance period; it watches every account, since turns move between
 * accounts for room. When the window refills its thread says so and closes.
 */
export function publishUsageForecastNotices(_record?: RecordEvent): void {
  let published = false;
  const capacity = (provider: 'claude-code' | 'codex') => {
    try { return newWorkCapacity(provider); } catch { return null; }
  };
  const claudeCapacity = capacity('claude-code');
  const codexCapacity = capacity('codex');
  const bothNear = !!claudeCapacity && !!codexCapacity
    && claudeCapacity.used >= NOTICE_AT_PERCENT && codexCapacity.used >= NOTICE_AT_PERCENT
    && (claudeCapacity.used < 100 || codexCapacity.used < 100)
    && !!claudeCapacity.windowResetAt && !!codexCapacity.windowResetAt;
  for (const provider of ["claude-code", "codex"] as const) {
    let nearlySpent: UsageForecast[];
    try { nearlySpent = accountsNearlySpent(provider); } catch { continue; }
    for (const reading of nearlySpent) {
      if (bothNear) continue;
      if (!reading.resetsAt) continue;
      // A fresh key: a pace notice already sent this period must not suppress the 90% one.
      const key = `usage-at-${NOTICE_AT_PERCENT}:${provider}:${reading.account}:${reading.window}:${allowancePeriod(reading.resetsAt)}`;
      if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(`service-notice:${key}`)) continue;
      try {
        const spare = accountsWithRoomBesides(provider, reading.account);
        const recorded = publishProviderFreeNotice(db, {
          key, kind: "provider_usage_warning",
          text: usageWarningText(provider, reading, spare),
          payload: {
            provider, account: reading.account, window: reading.window, windowLabel: windowLabel(reading.window),
            usedPercent: reading.usedPercent, resetsAt: reading.resetsAt, accountsWithRoom: spare,
            movesAutomatically: movesAutomatically(provider), thresholdPercent: NOTICE_AT_PERCENT,
          },
        });
        published ||= recorded;
        log("warn", "provider_usage_level_notified", { provider, account: reading.account, window: reading.window,
          used_percent: reading.usedPercent, accounts_with_room: spare.length, recorded });
      } catch (error) {
        log("error", "provider_usage_level_notice_failed", { provider,
          error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  try {
    const claude = claudeCapacity;
    const codex = codexCapacity;
    if (bothNear && claude && codex && claude.windowResetAt && codex.windowResetAt) {
      // Account eligibility can change before either provider refills. That must not turn
      // one period of shared pressure into a second warning with a different reset key.
      const open = db.query(`SELECT 1 FROM session_inputs input
        JOIN session_owner_events event ON event.input_id=input.id AND event.kind='provider_usage_warning'
        WHERE input.scope=? AND json_extract(event.payload_json,'$.providers') IS NOT NULL
          AND json_extract(event.payload_json,'$.resetsAt')>?
          AND NOT EXISTS (SELECT 1 FROM session_owner_events done WHERE done.event_id='post:service-resolved:'||input.id)
        LIMIT 1`).get(SERVICE_NOTICE_SCOPE,new Date().toISOString());
      if (!open) {
        const key = `both-providers-at-${NOTICE_AT_PERCENT}:${allowancePeriod(new Date(claude.windowResetAt).toISOString())}:${allowancePeriod(new Date(codex.windowResetAt).toISOString())}`;
        published ||= publishProviderFreeNotice(db, {key,kind:'provider_usage_warning',
          text:'Both Claude and Codex are at or above 90% on the accounts that can start new work. Automatic new work uses whichever still has room. If both run out, new requests wait for the first usable allowance reset; work already running keeps its provider.',
          payload:{providers:['claude-code','codex'],thresholdPercent:NOTICE_AT_PERCENT,
            claudeUsedPercent:claude.used,codexUsedPercent:codex.used,
            resetsAt:new Date(Math.min(claude.windowResetAt,codex.windowResetAt)).toISOString()}});
      }
    }
  } catch (error) { log('error','combined_provider_usage_notice_failed',
    {error:error instanceof Error?error.message:String(error)}); }
  // The notice has its thread before its notification can be tapped.
  if (published) fileServiceNotices();
  settleRefilledUsageWarnings();
}

/** Claude turns pick, each time, an account that still has room; Codex moves its one login once the account in use is spent. */
const movesAutomatically = (provider: UsageProvider) => provider === "codex" || claudeRunsFromOwnHomes();

function usageWarningText(provider: UsageProvider, reading: UsageForecast, spare: string[]): string {
  const name = provider === "codex" ? "Codex" : "Claude";
  const refill = noticeTime(db, Date.parse(reading.resetsAt!));
  const head = `${name} account ${reading.account} has used ${Math.round(reading.usedPercent)}% of its `
    + `${windowLabel(reading.window)}. It refills at ${refill}.`;
  const next = spare.length
    ? movesAutomatically(provider)
      ? ` When it runs out, new ${name} work moves to ${spare.join(" or ")} by itself; nothing to do.`
      : ` When it runs out, ${name} work stops until it refills unless you switch to ${spare.join(" or ")} on the Accounts page.`
    : ` No other ${name} account has room, so when it runs out ${name} work waits until it refills.`;
  const other = provider === 'codex' ? 'claude-code' : 'codex';
  const otherUsed = newWorkHeadroom(other);
  const thisUsed = newWorkHeadroom(provider);
  const bothNear = thisUsed !== null && thisUsed >= NOTICE_AT_PERCENT
    && otherUsed !== null && otherUsed >= NOTICE_AT_PERCENT;
  const automaticElsewhere = otherUsed !== null && otherUsed < 100
    ? ` Automatic new work can start on ${other === 'codex' ? 'Codex' : 'Claude'} while it has room.` : '';
  return head + next + automaticElsewhere + (bothNear
    ? ' Both Claude and Codex are at or above 90% on the accounts that can take new work. If both reach their limits, new work waits for an allowance reset; work already running keeps its provider.'
    : '');
}

/**
 * A warning whose window has refilled is no longer something to read: its thread says so and
 * closes, ending the reading item, the way a retry notice closes when its breaker clears.
 */
function settleRefilledUsageWarnings(): void {
  const rows = db.query(`SELECT input.id, event.payload_json FROM session_inputs input
    JOIN session_owner_events event ON event.input_id=input.id AND event.kind='provider_usage_warning'
    WHERE input.scope=? AND NOT EXISTS (SELECT 1 FROM session_owner_events done WHERE done.event_id='post:service-resolved:'||input.id)
    ORDER BY event.sequence`)
    .all(SERVICE_NOTICE_SCOPE) as { id: string; payload_json: string }[];
  let sharedWarningActive = false;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as { resetsAt?: string; account?: string; provider?: string; providers?: string[]; thresholdPercent?: number };
      // Pace warnings sent before 2026-10-08 are withdrawn rather than left waiting to be read.
      if (payload.thresholdPercent === undefined) {
        settleServiceNotice({ inputId: row.id,
          text: `Withdrawn: running-low notices now come only when an account reaches ${NOTICE_AT_PERCENT}%.` });
        continue;
      }
      const resetsAtMs = Date.parse(payload.resetsAt ?? "");
      if (payload.providers && Number.isFinite(resetsAtMs) && resetsAtMs > Date.now()) {
        if (sharedWarningActive) settleServiceNotice({inputId:row.id,
          text:'This repeated warning has closed. The first warning remains active.'});
        else sharedWarningActive = true;
        continue;
      }
      if (!Number.isFinite(resetsAtMs) || resetsAtMs > Date.now()) continue;
      settleServiceNotice({ inputId: row.id,
        text: payload.providers
          ? `The first allowance refilled at ${noticeTime(db, resetsAtMs)}. The both-providers warning has ended.`
          : `${payload.account ?? "The account"} refilled at ${noticeTime(db, resetsAtMs)}. Nothing waits on you.` });
    } catch (error) {
      log("error", "provider_usage_warning_settle_failed", { input_id: row.id, error: String(error) });
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
export function publishExpiringResetNotices(_record?: RecordEvent): void {
  const now = Date.now();
  let published = false;
  for (const provider of ["codex", "claude-code"] as const) {
    for (const account of providerAccountUsage(provider)?.accounts ?? []) {
      const credits = account.resetCredits;
      if (!credits?.available || !credits.expiresAt) continue;
      const expiresAtMs = Date.parse(credits.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
      const daysLeft = (expiresAtMs - now) / DAY_MS;
      const milestone = EXPIRY_MILESTONES.find(step => daysLeft <= step.days);
      if (!milestone) continue;
      const key = `provider-reset-expiring:${provider}:${expiresAtMs}:${milestone.name}`;
      // Recorded before as a bare outage event, which thnkr.ing never showed; one already recorded
      // that way is not announced a second time.
      if (db.query("SELECT 1 FROM session_owner_events WHERE event_id IN (?,?)").get(key, `service-notice:${key}`)) continue;
      try {
        const name = provider === "codex" ? "Codex" : "Claude";
        const count = credits.available === 1 ? "1 banked usage reset" : `${credits.available} banked usage resets`;
        published = publishProviderFreeNotice(db, {
          key, kind: "provider_reset_expiring",
          text: `${count} on ${name} account ${account.label} ${credits.available === 1 ? "expires" : "expire"} `
            + `${noticeTime(db, expiresAtMs)}. One is spent automatically when that account runs out and work stops; `
            + "you can also spend one yourself on the Accounts page.",
          payload: { provider, account: account.label, available: credits.available, expiresAt: credits.expiresAt,
            daysLeft: Math.max(0, Math.round(daysLeft)), milestone: milestone.name, title: credits.title ?? null },
        }) || published;
        log("warn", "provider_reset_credit_expiring", { provider, milestone: milestone.name,
          days_left: Math.round(daysLeft), available: credits.available, expires_at: credits.expiresAt });
      } catch (error) {
        log("error", "provider_reset_credit_notice_failed", { provider,
          error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (published) fileServiceNotices();
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
 *  - One brief for each delegation-availability state per session and allowance
 *    period. A change in available room can update the action without repeated
 *    notices for every usage reading.
 *  - It gives a delegation action only when the same account choice that starts helpers
 *    verifies Codex has the room. The session keeps its model and its work.
 */
export function briefRunningSessions(admit: (input: {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string; sourceRunId: string;
  requestId: string; text: string; delivery: "steer";
}) => unknown): void {
  for (const provider of ["claude-code", "codex"] as const) {
    let brief: string | null = null;
    let tight;
    let capacity;
    try {
      tight = tightestCurrentWindow(provider);
      capacity = newWorkCapacity(provider);
      brief = budgetBriefWithProviderRoom(provider);
    } catch { continue; }
    const resetsAt = tight?.resetsAt ?? (capacity?.windowResetAt ? new Date(capacity.windowResetAt).toISOString() : null);
    if (!brief || !resetsAt) continue;
    const episode = `${provider}:${tight?.window ?? 'most-spent'}:${allowancePeriod(resetsAt)}`;
    const running = db.query(`SELECT turn.id AS turn_id, turn.session_id FROM turns turn
      JOIN sessions session ON session.id = turn.session_id
      WHERE turn.status = 'running' AND turn.stop_requested_at IS NULL AND turn.turn_kind = 'native'
        AND session.provider_id = ?`).all(provider) as { turn_id: number; session_id: number }[];
    for (const run of running) {
      // A previous brief this allowance period lacked verified provider room and the
      // delegation action. The versioned identity delivers the changed contract once.
      const direction = provider === 'claude-code' && codexRoomForClaudeDelegation()
        ? 'codex-ready' : 'budget-only';
      const inputId = `budget-room-v1:${direction}:${episode}:${run.session_id}`;
      if (db.query("SELECT 1 FROM session_inputs WHERE id = ?").get(inputId)) continue;
      try {
        // The notice is its own source, like the update-wait notice: a source must be an input
        // that exists, and the episode name it once carried was none, so every brief from
        // 2026-10-07 to 2026-10-09 was refused by the ledger and no running agent was ever told.
        admit({ sessionId: run.session_id, inputId, origin: "service", sourceInputId: inputId,
          sourceRunId: nativeRunId(run.turn_id), requestId: inputId, delivery: "steer",
          text: `${brief}\n\nThis is about the account, not a request; you do not need to reply.` });
        log("info", "provider_usage_session_briefed", { provider, session_id: run.session_id,
          turn_id: run.turn_id, window: tight?.window ?? 'most-spent', minutes_left: tight?.minutesLeft ?? null,
          codex_delegation_ready: provider === 'claude-code' && !!codexRoomForClaudeDelegation() });
      } catch (error) {
        // A run that ended between the query and the admission is the ordinary case here.
        log("info", "provider_usage_session_brief_skipped", { provider, session_id: run.session_id,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
