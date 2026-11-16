---
failure: A no-reply release watch required an unwanted Inbox thread post before its turn could end quietly.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# No-reply release watch required a thread post

## What was seen

A release-watch service input said, “You do not need to reply to this.” After the Inbox router reconciled it, the owner refused a quiet `done` outcome until the router posted into the thread. The router made one bookkeeping post, then ended the turn. The retained report is capture `06ea55aa870b96f52cf0327862b6a80dd88391c228fe134a7e1c1323b10d6426`.

## Cause

The watch delivery was admitted as a service input without the no-reply mark already used by thread upkeep. The thread obligation therefore treated its source thread as waiting for a post. The message's words alone do not waive that obligation.

## Fix

New watch deliveries explicitly carry the service-only no-reply mark. The owner retains the watch text, including observation gaps, while allowing the reconciled turn to declare `done` without a thread post. Agent requests and ordinary service returns still owe posts.

## Acceptance scenario

- **Seed:** Register a marked release watch for an Inbox session in a thread, then let it fire after a release change.
- **Action:** Reconcile the delivered service input and declare `done` without posting.
- **Expected:** The installed owner accepts quiet `done`; the thread gains no bookkeeping post; the retained watch message still reports any observation gap; an ordinary agent return in a thread still owes its post.
- **Replayable offline:** yes (with a local owner ledger and controlled file watch).
