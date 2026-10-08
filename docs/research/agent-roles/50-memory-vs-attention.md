# Memory vs. attention as separate machinery — research for thread representation design

Scope: is a "thread" one structure or two? Cognitive science on memory/attention as distinct
systems; HCI/PIM work on activities vs. tasks vs. documents and one-structure/many-views;
agent memory architectures (2024–2026) and the coordinator-doesn't-know-what-its-workers-know
failure; and software patterns (CQRS, DB views) for one structure with multiple projections.
Ends with candidate primitives and open questions. Confidence is marked per section; this is a
literature scan, not a validated design.

---

## 1. Cognitive science: memory and attention as separate machinery

**The core distinction the literature supports:** attention is a *selection/limited-capacity*
mechanism; memory is a *storage/content* mechanism. Several models place a small, attention-gated
window on top of a much larger, passively-held store — which maps fairly directly onto "what's
active for me right now" vs. "everything that's ever been true about this thread."

- **Cowan's embedded-processes model** treats working memory not as a separate box but as (a) the
  set of long-term-memory representations currently *activated*, and (b) a much smaller subset of
  those, usually ~4 chunks, held in the **focus of attention**, controlled jointly by a voluntary
  central-executive process and an involuntary attentional-orienting process. Capacity limits are
  attentional, not structural — there's one memory, and attention is the spotlight on part of it.
  (Cowan, "An embedded-processes model of working memory"; overview: [PMC6105130](https://pmc.ncbi.nlm.nih.gov/articles/PMC6105130/), [Wikipedia: Nelson Cowan](https://en.wikipedia.org/wiki/Nelson_Cowan).)

- **Baddeley's episodic buffer** (added 2000 to the multi-component model) is a limited-capacity
  system that *binds* material from the phonological loop, the visuospatial sketchpad, and
  long-term memory into single integrated episodes (e.g., the memory of a story), under control of
  the central executive. It was motivated by amnesic patients who could not form new long-term
  memories but could still hold a coherent multi-element episode briefly — i.e., binding-into-one-
  episode is itself a distinct function from durable storage. ([Wikipedia](https://en.wikipedia.org/wiki/Baddeley's_model_of_working_memory), [ScienceDirect overview](https://www.sciencedirect.com/topics/psychology/episodic-buffer).)

- **Oberauer's focus of attention** sharpens this further into three nested states: the
  activated part of long-term memory, a capacity-limited "region of direct access," and a
  single-item (or single-chunk) **focus of attention** selected for immediate processing.
  Empirically, response latencies depend on which digit set is in the *active* vs. merely
  *held* set — direct evidence that "known" and "currently operated on" are separable states of the
  same content. (Oberauer, 2002, "Access to information in working memory: Exploring the focus of
  attention," *J. Exp. Psychol.: LMC* 28(3):411–421, [doi](https://doi.org/10.1037//0278-7393.28.3.411);
  retro-cue literature review: [Springer](https://link.springer.com/article/10.3758/s13414-016-1108-5).)

- **Transactive memory (Wegner, 1987)** addresses a different axis: not "what do I know" but
  "who/what holds this, and do I know where to look." A transactive memory system is the
  individual knowledge stores of group members *plus* a shared meta-memory of who-knows-what, built
  through encoding/storage/retrieval phases across the group. This is the closest existing construct
  to "the thread's agent doesn't need to hold everything its sessions know — it needs an index of
  which session holds what." (Wegner, D.M., 1987, "Transactive Memory: A Contemporary Analysis of
  the Group Mind," in Mullen & Goethals, *Theories of Group Behavior*, pp. 185–208 —
  [full chapter PDF, Harvard](https://dtg.sites.fas.harvard.edu/DANWEGNER/pub/Wegner%20Transactive%20Memory.pdf); overview: [Wikipedia](https://en.wikipedia.org/wiki/Transactive_memory).)

- **Prospective memory / goal maintenance** is the "what to do now" machinery, and it is
  anatomically distinguishable from episodic recall: rostrolateral prefrontal cortex (BA10)
  selectively activates during the *maintenance* of a pending intention (not encoding, not
  retrieval), and a fronto-parietal top-down network persists throughout a delay to keep the
  intention alive while other tasks run. This is a dedicated "what's pending for me" system,
  separate from the store of what happened. ([PMC3142765](https://pmc.ncbi.nlm.nih.gov/articles/PMC3142765/), [Oxford Cerebral Cortex](https://academic.oup.com/cercor/article/22/8/1876/320670).)

- **Pattern completion vs. gating.** The hippocampus performs *pattern completion*: a partial cue
  triggers retrieval of a full stored association — this is the retrieval/reconstruction half of
  memory. The prefrontal cortex (with the thalamic nucleus reuniens as relay) performs *gating*:
  deciding which hippocampal information gets through to influence current behavior, and
  inhibitory control over which memories intrude. Thalamic (mediodorsal) activity modulates how
  prefrontal cells respond to hippocampal input — i.e., there's a separate circuit for "what do I
  retrieve" vs. "what gets through to control behavior right now." ([PMC4354269](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4354269/), [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1074742715002178).)

**Synthesis of this section (confidence: high that the distinction is real and well-replicated;
lower confidence in how cleanly it maps onto software):** across every model surveyed, "the content
that exists" (long-term/activated memory, hippocampal associations) and "the narrow thing being
operated on right now" (focus of attention, PFC-gated access, prospective-memory maintenance) are
functionally and often anatomically distinct, even though they operate on the *same underlying
content*. No model proposes two copies of the memory — one small selection mechanism sits on top of
one large store. This is direct support for Tejas's intuition: a thread's full content (memory) and
a thread's "is this active, does it need me" status (attention) are different *functions* over the
same record, not two different records.

---

## 2. HCI / personal information management: activities, tasks, documents, and one-structure/many-views

- **Bardram's Activity-Based Computing (ABC)**, developed from 2003 in hospital settings, makes
  the "activity" (not the document or the application window) the unit the computer manages: an
  activity bundles the services, documents, and state needed for one piece of (often interrupted,
  resumed, handed-off) clinical work, addressing "parallel activities and interruptions...amplified
  because multitasking is combined with...mobility, collaboration, and urgency." Directly relevant:
  Tejas's threads are interrupted/resumed/handed-off the same way clinical tasks are.
  ([Bardram, "Activity-based computing," *Pers Ubiquit Comput* 2005](https://link.springer.com/article/10.1007/s00779-004-0335-2); [AI Magazine 2015 overview](https://onlinelibrary.wiley.com/doi/abs/10.1609/aimag.v36i2.2585).)

- **Kaptelinin's UMEA** ("User-Monitoring Environment for Activities," CHI 2003) automatically
  files documents, URLs, and resources under higher-level user-defined "projects," translating raw
  interaction history into project context — an early version of "the thread is the organizing
  unit, not the file." IBM's related Unified Activity Management (UAM) research line treats "the
  activity model" as a new unit of work coordination presenting all resources in one context.
  ([UMEA, CHI 2003](https://dl.acm.org/doi/10.1145/1054972.1055017); [UAM overview](https://www.researchgate.net/publication/228618473_Unified_activity_management_explicitly_representing_activity_in_work-support_systems).)

- **Bellotti's Taskmaster** recast email itself as task management via "thrasks" (threads of
  messages/links/drafts tied to one task) with visible deadline urgency (two-week bars going from
  green to red) and explicit action-item ownership (red/blue balls for "my" vs. "others'" actions).
  This is an early, concrete instance of exactly Tejas's attention view: one object (the thrask)
  surfaced differently depending on whose action is outstanding and how urgent it is.
  ([Bellotti et al., CHI 2004, "Taking Email to Task"](http://www.chi2004.org/res/Taking%20Email%20to%20Task.pdf).)

- **Gonzalez & Mark's "working spheres"** (CHI 2004 field study of analysts, developers, managers)
  found people average ~3 minutes per task and work across **~10 concurrent working spheres**,
  spending ~12 minutes in one before switching — empirical grounding for "a person's day is made
  of many live threads being time-sliced," and their conclusion that "design...needs to support
  people's continual switching between working spheres" is a direct argument for an attention
  view that shows *which threads are live* and *where each one left off*.
  ([González & Mark, CHI 2004, "Constant, constant, multi-tasking craziness"](https://ics.uci.edu/~gmark/CHI2004.pdf).)

- **Czerwinski, Horvitz & Wilhite's diary study** of task switching found that interruptions
  arriving at middle/late task stages cause longer suspension and worse resumption, and follow-on
  work (Mark et al., CHI 2008) found people compensate for interruption by working faster at the
  cost of stress and frustration — i.e., resumption cost is real and the *state a thread was left
  in* matters for how expensive it is to pick back up. This argues for an attention view that
  preserves not just "this is active" but "here is exactly where you left it."
  ([Czerwinski et al., CHI 2004](https://www.interruptions.net/literature/Czerwinski-CHI04-p175-czerwinski.pdf); [Mark et al., CHI 2008, "The Cost of Interrupted Work"](https://ics.uci.edu/~gmark/chi08-mark.pdf).)

- **Engelbart's NLS "view control"** is the cleanest precedent for "one structure, many views":
  a single structured hyperdocument could be rendered through different lenses — selective level
  clipping, content filtering, outline-vs-detail — and a *link itself* could specify which view to
  retrieve the destination in. The document didn't change; what changed was the retrieval/rendering
  function applied to it. ([ACM Hypertext retrospective, Engelbart](https://ics.uci.edu/~dfredmil/ics227-SQ04/papers/Hypertext/Secondary/p30-engelbart.pdf).)

**Synthesis of this section (confidence: high — this is a mature, convergent literature):** HCI/PIM
researchers independently arrived at the same shape Tejas is proposing 20+ years ago: the
organizing unit should be the activity/project/thrask, not the document or the message; the same
unit needs an urgency/ownership view (Taskmaster's bars and balls) distinct from its content view;
switching cost is real and argues for preserving exact resumption state; and the mechanism for
"one object, different presentations" (Engelbart's view control) already existed before any of
this was about software agents.

---

## 3. Agent memory architectures (2024–2026) and the coordinator-knowledge-gap problem

- **MemGPT / Letta**: treats the LLM like an OS managing virtual memory — a small, always-visible
  "core" context (RAM) and a much larger external "archival"/recall store (disk), with the model
  itself issuing explicit function calls to move data between tiers. Letta's production version
  keeps this **agent-scoped**: each agent has its own core memory plus its own archival store.
  Relevant tension for Tejas's design: this architecture was built for *one* agent's continuity
  over time, not for *multiple* agents (sessions) sharing one memory — scoping memory to the agent
  rather than to the thread is exactly the structural choice that produces his "thread's agent
  doesn't know what its sessions know" problem if applied naively.
  ([MemGPT paper, arXiv:2310.08560](https://arxiv.org/pdf/2310.08560); [Letta architecture overview](https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1).)

- **A-MEM** (Xu et al., NeurIPS 2025) takes a Zettelkasten approach: memories are atomic notes that
  the agent itself links to other notes via generated contextual descriptions, with the network of
  links evolving as new notes arrive — i.e., structure (what's related to what) is discovered
  and maintained continuously rather than fixed at write time. This is relevant to "memory unit" as
  a durable node with threads of linkage, not a flat log. ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110).)

- **HippoRAG** directly operationalizes the neocortex/hippocampus split for retrieval: an LLM
  extracts entities/relations into a knowledge graph that plays the role of the hippocampal
  **index** (pointers + associations between memory units), while the units themselves are stored
  separately (the "neocortex" role); retrieval runs Personalized PageRank over the index to do
  pattern completion from partial cues. This is a concrete engineering pattern for "the index that
  says what's connected to what" being a separate structure from "the content," which maps onto
  §1's hippocampus/PFC split and is a candidate mechanism for a thread's cross-session index.
  ([arXiv:2405.14831 / NeurIPS 2024 paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/6ddc001d07ca4f319af96a3024f6dbd1-Paper-Conference.pdf).)

- **Generative Agents (Park et al., UIST 2023)**: every observation is logged to a flat, timestamped
  **memory stream**; retrieval scores candidates by a weighted combination of *recency*, *relevance*
  (embedding similarity to current query), and *importance* (an LLM-assigned salience score), with
  periodic "reflection" passes that synthesize higher-level memories from low-level ones. This is a
  pull-based, single-agent retrieval model — there is one agent per character, so it doesn't
  address the multi-session-into-one-thread problem directly, but the recency/relevance/importance
  scoring is a reusable primitive for ranking what to surface in an attention view.
  ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442); worked example of the composite score: [AgentPatterns.ai](https://agentpatterns.ai/agent-design/generative-agents-memory-stream/).)

- **Anthropic's multi-agent research system** (lead/orchestrator + parallel subagents, each with
  its own context window) is the most directly relevant case of Tejas's exact tension, reported
  from production experience. Two load-bearing facts: (1) context is **deliberately not shared**
  between the lead and subagents — each subagent gets its own window for "separation of concerns";
  (2) this caused a real failure: vague delegation ("research the semiconductor shortage") led one
  subagent to explore the 2021 chip crisis while two others duplicated 2025 supply-chain research,
  because **subagents didn't know what their peers were doing and the lead didn't know enough to
  prevent the overlap**. The fix was not giving the lead full visibility into subagent work — it
  was writing much more explicit task boundaries into delegation itself ("don't research X, that's
  another subagent's job") plus pushing the lead's own plan to **external memory** so it survives
  context truncation and can be re-read rather than re-derived. In other words: Anthropic's
  production answer to "the orchestrator doesn't know what the workers know" was *better upfront
  task-boundary specification + a durable external plan the orchestrator re-reads*, not full trace
  sharing. ([Anthropic engineering blog, "How we built our multi-agent research system"](https://www.anthropic.com/engineering/multi-agent-research-system).)

- **Cognition's counter-position ("Don't Build Multi-Agents")** argues the opposite tradeoff:
  "Share context, and share full agent traces, not just individual messages," and "Actions carry
  implicit decisions, and conflicting decisions carry bad results." Their worked failure example:
  one subagent builds a Mario-style background, a second independently builds a realistic bird;
  neither saw the other's intermediate decisions, so the coordinator is left unable to reconcile
  incompatible outputs after the fact. Their stated preference is a **single-threaded agent with
  context compression** for long-running work, treating multi-agent parallelism as something to
  default against unless full-trace sharing is preserved. ([Cognition blog](https://cognition.com/blog/dont-build-multi-agents).)

  **These two production teams reached opposite defaults from the same failure mode** (a
  coordinator/lead missing what a parallel worker learned) — Anthropic chose isolated contexts +
  tighter task contracts + durable external plan; Cognition chose shared full traces + avoid
  parallelism by default. This is the single most relevant piece of evidence for Tejas's stated
  tension and it does not resolve in one direction — it's a real, open design fork, not a solved
  problem. (Confidence: high that both reports are accurate as stated; this is self-reported
  production experience from two labs, not an independently replicated experiment, so treat the
  magnitude of each approach's benefit as a claim, not a measured fact across contexts.)

- **Blackboard architectures** (classical AI pattern, now reapplied to LLM multi-agent systems):
  agents don't message each other directly; they read/write a shared structured space, often
  segmented by topic/task, and a controller activates agents when their preconditions are met on
  the blackboard. This decouples "which agent did this" from "what is currently known," which is
  one candidate shape for the thread's cross-session record (see §5).
  ([Blackboard architecture for LLM multi-agent systems, arXiv:2507.01701](https://arxiv.org/pdf/2507.01701); [overview](https://data-flair.training/blogs/blackboard-architecture-in-agentic-ai/).)

**Synthesis of this section (confidence: medium — this field is moving fast, 2024–2026, with
limited independent replication; treat specific numbers as vendor-reported):** every architecture
surveyed separates "the durable content" (archival memory, the memory stream, the blackboard, the
hippocampal index's targets) from "what's being actively attended to" (core/working context, the
focus-of-attention-equivalent window, the lead agent's live plan) — mirroring §1 almost exactly.
None of the surveyed single-agent memory systems (MemGPT, A-MEM, HippoRAG, Generative Agents)
actually solve the multi-session-one-thread problem, because they're scoped to one agent. The two
systems that *did* face it in production (Anthropic, Cognition) solved it in opposite ways, and
both solutions have costs: isolated-context-plus-explicit-contracts risks silent duplication/gaps
when the contract is underspecified; full-trace-sharing risks exactly the context-bloat problem
memory tiering exists to avoid.

---

## 4. One structure, multiple views: software precedent

- **CQRS** formalizes exactly the shape needed: one write/command model (append facts) and one or
  more independently-optimized read/query models (projections), accepting eventual consistency
  between them as the cost of letting each view be shaped for its own consumer rather than forcing
  one schema to serve every reader. ([Confluent explainer](https://www.confluent.io/learn/cqrs/); [Microsoft Azure architecture guide](https://learn.microsoft.com/azure/architecture/patterns/cqrs).)
- **Database views / materialized views** are the oldest version of this: the underlying relation
  is the single source of truth; a view is a stored *query* over it, not a copy of the data, so
  "attention view" and "memory view" could both be queries/projections over one append-only fact
  log rather than two maintained stores.
- **Engelbart's view control** (§2) is the direct ancestor of both — it predates CQRS by three
  decades and already made the point explicit: store structure once, let presentation (level of
  detail, filter, grouping) be a function applied at read time, and let a *reference* (link) pin a
  particular view.

**Synthesis (confidence: high — this is settled, widely-practiced software architecture):**
nothing here is novel engineering risk. The open design question is not "can one structure support
two views" (yes, trivially, with either materialized views or read-time projection) but "what is
the one underlying structure, and what are the exact projection functions for human-attention vs.
agent-memory."

---

## 5. Synthesis: candidate primitives, how the thread's agent stays current, open questions

### Candidate primitive: one append-only record, two projections

Across cognitive science (§1: one memory, attention is a selection function over it), HCI (§2:
Engelbart's view control, Taskmaster's one-thrask-two-lenses), and software (§4: CQRS, views),
the convergent answer is **not** "two data structures that must be kept in sync" but **one
underlying fact log per thread, with two read-time (or periodically materialized) projections**:

- **Memory projection (for agents):** the full append-only record — every session's actions,
  decisions, artifacts, and who/which-session did what — queryable by content (semantic/episodic,
  §1) and by provenance (who-knows-what, Wegner's transactive-memory layer). This is the
  HippoRAG/A-MEM role: an index over durable content, built for retrieval by a *different* reader
  than the one who wrote it.
- **Attention projection (for Tejas):** a much smaller, attention-shaped view derived from the same
  log — is this thread live, what's the single outstanding action, who owes what (Taskmaster's
  balls/bars), where did I leave off (Czerwinski/Mark's resumption-cost argument), ranked by
  something like Generative Agents' recency/importance/relevance composite rather than raw recency.

This reframes Tejas's "memory unit vs. attention unit" tension: they aren't two kinds of thread,
they're two queries against one thread's log — matching Cowan/Oberauer's "one store, attention is
a limited window onto it" almost exactly, and sidestepping a synchronization problem by
construction (per §4, the views are derived, never independently written).

### The orchestrator-knowledge-gap problem: three options, not one answer

This is the question the literature does **not** resolve, because the two production teams who hit
it (§3) chose opposite defaults:

1. **Shared record (Cognition's direction):** every session writes to the same durable log the
   thread's agent also reads; the thread's agent is "current" by construction because there is no
   private state to be behind on. Cost: more to read/compress as the thread ages; risks the
   context-bloat problem tiered memory exists to avoid; works best if most sessions are short-lived
   on one thread rather than many concurrent long-running ones.
2. **Relay (Anthropic's direction):** sessions report back to the thread's agent in structured,
   bounded updates (akin to subagent reports returning to the lead); the thread's agent's own
   "plan"/state is the durable thing it re-reads. Cost: exactly the duplication/gap failure
   Anthropic hit — the relay's fidelity depends entirely on task/report contracts being specific
   enough, and a gap in the contract silently reproduces the "orchestrator doesn't know" failure
   Tejas is worried about.
3. **Pull on demand (HippoRAG/A-MEM/transactive-memory direction):** the thread's agent doesn't
   hold session content at all; it holds (or can cheaply reconstruct) an *index* of which session
   knows what, and queries that session's log only when a question requires it — closest to
   Wegner's transactive memory ("I don't need to know it, I need to know who/where holds it") and
   to HippoRAG's separation of index from content. Cost: latency/complexity of fan-out queries at
   the moment attention is needed, and the index itself needs to stay current (a smaller version of
   the same problem, one level up).

None of these is "best" in the abstract — the literature doesn't adjudicate it, Anthropic and
Cognition made opposite bets, and the right one plausibly depends on facts of Tejas's system not
covered by this scan: how long do sessions on one thread typically overlap in time, how expensive
is a shared log to keep small, and does the thread's agent need to act autonomously between
Tejas's check-ins (favoring shared/relay) or only answer when asked (favoring pull-on-demand).

### Open questions for Tejas

- Is a "session" on a thread ever running **concurrently** with another session on the same thread
  (parallel, like Anthropic's subagents), or always sequential/handoff (more like activity-based
  computing's resumption model)? This single fact strongly determines whether the Anthropic-style
  relay risk (duplication from simultaneous ignorance) is even reachable, or whether a simpler
  sequential "read the log before you start" rule suffices.
- Does the **attention view** need to be computed from the full memory log in real time, or is a
  periodically-updated projection (materialized view, recomputed on each session close) acceptable?
  This decides between a live query (CQRS read model, HippoRAG-style index) and a cheaper batch
  summary (Generative Agents' periodic "reflection").
- What is the unit that gets a "which session knows this" pointer — every atomic fact (A-MEM's
  atomic notes), or only session-level summaries (coarser, cheaper, less precise)? This is the
  knob between HippoRAG-style fine-grained indexing and a cheaper session-log-of-session-logs.
- Should the thread's agent be allowed to act (not just answer) based on what its sessions knew,
  before Tejas asks? If yes, pull-on-demand is insufficient — it needs a standing awareness
  (shared record or relay) because it has no trigger to go looking. If the thread's agent only ever
  responds to Tejas's questions, pull-on-demand is sufficient and cheapest.

**Confidence overall:** high confidence that memory/attention-as-separable-functions-over-one-store
is the right frame (§1, §2, §4 all converge independently). Medium confidence on which of the three
cross-session-awareness options fits Tejas's actual usage pattern — that is an empirical question
about his system, not something the literature settles, and the two most relevant production
precedents (Anthropic, Cognition) disagree with each other.

---

## Sources

1. Cowan, N. — embedded-processes model: [PMC6105130](https://pmc.ncbi.nlm.nih.gov/articles/PMC6105130/), [Wikipedia](https://en.wikipedia.org/wiki/Nelson_Cowan)
2. Baddeley, A. (2000) — episodic buffer: [Wikipedia](https://en.wikipedia.org/wiki/Baddeley's_model_of_working_memory), [ScienceDirect](https://www.sciencedirect.com/topics/psychology/episodic-buffer)
3. Oberauer, K. (2002) — "Access to information in working memory," *J. Exp. Psychol.: LMC* 28(3):411–421, [doi.org/10.1037//0278-7393.28.3.411](https://doi.org/10.1037//0278-7393.28.3.411); review: [Springer 2016](https://link.springer.com/article/10.3758/s13414-016-1108-5)
4. Wegner, D.M. (1987) — "Transactive Memory," in *Theories of Group Behavior*: [full text PDF](https://dtg.sites.fas.harvard.edu/DANWEGNER/pub/Wegner%20Transactive%20Memory.pdf), [Wikipedia](https://en.wikipedia.org/wiki/Transactive_memory)
5. Prospective memory / RLPFC: [PMC3142765](https://pmc.ncbi.nlm.nih.gov/articles/PMC3142765/), [Oxford Cerebral Cortex 2012](https://academic.oup.com/cercor/article/22/8/1876/320670)
6. Hippocampal pattern completion / PFC gating / nucleus reuniens: [PMC4354269](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4354269/), [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S1074742715002178)
7. Bardram, J. — Activity-Based Computing: [Pers Ubiquit Comput 2005](https://link.springer.com/article/10.1007/s00779-004-0335-2), [AI Magazine 2015](https://onlinelibrary.wiley.com/doi/abs/10.1609/aimag.v36i2.2585)
8. Kaptelinin, V. — UMEA, CHI 2003: [ACM](https://dl.acm.org/doi/10.1145/1054972.1055017)
9. Bellotti, V. et al. — Taskmaster, CHI 2004: [PDF](http://www.chi2004.org/res/Taking%20Email%20to%20Task.pdf)
10. González, V. & Mark, G. — "Working spheres," CHI 2004: [PDF](https://ics.uci.edu/~gmark/CHI2004.pdf)
11. Czerwinski, M. et al. — task-switching diary study, CHI 2004: [PDF](https://www.interruptions.net/literature/Czerwinski-CHI04-p175-czerwinski.pdf); Mark, G. et al. — "Cost of Interrupted Work," CHI 2008: [PDF](https://ics.uci.edu/~gmark/chi08-mark.pdf)
12. Engelbart, D. — NLS view control: [ACM Hypertext retrospective](https://ics.uci.edu/~dfredmil/ics227-SQ04/papers/Hypertext/Secondary/p30-engelbart.pdf)
13. MemGPT: [arXiv:2310.08560](https://arxiv.org/pdf/2310.08560); Letta: [architecture overview](https://medium.com/@piyush.jhamb4u/stateful-ai-agents-a-deep-dive-into-letta-memgpt-memory-models-a2ffc01a7ea1)
14. A-MEM: [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
15. HippoRAG: [NeurIPS 2024 paper](https://proceedings.neurips.cc/paper_files/paper/2024/file/6ddc001d07ca4f319af96a3024f6dbd1-Paper-Conference.pdf)
16. Park, J.S. et al. (2023) — Generative Agents: [arXiv:2304.03442](https://arxiv.org/abs/2304.03442); scoring walkthrough: [AgentPatterns.ai](https://agentpatterns.ai/agent-design/generative-agents-memory-stream/)
17. Anthropic — "How we built our multi-agent research system": [anthropic.com/engineering](https://www.anthropic.com/engineering/multi-agent-research-system)
18. Cognition — "Don't Build Multi-Agents": [cognition.com/blog](https://cognition.com/blog/dont-build-multi-agents)
19. Blackboard architecture for LLM multi-agent systems: [arXiv:2507.01701](https://arxiv.org/pdf/2507.01701)
20. CQRS: [Confluent](https://www.confluent.io/learn/cqrs/), [Microsoft Azure Architecture Center](https://learn.microsoft.com/azure/architecture/patterns/cqrs)
