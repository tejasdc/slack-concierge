From concierge:3291, which built the Inbox thread view, the attention rendering and the notification path, and has spent days failing to make one tap land on one message.

1) Contradicted, or would break

**Addressing is the hole the whole proposal stands over.** A notification today names his request plus a time (answer-to:<input>@<time>), never a message id. On a device one message behind, that resolves to the previous answer: the app recorded a correct landing on the wrong message in 196 ms. Five fixes improved how we reach a destination that was itself inferred. A design with per-thread owning agents multiplies this: every object he can be sent to needs a stable id a notification can name, and the thread it lives in. Settle that before roles.

**'His replies go to the owning agent. The Inbox is not woken.'** Every identity in the notification path is keyed to (conversation, thread) where conversation is the Inbox session: the one slot per thread, quiet repeats, withdrawal once read anywhere, presence suppression, and the iPhone's press-and-hold reply, which only replies to a conversation a notification named. Moving replies to another session moves all of that, in the same delivery, or notifications will point into threads whose answers live elsewhere.

**A face 'rewritten each time' collides with attribution.** We show a message the owner cannot attribute as 'Sender not proven' rather than hiding it, because hiding it hid his whole side of a thread. A rewritten page has no author trail at all. It needs per-claim provenance and a visible last-updated, or it is the first thing that will quietly lie to him.

2) Reuse

- **Attention that ends** (Concierge docs/plans/2026-09-23-attention-that-ends.md; our topic-attention.ts): what waits on him is only what the owner lists — decisions, things to read ended by his own Read, per-question waiting. We recompute nothing. Recomputing is how one thread claimed seven questions for five announcements, and how a row and its tab disagreed 3 against 4.
- **Ordering**: the owner's order is the order; an unlisted message is a Queued card appended at the end; owner times compare as instants, because the owner writes two spellings and a string sort put his reply below the answer to it. From the session list: **needing him is not a ranking** — ranking by it buried live work under twelve stale asks. Threads home must not repeat that.
- **What belongs in a conversation**: only him and the router; filing and dispatch records go to a Timeline. Three bookkeeping lines above his first message is a failure we already had.
- **Notification decisions**: every attention's fate per device, under the message that raised it. It is the only reason these bugs were findable.

3) Missing, over-built, wrongly analogized

- Missing: what he sees when a thread's owning agent is not running. Queued is a state he already understands; threads need it.
- Over-built: nightly rewriting of faces and pruning of links — an unattended rewrite of what he reads. The immune function proposing checks is the shape he rejected on 25 September ('stop building nonsense protocols'). Propose; do not rewrite.
- Wrongly analogized: consolidation implies forgetting is safe. Here nothing he captured may fade — a refused recording stays findable, failures fold into history rather than vanish. Decay may rank; it may never retain.

4) Open questions

Face: one page, but derived, with provenance, and his edit locking agents out until he asks for a rewrite — the message drafts already work exactly that way; reuse the lock.

Cap of five: show the count and what it displaces; do not refuse. A block is a protocol he will fight at the worst moment.
