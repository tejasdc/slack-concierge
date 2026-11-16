---
failure: A bound test-session read refused for "other authorship" and nothing could say which input caused it, so its creator could not continue.
date: 2026-11-16
fix_commits: []
cause_status: best-explanation
---

# A bound read refused for changed authorship with no way to see why

## What was seen

Creator session 8754 held the exact create request for test session 9825. Its bound read was
refused twice with AGENT_TEST_SCOPE_CHANGED before any browser or handoff action. The refusal
names no input, and the owner's only authorship check was a yes/no query, so the rejecting input
was never identified. A service-written lifecycle input is a hypothesis, not an observation.

## Cause

Best explanation: the guard asks only whether any input fails its predicate, and a later admitted
run of the creator cannot satisfy the guard's historical pair match anyway. Nothing exposes the
first rejecting input.

## Fix

`router-actions.sh sessions agent-test-scope concierge:<id> --create-input request:<uuid>` returns
metadata only (input id, kind, origin, source pair and request id, a fixed reason, and the
source's relation to the target) for the first input the guard's own predicate rejects, plus the
count of rejecting inputs. It reuses the guard's single predicate text, runs the existing current
actor and handoff-fence checks, and is disclosed only to a current run of the session that created
the target. The guard and its errors are unchanged; the command opens no content, gives no clean or
allowed verdict, and reports a missing witness as "none rejecting now".

## Acceptance scenario

- **Seed:** a test session that later gained one human-origin input.
- **Action:** the creator's current run calls the command; another session calls it.
- **Expected:** the creator gets that input's metadata only; the other session is refused; the bound read still refuses.
- **Replayable offline:** yes
