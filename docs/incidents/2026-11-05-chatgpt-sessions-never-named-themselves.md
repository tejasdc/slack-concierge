---
failure: Sessions Tejas started himself in ChatGPT stayed called "Agent session" forever, while his same request was delivered for Claude, Codex and Gemini.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Every chat he opened himself with ChatGPT was called "Agent session"

## What was seen

On 2026-09-18 Tejas asked that every session name itself when it begins, including the ones he
starts by hand: "We had instructed agents to name their own title so let's make sure instruction is
getting passed through so they can name their title especially when they first begin." Two changes
on 2026-09-19 delivered that for the providers whose agents can run a command, and the live check
confirmed a fresh unnamed Claude session naming itself. ChatGPT was named as uncovered in that
answer and then stayed uncovered, so a ChatGPT chat he opened himself kept the placeholder name in
his sessions list however long he used it.

## Cause

Confirmed. Naming was built as one mechanism — an agent runs `sessions title` in its own live run —
and ChatGPT has no shell and no tools, so it can never run it. Nothing in the system compared a
provider against that mechanism: the per-provider contract table that exists precisely so a new
provider cannot quietly lack what the others have (`docs/architecture/PROVIDER-CONTRACT.md`, added
after Gemini shipped without steering) had no naming guarantee, so no check and no build error could
notice that one of four providers had no way to get a name at all.

## Fix

ChatGPT names its own conversations, and Thinkering already reads each conversation, title included,
whenever it collects an answer. A terminal ChatGPT result now carries `conversationTitle`, the raw
title ChatGPT set — never the capability host's placeholder for an untitled one — and the owner
adopts it through the same initial-title path a creator's name uses, so it fills only a session with
no name and never overwrites a name its creator or Tejas chose. Naming itself became a guarantee in
the provider contract, answered by all four providers, and the candidate release check reads both
naming paths, so a fifth provider cannot arrive without answering how its sessions get a name.

## Acceptance scenario

- **Seed:** a ChatGPT session created with no title (the surface's own create, or
  `sessions ask --provider chatgpt` without `--session-name`).
- **Action:** send it one message and let ChatGPT answer.
- **Expected:** the session's title is the name ChatGPT gave that conversation, not the
  "Agent session" placeholder, and a title event reaches open clients. Repeating the message does
  not rename it, and a title set with the human Rename control survives every later answer.
- **Replayable offline:** no (needs the signed-in ChatGPT browser; the adoption rule itself is
  replayable from a result carrying `conversationTitle`).
