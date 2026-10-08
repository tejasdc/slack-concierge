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

This launches Chromium against the real SessionComposer, device send outbox, browser
command custody and session-resource storage modules. A fixture gateway connects those
modules to the actual capture queue request handler, HumanCommandWorker and SessionOwner.
The composer submits while the six adopted hosts emit live output. Before transfer to the
owner, the check asserts server custody, closes the tab, opens another in the same browser
context, and refuses its view refresh. The saved view and pending original message remain.
It then releases delivery and verifies one exact accepted ledger input, unchanged action
and sequence, removal from IndexedDB, and disappearance of the waiting row. It records
time to paint the pending fixture row after the real composer send, not cold-page paint.
The final screenshot is retained in `tmp/reviews/loaded-browser-boundary.png`.

This check found a real wire mismatch: command claims sent camelCase process identity
while the capture API requires snake_case identity. The message correctly retained custody
but could never transfer. The worker's claim encoding must be fixed before this check passes.

The provider history callback remains synthetic; its timings do not prove native provider
history performance. This does not exercise the production authenticated web proxy, the
complete conversation/cache controller, provider pickup, late peer returns, a second owner
process crash after browser custody, or Safari/iOS. Those require separate observations.
The browser report explicitly retains those limits. A transport pause alone is never
reported as browser closure.
