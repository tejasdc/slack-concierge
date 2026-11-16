---
failure: Questions and their saved answers disappeared from global discovery after the Inbox changed agents, while some dispatched questions had no prompt answer clock.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Missing answers across Inbox changes

## What was seen

The final passage of human capture
`c44ca2e91fe5a270d59ca55f5580dd7d62cf4d63ac627acc75c0273e01900fd7`
asked to recover unanswered questions from yesterday/day before and make meaningful delays
visible for requested answers/actions. Other goals in that capture remained separate work.
Outside investigator `concierge:9767` traced the supported Nov13 05:00Z–Nov15 05:00Z window:
102 human inputs, six bug reports, 65 distinct direct/obligation-linked requests and 88 exact
request/post pairs. All 88 original post identities and author-request identities were read
successfully. Four requests had no linked Inbox post; that fact alone does not establish a
missing reply when the original human conversation was a direct session.

Global Asked returned only a new question while an exact older-topic read returned
`q:158a5029-0c5d-498f-be18-ed469c8b5040`. Its canonical topic retained its historical Inbox
and its accepted work. The Nov13 shortcut complaint's first retained thread response was
83m16s after its source; its exact response text was recovered, but this is not a provider
execution measurement or evidence of phone delivery. Spotify and Mac-helper work retained
their original real sign-in/device dependencies; neither was replayed.

## Cause

Prepared topic rows used the current Inbox context, but prepared question rows/counts used
the topic's original Inbox session. Global Questions selected only the current partition.
The November shared Inbox-lineage contract therefore outgrew the October prepared-question
partition assumption. Existing growth checks modeled one Inbox and missed the transition.

Only directly forwarded human replies set the prompt-answer flag. Inbox-dispatched questions
could accept an answering partial but their explicit asked-question linkage did not arm the
same clock. The diagnostic window separately counted any linked post as an answer, hiding
the difference between progress, service notices and semantic replies. These are proven
source defects; they do not establish that every reported missing answer had the same cause.

## Fix

Prepared global questions and counts use the active verified Inbox context while preserving
historical canonical ownership. The bounded worker refreshes retained question projections on
upgrade. Canonical and prepared asked reads share exact answer matching, including a unique
legacy source-to-obligation-to-dispatch relation, and publish one owner-derived wait/delay text.

An accepted asked question arms the existing exact request clock. Existing answering evidence,
original request time and terminality win over reconciliation. Peer late-clock admission is
an idempotent command on the already-accepted request, guarded by authenticated peer and exact
original source identity. Its receiver reuses the existing reminder, not a second task or timer.
Diagnostic reads retain reply-kind and receipt facts and stop calling progress an answer.

Recovered answers are linked in the existing complaint thread under their original identities.
No original work, song save, message send, capture, notification or device operation is repeated.
Passive collection remains outside answer-clock and phone-notification classification.

## Acceptance scenario

- **Seed:** Two successive Inbox agents, an untouched historical asked question and its exact
  obligation/dispatch, ordinary passive work, and original answer/progress records.
- **Action:** Switch Inbox, declare/link the exact asked question after dispatch, advance the
  existing two-/three-minute clock, record progress then an answering partial, and restart.
- **Expected:** Historical question remains globally findable with exact counts; original
  answer appears under its original identity; only the asked request is reminded once; no
  timer post or phone notice; prompt wait ends while work remains open. A peer command with
  another source is refused; a repeated valid one cannot duplicate the reminder.
- **Replayable offline:** yes. `bun bot/scripts/asked-answer-fixture.ts`,
  `bun bot/scripts/agent-report-reads-check.ts`, and the existing
  `bun bot/scripts/topic-projection-fixture.ts` exercise the boundaries. Restoring the old
  question partition or progress-as-answer predicate makes the corresponding check fail.

Source checks and isolated native checks are distinct from installed API/browser observation,
push transport acceptance and physical Mac/iPhone acceptance. Release and observation evidence
belongs to the retained repair request; no physical-device success is asserted here.
