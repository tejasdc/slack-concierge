# Codex usage limit is account-scoped (2026-09-15)

A same-provider Codex model fallback, mirroring the shipped Claude usage
fallback, cannot work. The Claude chain moves between models on one account and
fires because Claude's limit is per-model. The Codex allowance is account-wide,
so every Codex model draws on the same exhausted balance and a Codex-to-Codex
fallback could never trigger. This record holds the evidence, the resulting
inventory of lost work, and why replay-based recovery does not reach most of it.

This extends [the provider dispatch and usage-fallback audit](2026-09-15-provider-dispatch-fallback-audit.md),
which listed "Codex-side model fallback" as not implemented without establishing
whether it was implementable.

## Evidence that the limit is account-scoped

Four independent observations, all taken on 2026-09-15 while the allowance was
exhausted.

**Every configured Codex model is refused with one identical reset instant.**
Each of the three models in the alias table was probed directly through the
Codex CLI with a trivial prompt:

| Probed model | Outcome | Reset instant in the error |
| --- | --- | --- |
| `gpt-6-astra` (default) | refused | Sep 22nd, 2026 12:58 AM |
| `gpt-5.6-luna` (`cx-fast`) | refused | Sep 22nd, 2026 12:58 AM |
| `gpt-5.6-terra` (`cx-medium`) | refused | Sep 22nd, 2026 12:58 AM |

A per-model limit would produce independent reset instants. One shared instant
across three models is a single balance.

**The reset instant moves forward as usage is consumed.** Failures recorded at
04:53 UTC carry "try again at Sep 19th, 2026 8:35 AM". Failures from 06:28 UTC
onward carry "Sep 22nd, 2026 12:58 AM". A single rolling allowance was being
drawn down further during the day, pushing its own recovery point out.

**There is exactly one billing path.** Codex authenticates as `auth_mode:
chatgpt` against a single account id, with no `OPENAI_API_KEY` configured. The
error's remediation is to purchase credits on an account settings page. There is
no second, separately metered Codex credential to fall back onto.

**The contrast with Claude is live and observable.** At the same moment,
`claude-fable-5-1` returns "You're out of usage credits. Switch to another
model", while `claude-opus-5` answers normally. Claude's own error text
prescribes a model switch; Codex's prescribes a purchase. The session that
produced this document was itself running on the Claude Opus fallback.

Conclusion: do not build a Codex-to-Codex usage fallback. It cannot fire.

## What was lost

Eleven turns ended undelivered from Codex usage exhaustion, with
`delivery_status` still `not_ready` and no final reply. Ten are user requests;
one is a Grafana machine alert. They span eight sessions across `#slack-concierge`
and `#thinkering`. Eight of them died between 04:53:13 and 04:53:59 UTC, as one
allowance boundary was crossed by everything in flight at once.

A twelfth undelivered turn, from 2026-09-14 in the Concierge DM, failed on
Claude credit exhaustion rather than Codex, and is counted separately.

## Why replay-based recovery does not reach most of it

Recovery by re-dispatch requires that the turn's input still be safely
replayable. Two independent conditions block that for most of these turns.

**Delivered steering makes replay unsafe.** Eight of the ten user turns had
steering already accepted by the provider, one with thirty-nine such messages
and another with twenty. The lifecycle treats a turn with delivered steering as
unsafe to replay, because the provider already acted on input that a replay
would reissue.

**Unreplayable attachments block cross-provider continuation.** Four of the
eight sessions carry attachments Concierge cannot replay, covering five of the
eleven turns. This is the same refusal that prevented routing the follow-up
request as a cross-provider continuation of the original thread.

Only two turns are clean on both counts.

This is the substantive finding. The Claude fallback rescues a turn *because it
switches model inside the live native conversation*, needing no replay at all.
No cross-provider mechanism can offer that, because a different provider cannot
adopt another provider's native session. So a Codex-to-Claude fallback at
failure time would have rescued two of today's eleven turns, not eleven.

## Why the failures read as silent

Each failed turn did project an attention-required edit onto its existing
progress message, and those projections were delivered. None produced a final
reply, and none is recoverable through App Home's Retry control, because that
control requires a turn in `parked` state. All of these ended as `error`.

The database has never recorded a single `parked` turn. Turns that fail after
tool activity, or with delivered steering, deliberately bypass the
preserve-and-park path precisely because replaying them is unsafe. Parking is
reserved for failures observed before the turn did anything. A mid-flight quota
death is therefore, by design, not replayable and not retryable — the work is
genuinely unrecoverable rather than merely unretried.

## Options that remain open

None of these is implemented. They are recorded so the choice is not re-derived.

- **Pre-flight routing.** Treat a known-exhausted provider as unavailable at
  admission and start the turn on the other provider, before any tool activity.
  This is the only option that prevents mid-flight death rather than reacting to
  it, and it fires reliably. It needs a cheap liveness signal and a cached
  exhaustion state with an expiry, and it changes which provider new work runs
  on until the allowance resets.
- **Cross-provider fallback at failure time.** Convert a usage-limit failure
  into a linked Claude continuation. Bounded by the replay constraints above;
  it would have covered two of eleven turns today.
- **Purchase Codex credits.** Restores the status quo immediately with no code
  change, and leaves the failure mode intact for the next exhaustion.
- **Loud terminal failure.** Keep the provider unchanged but deliver quota death
  as a real final reply in-thread rather than an edit to a progress message, so
  the loss is visible when it happens.

Pre-flight routing and loud terminal failure address the stated requirement —
that quota exhaustion stop silently losing work — from the two different
directions of prevention and disclosure. The other two do not.
