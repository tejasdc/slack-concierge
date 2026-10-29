# Route one Inbox message

## What happens today

An Inbox message has an accepted input identity. A reply written inside a thread keeps its own identity and points to the message it answers. The owner follows that reply link to the first message of the conversation. A topic contains conversation roots, and the conversation page includes every message that resolves to each root. The router's `topics place` command accepts a message ID but resolves it to that root before placement. Consequently, naming one reply moves the entire conversation into another topic. The accepted messages and their bytes do not move in storage; their topic projection changes together.

An ordinary reply in a thread goes straight to the working agent when that thread has an eligible reply target. The owner retains a request for the exact human input and posts the agent's partial and final answers back under the request's thread root. Router requests also name a thread root, so their progress and answers appear under that thread. A placement change does not make a reply an independent work item or redirect its existing answer obligation.

## The October 15 case

Tejas asked about a Mac shortcut in a meditation thread. He then wrote an account-system question inside that thread, because that was where the held-agent behavior had occurred. The router tried to put only that question in the account-system thread. Placement followed the question to the meditation conversation root, so the meditation request, answers, and replies all appeared under the account-system topic. Moving the root back restored the meditation thread but left the account question without a distinct destination.

## Required behavior

1. The router names the exact accepted human message and a destination topic or session. The owner rejects a message that does not belong to the stated source or a destination that cannot receive it.
2. The source conversation keeps its root and all of its original messages. At the exact question, Tejas sees a receipt naming and linking to the destination.
3. The destination presents that message's original words, author, time, and attachments, plus a link to the source. The destination has its own message identity for page and reply targets; it names the original accepted input so provenance survives.
   A route to a sleeping Mac session first records a pending receipt and an exact queued delivery on the server. The destination link becomes ready only after the Mac accepts that delivery; a refusal shows failed delivery at the source. A terminal refusal permits a new route for that same source message, while the failed attempt remains in the audit history.
4. Follow-up work and answers use the destination's address. The source receipt does not become an answer or carry a second work obligation.
   The destination's provenance names the accepted message Tejas actually typed, even when the Inbox router was acting from another input when it routed it. If that original message never ran an agent turn, its provenance carries no run ID.
   Its topic context is the topic of that original message, not whichever thread happened to wake the router for the routing action.
5. `topics place` and whole-conversation moves require an explicit conversation root. Passing a reply returns a refusal that points to the one-message route. A genuine whole-conversation move remains available by naming the root.

For today's case, the meditation thread continues to show the Mac shortcut request and its full dialogue. Its account-system question stays at the place where Tejas typed it, with “Routed to Held work doesn't switch to an account with room” and a link. That thread shows the question as Tejas's message with “From Mac shortcut to start your Waking Up meditation” and a link back. He continues the account question there, and its answer appears there.

## Ownership and choice

Concierge owns the accepted input, the routing event, the two topic projections, and any request to an agent. Thinkering reads those projections and renders the links. One routing event is the durable fact, so reconnects and rebuilding a prepared page produce the same result. A distinct one-message route is needed because the existing root placement intentionally groups a conversation. Rewriting the reply's root would change the meaning of earlier answers and move its descendants. Leaving the message in place alone would make Tejas hunt for the agent's answer. Copying text into a new human input would lose the original accepted identity and invite duplicate execution.

The routed topic copy has a visible event address that acts as its thread root. Event storage requires an accepted input as custody, so replies and notices retain the route action's accepted input in that field and retain the visible thread root in their payload. Both live and prepared readers use the visible root for conversation placement and answer attribution. The first live answer check exposed this distinction: treating the visible event address as an accepted input failed the database foreign key and kept the answer out of the destination.

The live acceptance check routes an agent-marked test message from one test thread to another, observes its source receipt and destination message through the real Thinkering read path, then verifies the original root still holds its other messages and that a reply's ID is refused by whole-conversation placement. The marked test entrance is accepted by the same route contract as Tejas's own input, using its retained source input and run identity. A separate check routes a test message to a session and verifies its answer destination. A candidate build alone is not live acceptance.

## Several goals in one capture

The same accepted source message may have several topic-route events, each with its own action identity, visible destination message and thread root. The owner refuses a second route into a topic that already holds one of that source's routed messages, including after a topic move. It keeps all source receipts in routing order; older readers use the first receipt, while current readers show every destination. Each routed message independently names the original source and is the address used for a goal's agent request and reply. A reply under the original source cannot silently select among several destinations.
