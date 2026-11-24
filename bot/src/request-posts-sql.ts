/**
 * The posts that answer one request, found through each session's posts.
 *
 * Posts are a few thousand rows in a handful of Inbox sessions, so walking every session's
 * `(session_id, kind)` index entries reads only posts. Asking the event table by kind and request
 * alone has no index: it read every event ever recorded for each changed Inbox request (10 s
 * with the ledger in memory, 80-90 s beside a backup on 2026-11-24) and pushed the owner's ledger
 * pages out of memory. `scripts/storage-observation-check.ts` refuses a plan that scans events.
 */
export const postsForRequestSql=`SELECT event.sequence,event.session_id AS sessionId,event.event_id AS messageId,event.input_id AS inputId,event.created_at AS createdAt
  FROM sessions session CROSS JOIN session_owner_events event INDEXED BY session_owner_events_session_kind
    ON event.session_id=session.id AND event.kind='post'
  WHERE json_extract(event.payload_json,'$.requestId')=? ORDER BY event.sequence`;
export type RequestPost={sequence:number;sessionId:number;messageId:string;inputId:string;createdAt:string};
