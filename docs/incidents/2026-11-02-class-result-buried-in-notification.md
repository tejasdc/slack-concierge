---
failure: An agent's answer reached his phone opening with unrelated background, so "class not cancelled" was hidden in the notification's second paragraph.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# The class cancellation result was buried in the notification

## What was seen

At 5:27:21 PM ET the Chelsea Piers agent answered the "cancel the class, not the membership"
request with a needs-a-decision reply. Apple and Web Push accepted the notification, but its
729-character body began with the unsent membership email; the result (class not cancelled,
inside the one-hour cutoff) appeared only in the second paragraph. Seven seconds later the same
agent handed the request back, which settled the decision and withdrew the notification at
5:27:49. Tejas asked "Why was I not informed?". Agent report capture
`e4a3c14f2a2eb7b77d4e0cdc6d9138bd05c69d5e4d6591f6edfe47b1fd2773f4`.

## Cause

Filing an agent's answer into an Inbox thread built the Needs you item and the notification body
from the reply's first words. The reply's one-line summary, which the reply command requires and
describes as "shown first to the reader", was never passed to the filing, so what he read first
depended on how the agent happened to open its message.

## Fix

Server and Mac answers carry the reply's summary into the filing. A decision's text and a
requested result begin with the summary (unless the body already does), and a reading item's
headline is the summary. The early withdrawal by the same agent's later hand-back is the existing
rule that a decision belongs to the agent that asked; the item stays in his Notifications page.

## Acceptance scenario

- **Seed:** an Inbox thread with an open request to an agent.
- **Action:** the agent replies `--work-disposition needs_decision --summary "Class not cancelled: inside the 1-hour cutoff"` with a body that opens with other background.
- **Expected:** the thread's Needs you question text and the notification body both start with "Class not cancelled: inside the 1-hour cutoff".
- **Replayable offline:** yes (state copy with `CONCIERGE_STATE_DIR`).
