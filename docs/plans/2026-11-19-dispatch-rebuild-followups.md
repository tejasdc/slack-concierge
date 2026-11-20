# Dispatch rebuild — explicit follow-ups

Status: 2026-11-19. Each item below is NOT in PR #1019 and is named here as a
discrete next change with its evidence. Scope is explicit; each one needs its own
plan, its own test, and its own review gate.

## Why this list exists

The adversarial review of PR #1019 named several concerns that are real but
larger than "one more fix in this PR":

- derived-from-an-invariant replacements for hand-tuned constants
- transport replacements for subprocess/HTTP machinery
- event-driven admission for things that still poll
- cross-provider recovery for providers the current `transferSession` does not
  support
- older pre-rebuild session identities that have no retirement path

Each is a separate, bounded change. Keep them out of the rebuild PR so the
rebuild stays reviewable; keep them visible here so they don't fall off.

## 1. `WARM_STAY_BAND = 2` — hand-tuned ratio

`bot/src/provider-account-choice.ts:98,173`. The constant means "the warm
account stays while its own pressure is at least half the best one's." The 2
is a product judgment, not a derivation. Replace with a ratio computed from an
invariant — for example, the chance that the warm account's lapse pressure
genuinely exceeds the roomiest's over the next turn window, given the measured
read interval.

Evidence: slack-concierge:provider-account-choice.ts:95-98 comment and the
2026-11-15 incident replay at `bot/tests/incidents/2026-11-15-warm-stay-band.test.ts`.

Why not in this PR: the value works today; a derivation needs two week-long
usage traces to prove its curve. Scope expansion.

## 2. 90-second subprocess usage reader

`bot/src/provider-account-usage.ts:145`. Each `/usage` reading currently spawns
a subprocess that talks to Anthropic's CLI; the 90-second worst-case has been
a factor in several stale-reading incidents. Replace with a direct call to
`/api/oauth/usage` so the owner loop can refresh more aggressively and tolerate
variance.

Evidence: 2026-10-15 stale reading hid 19% account (`docs/incidents/`).

Why not in this PR: new HTTP path + auth flow + error semantics; sizeable.

## 3. `RUNNER_REPAIR_TIMEOUT_MS = 220_000`

`bot/src/provider-activation.ts:233`. Event-driven admission is the right
shape; the 220-second budget is a polling fallback. Replace with a listener on
the relevant SQLite event stream so admission opens the moment the repair
completes.

Evidence: `bot/tests/incidents/2026-11-17-runner-hold-bounded.test.ts`.

Why not in this PR: requires a new event-listener path and careful test
harness around admission.

## 4. Peer-answer version-hold notices still repeating after recovery

`docs/incidents/2026-11-15-peer-answer-version-hold-reminders.md`. A
peer-answer's version-hold notice fires more than once after a Concierge
recovery.

Why not in this PR: recovery path is in `provider-exhaustion-recovery.ts`
but the notice-dedup lives in the Inbox router. Cross-module fix.

## 5. Acknowledged-usage-hold handoff (2026-11-14)

`docs/incidents/2026-11-14-acknowledged-usage-hold-could-not-move.md`. A turn
whose provider acknowledged the input but held it for usage cannot be
transferred to another provider via `transferSession`; the receipt's
`admission.inputId` prevents `safeTurn` from admitting the move.

Why not in this PR: the current PR's exhaustion recovery still refuses the
move; the fix needs a new admission-aware transfer predicate.

## 6. Legacy-resume refusal parks turns (2026-11-16)

`docs/incidents/2026-11-16-claude-legacy-resume-refusal-parked-turns.md`.
Claude transcripts written before the `session-owner` header have no
retirement path through the new `claude_session_account_bindings` table.

Why not in this PR: the rebuild adds the binding for NEW sessions; backfilling
old transcripts requires a migration that touches every `.claude-accounts/*/projects/*.jsonl`.
Separate migration PR.

## 7. Codex refusal-streak keyed on closed-turn text (2026-11-16)

`docs/incidents/2026-11-16-refusal-streak-erased-by-closing-turn.md`. The
Codex refusal streak reads the closed-turn text; closing the turn erases the
streak. Should key on the session's own refusal history, not the turn's text.

Why not in this PR: the streak machinery is in `codex-reset-credit.ts`; the
rebuild didn't touch it.

## 8. ChatGPT prebrowser refusal cross-provider recovery (2026-11-17)

`docs/incidents/2026-11-17-chatgpt-prebrowser-refusal-blocked-original-recovery.md`.
A ChatGPT prebrowser refusal blocks the original recovery, which has no
equivalent of `transferSession` for ChatGPT-origin sessions.

Why not in this PR: needs a ChatGPT-aware successor path, which the current
code doesn't have.

## 9. Pre-host native Claude UUIDs refused on restart (2026-11-17)

`docs/incidents/2026-11-17-native-events-session-home-unproven.md`. Claude
UUIDs written before the native events host was installed have no
`claude_home_proof` row; a restart refuses them until a manual check runs.

Why not in this PR: same as item 6 — needs a one-time migration.

## 10. Mac-side usage reads (inventory items #19, #20)

`docs/plans/2026-11-19-provider-account-rebuild-inventory.md` §19-§20. The
Mac has its own `/usage` reader with per-home keychain lookups; the rebuild
preserved its behavior but did not consolidate it with the server-side reader.

Why not in this PR: cross-machine coordination; needs a careful acceptance run
on the Mac.

---

Each item has:
- **Evidence**: file:line and the incident doc or inventory section that cites it.
- **Why not in this PR**: the specific scope expansion that would have taken
  the rebuild from ~5400 lines to multiples of that.

When one of these lands, remove it from this doc with a link to the shipping
commit.
