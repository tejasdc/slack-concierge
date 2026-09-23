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
agents use, 30 seconds after start and every three minutes, into `provider_account_usage`.
The providers read (`/auth/providers`) returns it as `usage`, and Thinkering's Provider
accounts dialog displays it. Nothing here gates dispatch — but since 2026-09-23 it is no
longer only a display: every reading is kept (`provider_usage_readings`), forecast
(`provider-usage-forecast.ts`) and told to whoever needs it. See "Seeing it coming" below.
Readings tighten to every minute once a window on the account in use is more than about
halfway spent, because two samples cannot draw a line through a five-hour window;
`startProviderUsageWatch` owns that cadence and both runtime compositions start it.

Three minutes, not the original thirty: half an hour was chosen when these numbers only
decorated a dialog, and a five-hour window can go from comfortable to spent inside one pass,
so he was reading a number that had already stopped being true ("30 minutes is not going to
cut it", 2026-09-23). It is affordable because a reading is local and cheap — measured on
the box, a full pass over both Codex accounts and the Claude list is **3.0 seconds**, 1.65%
of a three-minute interval. **No reading is a model call, so none of this spends the
allowance it reports**; the cost is one short-lived process and one HTTPS request per
account against each provider's limits endpoint.

A credential change reads immediately rather than waiting for the next pass, because an
account that has just been signed in or switched to has no reading at all and the surface
would show it with nothing under it. `refreshing` on that payload says a read is running,
so the surface can name the state instead of leaving a gap. One pass runs at a time; the
timer, a credential change and his Refresh press all share it.

**Refresh reads.** `providerAuthStatus()` awaits `scheduleProviderAccountUsageRefresh()`
alongside the identity reads, so the payload it returns carries numbers fetched during that
press. Until 2026-09-23 it refreshed only *who was signed in* and returned whatever the
half-hourly pass had last written, so pressing Refresh changed no percentage on the screen
and read as a dead control: "I just pressed refresh and it doesn't seem to be working at
all." A press while a pass is already running joins that pass instead of starting a second.

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
  `cswap list` answers from claude-swap's own usage cache and will serve a reading minutes
  old without going to claude.ai, so tightening our interval alone changed nothing for
  Claude — measured on the box, `list` reported 18% while the account was really at 25%.
  Each pass therefore asks for `cswap status --json` first, which fetches the active account
  and writes that cache, and reads the list after it. The active account is the one being
  spent, so it is the one whose number has to be right; the rest are idle and barely move.
  **The Mac has no `cswap` installed**, so its Concierge reads no Claude usage at all and
  says so rather than showing numbers. Installing it there is the one outstanding gap in
  "every account on both machines".

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


## Which account a conversation runs on

`bot/src/provider-account-choice.ts` holds the rule, as a pure function with no ledger,
provider, clock or file system in it, so it can be read and exercised against real readings
without launching anything. The wiring that finds the homes and sets the environment belongs
to the launcher and is not built yet; what is settled is the rule and the constraint under it.

**A conversation moves between accounts, because its history is shared.** It could not until
2026-09-23: a transcript lived only in the home it was created in, and a resume elsewhere did
not lose context, it failed to start (`No conversation found with session ID: 802095ed-…`,
exit 1). Each extra account's home now borrows the default home's `projects/` by symlink —
the default stays a real directory that nothing moves, so the transcript archive, the Mac's
five-minute push and the episodic index keep reading exactly what they read before. Proven
the same evening: session `74077648-…` was started under `tejastej.dc@gmail.com`, resumed
under `tejas@chann.app`, and recalled the token planted in its first turn, with both
credentials byte-identical afterwards and nothing signed in or out. Two accounts also
answered concurrently, one per home.

So the account is decided **fresh at every dispatch**:

1. Only accounts this machine can actually launch as are candidates — one with its own home,
   or the default login. An account with neither is unreachable, because reaching it would
   mean writing over the shared credential, which is the thing that broke on 2026-09-22.
2. A conversation prefers the account it last ran on and keeps it while that account has room.
   Staying is free, and a conversation that hops accounts for no reason makes his usage harder
   to read.
3. When its account has no room it **moves**, and continues there with its context. This is
   "never wait for a refill while another account has room", and it is behaviour rather than a
   goal only because continuation is proven.
4. A new conversation goes to the candidate with the most room in its tightest window.
5. Only a **banked release** is bound: it exists to spend one named account's allowance before
   it lapses, so landing elsewhere spends the wrong subscription and lapses the allowance
   anyway. It waits instead. `provider-account-choice.ts` carries that as one bound-account
   concept, agreed with the session that designed banking.
6. Nothing is ever swapped underneath a running process. The choice happens at dispatch.

Running out mid-turn needs no new machinery: the turn fails with the provider's usage refusal
carrying its reset instant, returns to its own queue, and the next attempt re-runs the choice
and lands on an account with room.

## One account, one credential, one place

A Claude account used to be kept in two shapes for two readers: a snapshot under
`~/.claude/auth-profiles/<id>.json` for the Accounts surface, and — once dispatch launches a
turn against an account by pointing the process at that account's home — a credential in
`~/.claude-accounts/<id>/`. Two places for one refresh token means whichever refreshes first
invalidates the other, which is how a live account is lost.

So Claude now works the way Codex already did: **the account's home is the credential**, and
both the Accounts surface and dispatch read that one place. `installedAccounts` lists homes
for both providers; `saveProfile` keeps into a home for both.

**What moves.** Each `auth-profiles/<id>.json` moves to `~/.claude-accounts/<id>/.credentials.json`,
and its `<id>.email` sidecar to `<home>/.account-email`. By **rename, not copy** — at no
instant do two live copies exist. It happens inside `adoptLegacyClaudeProfiles`, called from
the read path, so it can never run before the code that understands it: a move done by hand
could land while the previous release was still reading the old path, and the account would
vanish from his Accounts screen until the next deployment.

**What the Accounts surface does afterwards.** Exactly what it did: lists every account with
its address and usage, and switches the machine onto one when he presses it. It reads the home
instead of the snapshot, which is invisible from the screen. The in-app sign-in already covers
both machines — the auth routes take a `machine` and a call for the peer is forwarded over the
peer channel — so adding an account to the box is a step he takes in Thinkering, never a
terminal command on a machine he is not sitting at.

**How to undo it.** Move `<home>/.credentials.json` back to `auth-profiles/<id>.json`. Nothing
stopped reading that path — `managedProfiles` still lists it, and a managed profile still wins
a name collision — so reverting the code alone restores the previous behaviour once the file
is back.

**An account this machine cannot name is not offered.** A Claude credential carries no address,
so a home whose name matches no known address is skipped rather than listed: switching to an
unnamed credential is how he was nearly moved onto the wrong account on 2026-09-22. The box
holds exactly such a leftover — `~/.claude-accounts/second/`, a week-old copy of the *Gmail*
account from an experiment — and it stays invisible without anything being deleted. Codex
credentials name themselves and need no such filter.

History is shared the same way on both machines: `~/.claude-accounts/<id>/projects` is a
symlink to `~/.claude/projects`, which stays a real directory.


## Seeing it coming

A wall that is announced only when it is hit costs an evening; on 2026-09-22 it cost one.
The readings above already described that outage while it was happening and nothing read
them back, because they were built for a screen. Now:

- **The forecast** (`provider-usage-forecast.ts`) keeps each reading per account and window
  and projects exhaustion. Where the provider projects a window itself — it does for the
  weekly allowance — that number is used as given (`source: "provider"`). The five-hour
  window, which the provider does not project and which is the one that broke, is a straight
  line through this machine's samples since that window began (`source: "observed"`). Samples
  from a spent window are dropped: a reset shows up as a fall in percentage or a changed
  reset instant, and mixing the two would flatten the line. Every forecast carries its
  source, sample count, span and rate so nobody has to trust it blindly, and no surface ever
  states a countdown — a rate cannot promise a time and agent work arrives in bursts.
- **Tejas is told** before it happens, once per window per allowance period, through the same
  `provider_outage` event the hold notice uses, so it needs no provider turn and no router.
- **`router-actions.sh sessions usage`** answers the same question for any caller: the
  account in use, the closest wall with its basis, the accounts with room, every window's
  forecast. A read; it recommends nothing and changes nothing. The Inbox router uses it to
  choose where new work goes.
- **Running sessions are told** (`usagePressureBrief`, `briefRunningSessions`). A turn that
  starts while the account is low reads it in its own per-turn context for free. A turn
  already under way is told inside that run, pinned to the exact live run with
  `delivery:'steer'` so it can never start a turn on an idle session — a notice about
  spending must not itself spend — once per session per allowance period. It names the
  numbers, names which *other* provider has room, says that nothing about the session is
  being changed, and asks whether work with a fixed acceptance criterion could be handed
  down. Tejas's rule that a running session keeps its own model binding is unchanged: this
  informs, it never switches.

Automatic account switching is deliberately **not** built; the design, and the two unproven
things it depends on, are in
[the plan](../plans/2026-09-23-usage-forecast-and-account-switching.md).

## Banked resets, so none of them lapses unused

OpenAI occasionally grants a Codex account a **rate limit reset** it can bank and spend when
it chooses. Both of his accounts were carrying one, granted 2026-09-22 and expiring
2026-10-22, and nothing had ever mentioned either: the half-hourly reading already carried
them and the field was dropped on the floor. A grant lapses **thirty days after it is
granted, with no refund**, so one that is never mentioned is simply lost — which is what he
asked to stop ("at the very least we should not let them go to waste", 2026-09-23).

Where it comes from, in order of authority:

| Source | Call | Gives |
| --- | --- | --- |
| Codex app-server (first party) | `account/rateLimits/read` | `rateLimitResetCredits.availableCount` and per-credit `id`, `status`, `grantedAt`, `expiresAt` |
| Codex app-server | `account/rateLimitResetCredit/consume` | Redeems one. Outcomes include `nothingToReset` and `alreadyRedeemed` |
| CodexBar | `usage.codexResetCredits` | The same grants, already in the reading this file takes every three minutes |

`provider-account-usage.ts` maps the CodexBar block into `AccountUsage.resetCredits`, keeping
only credits whose `status` is `available` and the expiry that falls first. That costs no new
call, no new tool and no new credential — the bytes were already arriving.

**A grant belongs to an account, not to a machine.** The same two credit ids appear on the
box and on the Mac, so either instance can see and redeem them, and redeeming on one makes
the other's next reading show `availableCount: 0` on its own.

**One is spent automatically when work has actually stopped.** Tejas reversed the original
"nothing ever spends one for you" on 2026-09-23: "if you're running low and I'm not awake
and I'm asleep, or especially if both our accounts are running low, feel free to use the
usage. You don't have to wait for me to reset the usage." The rule is
`decideAutomaticReset` in `bot/src/provider-reset-policy.ts`, deliberately a pure function
with no ledger, provider or clock, so it can be read and exercised on its own without
spending a grant.

It fires from the hold path in `turn-execution.ts` — the moment a usage refusal actually
held accepted work — and needs all of:

| Condition | Why |
| --- | --- |
| Work has really stopped, not a forecast | Observed fact rather than a prediction, and the moment a reset is worth the most: spending one earlier discards whatever is left in the window it replaces. |
| No other account of that provider has room | The work has somewhere to go, so a finite grant should not be burned. His "especially if both our accounts are running low" is this condition failing. |
| A reset is still available on the blocked account | Only that account's own reset can unblock it, so there is no choice to make between accounts; several on one account are offered soonest-expiry first. |
| Codex | Anthropic publishes no per-account list of grants to spend. |

**Whether he has acted is never inferred, and neither is whether he is asleep.** The only
thing read is whether a grant is still there at the instant work stopped. If he already
spent it there is nothing to spend; if he has not, waiting for him to wake is the stall he
asked us to end. There is no presence model anywhere in this.

**One reset can never be spent twice.** Within an instance, the decision is recorded under
an event id keyed to the exact hold episode *before* the attempt, so a second observer is
refused by SQLite rather than by timing, and a crash mid-call cannot produce a second try.
Across machines the provider is the lock: both instances can see the same exhausted account,
and `consume` answers `alreadyRedeemed`, which is treated as "someone already did it" and
not as a failure. Nothing tries to decide which machine goes first, because the only
authority on whether a grant still exists is OpenAI.

Afterwards the account is re-read, the work that was waiting on that reset instant is
released with `releaseUsageHeldWork` (only the scheduled instant moves; nothing is
replayed), and one notice says which account, why, how much work carried on and how many
resets are left. There is deliberately no "about to use one" step before it: the hour-ahead
forecast notice already exists, and adding a wait for acknowledgement would be the stall
this removes. The Accounts button stays for when he wants to spend one himself.

He is told in two places, and they are deliberately different events:

- **Running low, and a reset is waiting.** `resetCredit` rides on the existing hold and
  forecast notices in `provider-usage-notice.ts` rather than arriving as a second alert about
  the same moment — the message that already interrupts him to say he is running out is the
  one that should carry the way out of it. Only the account actually being spent is offered,
  because a reset on an account he is not using answers nothing about the wall in front of him.
- **About to lapse, whatever else is happening.** `publishExpiringResetNotices` watches the
  expiry itself, across *every* account, and fires once at seven days left and once at two.
  The forecast notice only fires under pressure, and a grant can expire during a quiet
  fortnight in which nothing ever gets close to a limit; this is why the guarantee holds
  rather than usually holding. Two milestones, each keyed by the expiry instant, so the pass
  that runs every three minutes cannot turn a deadline into a drumbeat.

**Anthropic has no equivalent to read.** Claude has the idea — its own copy offers "Use your
limit reset to reset it now" and its account config carries an entitlement cache — but that
cache records `available: false, eligible: false, granted: false` and there is no per-account
list of grants with ids, grant times and expiries the way OpenAI publishes one. So nothing
here infers a Claude grant. If that cache is ever observed turning true, it becomes a real
source; until then treating it as one would be guessing.
