---
failure: Retained Gemini Takeout evidence could not appear in Concierge session search or history.
date: 2026-11-25
fix_commits: []
cause_status: confirmed
---

# Gemini Takeout missing from Concierge

## What was seen

Thinkering could retain a Gemini Apps Takeout import, while the Concierge source
reader refused its Gemini provider identity.

## Cause

The common reader and archive session materializer admitted only existing provider
IDs. The Gemini export contains historical evidence and has no provider runtime binding.

## Fix

Keep the Gemini identity on a read-only archive session and reuse the exact source
reader. Route a new coding session through ordinary admission only after rereading
the exact source and validating the trusted adapter's complete dialogue proof.

## Acceptance scenario

- **Seed:** Isolated owner and source stores with synthetic grouped and ungrouped Gemini Apps activity.
- **Action:** Import the bytes, search each record, read its exact history, then request a new session from each source.
- **Expected:** Search returns pinned Gemini evidence. Both current export forms refuse new session creation with no queued turns. A verified adapter fixture permits one new queued session and one reusable receipt.
- **Replayable offline:** yes. Run `bun bot/scripts/gemini-takeout-owner-fixture.ts <absolute built Thinkering release>`.
