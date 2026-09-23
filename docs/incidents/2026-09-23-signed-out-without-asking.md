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

## Why each change was made, and what would not have signed him out

- **Sign-in secret.** Agents had read the plaintext secret out of the server's settings and signed
  in to thnkr.ing as him (a Mac agent on 2026-09-18, posting into his Inbox). The goal was that no
  one could read a usable secret there. Storing only a fingerprint of the *same* secret would have
  done that and changed nothing for him; replacing it with a secret nobody holds also removed his
  password fallback. Neither signs anyone out on its own.
- **Session key.** The server logged 64 sign-ins with the shared secret between 2026-09-14 and 18;
  at least the 2026-09-18 ones were an agent (confirmed from its transcript), the rest are not
  attributed. Each sign-in lasts 30 days, so an agent's session could keep acting as him into
  October. Changing the key was the
  only lever in the current design that ends them, and it ends his own sign-ins too. Alternatives
  that would not have hurt him: ask him and let him choose when (a minute of passkey sign-ins at a
  moment of his choosing); record how each session signed in, so sessions opened with the shared
  secret can be ended alone; or accept the window while blocking further agent sign-ins.
- **Slack token.** It posted as him in Slack. Revoking it touched none of his clients.

## The announcement and hold (added the same day)

His finding: nothing said "secrets rotated, all sessions will invalidate at next restart"; he lost
service and rebuilt the cause from logs. `bot/scripts/protected-secrets-watch.ts`, run by
remote-box's `remote-box-protected-secrets-watch` path and timer units, fingerprints every key in
the protected files (`SECRET_FILES` in `bot/src/protected-secrets-policy.ts`). On any change,
however made, it publishes `secrets_rotated` (file, keys changed/added/removed, who, when it takes
effect, whether it signs him out), puts a service message in his Inbox and raises it to Needs
attention, which Thinkering pushes to his phone, all without an agent turn. Who: the guard records
each change it allowed after his approval, so an approved change names its session and turn; a
change with no approval record is reported as not approved, with the agents working at the time.
For thnkr.ing, the previous values of changed keys are written to a held file that
`thinkering.service` loads after its real settings, so a restart keeps the old keys until he
replies "approve <code>". Values stay in the root-only state directory; events carry key names only.

The guard and the watcher are one mechanism: one list of protected things, one approval word, and
the watcher covers every write the guard cannot see (a script file, another machine, a person).

## Talking about a key is not changing it (fixed the same day)

The first guard matched words, so it refused the Inbox for sending a message that named the file.
The guard now reads a command as a shell does and refuses only acting on a protected key: a write
target, an operand of a file-changing command, interpreter code or a script handed the path, a
database write, a key API call, and the same inside `bash -c`, `ssh` and `$(...)`. Reading the
file, messages, commit text, prompts to other agents and edits to documents pass.

## Reversed the same evening: provenance, not locks

At 17:25 UTC Tejas reset the goal: agents need full control of both machines, including repairing,
restarting or bypassing Concierge and starting agents outside it, and the aim is provenance, not
stopping agents ("stop treating this as a maximum security prison"). He approved:

- The pre-command check, the file lock and the hold are removed (the installer now takes the check
  out of Claude's and Codex's machine settings; remote-box no longer locks the file).
- "Send to Inbox" and bug reports go back through the capture drop-off, which keeps them safe
  while Concierge is down.
- The key-change notice stays, as a notice (`bot/scripts/key-change-notice.ts`).
- Agents get their own test entrance for each delivery path, recorded as them
  (`router-actions.sh test-capture`).
- His messages show which door they came through.

The talk-versus-act reading of commands and the hold were removed with the check; the incident
record above is kept as history.
