import { db } from './state';
import { log } from './log';

/**
 * Every settled request owes its requester one return input. Delivery normally follows within
 * the same wake, so a settled result still without a return after the grace period has been
 * dropped somewhere, as completed work was on September 21, 2026 when it was retained instead
 * of returned. This audit makes that loud: one `session_return_undelivered` error per result.
 * A requester that is paused or archived holds its result on purpose and is not reported.
 */
const GRACE_MS = 10 * 60 * 1000;
const UNDELIVERED = (events: string, requests: string, extra: string) => `SELECT e.event_id, e.request_id, e.status, r.source_session_id
    FROM ${events} e JOIN ${requests} r ON r.request_id=e.request_id
    WHERE e.kind='final' AND r.outcome IS NOT NULL AND e.accepted_input_id IS NULL
      AND e.status NOT IN ('held','retained') ${extra}`;
const firstSeen = new Map<string, number>();
const reported = new Set<string>();

export function auditUndeliveredReturns(now = Date.now()) {
    const rows = [
        ...(db.query(UNDELIVERED('session_communication_events', 'session_communication_requests', 'AND r.source_input_id IS NOT NULL')).all() as any[]).map(row => ({ ...row, peer: null })),
        ...(db.query(UNDELIVERED('session_peer_events', 'session_peer_requests', '')).all() as any[]).map(row => ({ ...row, peer: true })),
    ];
    const current = new Set(rows.map(row => row.event_id as string));
    for (const id of firstSeen.keys()) if (!current.has(id)) firstSeen.delete(id);
    for (const row of rows) {
        const seen = firstSeen.get(row.event_id) ?? now;
        firstSeen.set(row.event_id, seen);
        if (now - seen < GRACE_MS || reported.has(row.event_id)) continue;
        reported.add(row.event_id);
        log('error', 'session_return_undelivered', { event_id: row.event_id, request_id: row.request_id, status: row.status,
            source_session_id: `concierge:${row.source_session_id}`, peer_request: !!row.peer, undelivered_ms: now - seen });
    }
}
