# Evidence companion: repeated latency retrospective

This is the technical/source companion to [the plain-language retrospective](2026-09-25-latency-retrospective.md). It distinguishes observed code, retained measurements, author recollection and proposals. No tests or new performance experiments were run by the retrospective investigator. Historical and interview measurements are attributed below. Source inspections and existing journal analysis are not live end-to-end acceptance.

## Scope, identities and limitations

- Request: `f3c326f7-f427-47bd-9a0e-6a476f77d8a7`; originating human input `a6d9f1c0-1aea-4a27-8403-c52462880003` in Inbox `concierge:3172`. Follow-up request `a8537216-149e-4fc5-9891-00219a111061`, originating human input `05cda62a-1838-4b46-8a76-f58d8858d62d`, explicitly foregrounds the caching question and asks whether replacement is needed.
- Investigator: `concierge:3757`, GPT-6 Astra; provider conversation `01a0d9b9-8f52-7652-9632-a314815b9191`, run `8edd7f36-8980-4924-b7c2-f64315b935d0`.
- Original authority: investigation and proposal only; build nothing and change nothing. Only report/evidence artifacts were authored, in a dedicated documentation worktree. No production or instruction changes were made by this investigation. Worktree setup ran the repository’s dependency-install bootstrap, not tests.
- Historical evidence gathering delegated to GPT-6 Sol; parent read its saved artifact. This was research assistance, not independent review. Author interviews were explicitly authorized by the original request.
- Current code inspected: Concierge canonical checkout `6aca08b`; Thinkering `7965097` at inspection. Thinkering’s active release symlink resolved to that same revision. Concierge checkout was behind the incident owner’s separately shipped `bb67297`; do not equate checkout with live runtime. Live index/activation statements below are attributed to the incident owner and corroborating existing log timings, not a new parent-run functional probe.
- Navigation used targeted `rg`, Git history, source slices and structured transcript extraction. This session exposed no LSP tool. Large owner files and transcripts were not read in their entirety. Searches are bounded evidence discovery, not an exhaustive proof that no other guard, incident or caller exists.
- Native search itself disclosed incomplete archive coverage: 27 sources could not be indexed and Mac archive-adapter coverage was incomplete in the returned search. Local archive searches and Git evidence supplemented it. No claim to have found every historical incident is made.

## Current source anchors

The following absolute links refer to the canonical checkout inspected on September 25; later edits can shift line numbers. Git identities above freeze the inspected state.

| Claim | Source |
|---|---|
| Saved receipt list includes `asOf`; hydration restores it | [session-cache.ts:281](/root/workspace/thinkering/apps/web/src/session-cache.ts:281) |
| Delta attempted first; any non-abort exception becomes `null`, then full get | [session-cache.ts:488](/root/workspace/thinkering/apps/web/src/session-cache.ts:488) |
| Browser IndexedDB snapshots are disposable per-resource entries | [session-cache-storage.ts:1](/root/workspace/thinkering/apps/web/src/session-cache-storage.ts:1) |
| Browser `get` and `receiptsSince` use the same owner route with different query | [browser-session-client.ts:149](/root/workspace/thinkering/packages/adapters/src/browser-session-client.ts:149) |
| Proxy cursor validator accepts 1–1024 base64url characters | [session-owner-routes.ts:190](/root/workspace/thinkering/packages/adapters/src/session-owner-routes.ts:190) |
| Cursor serializes all unsettled input sequence IDs | [session-owner.ts:257](/root/workspace/slack-concierge/bot/src/session-owner.ts:257) |
| Full unbounded get is default; only complete set earns a delta cursor; deltas revisit open items plus new rows | [session-owner.ts:676](/root/workspace/slack-concierge/bot/src/session-owner.ts:676) |
| Catalogue refresh is coalesced after non-message events, not a two-minute timer | [session-live.ts:32](/root/workspace/thinkering/apps/web/src/session-live.ts:32) |
| Catalogue refresh marks active receipts dirty by session update/reconciliation | [session-cache.ts:517](/root/workspace/thinkering/apps/web/src/session-cache.ts:517) |
| Per-record event patches coexist with broad dirty fallback | [session-cache.ts:547](/root/workspace/thinkering/apps/web/src/session-cache.ts:547) |
| Notification Inbox reader fetches all receipts and walks history | [notification-reply-routes.ts:56](/root/workspace/thinkering/packages/adapters/src/notification-reply-routes.ts:56) |
| Notification preparation wired to that reader | [application.mjs:117](/root/workspace/thinkering/scripts/application.mjs:117), [attention-notifications.ts:392](/root/workspace/thinkering/packages/adapters/src/attention-notifications.ts:392) |
| Catalogue invokes a view per session; imported view queries its continuation | [session-owner.ts:620](/root/workspace/slack-concierge/bot/src/session-owner.ts:620) |
| Receipt construction parses payloads and consults execution/request state; settled objects cached in process | [session-owner.ts:627](/root/workspace/slack-concierge/bot/src/session-owner.ts:627) |
| Message attribution joins event JSON to requested message identities | [session-history-projection.ts:25](/root/workspace/slack-concierge/bot/src/session-history-projection.ts:25) |
| Latest Claude history fetch reads native transcript then slices requested page | [provider-history.ts:300](/root/workspace/slack-concierge/bot/src/provider-history.ts:300) |
| Owner database uses synchronous Bun SQLite, WAL already enabled | [state-database.ts:1](/root/workspace/slack-concierge/bot/src/state-database.ts:1) |
| Conditional request logger has route/query names, duration, status, often null bytes; not caller identity | [session-owner.ts:1954](/root/workspace/slack-concierge/bot/src/session-owner.ts:1954) |
| Existing source checks enforce resource owner, narrow subscriptions, stable snapshots/converter | [check-architecture.mjs:17](/root/workspace/thinkering/scripts/check-architecture.mjs:17) |

Code confirms a full notification read exists. Logs alone do not quantify which caller produced every full read. A plain latest-history page limit also does not bound transcript-reader work. The incident owner measured transcript reading around 0.3–0.4 seconds for its 91 MB conversation, so it was not the dominant cost in that incident; its growth risk is separate from that finding.

## Author interviews and transcript corroboration

### Continuation author

Request `3120936b-86e3-442f-9868-dfa680e24425` addressed discovered `session:WzIsMzc1MSwxXQ`. Returned event `fd3442f3-646e-4e75-a46f-d91d9d0a6f90`, custody attachment `1f106c27-1eb7-41ee-a0c2-1ce13cac09be`.

Full self-account remains at [latency-self-retrospective-3751.md](/root/workspace/slack-concierge/tmp/reviews/latency-self-retrospective-3751.md). It says the parent specified and reviewed, Sol implemented, no index/read-frequency analysis occurred, and only interface-decisions was deliberately loaded. Its statements about assumptions are labelled recollection.

Parent checked the actual transcript `/root/.claude/projects/-root-workspace-slack-concierge/c429aa2a-6f77-4254-bb23-e1c87d29ded7.jsonl`:

- Row 179, 16:19:46.997Z: implementation prompt requires “When the view says a session was already continued, the same control just opens that session.”
- Row 189, 16:20:12.171Z: captured Sol runner identifies `gpt-6-sol`, medium, session `01a0d95d-b2a8-7f10-be88-8d615012be70`.
- Row 211, 16:30:57.644Z: printed diff includes the new per-view query against session inputs.
- Row 421, 17:40:33.498Z: a later, cancelled specification explicitly says “Compute this efficiently for the whole list, since the catalogue list builds every view.” This corroborates that the consideration was available, not a claim about hidden intent.

### Threads/incident author

Requests `f1f3ddc7-a441-4e14-82d2-f1a462f1dd45` and `0951e5de-e777-47aa-a773-17aae075d23b` addressed discovered `session:WzIsMzU3MiwxXQ`. Returned event `0cf27ea7-b153-4520-ad30-581c63086e8f` carries the self-account. Full artifact: [latency-self-retrospective-3572.md](/root/workspace/thinkering/tmp/reviews/latency-self-retrospective-3572.md).

Its retrospective corrects three earlier claims: the browser does send a cursor; the ~two-minute frequency was a rough average, not a timer; a count of 59 history reads had referred to Inbox pages, not the long conversation. Its own opening statement that both indexes were “live and measured” is narrowed later: installation and catalogue improvement were observed, but a post-install complete long-conversation read was not remeasured. The main report uses that narrower evidence.

Parent inspected retained tool output in `/root/.claude/projects/-root-workspace-thinkering/1ab2bce1-19d5-4d47-bbdd-f3b6be4850ef.jsonl`:

- Row 10821, 18:04:26.699Z: an actual production `request_refused` record for the Inbox route, code `INVALID_REQUEST`, problem `/changedAfter: pattern`; captured count 515 in the queried three-hour window.
- Row 10824, 18:04:37.309Z: that session’s measured response, `23,036,734` bytes, `7,367` operations; `asOf` length `1,348`, containing `193` live IDs. The end-to-end tool duration was `9.497104s`; its corresponding owner request record was about two seconds. These are different timing boundaries.
- Row 10830, 18:04:39.223Z: retained device report for page `c195746f-bf02-4f9f-a792-7f9ac9d15e6a`, 17:28:33–17:33:40Z: 381 requests, 91 cache persists, 40 receipt patches, 8 refusals; server refusal sample spans 15:45:10–18:03:15Z. The count is not eight independent root causes.

The author performed the response measurement during its self-investigation; the parent did not repeat it or request a new benchmark. The request had explicitly said no tests/changes. This is disclosed source evidence, not a precedent relaxing the project’s test prohibition.

## Retained owner journal analysis

Parent read existing `concierge-bot` records matching `owner_request_slow|owner_event_loop_lag`; saved diagnostic working copy `/tmp/latency-owner-journal-20260925.log`. Earliest matching record retrieved: 2026-09-22 05:47:11.743Z; latest snapshot record: 2026-09-25 18:01:59.627Z. 66,043 JSON records parsed, zero parse failures. This is the available signal window, not the lifetime of the application. The signals were introduced on September 22.

| UTC day | Loop-lag records | Slow-request records |
|---|---:|---:|
| September 22 | 5,317 | 1,542 |
| September 23 | 42,560 | 2,022 |
| September 24 | 3,725 | 4,274 |
| September 25, partial | 3,526 | 3,077 |
| Total | 55,128 | 10,915 |

Large September 23 lag count is not interpreted as that many user incidents. Logs trigger above thresholds (request 250 ms; loop tick lateness 200 ms), so they cannot supply overall request percentiles or a success denominator. Durations overlap. Selected accumulated slow-route observations: provider-account route with machine parameter 2,284 records / 4,097 seconds summed; full Inbox 1,384 / 1,718 seconds; long-session latest-history route 159 / 1,315 seconds; catalogue 2,640 / 1,296 seconds. These sums are **not** CPU or outage durations. Full Inbox delta requests were also present historically (469 slow logged, maximum 760 ms), disproving a blanket claim that incremental reading never existed.

## Historical source register

The research artifact [latency-history-20260925.md](/root/workspace/slack-concierge/tmp/reviews/latency-history-20260925.md) retains a longer table. Core sources are preserved here so this report does not depend on a temporary artifact remaining forever.

- September 14: stateful-shapes `shapes/06-sync-engine.md` cites Thinkering `ab5e85c` and twelve refreshes for empty resync. Source lesson, not fresh measurement.
- September 16: report `09ee5b3d-169d-4156-8c79-d5272c196d3f`; [contemporaneous hang review](/root/workspace/thinkering/tmp/reviews/hang-architecture-review.md), reviewer session `f83f3d32-5177-4aab-b92d-9edf60e9924a`. Parent read the review’s diagnostic and enforcement sections and current source checks. Commits `43726e8`, `17f6583`; their committed checks/tests are historical evidence, not tests run here. Memory only supplied a pointer to the earlier unresolved incident and the warning that fresh Chromium success did not establish installed-Safari success; current findings came from these sources.
- September 16/17 memory growth: Thinkering `130c89d` records five-hour window and fourteen-minute diagnostic sample. Activation not independently reconstructed.
- September 17 slow open: human input `7f9152f7-2265-4290-a5e5-56f7129966a2`, relay `request:8e8a895b-1bba-4c0e-8a25-f9a0d5485aa6`, 23:41:39Z in archive `claude-projects/-root-workspace-slack-concierge/12417f8b-453b-4bd6-a67d-a6407bf9b704.jsonl`. The 20–30-second wording is a contemporaneous relay; original report text not recovered. Concierge `35acddb` and Thinkering `01b5819` record causes and measurements. Parent read `35acddb`, including query-plan evidence without statistics.
- September 17 whole-event reads: Concierge `d311a03`; Thinkering `990cd04`. Slightly different windows yielded 15.8 MB / 31.6 seconds in the commit account and 15.9 MB / 33 seconds in the later lesson; these are not independent repetitions.
- September 18 search: Concierge `627953f` records 12–20-second search and selected changes.
- September 18 explicit instruction: human input `dc7cde41-b262-4d1f-896d-23deb85a8e23`, 05:43:08Z, archived Thinkering transcript `ec8a0f40-746a-4671-a661-223adbcad104.jsonl`: “I don't know why our app is kind of like doing a lot of inefficient operations here. Let's like update our instructions or like our skills here to make sure that we kind of build this the right way.” Follow-up `a593d320-88da-4cfa-a8a1-c581da673127`, 05:51:39Z: “fix that too.” Owner request `d65ada7d-29dc-41ce-a91a-277833bf2404` in `12417f8b-453b-4bd6-a67d-a6407bf9b704.jsonl` records 444 receipts / 2.7 MB. Changes: Concierge `1bc8c8d`, Thinkering `1b61f12`, `42eab26`.
- September 20 intermediary failure: Thinkering `824517b`, report `56d5fef0`; parent read the actual change from numeric-only to encoded-token validation with a length ceiling.
- September 22 notification recurrence: original Inbox captures `a7ca4dccedc3f95c6159de1753086fe37f185add56bcd3ee16c05d1de2c0e82f` at 03:56:23Z and `53101f1d454352637ad50bd9d1348e968054e51fc28d76f349dc325872991360` at 04:59:39Z in archived Inbox transcript `37d483bc-cc54-41a5-8525-ae6c2b5f5849.jsonl`. “A few seconds to open a fucking session? Unacceptable.” Then “the … latency bug is still here … What did you even fix?” Thinkering agent archive `ec8a0f40-746a-4671-a661-223adbcad104.jsonl`; fixes include Thinkering `a72f861`, `93aaf9a`, Concierge `5d56c9a` (telemetry/settled reuse), `dafb9cf` (topic read improvements).
- September 24 loader: Inbox capture `29d68b0834e1bda88e9012342e3ae9cfff3f8851ac35f2b679062cb8e33ecdf1`, 08:22:40Z, same Inbox archive. “the threads itself has a loading bar, and the notification now has a loading bar … Who's designing these things?” Thinkering `53a24fb`; source identifies a UI failure but does not establish its backend cause.
- September 24/25 preview: report `e47eeffd`, Thinkering `ec40597`. Parent read implementation diff and its explicit native-validation limits. No new native device experiment here.
- September 25 continuation: Concierge `6aca08b`; two-index correction `bb67297`. Parent read both commit evidence and continuation diff. Commit measurements are not asserted to be newly reproduced.
- Provider wait: [Claude session parity plan](/root/workspace/slack-concierge/docs/plans/2026-09-17-claude-session-parity.md), September 18 correction: 18/25 slowest turns received in 1–2.3 seconds, subsequent 15–95 seconds mostly model work; original 20-second acknowledgement interpretation corrected.
- Adjacent lifecycle examples: [August drain incident](/root/workspace/slack-concierge/docs/incidents/2026-08-12-drain-hang-nested-codex.md), source marks several remedies proposed; Thinkering `caff07e` moves startup archive indexing after admission. Neither is counted as a SQL recurrence.

## Existing guidance and enforcement examined

- `stateful-shapes` guideline 12 was committed as `cb114c9` on September 18 at 01:47 ET, before today’s regression. It says to read named changes, asks for payload/frequency/growth, and records this exact Inbox history. Its allowance for whole reads on first open/gaps also needs a bounded-bootstrap design, not an ever-growing exceptional download.
- `stateful-shapes` sync-engine and single-coordinator references distinguish content invalidation, replica usability and one mutation owner. They do not require all reads to execute on one thread.
- `vercel-react-best-practices`: reviewed catalog and its client fetching, subscriptions, identity and JavaScript work categories. Global instructions add data-layer separation and identity preservation; current Thinkering checker encodes several of these.
- `application-observability`: reviewed signal ownership, coverage, conditional-log limitation, alerting and use of existing operational boundaries. It is guidance, not proof of deployed alert rules.
- `architecture-lessons`: reviewed one-home/derive/publish/refuse principles; relevant to two independently defined cursor contracts.
- `skills/docs/LESSONS.md`: current September 25 entry references this retrospective; it cannot be treated as a pre-incident safeguard. The observed recurrence also has the older September 18 skill record above.
- Targeted checks of Concierge deployment/check scripts found no read-cost or query-plan release gate in those inspected paths. This is not an exhaustive absence proof across every repository or supervisor. Current project instructions explicitly prohibit agent-run tests; proposed new gates require approval.

## External primary references and how they were used

- [Bun SQLite](https://bun.sh/docs/runtime/sqlite): synchronous API; prepared-statement caching is not result caching. Current application uses this driver.
- [SQLite query planner](https://www.sqlite.org/queryplanner.html): access paths must match selection and ordering, not merely possess some index.
- [SQLite query-plan output](https://www.sqlite.org/eqp.html): scan/search interpretation and warning against depending on a stable printed output format.
- [SQLite expression indexes](https://www.sqlite.org/expridx.html): indexed expressions must match reader expressions; relevant to JSON identity extraction.
- [SQLite WAL](https://www.sqlite.org/wal.html), [appropriate uses](https://www.sqlite.org/whentouse.html): readers/single-writer boundary and database-replacement comparison.
- [React external-store contract](https://react.dev/reference/react/useSyncExternalStore): unchanged store snapshot identity and stable subscriptions; supports existing browser protections.
- [IndexedDB usage](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB): storage transactions supply persistence mechanics, not an application synchronization contract.
- [Interaction responsiveness](https://web.dev/articles/optimize-inp): 200 ms interaction guidance distinguished from remote freshness.
- [Linear engineering account](https://linear.app/now/scaling-the-linear-sync-engine): shipping-product precedent for an owned sync subsystem. Only the public talk-summary page was read; no undocumented implementation detail or suitability claim is inferred.

All proposed budgets, priorities, replacement costs and migration choices are judgments for Tejas’s decision. They are not measured outcomes, approved foundation changes, or guarantees of zero future latency.
