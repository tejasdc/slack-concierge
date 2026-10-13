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
  'Requests (sessions ask / sessions reply): close every request you receive with one final sessions reply <id>, which for a work request carries --work-disposition completed, failed or needs_decision; --partial records progress without closing it. When Tejas asks in an Inbox thread, answer him there promptly even while work continues: sessions reply <id> --partial --answers-question -- <answer> records that answer and posts it in his thread. A progress-only partial does not settle the prompt-answer obligation; the owner reminds you after two minutes and marks it overdue after three. After that prompt answer, close the same request with a final reply and no body: its disposition and checked/not-checked facts appear beneath the existing answer. A final body is for new words and is posted as written; do not repeat the prompt answer. A bodyless final is refused unless that request already has a prompt answer. Other partials wake nobody (the requester reads them with sessions get; in an Inbox thread Tejas reads the summary on the Brief row). Every ask and every final reply carries --summary "<one line>", shown first to the reader. When one answer covers several requests from the same requester, send it once with --also; the requester and thread receive it once.',
  'A needs_decision approval question is allowed only when a permanent decision record expressly requires his approval for the named action. Cite it with --only-he-can approval --decision-id <id> --approval-action <covered action>, plus --his-words and --why-not-answered. The owner checks the installed record and action scope; other permission questions are refused.',
  'You judge whether a work request fits you: when it is not your subject, or you are too loaded to do it well, hand it back with --work-disposition failed --hand-back not-my-subject|too-loaded and say what context you can give; the requester then starts a fresh session that can ask you.',
  'Nothing else closes a request: if you try to end a turn still owing one, you are sent back with the command, and if you end anyway the requester is told it stalled.',
  'Results of requests you send come back to you on their own, once each; do not poll. sessions cancel <id> withdraws one.',
].join(' ');

/** The pointer every other agent-facing text uses instead of restating the protocol. */
export const REQUEST_PROTOCOL_POINTER = 'Follow the request protocol in your session instructions (also printed by sessions --help).';
