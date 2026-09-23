import { db, getSessionById } from './state';
import { getAcceptedSessionInput } from './session-inputs';
import type { SessionOwner } from './session-owner';

/**
 * Whether an open request can still be answered without anyone's help, and what the owner does
 * when it cannot. See docs/plans/2026-09-23-request-reply-protocol.md.
 *
 * A request closes only by a command or a failed execution; a turn ending closes nothing. So the
 * owner needs to know when a request is *stranded*: its worker is not running, has nothing queued
 * and is not waiting on a live request of its own, which means nothing would ever produce the
 * answer. The worker was held to the protocol by the Stop hook when it tried to end its turn; a
 * request still stranded after that is reported to its requester once as stalled. The request stays
 * open, and a late final still returns. This is evaluated when a worker's execution changes and when a request
 * it sent closes, so there is no timer.
 */

/**
 * Requests asked from this instant on follow the reminder protocol. Open requests from before it
 * keep only their due-time notice: they were all notified already, and reminding every old worker
 * in one deploy would wake a dozen sessions nobody is waiting on.
 */
export const REMINDERS_SINCE_MS = 1790138700000; // 2026-09-23T04:45:00Z

/** A request this session sent that is still able to wake it with its answer. */
export function waitingOnLiveRequest(sessionId: number): boolean {
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
    | { step: 'stall'; reason: string };

/**
 * The next step for an open request whose worker's turn has ended with no final reply. The
 * worker was already held to the protocol at the moment it tried to end its turn, by the Stop hook
 * both Claude Code and Codex run (owed-reply-stop-hook.ts); there is no second reminder turn. So
 * a stranded request is reported to its requester once, and stays open for a late final.
 */
export function strandedStep(owner: SessionOwner, input: { requestId: string; workerSessionId: number; createdAtMs: number; remindedAtMs: number | null; remindedVia: string | null; stalledAtMs: number | null }): StrandedStep {
    if (input.createdAtMs < REMINDERS_SINCE_MS || input.stalledAtMs !== null) return { step: 'none' };
    if (workerWillWake(owner, input.workerSessionId)) return { step: 'none' };
    const session = getSessionById(input.workerSessionId);
    if (!session || !owner.view(session).capabilities.send)
        return { step: 'stall', reason: 'the worker session is paused, archived or no longer available' };
    return { step: 'stall', reason: input.remindedVia === 'hook'
        ? 'it was sent back with the reply command when it tried to end its turn, and ended again without a final reply'
        : 'its turn ended without a final reply, and its end-of-turn check did not send it back (the check was unavailable, or the request arrived after it ran)' };
}

export const stalledNotice = (requestId: string, worker: string, reason: string, lastPartial: string | null) =>
    `Request ${requestId} has stalled: ${worker} has not sent a final reply, and ${reason}. `
    + (lastPartial ? `Its last partial reply said: "${lastPartial.slice(0, 600)}". ` : 'It sent no partial reply. ')
    + 'The request stays open and a late final reply will still return here. Decide whether to wait, ask again, or cancel it (sessions cancel).';

/**
 * FIPA's cancel reaches the participant: a canceled request tells a worker that already holds it
 * to stop, so it does not keep working on something nobody wants and then have its reply refused.
 * Idempotent by input ID; a worker that never received the request is not told.
 */
export function tellWorkerCanceled(owner: SessionOwner, input: { requestId: string; workerSessionId: number; targetInputId: string; requester: string }) {
    const target = getAcceptedSessionInput(input.targetInputId);
    if (!target?.turn_id) return null;
    const turn = db.query('SELECT native_run_id FROM turns WHERE id=?').get(target.turn_id) as { native_run_id: string | null } | null;
    if (!turn?.native_run_id) return null;
    const session = getSessionById(input.workerSessionId);
    if (!session || !owner.view(session).capabilities.send) return null;
    return owner.admit({
        sessionId: input.workerSessionId, inputId: `canceled:${input.requestId}`, origin: 'service',
        sourceInputId: input.targetInputId, sourceRunId: turn.native_run_id, requestId: input.requestId,
        text: `Request ${input.requestId} from ${input.requester} was canceled by its requester. Stop work on it. No reply is owed, and a reply to it now would be refused. This is a system notice, not new authorization.`,
    });
}

/**
 * The requests a session holds and has not closed, as its end-of-turn hook sees them: delivered
 * to it, asked since the protocol began, not yet reported stalled, and no final reply. Empty while
 * the session waits on a live request of its own, because ending the turn then strands nothing.
 */
export type OwedRequest = { request_id: string; requester: string; requested_effect: string; command: string };
export function replyCommand(requestId: string, requestedEffect: string) {
    return requestedEffect === 'work'
        ? `sessions reply ${requestId} --work-disposition completed|failed|needs_decision -- <result>`
        : `sessions reply ${requestId} -- <answer>`;
}

/**
 * What makes two finals the same answer for delivery: everything the requester would receive from
 * them — the responding session, the exact words, the disposition, the files, the evidence and any
 * delivery warning (a sibling whose own message was never confirmed received keeps its own return).
 * Owner bookkeeping (`outcome`, `output`, event ids) is not part of the answer, so a worker's own
 * final and a sibling settled from it compare equal. Null for a final with no words, never merged.
 */
export function sameAnswerKey(payloadJson: string): string | null {
    const payload = JSON.parse(payloadJson);
    if (typeof payload.text !== 'string' || !payload.text.trim()) return null;
    return JSON.stringify([payload.responding_session_id ?? null, payload.text, payload.workDisposition ?? null,
        payload.attachments ?? [], payload.evidence ?? null, payload.output?.delivery ?? null]);
}
