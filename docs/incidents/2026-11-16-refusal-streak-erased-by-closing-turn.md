---
failure: A Codex session that never took its input (concierge:8245) was not flagged as unable to take messages.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# The refusal streak keyed on text that closing a turn erases

## What was seen

After the three-in-a-row refusal flag shipped (PR #935), concierge:8245 still showed
messageableForAgents:true although its Codex transcript showed turns starting and completing within a
second at 07:06, 07:08 and 11:54 with no user message recorded.

## Cause

The streak required a parked turn whose text began CODEX_INPUT_NOT_ACKNOWLEDGED:. Closing a turn
overwrites that text with the closing reason, and cancelling a request retires its turns as cancelled,
so the evidence was erased. The provider turn id and the acknowledgement time are not rewritten by
closing, and every provider records acknowledgement.

## Fix

The streak now reads terminal turns (done, parked, error, cancelled) and decides on durable columns:
acknowledged breaks it, unacknowledged with a provider turn (or the original text) and no Stop counts,
and everything else is skipped. SQL filters first, so a healthy session still reads three rows.

## Acceptance scenario

**Seed:** a Codex session with three cancelled turns that each have a provider turn id, no acknowledgement
and an overwritten closing text; also a turn with no provider turn id, a turn stopped before acknowledgement,
and three older acknowledged turns behind the three newer refused ones.

**Action:** build the session view (search or context).

**Expected:** messageableForAgents is false and inputRefused counts three; the never-reached and stopped
turns are skipped; the older acknowledged turns do not hide the streak; one newer acknowledged turn clears
it. Replayed by input-refusal-streak-fixture. Not checked live on 8245 by this change.
