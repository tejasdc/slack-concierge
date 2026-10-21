---
failure: The first freeze notice blamed a page for a 61-second freeze that was caused by Concierge's own background work.
date: 2026-10-08
fix_commits: [c78a1ea2]
cause_status: confirmed
---

# Freeze notice blamed a page that was not the cause

## What was seen

The first live freeze notice from the new responsiveness watch (06:12 UTC on 2026-10-08) said the freeze
involved "another page (1 slow, 0 seconds)" for a 61 s freeze. The freeze was background work; the named page
took no measurable time. The notice pointed whoever read it at the wrong cause.

## Cause

Confirmed from c78a1ea2. `owner-responsiveness.ts` (added hours earlier in b81b99dd) named any request that was
slow during the freeze window, regardless of how much of the frozen time it accounted for. A request that
happened to overlap a background freeze was reported as the culprit.

## Fix

c78a1ea2: requests are named only when they account for at least a quarter of the frozen time; otherwise the
notice says Concierge froze on its own work.

## Acceptance scenario

- **Seed:** a freeze episode of 60 s of loop lag with one completed request of a few milliseconds inside it.
- **Action:** the responsiveness watch files its notice.
- **Expected:** the notice says background work, not the page; with a request whose duration covers at least
  25% of the frozen time, the notice names that page.
- **Replayable offline:** yes (feed synthetic lag and request-timing events to the watch)
