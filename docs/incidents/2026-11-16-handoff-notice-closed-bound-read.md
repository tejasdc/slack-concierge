---
failure: After a test session handed its work off, its own closing handoff notice made its creator's bound read refuse as "other authorship".
date: 2026-11-16
fix_commits: []
cause_status: best-explanation
---

# The owner's closing handoff notice counted as another author

## What was seen

Creator 8754's bound view and receipts of test session 9825 returned HTTP 200 before 9825 handed its own work off (accepted handoff 7697a4ab to session 9935). The creator-only diagnostic afterwards reported complete coverage and exactly one rejecting input: the service input `handoff-notice:7697a4ab-…`, same-target source, reason origin_not_agent. No content was read after that.

## Cause

Best explanation, from source reading (no runtime probe): the owner writes one closing notice into the superseded predecessor (the only writer of that scope is the owner's handoff-notice function). It names the predecessor's active input and run, not itself, so the earlier own-notice exemption did not match, and the guard rejected every other non-agent input. Returns also name a same-session source but carry other agents' words, so "service with a same-session source" cannot be the rule. The ChatGPT Pro consult a6df74d7 (source inline, read as shown by its section list) assessed the same cause and recommended the repair below; it did not review the code.

## Fix

The shared guard/diagnostic predicate also accepts a service input of kind input with action `notice`, no request, whose id and scope equal `handoff-notice:` plus an accepted handoff whose predecessor is this session, and whose source input and run are held together by one turn of this session. Proposed or withdrawn handoffs, another session's handoff, a bare prefix or a mismatched pair do not qualify. No schema, marker or rewrite of the stored input.

## Acceptance scenario

- **Seed:** a predecessor test session holding only its own accepted-handoff closing notice.
- **Action:** the creator's current run reads it through the bound route; a human input is then added and the read repeated.
- **Expected:** the first read is not refused for authorship; after the human input it is, and the diagnostic names that input.
- **Replayable offline:** yes
