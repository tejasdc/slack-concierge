import { db, getSessionById } from './state';
import { canceledNotice, requestLabel } from './session-notices';
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

/**
 * When an agent is first asked whether it is still waiting: a request with no answer, or a
 * background job a Concierge update is waiting on. Every such notice and its wording read this
 * one value. It was 30 minutes in four places; Tejas asked for 15 on 2026-10-07, after workers
 * the 1:47 AM crash cut off went unnoticed for half an hour.
 */
export const STILL_WAITING_AFTER_MS = 15 * 60_000;
export const STILL_WAITING_MINUTES = STILL_WAITING_AFTER_MS / 60_000;

/** Human thread replies get a prompt answer while the recipient continues its work. */
export const PROMPT_ANSWER_REMINDER_MS = 2 * 60_000;
export const PROMPT_ANSWER_OVERDUE_MS = 3 * 60_000;

/** True while a Concierge update is draining: work held only by it is waiting, not stalled. */
export function updateDraining(): boolean {
  return !!db.query('SELECT 1 FROM deployment_drain WHERE singleton=1').get();
}

/**
 * The open requests the due-time inspection still looks at. Its timer and the inspection read this
 * one predicate. They once differed: the timer still counted a stalled request the inspection
 * skips, so a stalled request past its due time kept the timer due at once, and the owner
 * re-dispatched every open request dozens of times a second from 08:25 to 17:17 and again from
 * 17:42 on September 23, 2026. Those writes made every deployment's run claim fail on a busy database.
 */
export const AWAITING_INSPECTION = 'outcome IS NULL AND overdue_at_ms IS NULL AND stalled_at_ms IS NULL';

/** A request this session sent that is still able to wake it with its answer. */
export function waitingOnLiveRequest(sessionId: number, sinceMs = 0, untakenAnswers = true): boolean {
    const live = `outcome IS NULL AND stalled_at_ms IS NULL AND (overdue_at_ms IS NULL OR created_at_ms>=${REMINDERS_SINCE_MS})`;
    return !!db.query(`SELECT 1 FROM session_communication_requests request
        LEFT JOIN session_inputs target ON target.id=request.target_input_id
        LEFT JOIN turns saved_turn ON saved_turn.id=target.turn_id
        WHERE request.source_session_id=? AND request.source_input_id IS NOT NULL AND request.created_at_ms>=? AND ${live}
          AND NOT (saved_turn.saved_kind IS NOT NULL AND saved_turn.status='queued') LIMIT 1`).get(sessionId, sinceMs)
        || !!db.query(`SELECT 1 FROM session_peer_requests WHERE source_session_id=? AND created_at_ms>=? AND ${live} LIMIT 1`).get(sessionId, sinceMs)
        // A request that has just been answered still wakes this session until its answer is taken
        // in: on 2026-10-08 three requests were reported stalled in the same second their worker's
        // own sub-request settled, before the return that woke it had started a turn.
        || untakenAnswers && !!db.query(`SELECT 1 FROM session_communication_requests request
            JOIN session_communication_events answer ON answer.request_id=request.request_id AND answer.kind='final'
            WHERE request.source_session_id=? AND request.source_input_id IS NOT NULL AND request.created_at_ms>=? AND answer.status IN ('recorded','admitted') LIMIT 1`).get(sessionId, sinceMs);
}

/** The worker ended its turn waiting on something that will wake it: its own live request, or a watch it registered (watches.ts). */
export function waitingOnDependency(sessionId: number, sinceMs = 0, untakenAnswers = true): boolean {
    return !!db.query("SELECT 1 FROM watches WHERE session_id=? AND created_at_ms>=? AND (state IN ('accepted','observing') OR delivery_state='pending') LIMIT 1").get(sessionId, sinceMs)
        || waitingOnLiveRequest(sessionId, sinceMs, untakenAnswers);
}

/** Whether something already in the system will wake this worker again. */
export function workerWillWake(owner: SessionOwner, sessionId: number, sinceMs = 0): boolean {
    const session = getSessionById(sessionId);
    if (!session) return false;
    if (['running', 'queued'].includes(owner.view(session).execution)) return true;
    return waitingOnDependency(sessionId, sinceMs);
}

export type StrandedStep =
    | { step: 'none' }
    | { step: 'report-back' }
    | { step: 'stall'; reason: string };

/**
 * Requests asked from this instant on are owed one report-back when their worker stops without
 * replying and its end-of-turn check could not send it back. Older open requests keep the old
 * behaviour, so the release that adds this wakes nobody about work from before it.
 */
export const REPORT_BACK_SINCE_MS = 1792000000000; // 2026-10-14T17:46:40Z

/**
 * The next step for an open request whose worker's turn has ended with no final reply. The
 * worker is normally held to the protocol at the moment it tries to end its turn, by the Stop hook
 * both Claude Code and Codex run (owed-reply-stop-hook.ts). When that check could not send it back
 * (Concierge was restarting or down, as it can be under an outside agent, or the request arrived
 * after the check ran), the owner asks the worker once to report back (Tejas, 2026-10-14: "detect
 * that it actually stopped with no response, and then ask it to report back"). A request still
 * stranded after either reminder is reported once as stalled, and stays open for a late final.
 */
export function strandedStep(owner: SessionOwner, input: { requestId: string; workerSessionId: number; createdAtMs: number; remindedAtMs: number | null; remindedVia: string | null; stalledAtMs: number | null }): StrandedStep {
    if (input.createdAtMs < REMINDERS_SINCE_MS || input.stalledAtMs !== null) return { step: 'none' };
    // Only what the worker started for this request counts: its own sub-request or watch after the request arrived.
    if (workerWillWake(owner, input.workerSessionId, input.createdAtMs)) return { step: 'none' };
    const session = getSessionById(input.workerSessionId);
    if (!session || !owner.canSend(session))
        return { step: 'stall', reason: 'the worker session is paused, archived or no longer available' };
    if (input.remindedVia === null && input.createdAtMs >= REPORT_BACK_SINCE_MS) return { step: 'report-back' };
    // A reminder counts only once it reached the worker's queue: one retained by a run that died
    // before dispatching it is dispatched again, never taken for delivered.
    if (input.remindedVia === 'owner' && !getAcceptedSessionInput(`report-back:${input.requestId}`)?.turn_id) return { step: 'report-back' };
    return { step: 'stall', reason: input.remindedVia === 'hook'
        ? 'it was sent back with the reply command when it tried to end its turn, and ended again without a final reply'
        : input.remindedVia === 'owner'
        ? 'its run ended without a final reply, it was asked once to report back, and it ended again without one'
        : 'its turn ended without a final reply, and its end-of-turn check did not send it back (the check was unavailable, or the request arrived after it ran)' };
}

/** What a worker that stopped without replying is told, once, by the owner. */
export const reportBackNotice = (label: string, command: string) =>
    `Your run ended before you sent your final reply to ${label}, and your end-of-turn check could not send you back (Concierge may have been restarting). `
    + `Its requester has not been answered. Check what you finished and what is still open, then reply now with router-actions.sh ${command}, `
    + 'using this input\'s source pair. If the work is not finished, finish it first or say exactly what is left.';

export const stalledNotice = (reason: string, lastPartial: string | null) =>
    `The agent stopped before answering this request: ${reason}. `
    + (lastPartial ? `Its last partial reply said: "${lastPartial.slice(0, 600)}". ` : 'It sent no partial reply. ')
    + 'The request stays open, and a late answer will still arrive here.';

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
    // ChatGPT is not an agent: a canceled request's answer is simply dropped, never announced into
    // his ChatGPT conversation (Tejas saw this notice there on 2026-10-09).
    if (!session || session.provider_id === 'chatgpt' || !owner.canSend(session)) return null;
    return owner.admit({
        sessionId: input.workerSessionId, inputId: `canceled:${input.requestId}`, origin: 'service',
        sourceInputId: input.targetInputId, sourceRunId: turn.native_run_id, requestId: input.requestId,
        text: canceledNotice(requestLabel((db.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(input.requestId) as { payload_json: string } | null)?.payload_json ?? '{}'), input.requester),
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
        ? `sessions reply ${requestId} --work-disposition completed|failed|needs_decision --summary "<one line>" [-- <new words; omit after a prompt-answer partial>]`
        : `sessions reply ${requestId} --summary "<one line>" -- <answer>`;
}
