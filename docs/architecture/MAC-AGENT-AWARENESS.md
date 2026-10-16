# Mac agent awareness

The Mac session owner observes Claude and Codex tool starts in the existing provider
progress stream. The server owner also observes tool calls that SSH to Tejas's Mac,
including a plain command and AppleScript from a server agent. For actions that can
visibly affect Tejas's Mac, it retains one
`mac_surface_activity` event per action kind and turn with the agent's exact session,
input, turn and a short action description. It does not treat this as a permission
request or block the tool. The event ID makes provider replay idempotent.

The first action of each kind in a turn is reported: installs through common package
managers, launchd loads, Chrome debugging, screen capture, AppleScript and computer
use, opening an application, and SSH to the Mac. This is evidence from the agent's tool request,
not a claim that macOS granted a permission or that an installation completed.
The SSH observation recognizes the Mac peer's registered SSH address. Tool activity
outside the observed provider stream is not covered. macOS remains
the source of truth for its own permission and login-item records.

Codex reports shell commands under the shell executable's name, including
`/usr/bin/zsh`; the SSH observer accepts that tool identity. The first marked
server SSH check on October 16 ran successfully but created no activity event
because this identity was missing. A later check must observe both the retained
event and phone delivery.

On October 16, a server Codex agent investigating thnkr.ing Capture ran a
read-only AppleScript login-item query through SSH. macOS showed Tejas an
`sshd-keygen-wrapper` request to control System Events, while the existing
Mac-only observer sent no notice. The agent told him to choose Don't Allow;
the query did not need that permission. This server-side observation closes
that measured attribution gap. A harmless SSH AppleScript call and the
resulting phone notice are the live acceptance check.

Thinkering's existing attention notifier subscribes to this event from both
Concierge peers. It resolves the current session to name the agent and task, then
sends one phone alert linking to that session. The session's Stop control cancels
running work; a completed action still has its retained record. The notifier
uses its existing target and delivery store. Replay is deduplicated by event ID,
and events older than ten minutes are not pushed after an outage.

This awareness does not revoke Mac automation access. Tejas expressly confirmed
that agents may automate his Mac; the earlier proposed screen/app-control gate was
not installed after he rejected that expansion. The behavior here answers who did
what and gives him the existing Stop path.
