# Account switching evidence — 2026-11-12

This record separates direct Claude CLI account/history probes, a native Concierge dispatch, and installed server crash-recovery acceptance. The CLI probes alone do not prove Concierge account switching, native Pause, or automatic recovery.

## Server CLI probe: passed

Run on server `ax41`, initiated by controller session `concierge:9410` (GPT-6.1 Sol). The installed CLIs reported Claude Code `2.1.322` and Codex `0.162.0`. Each request used Claude Sonnet 5.5. The probe used the two existing signed-in Claude homes, explicitly selected each home for its own CLI process, and made no login, logout, forced renewal or credential copy.

Two different Claude conversation UUIDs completed `OK` while the CLI process intervals overlapped by about 6.2 seconds:

| Account home | Conversation UUID | Started (epoch seconds) | Ended (epoch seconds) | Result |
| --- | --- | ---: | ---: | --- |
| Gmail | `3ac01438-7b6b-4fb0-a301-7a98219cf2e6` | 1794511278.403791 | 1794511284.6146894 | `OK`, exit 0 |
| Chann | `26032314-d2b0-4e38-b837-1570638047db` | 1794511278.409670 | 1794511284.7602956 | `OK`, exit 0 |

Then each exact UUID resumed from the other home. Gmail's conversation, started under Gmail and resumed under Chann, returned the random fact from its first turn exactly. Chann's conversation, started under Chann and resumed under Gmail, did the same. The original prompts and resumed answers are retained in both native Claude transcripts. The assertions in `results.jsonl` passed.

The credential file for each home had identical bytes before and after the probe. This means each credential remained unchanged across the experiment; the two accounts do not share identical credential files. The verbatim producer trace calls this comparison `credentials_identical`; its meaning is within-home before/after equality, not cross-account equality. No hashes or credential contents are included here. Both account-specific `projects` links resolve to the real shared directory `/root/.claude/projects`. The probe left prior shared history entries untouched and created its two new transcripts in `/root/.claude/projects/-tmp-account-experiments-server-20261112/`.

The sanitized trace and locations of the exact raw CLI outputs are recorded in [the machine-readable evidence](2026-11-12-account-switching.json). Upstream CLI references: [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## Mac CLI probes: passed within the stated boundary

Codex controller `mac:314` (GPT-6 Luna), working in `/Users/tejasdc/workspace/slack-concierge`, ran separate Claude Sonnet 5.5 processes using the existing Hey and Chann homes. Matching before/after identity receipts confirmed `hey@tejas.nyc` and `tejas@chann.app`. Both returned their own synthetic markers with exit 0. Their provider request/response intervals overlap by 903 milliseconds, independently of the process timing.

A completed Hey conversation, UUID `939d0cc0-c8b3-452a-9699-e3b0bf85732e`, then resumed under Chann and returned the exact stored fact `OAK-314-TEAL`. A separate, manually signalled partial Hey response resumed once under Chann with its exact UUID and returned `RECOVERED`. Provider cancellation acknowledgement was not retained; this last result establishes manual continuation of a partial local response, not automatic recovery or a cancellation guarantee. The first attempted interruption finished before its signal and is excluded.

The [producer report](2026-11-12-mac-account-experiments.md) and [retained receipts](2026-11-12-mac-account-receipts.json) preserve the evidence and its limits. A separate read-only audit checked the identities, timing and exact responses; review working files remain outside versioned source. No Codex login was switched and no credential was copied or altered.

## Concierge recovery: before-fix failure

A separate real Concierge request tested a disposable Claude session with a harmless readiness barrier. Its separate Codex controller verified the exact request and execution identity, then sent `SIGKILL` only to that Claude provider process. It did not stop Concierge, the execution host, Codex, or another run. The request returned: “Not done: the agent could not finish because its run stopped with an error. Nothing will retry this by itself; ask again or send it to another agent.” No automatic continuation was observed. The retained full report is `/tmp/account-experiments-claude-crash-failure-20261112.md`.

The source-bound outside repair request `eaa06fab-8243-4039-a167-2b13cc5bc292`, session `concierge:9467`, delivered the repair through PR #789. Source commit `ae879cb92ac7715bf367fab74bff33cdb9889a42` is included in installed merge `c6aaaffedebf6ff4747c64eef8266a82a9ba8409`. A scoped release watch fired and the controller independently read that merge from the installed manifest before starting fresh acceptance. The release observation had a 21-second restart gap; uninterrupted availability is not claimed.

## Concierge recovery: repaired server passed

Fresh request `6d898287-b3e9-4f40-9114-b442494ff856` started in Claude Sonnet 5.5 session `9476`, native conversation `fd3613cb-df78-47c4-9d62-e4ad2cc04bb4`, source turn `28991`. After its first readiness action, the separate Codex controller killed only the manifest- and cgroup-verified native Claude child PID `3526101`, execution `dc37b3239a252132`.

Without a manual resume or another ask, Concierge admitted service input `turn-continuation:28991`. The same native conversation returned `RECOVERY-ORCHID-56291` in the retained final summary and completed the original request once, on turn `29005`. The native transcript has exactly one original request header and one continuation header. The first barrier's invocation log has exactly one entry, and its processes were gone after completion. This is separate installed recovery proof, not an inference from the earlier CLI results.

The injected native-child signal was `SIGKILL`. The host observed the enclosing Claude launcher exit with code `143` and no signal: the launcher maps non-SIGINT child signals to that exit code. These are distinct process layers; the trace does not claim the transport reported SIGKILL.

Two negative controls kept revoked work stopped. Request `a54b5dc9-d658-4127-b778-adb7c95f7e34` was explicitly cancelled while its first barrier ran and remained cancelled with no continuation after that barrier ended. The stronger control, request `d41fa95e-e0aa-416e-8363-119f4d96ea36`, session `9482`, first had cancellation confirmed and then its exact Claude PID `3568570` was killed. Its provider execution failed, but the request stayed cancelled; there was no continuation, active run or queued turn, the barrier ran once, and the owned processes were gone. The first control is cancellation-only; the second actually exercises crash recovery after authority was revoked.

The producing controller's assertions and exact identities are retained in [the crash acceptance trace](2026-11-12-crash-recovery-acceptance.json). A subsequent [bounded process audit](2026-11-12-crash-recovery-process-audit.json) records that all ten original process IDs in the two disposable test ancestries were absent. This establishes the server behavior under the stated cases. A physical Mac installation and native Concierge crash-recovery experiment remain separate, unverified cells. Human Stop, archive and repeated-crash budget behavior were source-reviewed but are not claimed as additional live experiments here.

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
| Concierge automatically continues a Claude turn after confirmed provider-process death | **Failed before repair; passed on repaired server** | Fresh exact-request, same-conversation, one-checkpoint and one-final-settlement acceptance after installation |
| Cancelled work does not resume after its provider crashes | **Passed on repaired server** | Cancellation confirmed before the injected crash; request stays cancelled, no continuation or queued turn |
| Codex work on Gmail after its current allowance exhaustion | **Blocked** | No usable Codex allowance was available for this case; no pass or product failure inferred |
| Switch accounts during a live active Concierge turn | **Blocked** | The real active-turn switch request was refused. This is not proof that a completed switch preserves its controller |
| Mac direct Claude concurrency and saved-conversation account continuation | **Passed** | Distinct identities, 903 ms provider overlap, exact same-UUID fact recall; not native Concierge routing or Pause |
| Mac manual partial-response continuation across Claude accounts | **Observed** | One corrected local interruption and one successful same-UUID follow-up; provider cancellation acknowledgement not established |
| Mac native Concierge crash recovery after the repair | **Not checked** | Shared source and a server pass do not prove Mac installation or Mac execution |

The successful CLI probe proves the installed Claude CLI accepted the two account homes and shared conversation history under the stated conditions. It does not prove native Pause behavior, completed active-turn switching, or visible page behavior. Native dispatch and repaired server recovery have their own evidence above. The original failed crash request remains unchanged as the before-fix counterexample; no startup backfill or replay was performed.

## Provenance

The historical speech experiment request was completed. Its exact retained receipt is in `tmp/reviews/retro-2026-09-29/sources/inbox-router-concierge3172-before-0926.txt:64670-64681`: request `c46c3754-9264-4f40-8fcb-be2c93d65a87`, source capture `capture:5cb141601f47030fd47980780e8b7836e5e2de28904a4b889f5d4f7b46fa11fb`, source run `c679b285-d0c8-4105-84ab-993870f7756e` from `cloud:3172`; final event `40dff5f6-2bf8-44d9-b904-5e4b4a25538c`, responder `mac:23`, responding run `6880cc67-5c0b-470b-ab98-334081d22432`, disposition `completed`, completion turn 227. The return was received on the requester's separate run `933fad3d-22c4-438f-827f-19242896a061`. Its result covers the separate app, skill/runbook and speech report; later tuning/Gemma work had a different request. It is not evidence for today's account-switch or recovery claims.

The named server sessions also have retained later evidence, so their old work must not be replayed. An exact current context read of session `3660` contains assistant event `e56117ca-68dd-4fae-908f-edd1431f6460`: “Everything was already finished and pushed before the outage. Closing the request.” A later event `e4737efe-5222-4a43-948f-24599792d636` confirms its project move was already complete before the rate limit. The same retained Inbox source records session `3637` saying “Resumed after the interruption” at line 58091 and a later completed return at line 68555 for request `a0282b8c-6743-4d43-9d1f-ab3bf00940c8`, run `22456a07-3f2f-4b9b-9a97-d5cba39d7371`, completion turn `3657`. These establish later completion or continuation for the named September work, without asserting universal recovery for every session.

## Remaining work has a retained continuation

On November 12, direct fresh Codex readings on both machines showed Gmail's weekly allowance at 100%, resetting November 13 at 16:14:44 UTC. The remaining Codex two-account cells are scheduled once for November 13 at 16:16 UTC (11:16 AM ET), using request `82590c18-741b-4cac-8666-01a4753416ed`, session `concierge:9468`, saved turn `28951`. Its exact saved-turn record was read back as queued with no repeat interval. It must recheck actual sign-in and allowance; the due time is not a promise that both accounts will be usable then. Its result is to be posted to both original Inbox roots, `c3179fa5-049c-41b9-b3cd-d6d75246d285` and `805fd723-9bad-4bdb-bc0a-dac8042f5ccc`.

Mac CLI request `7f50bf52-8bb8-4e8c-869c-91e2b7da64e3` returned its report and raw receipts, inspected by the controller and a separate read-only auditor. Native automatic recovery and a cancelled-before-crash control are separate request `36e3daf6-0b8e-49fb-8485-30af5ebc12ac` to the same Mac controller. Its exact request read showed the Mac running it; no native Mac acceptance result is claimed yet.
