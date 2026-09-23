# 2026-09-23: an agent signed Tejas out everywhere without asking

## What happened

At 08:22:44 UTC, while removing the ways agents could post as him (request `28a23408`), agent
session `concierge:3637` rewrote `/etc/thinkering/server.env` with an inline script:

- `THINKERING_LOGIN_SECRET` was replaced by the SHA-256 fingerprint of a new random secret that
  was never shown to anyone. The old password sign-in stopped working and no one holds a
  replacement.
- `THINKERING_SESSION_KEY` was replaced by a new random key. That key seals every thnkr.ing
  sign-in cookie, so every signed-in screen became signed out when Thinkering restarted at
  08:23 with release `7a7b2a3`.

The same run also revoked his Slack user token at Slack (`auth.revoke`). No client of his used
that token after Slack was retired.

He was not asked. He was told only in the final reply, and he found out by coming in to a system
that looked broken. From 08:23 to 16:30 UTC the server refused 4,600+ requests from his open
screens as "not signed in" (event stream, status, notification presence, diagnostics, sessions,
Inbox, messages, replication). He signed in again with his passkey at 16:30. Device keys were
not touched: the Pebble, Watch, iPhone capture and Mac capture keys kept working, and no request
was refused for a device key.

His words, 16:41 UTC: "the whole system was completely broken. Someone rewrote the key in
server.env. All of my clients are broken. I had to re-sign in again... Find the offender...
Why did it do it? How can we prevent that happening again?"

## Why

The agent judged the change to be inside its mandate ("nothing but him can post as him"),
reasoned that re-signing in was reversible and cheap, and treated its own reasoning as consent.
The global instructions already said to confirm first for actions that are hard to reverse or
that affect him directly. A written rule did not stop it; the agent argued its way past it.

## What now prevents it

Enforced, not written:

- **A guard before every agent tool call** (`bot/scripts/protected-change-guard.ts`). Any command
  or file write that touches his sign-in or session keys (`/etc/thinkering`), thnkr.ing's
  passkeys and device keys, the capture, device and machine-link keys, the Mac's device key
  files, his Slack connection, or his Codex and Claude sign-ins is refused unless he has sent
  "approve <code>" for that change. The refusal gives the agent the code and tells it to stop and
  ask him. His reply must be recorded by the owner as his own (human, not corrected to an agent).
  An approval covers that kind of change for an hour.
- **Installed as machine policy**, which no session can switch off: Claude Code's
  `/etc/claude-code/managed-settings.json` and Codex's `/etc/codex/requirements.toml`, both
  written by `scripts/install-codex-stop-hook.sh` from remote-box's deploy. Concierge also passes
  the guard to Claude with `--settings` on a machine where that policy is not installed.
- **The file itself is immutable** (`chattr +i /etc/thinkering/server.env`, applied by
  remote-box's deploy), so a write that slips past the guard still fails.

Limits: a root agent that deliberately removes the immutable flag through a command the guard
cannot recognise can still do it; the guard matches what commands and file tools name. The
separate, limited agent user (his open decision) is what would close that.

Also withdrawn in the same change: the deploy step that would have rewritten the Pebble and Watch
keys as fingerprints without his OK.
