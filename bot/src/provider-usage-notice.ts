import { db, getSessionById } from "./state";
import { log } from "./log";
import { currentAccount } from "./provider-accounts";
import { providerAccountUsage } from "./provider-account-usage";
import { modelLabel } from "./provider-outage";
import type { UsageProvider } from "./provider-usage";

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
  eventId: string; sessionId: number; inputId: string; turnId: number; kind: string; payload: unknown;
}) => void;

/** How many accepted inputs are waiting on this same reset instant, this one included. */
function heldInputCount(clearsAtMs: number): number {
  const row = db.query(`SELECT count(*) AS held FROM turns
    WHERE status='queued' AND dispatch_failure_class='retryable' AND dispatch_next_attempt_ms=?`)
    .get(clearsAtMs) as { held: number };
  return Math.max(1, row.held);
}

/**
 * The provider's other logins on this machine that had room at the last reading, by name.
 * The reading is the half-hourly one the Provider accounts surface already shows; it is
 * never taken here, because a notice must not wait on a subprocess. An account counts as
 * having room when none of its windows is spent.
 */
function accountsWithRoom(provider: UsageProvider): string[] {
  const usage = providerAccountUsage(provider);
  if (!usage) return [];
  return usage.accounts
    .filter(account => !account.current && !account.problem && account.windows.length
      && account.windows.every(window => window.usedPercent < 100))
    .map(account => account.label);
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
