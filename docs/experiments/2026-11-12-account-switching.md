# Account switching evidence — 2026-11-12

This record separates a successful direct Claude CLI account/history probe from Concierge behavior. It does not claim that Concierge switched accounts, paused a native turn, or automatically recovered it.

## Server CLI probe: passed

Run on server `ax41`, initiated by controller session `concierge:9410` (GPT-6.1 Sol). The installed CLIs reported Claude Code `2.1.322` and Codex `0.162.0`. Each request used Claude Sonnet 5.5. The probe used the two existing signed-in Claude homes, explicitly selected each home for its own CLI process, and made no login, logout, forced renewal or credential copy.

Two different Claude conversation UUIDs completed `OK` while the CLI process intervals overlapped by about 6.2 seconds:

| Account home | Conversation UUID | Started (epoch seconds) | Ended (epoch seconds) | Result |
| --- | --- | ---: | ---: | --- |
| Gmail | `3ac01438-7b6b-4fb0-a301-7a98219cf2e6` | 1794511278.403791 | 1794511284.6146894 | `OK`, exit 0 |
| Chann | `26032314-d2b0-4e38-b837-1570638047db` | 1794511278.409670 | 1794511284.7602956 | `OK`, exit 0 |

Then each exact UUID resumed from the other home. Gmail's conversation, started under Gmail and resumed under Chann, returned the random fact from its first turn exactly. Chann's conversation, started under Chann and resumed under Gmail, did the same. The original prompts and resumed answers are retained in both native Claude transcripts. The assertions in `results.jsonl` passed.

The credential file for each home had identical bytes before and after the probe. This means each credential remained unchanged across the experiment; the two accounts do not share identical credential files. No hashes or credential contents are included here. Both account-specific `projects` links resolve to the real shared directory `/root/.claude/projects`. The probe left prior shared history entries untouched and created its two new transcripts in `/root/.claude/projects/-tmp-account-experiments-server-20261112/`.

The sanitized trace and locations of the exact raw CLI outputs are recorded in [the machine-readable evidence](2026-11-12-account-switching.json). Upstream CLI references: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Concierge recovery: live failure observed

A separate real Concierge request tested a disposable Claude session with a harmless readiness barrier. Its separate Codex controller verified the exact request and execution identity, then sent `SIGKILL` only to that Claude provider process. It did not stop Concierge, the execution host, Codex, or another run. The request returned: “Not done: the agent could not finish because its run stopped with an error. Nothing will retry this by itself; ask again or send it to another agent.” No automatic continuation was observed. The retained full report is `/tmp/account-experiments-claude-crash-failure-20261112.md`.

The source-bound outside repair request `eaa06fab-8243-4039-a167-2b13cc5bc292`, session `concierge:9467`, owns the fix. Its repair and installed behavior remain unverified. A fresh live acceptance run after installation is pending.

## One fresh native dispatch: observed

An additional disposable native Concierge Claude Sonnet 5.5 turn was admitted without an account pin. Its own ordinary `claude auth status`, without changing its environment, reported `tejas@chann.app`, configuration directory `/root/.claude-accounts/tejas-chann-app`, `loggedIn:true`. Request `a5f2ba86-8a16-4511-8568-def18e77d37e`, session `concierge:9470`, turn `28963` settled as done. The logical runner is `ax41`; both the agent and the controller shell report hostname `cortex-docker-users` and working folder `/root/workspace/slack-concierge`.

This proves an actual unpinned native turn reached a working account, separately from the direct CLI experiments. It does not prove automatic cross-account movement or exhaustion recovery. Both accounts had room; selecting Chann is not evidence of waiting on an exhausted account. The current provider-state authority also considers a fresh selection, reusable prompt cache and allowance lapse pressure, so the experiment does not assume that the least-used weekly percentage must always win.

## Evidence matrix

| Claim | Status | Evidence boundary |
| --- | --- | --- |
| Two existing Claude homes can each complete direct CLI work concurrently | **Passed** | Two CLI processes, confirmed account identities, overlapping process intervals, both `OK`; not Concierge routing |
| The same Claude UUID can resume across these two homes and recall the prior fact | **Passed** | Both directions, exact UUID, prompt and answer retained; not Concierge switching |
| Each account credential stayed byte-identical before and after | **Passed** | Boolean comparison in the producing trace; credential bytes and hashes omitted |
| A fresh native Concierge Claude turn launches with an actual subscription login | **Passed** | Unpinned native session `9470` directly confirmed Chann login; no cross-account movement claimed |
| Prior shared Claude history was changed | **No** | New test transcripts were created under the shared history directory in a dedicated temporary project folder |
| Concierge automatically continues a Claude turn after confirmed provider-process death | **Failed on installed behavior** | The exact Claude process was killed; the request returned an error and no retry; repair is pending |
| Codex work on Gmail after its current allowance exhaustion | **Blocked** | No usable Codex allowance was available for this case; no pass or product failure inferred |
| Switch accounts during a live active Concierge turn | **Blocked** | The real active-turn switch request was refused. This is not proof that a completed switch preserves its controller |
| Mac account-switch acceptance | **Pending** | No Mac result is present in this server evidence |
| Fresh live crash recovery after the repair is installed | **Pending** | Repair request `eaa06fab-8243-4039-a167-2b13cc5bc292` / session `concierge:9467` owns the fix; an independent fresh retest remains required |

The successful CLI probe proves the installed Claude CLI accepted the two account homes and shared conversation history under the stated conditions. It does not prove Concierge account selection, native Pause behavior, active-turn switch safety, automatic recovery, or visible page behavior. The real Claude process-death case is a separate failed live test. Keep its retained session and request as the before-fix counterexample until the repair owner and independent post-repair acceptance have both reported their exact evidence.

## Provenance

The historical speech experiment request was completed. Its exact retained receipt is in `tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-before-0926.txt:64670-64681`: request `c46c3754-9264-4f40-8fcb-be2c93d65a87`, source capture `capture:5cb141601f47030fd47980780e8b7836e5e2de28904a4b889f5d4f7b46fa11fb`, source run `c679b285-d0c8-4105-84ab-993870f7756e` from `cloud:3172`; final event `40dff5f6-2bf8-44d9-b904-5e4b4a25538c`, responder `mac:23`, responding run `6880cc67-5c0b-470b-ab98-334081d22432`, disposition `completed`, completion turn 227. The return was received on the requester's separate run `933fad3d-22c4-438f-827f-19242896a061`. Its result covers the separate app, skill/runbook and speech report; later tuning/Gemma work had a different request. It is not evidence for today's account-switch or recovery claims.

The named server sessions also have retained later evidence, so their old work must not be replayed. An exact current context read of session `3660` contains assistant event `e56117ca-68dd-4fae-908f-edd1431f6460`: “Everything was already finished and pushed before the outage. Closing the request.” A later event `e4737efe-5222-4a43-948f-24599792d636` confirms its project move was already complete before the rate limit. The same retained Inbox source records session `3637` saying “Resumed after the interruption” at line 58091 and a later completed return at line 68555 for request `a0282b8c-6743-4d43-9d1f-ab3bf00940c8`, run `22456a07-3f2f-4b9b-9a97-d5cba39d7371`, completion turn `3657`. These establish later completion or continuation for the named September work, without asserting universal recovery for every session.

## Remaining work has a retained continuation

On November 12, direct fresh Codex readings on both machines showed Gmail's weekly allowance at 100%, resetting November 13 at 16:14:44 UTC. The remaining Codex two-account cells are scheduled once for November 13 at 16:16 UTC (11:16 AM ET), using request `82590c18-741b-4cac-8666-01a4753416ed`, session `concierge:9468`, saved turn `28951`. Its exact saved-turn record was read back as queued with no repeat interval. It must recheck actual sign-in and allowance; the due time is not a promise that both accounts will be usable then. Its result is to be posted to both original Inbox roots, `c3179fa5-049c-41b9-b3cd-d6d75246d285` and `805fd723-9bad-4bdb-bc0a-dac8042f5ccc`.

Mac live work is retained under request `7f50bf52-8bb8-4e8c-869c-91e2b7da64e3`, existing Codex session `mac:314`. Its admission was confirmed after the initial offline queue receipt. No Mac result is claimed until it returns and its evidence has been inspected.
