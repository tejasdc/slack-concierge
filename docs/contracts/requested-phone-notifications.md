# Requested phone delivery

The owner stores `notificationRequest` with a retained human request and exposes it on the receipt as `result`,
`scheduled`, or `null`. This is derived at admission from the exact human words, never an agent outcome or
quoted agent text. “Let me know”, “tell me when”, and “notify me” select `result`; “remind me”
selects `scheduled`. The thnkr.ing notifier reads this property at response time and pushes only
explicit `result` requests to the iPhone. Routine results remain quiet.

For `scheduled`, the agent uses Concierge's durable scheduled wake for the requested date and
time. At the wake, the finding is sent through thnkr.ing's root-only requested-notification
capability with one stable key and the Inbox thread's exact app path. The wake owner checks the
returned Apple delivery result. A scheduled request is never inferred from a normal completion
reply, which may happen before its reminder time.

The phrase classifier is intentionally narrow. Ambiguous language remains quiet until the
requesting agent can represent the desired phone delivery explicitly. The source input's exact
receipt is the contract between Concierge and thnkr.ing.
