# Questions Tejas asks

The Inbox topic owner stores each specific question Tejas asks as a topic question with
`kind: "asked"`. This is distinct from a decision an agent asks him to make and a reading
item an agent leaves him. A declaration names one accepted human source message in that
topic, the question in his words, and (when work was dispatched) the exact request ID.
The owner refuses an agent-authored source, a source in another topic, or a declaration
without one source. The Inbox router declares questions in captured messages when it
routes them, with a separate work request for each specific question. A worker receiving a directly forwarded thread reply can declare the
question in that reply using the topic and source identity in its request framing.
The displayed asked time and sort time come from that original human message, even when
the Inbox declares the question later. The declaration's own write time remains an
internal update time.

The answer is not copied into the question. The prepared reader resolves answer-bearing
Inbox posts for the linked request and source messages. An explicitly marked partial is
an answer as soon as it is posted; progress-only partials do not settle the question.
Completed final replies count as answers, including older replies made before the explicit
answer marker was retained on posts. A stalled or decision-needed final does not silently
turn the question into answered. Answer posts appear in order with their complete message
detail available. An unanswered question stays first in the `asked` page;
answered questions follow, each group newest first. The browser sends a follow-up as a
normal addressed thread reply, then links the accepted human input to the same question.
The owner verifies the source before appending it. Replies to that input join the item's
answer history; a failed link leaves the reply sent and reports that the view is behind.
Changing the linked answer request or source messages advances the question revision, so
prepared reads discard their earlier answer list and load the new association.

This uses the existing topic stream, accepted inputs, addressed reply path and prepared
question browser. A second question database would duplicate topic placement and reply
custody. Treating final work summaries as questions lost the original wording and hid
partial answers; the `asked` kind keeps the question's identity separate from the
agent's progress. The router and directly addressed worker make the semantic judgment
that his message asks a question; the owner enforces the source and answer linkage.

The session owner's presentation routes for the all-questions page, topic overview,
and topic items admit the `asked` filter before the prepared reader runs. The first
live Mac check on October 12 found that the reader supported it while the route
guards still returned 400, leaving the page at its loading error.
