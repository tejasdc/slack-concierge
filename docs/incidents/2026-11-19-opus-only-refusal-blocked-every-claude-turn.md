---
failure: An Opus-only cached refusal blocked Sonnet and Haiku dispatch, the account's own fresh reading at 39% weekly could not retire it, and a hand sign-in locked out every Claude turn.
date: 2026-11-19
fix_commits: []
cause_status: confirmed
---

# "Room remains" sat beside "no account has room" for every Claude turn

## What was seen

A Nov-22 Opus refusal cached under `hey@tejas.nyc` held the Inbox for hours while the
same account's fresh reading showed 39% weekly used with a Nov-19 reset. The hold
message named Nov 22. When the operator cleared the cache by hand and re-pressed, the
bot's re-attempt received both a structured `rate_limit_event { status: "allowed" }` and
a synthetic "You've hit your weekly limit" assistant text, and re-cached the same phantom
Nov-22 refusal. After `claude /login` was run in the terminal to try a different path,
`accounts.validate` reported `resolution:"ambiguous"` and every Claude turn refused with
`Runner ax41 cannot resolve selected Claude account hey@tejas.nyc`.

## Cause

Four cache/parser/resolver rules combined so the user saw contradictions on screen:

- **F1** `claudeAccountCachedReset(account, null)` returned the max cached reset over
  **any** model-specific scope under the account prefix. An Opus-only refusal poisoned
  Sonnet/Haiku/model-agnostic release checks.
- **F2** No Claude equivalent of `retireCodexRefusalSupersededByReading` existed. A
  fresh reading with every window under 100% and a non-matching reset could not retire a
  Claude cached refusal.
- **F3** `runnerAccountHomes` enumerated the live-root home and each per-account folder
  as independent candidates. A hand `claude /login` made the same account appear twice
  and `accounts.validate` refused `"ambiguous"`.
- **F4** The CLI parser's terminal decision combined `usageRejected || isClaudeUsageExhaustion(parsed.text)`.
  Anthropic's stream can carry a structured `rate_limit_event { status: "allowed" }` and
  a `<synthetic>` "weekly limit" text at the same time; the synthetic cached a phantom
  refusal even when the structured event explicitly said the request was allowed.
- **F10** `clearProviderUsage` had no scoped CLI entrance. The intervention the day
  required had to be written as raw SQL.

## Fix

- F1: `claudeAccountCachedReset(account, model, semantics)` requires a model for the
  model-specific question, and walks the Claude allowance chain (fable/opus/sonnet/haiku)
  for the `any-work` question. One spent model no longer blocks a healthy one.
- F2: `retireClaudeRefusalSupersededByReading(label, windows, model, readAtMs)` mirrors
  the Codex retirement rule. Called once per model from the Claude reading loop whenever
  the reading is fresh and not marked problem.
- F3: `runnerAccountHomes` dedupes by account label and prefers per-account folder over
  live root. `accounts.liveRootMirror` reports the mirrored sign-in separately; it never
  makes dispatch refuse.
- F4: The parser latches `sawStructuredAllowed` and `sawStructuredRejected` from
  `rate_limit_event`. The terminal decision becomes
  `sawStructuredRejected || (!sawStructuredAllowed && syntheticExhausted)`, and a
  conflict logs `claude_synthetic_overridden_by_structured_event`.
- F10: `router-actions.sh usage-clear <provider> [--account <label>] [--model <alias>] [--all]`
  calls `clearProviderUsageScoped`. A scoped clear leaves other accounts and models
  untouched.

Full plan and open follow-ups (the single-authority `canTakeWork` refactor, the
declared `provider_chain` failover order, the UI "has room" badge rewrite):
`docs/plans/2026-11-19-multi-account-multi-provider-redesign.md`.

## Acceptance scenario

- **Seed:** Cache an Opus refusal on `hey@tejas.nyc` with resetAt in the future. Leave
  Sonnet and Haiku with no cached refusal. Record a fresh reading for the same account
  with every window under 100% and a different reset time. Sign the same account into
  both the live root and a per-account folder. Replay a stream with
  `rate_limit_event { status: "allowed" }` and a `<synthetic>` "weekly limit" text.
- **Action:** Dispatch a Sonnet turn for this account. Then run
  `router-actions.sh usage-clear claude --account hey@tejas.nyc --model claude-opus-5-5`.
- **Expected:**
  - The Sonnet turn dispatches: the Opus cache is scoped to Opus; Sonnet is not blocked.
  - The next reading loop retires the Opus cache (reading contradicts cache).
  - `accounts.validate` returns `resolution:"unique"` for `hey@tejas.nyc` and never
    `"ambiguous"` from the mirrored live-root sign-in.
  - The parser does not cache a refusal from the allowed+synthetic stream; it logs
    `claude_synthetic_overridden_by_structured_event` with the synthetic excerpt.
  - The `usage-clear` call reports `cleared: 1` and leaves Sonnet's (empty) scope alone.
- **Replayable offline:** yes (every check is a function-level test; the stream parser
  check needs a recorded Anthropic stream fixture).
