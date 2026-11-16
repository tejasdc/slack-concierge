---
failure: Google refused work for quota all day, and each refusal ended its request for good instead of waiting for the reset or moving to an agent with room, while work kept being sent to the spent account.
date: 2026-11-12
fix_commits: []
cause_status: confirmed
---

# Twelve Google turns ended on "Individual quota reached … resets in 31h"

## What was seen

On 2026-11-12, from 11:43 AM New York time, Concierge's Google reading showed every allowance at
100% (Gemini weekly, Gemini 4 Argon weekly). Sessions already bound to Google (the Inbox router
continuation on Gemini Flash, an hourly read-only watch, a marked Google test session on Argon
Medium) kept being launched. Every launch was refused with "Individual quota reached … Resets in
31h", and each turn ended as a terminal error (12 turns between 18:40 and 19:12 UTC).

## Cause

1. Google's stream for a refused run now carries a `system_message` step besides the
   `error_message` step. The Google adapter reported every step other than a reply or user input
   as tool activity, so the turn runner counted the refusal as worked-on and ended it. The
   2026-10-31 fix had excluded only `error_message` by name.
2. A refusal after real work (the Inbox router's run, 43 million tokens in) was not marked as a
   confirmed provider end and its wording was not classified as a usage refusal, so it got no
   continuation either.
3. Nothing checked Google's own spent reading before launching a turn for a session already
   bound to Google; only automatic placement of new sessions read it.

## Fix

- Only a `tool` step counts as agent work; every other Google step is provider bookkeeping.
- A Google quota refusal is a confirmed end at any point: before work it waits or moves, after
  work it continues at the reset.
- Before launching, a turn whose model's allowance the fresh Google reading shows spent is
  refused with that reset, taking the same move-or-wait path without calling Google.
- Google's quota wording has one home shared by the adapter, the turn runner and the
  continuation classifier.

## Acceptance scenario

- **Seed:** Google's reading for the selected model shows 100% used with a future reset; a session
  bound to Google has queued work.
- **Action:** the queue dispatches that turn.
- **Expected:** no Google process starts; the turn waits in its queue until the reset (or, for an
  automatically placed first turn, moves to Claude or Codex with the same request); the request
  stays open.
- **Replayable offline:** yes, with a stored spent Google reading and a stand-in Google CLI.
