# 2026-10-12: the Inbox thread index was rebuilt inside his first tap after every restart

**Signal.** The work-flow supervisor opened incident `bfb3021e` at 04:47 UTC with
`owner_slow_reads`: three owner requests at or above two seconds in the five minutes to
04:45 UTC, on a host at load 18 of 12 cores while two deployments ran back to back
(04:35–04:43 and 04:47–04:49 UTC) and a Thinkering look gate ran six WebKit browsers.

**Confirmed.**

- 04:43:31 UTC, ten seconds after the update restarted Concierge: his `read` action on an
  Inbox thread (`POST /sessions/v1/inbox/topics/:id/actions`) took 2,875 ms with 62,533
  ledger calls and 157 MB of row bytes, holding the owner loop 2,698 ms inside the action's
  own write transaction. The slowest statement (1,211 ms) is the index build's own query,
  `inboxRows` plus `AND event.sequence>? ORDER BY event.sequence`, confirmed by its fingerprint.
- The same shape in the previous 72 hours: 39 topic actions read 100 MB or more, 30 took two
  seconds or more, and 38 of the 39 were the first topic read after one of the 75 restarts in
  that window; zero thread placements happened in the window, so the memo reset on thread
  moves was not the trigger. The read grew from 128 MB on 10-09 to 157 MB on 10-12.
- On the live ledger, read-only, the build's query takes about one second whether it selects
  every column or only the seven the index uses; the bytes are not the time. The rest of the
  hold is one root and kind lookup per message on an empty memo.
- 04:43:44 UTC: an event-stream resume replayed 37,996 events (417 MB, 2,222 ms, synchronous)
  for one client whose cursor was far behind; `stream()` replays without a page bound. Twelve
  such replays of 100 MB or more in 72 hours, up to 674 MB and 5.6 s. Not changed here.
- 04:44:58 UTC: `GET /sessions/v1/auth/providers` took 7,551 ms with 2 ms of ledger time,
  waiting asynchronously on the local usage view and the peer; no loop lag at that moment.
  The supervisor counts it as a slow read; it was not a block.

**Change.** `warmEntryIndex` fills the index after startup in steps of 250 rows, yielding
the owner between steps, in both runtime compositions; `entryIndex` still finishes whatever
is left when a reader arrives first. Nothing is written and no contract changes.

**Not acted on.** Restart frequency (75 in three days, each a deployment) and the host load
from release builds and browser gates are operational. The unbounded stream replay and the
supervisor counting an asynchronous wait as a slow read are open findings for their owners.
