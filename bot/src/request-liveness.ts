import { db, getSessionById, SETTLED_EXECUTION_SQL } from './state';
import { getAcceptedSessionInput } from './session-inputs';
import type { SessionOwner } from './session-owner';

/**
 * Whether an open request can still be answered without anyone's help, and what the owner does
 * when it cannot. See docs/plans/2026-09-23-request-reply-protocol.md.
 *
 * A request closes only by a command or a failed execution; a turn ending closes nothing. So the
 * owner needs to know when a request is *stranded*: its worker is not running, has nothing queued
 * and is not waiting on a live request of its own, which means nothing would ever produce the
 * answer. The first time, the worker is woken once with a reminder; if it is stranded again
 * without a final reply, the requester is told the request stalled. The request stays open, and a
 * late final still returns. This is evaluated when a worker's execution changes and when a request
 * it sent closes, so there is no timer.
 */

/**
 * Requests asked from this instant on follow the reminder protocol. Open requests from before it
 * keep only their due-time notice: they were all notified already, and reminding every old worker
 * in one deploy would wake a dozen sessions nobody is waiting on.
 */
export const REMINDERS_SINCE_MS = 1790138700000; // 2026-09-23T04:45:00Z

/** A request this session sent that is still able to wake it with its answer. */
function waitingOnLiveRequest(sessionId: number): boolean {
    const live = `outcome IS NULL AND stalled_at_ms IS NULL AND (overdue_at_ms IS NULL OR created_at_ms>=${REMINDERS_SINCE_MS})`;
    return !!db.query(`SELECT 1 FROM session_communication_requests WHERE source_session_id=? AND source_input_id IS NOT NULL AND ${live} LIMIT 1`).get(sessionId)
        || !!db.query(`SELECT 1 FROM session_peer_requests WHERE source_session_id=? AND ${live} LIMIT 1`).get(sessionId);
}

/** Whether something already in the system will wake this worker again. */
export function workerWillWake(owner: SessionOwner, sessionId: number): boolean {
    const session = getSessionById(sessionId);
    if (!session) return false;
    if (['running', 'queued'].includes(owner.view(session).execution)) return true;
    return waitingOnLiveRequest(sessionId);
}

export type StrandedStep =
    | { step: 'none' }
    | { step: 'remind' }
    | { step: 'stall'; reason: string };

/**
 * The next step for an open request whose worker's turn has ended with no final reply.
 * `remindedAtMs`/`stalledAtMs` are the request's own record of the steps already taken.
 */
export function strandedStep(owner: SessionOwner, input: { requestId: string; workerSessionId: number; createdAtMs: number; remindedAtMs: number | null; stalledAtMs: number | null }): StrandedStep {
    if (input.createdAtMs < REMINDERS_SINCE_MS || input.stalledAtMs !== null) return { step: 'none' };
    if (workerWillWake(owner, input.workerSessionId)) return { step: 'none' };
    const session = getSessionById(input.workerSessionId);
    if (!session || !owner.view(session).capabilities.send)
        return { step: 'stall', reason: 'the worker session is paused, archived or no longer available, so it cannot be reminded' };
    if (input.remindedAtMs === null) return { step: 'remind' };
    const reminder = getAcceptedSessionInput(reminderInputId(input.requestId));
    if (!reminder?.turn_id)
        return { step: 'stall', reason: 'the reminder could not be delivered to the worker session' };
    const turn = db.query(`SELECT (${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(reminder.turn_id) as { settled: number } | null;
    if (!turn?.settled) return { step: 'none' };
    return { step: 'stall', reason: 'the worker was reminded once and ended again without a final reply, and nothing it is waiting on is tracked' };
}

export const reminderInputId = (requestId: string) => `remind:${requestId}`;

/** One service input waking the worker with the exact command it owes. Idempotent by input ID. */
export function remindWorker(owner: SessionOwner, input: { requestId: string; workerSessionId: number; targetInputId: string; targetRunId: string; requester: string; requestedEffect: string }) {
    const command = input.requestedEffect === 'work'
        ? `sessions reply ${input.requestId} --work-disposition completed|failed|needs_decision`
        : `sessions reply ${input.requestId}`;
    return owner.admit({
        sessionId: input.workerSessionId, inputId: reminderInputId(input.requestId), origin: 'service',
        sourceInputId: input.targetInputId, sourceRunId: input.targetRunId, requestId: input.requestId,
        text: `Reminder: request ${input.requestId} from ${input.requester} is still open, and your turn ended without a final reply to it. How a turn ends is never read as a reply, and nothing else will wake you for it. `
            + `If you are finished, send your final reply now: ${command}. `
            + `If you are not, send --partial saying exactly what you are waiting on; unless that is a request you sent and are still waiting on, the requester will be told this request has stalled. This is a system reminder, not new authorization.`,
    });
}

export const stalledNotice = (requestId: string, worker: string, reason: string, lastPartial: string | null) =>
    `Request ${requestId} has stalled: ${worker} has not sent a final reply, and ${reason}. `
    + (lastPartial ? `Its last partial reply said: "${lastPartial.slice(0, 600)}". ` : 'It sent no partial reply. ')
    + 'The request stays open and a late final reply will still return here. Decide whether to wait, ask again, or cancel it (sessions cancel).';
