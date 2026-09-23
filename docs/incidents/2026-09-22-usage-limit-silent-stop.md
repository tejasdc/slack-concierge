# A usage limit stopped everything and told nobody — 2026-09-22

Tejas lost an evening. From about 23:46 UTC on 22 September he saw no response to anything
he sent; at 02:14 UTC he asked what had happened to his threads, and work resumed within
ninety seconds of his asking. He was the monitoring system.

## What happened, from the ledger and the journal

One Anthropic account serves both Concierge instances. It hit its five-hour session limit,
reset time 2026-09-23T00:30:00Z.

| UTC | What the records show |
| --- | --- |
| 23:33:06–23:51:10 | Seven of nine requests to sessions on the Mac settle `failed`. Their `remote_status_json` shows the peer received and acknowledged each one and then failed with Anthropic's `429 rate_limit_error`. Two requests in the middle of that window answer normally. |
| 23:44:51, 23:49:23 | Two local requests land on recipient turn 3133 (one opening, one steered in). |
| 23:51:37 | Turn 3133 fails with the same 429. Both requests settle `failed` with the same turn id and the same result hash — designed behaviour: one turn's terminal state settles every request it holds. |
| 23:51:22–23:52:05 | The Inbox router (concierge:3172) runs nine turns, 3137–3145, in 43 seconds. All nine `error`. Every accepted input is `origin='service'` with an id of the form `return:<eventId>` — they are the returns carrying the failures above. Turn 3137 got a live 429; 3138–3145 never reached the provider, refused by the usage cache with "No request was sent". |
| 23:52:05–02:14:36 | Nothing runs. The half-hourly `provider_account_usage_observed` heartbeat fires at 00:06, 00:36, 01:06, 01:36 and 02:06 and resumes nothing. The service never restarted; it had been up since 22:06:35. |
| 00:30 | The allowance returns. Nothing is left queued to resume: every input was already terminal. |
| 02:14:36 | His input `b8ab53bd` — "What happened to all of my threads" — starts turn 3146. |
| 02:15:25–02:15:51 | That turn creates six new requests, four to the Mac and two local. Each starts within a second of being created. |

The router reported that it had re-dispatched those six at 23:53–23:55 and that they sat
"admitted" for two hours and twenty minutes. Both request tables put their `created_at_ms`
at 02:15:25–02:15:51 with `source_turn_id=3146`, and the router's own transcript ends at
23:51:25 with the single line "You've hit your session limit · resets 8:30pm" and resumes
at 02:14:38. There was no two-hour queue stall. The six started in one 26-second burst
because they were dispatched in one 26-second burst.

At every half-hourly reading during the outage, the machine's other Claude account
(`tejas@chann.app`) showed a completely free five-hour window. One tap in Provider accounts
would have ended the evening's stoppage. Nothing connected the two facts.

## Why nothing said anything

- **The failure notice used the failing provider.** The nine destroyed inputs *were* the
  failure notices. A return is delivered by admitting an input to the requester session,
  which runs on the same exhausted account.
- **The overdue watchdog was correctly silent.** `session-communication.ts` inspects
  requests with `outcome IS NULL`; every one of these settled `failed` immediately. It
  watches for "no answer yet", never for "answered with a failure that destroyed the work".
  Its notice is also delivered to the requester as an input, so it would have died too.
- **The outage offer excluded this twice.** `offerOutageChoices` requires a human-origin
  input, and the native branch of `turn-execution.ts` returned before the offer hook.
- **The return audit was blind.** `session-return-audit.ts` reported results with no return
  input at all; here a return input existed and then died with its turn.
- **Attention was raised and reached nobody.** Nine `attention` events were recorded on the
  Inbox session, but Thinkering's push notifier subscribes to
  `needs_you,accepted,thread_link,provider_outage` — `attention` is not among them.

## What changed

- A usage refusal that states when its allowance returns now carries that instant
  (`clearsAtMs` on `ProviderDispatchError`), and the turn waits in its own queue for it
  instead of ending. Every existing effect-safety check gates it unchanged; a refusal with
  no stated reset stays terminal.
- The turn queue arms a timer at the soonest scheduled attempt instead of waiting for an
  unrelated wake. This also closes a latent gap in the native-only runtime, which has no
  periodic poll at all.
- Activating another account, or clearing the usage cache after a top-up, releases work
  waiting on the old account's reset.
- `provider-usage-notice.ts` publishes one `provider_outage` event per episode, naming the
  reset, how much work is waiting and which other accounts had room. Thinkering renders it
  with truthful words and pushes it to his phone without any provider turn.
- The return audit now also reports a return whose input died with its turn and was never
  carried into a later turn's context (`session_return_unhandled`), without replaying it.

## Investigation

GPT-6 Astra investigated read-only with the evidence and the failed-fix history
(`tmp/reviews/stalled-dispatch-astra.run.log`, not committed). It confirmed the mechanism
and corrected three claims: seven rather than six peer requests failed; turns 3134–3136
succeeded between 23:46 and 23:51, so "every Claude turn failed from 23:46" is too broad;
and the live Slack-enabled runtime does wake the queue every 60 seconds, so the missing
deadline timer is a latent gap in the native-only composition rather than tonight's cause.
It also found that inputs 3138–3145 were later carried into turn 3146's context
(`input_context_received_by_turn_id`), so their content was recovered rather than lost, and
that they must not be resent.

Two findings are recorded and not acted on here, because they are outside this fix:
`session-peers.ts:547` discards an execution error it already holds and reports the generic
"The peer target could not receive this request", which sent this investigation looking for
a transport fault that never existed; and `session-peers.ts:378` sends the remote request
before inserting the local row, so a crash between them can leave accepted peer work with
no origin request.
