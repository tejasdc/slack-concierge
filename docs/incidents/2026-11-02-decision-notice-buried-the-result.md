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

A `needs_decision` reply and a `needs_you` outcome had no field for the line he decides
from: the owner prepended the agent's whole text to his words and the reason they leave it
open, and thnkr.ing shows the question as given. Inbox thread questions already had a separate
`decision` line used as the notice body; replies and outcomes did not.

## Fix

Both now require `--decide`, one line (four words to 240 characters) saying what he must
decide and the result it depends on; the owner puts it first. A missing, multi-line, overlong
or fragment line is refused with the instruction to add it.

## Acceptance scenario

- **Seed:** a work request to an agent session; Tejas's words available for --his-words.
- **Action:** the agent replies `needs_decision` with text opening on unrelated news, first without `--decide`, then with `--decide "Class was not cancelled (inside the 1-hour cutoff): ask the front desk to waive the fee?"`.
- **Expected:** the first reply is refused naming `--decide`; the second records a question, attention item and notice body that begin with that line.
- **Replayable offline:** yes
