# Provider / account / dispatch subsystem — rebuild inventory

Author: discovery stage, 2026-11-19. Status: inputs to the architecture doc.

Source material (seven fork-produced inventories, each cites `path:line`):

- `/tmp/concierge-context/inv-dispatch.md` — `provider-accounts.ts`, `provider-account-usage.ts`, `provider-account-dispatch.ts`
- `/tmp/concierge-context/inv-cache.md` — `provider-usage.ts`, `provider-exhaustion-recovery.ts`, `provider-usage-forecast.ts`, `provider-usage-notice.ts`, `provider-free-notice.ts`, `provider-reset-policy.ts`, `aliases.ts`, `claude-allowance-hold.ts`, `account-allowance-observation.ts`
- `/tmp/concierge-context/inv-identity.md` — `runner-provider-accounts.ts`, `provider-account-home.ts`, `provider-account-selection.ts`, `provider-account-choice.ts`, `claude-home-entries.ts`, `claude-keychain.ts`, `claude-account-facts.ts`, `claude-account-login.ts`, `codex-account-login.ts`, `codex-saved-login-renewal.ts`, `runner-provider-account-owner.ts`, `runner-provider-account-readings.ts`
- `/tmp/concierge-context/inv-parser.md` — `claude-code.ts`, `provider-failures.ts`, `aliases.ts` (chain)
- `/tmp/concierge-context/inv-call-sites.md` — every tracked primitive
- `/tmp/concierge-context/inv-cli.md` — `systemd/router-actions.sh`, `routed-request-api.ts`, `bot/scripts/*.ts`, `provider-reset-facts.ts`, `provider-start-choice.ts`, `provider-activation.ts`
- `/tmp/concierge-context/inv-ui.md` — `app-home.ts`, `provider-auth-read.ts`, `account-allowance-observation.ts`, `session-execution-host.ts` (UI view), `provider-usage-notice.ts`, `banked-upkeep.ts`, `saved-work.ts`, `antigravity.ts`, `codex.ts`, plus the duplicate `providerAuthView` observation.

---

## 1. Overview

On 2026-11-19 the system saw hey@tejas.nyc show **"room remains" on the Accounts panel next to "no account has room until Nov 22"** on the hold notice, and at the end of the hour every Claude turn refused with `Runner ax41 cannot resolve selected Claude account hey@tejas.nyc (ambiguous)`. Four independent defects stacked (plan `#F1`-`#F4`, plus `#F10`), each patched by the band-aid PR at its own site, each a symptom of one architectural error: **twelve independent places track "is this account usable right now."** Each place has its own refresh cadence and its own interpretation. They disagree.

The rebuild collapses the twelve sources into one `AccountFacts` record and three computed views: capability (`canTakeWork`), home (`resolveHome`), and credential state (`signInState`). Every caller — dispatch, release, UI, cross-provider failover, recovery, status commands — goes through the authority. Section 2 lists the sources. Section 3 lists every dated incident reason preserved as a test. Sections 4-10 are the current facts. Section 11 says what each source becomes in the rebuild. Section 12 lists the judgment calls that remain for the architect.

---

## 2. Every state source

The plan names twelve. The forks surfaced three more in-memory maps, one Codex-specific daemon cache, one Google-only module variable, one readings-history table, and two parallel `providerAuthView` implementations (counted as one source for this table, because they read the same stores).

| # | Name | Kind | Writer (file:line) | Primary reader (file:line) | Fact it holds | Other readers (views) |
|---|---|---|---|---|---|---|
| 1 | `provider_usage_cache.limits_json[scope]` | sqlite table (row per provider) | `provider-usage.ts:106` (`recordUsageExhaustion`) | `provider-usage.ts:64` (`cachedUsageLimit`), `:72` (`claudeAccountCachedReset`) | Per-model refusal with `resetAt/observedAt/revision`; `generation` guards clears | `provider-account-dispatch.ts:184,334,336,376,379,393,432`; `provider-account-usage.ts:720,811,721,732,812`; `provider-start-choice.ts:41,42,64,65`; `provider-usage-forecast.ts:295,296`; `session-execution-host.ts:581,733,801`; `claude-code.ts:553` |
| 2 | `provider_account_usage.usage_json.accounts[label].windows` | sqlite table (row per provider) | `provider-account-usage.ts:657` (reader loop writes) | `provider-account-usage.ts:829` (`providerAccountUsage`) | Per-account window percentages and reset instants | 20+ callers: dispatch, start-choice, forecast, notice, auth-read, saved-work, codex.ts, antigravity.ts, banked-upkeep, session-execution-host, saved-work |
| 3 | `provider_account_usage.usage_json.accounts[label].signedOut` | sqlite (same blob) | same loop; set `true` on `token_expired` | `provider-account-dispatch.ts:161,176,218` | Reader's sign-in verdict per account | `claudeAccountLaunchableHere`, `claudeAccountAwaitingSignIn` |
| 4 | `provider_account_selection(provider, profile_id, account_label, revision)` | sqlite table | `provider-account-selection.ts:15` (`selectClaudeAccount`) | `provider-account-selection.ts:10` (`claudeAccountSelection`) | Operator's chosen Claude account for dispatch | `provider-account-dispatch.ts:207,326`; `session-execution-host.ts:513,2052`; `provider-auth-read.ts:52`; `turn-execution.ts:18` |
| 5 | `claude_home_proof(home, proven_at_ms)` | sqlite table | `provider-account-selection.ts:32` (`recordClaudeHomeProof`) | `provider-account-selection.ts:29` (`claudeHomeProven`) | Durable proof a real turn or probe landed on this home | `provider-account-dispatch.ts:126,165` (reads through in-memory Set) |
| 6 | `provenHomes: Set<string>` | in-memory module variable | `provider-account-dispatch.ts:119,121,123` (`markClaudeHomeVerified/Refused/forgetClaudeHomeCheck`) | `provider-account-dispatch.ts:165` | Process-local cache of (5) | `claudeHomeIsProven`, every dispatch ladder |
| 7 | `<home>/.account-email` file | file on disk (one per per-account home) | `claude-account-login.ts:116`; `runner-provider-accounts.ts:334`; `provider-accounts.ts:341` | `provider-accounts.ts:245,377`; `runner-provider-accounts.ts:243` | Canonical human-readable email per home | Every `claudeAccount(home)` call |
| 8 | `<home>/.claude.json`'s `oauthAccount.emailAddress` | file on disk | Claude CLI writes on sign-in and refresh | `provider-accounts.ts:104,234,406`; `runner-provider-accounts.ts:244` | Email the live Claude login reports | `localDefaultClaudeAccount`, label recovery |
| 9 | `~/.claude.json` default `oauthAccount.emailAddress` | file on disk | Hand `claude /login` writes here | `provider-accounts.ts:104`; `runner-provider-accounts.ts:244` | What the user's shell default is signed in as | Same |
| 10 | `claudeSignIn` module variable | in-memory (process-local) | `provider-accounts.ts:157` (`refreshClaudeAccount` on timer); `:182` (`setRunnerAccountInUse`) | `provider-accounts.ts:192,214`; `provider-account-usage.ts:357` (via `currentAccount`) | Last `claude auth status --json` on this process | `currentAccount("claude-code")` fallback tier |
| 11 | `runnerIdentity: Map<ProviderKey, ProviderAccount\|null>` | in-memory | `provider-accounts.ts:180` (`setRunnerAccountInUse`) | `provider-accounts.ts:210` (first in `currentAccount`) | Who this runner's reader last observed as current | First tier of three-tier `currentAccount` fallback |
| 12 | Mac keychain items (per home) | macOS keychain | Mac sign-in / token refresh | `claude-keychain.ts:33-66` (`claudeKeychainLogin/HasLogin/MayHoldLogin/Oauth`) | Opaque OAuth secret per home; presence probed | `provider-accounts.ts:306,230,249,453`; `provider-account-dispatch.ts:50`; `claude-account-login.ts:98`; `claude-account-facts.ts:247` |
| 13 | `memo: Map<ProviderKey, {key:mtime:size, account}>` | in-memory | `provider-accounts.ts:220` (write-through inside `currentAccount`) | same line | Stat-keyed file-read cache | Only `currentAccount`'s middle tier |
| 14 | `accountInUse: Map<ProviderKey, string>` | in-memory | `provider-account-usage.ts:802` (`releaseIfAccountChanged`) | same | Last-seen-current label per provider; change gate for release | Internal to release loop |
| 15 | `ownLoginPacing: Map<label, {nextAtMs, failures, credentialVersion}>` | in-memory | `provider-account-usage.ts:321` | same | Per-account reader-side exponential backoff | Reader pacing only |
| 16 | `provider_usage_readings` (reading history, forecast) | sqlite table | `provider-usage-forecast.ts:38` writer | `provider-usage-forecast.ts:155-191` (currentWindowSamples, recentPace) | Per-window samples across time | Forecast (advisory only); `usageSignal`; `usageReadingIsUrgent` |
| 17 | Codex App Server in-memory token | daemon memory | `codex app-server --stdio` daemon | `renewSavedCodexLogin`, dispatch probes | Codex daemon's running token | Session execution host via `accounts.codex.activate` |
| 18 | `antigravitySignIn` module variable | in-memory | `provider-accounts.ts:187` | `provider-accounts.ts:209` | Google/Antigravity last-observed account | `currentAccount('antigravity')`; `provider-account-usage.ts:757,763,783` |
| 19 | `claude_home_signed_out(home, seen_at_ms)` | sqlite table | `provider-account-selection.ts:45-47` | same | Durable sign-out verdict per Claude home | `provider-account-dispatch.ts:166,178` |
| 20 | Two parallel `providerAuthView` implementations | code | `provider-auth-read.ts:49-96` and `session-execution-host.ts:508-608` | native read worker and in-process `/auth/status` | UI row shape (one per account per provider) | Both read the same stores; both compute `allowance.hasRoom` with model-null (F9) |
| 21 | `signinOperations`, `activationOperations`, `codexActivationFlight` (and companions) | in-memory + durable journals | `runner-provider-accounts.ts:startSignIn/completeSignIn/settleSignIn`, `activateCodex`, …) | Same + startup replay | In-flight sign-in / activation state | Owner + activation path |

**Fifteen sources is the lower bound** that matter to "can this account take work right now." If reading pipelines, ledger journals, and UI mirrors are counted, the raw count is higher; this table collects the twelve the plan names plus the smallest set the forks called out as behaviorally distinct.

---

## 3. Every dated incident reason preserved

Table sorted by date. Column 5 is the test file that owns the replay in the rebuild (`bot/tests/incidents/<YYYY-MM-DD>-<slug>.test.ts`); several share the same test file when the same date captures several lessons. Dates are from the comment itself; where the forks surfaced only month+day the year is 2026 unless noted.

| Date | File:line | Comment (verbatim excerpt) | Protects against | Test file |
|---|---|---|---|---|
| 2026-09-21 | `claude-code.ts:611-615` | "On stdout the CLI's own user-role notes — interruption markers, background-task notifications — look like input, and Claude even marks a queued notification as a replay, exactly like an echo of our own message (a failed-task notice reached Tejas that way on 2026-09-21)." | `ownerSubmittedTexts` must filter publishProviderRow so CLI local notices are not read as his input | `bot/tests/incidents/2026-09-21-task-notification-replay.test.ts` |
| 2026-09-22 | `provider-usage.ts:94` | "Until 2026-09-23 this threw a plain terminal failure, and a five-hour Claude limit silently destroyed nine of the Inbox's inputs — including the returns that were reporting the outage." | A cached-usage refusal keeps the input alive with `clearsAtMs`, not kill it | `bot/tests/incidents/2026-09-22-usage-limit-silent-stop.test.ts` |
| 2026-09-22 | `provider-usage-notice.ts:54-66` | "On the evening of 2026-09-22 his Claude account hit its five-hour limit at 23:51 UTC. Nine of the Inbox's inputs — seven of them the returns that were reporting the outage — were refused in 43 seconds, and nothing said anything to anyone." | One hold notice per episode (account:model:clearsAt event id) | Same file as above |
| 2026-09-22 | `provider-accounts.ts:118-134` | "`~/.claude/.credentials.json` is the credential store on this box, but it is not the one Claude Code uses everywhere: on macOS the credentials live in the login Keychain." (macOS 26.7) | `claude auth status --json` is identity authority on Mac; never diagnose Mac over SSH | `bot/tests/incidents/2026-09-22-mac-keychain-credentials.test.ts` |
| 2026-09-22 | `provider-accounts.ts:307-311` | "A Claude credential names no account, so a home we cannot put an address to is not offered: switching to an unnamed credential is how he was nearly moved onto the wrong account on 2026-09-22." | Unnamed Claude home filtered out of Accounts list | `bot/tests/incidents/2026-09-22-unnamed-claude-home.test.ts` |
| 2026-09-22 | `provider-accounts.ts:367-371` | "his personal account sat in the list wearing his work account's email, which read as the same account listed twice and would have switched him to the wrong one had he pressed it (2026-09-22)." | `.account-email` is canonical label, recorded beside credential | `bot/tests/incidents/2026-09-22-account-label-mix-up.test.ts` |
| 2026-09-22 | `provider-accounts.ts:479-489` | "Every lost account on this server traces to such a copy — the Claude account kept beside the usage tool's own copy of it, the Codex accounts copied into and out of the agents' home on every switch." | The one-home invariant: no `saveProfile` by copy | `bot/tests/incidents/2026-09-22-one-home-invariant.test.ts` |
| 2026-09-22 | `provider-account-usage.ts:304-306` | "A reading that cannot name its account has nothing to tell him; headed 'Agents' account' said only 'usage could not be read' for an unnameable account." | Reading row requires a named account | Same file as above |
| 2026-09-22 | `claude-code.ts:782-784` | "any real output means a call got through. Tejas saw 'Working' for 19 minutes of retries during Anthropic's incident on 2026-09-22." | `onProviderRetry` reporting | `bot/tests/incidents/2026-09-22-anthropic-outage.test.ts` |
| 2026-09-22 | `codex-account-login.ts:10-25` (openai/codex#31162) | "Codex's device login deletes its home's auth.json before it starts ... OpenAI can revoke that account outright because another account signed into the same home." | Codex sign-in NEVER happens in `~/.codex`; always staging folder then move | `bot/tests/incidents/2026-09-22-codex-sign-in-staging.test.ts` |
| 2026-09-22 | `provider-account-usage.ts:48-61` | "OpenAI reset-credits granted but never acted on; the reading dropped them." | Carry credits with `expiresAt`; Anthropic has no equivalent | `bot/tests/incidents/2026-09-22-codex-reset-credit-carried.test.ts` |
| 2026-09-23 | `provider-account-usage.ts:149-157` | "30 minutes is not going to cut it" | Reading cadence coarsened to 3 min | `bot/tests/incidents/2026-09-23-usage-reading-cadence.test.ts` |
| 2026-09-23 | `provider-account-usage.ts:697-699` | "Keeping the reading series makes a rate possible; before that, only the latest was kept so there was no climb to warn on." | `provider_usage_readings` retains history | Same file |
| 2026-09-23 | `provider-account-usage.ts:788-800` | "why the fuck do you think waiting until 5:10 is okay on my MacBook?" | `releaseIfAccountChanged` on every reading; CLI sign-in triggers activation | `bot/tests/incidents/2026-09-23-cli-sign-in-activation.test.ts` |
| 2026-09-23 | `provider-accounts.ts:392-397` | "what is happening with my email address here? Why is it being dispelled like that?" | `recoverProfileAccountEmail` must resolve profile folder addresses | `bot/tests/incidents/2026-09-23-profile-email-recovery.test.ts` |
| 2026-09-23 | `provider-accounts.ts:459-466` | "that emptied login sat in his list behind a Switch button that could never work (tejas@chann.app, 2026-09-23 to 2026-09-29)." | `signedIn:false` surfaces sign-in button, not switch | `bot/tests/incidents/2026-09-23-empty-switch-button.test.ts` |
| 2026-09-23 | `provider-account-choice.ts:4-9` | "never wait for a refill while another account has room" + "it overwrote the one shared credential file, broke every live session, and turned seven turns that were safely waiting into seven terminal failures." | Choose fresh at every dispatch; never rewrite live credential | `bot/tests/incidents/2026-09-23-never-wait-choose-fresh.test.ts` |
| 2026-09-23 | `provider-account-choice.ts:15-21` | "session 74077648 started under one account and resumed under the other, recalling the token planted in its first turn, with both credentials untouched." | Shared history lets cross-account resume | `bot/tests/incidents/2026-09-23-cross-account-resume.test.ts` |
| 2026-09-23 | `provider-activation.ts:348-351` | "The switch on 2026-09-23 restored a snapshot whose token had expired eleven hours earlier, reported success, and every dispatch after it failed to authenticate." | Probe after switch (`claudeAccountWorks`/`codexCredentialsAnswer`) | `bot/tests/incidents/2026-09-23-switch-stale-snapshot.test.ts` |
| 2026-09-23 | `provider-activation.ts:450-454` | "On 2026-09-23 that turned seven turns that were safely parked until the allowance returned at 21:10 into seven terminal failures." | Release held work AFTER successful probe | `bot/tests/incidents/2026-09-23-release-order.test.ts` |
| 2026-09-23 | `provider-usage-forecast.ts:155-164` | "On 2026-09-23 that account climbed 67% → 100% in 34 minutes with a reset three hours away, all of it recorded, and nothing was sent." | `currentWindowSamples` filter and SAME_WINDOW grouping | `bot/tests/incidents/2026-09-23-no-notice-sent.test.ts` |
| 2026-09-25 | `provider-activation.ts:348-351` | "The saved-home switch on 2026-09-25 repeated the mistake by bypassing this probe entirely." | Probe after switch is required for every path | Same file as 2026-09-23 switch |
| 2026-09-29 | `provider-accounts.ts:459-466`, `provider-accounts.ts:479-490` | "every lost account on this server traces to such a copy... tejas@chann.app, 2026-09-23 to 2026-09-29" | One-home invariant (same preservation) | `bot/tests/incidents/2026-09-29-tejas-chann-empty.test.ts` |
| 2026-09-29 | `claude-account-login.ts:11-26` | "The Accounts screen signed Claude in by running `claude auth login` against the default home, `~/.claude`, which is the login every Claude session here is running on. Whatever he signed in as replaced it." (tejas@chann.app 4th report) | Sign-in in staging folder; only once Claude names its login does it move to per-account home | `bot/tests/incidents/2026-09-29-signin-replaces-default.test.ts` |
| 2026-09-29 | `provider-account-choice.ts:189-199` | "Am I a fucking idiot? ... What the fuck does it matter for me if you ran on one account or not?" | No notifications to him about account choices | `bot/tests/incidents/2026-09-29-no-account-notice.test.ts` |
| 2026-09-29 | `clear-stale-account-notices.ts:5` | Same quote (parallel) | Stale `claudeAccountNotice` banners removed; none added going forward | Same file |
| 2026-09-29 | `provider-activation.ts:425` | "A separate `codex exec` answered here before: it ran on its own copy of the token, so it said OK on 2026-09-29 while the daemon had already been refused." | Codex credential probe asks the running daemon, with `refreshToken:true`, not `codex exec` | `bot/tests/incidents/2026-09-29-codex-probe-daemon.test.ts` |
| 2026-10-01 | `router-sessions.ts:1126` (and :1129,:1142) | "if my platform is built on threads ... where can I find the idea." | Thinkering / commons ownership (out of scope for this rebuild; preserved) | — |
| 2026-10-04 | `provider-usage-notice.ts:193` | "his notice read 'Codex sign-in expired on cortex-docker-users' (2026-10-04)." | `machineName()` returns friendly string | `bot/tests/incidents/2026-10-04-machine-name-friendly.test.ts` |
| 2026-10-04 | `provider-activation.ts:186-191` | "A server started outside the daemon manager refuses `daemon restart` (from Oct 4 to Oct 7, 2026 that made every Codex switch fail)" | `replaceUnmanagedServer()` only recovery for unmanaged Codex daemon | `bot/tests/incidents/2026-10-04-unmanaged-daemon.test.ts` |
| 2026-10-06 | `provider-account-usage.ts:244-248` | "All three server Codex sign-ins answered `token_expired` while Accounts listed them signed in." | Refused sign-in is not a failed reading — `signedOut:true` set | `bot/tests/incidents/2026-10-06-token-expired-signedout.test.ts` |
| 2026-10-07 | `claude-code.ts:49` | "The two are written together (task_updated, then task_notification, recorded 2026-10-07)..." | `BACKGROUND_REPORT_GRACE_MS` | `bot/tests/incidents/2026-10-07-background-report-grace.test.ts` |
| 2026-10-07 | `claude-code.ts:656-660` | "On 2026-10-07 the owner grew to 41 GB, swapped and froze while several runs streamed" | Line-by-line `eventBuffer` instead of re-parse | `bot/tests/incidents/2026-10-07-owner-41gb.test.ts` |
| 2026-10-07 | `claude-code.ts:1493-1497` (9:02 PM) | "Reported as a plain error ('429 … model not changed'), it failed on the full account while the other had room (2026-10-07, 9:02 PM)." | `modelSwitchError` branch throws `claudeUsageExhaustedMessage(…)` | `bot/tests/incidents/2026-10-07-model-switch-fail-9pm.test.ts` |
| 2026-10-07 | `provider-account-dispatch.ts:26-31` | "Claude reads all of that from the folder it starts in, so a home that only linked history ran agents with no settings: on 2026-10-07 every command needed an approval nobody could give, for ten minutes after a switch that 'worked'." | A Claude home must have every shared entry; falling-closed-out-loud | `bot/tests/incidents/2026-10-07-10-minute-outage.test.ts` |
| 2026-10-07 | `provider-account-dispatch.ts:107-113` | "Proof invariant: automatic moves only go to a proven home; chooser once moved work for room onto a home holding an expired login." | `claudeHomeProven` gate for automatic moves | `bot/tests/incidents/2026-10-07-expired-login-proof.test.ts` |
| 2026-10-07 | `provider-account-dispatch.ts:189-199` (19:31 UTC) | "Hand `claude /login` as `tejas@chann.app` replaced his personal account with nothing said." | `claudeRunsFromOwnHomes()` so agents never run on the main folder | `bot/tests/incidents/2026-10-07-handlogin-displaced-personal.test.ts` |
| 2026-10-07 | `provider-account-selection.ts:22-23` | "on 2026-10-07 a restart at 8:43 PM left the account with room unproven, its new check took two minutes, and work kept failing on the full account." | `claude_home_proof` durable in SQLite | `bot/tests/incidents/2026-10-07-restart-proof-durable.test.ts` |
| 2026-10-07 | `provider-usage-forecast.ts:93-98` | "he heard about chann.app only once it was out (2026-10-07)." | `withAgentsAccountCurrent` overrides reader's current with dispatch selection | `bot/tests/incidents/2026-10-07-chann-app-current.test.ts` |
| 2026-10-07 | `session-execution-host.ts:550-551` (UI) | "The Codex login in use lives in the agents' own home, not in a kept account's folder, so it had no row of its own and nothing on the page said 'in use' (2026-10-07)." | Codex `in-use` synthetic row | `bot/tests/incidents/2026-10-07-codex-in-use-row.test.ts` |
| 2026-10-07 | `codex-account-login.ts:80-85` | "naming by address alone filed a second gmail home beside the long-standing one, and Accounts listed the same account twice (2026-10-07)." | `existingCodexHome(path)` collapses duplicates | `bot/tests/incidents/2026-10-07-codex-duplicate-home.test.ts` |
| 2026-10-07 | `claude-home-entries.ts:11-13` | "linking a lock to the main folder's would tie this account's renewals to whatever a terminal there is doing, and a lock that happened to exist during a switch would be left dangling (GPT-6 Astra's stand-in review, 2026-10-07)." | `.oauth_refresh.lock*`, `.storage-write`, `.storage-write.lock` per-login | `bot/tests/incidents/2026-10-07-per-login-locks.test.ts` |
| 2026-10-07 to 2026-10-09 | `provider-usage-notice.ts:498` | "every brief from 2026-10-07 to 2026-10-09 was refused by the ledger and no running agent was ever told." | Steer brief needs ledger-sourced input id | `bot/tests/incidents/2026-10-07-brief-input-source.test.ts` |
| 2026-10-07 to 2026-11-01 | `claude-account-facts.ts:323-329` | "claude-swap keeps a copy of each login and refreshes it only from the default folder, so once agents ran from their own homes (2026-10-07) the personal account's copy died at its next token rotation and read 'needs signing in again' from Oct 23 to Nov 1." | Own-home usage read never copies the login | `bot/tests/incidents/2026-10-07-own-home-usage-read.test.ts` |
| 2026-10-08 | `provider-account-dispatch.ts:143-147` (2:54 AM) | "Six turns held for 40 seconds while a proof ran at the moment of need." | Prove-ahead in background during reading | `bot/tests/incidents/2026-10-08-prove-ahead.test.ts` |
| 2026-10-08 | `provider-accounts.ts:302-304` | "A Mac keeps a Claude home's login in the Keychain under that folder's name, not in a file; counting only the file hid every Mac Claude home (2026-10-08)." | `installedAccounts` counts both file AND keychain | `bot/tests/incidents/2026-10-08-mac-keychain-only.test.ts` |
| 2026-10-08 | `provider-accounts.ts:401-404` | "the cycle ran until the stack overflowed (a catch hid it), re-reading every account file ~3,000 times per Accounts read and freezing the owner for up to 144 s (2026-10-08)." | `recoverProfileAccountEmail` uses `storedProviderAccountLabels` only | `bot/tests/incidents/2026-10-08-stack-overflow-144s.test.ts` |
| 2026-10-08 | `claude-keychain.ts:11-15` | "The Mac's browser agent signed in his personal account on 2026-10-08 and Accounts answered 'Claude did not finish signing in' because filing looked only for the file." | `moveClaudeKeychainLogin` and `claudeKeychainHasLogin` as file alternative | `bot/tests/incidents/2026-10-08-keychain-only-personal.test.ts` |
| 2026-10-08 | `provider-usage-forecast.ts:252-259` | "'I do not want to be notified when it's like a fucking 21% dude.' [decision: usage-notice-only-at-90-percent]" | Threshold-based notice at 90%; pace/forecast diagnostic only | `bot/tests/incidents/2026-10-08-notice-90-threshold.test.ts` |
| 2026-10-08 | `provider-reset-policy.ts:33-52` | "Obviously we're gonna reset only after we completely consume the entire fucking thing. We're not resetting before hundred percent dude..." | 5h+weekly≥95% exception; otherwise weekly must be 100% | `bot/tests/incidents/2026-10-08-reset-threshold.test.ts` |
| 2026-10-08 | `session-execution-host.ts:628-629` (UI) | "The Accounts page waits on this read, so a slow one names its own steps: on 2026-10-08 it took ~10 s a read and finding why took a system-call trace." | Per-step auth-view timing | `bot/tests/incidents/2026-10-08-10s-auth-read.test.ts` |
| 2026-10-08 | `provider-activation.ts:118` | "counting first left a window in which a turn could be claimed onto a server about to stop (outage review, 2026-10-08)." | During a Codex restart, admit-hold first then count | Same file as 2026-10-04 |
| 2026-10-09 | `provider-usage-forecast.ts:282-289` (accountAvailability header) | "On 2026-10-09 a held message said every Claude account was out until Oct 11 at 11 PM, which was chann.app's weekly reset alone; his personal account refilled at 11:20 PM." | Per-account resets stated per-account, not globally | `bot/tests/incidents/2026-10-09-per-account-resets.test.ts` |
| 2026-10-09 | `provider-usage-forecast.ts:323-330` | "It used to leave the selected account out, so with only that one free it read as 'no account has room' (2026-10-09)." | `accountsWithRoom` includes the selected account | Same file |
| 2026-10-09 | `turn-execution.ts:1328-1333` (via inv-parser) | "...the refusal only knows its own account's reset: holding until that told him every account was out until chann.app's weekly reset two days away, while his other account refilled that evening (2026-10-09)." | `clearsAtMs` reconciled with `claudeEveryAccountClearsAt` outside parser | Same file |
| 2026-10-10 | `provider-account-choice.ts:144-147` | "the 2026-10-10 case still holds — 13% with two days left (0.3) loses to 83% with five (0.7)." | Lapse-pressure formula over raw `usedPercent` | `bot/tests/incidents/2026-10-10-lapse-pressure.test.ts` |
| 2026-10-10 | (plan `#F7` evidence) | "usage percentage is not proof, since it read zero while Claude refused real work on 2026-10-10." | Percentage is not proof of room; cache + reading must be joined | `bot/tests/incidents/2026-10-10-percentage-zero-refusal.test.ts` |
| 2026-10-12 | `router-actions.sh:115` | "a reply flag on 2026-10-12, project new's `--owner` on 2026-10-21" | Server sessions use installed release's router-sessions client | `bot/tests/incidents/2026-10-12-pinned-client-outdated.test.ts` |
| 2026-10-13 | `provider-exhaustion-recovery.ts:62-66` | "...he asked how Claude could answer when it had run out (2026-10-13)" | `movedToCodex()` attributes `continued on Codex` line to service | `bot/tests/incidents/2026-10-13-moved-to-codex-attribution.test.ts` |
| 2026-10-13 | `aliases.ts:166-168` | "... which called every Google (Gemini) session 'Claude' in waiting notices (2026-10-13)." | Provider display name keyed exhaustively | `bot/tests/incidents/2026-10-13-provider-display-name.test.ts` |
| 2026-10-13 | `provider-account-choice.ts:41` | "A week reset 15 hours before its end (Tejas, 2026-10-13) is the extreme case." | `weeklyResetsAtMs` ranking by lapse pressure | `bot/tests/incidents/2026-10-13-week-reset-15h.test.ts` |
| 2026-10-13 | `provider-reset-facts.ts:4-19` (12:52 PM ET) | "I just reset one of the accounts because we were running out, and the reset keeps the same timing..." + "tejastej.dc@gmail.com on 2026-10-13: at 16:50 UTC the weekly fell from 100% to 0% and the Fable-only weekly from 44% to 0%, and both kept their Oct 14 08:00 UTC end." | Claude resets preserve week-end; Codex resets restart clock | `bot/tests/incidents/2026-10-13-claude-reset-fixed-end.test.ts` |
| 2026-10-13 | `claude-account-facts.ts:6-10` | "I also added the API credits on my chann.app account, so both accounts should accrue these API credits..." | Per-account Admin API key lookup for cost-report spend | `bot/tests/incidents/2026-10-13-per-account-api-key.test.ts` |
| 2026-10-15 | `provider-account-dispatch.ts:408-416` | "a reading counts for 6 minutes; a fresh account routinely looked unreadable and work was held until the spent account's reset." | `lastShowedRoom` fallback (new rule D in design) | `bot/tests/incidents/2026-10-15-19-percent-unreadable.test.ts` |
| 2026-10-15 | `claude-keychain.ts:27-32` | "on 2026-10-15 a lookup during a restart of the Mac's owner dropped his personal account, at 19% of its week, from the accounts it could launch" | `claudeKeychainMayHoldLogin` returns true on `unanswered` | `bot/tests/incidents/2026-10-15-locked-keychain-drop.test.ts` |
| 2026-10-21 | `router-actions.sh:115` | "project new's `--owner` on 2026-10-21" | Pinned client enforcement (same as 10-12) | Same file |
| 2026-10-23 | — | "tejastej.dc@gmail.com reads 'Showing the last reading' from Oct 23" (plan `#F5`) | Stale `/usage` reading auto-invalidate | `bot/tests/incidents/2026-10-23-stale-reading-month.test.ts` |
| 2026-10-23 | `provider-account-choice.ts:164-172` | "we should not be changing only when they're expiring, but actually based on what weekly windows are happening." | Warm cache stays only inside pressure band | `bot/tests/incidents/2026-10-23-warm-stay-band.test.ts` |
| 2026-10-30 | `claude-account-facts.ts:80-81` | "Anthropic renamed the plans on 2026-10-30: Max 20x is Ultra, Max 5x is Max." | `planName` string parsing | `bot/tests/incidents/2026-10-30-plan-names.test.ts` |
| 2026-10-30 | `account-allowance-observation.ts:17-20` | "Anthropic removes it from verified Ultra accounts (email of 2026-10-30)" | `includedAllowanceWindows` Claude branch doesn't require 5h window | `bot/tests/incidents/2026-10-30-no-5h-ultra.test.ts` |
| 2026-10-30 | `provider-start-choice.ts:77` | "none of the five-hour limits should be limiting our judgment." | New-work candidate selection excludes unspent 5h windows | Same file |
| 2026-11-02 | `provider-account-dispatch.ts:154-159` | "The Mac's tejas@chann.app read 54% free while its home was signed out, and the hold notice promised work would 'move to it by itself'." (plan `#F9`) | `canTakeWork` must refuse with `signed-out` even when reading says room | `bot/tests/incidents/2026-11-02-mac-signin-wait-read-as-usage.test.ts` |
| 2026-11-02 | `claude-code.ts:312-315` | "Claude Code writes its own notices (a usage limit, an API error) as assistant rows with the model `<synthetic>`... one did on the Mac on 2026-11-02 and a fresh request failed instead of moving to the other account." | `<synthetic>` filter gates `agentSpoke` (but NOT `isClaudeUsageExhaustion`, which is F4) | `bot/tests/incidents/2026-11-02-synthetic-filter-origin.test.ts` |
| 2026-11-02 | `claude-code.ts:570-572` | "The account's reset as Claude last stated it during this request's fallback attempts. Each fallback model's refusal may name none (Haiku's did not on 2026-11-02), and that must not erase the account's known reset." | `accountUsageResetAt` latches across model fallbacks | `bot/tests/incidents/2026-11-02-haiku-no-reset-latch.test.ts` |
| 2026-11-02 | `claude-home-entries.ts:20-22` | ".storage-write.lock is Claude's lock beside .storage-write: a terminal sign-in in the main folder left one there on 2026-11-02 and every extra home read as incomplete until it went away." | `.storage-write.` regex keeps per-login locks out of symlinks | `bot/tests/incidents/2026-11-02-storage-write-lock.test.ts` |
| 2026-11-02 | `aliases.ts:477-482` | "Claude Code's extended-window Opus is the same model on the same allowance: on 2026-11-02 one account was refused for both names with the same reset." | `claudeUsageAllowanceModel` collapses Opus 1M to Opus for scope | `bot/tests/incidents/2026-11-02-opus-1m-collapse.test.ts` |
| 2026-11-02 | `provider-exhaustion-recovery.ts:174-180` | "On 2026-11-02 the Mac moved his 7:28 PM message into a new Codex session while he was signing tejas@chann.app back in" | Recovery refuses while any account with reading-room awaits sign-in | `bot/tests/incidents/2026-11-02-7-28-mac-moved.test.ts` |
| 2026-11-02 | `provider-usage-notice.ts:112-114` | "Room in a usage reading is not room this machine can use: an account whose login here is signed out is named as needing a sign-in, never as where the work moves (the Mac, 2026-11-02)." | `claudeAccountLaunchableHere` filter in alternatives | Same test file |
| 2026-11-03 | `provider-usage-notice.ts:66` | "Publishing this as a phone outage made a withdrawn agent request look like his own waiting message on 2026-11-03." | Usage holds are not phone outages | `bot/tests/incidents/2026-11-03-withdrawn-consult-notice.test.ts` |
| 2026-11-03 | `provider-usage-notice.ts:137` | "Whether held work moves to an account with room by itself is this file's rule; the notice reads the answer instead of keeping its own copy of it (nightly review, 2026-11-03)." | `movesAutomatically` single source | Same file |
| 2026-11-03 | `provider-account-usage.ts:313-317` | "A 429 from Anthropic blanked his only Claude account with room." (hey@tejas.nyc) | Keep last-good `AccountUsage` while pacing retries | `bot/tests/incidents/2026-11-03-429-blanking.test.ts` |
| 2026-11-03 | `provider-account-usage.ts:437-440` | "hey@tejas.nyc signed in through Accounts but absent from cswap list — the account was invisible until the own-login reader was added." | Own-login reader fallback when claude-swap misses | `bot/tests/incidents/2026-11-03-usage-reader-missed-new-account.test.ts` |
| 2026-11-03 | `provider-activation.ts:471` | "An account the usage reader cannot see never produces (the Inbox stayed held 35 minutes, 2026-11-03)." | Activation calls `releaseUsageContinuationHolds` + `releaseUsageHeldWork` + `releaseAuthHold` | `bot/tests/incidents/2026-11-03-inbox-held-after-new-account.test.ts` |
| 2026-11-03 | `provider-activation.ts:77` | "The IN term lets SQLite use the partial running-turn index; without it this check, run on every execution change, walked every Codex turn's stored text (2026-11-03)." | Running-turn count uses partial index | `bot/tests/incidents/2026-11-03-codex-running-count.test.ts` |
| 2026-11-03 | `runner-provider-account-readings.ts:152-156` | "hey@tejas.nyc was missing from the runner's reading after usage moved here." | Every signed-in home claude-swap doesn't list is read from its own login | Same test as 2026-11-03-usage-reader-missed-new-account |
| 2026-11-04 | `claude-code.ts:1438-1439` | "343 ms and 75 MB of garbage per five 1 MB lines (2026-11-04)." | Chunk accumulation only on line boundary | `bot/tests/incidents/2026-11-04-chunk-split-gc.test.ts` |
| 2026-11-04 | `router-actions.sh:97` | "A read-only audit helper closed its parent's repair request on 2026-11-04." | Native sub-helper identity rule | `bot/tests/incidents/2026-11-04-audit-helper-closed-parent.test.ts` |
| 2026-11-05 | `routed-request-api.ts:247` | "A block in them is named by route (2026-11-05: a 6.6 s runner-route transaction ran unlabelled inside a 10.9 s block)." | Every local-owner handler runs under `withTaskLabel(routeLabel(...))` | `bot/tests/incidents/2026-11-05-route-label.test.ts` |
| 2026-11-05 | `claude-allowance-hold.ts:1` | "Emergency allowance hold for the 2026-11-05 weekly reset, 8 PM Eastern (EST)." | Dead code today; the rebuild deletes it | — (delete, no test needed) |
| 2026-11-06 | `provider-usage.ts:181-186` (retireCodexRefusalSupersededByReading) | "on 2026-11-06 a Nov 3 refusal of tejas@chann.app (cached until Nov 9 19:36 UTC) held every Codex turn while the account read 7% used with its week ending Nov 12." (plan `#F2` origin) | A fresh reading showing room retires a cached refusal; design must generalize to Claude | `bot/tests/incidents/2026-11-06-codex-retirement-rule.test.ts` |
| 2026-11-06 | `runner-provider-accounts.ts:66-67` | "on 2026-11-06 one `claude auth login` ran for eleven days and many restarts before an unrelated inventory noticed it." | Leftover sign-in CLI signalled and confirmed killed | `bot/tests/incidents/2026-11-06-leftover-signin-eleven-days.test.ts` |
| 2026-11-06 | `claude-code.ts:1508-1511` | "Claude exits before its session exists when its launch itself is refused, and no transcript is written then" (8876) | Launch-refusal path reads stderr | `bot/tests/incidents/2026-11-06-launch-refusal-stderr.test.ts` |
| 2026-11-06 to 2026-11-10 | `claude-home-entries.ts:29-41` | "`stats-cache.json` is Claude's cache ... Classed as shared settings it marked every Mac account home incomplete, one by one between Nov 6 and Nov 10 2026." | Scratch entries never moved; per-process | Same test file as 2026-10-07 per-login locks |
| 2026-11-11 | `aliases.ts:29-30`, `:467-470` | "Fable 5.2, Sonnet 5.5 and Haiku 5.5 each answered a live turn through the server's Claude Code before moving here (2026-11-11). Fable 5.2 needs Claude Code 2.1.320 or newer." + "Legacy since 2026-11-11; Fable 5.1 and 5.2 share the one 'Fable only' weekly cap." | Model-table provenance; Fable 5.1 collapses to Fable 5.2 for scope | `bot/tests/incidents/2026-11-11-model-table.test.ts` |
| 2026-11-11 | `provider-exhaustion-recovery.ts:33-39` | "Until 2026-11-11 this demanded a Claude admission, written when only Claude work moved" | Receipt key filter accepts `admission` and live `admissionIntent` | `bot/tests/incidents/2026-11-11-receipt-filter.test.ts` |
| 2026-11-13 | `runner-provider-account-readings.ts:180-188` | "on 2026-11-13 a routine access-token expiry made the own read fail, claude-swap's stale copy said relogin_required, and the Mac's browser agent was sent to renew a login whose refresh token was valid for three more weeks." | `ownLoginRefreshable` is sign-out gate, not claude-swap `relogin_required` | `bot/tests/incidents/2026-11-13-expired-access-token-read-as-signed-out.test.ts` |
| 2026-11-15 | `provider-account-dispatch.ts:397-402` | "The unconditional stay was what let the week ending Sunday be spent while the week ending Wednesday kept room" | `WARM_STAY_BAND` pressure gate | `bot/tests/incidents/2026-11-15-warm-stay-band.test.ts` |
| 2026-11-16 | `provider-start-choice.ts:17` | "It has to look at aggregated usage per provider, not existing usage per single account." | `providerTotalRoom` sums across accounts | `bot/tests/incidents/2026-11-16-aggregated-provider-room.test.ts` |
| 2026-11-17 | `provider-activation.ts:276` | "On 2026-11-17 the hold was taken before the count and kept while six-hour turns ran, which queued every new server Codex turn." | Same ordering as `:118` | Same test file as 2026-10-08 admit-hold |
| 2026-11-17 | `provider-activation.ts:568` | "no hold outlives the swap it guarded (2026-11-17)." | Every 30s `expireCodexRunnerHolds` sweeps bounded admission holds | `bot/tests/incidents/2026-11-17-runner-hold-bounded.test.ts` |
| 2026-11-18 | `runner-provider-accounts.ts:100-105` | "on 2026-11-18 GitHub's runner read the group between a shell starting its child shell and that shell starting the command, so the command was never recorded, ignored SIGTERM" | Re-read process group while recorded member is alive before claiming kill | `bot/tests/incidents/2026-11-18-child-shell-group-race.test.ts` |
| 2026-11-18 | `runner-provider-account-owner.ts:111-114` | "The drain is bounded (RUNTIME_MAINTENANCE_DRAIN_BOUND_MS): after it, waiting for running work never holds new Codex work" | Open admission past drain bound | `bot/tests/incidents/2026-11-18-drain-bound.test.ts` |
| **2026-11-19** | `claude-code.ts:316` (synthetic filter) + `:1549` (terminal decision) | Combined: `usageExhausted = usageRejected || isClaudeUsageExhaustion(parsed.text)` lets a `<synthetic>` "You've hit your weekly limit" override a structured `rate_limit_event { status: "allowed" }` | **F4** — structured beats synthetic | `bot/tests/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.test.ts` (F1, F2, F3, F4 all on one incident) |
| **2026-11-19** | `provider-usage.ts:72` (`claudeAccountCachedReset`) | Prefix-match returns max across any model scope when `model=null`. Opus-only refusal poisoned Sonnet/Haiku release checks. | **F1** — model-specific caches must stay model-specific | Same file as above |
| **2026-11-19** | `provider-usage.ts:188` (`retireCodexRefusalSupersededByReading`, Codex only) | No Claude equivalent. 2026-11-06 Codex rule explicitly chose model-specific success as the only Claude retirement. | **F2** — generalize retirement rule | Same file as above |
| **2026-11-19** | `runner-provider-accounts.ts:656-668` (`runnerAccountHomes`) | Enumerates live-root and per-account folder as independent candidates. Hand `/login` created duplicate; `accounts.validate` refused `ambiguous`. | **F3** — dedupe by account label | Same file as above |
| **2026-11-19** | `provider-exhaustion-recovery.ts:173-175` (recoverExhaustedClaudeWork) | Gate reads `newWorkCapacity('claude-code').used >= 100`, i.e. `/usage` percentages, not cached refusals. | **F7** — recovery gates on authority, not percentages | Same file as above |
| **2026-11-19** | `provider-usage.ts:144` (`clearProviderUsage`) | All-or-nothing; no CLI handle. | **F10** — operator interventions have named CLI commands | Same file as above |

**Count**: ~90 dated comments, ~55 test slots after dedup. Six distinct test files map one-to-one to the critical "F#" defects on 2026-11-19; the rest are one per lesson. Several tests (e.g. the `one-home-invariant`) cover more than one dated comment.

**Decision annotations preserved**:
- `[decision: usage-notice-only-at-90-percent]` — `provider-usage-forecast.ts:257`.
- `[decision: provider-account-notices-only-when-action-needed]` — `docs/architecture/PROVIDER-STATE-FLOW.md` (not a code comment but a referenced rule).

---

## 4. Call-site map

From `/tmp/concierge-context/inv-call-sites.md`. One subsection per primitive; each site is annotated with "the question being asked here". Copied with light formatting.

### `cachedUsageLimit`
Definition: `bot/src/provider-usage.ts:64`.
- `claude-code.ts:553` — skip launching the model if its exact scope is cache-refused
- `codex.ts:1992` — retain prior resetAt when recording a new exhaustion
- `provider-start-choice.ts:42` — Codex-only guard for new-work provider selection
- `provider-start-choice.ts:65` — Codex reset lookup in account ranking
- `provider-usage.ts:99` — `assertUsageAvailable` pre-launch check
- `provider-usage.ts:191` — internal helper for `retireCodexRefusalSupersededByReading`
- `provider-usage-forecast.ts:296` — Codex branch of `accountAvailability`
- `session-execution-host.ts:733` — accept-this-account gate at launch
- `session-execution-host.ts:801` — latest-refusal check mid-turn
- `provider-account-usage.ts:721,732,812` — release loop Codex-side gates

### `claudeAccountCachedReset`
Definition: `bot/src/provider-usage.ts:72` — prefix hash `sha256(label.lowercase)[:24]`; model-null walks all scopes under the prefix (F1 source).
- `provider-start-choice.ts:41` — new-work provider skip when this model refused
- `provider-start-choice.ts:64` — new-work account scoring (per-model)
- `provider-account-dispatch.ts:184` — score inflation to 100 when a cache row exists (F1 extra site: works at account+model level but returns 100 whenever any row is present)
- `provider-account-dispatch.ts:334,336` — selected-account gate
- `provider-account-dispatch.ts:376,379` — accounts-with-room filter
- `provider-account-dispatch.ts:393,432` — launchable-home gate
- `provider-account-usage.ts:720,811` — release loop with **model=null** (F1 bite)
- `provider-usage-forecast.ts:295` — `accountAvailability` Claude branch
- `session-execution-host.ts:581` — "claude in use" sentence helper (model=null)

### `accountCanTakeWork`
Definition: `bot/src/account-allowance-observation.ts:56`.
- `provider-account-usage.ts:718` — release loop `activeHasRoom`
- `provider-usage-forecast.ts:304` — per-account availability combined with refusedUntil

### `hasActiveFullAllowanceWindow`
Definition: `bot/src/account-allowance-observation.ts:38`.
- `provider-account-dispatch.ts:392,436` — reading-room filters

### `chooseClaudeDispatch`
Definition: `bot/src/provider-account-dispatch.ts:319`.
- `session-execution-host.ts:361` — launch-choice RPC body
- `session-asides.ts:112` — session aside pre-flight
- `turn-execution.ts:646` — primary dispatch
- `turn-execution.ts:1344` — mid-turn fallback to different account
- `provider-account-dispatch.ts:269` — called from `claudeAccountWithRoomBesides`
- `provider-account-dispatch.ts:283` — called from `claudeHeldWorkCanRun`
- `provider-account-dispatch.ts:304` — called from `requestMissingClaudeHomes` as probe

### `currentAccount` (function invocation)
Definition: `bot/src/provider-accounts.ts:208`. Three-tier fallback.
Call sites (40+): session-execution-host.ts (7), turn-execution.ts (4), provider-usage-notice.ts (7), provider-usage.ts (3), antigravity.ts, provider-auth-read.ts, provider-account-dispatch.ts (3), provider-activation.ts, claude-account-facts.ts (2), provider-accounts.ts (3 internal), provider-account-usage.ts, provider-start-choice.ts, provider-usage-forecast.ts, session-owner.ts (import only). None distinguish the three tiers (runner-identity vs. file-memo vs. memory-fallback).

### `storedUsage`
Definition: `bot/src/provider-usage-forecast.ts:86`.
- session-execution-host.ts:686,2407; provider-start-choice.ts:111,126; provider-auth-read.ts:65 (via alias); internal forecast use at :236,292,356,401

### `providerAccountUsage`
Definition: `bot/src/provider-account-usage.ts:829`.
- 20+ callers; the entire read-side of the system. Representative: session-execution-host.ts (6 reads), provider-account-dispatch.ts (5), provider-usage-notice.ts (3), provider-start-choice.ts (2), provider-auth-read.ts (2), banked-upkeep.ts, saved-work.ts, codex.ts, antigravity.ts (2).

### `recordUsageExhaustion`
Definition: `bot/src/provider-usage.ts:106`.
- `claude-code.ts:946` — inside `startUsageFallback`
- `claude-code.ts:1550` — terminal (F4 hazard site)
- `codex.ts:1989` — Codex refusal path

### `recordUsageSuccess`
Definition: `bot/src/provider-usage.ts:124`.
- `claude-code.ts:1568` — after successful Claude turn
- `codex.ts:1956` — after successful Codex turn

### `clearProviderUsage`
Definition: `bot/src/provider-usage.ts:144`.
- `bot/scripts/provider-usage.ts:15` — ad-hoc operator script; no `router-actions.sh` entrance (F10)

### `clearCodexAccountUsage`
Definition: `bot/src/provider-usage.ts:163`.
- `session-execution-host.ts:672` — after Codex external-reset outcome
- `provider-usage-notice.ts:321` — parallel outcome path
- `provider-usage.ts:195` — internal from `retireCodexRefusalSupersededByReading`

### `retireCodexRefusalSupersededByReading`
Definition: `bot/src/provider-usage.ts:188`. **Only call site**: `provider-account-usage.ts:712` (reading loop). No Claude equivalent. **F2**.

### `runnerAccountHomes`
Definition: `bot/src/runner-provider-accounts.ts:656`. **F3**.
- `runner-provider-account-readings.ts:62,149` — reading loop iterations
- `runner-provider-accounts.ts:297` — Codex find-by-id
- `runner-provider-accounts.ts:324` — Claude find-by-email (returns duplicates)
- `runner-provider-accounts.ts:673,685,850,887` — internal helpers

### `claudeAccountLaunchableHere`
Definition: `bot/src/provider-account-dispatch.ts:160`.
- `provider-usage-notice.ts:115` — filter "withRoom" by local-launchability

### `claudeAccountWithRoomBesides`
Definition: `bot/src/provider-account-dispatch.ts:267`.
- `turn-execution.ts:1616` — adorn a refusal with `elsewhere:true`

### `claudeHeldWorkCanRun`
Definition: `bot/src/provider-account-dispatch.ts:280`.
- `provider-account-usage.ts:724` — release loop: if claude can dispatch, drop usage holds

### `claudeEveryAccountClearsAt`
Definition: `bot/src/provider-account-dispatch.ts:303`. Answers via exceptions — runs `chooseClaudeDispatch(null)` and reads `ProviderDispatchError.clearsAtMs` when thrown.
- `turn-execution.ts:1347,1610` — refusal notice earliest clear
- `provider-account-usage.ts:735` — fallback floor for `moveUsageHoldsEarlier`

### `newWorkCapacity`
Definition: `bot/src/provider-start-choice.ts:104`. Reads `/usage`, not caches.
- provider-start-choice.ts:101,118,119; turn-execution.ts:338; provider-exhaustion-recovery.ts:173,174 (F7); held-work-failover.ts:39,50; incident-budget-pause-recovery.ts:134; provider-usage-notice.ts:140; session-owner.ts:155; standing-role-provider-failover.ts:55,59.

### `provenHomes` (Set) and `claudeHomeProven`
Definition: `bot/src/provider-account-dispatch.ts:114` (in-memory), mirror of `claude_home_proof` at `provider-account-selection.ts:29`.
- provider-account-dispatch.ts:119,121,123,125,126,165 — mutate/read (in-memory)
- provider-account-dispatch.ts:12 (import), :126,:165 — read-through from SQLite

### `markClaudeHomeVerified`
Definition: `bot/src/provider-account-dispatch.ts:119`.
- session-execution-host.ts:174 (import), 978 — after `claudeAccountWorks` succeeds
- turn-execution.ts:880 — after a successful turn
- provider-account-dispatch.ts:132 — inside `claudeAccountWorks` success path

### `setRunnerAccountInUse`
Definition: `bot/src/provider-accounts.ts:177`.
- session-execution-host.ts:291 — reset on reconfigure
- provider-account-usage.ts:673,674 — after a usage read confirms identity

### `claudeAccountWorks`
Definition: `bot/src/provider-activation.ts:366`.
- session-execution-host.ts:963 — pre-dispatch verification
- provider-account-dispatch.ts:130 — background prove-ahead probe
- provider-activation.ts:419 — `claudeCredentialsAnswer` adapter

### `isClaudeUsageExhaustion`
Definition: `bot/src/provider-failures.ts:6`. Regex `/^(?:you(?:'|’)re out of usage credits\b|you(?:'|’)ve hit your (?:(?:weekly|daily|monthly|session|usage|extra usage) )?limit\b)/i`.
- claude-code.ts:945 — in-fallback loop early-exit
- claude-code.ts:1549 — terminal (F4 hazard)
- provider-activation.ts:403 — map `claudeAccountWorks` error-text to `out_of_room`
- provider-failures.ts:156 — self-reference inside `isUsageExhaustion`

### `claudeUsageFallbackModels`
Definition: `bot/src/aliases.ts:488`. Chain `[fable, opus, sonnet, haiku]`.
- claude-code.ts:561 — pre-launch model list
- claude-code.ts:1144 — mid-stream fallback-list reconstruction

### `recoverExhaustedClaudeWork`
Definition: `bot/src/provider-exhaustion-recovery.ts:171`. **F7**.
- session-runtime.ts:35 (import), 143, 151, 156 — session startup, timer tick, execution-change
- index.ts:252 (import), 629, 2544, 4045 — owner-loop ticks
- provider-exhaustion-recovery.ts:200 — self-recursion after transfer

### `recoverExhaustedCodexWork`
No symbol with this exact name. Codex failover goes through `held-work-failover.ts` and `standing-role-provider-failover.ts`, both gated on `newWorkCapacity`. Same F7 hazard.

---

## 5. Dispatch decision structure — `chooseClaudeDispatch`

File: `bot/src/provider-account-dispatch.ts:319-450`.

Nine gates in order. Each gate's dated reason preserves the lesson it encodes. `canTakeWork` must subsume gates 1-9 as a filter+rank over one authority.

| # | Line range | Gate | Question asked | Dated reason preserved |
|---|---|---|---|---|
| 0 | 320-321 | Read `provenWaitingTurns` for this `turnId` | Is this turn's manual-check proof still live? | one-shot admission per turn |
| 1 | 332-341 | **No reading / selected not in reading** — launch on `selected` if home ready and no cached refusal | "Run where he chose" when no usage data exists | A new account selected but reading not yet caught up |
| 2 | 344 | **Bail** — not `ownHomes` and no `defaultAccount`: `return null` (legacy pass-through) | Legacy single-home install uses existing path | Backcompat |
| 3 | 346-352 | **Build `homes` map, require `extraHomes.length`** | Any complete extra home exists? | "Not logged in" state → `parked_access` |
| 4 | 375-377 | **Proven waiting-turn room** — a proof match with home, no cached-refused | Stale 100% reading blocking a manually-verified account | 2026-10-15 19%-of-week trap |
| 5 | 388-394 | **`selectedAttempt`** — selected account, no fresh number, no full-window-with-future-reset, no cached refusal | Grant one attempt on selected login the reader cannot measure | 2026-10-07 agents' own homes rule |
| 6 | 402-404 | **Warm stale** — warm cache account whose reading is stale | Keep warm cache in pressure band | 2026-11-15 warm-stay-band |
| 7 | 405 | **Ranker** — `chooseAccountForTurn(rooms, ...)` picks by weekly-used + continuity bias | Normal path | 2026-10-10 lapse-pressure formula |
| 8 | 408-427 | **Last-showed-room** — unreadable-but-last-good-reading-showed-room, ranked | 2026-10-15 reading-staleness turning healthy account invisible | Same as 4 |
| 9 | 429-442 | **Unreadable** — filter accounts with no fresh number, no cached-refusal, no full active window | Let Claude decide on last resort | A failed usage read is not a provider refusal |
| 10 | 443-447 | **Give up** — throw `ProviderDispatchError` with earliest known `clearsAtMs` | Terminal refusal | — |

Gates 4, 5, 6, 7, 8, 9 **each** call `claudeAccountCachedReset(acct, model)` independently.

Six other dispatch-adjacent decisions live elsewhere (each is really a question about `canTakeWork`):

| Function | File:line | Question |
|---|---|---|
| `claudeAccountLaunchableHere(account)` | `provider-account-dispatch.ts:160` | Can this machine launch this account now (proven home + not signed out)? |
| `savedWorkAccountRooms(provider, usage, now?, model?, runnerTarget?)` | `provider-account-dispatch.ts:225` | For saved-work views: decorated per-account room info |
| `claudeHeldWorkCanRun(model?)` | `provider-account-dispatch.ts:280` | Should the release loop wake Claude usage-held work right now? |
| `claudeAccountWithRoomBesides(refused, model?)` | `provider-account-dispatch.ts:267` | Does any account dispatch other than `refused`? |
| `claudeEveryAccountClearsAt(model?)` | `provider-account-dispatch.ts:303` | Earliest reset among launchable accounts (**answered by exception**) |
| `accountUsedPercent(provider, account, model?)` | `provider-account-dispatch.ts:176-184` | Score for this account; returns 100 when **any** cache row present (not scope-aware) |

---

## 6. Parser flow — Claude CLI stream

File: `bot/src/claude-code.ts`.

### `runClaudeCodeTurn` outline (line numbers)

- **Subprocess launch**: `claudeCodeArgs(…)` at `409-449`. Always `--print --verbose --output-format stream-json --input-format stream-json --replay-user-messages`; optional `--resume`, `--fork-session`, `--model`, `--effort`, `--append-system-prompt`, `--settings`, `--mcp-config`, `--dangerously-skip-permissions`. Env at `1410-1411`.
- **Up-front model gate**: `selectAvailableModel(models)` at `550-559`. Iterates preferred model + `claudeUsageFallbackModels(input.model)`, skipping any with `cachedUsageLimit` set. `assertUsageAvailable(usageAttempt(...))` at `562` throws when none free.
- **Stream parse loop**: `handleProtocolEvent` at `1121-1303` dispatches on event type.
- **Terminal decision** at `1548-1567`:

```ts
if (parsed.isError) {
  const usageExhausted = usageRejected || isClaudeUsageExhaustion(parsed.text);
  if (usageExhausted && currentUsageAttempt) recordUsageExhaustion(currentUsageAttempt, usageResetAt);
  const resetAt = usageExhausted ? usageResetAt ?? accountUsageResetAt : null;
  ...
}
```

Confirmed: **line 1549** is the terminal expression. **F4** exactly here.

### Current parser flags

| Name | Type | Where set | Where read | Notes |
|---|---|---|---|---|
| `usageResetAt` | `number \| null` | `569` init; `1148` from `rate_limit_event.resetsAt`; reset at `1070,1194,1200,1251` | `946,1498,1550,1554` | **Not latched**: an `allowed` event after `rejected` clears it |
| `accountUsageResetAt` | `number \| null` | `573` init; `1149` copies latest when non-null | `1498,1554` | **Does latch** latest known reset (2026-11-02 Haiku reason) |
| `usageRejected` | `boolean` | `673` init; `1147` from `status === "rejected"`; reset at `1069,1193,1199,1250` | `945,1549` | **Not latched**; same hazard |
| `usageExhausted` | `const boolean` per-branch | `1549` | — | Local; the defect line |
| `agentSpoke` | field on `ClaudeOutputAccumulator` | `250` init; `320` true on real text; `276,301` reset | `335` into `read().assistantOutput` | `<synthetic>` filter at `316-320` protects this, not the text buffer |
| `messageParts` | field on `ClaudeOutputAccumulator` | `249` init; `319` push ANY text including synthetic | `332` folds into `parsed.text` | **Why synthetic survives to `isClaudeUsageExhaustion(parsed.text)`** |

### `<synthetic>` filter (verbatim)

`bot/src/claude-code.ts:312-325`:

```ts
// Claude Code writes its own notices (a usage limit, an API error) as assistant rows with
// the model <synthetic>. They are not the agent working, so they never make a refused
// turn look worked-on: one did on the Mac on 2026-11-02 and a fresh request failed instead
// of moving to the other account.
const synthetic = ev.message?.model === "<synthetic>";
for (const block of content) {
  if (block?.type === "text" && typeof block.text === "string") {
    this.messageParts.push(block.text);
    if (!synthetic && block.text.trim()) this.agentSpoke = true;
    this.responseChars += block.text.length;
  } else if (block?.type === "tool_use") {
    this.toolsUsed.push(String(block.name || "tool"));
  }
}
```

The filter only gates `agentSpoke = true`. It **still pushes the synthetic text** into `messageParts` at line 319. `read().text` is then fed to `isClaudeUsageExhaustion(parsed.text)` at line 1549. **This is F4's structural root.**

### How `recordUsageExhaustion` is called from the parser

Two call sites, both pass `usageResetAt` (not `accountUsageResetAt`):

- **Line 946** inside `startUsageFallback()` — caches the current (spent) model before falling back.
- **Line 1550** inside the terminal `parsed.isError` branch.

When F4 bites, `usageResetAt = null` (the `allowed` event cleared it), but `recordUsageExhaustion` is still called — writing a `null`-reset tombstone at the Opus model scope. The thrown `clearsAtMs = usageResetAt ?? accountUsageResetAt` then uses the latched `accountUsageResetAt` (Nov 22, from the earlier rejected event). That is how Nov 22 reaches the dispatcher.

### Where structured `rate_limit_event` is consulted vs. where it isn't

Consulted at **line 1146-1150** only:

```ts
if (event.type === "rate_limit_event") {
  usageRejected = event.rate_limit_info?.status === "rejected";
  usageResetAt = usageRejected ? resetEpochMilliseconds(event.rate_limit_info?.resetsAt) : null;
  if (usageResetAt !== null) accountUsageResetAt = usageResetAt;
}
```

Plain assignment, not a latch. A later `allowed` event clears `usageRejected` and `usageResetAt`. The structured `allowed` signal is NOT propagated past the parser — no log, no consult at the terminal decision. **This is F4's full defect surface.**

The dispatcher reads the result back by regex-matching the thrown message in `turn-execution.ts:1340-1352` (`message.startsWith('Claude usage is exhausted')`). The parser's `clearsAtMs` is the structured `rate_limit_event.resetsAt`.

---

## 7. Home resolution — every per-provider, per-machine path

### Claude on server

- **Default home**: `~/.claude/` (live root).
- **Per-account folder**: `~/.claude-accounts/<profileId(email)>/`. `profileId(email)` slugs the email, up to 64 chars.
- **Credential file**: `.credentials.json` → `claudeAiOauth.refreshToken`.
- **Account identity** (`runner-provider-accounts.ts:239-250`): reads `.credentials.json`, hashes refresh token for id, labels from `.account-email` first, then live-root's `~/.claude.json → oauthAccount.emailAddress` if the home IS the live root, else `Claude <subscriptionType>` fallback.
- **`.claude.json`** (per-home): Claude CLI writes `oauthAccount.emailAddress` on sign-in.
- **`.account-email`**: canonical label, written at sign-in (`claude-account-login.ts:116`, `runner-provider-accounts.ts:334`).
- **Shared history**: `sharedClaudeHome(email, home, true)` symlinks every non-per-login, non-scratch entry from live root into the per-account home.

### Claude on Mac — adds a keychain

- All of the above, plus every per-account home's secret in the macOS login Keychain under service `Claude Code-credentials-<sha256(home)[:8]>`. The live root is under `Claude Code-credentials` (no suffix).
- `claudeKeychainOauth(home)` returns `{oauth, version}` from Keychain, no file touch.
- `claudeKeychainMayHoldLogin` returns true on `present|unanswered` (not `absent`) to tolerate a locked Keychain (2026-10-15 lesson).
- `macClaudeSignIn(account)` at `claude-account-facts.ts:221-241` spawns `claude auth status` in the exact home as final confirmation.

### Codex on server

- **Default home**: `~/.codex/` (live root).
- **Per-account folder**: `~/.codex-accounts/<profileId(email)>/`.
- **Credential file**: `auth.json` → `tokens.account_id`, `tokens.id_token` (JWT), `tokens.refresh_token`.
- **Account identity**: `codexAccount(home)` returns `{id: tokens.account_id, label: JWT.email || id}`.
- **App-Server in-memory token**: `provider-accounts.ts:164-172` records that the shared App Server reads `auth.json` once at start and keeps its token in memory; file and daemon can disagree. `restartCodexForAccount` moves files AND restarts AND probes `account/read` to confirm.
- **Legacy profiles**: `~/.codex/auth.json.<name>` files, adopted at boot.

### Codex on Mac

- Identical to Codex on server; no Keychain detour because Codex stores its token in `auth.json` on all platforms.

### Antigravity (Google)

- The Gemini CLI's own keyring on each machine. Concierge reads usage through `/usage` only and never sees its token.

### The current `runnerAccountHomes` algorithm (verbatim)

`bot/src/runner-provider-accounts.ts:656-668`:

```ts
export function runnerAccountHomes(key: AccountProvider): { account: string; home: string }[] {
  const found = new Map<string, string>();                       // home → label
  const active = key === "codex" ? codexAccount(liveRoot(key)) : claudeAccount(liveRoot(key));
  if (active) found.set(liveRoot(key), active.label);            // live root is always first
  let names: string[] = [];
  try { names = readdirSync(accountRoot(key)).filter(name => !name.startsWith(".")); }
  catch { return [...found].map(([home, account]) => ({ account, home })); }
  for (const name of names) {
    const home = join(accountRoot(key), name);
    const account = key === "codex" ? codexAccount(home) : claudeAccount(home);
    if (account && !found.has(home)) found.set(home, account.label);
  }
  return [...found].map(([home, account]) => ({ account, home }));
}
```

### The F3 bug walkthrough

1. The Map is keyed by `home` (the file-system path), not by `account`.
2. The live root is listed first (lines 658-659) and never evicted.
3. The per-account folder is added if `!found.has(home)` — but found is keyed by **path**, not label.
4. If the live root and a per-account folder both resolve to `hey@tejas.nyc`, the return value has **two entries with the same account label** but different homes.
5. `accounts.validate` filters by `candidate.account === params.account` and demands `length === 1`. Two matches → `resolution:"ambiguous"` → every Claude turn refused with `Runner ax41 cannot resolve selected Claude account hey@tejas.nyc`.

The band-aid at `namedRunnerAccountHomes` (`:671-674`) excludes the Claude live root from the label-filtered list. But the underlying `runnerAccountHomes` is still the twelve-source truth consumed by every other site (`fileClaudeSignIn:324`, `fileCodexSignIn:297`, `accounts.transcript:850`, the reading loop at `runner-provider-account-readings.ts:62,149`, `accounts.codex.resetCredit:887`).

The rebuild's `resolveHome` is dedup-by-label with per-account folder preferred.

---

## 8. Sign-in flows per provider per machine

### Claude on server (Linux)
`claude-account-login.ts:ClaudeAccountLogin`:
1. Stage `~/.claude-accounts/.signing-in-<uuid>/` mode 0700.
2. `claude auth login [--email <addr>]` with `CLAUDE_CONFIG_DIR=<staging>`.
3. `complete(code)` runs Claude's code-paste completion.
4. File: read email with `claudeHomeEmail(staging)`.
5. Move `.credentials.json` and `.claude.json` from staging to `~/.claude-accounts/<profileId(email)>/`; existing file set aside as `*.superseded-<ts>`.
6. Write `.account-email`.
7. `sharedClaudeHome(email, home, true)` symlinks shared entries.
8. `forgetClaudeHomeCheck(home)` so next dispatch re-verifies.

### Claude on Mac
Same flow, plus after step 5: if `.credentials.json` is absent but `claudeKeychainHasLogin(staging)` is true, call `moveClaudeKeychainLogin(staging, home)`. 2026-10-08 incident origin.

### Claude on runner
`runner-provider-accounts.ts:startSignIn/completeSignIn/settleSignIn`:
1. Stage `~/.claude-accounts/.signing-in-<uuid>/`.
2. `${CLAUDE_EXECUTABLE} auth login` with `CLAUDE_CONFIG_DIR=<staging>`.
3. `fileClaudeSignIn`: read email, require `runnerAccountHomes('claude-code').filter(c => c.account === email).length <= 1`, pick existing home or make one, move files, write `.account-email`, call `prepareRunnerClaudeAccountHome`.

### Codex on server
`codex-account-login.ts:CodexAccountLogin`:
1. Stage `~/.codex-accounts/.signing-in-<uuid>/` mode 0700.
2. `codex login --device-auth` with `CODEX_HOME=<staging>`.
3. Decode JWT email; resolve `existingCodexHome(stagingAuth)` or fall back to `~/.codex-accounts/<profileId(email)>/`.
4. Move `auth.json` across; set existing aside as `auth.json.superseded-<ts>`.
5. `activate(settledHome)` — move to live root, restart App Server, probe `account/read`.

### Codex on runner
Same flow; `fileCodexSignIn` dedupes by `account_id` via `codexCredentialId(home)` — more robust than Claude's current path. `activateCodex` enqueues `restartCodexForAccount(accountLabel)` with full rollback.

### Codex on Mac
Identical to Codex on server; no keychain detour.

---

## 9. Operator entrances — existing

### `router-actions.sh` subcommands (shell)

Verbs that touch provider/account/usage state:
- `sessions usage [--by-session] [--period week|today]` — read-only; per-provider current usage.
- `sessions auth switch codex <profile-id>` — activate saved Codex sign-in; restart App Server; release held work.
- `sessions repair-home <addr> (--local | --runner <runner>)` — rebuild Claude per-account home layout.
- `sessions codex-maintenance --required-commit <sha>` — Codex runtime maintenance.
- `sessions move <addr>` — move session's account binding.
- (band-aid only) top-level `usage-clear <provider> [--account <label>] [--model <alias>] [--all]` — scoped cache clear.

### `routed-request-api.ts` endpoints touching provider/account state

- `GET /internal/auth-ephemera` (line 260-261) — read current sign-in snapshot.
- `POST /internal/auth-refresh` (:262-263) — re-read disk/keychain; refresh `claudeSignIn`/`codexSignIn` module caches.
- `/session-communication/*` operations: `usage` (:137), `auth-switch` (:143), `repair-home` (:188), `codex-maintenance` (:183), `move` (:187). These mutate account binding or restart daemons.
- `POST /runner/v1/jobs` → `serveRunnerAccountCall` routes `accounts.identity`, `accounts.validate`, `accounts.transcript`, `accounts.readings`, `accounts.signin.*`, `accounts.codex.activate`, `accounts.codex.repairUnmanaged`, `accounts.codex.resetCredit`, `accounts.codex.runtimeMaintenance[.observe|.publish]`.

### Standalone `bot/scripts/*.ts` touching account state

- `bot/scripts/provider-usage.ts status|clear <provider>` — all-or-nothing cache operations.
- `bot/scripts/approve-claude-signin.ts` — Mac paste-code automation.
- `bot/scripts/clear-stale-account-notices.ts` — one-shot SQL to clear `claudeAccountNotice` banners (2026-09-29 cleanup, not routed through router-actions.sh).
- `bot/scripts/install-codex-browser-policy.ts`, `ensure-codex-updater-disabled.ts`, `install-antigravity-account-hook.sh`, `antigravity-account-statusline.sh` — system policy, read-only / shell config.
- `bot/scripts/mac-peer-usage-breakdown-check.ts`, `runner-account-check.ts`, `responsive-provider-observation.ts`, `usage-breakdown-reader.ts` — read-only integration tests.
- (band-aid only) `bot/scripts/router-usage-clear.ts`.

### What today's investigation had to do by hand

| Intervention | Entrance today | How it was actually done |
|---|---|---|
| A. Clear Opus-only cache on hey@tejas.nyc | None (only whole-provider) | Hand-written SQL against `provider_usage_cache.limits_json` |
| B. Inspect dispatcher's belief vs. UI | Partial (`provider-usage.ts status`) | Manual SQL inspection |
| C. Drop live-root duplicate after `claude /login` | None | Hand-moved `~/.claude/.credentials.json` into per-account folder |
| D. Force fresh /usage reading | None (restart or wait) | Waited, then restart |
| E. Verify dispatcher's decision for one account+model | None | Read logs; replayed by hand |
| F. Trigger retire-contradicting-reading for Claude | Didn't exist (Codex-only) | Clear cache by hand |
| G. Clear per-session `claudeAccountNotice` banners | Script exists, not in `router-actions.sh` | Run standalone script |

---

## 10. UI readers of account/provider state

From `/tmp/concierge-context/inv-ui.md`, the "UI readers" table is 30 rows. Representative excerpt (every row carries file:line, store, and the F9 hazard note where applicable):

| # | File:line | Reads | Caches hit |
|---|---|---|---|
| 1 | `provider-auth-read.ts:31-96` — `providerAuthRead` | `providerAccountUsage` + selection + `listProfiles` + `currentAccount` + ephemera | **Never reads `provider_usage_cache`** — F9 source |
| 2 | `provider-auth-read.ts:15-28` — `claudeInUseSentence` | `storedUsage` only | Blind to Claude refusal cache |
| 4 | `session-execution-host.ts:508-608` — `providerAuthView` (private) | **Duplicate** of #1 produced in the owner process | Same stores as #1 |
| 8 | `provider-usage-forecast.ts:292-316` — `accountAvailability` | `storedUsage` + `claudeAccountCachedReset`/`cachedUsageLimit` + `accountCanTakeWork` + `includedAllowanceWindows` | **The one shared availability view.** Consulted by dispatch, forecast, and notice |
| 9-11 | `accountsWithRoom`, `accountsWithRoomBesides`, `earliestRoomAt` | derived from #8 | — |
| 18 | `account-allowance-observation.ts:106-123` — `markUncurrentAccountReadings` | per-account windows + fresh gate | **Where the UI badge comes from**; computes `hasRoom` with model=null **and never consults refusal cache** — the exact F9 root |
| 20 | `provider-usage-notice.ts:101-153` — `noticeUsageHold` | `accountsWithRoom(input.provider, input.model)` + `accountAvailability` + `claudeAccountLaunchableHere` + `claudeAccountAwaitingSignIn` + `availableResetCredit` | **The "no account has room" surface the user saw today** |

### Two parallel `providerAuthView` implementations

`provider-auth-read.ts:49-96` and `session-execution-host.ts:508-608` are near-line-for-line duplicates reading the same stores and producing the same `ProviderAuthView` shape. One serves `/sessions/v1/auth/providers` (worker path); the other is called directly from the owner's `/auth/status`. **Both must be rebuilt in lockstep, or consolidated into one.** The rebuild should consolidate; the authority `canTakeWork` produces the row shape and both callers read it through the same path.

### Why today's panel said "room remains" next to "no account has room"

- `account-allowance-observation.ts:119-120`:
  ```ts
  hasRoom:fresh&&includedAllowanceWindows(provider,account).length>0
    ?includedAllowanceWindows(provider,account).every(window=>window.usedPercent<100):null
  ```
  For `hey@tejas.nyc` at 12:44 the fresh reading showed Weekly = 39%. Every window < 100, so `hasRoom = true`. **No cache check.**
- `provider-usage-notice.ts:noticeUsageHold:114-120` called `accountsWithRoom(input.provider, input.model)` with `input.model = 'claude-opus-5-5'`. Each account went through `accountAvailability:296` → `claudeAccountCachedReset(account.label, 'claude-opus-5-5')` which returned a future reset (the cached Opus refusal). `hasRoom = accountCanTakeWork(...) && refusedUntil === null` → `false`.

One panel from `markUncurrentAccountReadings` (reading only), one from `accountAvailability` (reading + cache). The split is the F9 contradiction.

---

## 11. The 12 sources — collapsed vs. preserved

Rebuild target per source (status values: **C** collapsed into `AccountFacts`; **V** rebuilt as a view of `AccountFacts`; **D** deleted; **K** kept as-is).

| # | Source | Status | Reason |
|---|---|---|---|
| 1 | `provider_usage_cache.limits_json` | **C** | Becomes the `refusals` column/view of `account_facts`. Scope convention keeps `<accountHash>:<canonicalModel>`; model-null query becomes an explicit "any-of-chain" walk through `CLAUDE_USAGE_FALLBACK_CHAIN`. Retirement rule generalizes Codex's (F2). |
| 2 | `provider_account_usage.usage_json.accounts[].windows` | **K** | Stays as the reader's own output. Everything that cares about "room" goes through `canTakeWork(provider, account, model, now)`, which reads this. |
| 3 | `.signedOut` flag | **V** | Same blob but exposed through `signInState(provider, account)`. |
| 4 | `provider_account_selection` row | **K** | Operator's chosen account; `canTakeWork` reads it but never refuses because of it. |
| 5 | `claude_home_proof` table | **K** | Durable proof of a working home; consumed by `canTakeWork`'s rule-C "recent proof" branch. |
| 6 | `provenHomes: Set<string>` | **V** | In-memory cache rebuilt as a view of (5). No independent write path. |
| 7 | `.account-email` file per home | **K** | Canonical label; written at sign-in, read at every home resolve. |
| 8 | `.claude.json` oauthAccount.emailAddress | **K** | Claude CLI writes it; we read it. |
| 9 | `~/.claude.json` default emailAddress | **K** | Same for live root; the F3 fix means a duplicate here is a benign mirror, not a dispatch refusal. |
| 10 | `claudeSignIn` module variable | **D** | Deleted. `currentAccount` becomes runner-identity-first with no module fallback. |
| 11 | `runnerIdentity` map | **V** | Kept as the single source for "who the runner is acting as"; becomes part of `AccountFacts.selection`. |
| 12 | Mac keychain items | **K** | OS-level; we only probe. |
| 13 | `memo: Map<ProviderKey, {mtime:size, account}>` | **D** | Deleted. `currentAccount` reads the file each time; the file read is cheap (1 syscall). |
| 14 | `accountInUse` map | **D** | Deleted. `releaseIfAccountChanged` reads from `canTakeWork`'s before/after output. |
| 15 | `ownLoginPacing` map | **K** | Reader-internal backoff; not a usability belief. |
| 16 | `provider_usage_readings` history | **K** | Forecast only; feeds `tightestCurrentWindow` and `usageForecasts`. |
| 17 | Codex App Server in-memory token | **K** | Codex-specific; probed via `account/read`. |
| 18 | `antigravitySignIn` module variable | **V** | Rebuilt as `AccountFacts` row for Antigravity. |
| 19 | `claude_home_signed_out` table | **V** | Combined with (3) and (12) into `signInState`. |
| 20 | Two `providerAuthView` implementations | **C** | Consolidated to one view that reads from `AccountFacts`. |
| 21 | `signinOperations`/`activationOperations` journals | **K** | In-flight operation tracking; not a usability belief. |

**Open questions** (marked for architect in section 12):
- #10 and #13 are both deletions that touch `currentAccount`'s three-tier fallback. The rebuild must ensure every caller that today relied on tier-2 or tier-3 either (a) tolerates runner-identity-only, or (b) has a fresh file read path. Research plan says delete tiers 2-3; the inventory confirms ~40 callers, none of which distinguish tiers.

---

## 12. Open questions for the architect

### OQ1. CLI namespace — `accounts` vs `providers` vs `sessions`

**Evidence**: `/tmp/concierge-context/inv-cli.md` section 5 point 2. The band-aid placed `usage-clear` at the top level; the plan placed it under `sessions`. The data model is per-`(provider, account_label)`.

**Candidates**: `accounts <verb>` (matches runner's `accounts.*` RPC family) · `providers <verb>` · stay with `sessions`.

**Recommendation**: `accounts <verb>` — aligns with RPC naming and the `provider_accounts` table. Architect must pick in section "Operator CLI".

### OQ2. Opus 1M fallback-chain membership

**Evidence**: `/tmp/concierge-context/inv-cache.md` section 3 "`claudeUsageFallbackModels`". `opus[1m]` is NOT in `CLAUDE_USAGE_FALLBACK_CHAIN` and `canonicalClaudeUsageModel` does not fold it. A session bound to Opus 1M whose allowance exhausts has no in-process fallback, but caches correctly at the Opus scope.

**Tension**: `claudeUsageAllowanceModel(opus[1m]) → claude-opus-5-5` collapses for cache. `canonicalClaudeUsageModel(opus[1m]) → opus[1m]`. If the architect wants `canTakeWork(provider, account, 'opus[1m]', now)` to walk the Opus fallback chain, the alias layer must agree.

**Candidate**: expose `allowanceModelFor(model)` (the cache-scope collapse) and `fallbackChainFor(model)` (the in-process fallback order) separately; keep them in `aliases.ts` and have `canTakeWork` call them explicitly.

### OQ3. F2 retirement rule for Claude — observation window

**Evidence**: `/tmp/concierge-context/inv-cache.md` section 6 "Retirement paths". The Codex rule retires when a reading's `observedAt > limit.observedAt` AND every window `< 100%` AND no window reset within 60s of cache reset. The Claude counterpart must preserve the preserved reason at `provider-account-usage.ts:722-724`: "A percentage drop cannot identify which window caused a model-specific refusal."

**Tension**: the Codex rule is scoped per account; Claude's is per model. If the fresh reading has only a `Weekly` window and the cache is for `claude-opus-5-5`, the "no window's reset matches" test only compares one window. Is that sufficient?

**Candidate**: the rule generalizes exactly — Claude's cache scope already includes the model, and `includedAllowanceWindows(provider, account, model)` restricts to the model's allowance windows. The architect should write this out explicitly.

### OQ4. `claudeAllowanceHold.ts` — delete or keep

**Evidence**: `/tmp/concierge-context/inv-cache.md` "claude-allowance-hold.ts" entry. The hard-coded hold ended 2026-11-06. The file exists and is called from the Claude launch gate.

**Candidate**: delete the file and its one caller. Preserved reason: emergency holds should be an operator CLI that writes a dated row, not a compile-time constant. If the architect agrees, the rebuild removes the file and tracks the "emergency hold" need as a new (future) CLI surface — not built in this pass.

### OQ5. Two `providerAuthView` implementations — consolidate or extract

**Evidence**: `/tmp/concierge-context/inv-ui.md` observation 1. `provider-auth-read.ts:providerAuthView` and `session-execution-host.ts:providerAuthView` are near-duplicates.

**Candidate**: one function in a new module (`provider-auth-view.ts`?), called by both the native read worker and the owner's in-process `/auth/status`. The architect should pick a home.

### OQ6. `accounts.transcript` Codex live-root enumeration

**Evidence**: `/tmp/concierge-context/inv-identity.md` section "Call sites of `runnerAccountHomes`". The band-aid dedupes Claude label lookup through `namedRunnerAccountHomes` but NOT Codex. `accounts.transcript` with `account === null` still walks every candidate (including live root for Codex).

**Tension**: should Codex also exclude live root from transcript lookup? Codex dedupes by `account_id`, which is more robust than Claude's label dedup. A shared transcript symlink between Codex live root and a per-account folder IS a benign mirror, like Claude's.

**Candidate**: the rebuild's `resolveHome` applies the same dedup rule to both providers. `runnerAccountHomes` becomes dedup-by-label-with-per-account-folder-preferred for both.

### OQ7. `admitProvenClaudeWaitingTurn` — preserve or restructure

**Evidence**: `/tmp/concierge-context/inv-dispatch.md` "`provider-account-dispatch.ts:provenWaitingTurns`". A one-shot per-`turnId` override that bypasses a stale 100% reading when a manual check succeeded.

**Tension**: the rebuild collapses all dispatch decisions to `canTakeWork`. A per-turn admission is not naturally a `canTakeWork` input.

**Candidate**: `canTakeWork(provider, account, model, now, { provenWithinMs })` — the manual-check override becomes an operator-supplied freshness window on `canTakeWork`'s rule-C "recent proof" branch. The architect should decide if the `provenWithinMs` field lives on the call or in a per-turn table.

---

End of inventory. The architecture doc at `docs/plans/2026-11-19-provider-account-rebuild-architecture.md` builds on this.
