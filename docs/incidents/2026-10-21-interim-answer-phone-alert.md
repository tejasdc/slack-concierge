# Interim answer sent a result phone alert

On 2026-10-21 Tejas received a phone alert for an agent's interim answer in the
Artists Inbox thread. The answer said the agent was still checking a Ticketmaster
credential and would notify him only if help was needed. The reply was submitted
with `--partial --answers-question` and without `--notify`. Tejas reported the
unexpected alert immediately.

Tejas's Ticketmaster request said, "If you still need my help. Send me a
notification." The request classifier treated that as a general result alert,
although it was conditional on needing his help. The owner then treated
`answersQuestion` on a partial reply as enough to consume that pending alert.
That marker means the agent answered a direct question before its work request
closed; it says nothing about whether the separate work result is ready.
The retained ledger confirms the exact chain: human input
`4aa2dd7a-95f5-4aeb-83b9-8ce322d36b42` was admitted with a `result` mark; its
arm was consumed by partial post
`post:forward:8757aafa-e139-4aef-9623-348ac14af95b`; the resulting
`needs_you` event named that input and post with `requestedNotification:true`.
The diagnostic snapshot establishes Concierge's request to send that push.
Tejas's report is the evidence that it reached his phone.

The repair removes help-needed wording from the general result classifier;
Concierge's existing blocking-question path alerts Tejas if the agent needs him.
It also makes interim request replies quiet by default, regardless of the
question-answer marker. They still post promptly and settle the answer clock.
`--notify` remains an explicit way to alert on an interim message. A final answer
still consumes a pending human result request and follows the normal decision
notification rule. The owner retains the notification arm until that final answer
or an explicit alert, so a result request is not silently discarded.

The notification contract for this repair is in
[requested phone delivery](../contracts/requested-phone-notifications.md).
