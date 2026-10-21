---
failure: A thnkr.ing release was blocked by the live-database safety check because its release note contained a semicolon, even through the exact safe entrance the refusal named.
date: 2026-10-15
fix_commits: [d6e8c8df]
cause_status: confirmed
---

# The live-ledger guard refused a release because of punctuation in its note

## What was seen

On 2026-10-15 the agent shipping Tejas's handwriting changes (concierge:6494, thinkering PR #133)
ran `npm run ship -- --checked "Web build passed; handwriting panel checked"`. The machine's
pre-command "live Concierge ledger" guard refused it. The agent then used the sealed
`private-code-command` wrapper that the refusal message named, and the guard refused that too, so the
release was stuck. The Inbox router asked a repair session who added the guard and why it refused.
Tejas had asked the same.

## Cause

`bot/scripts/live-store-copy-guard.ts` refuses package-runner launches that could import Concierge
modules while a stale agent still inherits the live ledger setting. Its one allowed path is the
private entrance, checked by `privateEntrance`. That function rejected the command whenever it
contained any of `; & | < > \` $ ( )` or a newline anywhere, with no notion of quoting. A semicolon or
parentheses inside the quoted `--checked` note therefore looked like shell chaining, and the wrapped
release was refused exactly as the unwrapped one was.

## Fix

d6e8c8df replaces the character test with `shellControl`, which reads the command with quote
context. Inside single quotes nothing is control. Inside double quotes only `` ` `` and `$`
(substitution) are. Outside quotes the old characters still refuse, as do newlines and an unclosed
quote. Real chaining (`…; npm run build`), command substitution inside the note, a direct unwrapped
release and raw ledger copies are still refused. The guard fixture
(`bot/scripts/live-store-copy-guard-fixture.ts`) covers the observed release shape, a note with
parentheses, and those unsafe neighbours. `docs/runbooks/DEPLOYMENT.md` and `AGENTS.md` were updated.
The handwriting release went out (installed revision 46ece887) with a plain note while the fix shipped.

## Acceptance scenario

- **Seed:** The installed machine hook with an agent environment that inherits the live state
  directory and has the private entrance configured.
- **Action:** Run the wrapped release with a note containing `;` and `( )` inside double quotes.
- **Expected:** The hook allows it. The same command with `; npm run build` appended, or with
  `"$(npm run build)"` as the note, is refused, and so is the unwrapped `npm run ship`.
- **Replayable offline:** yes (the guard fixture runs the hook against command strings; no release
  needs to execute)
