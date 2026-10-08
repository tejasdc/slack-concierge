# His reading, for the roles/hierarchy/protocols design session

Sourced via `readwise reader-search-documents` (hybrid search) and `readwise readwise-search-highlights`
(vector search over highlights), full protocol (20+ term variations, both commands), then
`reader-get-document-highlights` / `reader-get-document-details` for the strongest hits. Confidence
labels: **Confirmed** = his own highlight/note read directly; **Likely** = strong hybrid-search match,
document saved but not (yet) highlighted; **Possible** = tangential, included for completeness.

---

## 1. Stigmergy — coordination without a controller (Confirmed, highest relevance)

**"Stigmergy: The Most Important Concept You've Never Heard Of"** — francisheylighen.substack.com
(document `01khjwbtne04gv6w2jz250tqqv`, 7 highlights, no notes)

> Stigmergy is coordination of actions through the traces of past activity.

> Stigmergy is a concept with a clumsy name and a modest origin. It was first proposed by the French
> entomologist Grassé to explain how termites build complex nests without blueprints, leaders, or
> explicit communication. Yet beneath that narrow biological context lies one of the most powerful and
> general solutions to a problem that pervades modern life: **How can agents coordinate their actions
> without central control, shared plans, or direct communication?**

> This is the key insight that led to the concept of stigmergy: **coordination does not require
> communication between individuals, only interaction through a shared environment**. The environment
> stores the results of past actions and channels future ones.

> What stigmergy reveals is that coordination does **not** require that agents understand the global
> picture or agree among each other about who would do what. It only requires that they can: 1. Act
> locally 2. Leave visible traces of those actions 3. Respond adequately to traces left by others. The
> intelligence is not in the agent, nor in a controller above them, but in the *interaction between
> agents and a shared environment*.

> The traditional answers invoke **hierarchies**, **planning**, **agreements**, or **communication**.
> But these solutions scale poorly. As the number of participants grows, centralized control becomes
> brittle, and explicit communication becomes overwhelming.

**Bearing on the design:** this is the single most directly on-topic saved piece in the library — it
names the router-vs-swarm tradeoff explicitly ("hierarchies... scale poorly") and gives the alternative
vocabulary (shared environment as memory + signal) that maps directly onto a task ledger / shared
file-state design for worker agents, as opposed to a router that must hold the whole plan in its head.

**"SwarmWorld: Stigmergic technological evolution in societies of language-model agents"** — Subhadeep
Pal, Fiona Y. Wang, Markus J. Buehler (`01m1axv7psn1p7p4p0fbsysqyw`, saved, not yet highlighted —
**Likely**)

> Collective intelligence can emerge when individuals coordinate through a shared environment, allowing
> local actions to accumulate into durable social organization. Language-model agents offer a new
> substrate for this process, yet most multi-agent systems rely on direct conversation, predefined
> roles, or centralized workflows. It remains unclear whether decentralized agents can build functional
> technologies and outperform independent search. Here, initially homogeneous LLM agents in SwarmWorld
> self-organize without assigned roles or recipes...

**Bearing on the design:** the literal LLM-agent test of stigmergy vs. predefined-role/centralized
orchestration — direct academic prior art for a no-hierarchy alternative to the router/worker model, saved
but not yet read closely; worth surfacing to him as unfinished business relevant to this exact session.

---

## 2. Engelbart — augmenting human intellect, H-LAM/T, process/capability hierarchies (Confirmed, very high engagement)

**"Augmenting Human Intellect: A Conceptual Framework" (1962)** — hosted at pierogi.tech
(`01jyf59gp7py609zjvdj0fyqaj`, **75 highlights** — by far the deepest engagement of anything found in
this sweep)

> By "augmenting human intellect" we mean increasing the capability of a man to approach a complex
> problem situation, to gain comprehension to suit his particular needs, and to derive solutions to
> problems.

> What happens, then, is that each individual develops a certain repertoire of process capabilities
> from which he selects and adapts those that will compose the processes that he executes... the entire
> repertoire represents an inter-knit, hierarchical structure (which we often call the repertoire
> hierarchy).

> ...the sub-process capabilities as listed would not be complete without the addition of a seventh
> capability—what we call the **executive capability**. This is the capability stemming from habit,
> strategy, rules of thumb, prejudice, learned method, intuition, unconscious dictates, or combinations
> thereof, to call upon the appropriate sub-process capabilities with a particular sequence and timing.
> An executive process... involves such sub-processes as planning, selecting, and supervising, and it is
> really the executive processes that embody all of the methodology in the H-LAM/T system.

> If we then ask ourselves where that intelligence is embodied, we are forced to concede that it is
> elusively distributed throughout a hierarchy of functional processes... If there is any one thing upon
> which this 'intelligence depends' it would seem to be organization... synergism is our most likely
> candidate for representing the actual source of intelligence.

**Bearing on the design:** Engelbart's own model already contains an internal "router" — the
**executive capability**, a distinct sub-process whose only job is sequencing and supervising the other
capabilities, sitting inside a **repertoire hierarchy** rather than above a flat swarm. This is a direct,
decades-old precedent for "router agent selects/sequences/supervises; worker agents are the
capabilities," and it explicitly locates intelligence in organization/synergism rather than in any one
layer — a caution against over-crediting the router.

**"Bootstrapping Organizations Into the 21st Century: A Strategic Framework"** — Douglas C. Engelbart
and Christina Engelbart (`01kbtz5ax14sqm12w7pxtfdt8d`, 21 highlights)

> Any high-level capability needed by an organization rests atop a broad and deep *capability
> infrastructure*, comprised of many layers of composite capabilities, each depending upon the
> integration of lower-level capabilities.

> Given this model, we can now consider the prospects of improving the organization's improvement
> capability... as *improving the capability of the B Activity*. And for such a critical pursuit to be
> effective requires yet another explicit organizational activity... the organization's **C Activity**.
> ...An investment that boosts the A Capability provides a one-shot boost. An investment that boosts the
> B Capability boosts the subsequent rate by which the A Capability increases. And an investment that
> boosts the C Capability boosts the rate at which the rate of improvement can increase.

> The **CODIAK** capability is not only the basic machinery that propels our organizations, it also
> provides the key capabilities for their steering, navigating and self repair.

**Bearing on the design:** Engelbart's A/B/C activity model (A = doing the work, B = improving how A is
done, C = improving how B is improved) is a ready-made framework for separating "worker does the task"
from "router improves how workers are dispatched" from "a meta-layer that improves the router" — i.e. a
principled argument for more than two tiers when the system is meant to bootstrap itself, not just
execute. CODIAK (Concurrent Development, Integration, and Application of Knowledge) is close kin to the
stigmergic shared-environment idea, but framed as organizational infrastructure rather than insect
behavior.

**"A Few Words on Doug Engelbart"** — worrydream.com / Bret Victor (`01k7br0hcqayq93wy55a89ptvg`, 5 highlights)

> Engelbart's vision, from the beginning, was collaborative. His vision was people working together in
> a *shared intellectual space*. His entire system was designed around that intent.

> The most important question you can ask about Engelbart is, "What world was he trying to create?" By
> asking that question, you put yourself in a position to create that world yourself.

**Bearing on the design:** reframes "augmentation" as intent, not feature-list — a useful check against
designing router/worker protocols that optimize dispatch efficiency while losing sight of what
collective capability the whole system is meant to create for him specifically.

**"Bootstrapping Research & Dynamicland"** — dynamicland.org (`01jw5dr35cn6ppp5zh0y1jt94y`, **35
highlights**, second-deepest engagement in the sweep)

> And the right kind of research environment that has cultivated an enormous amount of fruit is what
> Engelbart called a **bootstrapping research environment**... Bootstrapping is a process where you're
> not trying to make any particular product or technology to put into the world. You're actually trying
> to create your own little world.

> Alan Kay... wanted to create a new form of literacy in which all people could model and simulate the
> complex systems of the world... he thought a good way of organizing those models might be as these
> computational objects that are sending messages to each other. So that's where "object-oriented" came
> from.

> The thing on the left is designed to teach you to become self-sufficient, to go beyond the menu. The
> thing on the right teaches you to be dependent on a corporation for all your needs.

**Bearing on the design:** ties Engelbart and Kay together explicitly (message-passing objects as an
early "multi-agent" metaphor), and raises a design question this session should probably surface: should
the agent system teach Tejas to go "beyond the menu" (extensible, legible, a medium) or keep him dependent
on whatever fixed roles/protocols get designed for him — directly resonant with the global instructions'
Engelbart/Kay-sourced "augmentation" philosophy already in his CLAUDE.md.

---

## 3. Ants / division of labor without central control (Confirmed)

**"The Collective Wisdom of Ants"** — Deborah M. Gordon (`01gt18aa1ny99zs752bwdmcsee`, saved, not
highlighted — **Likely**, but her name/work is the direct hit the design brief asked about)

**"Mastering Bitcoin"** — Andreas M. Antonopoulos:

> Although ants form a caste-based society and have a queen for producing offspring, there is no central
> authority or leader in an ant colony. The highly intelligent and sophisticated behavior exhibited by a
> multimillion-member colony is not the product of a leader or a central intelligence, but the emergent
> property of the system as a whole...

**"Scale"** — Geoffrey West:

> Ant colonies are built without forethought and without the aid of any single mind or any group
> discussion or consultation. There is no blueprint or master plan. Just thousands of ants...

**"The Selfish Gene"** — Richard Dawkins:

> An animal moves as a coordinated whole, as a unit. Subjectively I feel like a unit, not a colony. This
> is to be expected. Selection has favoured genes that cooperate with others.

**Bearing on the design:** this is the "no router at all" pole of the design space — emergent
coordination purely from local rules and a shared environment, no member with a global view. Useful as
the extreme case to place against a router/worker hierarchy on a spectrum, and a natural pairing with the
stigmergy article above (same underlying mechanism, described at colony scale rather than named
abstractly).

---

## 4. Hierarchy, span of control, and a reconsidered view of bureaucracy (Confirmed)

**"From Hierarchy to Intelligence"** — jack [Dorsey], via Sequoia (`01kn5z3hx2wp05q2pk2pdhk2rm`, tweet,
saved — content read via document details, **Likely**)

> Two thousand years before the first corporate org chart, the Roman Army solved a problem that every
> large organization still faces: how do you coordinate thousands of people across vast distances with
> limited communication? Their answer was a nested hierarchy with a consistent span of control at every
> level. The smallest unit was the *contubernium*, eight soldiers... led by a *decanus*. Ten
> *contubernia* formed a century of eighty men under a centurion. Six centuries made a cohort. Ten
> cohorts made a legion of roughly 5,000. At each layer, a named commander held defined authority,
> aggregated information from below, and relayed decisions from above. The structure (8 → 80 → 480 →
> 5,000) was an information routing protocol built around a simple human limitation: a leader can
> effectively manage somewhere between three and eight people...

**Bearing on the design:** frames hierarchy itself as "an information routing protocol" sized to a
cognitive limit (span of control), not an org-chart artifact — directly on-topic for deciding how many
worker agents one router should hold live at once, and whether a second router tier is warranted before
that limit is hit.

**"Sapiens"** — Yuval Noah Harari, highlighted section **"The Wonders of Bureaucracy,"** his own note:
*"First time hearing a positive connotation to bureaucracy."*

**Bearing on the design:** a rare moment of him explicitly updating toward hierarchy/bureaucracy as
something that can be good, not just a scaling cost — worth naming directly in the session since it
pre-dates and may inform how much process/rule structure he's willing to accept between router and
workers.

**"Why Information Grows"** — César Hidalgo:

> The personbyte theory can also help us explain why large chunks of knowledge and knowhow are hard to
> accumulate and transfer, and why knowledge and knowhow are organized in the hierarchical pattern that
> is expressed in the nestedness of the industry-location data. This is because large chunks of
> knowledge and knowhow need large networks of people to be embodied in, and transferring or duplicating
> large networks is not as easy as transferring a small group of people.

**Bearing on the design:** an argument for hierarchy as a consequence of *what a single mind (or agent)
can embody*, not a control preference — knowledge too large for one "personbyte" forces nesting. Maps
onto why a single router context window can't hold everything and must delegate.

**"What Does It Mean to Be Strategic?"**, his own note: *"Strategy work is a Socratic process."*

> The mission of a strategist is not to set or devise strategy. It is to understand how an
> organization's strategy emerges and why, then constantly scrutinize and interrogate the process,
> identifying inconsistencies and nudging the organization to address them.

**Bearing on the design:** a candidate job description for a router/chief-of-staff role that is not
"decide and dictate" but "observe, interrogate, nudge" — closer to a coordinator than a commander.

**"The Systems View of Life"** — Fritjof Capra, Pier Luigi Luisi:

> Power, in the sense of domination over others, is excessive self-assertion. The social structure in
> which it is exerted most effectively is the hierarchy... However, there is another kind of power, one
> that is more appropriate for the new paradigm – power as empowerment of others. The ideal structure
> for exerting this kind of power is [not the hierarchy].

**Bearing on the design:** names the two readings of "hierarchy" the session will likely need to
disambiguate — control/domination vs. empowerment/support structure.

---

## 5. Alan Kay (Confirmed via secondary sources; his own essays saved, not yet highlighted)

Kay's own primary texts — *"The Real Computer Revolution Hasn't Happened Yet,"* *"Afterword: What Is a
Dynabook?,"* *"Personal Dynamic Media"* — are all **saved** in Reader but currently carry **no
highlights**, i.e. read-later material rather than deeply annotated yet (**Likely**, worth flagging to
him as unfinished reading directly relevant to this session). His engagement with Kay so far comes
through others quoting him:

> Alan Kay, who had two great maxims that Jobs embraced: "The best way to predict the future is to
> invent it" and "People who are serious about software should make their own hardware." — *Steve Jobs*,
> Walter Isaacson

> We are embedded in four large "systems of systems": the natural universe, our social systems, our
> technological systems, and the "systems that are us" (biological, psychological, etc.) — *Enlightened
> Imagination for Citizens*, Alan Kay (his own essay, hit under "systems not goals" search)

**Bearing on the design:** the "systems of systems" framing is a useful nesting model (a multi-agent
system is itself embedded in social + technological systems it must interoperate with — Slack, Thinkering,
his calendar), and worth reading Kay's own Dynabook/Smalltalk essays before the session for the
message-passing-object idea of agents as small, encapsulated, communicating wholes rather than a
monolith with subroutines.

---

## 6. Protocols vs. rules, and "systems not goals" (Confirmed)

**Atomic Habits** — James Clear (this is the literal source of the "golden rule" already quoted in his
own CLAUDE.md):

> You do not rise to the level of your goals. You fall to the level of your systems.
> Goals are about the results you want to achieve. Systems are about the processes that lead to those
> results.

**Getting Things Done** — David Allen, quoting Dee Hock:

> Simple, clear purpose and principles give rise to complex and intelligent behavior. Complex rules and
> regulations give rise to simple and stupid behavior.

**"Money, Blockchains, and Social Scalability"** — Nick Szabo:

> Information flows between minds – what I have called intersubjective protocols – include spoken and
> written words, custom (tradition), the contents of law (its rules, customs, and...)

**"One Tension to Rule Them All"** — Protocolized:

> The best way to understand the relationship between efficiency and thoroughness is *not* as a
> trade-off, but as a *tension*... In infinite games, there are no trade-offs – only *tensions*.

**Bearing on the design:** confirms "systems not goals" and "protocols over rigid rules" are load-bearing,
pre-existing convictions of his (already codified in his global instructions), not something to be argued
from scratch in the session — the design should be pitched as principles/protocols generating router and
worker behavior, not an enumerated rulebook, and framed as an ongoing tension (efficiency vs. thoroughness,
autonomy vs. oversight) rather than a one-time tradeoff to be solved and closed.

---

## 7. Multi-agent orchestration, context engineering, harness design (Confirmed + Likely — his current AI reading)

**"How We Build Effective Agents"** — Anthropic (`01jj6a56c155ffn93ncrr6n1jr`, 6 highlights):

> We draw an important architectural distinction between **workflows** and **agents**: Workflows are
> systems where LLMs and tools are orchestrated through predefined code paths. Agents... dynamically
> direct their own processes and tool usage, maintaining control over how they accomplish tasks.

> Success in the LLM space isn't about building the most sophisticated system. It's about building the
> *right* system for your needs. Start with simple prompts, optimize them with comprehensive evaluation,
> and add multi-step agentic systems only when simpler solutions fall short.

> When implementing agents, we try to follow three core principles: 1. Maintain **simplicity**... 2.
> Prioritize **transparency**... 3. Carefully craft your agent-computer interface (ACI)...

**Bearing on the design:** direct architectural vocabulary (workflow vs. agent) for classifying whether a
given router→worker handoff should be a fixed pipeline or genuine delegation, plus an explicit
anti-over-engineering principle that should gate how many roles/tiers get proposed.

A cluster of **saved-but-not-yet-highlighted** documents shows active, current interest in exactly this
design question, without deep annotation yet (**Likely** — worth surfacing as reading he may want to
finish before or during the session): *"How we built our multi-agent research system"* (anthropic.com),
*"Effective context engineering for AI agents"* (anthropic.com), *"Context Engineering"* (LangChain Blog),
*"First-class Agents"* (Ben Follington/Nichecraft — "Agents as a programming primitive"), *"Field Report:
The Harness Is the Product"* and *"AI Field Report 2: The Orchestrator's Dilemma"* (Cornelius), *"The
harness as the context manager"* (Tony Gentilcore), *"The emerging agent architecture"* (Arvind Jain),
*"Background agents are here. Your orchestration isn't ready."* (Dan Farrelly/Inngest), *"OpenClaw +
Codex/ClaudeCode Agent Swarm: The One-Person Dev Team"* (Elvis).

**"Staff archetypes"** — Will Larson (`01kvdytxpz2wpfvkwb0jsc2bqh`, saved, **Likely**):

> The four common archetypes of Staff-plus roles I encountered are: the **Tech Lead**... the
> **Architect**... the **Solver**, who digs deep into arbitrarily complex problems... [and] the **Right
> Hand**, [who] extends an executive's attention, borrowing their scope and authority to operate
> particularly complex organizations. They provide additional leadership bandwidth to leaders of
> large-scale organizations.

**Bearing on the design:** "Right Hand" is close to a "chief of staff" agent archetype already named in
the brief — borrowed scope/authority rather than an independent mandate — and the other three archetypes
(Tech Lead, Architect, Solver) could map onto distinct worker-agent job descriptions rather than one
undifferentiated "worker."

---

## 8. Cognitive control, System 1/System 2 (Possible/Confirmed — thin coverage)

No direct hit on Kahneman's System 1/System 2 itself, Baars' Global Workspace Theory, Stafford Beer's
Viable System Model, Ashby's requisite variety, or Conway's Law by name — these searches returned mostly
noise (unrelated books/tweets that happened to score above the vector-search floor). Treat their absence
as **Unknown**, not "he rejects them" — they may simply not be in his library under those names.

Adjacent material that did surface:

**"Cognitive load is what matters"** — minds.md / GitHub:

> A well-crafted monolith with truly isolated modules is often much more flexible than a bunch of
> microservices. It also requires far less cognitive effort to maintain. It's only when...

**"A Philosophy of Software Design"** — John Ousterhout:

> There are two general approaches to fighting complexity, both of which will be discussed in this book.
> The first approach is to eliminate complexity by making code simpler and more obvious...

**Bearing on the design:** a caution against over-modularizing into many small worker agents when a
"well-crafted monolith" (fewer, more capable agents) might carry less coordination overhead — directly
relevant to deciding agent granularity.

---

## Recurring themes across the sweep

1. **Coordination without a controller is a recurring fascination** — stigmergy, ant colonies, and their
   direct 2026 LLM-agent analogue (SwarmWorld) all surface together, and the stigmergy article explicitly
   frames hierarchy as the thing that "scales poorly." Any router/worker design in the session should
   expect this to be raised as the alternative pole.
2. **Engelbart is not background reading — he is the deepest single engagement in the entire library**
   (75 highlights on the 1962 report, 35 on the Dynamicland/bootstrapping piece, 21 on the Engelbart
   "capability infrastructure" paper). The A/B/C activity model, the "executive capability," and
   "repertoire hierarchy" are pre-existing, heavily annotated frameworks he can be expected to reach for
   even if not named explicitly.
3. **"Systems not goals" and protocols-over-rules are settled convictions**, already load-bearing in his
   own instruction file, not positions to re-litigate.
4. **Hierarchy is being actively re-evaluated, not rejected** — the Sapiens "bureaucracy" note, the Roman
   Army span-of-control piece, and the Capra "power as empowerment" quote together suggest he is looking
   for a *legitimate* form of hierarchy (bounded span of control, empowerment rather than domination)
   rather than a flat swarm or a command structure.
5. **His current-events AI reading (multi-agent orchestration, context engineering, harness design) is
   heavily saved but under-highlighted** — this is live, unfinished research he was in the middle of when
   this design session was requested, not settled opinion. Worth naming directly rather than treating his
   library as if it already contains a verdict.
6. **Alan Kay is present by reputation and via secondary sources (Bret Victor, Dynamicland) more than by
   his own primary texts**, which are saved but unread/unhighlighted — an actual gap worth closing before
   leaning on Kay's ideas as settled.
