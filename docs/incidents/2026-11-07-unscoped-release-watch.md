---
failure: Unrelated Concierge releases repeatedly woke the Echo acceptance agent.
date: 2026-11-07
fix_commits: [ae8caad4e09f51d1293ac31879daf238865762af, 6a3c55734aab4657a12a6c1bbb0b47adbafc02fd, 1e8f7711d16e699d73a3398d6a21a42f0d796e68]
cause_status: confirmed
---

# Unrelated releases repeatedly woke Echo acceptance

## What was seen

On November 6–7, 2026, the Echo Inbox Drop acceptance session reported more than twenty
wakes from its renewing watch on Concierge's current-release link while the Echo question
repair remained an unmerged draft. The acceptance request stayed open and each release
produced another agent turn to recheck the same unchanged installed rule and capture record.

## Cause

The watch correctly detected link swaps, but its condition identified only a path. It had
no target repair identity, so every Concierge deployment satisfied it. Earlier repairs
made watch renewal durable, associated an outside request with its exact watch, and
stopped renewal after all named requests closed. Those guards did not distinguish one
release from another while a request remained open.

## Fix

The scoped condition names a full target commit. The owner compares it with the installed
manifest's commit ancestry and the successful receipt for that exact release artifact.
Unrelated releases advance the file baseline without generating a turn; an activation not
yet confirmed retains the old baseline; a request-bound series closes quietly after its
requests close. The requesting agent must replace its earlier unscoped watch with the
scoped one after this behavior is installed.
Git's definite non-ancestor result is the only reason to advance the baseline; an ancestry
error retains it and is retried. This rule was added after review found that an unreadable
repository during the target release could otherwise silence the watch indefinitely.
A second review (November 11) found that the renewed successor rechecked the same installed
release at registration and fired again every poll; a scoped watch now ends its series when it
fires. A target commit missing from the deployment clone is classified as absent, so a draft that
was never fetched no longer retries Git and logs a warning every five seconds.
The first live check after installation (November 11) found registration refused every agent:
server agents run on the AX41 runner, and the scoped rule refused any runner. The owner now
evaluates a scoped watch on its own machine regardless of the registering agent's runner.

Evidence: the exact issue report in topic `topic:511b909c-6800-4522-82bf-781dc6e6c8be`,
the Echo acceptance session `concierge:9096` and its November 7 partial naming watch
`3b689d2a74bd`; prior watch fixes in PR #478 and the November 6 outside-watch repair.

## State card

- Entity and writer: one durable watch series, mutated only by the Concierge owner.
- Identity: the source input and action ID identify registration; the full target commit is part of
  the immutable condition; a request binds to the series through an exact watch ID.
- Acceptance: a watch receipt proves registration. A successful release receipt for the linked
  artifact plus ancestry proves installation. Delivery of the fired event wakes the agent;
  the agent still checks the product behavior before closing the request.
- Lifetime: the owner keeps the watch through restarts and silently extends its deadline while
  the target is absent; all bound requests closing ends the series.
- Old readers: existing unscoped watches keep their path-change and deadline behavior; the new
  condition lives in the existing stored JSON.
- Failure trace: an unscoped watch is registered, an unrelated release swaps the link, the owner
  fires and renews the watch, the answer is delayed or the owner restarts, then the Echo agent
  receives the durable event and spends a turn rechecking unchanged work.

## Acceptance scenario

- **Seed:** Register a renewing scoped watch for repair commit A and bind an open request; the
  installed release is commit B, which does not include A.
- **Action:** Install another release without A, then a successful release whose commit descends
  from A; repeat with the request closed before the final installation.
- **Expected:** The first release causes no agent turn and preserves the watch. The successful
  descendant produces one wake. A closed request ends its watch quietly. Generic file watches
  still fire for a file change or deadline.
- **Replayable offline:** yes, with a disposable owner ledger, release manifest and Git graph.
