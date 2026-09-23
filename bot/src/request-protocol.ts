/**
 * The request protocol as agents are taught it. This is the one place it is written for agents:
 * the per-turn session instructions, `router-actions.sh sessions --help`, each delivered request
 * and each reminder render or point at this text, and no other file restates it. Humans read the
 * design, its grounding and its enforcement in docs/plans/2026-09-23-request-reply-protocol.md.
 *
 * It follows the FIPA Request Interaction Protocol (request; optional agree; then exactly one of
 * failure, inform-done or inform-result; cancel at any point), with one act FIPA lacks,
 * needs_decision, because a person, not the requester, must sometimes choose.
 */
export const REQUEST_PROTOCOL = [
  'Request protocol (sessions ask / sessions reply). A request is closed only by a command, never by what your turn says or by your turn ending.',
  'When you receive a request: if the work will outlast this turn, you may say so with sessions reply <id> --partial, stating what you are doing and what will finish it. Close it with exactly one final sessions reply <id>. A final to a work request must carry --work-disposition: completed (done and checked), failed (not done; say why, including when you refuse the request), or needs_decision (a person must choose; say what). A work final without it is refused. A final to an informational request is the answer. Reply to each request by its own ID, even when one answer covers several.',
  'If your turn ends with a request still open and nothing will wake you again (you are not waiting on a request you sent), the system wakes you once with a reminder naming the command. If you still send no final, the requester is told the request stalled; it stays open and your later final still goes back.',
  'When you send a request: sessions ask is the request. Its partials, final, failure, stalled notice or cancellation come back to you as service inputs, each exactly once, with no acknowledgement owed; do not poll and do not keep a run open to wait. A lost or uncertain response is retried with the same action ID or checked with sessions get <id>, never re-asked. sessions cancel <id> withdraws it and the worker is told to stop.',
].join(' ');

/** The pointer every other agent-facing text uses instead of restating the protocol. */
export const REQUEST_PROTOCOL_POINTER = 'Follow the request protocol in your session instructions (also printed by sessions --help).';
