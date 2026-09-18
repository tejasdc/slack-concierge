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
candidate is cached unavailable, the request receives a confirmed, terminal refusal before
any provider call. Codex receives the same visible refusal at account scope; selecting
another Codex model cannot bypass it. No cross-provider substitution is introduced.

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
| Cache correctly says exhausted | Continues under its existing owner | Uses eligible Claude fallbacks or visibly fails before dispatch |
| Manual top-up makes cache stale | Clear does not interrupt it or replay it | Clear permits the next attempt immediately |
| Cache says available but provider is exhausted | Actual refusal preserves existing terminal/continuity behavior and updates the cache | Next dispatch consults the new observation |
| Reported reset passes | No action against running turns | Entry stops blocking on the next lookup |

Clear and expiry never resume stopped, archived, failed, or ambiguous work. Failed input
requires the existing explicit retry/new-input action; ordinary queued work follows its
existing FIFO. No timer schedules replay at the reset date.

## Cost, persistence and visibility

There is no poller, probe loop, worker or idle work. Lookup is one small existing-ledger
read per candidate; quota failure/success/clear are short SQLite transactions. Storage is
one entry per model with observed exhaustion plus the one Codex account entry. Expired
entries are ignored immediately and removed on subsequent writes; unknown entries remain
diagnostic until a successful attempt or clear. Cache-write failure is logged without
changing an already-completed provider result or replacing its original error.

Structured events report `provider_usage_exhausted`, `provider_usage_cached_skip`,
`provider_usage_cached_refusal`, `provider_usage_cleared`, `provider_usage_reset_unavailable`
and `provider_usage_cache_write_failed`. Fields contain provider/model identity and reset
metadata, never prompts, credentials, account identifiers or raw provider errors.

This change was inspected against source and the existing incident evidence. No tests,
provider probes or sandbox traffic were run or added, under the current delivery policy.
Tejas owns end-to-end acceptance.

## Usage limits for every account

The cache above records refusals. Separately, `bot/src/provider-account-usage.ts` reads the
current usage windows (headroom, reset time, pace) of **every** account, not only the one
agents use, 30 seconds after start and every 30 minutes, into `provider_account_usage`.
The providers read (`/auth/providers`) returns it as `usage`, and Thinkering's Provider
accounts dialog displays it. Nothing here gates dispatch.

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

A missing tool or unreadable account yields an empty list or a per-account problem, never
a failed providers read.
