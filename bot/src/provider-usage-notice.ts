import { providerDisplayName } from "./aliases";
import { authHeldInputCount, db, getSessionById } from "./state";
import { log } from "./log";
import { currentAccount } from "./provider-accounts";
import { claudeAccountAwaitingSignIn, claudeAccountLaunchableHere, claudeRunsFromOwnHomes, selectedClaudeHome } from "./provider-account-dispatch";
import { modelLabel } from "./provider-outage";
import { inboxSession } from "./session-inbox";
import { accountAvailability, accountsWithRoom, accountsWithRoomBesides } from "./provider-usage-forecast";
import { noticeTime, publishProviderFreeNotice, SERVICE_NOTICE_SCOPE } from "./provider-free-notice";
import { fileServiceNotices, settleServiceNotice } from "./session-topics";
import { nativeRunId } from "./session-inputs";
import { providerAccountUsage } from "./provider-account-usage";
import { budgetBriefWithProviderRoom, otherProviderRoomForDelegation, measuredBudgetPressure, newWorkCapacity } from './provider-start-choice';
import { decideAutomaticReset, resetUsedSentence } from "./provider-reset-policy";
import { clearCodexAccountUsage, type UsageProvider } from "./provider-usage";
import type {TurnContinuationReason} from './session-inputs';
import { hostname } from "node:os";
import { createHash } from "node:crypto";

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
 * The hold is recorded for diagnosis. A usage wait does not itself require Tejas to act:
 * the owner retries on a usable account or at a proved reset, and the repair path handles
 * a sign-in that actually needs him. Publishing this as a phone outage made a withdrawn
 * agent request look like his own waiting message on 2026-11-03.
 *
 * One observation per episode, not per input: the allowance belongs to the account, so the
 * reset instant identifies the episode and the ledger's unique event id deduplicates it.
 * It changes nothing by itself. A hold is not a request for Tejas to act.
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
function heldInputCount(clearsAtMs: number,provider:UsageProvider,account:string|null): number {
  if(provider==='claude-code'&&!account)return 1;
  const row = provider==='claude-code'
    ?db.query(`SELECT count(*) AS held FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.status='queued' AND turn.dispatch_failure_class='backoff' AND turn.dispatch_hold='usage'
        AND turn.dispatch_next_attempt_ms=? AND session.provider_id=?
        AND EXISTS (SELECT 1 FROM executions execution WHERE execution.turn_id=turn.id
          AND execution.created_at_ms=(SELECT max(latest.created_at_ms) FROM executions latest WHERE latest.turn_id=turn.id)
          AND json_extract(execution.processor_json,'$.account.account')=?)`).get(clearsAtMs,provider,account) as {held:number}
    :db.query(`SELECT count(*) AS held FROM turns turn JOIN sessions session ON session.id=turn.session_id
      WHERE turn.status='queued' AND turn.dispatch_failure_class='backoff' AND turn.dispatch_hold='usage'
        AND turn.dispatch_next_attempt_ms=? AND session.provider_id=?`).get(clearsAtMs,provider) as {held:number};
  return Math.max(1, row.held);
}

export function noticeUsageHold(input: UsageHoldNotice, record: RecordEvent): void {
  const account=input.provider==='claude-code'?input.account??null:currentAccount(input.provider)?.label??null;
  const accountId=account?createHash('sha256').update(account.toLowerCase()).digest('hex').slice(0,16):'unknown';
  const eventId = `provider-usage-hold:${input.provider}:${accountId}:${input.model??'unknown'}:${input.clearsAtMs}`;
  if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(eventId)) return;
  const turn = db.query("SELECT session_id, accepted_input_id FROM turns WHERE id=?")
    .get(input.turnId) as { session_id: number; accepted_input_id: string | null } | null;
  if (!turn?.accepted_input_id || !getSessionById(turn.session_id)) return;
  const inputId = turn.accepted_input_id;
  try {
    // A failed Claude attempt names its execution account; preflight has no execution account.
    // Room in a usage reading is not room this machine can use: an account whose login here is signed
    // out is named as needing a sign-in, never as where the work moves (the Mac, 2026-11-02).
    const withRoom = accountsWithRoom(input.provider,input.model);
    const alternatives = input.provider==='claude-code' ? withRoom.filter(claudeAccountLaunchableHere) : withRoom;
    const needSignIn = input.provider==='claude-code' ? withRoom.filter(claudeAccountAwaitingSignIn) : [];
    // Each account's own state, so nothing reading this notice has to infer one account's
    // reset from another's: which is out, and until when.
    const accounts = accountAvailability(input.provider,input.model).map(room => ({ account: room.account, hasRoom: room.hasRoom,
      freeAt: room.freeAt === null ? null : new Date(room.freeAt).toISOString() }));
    const inbox=input.provider==='claude-code'?inboxSession():null;
    const inboxClaudeExhausted=!!inbox&&inbox.provider_id==='claude-code'&&alternatives.length===0;
    const held = heldInputCount(input.clearsAtMs,input.provider,account);
    record({
      eventId, sessionId: turn.session_id, inputId, turnId: input.turnId,
      kind: "provider_hold_observed",
      payload: {
        inputId, provider: input.provider, model: input.model,
        modelLabel: modelLabel(input.model), status: null, incident: null,
        // No model alternative is offered: a usage allowance belongs to the account, so
        // every model on it is equally out and a model switch would answer nothing.
        alternatives: [],
        usage: {
          account, clearsAt: new Date(input.clearsAtMs).toISOString(),
          heldInputs: held, accountsWithRoom: alternatives, accountsNeedingSignIn: needSignIn, accounts,
          // Whether held work moves to an account with room by itself is this file's rule; the
          // notice reads the answer instead of keeping its own copy of it (nightly review, 2026-11-03).
          movesAutomatically: movesAutomatically(input.provider), machine: machineName(),
          inboxClaudeExhausted,
          codexRoom: input.provider==='claude-code' ? (()=>{const codex=newWorkCapacity('codex');return codex?codex.used<100?'yes':'no':'unknown';})() : null,
          // The moment a banked reset is worth most: work is stopped, and this ends it now
          // rather than at the reset instant above.
          resetCredit: availableResetCredit(input.provider),
        },
      },
    });
    // The account name belongs in his app, not in a log line.
    log("info", "provider_usage_hold_observed", { provider: input.provider, session_id: turn.session_id,
      turn_id: input.turnId, clears_at: new Date(input.clearsAtMs).toISOString(),
      held_inputs: held, accounts_with_room: alternatives.length, accounts_needing_sign_in: needSignIn.length });
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
  // Claude homes and Codex have a browser repair agent. Antigravity, and a
  // single-home Claude installation, still need a guarded human sign-in notice.
  const hasRepairRoute=input.provider==='codex'||input.provider==='claude-code'&&claudeRunsFromOwnHomes();
  try {
    record({eventId:episode,sessionId:turn.session_id,inputId:turn.accepted_input_id,turnId:input.turnId,
      kind:hasRepairRoute?'provider_hold_observed':'provider_outage',payload:{inputId:turn.accepted_input_id,provider:input.provider,
        model:input.model,modelLabel:modelLabel(input.model),status:null,incident:null,alternatives:[],
        auth:{account,machine,heldInputs}}});
    log('info','provider_auth_hold_observed',{provider:input.provider,machine,held_inputs:heldInputs});
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
  // A rate limit or a model at capacity clears by itself within seconds and the continuation
  // carries on, so nothing has stopped and there is nothing for him to know. Phrased as an
  // allowance notice it read "9 messages are waiting on tejas@chann.app … stopped at the GPT-6
  // limit" while that account had 61% of its week left, 22 times from Oct 16 to Oct 30, each a
  // new push. If such waits never end, the retry policy's exhaustion notice reaches the repair agent.
  if(input.reason.refusal==='rate_limit'){
    log('info','provider_continuation_rate_limit_quiet',{provider:input.provider,model:input.model,
      turn_id:input.turnId,clears_at:input.reason.waitUntilMs?new Date(input.reason.waitUntilMs).toISOString():null});
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
  // Only work this refusal actually stopped: scheduled and banked items waiting for their own
  // time, and queued turns of suspended sessions, are not waiting on an allowance.
  const waiting=db.query(`SELECT count(*) AS held FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND sessions.provider_id=?
      AND (turns.dispatch_hold='usage' OR turns.dispatch_failure_class='usage_wait' OR turns.id=?)`)
    .get(input.provider,input.turnId) as {held:number};
  try{
    record({eventId,sessionId:turn.session_id,inputId:turn.accepted_input_id,turnId:input.turnId,
      kind:'provider_hold_observed',payload:{inputId:turn.accepted_input_id,provider:input.provider,
        model:input.model,modelLabel:modelLabel(input.model),status:null,incident:null,alternatives:[],
        continuation:{reason:input.reason.refusal,account:input.account??currentAccount(input.provider)?.label??null,
          machine:machineName(),heldInputs:waiting.held,
          clearsAt:input.reason.waitUntilMs?new Date(input.reason.waitUntilMs).toISOString():null}}});
    log('info','provider_continuation_hold_observed',{provider:input.provider,reason:input.reason.refusal,
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
 *  - The exact hold episode is also the provider idempotency key. A repeated attempt with
 *    that key can report `alreadyRedeemed`, meaning that attempt completed successfully.
 *    Two machines may race with distinct hold episodes; OpenAI decides whether the named
 *    credit remains available. Only a confirmed reset followed by a fresh account read
 *    that permits ordinary work releases a hold.
 */
export async function useResetIfWorkStopped(input: UsageHoldNotice, record: RecordEvent,
  spend: (account: string, idempotencyKey: string, beforeConsume: () => void) => Promise<{ status: string; detail: string;
    accountId?: string; verifiedReadStartedAtMs?: number; remainingCredits?: number | null; nextExpiresAt?: string | null }>,
  afterUse: (accountId: string) => Promise<number>): Promise<void> {
  const provider = input.provider;
  const held=db.query(`SELECT turn.saved_kind AS saved_kind FROM turns turn JOIN sessions session ON session.id=turn.session_id
    WHERE turn.id=? AND session.provider_id=? AND turn.status='queued'
      AND turn.dispatch_hold='usage' AND turn.dispatch_failure_class IN ('usage_wait','backoff')`)
    .get(input.turnId,provider) as {saved_kind:string|null}|null;
  // The exact refused turn must be ordinary work held for usage. An unrelated retry backoff
  // elsewhere in the queue is not evidence for spending a finite credit on this episode.
  if(!held||held.saved_kind==='banked'){
    log('info','provider_reset_not_used',{provider,reason:'no_ordinary_usage_hold_on_this_turn'});
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
  const digest = createHash("sha256").update(episode).digest("hex");
  // Stable across restarts and short enough for the provider's recommended UUID shape.
  const idempotencyKey = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const outcome = await spend(decision.account, idempotencyKey, () => {
    // Reserve only after direct preflight succeeds, immediately before the provider call.
    // A declined preflight leaves the hold eligible for a later existing wake or manual action.
    if (db.query("SELECT 1 FROM session_owner_events WHERE event_id=?").get(episode))
      throw new Error("This reset episode already has an attempt.");
    record({ eventId: episode, sessionId: session, kind: "provider_reset_attempt",
      payload: { provider, account: decision.account, because: decision.because } });
  });
  if (outcome.status !== "used" || !outcome.accountId || !outcome.verifiedReadStartedAtMs) {
    log("warn", "provider_reset_auto_not_confirmed", {
      provider, account_known: true, outcome: outcome.status,
    });
    return;
  }
  let cleared = false;
  try { cleared = clearCodexAccountUsage(outcome.accountId, outcome.verifiedReadStartedAtMs); }
  catch (error) { log("error", "provider_reset_auto_cache_clear_failed", {
    provider, error: error instanceof Error ? error.message : String(error) }); }
  let released = 0;
  if (currentAccount('codex')?.id !== outcome.accountId) {
    log("warn", "provider_reset_auto_account_changed", { provider, account_known: true });
  } else if (cleared) {
    try { released = await afterUse(outcome.accountId); }
    catch (error) { log("error", "provider_reset_auto_release_failed", {
      provider, error: error instanceof Error ? error.message : String(error) }); }
  }
  const remaining = outcome.remainingCredits ?? null;
  const nextExpiresAt = outcome.nextExpiresAt ?? null;
  record({
    eventId: `${episode}:used`, sessionId: session, kind: "provider_hold_observed",
    payload: {
      inputId: null, provider, model: null, modelLabel: providerDisplayName(provider) ?? provider,
      status: null, incident: null, alternatives: [],
      usage: {
        account: decision.account, clearsAt: null, heldInputs: 0, accountsWithRoom: [],
        // What makes this a report of something already done rather than an offer.
        resetUsed: {
          account: decision.account, remaining, releasedInputs: released,
          nextExpiresAt,
          summary: resetUsedSentence({ account: decision.account, remaining, releasedInputs: released,
            nextExpiresAt, roomConfirmed: cleared && currentAccount('codex')?.id === outcome.accountId }),
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

/** Running-low readings stay in Accounts; they do not require a message to Tejas. */
export function publishUsageForecastNotices(_record?: RecordEvent): void {
  settleRefilledUsageWarnings();
}

/** Claude turns pick, each time, an account that still has room; Codex moves its one login once the account in use is spent. */
const movesAutomatically = (provider: UsageProvider) => provider === "codex" || claudeRunsFromOwnHomes();

/**
 * A warning whose stated reset time passed is no longer something to read: its thread says so and
 * closes, ending the reading item, the way a retry notice closes when its breaker clears.
 */
function settleRefilledUsageWarnings(): void {
  const rows = db.query(`SELECT input.id, event.payload_json FROM session_inputs input
    JOIN session_owner_events event ON event.input_id=input.id AND event.kind='provider_usage_warning'
    WHERE input.scope=? AND NOT EXISTS (SELECT 1 FROM session_owner_events done WHERE done.event_id='post:service-resolved:'||input.id)
    ORDER BY event.sequence`)
    .all(SERVICE_NOTICE_SCOPE) as { id: string; payload_json: string }[];
  for (const row of rows) {
    try {
      settleServiceNotice({ inputId: row.id,
        text: 'Running-low updates now stay in Accounts; this notice is closed.' });
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
        const name = providerDisplayName(provider) ?? provider;
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
 *  - One brief for each delegation-availability state per session, account and
 *    allowance period. A change in available room can update the action without
 *    repeated notices for every usage reading.
 *  - It gives a delegation action only when the same account choice that starts separate
 *    work verifies the other provider has room. The session keeps its model and its work.
 */
export function briefRunningSessions(admit: (input: {
  sessionId: number; inputId: string; origin: "service"; sourceInputId: string; sourceRunId: string;
  requestId: string; text: string; delivery: "steer";
}) => unknown): void {
  for (const provider of ["claude-code", "codex"] as const) {
    // The IN term selects the partial running-turn index instead of walking every turn.
    const running = db.query(`SELECT turn.id AS turn_id, turn.session_id FROM turns turn
      JOIN sessions session ON session.id = turn.session_id
      WHERE turn.status IN ('running','delivering') AND turn.status = 'running' AND turn.stop_requested_at IS NULL AND turn.turn_kind = 'native'
        AND session.provider_id = ?`).all(provider) as { turn_id: number; session_id: number }[];
    for (const run of running) {
      // Claude turns can outlive an account selection change. Use the account retained
      // with this execution, and say nothing when older custody cannot identify it.
      const execution = db.query(`SELECT processor_json FROM executions WHERE turn_id=?
        AND state IN ('intended','live') ORDER BY created_at_ms DESC LIMIT 1`)
        .get(run.turn_id) as { processor_json: string } | null;
      let account: string | undefined;
      try { account = (JSON.parse(execution?.processor_json ?? '{}') as { account?: { account?: string } }).account?.account; }
      catch { continue; }
      if (provider === 'claude-code' && !account) continue;
      const pressure = measuredBudgetPressure(provider, account);
      if (!pressure) continue;
      const brief = budgetBriefWithProviderRoom(provider, Date.now(), account);
      if (!brief) continue;
      const period = pressure.resetsAt ? allowancePeriod(pressure.resetsAt) : `run-${run.turn_id}`;
      const episode = `${provider}:${pressure.account}:${pressure.window}:${period}`;
      // A previous brief this allowance period lacked verified provider room and the
      // delegation action. The versioned identity delivers the changed contract once.
      const otherRoom = otherProviderRoomForDelegation(provider, Date.now(), pressure.account);
      const direction = otherRoom === 'codex' ? 'codex-ready'
        : otherRoom === 'claude-code' ? 'claude-ready' : 'budget-only';
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
          turn_id: run.turn_id, account: pressure.account, window: pressure.window,
          used_percent: pressure.usedPercent, observed_at: pressure.observedAt,
          other_provider_room: otherRoom });
      } catch (error) {
        // A run that ended between the query and the admission is the ordinary case here.
        log("info", "provider_usage_session_brief_skipped", { provider, session_id: run.session_id,
          reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}
