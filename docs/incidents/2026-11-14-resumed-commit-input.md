---
failure: An update made during a resumed conversation linked to an earlier request.
date: 2026-11-14
fix_commits: []
cause_status: confirmed
---

# A resumed conversation retained its earlier commit input

## What was seen

Session `concierge:9724` was answering request `c2fa5a03-1102-4f3b-bfc5-fd7b0abbd761`, but unpublished Thinkering commit `4fd890a1ce52137bdef4915564df9b6d4deaae1a` carried input `0761b986-5148-4d3b-8f58-2f379c2013d5`. The reporting agent corrected that unpublished commit. This repair does not replay the earlier work.

## Cause

The SSH identity repair exported a per-turn commit input into Codex’s durable thread shell policy. Thinkering’s hook preferred that value over the source input. The existing opaque provenance hook already resolves Codex’s current running turn rather than trusting its persistent environment; the newer update trailers did not use that invariant. The negative control reproduces the stale trailer with the earlier hook even when the source input is current.

## Fix

The current owner resolves exactly one running accepted input at commit time. A local Codex conversation names the running turn; a server commit naming a Mac session asks that Mac’s live owner through the existing peer connection. Missing, ambiguous, mismatched and unavailable evidence refuses the commit. The durable Codex shell policy no longer retains the commit input. SSH configuration and historical accepted effects remain unchanged.

## Acceptance scenario

- **Seed:** One completed earlier turn and one running newer turn on the same Codex conversation, with stale exported commit and source inputs.
- **Action:** Commit through Thinkering’s real stamping hook, then repeat naming a Mac session with a stale transported input and an unrelated local Codex conversation.
- **Expected:** The first commit names the newer running accepted input. The second asks the Mac’s current session and ignores the server’s Codex conversation. Unknown or ambiguous identity leaves no new commit. The prior hook fails the negative control by stamping the earlier input.
- **Replayable offline:** yes (isolated owner ledger and substituted peer/router transport); actual resumed provider, authenticated peer transport and installed release acceptance remain separate live checks.
