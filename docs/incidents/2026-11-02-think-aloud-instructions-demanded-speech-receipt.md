---
failure: The think-aloud Codex agent refused to start a Canvas thread for lack of a speech receipt, then reported a thread as done that never appeared on his open Canvas.
date: 2026-11-02
fix_commits: []
cause_status: confirmed
---

# Think-aloud instructions demanded a speech receipt

## What was seen

On his curiosity engine Canvas, Tejas asked his think-aloud agent (`concierge:7810`) to start a
thread. It refused, saying the turn lacked a verified speech receipt. Later it created one, read
it back from the server and told him it worked; his open Canvas never showed it (capture
`07e17e49c37ee7c9df3bc15eb3230b0f959205dca9d8a3c1992559c1b32d83ae`).

## Cause

These instructions told Codex that create_thread, create_idea and add_point "carry the retained
input id as sourceUtteranceId plus an exact sourceQuote". thnkr.ing dropped that requirement at
11:53 ET; the instructions here still demanded it. Nothing told the agent how to know whether he
could see a change, so it reported a server save as done. The display failure itself was in
thnkr.ing: its failure ledger case thinkering-canvas-agent-change-never-reached-open-canvas.

## Fix

The instructions make the speech source optional and never a reason to refuse, send the page id
with every action, and report a change as done only when thnkr.ing answers `page.shown` true. The
text lives in `bot/src/think-aloud-instructions.ts`, a pure function thnkr.ing's isolated agent
workspace renders for its real-Codex check, so the check uses these exact words.

## Acceptance scenario

- **Seed:** an isolated thnkr.ing workspace, a Canvas open in two windows that never reload.
- **Action:** his words, "Start a new thread called Probe Codex alpha.", reach a real continuing
  Codex agent through the think-aloud panel with these instructions
  (`node scripts/canvas-agent-probe.mjs --codex` in thnkr.ing).
- **Expected:** both windows draw the thread; the agent neither refuses nor asks for a receipt.
