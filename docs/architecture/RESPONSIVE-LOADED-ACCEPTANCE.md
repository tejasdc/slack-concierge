# Loaded responsiveness check

`bot/scripts/responsive-loaded-acceptance.ts` exercises the real execution-host
transport and owner request handler against isolated synthetic state. It creates six
hosted executions with 8 MB journals, kills an attached coordinator, adopts the
hosts, streams another 10 MB in aggregate, and interleaves page, history, durable
command custody, and send requests. It reports route work, latency percentiles,
event-loop lag, memory, and host memory. It does not contact a real provider or
mutate production state.

Run it only with the scoped native acceptance authorization:

```sh
CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622 bun run bot/scripts/responsive-loaded-acceptance.ts
```

The catalogue read uses the actual prepared page route and a separate real presentation
worker. Use `--sessions=100` and `--sessions=1000` to compare identical pages across a
tenfold increase in unrelated sessions. Provider frames arrive gradually during the
interaction rather than finishing in one initial burst. The report includes actual route
query counts and response times; it must not substitute for receipt/topic growth fixtures.

To include the browser boundary, point at the integrated Thinkering checkout (with its
existing Vite and Playwright dependencies):

```sh
CONCIERGE_TEST_AUTHORIZATION=responsive-system-b1eed622 THINKERING_ACCEPTANCE_REPO=/path/to/thinkering bun run bot/scripts/responsive-loaded-acceptance.ts --sessions=1000
```

This launches Chromium against the shipping App, WorkspaceRouter, conversation controller,
history/cache, composer and command outbox. The shipping Fastify `registerSessionOwnerRoutes`
and `SessionOwnerClient` connect it to the actual capture queue handler, HumanCommandWorker
and a separately running SessionOwner. Authentication supplies a synthetic approved-device
identity; it does not use or test production cookies. Workspace replication is disabled in
this fresh synthetic browser profile. The PWA update registration is stubbed, not notification
navigation, conversation storage or message custody.

After the first normal visit, the composer sends while six adopted hosts emit live output.
The test asserts server custody before owner acceptance, closes the tab, SIGKILLs that owner,
and starts another owner against the same scratch state. The new owner adopts the same six
hosts. Journal sizes must prove live output both before and after the kill. Capture ingress
and the web proxy stay alive. The browser reopens with all owner GET reads deliberately
refused: its own previously saved history, composer and exact pending message must appear.
No test-written cache or pending-message DOM is supplied. Restoring reads and releasing
delivery must produce one exact accepted ledger input with the same action and sequence,
then remove the retained browser command. The real notification handler receives a synthetic
service-worker delivery and must locate the exact history message inside the viewport.

Provider observation is a separate, named boundary: fixture-controlled admission starts the
shipping `runClaudeCodeTurn` and `SubprocessClaudeCodeTransport` against a generated executable.
That process records the exact received bytes, emits an unrelated echo (which must not count),
then the matching native echo. Exactly one acknowledgement must occur after the matching echo.
This proves wire observation, not normal queue scheduling or external provider inference.

The report separately names pending-message frame time, cold full-App load (including Vite
development compilation), cached reopen, notification location and provider observation.
These one-run timings are not a production-browser SLO distribution. Request distributions
and event-loop timings after the second restart belong to the replacement process; route
work aggregates both owners. Kernel memory high-water marks are sampled per owner PID,
including immediately before killing the first owner. Screenshots are retained in
`tmp/reviews/loaded-offline-reopen.png` and `loaded-whole-conversation.png`.

This check found a real wire mismatch: command claims sent camelCase process identity
while the capture API requires snake_case identity. The message correctly retained custody
but could never transfer. The worker's claim encoding must be fixed before this check passes.

The whole-App check also exposed an offline recovery defect hidden by the earlier small
composer fixture: normal selected views were no longer persisted or hydrated after moving
the catalogue to compact cards. Messages remained durable but reopening during an outage
hid the conversation and composer. The corrected browser retains at most 64 selected views
and a separate validated forty-card cached window, with no fabricated delta base. Fresh
network answers win over asynchronous device restoration.

The provider history callback remains synthetic; its timings do not prove native provider
history performance. Normal queue admission, upstream provider response time, passkey/session
authentication, production asset loading, Safari/iOS and native notification delivery remain
outside this fixture. Late peer return is covered by the separate restart fixture below,
not by the loaded browser journey. A transport pause alone is never reported as tab closure.

`responsive-restart-acceptance.ts` separately exercises a real owner-process death after
canonical acceptance but before delivery acknowledgement. The capture process stays alive;
a replacement owner recovers the dead claim, reuses the accepted input, and settles the
retained command. The same fixture delivers an exact late peer answer twice and verifies
one retained event and one terminal request result. It launches no external provider and
does not claim provider-pickup timing. Its report records both process identities and the
unchanged accepted input identity. Run with the same scoped authorization above.
