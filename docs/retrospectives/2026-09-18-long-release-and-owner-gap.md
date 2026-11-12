# September 18 long Concierge release and request gap

Tejas saw one long “Can’t reach the server” notice. The release ledger retains the
update run but the host journal now starts on November 2, so the precise September
socket outage cannot be measured directly from systemd logs.

## Retained timeline (UTC)

| Time | Recorded event |
| --- | --- |
| 05:57:51 | Release started and began waiting for active work to drain. |
| 06:04:46 | The last pre-release agent turn ended. |
| 06:04:47 | Release acquired the admission gate. |
| 06:04:55 | Candidate was prepared and activated. |
| 06:04:58 | Restart verification began. |
| 06:05:18 | Thinkering accepted the bug report into its capture custody. |
| 06:06:08 | Concierge accepted Tejas's message that reports were not flowing; its provider turn started only at 06:10:05. |
| 06:10:03 | Release recorded health verification complete and began reopening admission. |
| 06:10:04 | The bug report entered Concierge's Inbox. |
| 06:10:06 | Release succeeded with the candidate runtime and both admission gates released. |

The initial 6m56s was a wait for an idle boundary while the old service was still
running. The 5m05s verification interval is the unexplained part. During it,
capture custody was preserved, but delivery and agent dispatch were held. The
five-minute systemd stop limit and a release verification interval of almost
exactly that length make a slow shutdown plausible; no retained September journal
proves which shutdown step took the time. An external Slack authentication probe
in the old release had no request deadline, so that is another possible source
of verification delay. Neither should be called the confirmed September cause.

This is not the separate short Thinkering restart issue. A later Concierge update
at 06:20:45–06:20:52 completed verification in about six seconds.

## Present behavior and repair

The same class of gap was observed. On November 5 at 23:04:01, a planned
Concierge stop began and its foreground gateway immediately reported the owner
unavailable. The old owner did not finish closing request surfaces until 23:05:50;
the release then finished at 23:06:38. Instrumentation installed afterwards
identified a concrete hold during the November 6 02:15 release: the foreground
gateway became unavailable at 02:15:05.873, the routed request server closed in
65 milliseconds, and session communication took 15.8 seconds to stop. Six status
requests to the unreachable Mac ended at that boundary. The peer owner waited for
those reads to reach their deadline, even though their durable request IDs could
be reconciled after restart. This establishes the present cause, not the precise
September cause; the September journal is no longer retained.

The repair cancels only peer status and reply reads during server shutdown and
starts that cancellation before waiting for session communication workers.
Peer admission requests retain their previous uncertain-delivery contract. An
isolated check held a Mac status response indefinitely, then saw shutdown finish
in 3 milliseconds with the request still open. Installed release timing and live
request behavior still need to be checked after deployment.
