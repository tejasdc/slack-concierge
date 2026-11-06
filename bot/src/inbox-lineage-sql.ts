/**
 * Which sessions are the Inbox, as SQL both the owner and the prepared-read worker share.
 * This module imports nothing, so the worker can use it without loading the owner's state.
 *
 * There is one Inbox. Every session ever marked as the Inbox (`$.inbox`) is part of its one
 * dialogue, its threads and its topics; the history page has always read it that way. The
 * session that holds the `inbox` standing role is the current router: new captures go to it
 * and Inbox commands act through it. A provider handoff and `sessions agents bind inbox` both
 * move that role. Before 2026-11-06 only a handoff did: binding a stand-in moved the role's
 * label, but captures, threads and thread lookups kept following the newest Inbox-marked
 * session and an accepted-handoff chain, so the stand-in received nothing and could name no
 * thread (the overnight Codex usage-limit incident).
 */

/** The current Inbox router: the live role holder among Inbox sessions, else the newest one. */
export const CURRENT_INBOX_ID_SQL=`SELECT id FROM sessions
  WHERE json_extract(native_metadata_json,'$.inbox')=1
  ORDER BY (status<>'archived' AND json_extract(native_metadata_json,'$.standingRole') IS 'inbox') DESC, id DESC LIMIT 1`;

/**
 * The sessions whose rows belong to the same conversation as session `?` (one bind parameter):
 * itself, its accepted provider-handoff predecessors and, when any of those is an Inbox
 * session, every Inbox session. UNION (not UNION ALL) keeps a handoff cycle finite.
 */
export const INBOX_LINEAGE_SQL=`WITH RECURSIVE lineage(id) AS (SELECT ? UNION
    SELECT predecessor_session_id FROM session_handoffs JOIN lineage ON successor_session_id=lineage.id WHERE state='accepted')
  SELECT id FROM lineage
  UNION SELECT inbox.id FROM sessions inbox WHERE json_extract(inbox.native_metadata_json,'$.inbox')=1
    AND EXISTS (SELECT 1 FROM lineage JOIN sessions member ON member.id=lineage.id
      WHERE json_extract(member.native_metadata_json,'$.inbox')=1)`;
