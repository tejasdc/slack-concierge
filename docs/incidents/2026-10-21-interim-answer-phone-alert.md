# Interim answer sent a result phone alert

On 2026-10-21 Tejas received a phone alert for an agent's interim answer in the
Artists Inbox thread. The answer said the agent was still checking a Ticketmaster
credential and would notify him only if help was needed. The reply was submitted
with `--partial --answers-question` and without `--notify`. Tejas reported the
unexpected alert immediately.

The owner previously treated `answersQuestion` on a partial reply as enough to
consume any pending result notification on the topic. That marker means the agent
answered a direct question before its work request closed; it says nothing about
whether the separate work result is ready. An older topic notification arm could
therefore make this progress reply ring. The report and submitted reply establish
the wrong result; the precise retained arm responsible for that alert has not
been independently inspected here.

The repair makes interim request replies quiet by default, regardless of the
question-answer marker. They still post promptly and settle the answer clock.
`--notify` remains an explicit way to alert on an interim message. A final answer
still consumes a pending human result request and follows the normal decision
notification rule. The owner retains the notification arm until that final answer
or an explicit alert, so a result request is not silently discarded.

The notification contract and real-system check for this repair are in
[requested phone delivery](../contracts/requested-phone-notifications.md).
