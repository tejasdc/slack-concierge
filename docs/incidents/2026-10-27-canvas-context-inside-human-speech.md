---
failure: Argument-map think-aloud stored the app's board and page instructions inside Tejas's spoken message.
date: 2026-10-27
fix_commits: []
cause_status: confirmed
---

# Canvas instructions appeared as Tejas's words

## What was seen

Each finalized think-aloud transcript reached the ordinary Codex session with a bracketed board, page and segment envelope prefixed to Tejas's speech. The session therefore retained application instructions as part of the human-authored message.

## Cause

Thinkering had no typed session-input field for argument-map context, and the canonical session owner rejected unknown fields. The sender put required canvas metadata into `text` so the agent could receive it.

## Fix

The canonical server and Mac session owners accept and validate one bounded argument-map context record. They retain it beside the exact transcript and add it only while preparing the provider prompt. The displayed and retained human message remains the transcript. Thinkering ships its sender only after both owners accept the field; an older owner refusal leaves the stable browser-outbox input pending instead of dropping the context.

## Acceptance scenario

- **Seed:** An ordinary Codex session owned by either the server or Mac, and one argument-map speech input whose transcript is `Maybe these have a common cause` with separate board and open-page context.
- **Action:** Submit the input, inspect its retained receipt and visible history, then inspect the provider prompt prepared for that input.
- **Expected:** The receipt and visible human message contain exactly `Maybe these have a common cause`; the provider prompt labels the validated board and page values as application context before the exact speech; replaying the stable input ID creates no duplicate.
- **Replayable offline:** yes
