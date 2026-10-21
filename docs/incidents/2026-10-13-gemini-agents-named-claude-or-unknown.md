---
failure: A Gemini agent was shown as Claude in thread answers and notices, with a different running state in the sidebar than on its page, and older Gemini answers then showed as an unknown agent.
date: 2026-10-13
fix_commits: [ccbb1156, e566e031]
cause_status: confirmed
---

# Gemini agents were named Claude, and then unknown, depending on where they were shown

## What was seen

On 2026-10-13 one Gemini agent was shown as Gemini in the sidebar, as Claude on its thread answer, and as
running in the sidebar while its session page said completed. A Gemini session's usage notice read "No Claude
account has room". After the first fix, older Gemini answers in cold Inbox threads reached thnkr.ing without
the agent's shown name and appeared as an unknown agent.

## Cause

Who an agent is and what it is doing had several copies. The prepared sidebar card worker and the owner each
had their own running/completed rule. Three author-session rules existed (`session-message-author.ts`,
`inbox-attribution-read.ts` and the peer path); two defaulted a peer agent missing from the catalogue to
`claude-code`. About a dozen notices named every non-Codex provider "Claude" (`provider === "codex" ? "Codex"
: "Claude"` in `provider-usage-notice.ts` and others). Separately, stored Inbox entries keep the author identity
they were prepared with, and the bounded preview in `presentation-inbox-display.ts` kept only id, title and
provider, so entries prepared before the shared record had no `agentName`.

## Fix

- ccbb1156: `bot/src/session-presence.ts` is the one rule for provider, model, effort, shown name
  (`agentDisplayName`), execution and timing, with a `presenceRevision`; views, cards and every author session
  call it. `providerDisplayName` replaces the guessed names; unknown stays null, never Claude.
  `bot/scripts/check-agent-presence.ts` in the build refuses a guessed provider name, a defaulted provider or a
  second turn-state table (22 places on the previous main). The thread-answer label half shipped in thnkr.ing.
- e566e031: the preview keeps model, effort and `agentName`, and both owner reads of stored entries (topic
  entries and thread history) rename each author session through the one rule (`withCurrentAuthors`).
- 309fae38, from an independent review, keeps an unresolvable thread-answer author unknown instead of falling
  back to the Inbox. It is not listed above because no such case was observed.

## Acceptance scenario

- **Seed:** A Gemini (`antigravity`) session that has finished a turn, with an Inbox thread entry it authored
  that was prepared before the presence record (author session without `agentName`), and a usage reading for
  its account at 95%.
- **Action:** Read its sidebar card, its session view, the thread entries and the usage notice text.
- **Expected:** Card and view report the same execution and `presenceRevision`; the thread entry's author
  carries the Gemini `agentName`; no surface or notice says Claude for it; a peer session missing from the
  catalogue has a null provider. The build check fails if a `=== "codex" ? "Codex" : "Claude"` guess is added.
- **Replayable offline:** yes (scratch ledger and prepared-entry rows; no Gemini account needed)
