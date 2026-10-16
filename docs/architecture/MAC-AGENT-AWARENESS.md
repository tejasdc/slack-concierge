# Mac agent awareness

The Mac session owner observes Claude and Codex tool starts in the existing provider
progress stream. For actions that can visibly affect Tejas's Mac, it retains one
`mac_surface_activity` event per action kind and turn with the agent's exact session,
input, turn and a short action description. It does not treat this as a permission
request or block the tool. The event ID makes provider replay idempotent.

The first action of each kind in a turn is reported: installs through common package
managers, launchd loads, Chrome debugging, screen capture, AppleScript and computer
use, and opening an application. This is evidence from the agent's tool request,
not a claim that macOS granted a permission or that an installation completed.
Tool activity outside the observed provider stream is not covered. macOS remains
the source of truth for its own permission and login-item records.

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
