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

The provider history callback is synthetic; its timings do not prove native provider
history performance. The synthetic probe does not measure browser paint, queue age, provider
pickup or browser closure. Those require separate end-to-end observations. A transport
pause in this harness is explicitly not evidence of closing and reopening a browser.
