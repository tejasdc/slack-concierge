# Provider usage reset cache

Concierge remembers an actual usage refusal and its provider-reported reset instant
in the existing SQLite ledger. The shared implementation is `bot/src/provider-usage.ts`;
the Codex and Claude adapters consult it immediately before starting provider work.
It does not select a different provider or own session recovery.

## Scope and evidence

The operating profile has one configured account per provider. Each provider has one
`provider_usage_cache` row: Codex has one `account` entry shared by all models; Claude
has entries for exact canonical model IDs. The legacy Fable ID resolves through the
alias authority to the same usage entry. Clear the provider cache when changing its
configured account as well as after an early allowance reset.

- Codex retains absolute epoch seconds from `account/rateLimits/updated` or the legacy
  `token_count` rate-limit payload. It records a blocking entry only after the actual
  usage-limit error, using future reset times from exhausted primary/secondary windows.
  When the shared App Server supplied no usable stream timestamp, that error triggers
  one `account/rateLimits/read` metadata request. An unavailable read retains an unknown
  reset; it never starts another model request. Non-Codex quota buckets are ignored.
- Claude retains `rate_limit_event.rate_limit_info.resetsAt` from a rejected usage event,
  paired with the owned turn's usage failure and the currently attempted model. An
  allowed/warning event alone cannot mark a model unavailable.
- Both adapters normalize provider epoch seconds to absolute milliseconds. They do not
  parse timezone-less error prose. The observed Codex error text uses account-local
  America/New_York time, which cannot safely be treated as UTC or host time.
- Missing or expired reset evidence remains nonblocking. In particular, the observed
  Fable credit error supplied no timestamp. Its normal fallback still runs; this change
  does not invent a cooldown or indefinitely disable Fable from that message alone.

The [Codex incident](../incidents/2026-09-15-codex-usage-limit-scope.md) records the
account-wide evidence. Protocol references are the provider's
[rate-limit notification](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/AccountRateLimitsUpdatedNotification.ts),
[account read](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountRateLimitsResponse.ts),
and Anthropic's [native event examples](https://github.com/anthropics/claude-agent-sdk-python/blob/main/tests/test_rate_limit_event_repro.py).

## Dispatch and invalidation

A known exhausted Claude model is skipped within the existing configured Claude chain,
with visible progress naming the skipped model and reset instant. The requested preferred
model stays unchanged. Actual provider model reporting remains authoritative. If every
candidate is cached unavailable, the request is refused before any provider call. Codex
receives the same visible refusal at account scope; selecting another Codex model cannot
bypass it. No cross-provider substitution is introduced.

That refusal **holds the input rather than ending it**, whenever the provider stated when
its allowance returns. The refusal carries that instant as `clearsAtMs`
(`provider-failures.ts`), `turn-execution.ts` classifies it as retryable, and the turn
returns to its own queue with `dispatch_next_attempt_ms` set to the reset. Every existing
effect-safety check still gates it unchanged — no tool activity, no artifact activity, no
unsafe steering, and either nothing admitted or a provider-confirmed terminal failure — so
nothing with an uncertain effect is ever re-queued. A refusal with no stated reset stays
terminal, because there is nothing to wait for and a wait is never guessed.

Until 2026-09-23 the refusal was plainly terminal. One five-hour Claude limit at 23:51 UTC
on 2026-09-22 destroyed nine of the Inbox's accepted inputs in 43 seconds — seven of them
the returns that were reporting the outage — the allowance came back at 00:30 with nothing
left to resume, and Tejas discovered it at 02:14 by asking what had happened to his
threads. See [the incident](../incidents/2026-09-22-usage-limit-silent-stop.md).

This boundary covers native new inputs, resumes, queued/automated turns, consultations,
and retained comparison/review paths that call these adapters. History-only forks/reads
consume no model turn and stay available. A legacy Claude fork that omits a model can
record quota only after native initialization identifies it; preflight skipping requires
an explicit model. Direct external CLI invocations outside these adapters do not use
Concierge's cache. Existing dispatch provenance and comparison counterpart selection
remain with their owners.

The chosen early invalidation mechanism is **explicit clear**. It is available from the
operator shell even when neither model can run. From the Concierge repository, with
`CONCIERGE_STATE_DIR` set to the owning runtime's existing state directory:

```bash
bun bot/scripts/provider-usage.ts status
bun bot/scripts/provider-usage.ts clear codex
bun bot/scripts/provider-usage.ts clear claude-code
```

Clear requires an operator-requested top-up/reset/account change; an agent must not clear
the cache merely to force another attempt at a known exhausted provider. It clears that
provider's entries atomically and advances its generation. Already-running attempts retain
their original generation, so a late error from before the clear cannot restore stale
limits. A successful attempt can retire only observations that existed when it began;
an old success cannot erase a newer failure. Changed reset dates or utilization percentages
alone are not proof that an account is usable.

| Condition | Running work | Queued and later work |
| --- | --- | --- |
| Cache correctly says exhausted | Continues under its existing owner | Uses eligible Claude fallbacks, else waits in its own queue for the reported reset |
| Manual top-up makes cache stale | Clear does not interrupt it or replay it | Clear permits the next attempt immediately and releases work waiting on that reset |
| Another account is activated | Not interrupted or replayed | Work waiting on the old account's reset is released (`provider-activation.ts`) |
| Cache says available but provider is exhausted | Actual refusal preserves existing terminal/continuity behavior and updates the cache | Next dispatch consults the new observation |
| Reported reset passes | No action against running turns | The queue's own deadline timer wakes at that instant and the held turn runs |
| Exhausted with no reported reset | Unchanged | Terminal, as before; there is nothing to wait for |

Clear, activation and expiry never resume stopped, archived, cancelled or ambiguous work,
and they replay nothing: only a queued input's own next-attempt instant moves. A turn that
already failed terminally still requires the existing explicit retry/new-input action, and
ordinary queued work follows its existing FIFO.

A reset instant hours away needs someone to come back for it, so the turn queue arms a
timer at the soonest `dispatch_next_attempt_ms` after every pump
(`session-turn-queue.ts`, `state.ts` `nextQueuedTurnAttemptMs`). Both compositions wire it:
the Slack-enabled runtime in `index.ts`, which also polls every 60 seconds, and the
native-only runtime in `session-runtime.ts`, which has no poll at all and before this
change could leave a scheduled retry waiting indefinitely on a quiet machine.

## Cost, persistence and visibility

There is no poller, probe loop, worker or idle work. Lookup is one small existing-ledger
read per candidate; quota failure/success/clear are short SQLite transactions. Storage is
one entry per model with observed exhaustion plus the one Codex account entry. Expired
entries are ignored immediately and removed on subsequent writes; unknown entries remain
diagnostic until a successful attempt or clear. Cache-write failure is logged without
changing an already-completed provider result or replacing its original error.

Structured events report `provider_usage_exhausted`, `provider_usage_cached_skip`,
`provider_usage_cached_refusal`, `provider_usage_cleared`, `provider_usage_hold_released`,
`provider_usage_hold_notified`, `provider_usage_reset_unavailable`
and `provider_usage_cache_write_failed`. Fields contain provider/model identity and reset
metadata, never prompts, credentials, account identifiers or raw provider errors.

## Telling him his account has stopped

A hold is invisible unless someone says so, and the session that would normally say it runs
on the provider that is refusing. So `provider-usage-notice.ts` publishes one durable
`provider_outage` owner event the moment a usage refusal actually blocks accepted work, on
the session whose input was held. Thinkering already turns that event into a notification on
his phone through its notification courier, with no provider turn and no router session
involved — which is what the 2026-09-22 outage needed, because every Claude path was the
broken thing.

One notice per episode, not per input: the allowance belongs to the account, so the reset
instant identifies the episode and the ledger's unique event id deduplicates it. The payload
carries a `usage` object — the reset instant, how many inputs are waiting on it, and which
other accounts had room at the last half-hourly reading — and offers no model alternatives,
because every model on an exhausted account is equally out. Thinkering renders that object
with its own words (`attention-notifications.ts`); the ordinary outage wording is unchanged.
Nothing switches by itself: changing account remains his tap in Provider accounts.

This change was inspected against source and the existing incident evidence. No tests,
provider probes or sandbox traffic were run or added, under the current delivery policy.
Tejas owns end-to-end acceptance.

## Usage limits for every account

The cache above records refusals. Separately, `bot/src/provider-account-usage.ts` reads the
current usage windows (headroom, reset time, pace) of **every** account, not only the one
agents use, 30 seconds after start and every 30 minutes, into `provider_account_usage`.
The providers read (`/auth/providers`) returns it as `usage`, and Thinkering's Provider
accounts dialog displays it. Nothing here gates dispatch.

A credential change reads immediately rather than waiting for the next pass, because an
account that has just been signed in or switched to has no reading at all and the surface
would show it with nothing under it. `refreshing` on that payload says a read is running,
so the surface can name the state instead of leaving a gap. One pass runs at a time; the
timer and a credential change share it.

- **Codex**: the agents' home `~/.codex` plus one home per extra account under
  `~/.codex-accounts/<name>/`, each read by CodexBar (`/root/tools/codexbar-cli/codexbar`)
  with its own `CODEX_HOME`. CodexBar reads with the stored access token and never refreshes
  or rewrites credentials. Sign an extra account into its own empty home with
  `CODEX_HOME=~/.codex-accounts/<name> codex login --device-auth`; never sign in inside
  `~/.codex`, because device login deletes that home's `auth.json` first, and OpenAI can
  revoke a stored token when another account signs into the same home
  ([openai/codex#31162](https://github.com/openai/codex/issues/31162)).
- **Claude**: [claude-swap](https://github.com/realiti4/claude-swap) (`~/.local/bin/cswap`,
  installed with `uv tool install claude-swap`) holds each account and reads its usage
  without switching. Add an extra account by signing it into its own config folder,
  `CLAUDE_CONFIG_DIR=~/.claude-accounts/<name> claude auth login`, then
  `CLAUDE_CONFIG_DIR=~/.claude-accounts/<name> cswap add`. Never `/logout`; that can
  revoke the account being left.

`~/.codex/retired-auth/` holds logins that have been superseded, moved there on
2026-09-18 when the per-account homes above replaced the old `~/.codex/auth.json.<name>`
convention. Nothing reads it. Treat everything in it as dead: a stored token is revoked
once the account signs in again anywhere, so an archived copy is evidence of what the
machine used to hold, never a credential to restore. Verified on 2026-09-22, when the
week-old copy of an account answered `refresh_token_invalidated`.

What each action destroys, which is the part that gets forgotten:

| Action | Active login `~/.codex/auth.json` | Per-account home | Retired archive |
| --- | --- | --- | --- |
| Sign in **inside `~/.codex`** | deleted first, then replaced | untouched | untouched |
| Sign in into its own home | untouched | created or replaced | untouched |
| Switch to a kept account | replaced by a copy of that home | untouched | untouched |

The first row is the dangerous one and it is not reversible: the account that was in
`~/.codex` loses the only live token the machine had for it, and OpenAI can revoke that
token outright because another account signed into the same home. On 2026-09-22 a sign-in
through Thinkering's Accounts screen did exactly this, and the account that left could no
longer be read at all — its usage disappeared from the screen and its archived copy was
already revoked. The rule against it was written here before that feature was built, and
the feature was built without reading it.

Never sign an account into `~/.codex`; never delete or hand-edit a per-account home, since
each one is the only live token for its account; never present anything in `retired-auth`
as recoverable.

A missing tool or unreadable account yields an empty list or a per-account problem, never
a failed providers read.
