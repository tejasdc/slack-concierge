/**
 * The request protocol as agents are taught it: the commands only. It is read once per run in the
 * session instructions (and printed by `router-actions.sh sessions --help`); requests point at it.
 * The rules are not taught by repetition but enforced where they apply: the Stop hook every Claude
 * and Codex agent runs sends it back when it tries to end a turn owing a reply, and the owner
 * reports a stall (docs/plans/2026-09-23-request-reply-protocol.md).
 *
 * It follows the FIPA Request Interaction Protocol (request; optional agree; then exactly one of
 * failure, inform-done or inform-result; cancel at any point), with one act FIPA lacks,
 * needs_decision, because a person, not the requester, must sometimes choose.
 */
export const REQUEST_PROTOCOL = [
  'Requests (sessions ask / sessions reply): close every request you receive with one final sessions reply <id>, which for a work request carries --work-disposition completed, failed or needs_decision; --partial reports progress without closing it. When one answer covers several requests from the same requester, reply to each with the identical words and disposition; the requester receives it once.',
  'Nothing else closes a request: if you try to end a turn still owing one, you are sent back with the command, and if you end anyway the requester is told it stalled.',
  'Results of requests you send come back to you on their own, once each; do not poll. sessions cancel <id> withdraws one.',
].join(' ');

/** The pointer every other agent-facing text uses instead of restating the protocol. */
export const REQUEST_PROTOCOL_POINTER = 'Follow the request protocol in your session instructions (also printed by sessions --help).';
