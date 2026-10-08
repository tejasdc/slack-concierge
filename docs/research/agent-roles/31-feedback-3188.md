1. **Contradictions and breakage**
- A thread cannot also be the unit of execution. We observed one human request routed to two destinations: one was working while the other never accepted delivery. Collapsing them produced the false aggregate “Failed.” A thread needs child work records, each with its own destination, admission, progress, result and failure. Aggregate state must preserve partial delivery.
- “Inbox has no answer path” is too absolute. Some captures intentionally stay in Inbox, and the router may need to confirm placement, ask a routing question or answer about its own operation. Remove the relay path; retain deliberate router-to-human posts.
- Nightly rewriting faces, pruning links and closing sessions would change durable meaning without him. Generated synthesis must be revisioned, source-linked and visibly proposed; accepted decisions and original episodes cannot be silently rewritten.
- This proposal must reconcile with the already approved topic architecture in `docs/plans/2026-09-22-topic-threads.md` and attention ownership in Concierge’s `docs/plans/2026-09-23-attention-that-ends.md`. Replacing those foundations requires another explicit approval.

2. **What to reuse**
- Our original Slack-inspired design established: a top-level human-meaningful list; open one item to see its history; machine identifiers behind disclosure; routing rendered from the owner’s structured ledger, never parsed from agent prose; destination sessions as direct links.
- The later repair established a stronger invariant: human text is the item’s identity, attachments belong with it, and the transcript must not duplicate the same request as an empty message shell.
- Membership is owner-linked only. The browser must never infer that shared provider activity belongs to a request or thread.
- Status is per destination. “Awaiting response,” “not delivered,” and “response received” remain separate; an aggregate says “in progress” while any accepted work remains open.
- “Done” means done for now: new activity returns an item to the working set. Carry that into resting/done semantics.

3. **Missing or over-built**
- Missing: explicit child-work and evidence models; provenance for every face claim; correction/history for generated synthesis; handling for intentional non-routing; unread/result/decision attention as separate facts.
- Over-built: spatial maps, nightly link fading and an automatic active cap before the basic thread/work/attention contract is proven.
- The neuron, immune and metabolism analogies are useful prompts, not architecture. Translate each into an enforceable owner contract or drop it.

4. **Open questions**
- The face should be a structured, revisioned projection, not one freely rewritten page: stable human-edited purpose; accepted decisions with reasons; open questions; current child work; generated “since you looked” with sources.
- A hard cap of five likely backfires. Three-to-five sessions started per day is not evidence for five concurrent thoughts. Preserve frictionless capture; use a soft focus set and ask him to park or finish something only when starting another substantial execution or when measured overload triggers it.

