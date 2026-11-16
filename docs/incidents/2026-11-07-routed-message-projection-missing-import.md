---
failure: Every session event-stream page that contained a routed Inbox message failed with a runtime reference error, so live session updates stopped at that message.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# Live session updates stopped at a routed Inbox message

## What was seen

From 05:22Z on 2026-11-07 the installed read worker logged
`ReferenceError: getAcceptedSessionInput is not defined` on every event-stream page read
(2,025 times in the 50 minutes after the 06:32Z restart alone). The owner's event stream
answered 500 to each consumer, logged `session_event_stream_failed`, and closed the stream;
consumers reconnected every five seconds and failed on the same page. Thinkering's live
session view and any agent watching session events could not advance past the sequence that
held the routed message.

## Cause

Commit 3468b638 (2026-11-06, "Preserve corrected authorship across Inbox routes") made the
history projection look up the routed message's original accepted input, but added the call
without importing the function from the session-inputs module. The release build bundles with
`bun build`, which resolves imports but never checks free identifiers, so the undefined name
shipped and threw on the first routed message a page contained. The same class of fault
shipped the day before (`ProviderDispatchError`, docs/incidents/2026-11-06-provider-dispatch-error-unbound.md).

## Fix

Import the function. Add `bot/scripts/undefined-name-check.ts` to the release build: it runs the
pinned TypeScript compiler over the same entry points the bundler ships and refuses the build on
"cannot find name" diagnostics (TS2304, TS2552) only, so the gate is exact while the rest of the
codebase does not typecheck whole. On the broken tree it named this exact line; on the fixed tree
it passes for all twelve bundles in about eight seconds.

## Acceptance scenario

- **Seed:** A session holds a routed Inbox message (an accepted input whose payload carries
  `routedFrom.originalText`).
- **Action:** Read the event-stream page that contains that message.
- **Expected:** The page returns the message with its routed author; no reference error, and the
  stream continues past it.
- **Replayable offline:** yes; the build gate also replays the cause: remove the import and
  `bun run scripts/undefined-name-check.ts` refuses the build naming the line.
