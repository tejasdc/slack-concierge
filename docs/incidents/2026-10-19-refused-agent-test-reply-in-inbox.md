---
failure: An agent's test of the Watch reply path left a "your notification reply was refused" notice in Tejas's Inbox thread.
date: 2026-10-19
fix_commits: [6e23a49d]
cause_status: confirmed
---

# Refused agent test replies appeared in Tejas's Inbox thread

## What was seen

Two Watch-reply tests run by agents on 2026-10-19 each ended with a notice in his Inbox thread reading
"Your notification reply was refused. Open the conversation to retry with the words kept below", as if his
own reply had failed and he had something to resend.

## Cause

In `bot/src/index.ts` the human-command intake's `refused` handler publishes a provider-free
`notification_reply_refused` notice for any refused `/notification-replies` command. The notice is meant for
replies he typed, so he can resend the words. Agent tests through the marked test entrance
(`router-actions.sh test-capture`) carry `body.agentSource`, but the handler never looked at it.

## Fix

6e23a49d: when `command.body.agentSource` is present the handler logs `agent_notification_reply_refused`
(action and session ids) and returns without publishing the notice. The testing agent learns the refusal
from its own answer.

## Acceptance scenario

- **Seed:** A thread bound to a session and a notification-reply command that the owner will refuse
  (e.g. a target that no longer accepts input).
- **Action:** Submit it once through the marked agent entrance (with `agentSource`) and once as Tejas.
- **Expected:** The agent-sourced refusal appears only as an `agent_notification_reply_refused` log line and
  nothing is filed in any Inbox thread; the human-sourced one still files exactly one
  `notification_reply_refused` notice with his words.
- **Replayable offline:** yes (the intake refusal handler with a stub owner)
