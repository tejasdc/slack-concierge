---
failure: Inbox automatically moved between provider conversations instead of staying in one Claude Code session.
date: 2026-11-16
fix_commits: []
cause_status: confirmed
---

# Inbox continuity changed with account allowance

## What was seen

The November 16 human instruction relayed by concierge:9832 in request
`b563714b-ba58-4517-b935-fc7ad4303463` requires the same Claude Code session unless the
human explicitly asks otherwise. It identifies three saved Claude accounts as the alternative
to moving the conversation. The parent investigation verified the current Inbox is
concierge:9832, Claude Opus with one-million context, native conversation
`ea1772f7-7a71-4e85-a8a4-7b26bb159214`. Historical account events show that conversation
already selected all three saved accounts on November 16 without changing its identity.

## Cause

The standing-role allowance sweep deliberately proposed provider handoffs for Inbox.
Inbox preparation could create a Codex router while Claude creation was held. Ordinary
agent handoff and direct standing-role binding were additional ways to replace the router.
This was implemented behavior, not evidence that account switching required new conversations.

## Fix

The durable current Inbox role holder is the pin; installation needs no live role mutation.
Only a one-use override grounded in actual retained human words can transfer it. Proposal and
acceptance both check that authority, and the central transfer protects direct binding.
Metadata changes, duplicate role creation, provider conversation replacement, first-turn
automatic rerouting and exhaustion recovery cannot bypass the pin. Existing account dispatch
continues to choose a Claude home with room while resuming the same conversation.

## Acceptance scenario

- **Seed:** disposable Claude Inbox with a fixed native conversation, an exact queued human input,
  and three synthetic saved homes sharing one transcript directory.
- **Action:** the real account dispatcher records exhaustion for each synthetic account; invoke
  automatic continuity, Inbox preparation and agent-authored transfers.
- **Expected:** dispatcher reports all three accounts out; Inbox, native conversation and exact
  queued input remain. Agent requests and unrelated, conditional or quoted human words cannot
  transfer it. A fresh explicit human bind and a full handoff override succeed; consumed authority
  cannot authorize another transfer. Old Inbox history remains marked and readable.
- **Replayable offline:** yes, `cd bot && bun run scripts/inbox-session-pin-fixture.ts`.

This record describes candidate behavior. Installed acceptance requires rerunning the disposable
fixture against the installed release and independently reading the live role and native identity.
No live exhaustion, handoff or role mutation is needed to check installation.
