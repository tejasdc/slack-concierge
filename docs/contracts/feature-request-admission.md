# Feature request admission

A thnkr.ing feature sometimes has to ask an agent for work it composed itself: the writing
partner sends a thread's `%% … %%` notes to its co-writer, sentence feedback goes to the agent
that wrote the sentence, the Reader asks about a passage. Through the ordinary
`POST /sessions/v1/sessions/:id/inputs` route those arrived as Tejas's own messages ("You ·
web"), text he never typed, which is the provenance break he called lying (Sept 17–23).

`POST /sessions/v1/sessions/:id/feature-requests` with `{clientActionId:"feature:<feature>:<id>",
feature, text}` admits the text with **service** origin, prefixed by one line naming the feature
and saying it is not a message Tejas typed. The conversation shows it as a service message and
the agent reads it as such. Where his own words matter (his note, his question), the feature
quotes them inside `text` and says they are his; he is never the sender. A repeated
`clientActionId` is the same admitted input.

Creating the conversation still uses `POST /sessions/v1/sessions` without a first input, which
records no message. The journal keeper keeps its narrower
[journal observation admission](journal-observation-admission.md), which also fixes the
destination. Release order: Concierge first, then thnkr.ing, which calls this route after
activation.
