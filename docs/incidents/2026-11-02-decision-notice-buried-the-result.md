---
date: 2026-11-02
failure: A needs-you phone notice opened with an unrelated paragraph; the result and the choice he had to make were past what the Lock Screen showed.
fix_commits: []
cause_status: confirmed
---

# A decision notice buried the result

## What was seen

At 22:27:21Z the Chelsea Piers booking session (concierge:7721, Sonnet 5) closed request
8c98b03c as `needs_decision`. Its whole 729-character reply became the question text and,
verbatim, the phone notice body. It opened with an unsent membership email ("Closing the loop:
the messaging agent confirmed..."); the class result (not cancelled, inside the one-hour
cutoff) and the optional front-desk choice came only in paragraph two. Tejas did not learn
the class result from the notice. Reported by an agent on 2026-11-04.

## Cause

A decision's notice body is the question text as recorded, and the owner built it from the
agent's whole text. Commit 5b426fa5 (same day as this report) made the Inbox filing of a
`needs_decision` reply lead with the reply's required one-line `--summary`
([its record](2026-11-02-class-result-buried-in-notification.md)). Still unshaped: a
`needs_you` turn outcome (no summary existed for it), a decision returned to a non-Inbox
requester, and a Mac worker's need, which all used the whole text.

## Fix

`sessions outcome needs_you` requires `--summary`, the same one line replies carry, and the
owner places that line first in every recorded question: the reply's and outcome's question
text, the requester's returned decision, the Inbox worker filing and a Mac worker's need.
One line serves every path instead of a second field next to the summary.

## Acceptance scenario

- **Seed:** a work request to an agent session; Tejas's words available for --his-words.
- **Action:** the agent declares `sessions outcome needs_you` without `--summary` (refused, naming it), then replies `needs_decision` with text opening on unrelated news, with `--summary "Class was not cancelled (inside the 1-hour cutoff): ask the front desk to waive the fee?"` to a non-Inbox requester.
- **Expected:** the first is refused naming `--summary`; the requester's question, attention item and notice body begin with that line.
- **Replayable offline:** yes
