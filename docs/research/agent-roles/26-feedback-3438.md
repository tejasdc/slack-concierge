Feedback from concierge:3438 ("Brainstorm: topic threads that keep collecting", 2026-09-20).
My session brainstormed exactly this: threads that keep accumulating, agents appending typed
links, and how an agent learns a relevant thread exists. Artifacts, all still on the box:
`/root/workspace/thinkering/tmp/brainstorm-threads/{options.md, prior-thinking.md, readwise.md}`.
prior-thinking.md is a sourced digest of his own earlier design work; nothing below is new.

1. Contradicted by, or would break

- **The face has no recognition rule, so nothing can file into a thread.** In ChatGPT
  `session:WzIsMzIwOSwxXQ` he converged on the attractor primitive: purpose,
  *what-signals-belong-here*, current evidence, candidate items, maturity criteria, review
  trigger, possible outputs, steward — and "I would not implement an attractor as a folder."
  The proposal's face carries decided/open/changed but not the recognition field. Without it the
  nightly pass has no criterion to file by and the immune function has no threat signature.
- **"The face is rewritten each time the thread is reactivated" collides with the endorsement
  invariant.** In thnkr.ing's workspace, an agent actor may only author proposals
  (`HUMAN_ENDORSEMENT_REQUIRED`); accept/edit/reject is his. A face an agent rewrites in place
  either bypasses that or must itself be a proposal. His own rule from the same session: the
  three extraction timescales exist to "prevent the same agent that made a decision from also
  becoming the unquestioned historian of why it was correct" — so the owning agent should not be
  the only author of its own thread's face.
- **Two timescales where he specified three.** Working agent + nightly sleep drops the middle
  steward that consolidates after a meaningful transition. That middle one is the cheap one.
- **Typed links already exist, with different names.** Eighteen kinds ship today with a required
  reason, pinned endpoint revisions and retraction history — including `instance-of`,
  `evidence-for`, `supersedes`, `contradicts`, `caused`, `led-to`. "This is an example of that
  problem" is `instance-of`; "this is where it broke" is `evidence-for`. A new four-link
  vocabulary is a second table for the same knowledge.
- **Topic vs branch was his correction, and the proposal flattens it back.** In
  `session:WzIsMzM3MiwxXQ` he rejected a ten-entity taxonomy and separated Topic (territory),
  Branch ("a visible growth path", created only once a thought accumulates children) and Thought
  (atomic, typed by glyph). One "thread" state machine covers a one-message capture and a
  multi-month territory identically.
- **Two thread stores.** Notes already are threads (root + children, Timeline, Review). If the
  thread record lives only with Concierge, his not-yet-building idea threads live in one place
  and his work threads in another, and no rule says which.

2. Reuse

- The attractor field list, review triggers ("every 10 incidents OR same cluster 3×"), and "one
  occurrence, multiple projections" (one incident feeds several threads).
- Automatic analysis: it already reads new *human* material and proposes typed links with pinned
  evidence into Review. The recognizer exists; it has never been pointed at agent work.
- `self-healing-agents` (on disk): rejection is a signal; an edit means right direction, a
  deletion means the rule was wrong; trail evaporation (unreinforced traces decay); two-signal
  activation before acting. The immune function should be these, not a new mechanism.
- One real gap: agents cannot write into a note or link to one today — only `/captures/note`,
  verbatim. That single proposal-shaped write path is the smallest thing worth building.

3. Missing, over-built, wrongly analogized

- Missing: the decay rule; where a thread physically lives; what sleep actually reads (day's
  final reports and his messages, not full transcripts — cost).
- Over-built: the Map, and the immune function as a *named subsystem* — in the agent-ecology
  thread he argued the opposite ("we should not define sleep or immune system... define the
  physics"). That tension is his and unresolved; surface it rather than settle it silently.
- Analogy: consolidation prunes and strengthens selectively, and "local sleep" means it need not
  be globally idle — per-project batch on idle gets the cross-session view without a nightly
  global job.

4. Open questions

- **Face:** one page, but with the recognition rule at the top and split authorship — agent
  proposes, he endorses.
- **Active cap:** I would not ship it. His own pattern is that unfinished design threads pay off
  later ("I just asked that agent to get some input from that session"); a cap taxes exactly
  that. Ship the point-of-performance question first, measure parking, and only then consider a
  cap.

