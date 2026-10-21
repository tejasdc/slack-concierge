---
failure: A production repair of the manifesto publishing system was marked a small task and handed to Gemini Flash, which removed a deliberate publishing rule, and the request's record did not show it had been marked small.
date: 2026-10-18
fix_commits: [82d5d9ad]
cause_status: confirmed
---

# A publishing-system repair was routed to Gemini as a "small task"

## What was seen

On 2026-10-17 the Inbox router started a new session for a manifesto request that asked for diagnosis and a change
to a deliberate publishing rule. The router passed `--small-task`, so Automatic provider choice admitted Google, and
the work ran on Gemini 3.8 Flash. That session removed the manifesto's publish-number gate. Auditing afterwards was
harder because the retained request payload did not record the small-task mark, so the dispatch to Google looked
unexplained (`docs/architecture/PROVIDER-SESSIONS.md`, automatic starts).

## Cause

Automatic new-session choice admits Google only for a request the router marks `--small-task`
([decision: mix-claude-codex-google-for-new-work]); the owner enforced that rule correctly. The error was the router's
judgement: its standing instructions (`INBOX_INSTRUCTIONS` in `bot/src/session-inbox.ts`) defined small only as "a
bounded task that fits one focused session without live steering", which an unknown-cause diagnosis plus a rule
change could be read to satisfy. Separately, `SessionCommunicationCoordinator` in `bot/src/session-communication.ts`
passed `smallTask` to session creation but did not write it into the request's retained `payload_json`, so the receipt
lost the evidence. At the time the `google` alias resolved to Flash, the strongest mode the CLI listed on 2026-10-13.
Not established: that a different provider would have kept the gate.

## Fix

82d5d9ad has three parts, and only one is an enforced system change:
- **System change:** the retained request payload now includes `smallTask:true`, so every receipt shows whether the
  router chose the Google-eligible path.
- **Instruction only:** the router's per-run instructions now require "a fully stated deliverable" and say that
  unknown-cause diagnosis, a change to an established product rule, or a production repair is not small, citing this
  incident. Nothing in the owner refuses a mis-marked request; the router can still make the same mistake.
- **Model default:** `google` now selects Gemini 4 Argon (High), the strongest mode for the paid AI Pro account on
  2026-10-18; Flash needs the explicit `google-flash` alias. This lowers the cost of a mis-mark but does not prevent it.
`AGENTS.md` and `PROVIDER-SESSIONS.md` record the boundary.

## Acceptance scenario

- **Seed:** An Inbox router session; a capture asking to diagnose why a publishing step misbehaves and to change its
  numbering rule in a registered project.
- **Action:** The router routes it to a new Automatic session.
- **Expected:** The router does not pass `--small-task`, so the new session is Claude or Codex. Any request created with
  `--small-task` carries `smallTask:true` in its retained payload, and a Google session created that way uses
  `gemini-4-argon-high`.
- **Replayable offline:** no (the router's judgement needs a real model run and cannot be guaranteed; the payload mark
  and alias alone are deterministic and replayable)
