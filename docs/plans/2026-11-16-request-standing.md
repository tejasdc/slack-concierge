# Open requests always show who holds them and where they stand (2026-11-16)

## His words
Tejas, 2026-11-16 1:42 AM ET, bug report 6bf4443e: "Things have regressed so badly. 99% of the threads have no responses, even when the sessions are finished. The sessions are completed here; the session itself is complete. How can it complete without actually responding?"
Related agent reports in the same request: after a provider handoff the thread shows the old agent as canceled/failed and nothing from the successor; and "Why the fuck is there no fucking like system to say, hey, this thread was open like, you know, an hour ago? It's been one hour. There is no response."
Asked: a thread with an open request must show who holds the work and its current state in plain words (working, waiting on X, held until Y); a session whose turn ends with the request still open must not look "completed"; when a request in his thread has had nothing for an hour the thread says so and the holder is woken, without relying on the holder or the router remembering. No per-step notifications.

## Cause (confirmed in source)
1. The topic work value (`topicWorkValue` in bot/src/prepared-topic-values.ts and `topicWork` in bot/src/session-topics.ts) counted an open request as work only while something down the holder's request chain had a running or queued turn. An open request whose holder ended its turn (waiting on another agent, a watch, or nothing) was `idle`: "No update yet", dot green.
2. thnkr.ing's hand-off card said "Working on it now" only while the original target ran; after a provider handoff it never named the successor or showed progress (progress partials stopped being posted into threads on Nov 4, by design).
3. The session row showed the raw execution ("completed") for a session whose last turn ended while it still held an open request; a handed-off predecessor showed "failed"/"canceled".
4. From about 23:41 ET Nov 15, roughly twenty Codex sessions were moved to Claude successors, making 1–3 hit nearly every open thread at once.
5. Liveness (`strandedStep`/`workerWillWake`) never acts when the holder waits on a dependency, even if that dependency is itself stuck.

## Invariant
Every open request in a thread has exactly one displayed holder and one standing, computed once by Concierge; "nothing will wake it" is itself a standing that triggers action. thnkr.ing only renders it.

## Concierge contract
`requestStanding(source, requestId, now)` (`bot/src/request-standing.ts`), used by both work-value copies:

```
{ requestId, holder:{sessionId,title}, movedFrom:[{sessionId,title}], state:'working'|'waiting'|'held'|'quiet'|'stalled',
  text, since:ISO|null, until:ISO|null, progress:{text,at}|null, remindedAt:ISO|null }
```
- working: something down the holder's chain is running or queued to run ("Working now", or "Working through <title>" when the chain is longer than the holder).
- held: the holder has no running turn and its next turn is held (usage, snooze, scheduled, banked, chosen time, sign-in, start pacing, or for Codex a retained Codex-wide admission hold: account switch, update or repair); words follow `receiptStatusFromFacts`, shortened; `until` is when it clears.
- waiting: the holder sent a request it still waits on ("Waiting on <title> · no word from it"), or a watch its partial named ("Waiting for a Concierge release").
- stalled: the request has `stalled_at_ms` ("Stopped without finishing" plus the recorded reason).
- quiet: none of the above ("No word yet").
Times are in `since`/`until`/`remindedAt`; `text` embeds none, so it never goes stale.

Topic work: `worker_working` while any open request is working, new `worker_waiting` otherwise (text: first holder title · its state words), `idle` only with no open request. `workers[]` gains `requestId` and `standing`. Session views (live and prepared card) gain `heldRequests:{count,oldestAt}|null`.

## Quiet clock
In the request reconciliation sweep, for an open request with a thread root whose standing is `waiting` or `quiet`: when the latest of creation, last progress/final, holder's last turn end and last quiet wake is at least 60 minutes old, admit one service input `request-quiet:<requestId>:<n>` to the holder through the reminder carrier (handoffs followed) saying what the request is, what it waits on and its standing, and to continue, chase or replace the dependency, or close it. Record `quiet_reminded_at_ms`. A holder that cannot receive input is marked stalled so the Inbox router reassigns. No thread post, no phone notification.

The existing stall path still applies to a wake that does not help: when the woken holder ends its turn with the dependency stuck, the owner's report-back and stall steps run as before, so a wake never extends silence beyond one more chase.

Refinements from the ChatGPT Pro design review: a wait on something itself stuck (every request the holder sent is quiet or stalled, or the watch it named is gone) is actionable at once, spaced 15 minutes apart, and only a wait on working or held work keeps the hour. A progress reply never resets the three-wake bound; it restarts only when the request is seen working or held for real (the wake's own turn does not count) or a request the holder was waiting on settles. The count lives on the request row, so restarts and handoffs keep it. A thread's work text counts mixed states, worst first (`1 stopped · 2 working`), so a stopped request is not hidden behind a working one.

## thnkr.ing rendering (separate change)
Hand-off card pill and one-line state from the standing, naming the current holder and "Moved from"; latest progress under it; thread row shows `worker_waiting` text with a still amber dot; "Work here" lists waiting workers; session row shows "Request open" when `heldRequests` is set and the session is not running, and "Moved" for a superseded predecessor. No notifications.

## Acceptance
- On the real thread "Give an agent context without starting a conversation": the card names the Claude successor, says "Moved from" the Codex one, shows its state and the latest progress; the row is not "No update yet".
- A session row for an idle holder of an open request reads "Request open".
- Focused check (`bot/scripts/request-standing-fixture.ts`): an open thread request whose holder waits on a sent request that is itself idle gets exactly one `request-quiet:` input after 60 minutes, a second only after another 60, none while anything in the chain runs or while held.

A live watch of the holder (any, named or not; accepted or observing, deadline ahead, no coverage gap) makes a request `waiting`, not `quiet`: it wakes the session by itself, so the quiet clock sends nothing and counts nothing until it ends.

## Known limits
'working' still means the holder session has a running turn, not that the turn serves this request; binding turns to requests is follow-on work.
