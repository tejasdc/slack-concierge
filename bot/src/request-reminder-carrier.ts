import { getAcceptedSessionInput, type AcceptedSessionInput } from './session-inputs';
import { readInputExecution } from './session-owner';

/**
 * A "no confirmed answer" reminder is admitted once under `request-reminder:<event>`. After that,
 * its delivery is read from whichever input carries it now, never admitted again under the same
 * identity: an accepted handoff moves the asking request to the successor and copies a queued
 * reminder there as `handoff-input:…`, so re-admitting the original identity into the successor
 * is refused by the ledger (it belongs to the predecessor). On 2026-11-12 three Nov 7 reminders
 * were refused that way about three times a minute, 6,133 times since that morning's restart
 * (docs/incidents/2026-11-12-handed-off-reminder-refused-forever.md).
 */
export type ReminderDelivery = { inputId: string; status: 'received' | 'admitted' | 'held'; error: string | null };
type Owner = { admit(input: { sessionId: number; inputId: string; origin: 'service'; sourceInputId: string; sourceRunId: string; requestId: string; text: string }): AcceptedSessionInput;
  dispatch(input: AcceptedSessionInput): AcceptedSessionInput };

const receiptOf = (input: AcceptedSessionInput): { state?: string; continuedAs?: string; reason?: string } => {
  try { return JSON.parse(input.receipt_json ?? '{}') ?? {}; } catch { return {}; }
};

/** Follows handoff copies (`continuedAs` on the moved input's receipt) to the input carrying the reminder now. */
export function reminderCarrier(inputId: string): AcceptedSessionInput | null {
  let input = getAcceptedSessionInput(inputId);
  const seen = new Set<string>();
  while (input && !seen.has(input.id)) {
    seen.add(input.id);
    const next = receiptOf(input).continuedAs;
    const carried = typeof next === 'string' ? getAcceptedSessionInput(next) : null;
    if (!carried) return input;
    input = carried;
  }
  return input;
}

function observed(input: AcceptedSessionInput): ReminderDelivery {
  const execution = readInputExecution(input);
  const received = execution.acknowledgedAt || execution.turn?.input_context_received_by_turn_id;
  return { inputId: input.id, status: received ? 'received' : input.turn_id ? 'admitted' : 'held', error: null };
}

export function deliverRequestReminder(o: { eventId: string; acceptedInputId: string | null; sourceSessionId: number;
  sourceInputId: string; sourceRunId: string; requestId: string; text: string; owner: Owner }): ReminderDelivery {
  const original = `request-reminder:${o.eventId}`;
  const admit = (inputId: string) => observed(o.owner.admit({ sessionId: o.sourceSessionId, inputId, origin: 'service',
    sourceInputId: o.sourceInputId, sourceRunId: o.sourceRunId, requestId: o.requestId, text: o.text }));
  const carrier = (o.acceptedInputId ? reminderCarrier(o.acceptedInputId) : null) ?? reminderCarrier(original);
  if (!carrier) return admit(original);
  const receipt = receiptOf(carrier);
  const current = observed(carrier);
  if (current.status === 'received') return current;
  // Withdrawn on purpose (its request closed, or Stop): retire it rather than resend withdrawn words.
  if (receipt.state && !receipt.continuedAs)
    return { inputId: carrier.id, status: 'received', error: `Reminder withdrawn before delivery${receipt.reason ? ` (${receipt.reason})` : ''}; not resent.` };
  if (carrier.session_id === o.sourceSessionId) return observed(o.owner.dispatch(carrier));
  // The asking session was handed off and its successor holds no copy: give the successor its own,
  // under an identity scoped to that session so the predecessor's record is never rewritten.
  return admit(`${original}:session:${o.sourceSessionId}`);
}
