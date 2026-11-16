---
failure: A brand-new Claude session's end-of-turn check let a fast first turn end without its owed reply.
date: 2026-11-11
fix_commits: []
cause_status: confirmed
---

# First-turn Stop check found no session

## What was seen

A marked test session (concierge:9409, Claude Haiku) was asked for work and told to end its
first turn with closing words only. The turn ended about a second after it started. Its Stop hook
ran for 27 ms and printed nothing, so the agent was not sent back. The request was not treated as
answered: the owner's stranded-run recovery sent a follow-up turn ("your end-of-turn check could not
send you back") and the agent then replied explicitly. The same session's second turn was sent
back correctly by the same hook.

## Cause

The hook identifies its turn by the provider conversation id. For a new Claude session the owner
learns that id from the CLI's output stream, which on a runner reaches the owner asynchronously.
A first turn that stops before that binding lands finds no session, so nothing is owed. The run id
the owner assigned before launch was already in the agent's environment but was not sent.

## Fix

Claude's hook sends its launched run id. When no running session matches the conversation id, the
owner finds the running turn by that run id, only for a session with no recorded conversation yet.
Codex's shared App Server environment is not per run, so Codex keeps the conversation lookup; its
thread id is reported before the turn starts.

## Acceptance scenario

- **Seed:** A new session with a delivered work request and no recorded conversation id.
- **Action:** Ask the owner what is owed with an unknown conversation id and the turn's run id.
- **Expected:** The request is listed. Without the run id, nothing is listed. Once the session has
  its own conversation id, a run id alone no longer speaks for it.
- **Replayable offline:** yes (`bot/tests/native-communication.test.ts`, "a first turn whose
  conversation id is not yet recorded is still held to its reply").
