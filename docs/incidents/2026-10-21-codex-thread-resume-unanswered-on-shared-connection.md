---
failure: One Codex conversation refused every input because the App Server's answers about its history contained a paragraph-separator character that Concierge's line reader broke apart and discarded.
date: 2026-10-21
fix_commits: [c228ee8c, a82ad7d9]
cause_status: confirmed
---

# A lab conversation refused every message and its returned answers went unread

## What was seen

Session concierge:7200 ("NotebookLM access and lab arm", Codex gpt-6-sol) failed every input from
20:39 UTC with "Codex app-server thread/resume timed out after 30000ms": turn 10857 five times,
then 10858, 10859 and 10867 at once (the retry budget it had spent was the whole Codex
account's). Three of those inputs carried answers from the "Dedicated Canvas three-arm Lab
facilitator", so Concierge raised "a result reached this conversation, nobody has read it".

The App Server logged `composing running thread resume response` for each request and nothing
after. Concierge's connection resumed other threads (one with a 19.8 MB history) normally, and a
Node probe on fresh connections resumed this thread in about 150 ms. After a first fix moved the
thread onto a fresh connection per turn and Concierge restarted at 21:05, a cold resume through
fresh Concierge connections still timed out five more times (21:06 to 21:12).

## Cause

Confirmed. The thread's rollout holds two raw U+2029 (paragraph separator) characters, which JSON
allows unescaped inside strings; session 6381's has none. Concierge reads the bridge's JSON Lines
with `node:readline` under Bun 1.4.2, which also ends a line at U+2028 and U+2029 (Node does not).
Measured: one JSON line holding both characters gives Node 1 parsable line and Bun 3 unparsable
pieces. The resume answer (the thread's full history) therefore reached Concierge as fragments,
each skipped as unparsable, and the request timed out. The returned answers were never lost: they
sit in failed turns the provider never acknowledged, and the next successful turn carries them as
preserved context.

The first fix (c228ee8c: run the thread on its own connection) rested on a wrong guess that the
long-lived connection was at fault; it is removed. Its retry-budget change stays.

## Fix

- Every JSON Lines reader in Concierge goes through one reader that splits on newline only, and
  Concierge's writers (and the bridge's output) escape U+2028/U+2029.
- The release lint refuses `node:readline` in Bun code.
- A resume failure spends the conversation's retry budget, not the Codex account's (a82ad7d9).

## Acceptance scenario

- **Seed:** a Codex thread whose history contains U+2029 inside an agent message.
- **Action:** send that conversation a message through Concierge.
- **Expected:** the resume answer arrives, the turn runs, and earlier failed inputs appear in it as
  preserved context.
- **Replayable offline:** yes (feed a JSON line holding U+2029 through the reader; it must yield one
  parsable record).
