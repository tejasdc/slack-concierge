# Feedback on "threads as a humane representation of thought" — from concierge:3572 (Threads redesign, Inbox thread contract, notice threads, quiet-done, thread latency)

Information only. Nothing here is approved or built.

## 1. What is contradicted, or would break

- **"His replies go to the owning agent; the Inbox is not woken."** Today a thread *is* an Inbox topic in the owner (Concierge): a reply is an input to the Inbox session, its thread root is resolved from the message it answers, the notification slot is keyed to (Inbox, thread root), the Timeline is built from requests the Inbox sent and what came back, and the router's posts are the thread's answers. Sending replies to the owning session breaks all four unless the owner itself routes "reply in thread → owning session" and keeps the thread root, attention slot and Timeline on the thread. It also strands the one structural guard against silence built this week (the owner refuses a quiet end on his own message unless a reason is given, Inbox-only). If owners answer directly, that guard moves to every session or the silence problem returns. So: right direction, but it is an owner-level routing rule, not a UI change.
- **"Face rewritten on each reactivation."** He rejected things changing under him twice this week (rows reordering under his finger; foundations changed unasked). A face an agent rewrites is that unless: his edits win (the drafts store's edit lock pattern: once he edits, the agent may only propose a rewrite), and "since you last looked" is a real diff against his read mark (exists today: per-topic `readSequence`).
- **"Fade salience so only what came back stands out."** He rejected salience as ranking on 2026-09-24 ("How can an active session be behind 20 older sessions?"). Whatever fades must never reorder what waits on him or what is running.
- **"Sessions are disposable, nested under threads."** He pulls research from stalled design sessions later, and yesterday's build lets imported sessions be continued in place. Sessions are the episodes; keep them addressable.

## 2. What to reuse

- Owner-held thread records: roots, questions typed decision/reading with revisions, reading marks, requests with dispatches and returns (the Timeline), posts as the deliberate answer, `answeredByPost`, relay of an unposted answer into its thread, service notices auto-filed with their own thread and "running again" closure, the quiet-reason field shown under a reply, one notification slot per thread, "Being sorted" for unfiled items. Docs: Concierge `docs/plans/2026-09-23-attention-that-ends.md`, `docs/contracts/native-inbox.md`; thinkering `docs/plans/2026-09-22-topic-threads.md`; the interface-decisions skill (his words on notices, cancel, marks).
- The measured economics: thread reads cost 0.3 s; the catalogue (994 sessions, per-row lookups) was 4 s and re-read after every event; the owner serves one request at a time; the Inbox's full receipt list (23 MB) is re-read because a cursor grows past a proxy cap. Retrospective: `thinkering/tmp/reviews/latency-self-retrospective-3572.md`. Replacing the sidebar with threads removes the largest read; that supports the proposal.

## 3. Missing, over-built, wrongly analogized

- Missing: read budgets and who computes what. Face, map, morning page and nightly replay are all owner work. Each surface should state what it reads and that the face is an event-maintained projection, or it becomes the next 4-second read.
- Missing: the seam between the thread record (owner) and project documents (git: AGENTS.md, docs/plans). Which wins when the face and the project doc disagree.
- Over-built for a first cut: map, sleep and immune function together. The failure-family table's "structural answers" are partly instructions in disguise ("no retelling", "heat suggests links"): name the refusal, projection or required field, or call it an instruction.
- Wrongly analogized: an immune system acts autonomously; his rule is proposal-then-approval. What is actually missing is detection: 837 owner-lag lines went unread for two hours. Call it monitoring and alerting.
- Reversal to note: today's routing-only refusal on the router was canceled by him; the quiet-reason field shipped before this design. Fold both into the proposal as candidates, not givens.

## 4. Open questions

- Face: one page per thread, generated from owner records (state, decisions, open questions, requests, what changed since his read mark), with one human-edited section under an edit lock.
- Active cap: keep zero friction at capture; put the cap on starting agent work, not on having threads; never hide parked ones. Design-thread rest requires a decision record: yes, using the existing decision/reading question types.

