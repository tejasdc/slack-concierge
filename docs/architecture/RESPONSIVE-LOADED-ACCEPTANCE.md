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
CONCIERGE_TEST_AUTHORIZATION=native-attribution-5eaa0768 bun run bot/scripts/responsive-loaded-acceptance.ts
```

The current page read deliberately uses the legacy unpaged session endpoint, so
its rising database call count is a **known failure signal**, not a passing
release check. Once the browser consumes prepared bounded endpoints and the old
unpaged interactive path is refused, move the harness to those exact endpoints
and require fixed query work as message count and unrelated catalogue size grow.
The synthetic probe does not measure browser paint, queue age, or provider pickup;
those require separate end-to-end observations.
