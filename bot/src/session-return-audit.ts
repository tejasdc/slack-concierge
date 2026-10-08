import { db } from './state';
import { log } from './log';
import { recordTurnOutcome } from './session-turn-outcome';
import { REMINDERS_SINCE_MS } from './request-liveness';

/**
 * Every settled request owes its requester one return input. Delivery normally follows within
 * the same wake, so a settled result still without a return after the grace period has been
 * dropped somewhere, as completed work was on September 21, 2026 when it was retained instead
 * of returned. This audit makes that loud: one `session_return_undelivered` error per result.
 * A requester that is paused or archived holds its result on purpose and is not reported, and an
 * answer the owner posted straight into an Inbox thread (`received` with no return input) has
 * reached its destination.
 */
const GRACE_MS = 10 * 60 * 1000;
const UNDELIVERED = (events: string, requests: string, extra: string) => `SELECT e.event_id, e.request_id, e.status, e.created_at_ms, r.source_session_id
    FROM ${events} e JOIN ${requests} r ON r.request_id=e.request_id
    WHERE (e.kind='final' AND r.outcome IS NOT NULL OR json_extract(e.payload_json,'$.stalled')=1) AND e.accepted_input_id IS NULL
      AND e.status NOT IN ('held','retained','received') AND e.created_at_ms<=? ${extra}`;
export type UndeliveredReturnRow={event_id:string;request_id:string;status:string;created_at_ms:number;source_session_id:number;peer:boolean};
/** The audit and local supervisor read one definition; the supervisor supplies a hard bound. */
export function undeliveredReturnRows(now=Date.now(),limit?:number):UndeliveredReturnRow[] {
    const bounded=limit===undefined?null:Math.max(0,Math.min(30,Math.trunc(limit)));
    if(bounded===0)return [];
    const read=(events:string,requests:string,extra:string,peer:boolean)=>(db.query(`${UNDELIVERED(events,requests,extra)} ORDER BY e.created_at_ms,e.event_id${bounded===null?'':' LIMIT ?'}`)
        .all(now-GRACE_MS,...(bounded===null?[]:[bounded])) as Array<Omit<UndeliveredReturnRow,'peer'>>).map(row=>({...row,peer}));
    return [...read('session_communication_events','session_communication_requests','AND r.source_input_id IS NOT NULL',false),
        ...read('session_peer_events','session_peer_requests','',true)]
        .sort((a,b)=>a.created_at_ms-b.created_at_ms||a.event_id.localeCompare(b.event_id)).slice(0,bounded??undefined);
}
/**
 * A return whose input was recorded and then died with the turn that received it.
 * Recording a return does not discharge it: on 2026-09-22 nine returns were written into
 * the Inbox and every one of their turns was refused by a usage limit within seconds, so
 * the ledger said `received` while nobody had read a word. A turn whose unacknowledged
 * input was later carried into another turn's context is excluded — that one did arrive.
 */
const UNHANDLED = (events: string, requests: string, extra: string) => `SELECT e.event_id, e.request_id, e.status, e.accepted_input_id, e.created_at_ms, r.source_session_id, turn.id AS turn_id, turn.status AS turn_status
    FROM ${events} e JOIN ${requests} r ON r.request_id=e.request_id
      JOIN session_inputs input ON input.id=e.accepted_input_id
      JOIN turns turn ON turn.id=input.turn_id
    WHERE (e.kind='final' AND r.outcome IS NOT NULL OR json_extract(e.payload_json,'$.stalled')=1)
      AND turn.status IN ('error','parked') AND turn.input_context_received_by_turn_id IS NULL ${extra}`;
const reported = new Set<string>();
const reportedUnhandled = new Set<string>();
const loggedUnhandled = new Set<string>();
/**
 * Both scans read every settled result, and the communication wake runs many times a second
 * under load; nothing here can be reported before a ten-minute grace, so once a minute is enough.
 * On 2026-10-07 the audit was a tenth of the owner's busy time while Tejas's replies waited.
 */
const AUDIT_EVERY_MS = 60 * 1000;
let auditedAt = -Infinity;

export function auditUndeliveredReturns(now = Date.now()) {
    if (now - auditedAt < AUDIT_EVERY_MS) return;
    auditedAt = now;
    const rows = undeliveredReturnRows(now);
    for (const row of rows) {
        if (reported.has(row.event_id)) continue;
        reported.add(row.event_id);
        log('error', 'session_return_undelivered', { event_id: row.event_id, request_id: row.request_id, status: row.status,
            source_session_id: `concierge:${row.source_session_id}`, peer_request: !!row.peer, undelivered_ms: now - row.created_at_ms });
    }
    const unhandled = [
        ...(db.query(UNHANDLED('session_communication_events', 'session_communication_requests', 'AND r.source_input_id IS NOT NULL')).all() as any[]).map(row => ({ ...row, peer: null })),
        ...(db.query(UNHANDLED('session_peer_events', 'session_peer_requests', '')).all() as any[]).map(row => ({ ...row, peer: true })),
    ];
    // One return can carry several requests' answers; it is one thing for him to look at.
    const seenInputs = new Set<string>();
    for (const row of unhandled) {
        if (seenInputs.has(row.accepted_input_id)) { reportedUnhandled.add(row.event_id); continue; }
        seenInputs.add(row.accepted_input_id);
        if (reportedUnhandled.has(row.event_id)) continue;
        // Already reported in an earlier process, by hand before reminders existed or by its recorded
        // question since: every restart used to log the whole history again as fresh errors.
        if (row.created_at_ms < REMINDERS_SINCE_MS
            || db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`return_unhandled:${row.event_id}`)) {
            reportedUnhandled.add(row.event_id); continue;
        }
        // Reported, never replayed: the result stays in the ledger for its requester's
        // own next run, because a failed handling is not permission to send it again.
        if (!loggedUnhandled.has(row.event_id)) log('error', 'session_return_unhandled', { event_id: row.event_id, request_id: row.request_id, status: row.status,
            turn_status: row.turn_status, source_session_id: `concierge:${row.source_session_id}`, peer_request: !!row.peer });
        loggedUnhandled.add(row.event_id);
        // A log alone left him as the monitoring system. The session that should have read this
        // result asks him to look, through the same Needs attention path any turn uses.
        // Results from before this rule were already handled by hand (2026-09-22); only new ones ask.
        // The event counts as reported only once he can see it; a failed attention write is retried.
        if (row.created_at_ms < REMINDERS_SINCE_MS) { reportedUnhandled.add(row.event_id); continue; }
        try {
            // One transaction, so a failure part-way leaves nothing behind and the next audit retries.
            db.transaction(() => recordTurnOutcome({ eventId: `return_unhandled:${row.event_id}`, sessionId: row.source_session_id, turnId: row.turn_id, inputId: row.accepted_input_id,
                outcome: 'needs_you', text: `A result for request ${row.request_id} reached this session but its turn ended ${row.turn_status === 'error' ? 'in an error' : 'without a confirmed outcome'}, so nobody has read it. Open this session to see it; it has not been sent again.` }))();
            reportedUnhandled.add(row.event_id);
        } catch (error) { log('error', 'session_return_unhandled_attention_failed', { event_id: row.event_id, error: error instanceof Error ? error.message : String(error) }); }
    }
}

/**
 * The release that stopped retaining completion shipped while the old runtime kept retaining.
 * The Inbox's retained results up to this instant were re-delivered to it once, in the fixing
 * session's reply; anything the old runtime retained afterwards returns normally here. Rows
 * retained before this instant stay history, so nothing is delivered twice.
 */
const RETAINED_WRITES_REDELIVERED_UNTIL_MS = 1790022862331;
export function releaseLateRetainedReturns() {
    for (const table of ['session_communication_events', 'session_peer_events'])
        db.query(`UPDATE ${table} SET status='recorded',error=NULL WHERE status='retained' AND created_at_ms>?`).run(RETAINED_WRITES_REDELIVERED_UNTIL_MS);
    // Declared completion used to wait for the answering run to end; a request still waiting
    // that way settles now, from the reply already recorded as its result, and returns.
    for (const [requests, events] of [['session_communication_requests', 'session_communication_events'], ['session_peer_requests', 'session_peer_events']])
        db.query(`UPDATE ${requests} SET outcome='answered',status='settled' WHERE outcome IS NULL AND result_json IS NOT NULL
            AND EXISTS (SELECT 1 FROM ${events} e WHERE e.request_id=${requests}.request_id AND e.kind='final'
                AND json_extract(e.payload_json,'$.workDisposition')='completed')`).run();
}
