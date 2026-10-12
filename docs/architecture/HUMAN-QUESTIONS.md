# Questions Tejas asks

The Inbox topic owner stores each specific question Tejas asks as a topic question with
`kind: "asked"`. This is distinct from a decision an agent asks him to make and a reading
item an agent leaves him. A declaration names one accepted human source message in that
topic, the question in his words, and (when work was dispatched) the exact request ID.
The owner refuses an agent-authored source, a source in another topic, or a declaration
without one source. The Inbox router declares questions in captured messages when it
routes them, with a separate work request for each specific question. A worker receiving a directly forwarded thread reply can declare the
question in that reply using the topic and source identity in its request framing.

The answer is not copied into the question. The prepared reader resolves the retained
Inbox posts for the linked request and source messages. Partial and final worker replies
therefore appear in order, with their complete message detail available. A partial is an
answer as soon as it is posted. An unanswered question stays first in the `asked` page;
answered questions follow, each group newest first. The browser sends a follow-up as a
normal addressed thread reply, then links the accepted human input to the same question.
The owner verifies the source before appending it. Replies to that input join the item's
answer history; a failed link leaves the reply sent and reports that the view is behind.

This uses the existing topic stream, accepted inputs, addressed reply path and prepared
question browser. A second question database would duplicate topic placement and reply
custody. Treating final work summaries as questions lost the original wording and hid
partial answers; the `asked` kind keeps the question's identity separate from the
agent's progress. The router and directly addressed worker make the semantic judgment
that his message asks a question; the owner enforces the source and answer linkage.
