TL;DR: Direct conversation with a thread’s owner fits our findings. But this proposal needs an explicit read/update architecture: otherwise faces, maps and nightly consolidation can recreate the same history-dependent work that made opening threads slow.

1. What would break

“Rewritten each time the thread is reactivated” must not mean opening a thread waits for an agent or reconstructs its history. Our investigation found a 23 MB full-receipt fallback despite browser storage: the browser sent its cursor, the proxy rejected its growing size, and the client silently fetched everything. Server notification preparation also reconstructed one thread through whole-Inbox reads. A new representation alone does not remove these paths.

“Sessions are disposable” should mean disposable execution context, not disposable provenance, pending obligations or exact message identities. Archiving cannot imply completion. Direct owner answers should preserve explicit request settlement and attachment custody while removing Inbox retelling.

2. Reuse from this session

Read docs/plans/2026-09-25-latency-retrospective.md and its companion latency-retrospective-evidence.md on branch worktree-latency-retrospective (commit 4ef90bb). Both are proposals, not approved changes. This session built no runtime functionality.

The proposed invariant is: opening one thread costs a bounded page; updating it costs what changed, independently of unrelated retained history. Maintain indexed presentation records as authoritative changes occur; use compact revision cursors, bounded reset pages and one contract across browser, proxy, owner and notification readers. Separate expensive reconstruction from the interactive event loop without creating another execution authority.

Tejas explicitly said: “This is not about adding another index.” The continuation author admitted reviewing correctness without considering list cost; the Threads author admitted making the wait calmer without shortening it. Therefore role instructions and an immune agent cannot substitute for enforced access boundaries. Performance release checks remain a separate approval decision under the present no-tests policy.

3. Missing or over-built

Specify who may change each fact, how conflicting edits resolve, and how proposed, approved and completed stay distinct. The face cannot silently promote an agent’s interpretation into his decision. Original words and the Inbox’s expansion must remain separately identifiable.

Nightly consolidation must not be required for current correctness. Process new material incrementally and make the job resumable; do not rescan everything nightly. “Closes finished sessions” and “prunes dead links” need explicit predicates and reversible history. Low salience does not mean an obligation disappeared.

The immune function should group repeated symptoms into one evidence-backed incident and propose a remedy. Thousands of slow-operation logs must not become thousands of agent invocations. Detection is distinct from authority to repair.

Metabolism is useful for generating hypotheses, but “energy is abundant” is not an operating fact: provider quotas, synchronous reads and human review remain scarce. More agent activity can increase contention.

4. Face and active cap

Use one recognizable landing page per thread, backed by separately versioned decisions, open questions, ownership and source-linked narrative. Preserve human edits; show freshness and changes. A single repeatedly rewritten blob is easy to read but risks overwriting decisions and creates another full-object synchronization problem.

Five daily destinations does not establish five sustainable active commitments. I have no evidence for a clinical ADHD recommendation. Offer a user-adjustable focus set with visible deferred work; keep capture available. Compare that with a hard cap through his actual use before imposing refusal. Mandatory parking paperwork could reproduce the decision burden he described.
