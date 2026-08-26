# Native Agent progress without expiring streams

Approved scope: replace new turns' streaming progress with native Block Kit replies
updated in place. Continue in another reply in the same thread only when a payload
fills. Preserve text-separated activity cards, plan progress, provider duration,
redaction, native Agent status/Stop, separate final delivery and cumulative summary.

## Ownership and state contract

The existing turn coordinator owns the provider and terminal ordering. The progress
controller remains the sole event reducer/coalescer. Its transport projects ordered
chunks into bounded message pages, with one SQLite row per actual/planned reply.
Each row holds desired content, its exact Slack timestamp, and creation intent.
Persist content before writes. Updates of known messages are replayable; a post
whose outcome is unknown is parked, never blindly repeated. Seal an old page before
publishing its successor. Stop binds to the current owned turn and Slack event time,
not the list of streams or the current continuation timestamp. The first reply
timestamp is the stable turn boundary; stale events cannot stop a successor.

Retain the old progress_stream_* columns as lifecycle/first-message identity for
compatibility with existing recovery and old persisted streams. Page rows identify
the new transport. No historical message backfill. Old streams are only finalized
by the compatibility path; new turns never start streams.
Initial page intent and the starting transition commit atomically. Recovery
requeues provably unattempted pending pages before provider admission, atomically
resetting their old activity snapshot. A posting page, or a historical starting
stream without page rows, remains ambiguous and is not repeated.

## Cost and boundaries

Work is event-driven: one coalesced current-page reduction per flush; one full
message update per affected page, and one post per continuation. Each payload is
bounded by Slack's 12,000 cumulative Markdown characters and 50 input blocks.
Rows grow with the replies actually required by the user's commentary, not with
tool events; task updates replace values. Dirty-page lookup is indexed per turn,
and current-page lookup is indexed by turn/page, never a fleet/history scan.
Rows follow turn retention through cascading deletion. No idle progress work.
The existing 45-minute status renewal runs only while a turn is processing, one
call per active turn per interval, because Slack's one-hour status lease requires
renewal. Terminalization stops and awaits it.

## Verification contract

Pure pagination tests cover exact limits, Unicode, ordering, activity reuse,
continuations and terminal cards. SQLite/transport tests cover durable intent,
ambiguous posts, replayable updates, retry/recovery and stable turn identity.
Stop tests cover empty stream lists, stale/duplicate events, wrong threads and
Stop versus delivery. Native payload preflight checks task cards plus Markdown,
whole-message replacement and conversion expansion. Focused/full tests and one
independent actual-diff review gate integration. No service restart/deploy waiting;
post-deployment UI click proof is explicitly reserved for a later user turn.

Native preflight evidence (2026-08-26): native task cards plus Markdown can be
posted and updated at the same timestamp. Markdown translation can make a
50-input-block payload exceed the rendered block cap; explicit rejection is
handled by partitioning, never by retrying an ambiguous post. An isolated live
run created three progress pages, carried and updated the plan, then updated it
again after six minutes: Slack still reported `processing` and `is_stoppable`.
All four temporary messages (root and three replies) were deleted afterward.
No real native Stop click or deployed Concierge UI is claimed verified by this
API probe; handler/provider cancellation is exercised through focused tests.
A second native probe exercised rendered-block overflow through the actual page
projector, producing a fourth continuation page and preserving the updating plan
and processing/stoppable session. Its five temporary messages were also removed.
Progress-message writes use a dedicated SDK client with the existing credential,
automatic transport retries disabled, and rate-limit rejection surfaced to the
existing limiter. An in-memory SDK HTTP-500 adapter test proves that even a Retry-After header
does not cause an ambiguous post to be repeated.

Local validation: the full suite passed 605 tests before the final recovery
correction. After that correction and integration of concurrent attachment/router
changes, 58 focused execution, dispatch, recovery and progress tests passed; the
445-module production build and documentation-link checks also passed. Recovery
coverage includes unattempted starts, atomic initialization rollback, attempted
posts, and historical stream ambiguity. No service deployment or post-deployment
UI verification was performed in this implementation turn.
Independent actual-diff review returned `SHIP` after the recovery and test
portability corrections; its final targeted run passed 32 tests.

Sources: https://docs.slack.dev/ai/agent-sessions/,
https://docs.slack.dev/reference/events/agent_session_stopped/,
https://docs.slack.dev/reference/methods/chat.update/,
https://docs.slack.dev/reference/block-kit/blocks/markdown-block/,
https://docs.slack.dev/reference/block-kit/blocks/.
