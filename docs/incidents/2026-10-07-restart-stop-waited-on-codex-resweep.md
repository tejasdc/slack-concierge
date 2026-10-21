---
failure: Each update restart took a minute or more to stop, leaving his threads unable to reach the server, because shutdown waited for a full re-check of every Codex conversation.
date: 2026-10-07
fix_commits: [f9aae3a6]
cause_status: confirmed
---

# Update restarts sat for a minute waiting on the Codex conversation sweep

## What was seen

The back-to-back update restarts at 20:05 and 20:07 EDT on 2026-10-07 took 60-94 s to stop, about 50 s of it
waiting on the Codex session observer. During that time his threads showed they could not reach the server.

## Cause

Confirmed from the commit. On every start `CodexSessionObserver.subscribeCurrentBindings`
(`bot/src/codex-session-observer.ts`) resumes each bound Codex conversation one at a time (`thread/resume`,
about 300 conversations, a minute or more). Drain awaits `codexSessionObserver.stop()`, and the loop never
checked whether the observer had been stopped, so a restart that came during or soon after a start waited for
the whole sweep to finish.

## Fix

f9aae3a6: the sweep checks `this.stopped` before each conversation and returns as soon as shutdown has begun.

## Acceptance scenario

- **Seed:** an owner with a few hundred bound Codex sessions and a stub App Server that answers each
  `thread/resume` after ~200 ms.
- **Action:** start the owner, then send SIGTERM while the sweep is in progress.
- **Expected:** the observer stops within one resume of the signal and the drain completes in seconds, not
  after the full sweep.
- **Replayable offline:** yes (stub App Server client; scratch ledger with synthetic bindings)
