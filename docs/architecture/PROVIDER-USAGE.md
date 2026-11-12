# Provider usage reset cache

The [current provider state flow](PROVIDER-STATE-FLOW.md) joins this evidence and the session owner into one operator map. Historical notice descriptions below are corrected at the affected sections for the November 3 incident.

Concierge remembers an actual usage refusal and its provider-reported reset instant
in the existing SQLite ledger. The shared implementation is `bot/src/provider-usage.ts`;
the Codex and Claude adapters consult it immediately before starting provider work.
It does not select a different provider or own session recovery.

## Scope and evidence

The existing cache keeps one row per provider. Codex scopes refusals to its account;
Claude scopes them to the chosen account and exact canonical model. The legacy Fable ID
resolves through the alias authority to the same usage entry. A one-home Claude
installation retains its previous cache scope and dispatch behavior.

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

The chosen early invalidation mechanism is **explicit check**. The Accounts window's Refresh
press asks each reachable machine to try at most one small, tool-free provider turn on its selected account
and exact model of its oldest usage-held work. This trial bypasses only its own cached refusal;
the normal queue and other models keep their holds. A successful provider answer releases only
waiting turns for that proved model and account; a usage refusal keeps the hold, and an unrelated
failure is reported as unconfirmed. The result names the checked account, model and number of
released turns. A usage percentage is not proof, since it read zero while Claude refused real
work on 2026-10-10. The check also covers a usage hold created by a percentage reading before
any provider refusal has been cached, and a continuation with no reset instant. If a check has
not finished in one minute, Concierge requests cancellation, waits briefly for settlement, and
keeps the work held; a still-running check prevents another one on that machine. For a proved
Claude account whose usage bar still reads 100%, only the exact released turns carry one-use
admission proof into account selection. Their first dispatch uses that same proved account;
the proof is consumed then and
disappears on a service restart; an unrelated turn still follows the ordinary reading.
Opening Accounts and the ordinary background usage readings never spend model tokens or override a refusal. A successful
Codex reset-credit use on the account running agents also clears its old refusal and wakes held
work as part of that action. The operator shell remains available for recovery even when the
app cannot open. From the Concierge repository, with
`CONCIERGE_STATE_DIR` set to the owning runtime's existing state directory:

```bash
bun bot/scripts/provider-usage.ts status
bun bot/scripts/provider-usage.ts clear codex
bun bot/scripts/provider-usage.ts clear claude-code
```

Shell clear requires an operator-requested top-up/reset/account change; an agent must not clear
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

## One allowance per Claude model, and every proof of room releases every hold

Usage limits and holds name the allowance a model spends (`claudeUsageAllowanceModel`), not its
alias: Claude Code's extended-window Opus (`opus[1m]`, the Inbox's model) and Opus 5.5 are one
scope. In-turn model fallback still uses the exact model, so the Inbox does not start falling back to
Sonnet. A sign-in, a switch or a background account check whose credentials answer releases
usage-held turns and refused turns' continuations alike; before 2026-11-03 it released only the
former, and continuations waited for a usage reading showing room, which an account the usage
reader cannot read never produces. On 2026-11-03 the Inbox's captures stayed held 35 minutes after
a new account was signed in and proven, while an Accounts check released only Opus 5.5's holds,
until a Concierge restart's startup check ran it. Record:
`docs/incidents/2026-11-03-inbox-held-after-new-account.md`.

## Sign-in holds

An authentication refusal is held without a guessed reset time when the provider confirmed
the turn ended, and the adapter observed no assistant content or tool use. The existing
dispatch safety checks still exclude unsafe steering, artifact activity and ambiguous
admission. The input remains queued at the head of its own session with its original
identity; later inputs cannot pass it. Its receipt says the account cannot sign in and
will resume automatically.

The existing credential activation path releases these holds only after the selected
account answers a small real request. Owner sign-in, account add and switch call
activation directly. Directory filesystem events watch the login credential names;
on the Mac, a login Keychain file event also probes a held Claude account. A Codex
activation deferred behind running work is retried when execution changes after
the last running Codex turn. Startup probes held work once. A three-minute check
runs only while authentication-held work exists as a temporary fallback for
external sign-ins. Each release records `released_by` as `owner_signin`,
`file_event`, `keychain_event`, `turn_finished`, `startup` or `interval` in the
structured log and in a companion resolution event for the one-time outage
notice. An `interval` release proves a missing event path. Remove the fallback
only after real external sign-ins on both machines release real held work through
events within seconds; the required browser approval and expired login cannot be
simulated by this change. Codex activation
also restarts its App Server when no turns are running, because that server keeps its
credential in memory. A failed activation leaves the queue untouched. Claude's macOS
Keychain login uses the existing sign-in activation path and Keychain change event.

A signed-out account gets one renewal request to the Mac's browser agent per episode
(`bot/src/signin-renewal.ts`). After the agent answers failed, no new request goes out for
that account for six hours from when Concierge first sees that answer (neither request table
records when an answer arrived, and a sleeping Mac can answer hours late, so the first sighting
is stamped in `signin_renewal_failures`): on 2026-11-03 Claude refused the approval with
"Couldn't verify your browser" and the old half-hour episode sent a second request 30 minutes
later, switching his Chrome's claude.ai account again. A needs_decision answer does not hold,
because it asks him to fix Chrome's own sign-in and a renewal should follow once he has. While
the last stored reading shows a Claude account's weekly allowance used up with its reset more
than an hour away, no renewal starts at all, because signing in gives it no room; the background
check asks again within the hour before the reset. Codex is not deferred this way, because a
Codex account at 100% can still run on credits or spend a banked reset. The agent is told to switch
the provider site in his Chrome back to the account it found there when it finishes or gives
up, and not to approve again after a browser-verification refusal.

A usage reading with room is not an account this machine can run: the usage reader holds its own
copy of each login, so a home whose login is signed out still reads as having room. One answer,
`claudeAccountLaunchableHere`, says whether this machine can launch an account now (a proven home,
or the selected one not just refused; a home whose latest check or turn found it signed out stays
out until a check passes). The usage hold notice names only launchable accounts as where work
moves, and lists the rest as `accountsNeedingSignIn`. It also carries `movesAutomatically`, the
same answer the usage warnings carry, and `machine`, so thnkr.ing promises a move only when this
rule makes one and never keeps a copy of the rule. The Claude-to-Codex transfer at an allowance
wall does not run while an account with room only needs a sign-in: the work stays held in the
session it was sent to. The renewal request a Mac sends its own browser agent names the Mac's
login, never the server's. Before 2026-11-02 it said "the server's" from both machines, so the
agent renewed the server's healthy login, reported success, and the Mac's stayed signed out; the
notice promised the work would move to that account, and his 7:28 PM message moved to a Codex
session instead while he was signing in. Record:
`docs/incidents/2026-11-02-mac-signin-wait-read-as-usage.md`.

The Inbox router keeps one canonical role across providers. When its current provider has no
launchable allowance and another provider has a launchable account with room, a confirmed
usage-held Inbox turn can propose the existing session handoff even if a later input is queued
or the refused attempt recorded admission intent. The successor accepts an exact inventory;
only then does the role move and safe queued inputs retain their original source and request
identity. An ambiguous or acknowledged input blocks acceptance. A fresh reading showing room
on the current provider instead releases its held work there; a provider reset does not switch
an already running conversation in place. The generic Claude recovery excludes Inbox because
it cannot own this canonical role transfer.

The first held input of an episode records one internal `provider_hold_observed` event with an
`auth` payload: account, machine and number of held inputs. It does not itself push a
notification. The sign-in renewal path asks Tejas only when the Mac browser agent cannot
restore the login without him. This does not replay turns that reached
assistant output or tools. The September 23 expired-sign-in incident left six Inbox
inputs terminal despite Claude only writing their input to its transcript; those six
are handled separately by the Inbox and are not migrated or replayed by this change.

**A Claude account's expired sign-in on the server is renewed by the Mac, not by him**
(Tejas, 2026-10-08, capture c7274372). When an account's own home is refused for its sign-in,
by a turn, the background account check or a Switch, `signin-renewal.ts` records one
`claude_signin_expired` repair notice per account per episode (none while an earlier one is
undelivered, under half an hour old, or its Mac request is unanswered). Delivering it, the owner
sends the Mac's browser agent a work request as the repair agent, with no provider turn first,
because the repair agent may itself be held by the same expired login. The Mac agent drives his
Chrome through thnkr.ing Accounts' own sign-in, so the link and one-time code pass page to page
and never enter a message or this ledger, and the account check plus the ordinary release then
frees held work. The repair agent reaches him only if Chrome's own claude.ai sign-in expired.
Usage exhaustion never triggers it: an account out of room is moved off automatically.
Codex is renewed the same way (`codex_signin_expired`): a Codex turn refused for its sign-in, or any
account whose usage reading says its sign-in stopped working, sends the Mac agent to start that
account's device sign-in from Accounts and enter the code at OpenAI in his Chrome. The Mac renews its own accounts the
same way: there the browser agent is a session of the same instance, so the owner sends it the
request through the outside-agent entrance (`signin-renewal`), and the agent itself declares
needs_you when only he can act, since no session reads that request's answer.

**Codex moves off a spent account by itself.** Codex runs every turn on one shared login, so it cannot
choose per turn as Claude does. Instead the owner checks once a minute and whenever execution changes:
when the account whose login is on disk has spent any window in the latest reading, another kept
account has room in every window, and no Codex turn is running, it puts the least-used such account in
use through the Accounts switch (move the login, restart the App Server, prove it renews), which
releases work held for the spent account's reset. A failed move is not retried for that account for
fifteen minutes.

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

## Showing a held message without an unnecessary phone notice

A hold remains visible on the accepted message's session receipt. The owner also records one
durable `provider_hold_observed` diagnostic event for an allowance or authentication episode.
That event does not produce a phone outage or Needs attention item: a reset or usable account
can release the work without Tejas. If only he can complete sign-in or make a decision, the
repair path raises that exact need. The prior raw `provider_outage` delivery let a transient
agent consult claim Tejas had a waiting message on November 3.

One notice per episode, not per input: the allowance belongs to the account, so the reset
instant identifies the episode and the ledger's unique event id deduplicates it. The payload
carries a `usage` object — the reset instant, how many inputs are waiting on it, and which
other accounts had room on this machine — and offers no model alternatives, because an
account-wide allowance cannot be bypassed by picking another model. A reset is a recheck,
not an unconditional start promise.
A running process never changes account. A later Claude turn may launch from another
account's own home when it has room; no shared credential is replaced.

The November 3 replay procedure and live release checks are tracked in the [incident](../incidents/2026-11-03-withdrawn-mac-consult-usage-notice.md).

## Usage limits for every account

Claude accounts are read from two places: claude-swap's managed list, and every account home
Concierge keeps (`listProfiles`), read from that home's own login when claude-swap does not list it.
Each machine also discovers the other machine's Claude accounts on every usage refresh, even
when all local readings succeed. The peer's account label and source time can trigger local
sign-in repair for a held turn, but they do not prove a runnable local credential home.
Signing in through Accounts files a home but never adds it to claude-swap (adding copies the login,
which dies the first time the original renews), so before 2026-11-03 such an account was missing from
every reading: hey@tejas.nyc read as absent, and nothing that waits for room could see it.
A provider runner's own reader (`runner-provider-account-readings.ts`, used once account custody moved
to runners on 2026-11-05) follows the same rule: after claude-swap's list it reads every signed-in
runner home it does not list from that home's own login, and shows "Usage could not be read." when
that read fails; it still reads those homes when claude-swap is missing or fails. Until 2026-11-12 it
skipped them, so hey@tejas.nyc vanished again (`docs/incidents/2026-11-12-runner-usage-reader-missed-account.md`).
When a peer supplies newer usage for an account on both machines, the receiving machine keeps its
own sign-in verdict. A server reading can fill the Mac's bars for a signed-out home, but cannot turn
that Mac home into a signed-in profile. Dispatch rejects the local signed-out verdict before
the selected account's usual attempt is allowed. The peer source and original read time remain
visible on the usage reading.
Record: `docs/incidents/2026-11-03-usage-reader-missed-new-account.md`. Each account read from its own login (also the fallback when claude-swap's copy has died) is asked at most every five minutes, inside the six minutes a reading counts as fresh, doubling the gap after a failure up to thirty minutes. If an idle home's access token has expired, the reader asks Claude Code's local `/usage` command to renew that home's own login without a model turn; the reader does not copy or refresh credentials itself. One renewal per account runs at a time, and an unsuccessful unchanged login backs off from five to thirty minutes. A changed credential file bypasses the earlier failed-read wait so the next usage pass can use it. Between reads or after a failure the reader keeps its last good windows with the time they were taken, so a 429 never blanks it.

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

**Refresh reads.** A `fresh` read of `/auth/providers` starts
`scheduleProviderAccountUsageRefresh(true)` alongside the identity reads (`claude auth status`,
the Codex sign-in state) and answers at once from the last known state with `checking` set;
the Accounts page reads again every few seconds while any row or machine says `checking`
or `refreshing` (a peer machine says `checking` only while a read of it is outstanding), so the numbers fetched for that press arrive on screen without a read waiting
for them. Until 2026-09-23 it refreshed only *who was signed in* and returned whatever the
half-hourly pass had last written, so pressing Refresh changed no percentage on the screen
and read as a dead control: "I just pressed refresh and it doesn't seem to be working at
all." From then until 2026-11-03 a fresh read waited for the whole check, 11 to 20 seconds
around a sign-in, which held the account row's confirmation spinner that long. A press
while an ordinary pass is already running queues one forced pass after it. The owner keeps
`checking` true until the forced pass settles; the Accounts Refresh mark stays active while
the page watches that state. A press during a forced pass joins that same pass.

- **Codex**: the agents' home `~/.codex` plus one home per extra account under
  `~/.codex-accounts/<name>/`, each read by CodexBar (`/root/tools/codexbar-cli/codexbar`)
  with its own `CODEX_HOME`. CodexBar reads with the stored access token and never refreshes
  or rewrites credentials. If a saved account's token has expired, Concierge asks Codex's
  own App Server in that saved home to renew it, one process per account at a time, then
  refreshes the usage reading. The read cannot count the old usage as room while renewal
  runs. An explicit revoked or reused refresh token is marked signed out and enters
  the existing sign-in repair. Three transport or startup failures against an unchanged
  login back off before the reader reports renewal unavailable without claiming that
  Codex refused the login; a changed login can be tried again.
  Sign an extra account into its own empty home with
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
  `cswap list --json` checks every managed account due under claude-swap's shared
  per-account poll plan, then returns its account-specific source fetch time. An older
  value can remain on screen after a failed or delayed fetch; Concierge retains that
  original time and treats the value as historical once its decision limit passes.
  The tool can space idle or exhausted accounts up to ten minutes apart to respect
  the usage endpoint's request budget, so a six-minute decision may temporarily
  lack fresh evidence for one of them; another scan cannot turn that into fresh data.
  `cswap status --json` checks only the terminal-active account and is not used here:
  a Concierge turn may run on another saved home without changing terminal selection.
  When claude-swap returns `lastGoodUsage` instead of decision-grade `usage`, Concierge
  pairs it with `lastGoodFetchedAt`, never the outer scan time. A Mac Refresh asks its
  local Keychain logins for a new reading even inside the ordinary five-minute read gap;
  it joins a running pass, then takes a fresh pass if that pass was periodic.
  On the Mac, Claude Code keeps each account's only login in its GUI Keychain. Concierge
  asks Claude Code to confirm each saved home's signed-in email and configuration directory,
  then reads that home's local Keychain item and asks Anthropic's usage endpoint with its
  access token. Keychain item presence alone does not prove that Claude still accepts the
  login: a signed-out home is shown as needing sign-in and its usage is not requested or
  renewed. An unanswered or mismatched identity check is shown as unverified and cannot
  authorize work. Concierge never copies or writes the login; if a confirmed home's token
  expires or Anthropic rejects it with 401, Claude Code's local `/usage` renews that same
  home's Keychain item. A pressed Refresh waits for renewal, and a rejected-token read
  retries once after renewal before it settles.
  The same five-minute per-account read plan and failure backoff apply. A failed read keeps
  the last good Mac value with its original source time. A signed-out home has no usage bars.
  The Mac no longer substitutes a server reading for a missing local one; such a peer value
  cannot prove that the Mac can run the account.
  This replaces the Mac's former peer-only display, which omitted Mac-only accounts and
  could show days-old server numbers after a Mac Refresh. On November 6 a Mac-local probe
  found two saved homes whose initial usage requests returned 401; Claude Code renewed
  each without a model turn, and subsequent usage and profile requests returned 200 with
  matching account emails. A third saved home still reported signed out and was not renewed.
  The Mac's two-home continuation and concurrent use were proven on 2026-09-23;
  see [the shared-history design](../plans/2026-09-23-accounts-share-one-history.md).

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
| Switch to a kept account | moved back to its own home; the kept login moved in | its login moved out, the outgoing one moved in; anything already there set aside as `auth.json.superseded-<time>` | untouched |

A switch **moves** logins; it never copies them (2026-09-29). It used to copy the kept home's
login into `~/.codex` and skip saving the outgoing one whenever a stale home for that account
already existed. The daemon renews on start, so each copy it ran on left the home copy spent:
on 2026-09-29 a switch put the spent `tejas@chann.app` copy in place (OpenAI answered
`refresh_token_reused`) and overwrote the working gmail login, whose older home copy was spent
the same way on 2026-09-22. Both server Codex logins were lost, while the panel said
"Switched". Now `moveCodexAccountIntoUse` moves the live login home and the kept login in, the
daemon restarts, and the switch succeeds only when the running daemon answers
`account/read {refreshToken:true}` as that account. Otherwise both logins are moved back and
the daemon restarted onto the previous one, and the row offers a sign-in. The account in use
therefore has no `auth.json` in its home while it is in use; `~/.codex` is its one copy.
Reading the Accounts list no longer snapshots the login in use, and `saveProfile` refuses.
A switch is refused while a Codex turn is running on this machine. The post-restart account
probe uses the shared bounded retry primitive and its own 45-second, three-attempt policy;
temporary socket startup failures never create an unbounded or ad hoc retry loop.

An agent acting on Tejas's work request uses `router-actions.sh sessions auth switch codex
<saved-profile-id>` (or `--machine mac`) with its exact source input, run and stable action ID.
This enters the same guarded switch as Accounts while retaining the agent's authorship and
an operation receipt. It cannot borrow an information-only consultation's authority. A
duplicate action returns its retained result; if a process died during the switch, it
reports an uncertain result for inspection rather than moving the credentials twice.
The command does not override the running-Codex-turn guard or sign in an expired account;
the saved home must be renewed through Codex itself before the guarded switch can succeed.
The guarded move also refuses while any saved Codex login on the machine is renewing,
and renewal does not start while a switch is moving credentials. Both the incoming
and outgoing login can move into saved homes, so the exclusion covers the machine.

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

**What Accounts says (2026-10-07).** Each provider's message names the account in use and why:
for Claude, his choice, and when that account is at its limit, where new work runs until its
reset. The Codex login in use (the agents' own home) is listed as its own row marked in use. A
Codex sign-in is filed into the account's existing home, found by the account its login names,
so signing the same account in twice never lists it twice. A Codex switch whose restart fails
says so ("could not be restarted"), naming an App Server started outside its manager, instead of
blaming the account's sign-in; from Oct 4 to Oct 7 an unmanaged listener made every Codex switch
fail that way, repaired per the App Server runbook.

For Claude, `bot/src/provider-account-choice.ts` owns the pure rule. At dispatch, the owner joins its
cached per-account usage with the default login and extra homes whose `projects` directory
resolves to the shared Claude history. A machine with no such extra home keeps the previous
launch path. Each new process gets the selected home's `CLAUDE_CONFIG_DIR`; no credential
file changes and a running process keeps the home it started with.

**A sign-in typed by hand never moves agents** (`claudeRunsFromOwnHomes` in
`provider-account-dispatch.ts`). Once this machine keeps any Claude account in a home of its
own, agents never run on the main folder's login (`~/.claude/.credentials.json`): it belongs to
whoever typed `claude auth login` or `/login` in a terminal, and that command replaces the login
that was there with no copy kept. At 19:31 UTC on 2026-10-07 a hand sign-in as tejas@chann.app
replaced his personal account that way, and agents silently lost it. Now every account runs from
its own home, the selected one without waiting for a background proof (it was proven when chosen),
and when none can run the turn is held for a sign-in rather than falling back to the main folder.
Accounts no longer lists the main folder's login as an account and says nothing about it: a terminal
sign-in is not his work, and the line naming it was removed on 2026-10-08 as news about nothing.
The account line above the list is empty while the chosen account is in use; it speaks only when
that account is at its limit, signed out, or none is selected.
The Mac also keeps separate saved homes, with each login in the Keychain. A usage reading that
fails or is missing for the selected account does not alone prove its login is unusable;
the local reader confirms sign-in separately, and a real limit still comes back from Claude
as an ordinary usage hold. The last account is
recorded only when Claude reports that the process started. Each main-conversation response with
usage also retains its account, conversation ID, response ID and receipt time in that session's
metadata. The next ordinary turn stays on that account when its last response is within the
main conversation's one-hour cache lifetime and the account still has usable room. Anthropic
isolates prompt caches between organizations; in the 48 hours before this change, 133 account
changes accompanied 68.2 million rewritten tokens, and all 14 sampled changes within 50 minutes
were cold. Keeping an eligible warm account avoids sacrificing that prefix to spend a different
weekly allowance. A fresh Accounts selection still wins the next turn, a banked turn stays bound
to its saved account, and a cached usage refusal makes an account ineligible. When the prefix is
cold, the chooser again ranks usable accounts by weekly allowance lapse pressure and uses the
previous account to break equal-room ties. That ranking preserves weekly room: at
07:22 Eastern on 2026-10-10 Inbox stayed on an account with about 13% weekly room even though
another launchable account had about 83%, because the older rule always preferred its last
account while it had any room. The session view exposes the actual account; an account event
records the choice reason for diagnosis without announcing it. A confirmed usage refusal on one
account is cached under
that account, allowing a safe queued retry to choose another immediately. When none has
room, the existing timed usage hold keeps the input for the earliest readable reset.
The observed failure and replayable boundary are in
[warm Claude conversation moved accounts](../incidents/2026-10-23-warm-claude-conversation-moved-accounts.md).

State boundary: the session owner is the single writer for the last-call marker and account
choice. A response ID identifies the observation; a turn ID identifies the dispatch attempt.
The provider's response establishes a possible warm prefix, while a transcript usage record
establishes what was actually read or rewritten. If a response is not recorded, a process restarts,
the conversation ID changes, or the marker expires, dispatch uses the existing cold ranking.
Older readers ignore the optional metadata. The falsifying sequence is a warm call on account A
while account B has higher lapse pressure: A must win with room, B must win when A has no room,
and a bound banked turn must remain bound. The focused chooser check exercises that sequence;
installed usage figures measure the resulting cache behavior.
"None has room" is a claim about readings and refusals only. A reading older than six minutes
is unknown, not full: when no freshly read account has room, a launchable account whose last
reading was good when taken and showed room, with no cached refusal, is tried, and Claude's own
refusal excludes it if it is spent. Each usage reading releases held work by that same rule
(`claudeHeldWorkCanRun`), so a hold made while the account looked unreadable does not wait for a
reading the release check alone would accept. On a Mac, a Keychain lookup that times out or cannot be asked is not "no login"; only
`security`'s item-not-found answer (exit 44) is, and an unanswered lookup is logged as
`claude_keychain_lookup_unanswered`. Filing a finished sign-in still requires the login to be
found. Both closed the 2026-10-15 hold that kept his personal account (19% of its week) out of
the Mac's choice and held work "until October 18" on the spent tejas@chann.app account.
Each fresh Claude usage reading also asks the actual dispatch chooser whether an account can
run. If one can, the owner releases only queued usage holds and wakes the queue; it does not
move time-based retries for unrelated failures. This matters when a five-hour limit on one
account clears before the longer reset time assigned while every account was exhausted.

**Whether an account is out, and until when, has one answer** (`accountAvailability` in
`provider-usage-forecast.ts`): per readable account on this machine, whether it has room now and,
if not, `freeAt`, the latest reset among its spent windows or the reset Claude stated when it last
refused it. Accounts only the peer could read, and unreadable ones, never count as room. Every
reader takes it from there: `accountsWithRoom` (every account with room, the selected one
included; it once left the selected one out and read empty while that account had room),
`accountsWithRoomBesides` (for warnings and the reset policy), dispatch's all-spent reset, and the
hold. A usage hold waits until the first launchable account frees up
(`claudeEveryAccountClearsAt`), not the refusing account's own reset, and each reading moves held
work earlier when a reading shows an account frees sooner (`moveUsageHoldsEarlier`); the held line
says "No Claude account has room until X, when the first one frees up". On 2026-10-09 a held
message said every Claude account was out until Oct 11 at 11 PM, which was tejas@chann.app's weekly
reset alone, while tejastej.dc@gmail.com refilled at 11:20 PM. The hold notice payload also carries
`accounts`: each account with `hasRoom` and `freeAt`.

**A refusal ends when a reading proves a reset.** A Claude refusal recorded against an account was
cleared only by a successful run on that account, and none is tried while it stands, so a reset the
provider granted early could never be noticed: on 2026-10-10 the Mac held every Claude job "until Oct
11, 11 PM" for a chann.app refusal his 2:05 AM reset had already ended. Each reading now forgets an
account's refusals when that account shows every window below 100% and some window lower than its last
reading before the refusal (`usageFellSince`); usage only falls on a reset, so a reading that merely lags
a refusal never clears it. Each machine's own Claude usage readings determine its room;
the Mac reads its saved Keychain homes locally. After a switch the owner re-reads usage at once, and the switch result says
whether the account answered its test request or refused it as out of usage; the app shows that sentence.

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

For Claude, the account is decided **fresh at every dispatch**:

1. Only accounts this machine can actually launch as are candidates — one with its own home,
   or the default login. An account with neither is unreachable, because reaching it would
   mean writing over the shared credential, which is the thing that broke on 2026-09-22.
2. A fresh selection in Accounts wins the next turn if that account can run. Afterwards every
   ordinary turn goes to the eligible account with the most primary weekly room. All of its
   windows must have room; a full five-hour window makes it ineligible. If a weekly reading is
   unavailable, its tightest readable window is used for ranking. Equal weekly room keeps the
   previous account, avoiding a needless hop. This uses the roomier weekly allowance after a
   reset instead of continuing to spend a nearly exhausted week.
3. A conversation **moves** when another eligible account has more room, and continues there
   with its context. This can happen before the former account is completely spent because
   continuation across homes has been proven.
4. A new conversation also goes to the eligible account with the most primary weekly room.
5. Only a **banked release** is bound: it exists to spend one named account's allowance before
   it lapses, so landing elsewhere spends the wrong subscription and lapses the allowance
   anyway. `provider-account-choice.ts` carries this rule.
6. Nothing is ever swapped underneath a running process. The choice happens at dispatch.

For Codex, every turn uses the shared App Server. A banked turn can select only its currently
signed-in account; other Codex accounts still have usage readings and can be selected through
Accounts, which moves the login after running turns finish. There is no per-turn Codex home.
Ordinary turns and scheduled firings without a saved account binding use that current login at
their next dispatch. A fresh reading with room, a completed account switch, or a confirmed reset
therefore releases their queued usage holds; the queue still enforces each scheduled firing's
original fire time. Banked turns remain bound to the account and allowance window they saved.
On 2026-11-06 the hourly overnight checkpoint's 14:00 firing waited for a spent account's
November 12 reset even after the shared App Server moved to a personal account with room:
the release path excluded every saved turn, including an unbound schedule. The Accounts
tool-free retry had a separate stale session-column name and could not recover that hold either.
See [the failure record](../incidents/2026-11-06-unbound-schedule-stayed-usage-held.md).

Running out mid-turn needs no new machinery: the turn fails with the provider's usage refusal
carrying its reset instant and returns to its own queue. The next Claude attempt re-runs its
account choice; a Codex attempt waits for the shared App Server's account or an Accounts switch.

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

**What the Accounts surface does afterwards.** It lists every account with its address and
usage. Pressing a Claude account records which home new work should launch from; it never
copies that home's credential into the default login. The choice is durable, and the next
turn uses it as a preference before ordinary room-based account choice resumes. The default
login is selectable without an override. The current-account mark follows this choice,
not the credential sitting in the default home. Codex still uses its existing activation.
The in-app sign-in already covers
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
The in-app Claude Switch action creates that link when an older account home lacks it,
then verifies that it resolves to the default history before recording the choice.
An existing path pointing elsewhere is preserved and the switch is refused. This
does not change either account's credential or a running Claude process.

The old Claude snapshot operation is refused, and reading or pressing an account no longer
calls the outgoing-account snapshot path. The one-home dispatch path and Codex activation
remain unchanged. A Claude press releases a usage hold only when the selected account has
a readable usage window with room; the ordinary effect-safety gate still controls retry.

**Signing a Claude account in never touches a login that is already here** (2026-09-29).
"Sign in to another account" used to run `claude auth login` against `~/.claude`, the login
every Claude session runs on, and a saved account whose login had lapsed had no repair: its
Switch was refused with "sign in to that account again" and nothing could. The cause of that
lapse, from the server's records: `claude-swap` (the usage reader) keeps its own copy of each
account and renewed `tejas@chann.app` on 2026-09-23 18:09 and 2026-09-29 10:11 (its log);
`~/.claude-accounts/tejas-chann-app` was a copy of that same login, so the first renewal
killed it (the switch probe failed from 2026-09-23 21:29 on), and Claude then emptied its
tokens. `claude-account-login.ts` now signs in inside a fresh `~/.claude-accounts/.signing-in-*`
folder (`--email` prefilled when started from an account's row), asks Claude whose login it
is, and moves only `.credentials.json` and `.claude.json` into that account's home (an older
one is set aside), so the account holds its own independent login. It then switches through
the same probe as the Switch button. Signing in as a different account than the row pressed
keeps that login and switches nothing. Each kept account reports `signedIn`: false when its
login has no renewal key, so the panel offers that account's sign-in instead of Switch; a
switch refused for authentication returns `needsSignIn` with the same effect. On the Mac,
where Claude keeps logins in the Keychain rather than a file, this sign-in reports that it
could not finish rather than filing anything.

The Mac proof established both continuation across homes and simultaneous spending on two
Claude accounts. The sign-in itself has since run for real on the server: the runner's
sign-in record carries a completed Claude sign-in at 2026-11-07T01:45:36Z, and
`~/.claude-accounts/tejastej-dc-gmail-com/.credentials.json` was rewritten at that second
with the previous login set aside as `.credentials.json.superseded-1794015936337`. So the
independent-login design is observed, not only designed. Codex's equivalent is dated
2026-11-06T18:09:41Z, the first credential filed into a newly created home.


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
- **Running-low readings stay in Accounts.** The older 90% warning and combined Claude/Codex
  warning were valid under Tejas's October 8 decision [decision: usage-notice-only-at-90-percent],
  which replaced noisy pace warnings. His November 3 decision [decision: provider-account-notices-only-when-action-needed] superseded that threshold:
  no routine usage, provider, or account notice should reach him unless he must act. Existing
  warning threads are closed on the next usage pass. Forecasts remain available in Accounts
  and through `sessions usage`; they do not gate dispatch. A banked reset approaching expiry
  remains a separate notice when using it before it lapses requires his decision.
- **`router-actions.sh sessions usage`** answers the same question for any caller: the
  account in use, the closest wall with its basis, the accounts with room, every window's
  forecast. A read; it recommends nothing and changes nothing. The Inbox router uses it to
  choose where new work goes.
- **Running sessions are told** (`briefRunningSessions`). A turn that
  starts while its account has a fresh measured window at or above 90% reads it in its own per-turn context for free. A turn
  already under way is told inside that run, pinned to the exact live run with
  `delivery:'steer'` so it can never start a turn on an idle session — a notice about
  spending must not itself spend — once per session, account and allowance period. It names
  the machine, account, window, measured percentage and observation time. A stale reading,
  earlier refusal or forecast cannot trigger it. A separate dispatch check determines whether
  Codex has room for an independent helper; the running session keeps its model binding.

Account choice at the next dispatch does not change the login of a running process. The
earlier credential-switching proposal in
[the plan](../plans/2026-09-23-usage-forecast-and-account-switching.md) is historical.

## A grant is spent only against a spent weekly allowance

Tejas cancelled the pre-expiry spend on 2026-10-08, hours after it shipped: "Obviously we're
gonna reset only after we completely consume the entire fucking thing. We're not resetting
before hundred percent dude … we only use actual resets for the whole weekly consumption …
please do not build any sort of spending reset on whatever before it expires at all." The
72-hour at-risk window, the 60%-used threshold, the last-8-hours override and the
`sessions reset-credit` command an agent could call are all removed; nothing spends a grant
because it is about to lapse, and no agent can ask for one to be spent.

`decideAutomaticReset` now requires, on top of the conditions it always had (work genuinely
held, no other account of that provider with room, a grant on the blocked account):

- the blocked account's **weekly** allowance fully used; **or**
- his one exception — the five-hour window exhausted while the weekly is **at or above 95%**,
  because a full reset clears both and at that point almost the whole week comes back with
  it. "Almost" is 95% deliberately: the cost of being wrong is a grant that cannot be got
  back, so at 95% a reset forfeits at most a twentieth of the week, where 90% would throw
  away a tenth — most of a day's allowance.

**A five-hour wall never spends a grant.** It does not need to: that window refills within
hours on its own, the held work already carries the instant it clears, and the queue brings
it back then. Confirmed in production rather than from this document — `provider_usage_hold_released`
fired three times in the 36 hours to 2026-10-08, releasing 6, 7 and 3 pieces of held work,
the latest at 06:54 UTC, with no grant involved in any of them.

**An unreadable window refuses.** The blocked account's windows are matched by what the
provider calls them, and a window this cannot identify stays null; null never argues for
spending, so when the weekly state cannot be established the answer is no. The five-hour
window is frequently absent from the Codex reading altogether, which is why only the weekly
one is required.

The stored CodexBar row is an early screen, never authorization to spend a finite credit.
Before automatic use, Concierge reads each other saved Codex home directly. Its verified
account ID, blocked ordinary included allowance, and an exact spent Codex five-hour or
weekly window must all agree. An unreadable home or one with possible room declines the
automatic spend. It then rereads the target home last and requires the same account ID,
blocked ordinary included allowance, the exact spent weekly window (or the 95% weekly
exception with a spent five-hour window), and a matching available grant. These direct
observations expire after 60 seconds or their first window reset, whichever comes first.
The attempt is durably reserved only after this preflight, immediately before the consume
request in the same initialized App Server session as the final target read; a preflight
decline before reservation does not mark the episode spent. A retained hold is reconsidered
on an existing wake or a manual action, not by a new polling loop. This is intentionally
stricter than ordinary attempt policy because spending a grant is irreversible.

The installed Codex App Server's raw primary/secondary positions did not match a fixed
five-hour/weekly naming assumption in the 2026-10-14 read. CodexBar normalized that observed
response to a weekly secondary window correctly. Concierge now names Codex windows from
CodexBar's actual `windowMinutes` value and retains `usage.updatedAt` as the source time;
this is a defensive normalization change, not evidence that the live Accounts bar was mislabeled.
The reset-credit block has its own provider fetch context and may have a different age from
the included-allowance bar. Refreshing one does not prove the other fresh; a direct limits
read confirms a grant before automatic redemption.
The installed 0.162.0 [App Server handler](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/app-server/src/request_processors/account_processor.rs)
handles each limits RPC by asking its [backend client](https://github.com/openai/codex/blob/rust-v0.162.0/codex-rs/backend-client/src/client/rate_limit_resets.rs)
for a new HTTP GET to the account usage endpoint; it does not answer from its own stored bar.
The response does not expose the backend's original measurement timestamp, so a new GET
cannot prove the remote service did not itself serve a cached value. Missing or elapsed
window reset instants still decline finite spending.

The installed Codex App Server (0.162.0, generated protocol checked 2026-10-14;
[upstream account contract](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs))
requires an idempotency key as well as a credit id for a
consume attempt. The automatic hold episode supplies that key; an Accounts button press
generates one for its request. The response has four explicit outcomes: `reset` and
`alreadyRedeemed` confirm that attempt redeemed a credit, while `nothingToReset` and
`noCredit` did not. A transport failure or unrecognized response is unknown, never
success or proof that nothing was spent. The current response names no individual
windows; the grant's `reset_type` remains its declared scope. After confirmed redemption,
Concierge reads limits again through the same account home. Both readings must carry the
same nonempty account ID as that home's sign-in; a missing or changed ID never proves
that the named account recovered. Only a matching fresh read saying ordinary included
work is allowed invalidates that account's old refusal, preserving a per-account ordering
marker so an earlier in-flight failure cannot restore it while another account's refusal
can still be recorded. A refusal recorded after the confirming limits read begins, including
while its HTTP request is in flight, is never cleared
by that read. Only ordinary held work on the active Codex login becomes
eligible to retry. If the selected login changed meanwhile, redemption is still reported,
with zero work made eligible. Eligibility is not provider admission or completed work. A read-only probe of
the installed server on 2026-10-14 confirmed that its limits response supplies an
account ID matching the local sign-in and a boolean `ordinaryUsageAllowed`; no credit
was consumed by that probe.
If redemption is confirmed but the read fails or still denies ordinary work, the credit
is reported redeemed and the work stays held. The Accounts button retains its two-press
confirmation.

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

**One hold episode cannot automatically spend twice.** Within an instance, the attempt
is recorded after preflight and before the consume request, so a second observer is refused by SQLite. The episode
is also the consume request's idempotency key. A crash or ambiguous transport response
never causes an automatic second attempt. Across machines, OpenAI owns the credit state;
`alreadyRedeemed` means the *same key* previously completed a reset. It does not prove
that another machine's differently keyed attempt succeeded.

After confirmed redemption and a fresh account read permitting ordinary work, only that
account's cached refusal is invalidated. Ordinary held work on the active login can then become eligible to
retry; nothing is replayed without the normal queue. The notice reports the count made
eligible, including zero, and the remaining grant count only when the direct postread
confirmed it. Unknown and redeemed-but-unverified
outcomes leave work held and publish no "reset used" notice. There is deliberately no
"about to use one" step before it: the hour-ahead
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

**Anthropic's resets exist, but Concierge cannot see them.** Anthropic occasionally offers a
"limit reset" to eligible plans, pressed as "Reset for free" in claude.ai Settings > Usage on the
web or desktop app and on the limit-reached message (not in Claude Code), and Tejas used one on
2026-10-13. There is no per-account list of them with ids, grant times and expiries the way
OpenAI publishes one: the usage endpoint carries nothing about an offer (checked against the raw
reply the same day), so nothing here infers a Claude grant or spends one. What a reset does, and
when it is worth pressing, is the next section.


## What a reset does, and when it is worth using

Tejas, 2026-10-13, after resetting tejastej.dc@gmail.com at 12:50 PM ET: "I thought the reset
would reset the timing, but apparently it doesn't. For that account, the weekly reset was
Wednesday 4 AM … now I need to use all of it today, by Wednesday 4 AM. So we have maybe 15 hours
to use a whole week's worth of usage … add information in the provider account that I can use to
make the right judgment on when to reset. And the agents should have this information too."

The facts, in `bot/src/provider-reset-facts.ts` (`RESET_FACTS`, read by him on the Accounts page
and by agents through `sessions usage` and their budget brief):

| Provider | What a reset restores | What happens to the clock | Source |
| --- | --- | --- | --- |
| Claude | The five-hour or the weekly limit it was offered for, back to full; cannot be undone; works before a limit is hit; expires on the offer's date | **Nothing.** "Your weekly limits still reset on their usual day and time." | support.claude.com 17007452 (What is a limit reset?), 11049741 (Max plan) |
| Codex (banked grant) | The consume response confirms whether a grant redeemed, without naming individual windows; a fresh limits read shows current room | The clock behavior of a banked grant is not established by this response. The documented purchased weekly reset is a different mechanism. | Codex App Server 0.162.0 generated protocol; help.openai.com 20001507 for purchased weekly resets |

This ledger's own readings of the account he reset (`provider_usage_readings`, 2026-10-13): the
weekly stood at 100% all afternoon with its end at 08:00 UTC on Oct 14; at 16:50 UTC it read 0%
with the **same** end, and the Fable-only weekly fell from 44% to 0% with the same end too. The
five-hour window had been idle at 0% beforehand, so the readings cannot say whether that reset
touched it; Anthropic's words say a reset is for one limit or the other.

So the value of a reset is what it recovers multiplied by the time left to use it, and the
advice is derived from that, per account, at the moment he looks (`resetAdvice`):

| Reading | Advice | Why |
| --- | --- | --- |
| Week at or above 95%, less than 24 h to its end (Claude) | **wait** | The same week arrives on its own in hours; a reset buys a week to be spent in those hours and nothing after |
| Week spent, end far, another account has room | **later** | Work moves to the account with room; a reset recovers nothing that was needed yet |
| Week spent, end far, no other room | **now** | Full value: a whole week with days to use it, and work is otherwise stopped |
| Under 20% used with under 48 h to the end | **spend first** | Nothing to reset; the room lapses at the end, so the automatic choice spends this account first |
| Five-hour wall with the week not spent | **later** | That window refills on its own; a reset would recover only the part of the week already used |
| Anything else | **later / none** | Recovers only the used share of the week, which is not yet worth a finite grant |

The sentence is written once (`withResetAdvice` in `provider-usage-forecast.ts`) and shown in
three places so they cannot disagree: under the account's bars on the Accounts page (both
machines, through the same account rows the Mac borrows), in `sessions usage` as `resetFacts`
and `resetAdvice`, and in the budget brief a running session gets when its account is low.

**The automatic choice spends the allowance that lapses first.** `chooseAccountForTurn` ranks
eligible accounts by `lapsePressure`: percent of weekly room left divided by hours until that
week ends. A freshly reset week with 15 hours to its end (93% ÷ 15 h ≈ 6.3) is used before a
week with 2% room and five days (≈ 0.02), and the 2026-10-10 case still holds: 13% with two days
(0.3) loses to 83% with five (0.7). An unknown end counts as a whole week away, so a missing
date never jumps the queue. Equal pressure keeps the previous account, as before. Exercised on
the day's real readings before shipping: the reset Gmail account won over chann.app at 98%, and
the October 10 pair still chose the roomier account.

## Credits on the accounts page

Tejas, 2026-10-13: "I also added the API credits on my chann.app account, so both accounts should
accrue these API credits … build that into our dashboard too, so we understand how much of the API
credits we're using, if that information is available from the same source we use for the usage
here, or if Anthropic provides it directly."

Two different credits exist, and each Claude account row names both (`bot/src/claude-account-facts.ts`,
read on the same login as the bars, refreshed every thirty minutes because the usage endpoint's
polling budget is shared with claude-swap):

| Credit | What it is | Where it is read | Shown as |
| --- | --- | --- | --- |
| Usage credits | A prepaid balance that carries Claude and Claude Code past a plan limit at API rates (support.claude.com 12429409) | The `spend` block of the same `/api/oauth/usage` reply the bars come from | "Usage credits: off (out of credits); monthly cap $20." |
| Monthly API credits | $100 a month on Max 5x, $200 on Max 20x, granted to one linked Console organization each billing cycle, expiring at its end; API, Managed Agents, Agent SDK and playground only, never Claude Code or app extra usage (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers) | Plan tier and billing day from `/api/oauth/profile`; **no API publishes the credit balance**; spend this cycle from the Admin API's `cost_report` once an Admin API key for that organization is filed by the credential portal at `/root/.local/state/credential-portal/credentials/anthropic-admin-api/<account-slug>.json` | "API credits: $200 a month on Max 20x, in the linked Console organization; $37.12 spent this cycle as of 1:04 PM ET (Anthropic's cost report); renews November 12 at 4:56 AM ET." |

Until a key is filed the line says so and shows what is known (the amount, the plan, the renewal).
The remaining amount is the grant minus that spend only while the organization holds no other
credits; the page says "about … left if nothing else was bought". The Console's own
Settings > Billing > Promotional credits remains the authority for the balance and its expiry.

A Codex row shows the ChatGPT credit balance its own usage reading reports (OpenAI's "Extra usage"
pool, 62,500 granted on 2026-09-30 to the personal Pro account). The reading carries no expiry, so the
line states none. [OpenAI's credit contract](https://help.openai.com/en/articles/12642688)
says eligible Codex work draws from that account's credits after included usage is spent. A
fresh account reading with credits enabled, a positive balance, and its own current credit timestamp therefore keeps that account
eligible for ordinary work despite a full included allowance bar. A newer actual Codex usage
refusal still wins: credits on a screen are not proof that a particular launch succeeded. An
account with no credits cannot borrow another account's balance. A reset used on a saved account
is confirmed by a fresh limits read for that account; Concierge keeps the confirmed result even
when another account is selected, refreshes the account list, and immediately reconsiders the
normal guarded move and held-work release. The Accounts button shows progress and the result.
When OpenAI makes ChatGPT and Codex share one
allowance (announced 2026-10-31, "in the coming weeks"), the same Codex reading will include ChatGPT
use; nothing here counts ChatGPT separately, because a second count would be a second copy of the
provider's meter.

When claude-swap cannot read a Claude account (its own stored copy of the login has died, as the
personal account's did from Oct 23 because claude-swap refreshes copies only from the default
folder), the reader asks Anthropic's usage endpoint with the login in that account's own home,
read-only and never refreshed, and uses those windows. A verified Ultra account reports no
five-hour window there, and the reading is still complete.

## What he is told about accounts, and when he is not

**Nothing, unless work has actually stopped.**

| What happened | What he reads |
| --- | --- |
| A conversation started on the account his work runs on | nothing |
| A conversation stayed where it was | nothing |
| He selected another account and conversations moved onto it | nothing — he did it |
| Its account ran out and it continued on another one | nothing — it kept working |
| **Every usable account is out, so work is waiting** | the held message remains visible in its session; Accounts shows allowance evidence; no automatic phone outage |
| **A banked turn's selected account is out** | it waits, and says so, naming that account |

The first five rows are the account rule doing its job. The final row describes a session
receipt, not a phone notice. A banked release remains in its session and names its bound
account there.

He arrived at that line in four messages on 2026-09-29, each after a narrower fix:

1. A banner named the account each conversation ran on — 33 of them, all naming the account he
   had selected himself: *"We did not change the accounts."*
2. Narrowed to moves only; a move he caused by his own selection still spoke: *"I'm the one who
   fucking selected that. Haven't I? So why are you notifying me that?"*
3. Narrowed to run-outs only: *"What the fuck does it matter for me if you ran on one account or
   not? What matters for me is … we never face an issue of an user is running out."*
4. And the correction that keeps the one that matters: *"I'm not asking you to remove everything.
   Why would you remove run out? … Use some fucking discernment here."*

So the test is **is work affected**, not *did something change*. A switch that worked changed
something and affected nothing.

The choice is still recorded on every turn as an `account` event carrying the account, the reason
(`AccountReason`) and the account that was expected — for diagnosis, with no sentence in it.
`claudeAccountNotice` is retired: written null on every turn so any stored sentence clears, and
removed from the owner's session view; thnkr.ing's banner, its component and its field are gone
(`6c74028`), because a field nothing populates is an invitation to relight it.

## Who used the allowance

Weekly subscription percentages have two meanings. The account's
`weeklyAllowance.usedPercent` is the provider's latest weekly reading, with its
reset and observation time, or `unavailable` when the reading is old or absent.
The per-session, per-topic and repeating-routine `weeklyAllowance.usedPercent`
is an **estimate**. The scanner splits each meter's readings at every weekly
reset, because a seven-day report almost always spans one, and shares each reset
period's percentage rise among the transcript usage inside that period, in
proportion to published API-price weighted tokens. Fifteen-minute buckets keep
raw provider calls on their runner until all runner reports have been merged; a
provider percentage is allocated only once. Claude Fable calls are weighted into
both the all-models weekly meter and the Fable-only meter, because Fable draws
on both; their tokens are still counted once. A conversation outside Concierge
keeps its own bucket key, so each such row on Accounts carries its own share. A
full weekly bar stops allocating at the first observed saturation, because later
calls may spend credits. Weekly readings are kept for eight days by age rather
than by sample count, so the rolling week is covered at any reading cadence;
history from before installation cannot be reconstructed. Each estimate's
coverage reports its from and through instants, the observed percentage change,
covered transcript weight, `uncoveredTranscriptWeighted` with `complete:false`
when part of the work fell outside every measured period (thnkr.ing then shows
the estimate as a lower bound), and the fact that other use of the same account
(the Mac, claude.ai, the phone) is unknown. A missing reading, reset identity,
matching transcript work, or fresh observation produces `unavailable`, never
zero. Different account or model-specific meters remain separate components;
their percentages are not added. A routine row counts only its own scheduled
turns: work it hands to other sessions (the nightly review's fix requests) is
counted under those sessions and threads. The full breakdown carries `byThread`,
`byRoutine` with daily rows, `byDay` and an explicit `unassignedThread`; the
per-id maps `sessionAllowanceById` (keyed by `concierge:<id>`) and
`threadAllowanceById` (keyed by stable topic ID) stay in the cached report for
the visible-row lookup and are left off the breakdown response to keep it under
its size limit. A call is assigned to a topic only when its exact turn input
has a recorded request topic, attached thread link, or topic root; work without
that evidence stays unassigned. Topic and routine rows carry optional display
titles read from the existing owner ledger after runner merge. Existing token
totals and price-proxy `share` fields remain for older clients.

The main Threads and Sessions views read
`GET /sessions/v1/usage/allowance?session=concierge:<id>&topic=<topic-id>` with
repeated keys for up to 100 visible rows total; a larger or malformed request is refused with 400. It selects from the same cached
weekly report and returns only those rows plus `computedAt` and `stale`, never a
transcript scan per row. Accounts reads the same route with `overview=1`,
which adds each account's measured reading and estimated use, the 50 threads
with the largest estimated share (plus `threadCount`), the unassigned row,
every routine with its days, and each day: about 130 KB on the live week. The
complete week breakdown carries every session's token detail and is several
megabytes, past the route's 1 MiB limit, so Accounts does not use it for the
weekly allowance.

The owner serves `GET /sessions/v1/usage/breakdown?period=today|week`; agents get the
same read through `router-actions.sh sessions usage --by-session --period today|week`.
The read now includes `callMix` for all calls, each account, and each session:
total calls, helper and main calls, helper share, and each model's call share.
Each provider response counts once. The reader scans each real transcript
folder once, so account homes whose `projects/` or `sessions/` links to a
shared folder do not repeat it, and the report counts a provider,
conversation and response ID once when a genuine copy of a conversation sits
under another home. Account attribution comes from the ledger's per-turn
account, never from the home a transcript was found under. A forked
conversation that copies parent responses into a new conversation ID is not
merged; none appeared in the 2026-11-12 cache.
It also includes `editMix` at those three levels: recognized code-editing tool
calls split by model and helper versus main conversation. Claude transcript
tool-use IDs and Codex completed-item IDs deduplicate repeated provider records
across transcript copies in different account homes;
Codex child conversations follow their root session. The edit count includes
dedicated edit/write/file-change tools and recognized patch commands. It does
not infer arbitrary writes from every shell command, so it is a lower bound on
all code changes. Calls measure editing actions, not changed files or lines.
For the Accounts dashboard, each account and session also carries `byModel` with
the exact transcript token classes, a published-price weighted total, and the
helper subset of both. Each session carries `byHelper`, keyed by the source
subagent transcript identity and model. Codex child threads are followed to
their root session; Claude Code nested subagent files retain their own helper
identity. These measurements are additive across accounts and projects. The
dashboard groups the existing session project labels across providers, keeps
unknown attribution visible, and shows raw token totals beside the weighted
comparison bars. A call count must never be presented as a token share.
Codex helper transcripts identify their parent thread; nested helpers follow that
chain back to the session. It also counts accepted Fable/Astra escalation events
and accepted agent-shell Astra command starts from the owner's escalation log
by model. This measures model calls, not price or task quality, and the transcript
scanner's `computedAt` bounds freshness.
Today starts at midnight in the owner's saved-work time zone; week means the last
seven days. Each runner reads its provider transcripts incrementally and keeps its
cursor and deduplicated usage records in its own usage cache, never in the owner ledger.
The owner sends only the relevant one-week session, turn, account and prompt-cache facts to
the runner for attribution. The runner computes the account/session report and cache diagnostics
beside its cache; the owner combines runner reports. Raw provider records do not cross the relay
on each refresh. Neither scanner modifies transcripts or holds the owner event loop.
The Mac peer still runs its own native sessions without a configured provider runner. Its
breakdown reader scans the existing local Claude and Codex transcript trees and joins those
calls to a bounded snapshot of its own session ledger. Unknown local account homes remain
unknown in the report; the account allowance reading and dispatch path are separate. Owners
with configured runners continue to use the runner reports, and a non-Mac owner with no
runner refuses the scan instead of silently reading the wrong machine's transcripts.
It runs in the background: every usage reading starts a scan when the last one is over five
minutes old, and a read answers from the latest result with its `computedAt` (only the first
read ever waits for a scan). Until 2026-10-08 it was scanned per read; while the owner
was stalling for other reasons one read took 50 s, the Accounts page gave up at 30 s and told
Tejas the session owner had not answered. The read itself is answered by a read worker, a
separate process, so the latest result is published to `usage-breakdown-latest.json` beside
the ledger and every process serves that file; until 2026-10-30 each worker kept its own empty
copy and its reads each waited about 2 s for a scan. A reader scans itself only when no result
exists or the file is more than fifteen minutes old. `usage_breakdown_refreshed` / `_refresh_failed` log
each scan's duration. Every response includes `computedAt` and `stale`; a result older than
fifteen minutes is marked stale while a new scan is attempted, including when that attempt
fails. The old report remains available for context without claiming it is current.

Shares use published API token prices as an **allowance proxy**, not a claim that a
subscription's five-hour meter is denominated in dollars. The response includes the
prices and sources used, weighted totals, raw token classes, and each consumer's share.
Claude's shared transcript folder cannot reveal the account used by a terminal process;
those conversations appear under an explicit unknown-account bucket. A Concierge turn
without an account event is also unknown rather than assigned by guesswork.

The same read exposes `scheduledFirings` for every repeating firing in the selected
period, including queued and failed firings. Each row identifies its schedule root and
sequence, intended fire time, status, provider wall time, raw token classes and published
API price equivalent. The worker attributes transcript usage only within that turn's
recorded provider start and end, so a queued or still-running firing, missing transcript
records are not reported as zero cost. Missing usage remains `null` with
`usageObserved=false`; an unlisted model uses the report's declared fallback price and
appears in `fallbackModels`. CPU time and peak memory remain `null`: a persistent provider
process and its helpers can span turns, and process totals cannot be honestly assigned to
one firing. This is a read-only projection over the existing turn ledger and transcript
cursor, with no new collector, credential, or effect on dispatch. A five-minute background
refresh means the latest firing may appear before its usage record does.

The same incremental transcript reader also reports cache use. `cacheDiagnostics.calls`
lists the 100 calls with the most rewritten input in the period; `callCount` is the full
number, so a caller can tell when detail was omitted. `cacheDiagnostics.turns` similarly
lists the 100 turns with the most rewritten input and gives the full `turnCount`. The
existing account `bySession` rows contain complete per-session cached and rewritten input
totals, call counts, and flag counts. Cached input is provider-reported cache reads;
rewritten input is uncached input plus cache creation. A call's cache-read share uses
those two input classes as its denominator. These are transcript accounting facts,
not a measured cache hit probability or a subscription allowance charge.
Codex's dedicated per-response usage record takes precedence over its duplicate
cumulative event. Recent transcripts are rebuilt once in the same store so the two
record styles cannot double count one call. Cursors for files untouched for over a week
advance without rereading their archived bytes. The first refresh after installation
still reads this week's changed transcripts once.

Cause reasons for a large miss are observed changes between consecutive calls in one
transcript: model, client version, a compaction boundary, or a changed
Claude account or effort on two exactly attributed Concierge turns. Their timing does not
prove which change invalidated the cached prefix when several occur together. A changed
submitted system-instructions fingerprint is an observed difference for Codex and a
possible difference at the provider for Claude. Claude Code's default system-prompt
snapshot sends the first turn's recorded instructions on resume until compaction, even
when Concierge submits different text. The fingerprint is a content-free SHA-256 recorded by the execution
owner on each new turn. The first call is expected only if the cursor saw it at the
beginning of the transcript; an older cursor without this fact stays unknown. An
elapsed cache lifetime is an expected category for a gap of at least one hour
for a main Claude conversation, or five minutes for a helper without an observed
one-hour write on its preceding call. This classifies the gap, not the actual
cause of the rewrite. Historical turns without a
fingerprint and calls without unique turn attribution remain `unknown`. Calls
without a large miss are `not_applicable`. A call is flagged
`large_unexplained_cache_miss` when more than half of over 50,000 input tokens were
rewritten after a previous call in the same transcript and neither compaction nor
a provider-supported cache-lifetime gap is observed. An account, model, client
version, effort or system-instructions change remains a candidate cause and does
not suppress the flag. A turn or session is a bug candidate when its flagged-call
rate exceeds both 5% and twice that provider's ordinary-call baseline for the period. This is an
investigation flag, not proof of a provider or Concierge bug. Transcript compaction markers and usage
records share the existing cursor store; there is no second collector or owner-loop scan.
The 48-hour count under `cacheDiagnostics.last48Hours` distinguishes expected first
calls, flagged unexplained misses, unknown causes and observed reasons, with rewritten
token totals per reason. Multiple observed reasons can count the same call. Its
`unknownPatterns` groups unresolved calls by provider, gap, account attribution and
whether two adjacent turns' instruction fingerprints agree or were unavailable;
it does not turn a matching fingerprint into a cause. A matching 15-minute summary
under `last15Minutes` permits a bounded post-release comparison without mixing in
the previous 48 hours. Both summaries are attached to both period views; the period's detailed calls and
turns retain their own time bounds.

The earlier per-turn identity, allowance brief, banked-work notice and first-run title
instruction were submitted as system text. Claude Code's snapshot retained the first
turn's copy, so later Claude turns did not receive their current values. Concierge now
sends changing turn context with that turn's user message after the stable conversation.
This corrects turn-context delivery. The historical Claude cache-miss records do not
establish that it saves cache writes. Codex receives system instructions per turn, but
whether this placement changes its cached prefix remains unmeasured.

## How long a conversation may grow

Every model call, including each tool step inside a turn, re-sends the whole conversation;
prompt caching serves the unchanged part as cached input, which is cheaper but not free, and
neither Anthropic nor OpenAI publishes how cached input counts toward a subscription's five-hour
or weekly allowance (checked 2026-10-08: Claude Code prompt-caching, env-vars and model-config
docs; OpenAI Codex pricing and prompt-caching docs). On a 1M model Claude Code compacts only at
about 967k tokens, so long sessions lived near 1M. In the 24 hours to 2026-10-08 07:50 UTC the
server's Claude transcripts made 12,370 model calls averaging 324k tokens of context each:
3.92 billion cache-read, 88 million cache-write (72M of it one-hour), 7.3 million output, and
almost no uncached input; 29 sessions that passed 500k carried 77% of the cache reads, and a
turn averaged 12.6 calls. Codex made 4,138 calls with 527 million cached input (its window
compacts near 240k already).

Concierge does not shorten conversations itself: an earlier change that made every Claude run
summarise at 250k was removed the same day [decision: agent-conversations-are-not-condensed].
Anthropic's own explanation of why a long session costs more, and its remedies (a fresh session
for unrelated work; compaction only for continuity, and it is itself a large request), is in
"Why usage climbs in a long session" at https://code.claude.com/docs/en/costs.
Measure again with `python3 -I scripts/token-burn.py <hours>`.

## Account, sign-in and forecast details

- Signing Codex in is asked of Codex, never read off its console. `codex-device-login.ts`
  calls the App Server's `account/login/start` (`chatgptDeviceCode`), which answers with
  `verificationUrl` and `userCode` as fields, reports approval through the
  `account/login/completed` notification, and withdraws an abandoned attempt with
  `account/login/cancel`. The daemon performs the login itself, so it already holds the
  token: nothing here writes a credential file and no restart is needed, only the release
  of parked work. The scraper it replaced expected a four-and-four code, Codex 0.153.4
  prints four-and-five (`S8AM-GKSLB`), and Tejas was shown an empty box with no way to
  finish (September 22, 2026). Never parse a human-facing transcript for a value a
  protocol will hand over. Claude Code keeps the bounded CLI adapter in `auth-login.ts`
  because it documents no structured login; its approval code arrives through the app's
  own field, never from him reading process output. Where that adapter must read the
  transcript, it reads exactly, never by a heuristic about what the value looks like: the
  same file cut every Claude sign-in link at `redirect_uri=` for three weeks, because it
  trimmed each URL at the second `http` and Claude's authorize URL carries an encoded
  `redirect_uri=https%3A%2F%2F…`. Anthropic rejected every one of those links, so no Claude
  sign-in through this path had ever completed, and he found it during an outage a sign-in
  would have ended (2026-09-22). A URL may contain a URL; a code may be grouped any way.
  Parse what the shape actually is, or do not parse at all.

- A kept account's name is recorded beside it, never inferred from whoever is signed in.
  A Codex credential names its own account; a Claude one carries no address at all, so the
  code that labelled it read `~/.claude.json`, which is the global record of the *current*
  sign-in. Every kept Claude account therefore wore the current account's email: his
  personal account sat in the list as `tejas@chann.app`, which read as one account listed
  twice and would have switched him to the wrong one (2026-09-22). Claude homes keep
  `.account-email` beside their credential; the default login keeps its own identity.
  Whether the account selected for new work is current is decided by that address and the
  owner's durable selection — a refresh token rotates and its fingerprint stops matching, which would
  list the account in use a second time. An account kept before a name was recorded recovers
  its address by applying `profileId` forward to the addresses this machine already knows
  (the usage reader lists every Claude account by address) and matching — an equality check
  on a function we own, not a guess at a slug. Showing the filed name instead was shipped
  knowingly for one evening and was wrong twice over: a usage reading is keyed by address, so
  the same row also claimed its usage had never been read while that account sat at its
  weekly limit, and he read the screen as broken (2026-09-23).

- A usage reading is not a display. Every reading is kept and forecast
  (`provider-usage-forecast.ts`); a window the provider does not project itself — the
  five-hour one, the one that broke — is projected from this machine's own samples, and
  every forecast carries its source, samples, span and rate. Never state a countdown: a rate
  cannot promise a time. Readings tighten to five-minute cadence near a wall because two
  samples cannot draw a line, and both runtime compositions start the watch.
