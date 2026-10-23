---
failure: Captures made during a writing Focus session still became Inbox topics and agent work.
date: 2026-10-23
fix_commits: []
cause_status: best-explanation
---

# Focus captures started Inbox work

## What was seen

During a writing day, Tejas sent 35 captures that the Inbox owner placed into 24 topics in
one measured window, including captures made while Focus was on. A separate device and
usage review of 3 PM to 12:40 AM found seven Focus sessions, 39 captures, 44 router
dispatches to 22 agent sessions, and about 26 Inbox sends within Focus; its window and
counting method differ from the Inbox owner's. Tejas described the resulting topics as
filling his working memory while he tried to write. These historical inputs remain where
they were accepted; this change does not replay or move them.

## Cause

The existing cloud Focus lease held new Inbox router turns in the execution queue for at
most 15 minutes. It did not make capture admission a separate durable review state.
When the lease ended or expired, waiting router work became eligible automatically.
The two measurements alone do not prove which individual dispatch followed a lease
expiry, an earlier running turn, or another entrance; the missing admission hold is the
confirmed product boundary that allowed the observed class of interruption.

## Fix

An updated Focus client opts in to durable capture review on each lease renewal. The
accepting Concierge owner keeps each new ordinary capture's words, attachment custody,
source and exact addressed target without creating a provider turn, Inbox event or
attention notice. The capture remains held after Focus ends until Tejas selects it for
release. An explicit human choice of data-loss or medication urgency bypasses the hold.
The legacy Thinkering gateway persists that choice and a capture-time review decision
before forwarding, so delayed delivery keeps its meaning. A Mac-owned addressed reply
is held and reviewed on the Mac owner. Older Focus clients retain the prior queue-only
behavior until the thnkr.ing review surface is installed.

## Acceptance scenario

- **Seed:** In a scratch owner, start an opted-in Focus lease and prepare an ordinary
  capture with words and an attachment, plus an addressed Capture bar reply.
- **Action:** Accept both, retry their exact IDs, end the lease, read the held page, then
  release only the selected IDs with one stable action ID and retry that action.
- **Expected:** Acceptance returns a held receipt and retains the same bytes and IDs;
  no provider turn, Inbox event or attention notice exists before release. Lease end
  leaves both held. One selected release creates one canonical queue turn or exact
  addressed delivery per capture, and its retry creates none. An urgent medication
  capture may enter the router during Focus, while an active session still excludes a
  second claim. A Mac-owned addressed reply remains locally held until the cloud lease
  clears.
- **Replayable offline:** yes (the Focus capture admission and prepared-reader fixtures
  run in a private scratch state as part of the candidate release check).
