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

Thinkering had no typed session-input field for argument-map context, and the canonical session owner rejected unknown fields. The sender put required canvas metadata into `text` so the agent could receive it. The first owner change retained the field separately but then rebuilt the same combined text immediately before provider admission, so the native Codex user turn was still not the human transcript.

## Fix

The canonical server and Mac session owners accept and validate one bounded argument-map context record. They retain it beside the exact transcript and send it through Codex's existing application-context channel. The native turn-start and steering user text remains exactly the transcript. The application context also supplies the map's read/action protocol on every newly started canvas turn: a server session calls Thinkering's private Unix socket directly, while a Mac session reaches that server socket with `ssh remote-box`.

The exact selected owner advertises this protocol at `GET /sessions/v1/sessions/:id/capabilities`. Thinkering creates or resolves the session and requires `{canvasContext:true}` before it starts microphone capture. An older owner returns404, so no speech is recorded or sent to a schema that would terminally refuse it.

## Acceptance scenario

- **Seed:** An ordinary Codex session owned by either the server or Mac, and one argument-map speech input whose transcript is `Maybe these have a common cause` with separate board and open-page context.
- **Action:** Submit the input, inspect its retained receipt and visible history, then inspect the provider prompt prepared for that input.
- **Expected:** The receipt, visible human message and native Codex user turn contain exactly `Maybe these have a common cause`; the separate Codex application context carries identity, board/page values and the correct server or Mac capability route; replaying the stable input ID creates no duplicate. A second checkpoint steered into the same page's running turn is also exact transcript text. An old owner returns404 from capability negotiation before microphone capture.
- **Replayable offline:** yes
