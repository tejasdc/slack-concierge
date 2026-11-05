---
failure: Sessions stopped accepting work while startup recovery exhausted the server's memory.
date: 2026-11-05
fix_commits: []
cause_status: best-explanation
---

# Sessions queued while the owner froze

## What was seen

The server and Thinkering's web endpoint remained reachable, but the session owner stopped
answering its socket shortly after each restart. Its process used a full CPU core and grew
past 40 GB of resident memory. Accepted requests stayed queued. A deployment attempt also
waited on that owner and could not install a newer release. The last owner task before the
freeze was the Codex adopted-turn recovery loop. Open Codex conversations included rollout
files of roughly 181 MB and 69 MB.

## Cause

The installed recovery path requested `thread/read(includeTurns=true)` for every adopted
Codex turn, materializing whole conversations when it needed only one turn. This is the
best explanation for the memory growth; a live stack or heap attribution was unavailable
after the event loop froze. The deployment's "no verified last-known-good" message followed
an owner read timeout; the recorded installed release verified independently on disk.

## Fix

Recovery now pages turn summaries to identify the accepted turn and its status. It observes
live notifications while a turn runs and reads only that turn's persisted items after terminal
status. It keeps the exact provider turn and input identities and
continues to park an ambiguous turn if the provider refuses a required read.

Twelve adopted Codex requests had an admission intent but no recorded provider turn or
acknowledged input. This change preserves those requests as unresolved if no exact turn appears;
their same-session successors remain fenced. Their provider outcomes need separate evidence
before recovery can safely continue them. Unrelated queued sessions can progress once the owner
responds again.

## Acceptance scenario

- **Seed:** An adopted Codex turn in a conversation with hundreds of megabytes of earlier history and queued session requests.
- **Action:** Restart the session owner and let it reconcile the exact adopted turn.
- **Expected:** The owner reads summary pages and terminal item pages for only that turn, stays responsive, preserves the turn's outcome, and begins processing queued requests.
- **Replayable offline:** yes (a Codex App Server fixture can expose the full-thread read as a failure).
