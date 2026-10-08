# How hierarchy and separation of concerns evolve — research brief for agent-roles design

Scope: recurring failures in Tejas's router/worker agent system (router does the work
itself; router's context fills with relay chatter and it "forgets" its role after
compaction; written instructions don't hold; agents change foundations without
approval; he isn't notified when something needs him) — grounded against how nature
and human organizations actually solved (or evolved toward) hierarchy and division of
labor. Each item: citation, key finding, and the implication for a router/worker agent
system. Confidence markers used throughout: Confirmed (directly read from source
material or search results), Likely (strong secondary-source consensus), Possible
(partial evidence). Everything below is Confirmed-from-secondary-source unless noted;
I did not read full original papers/books cover to cover, only abstracts, reviews and
excerpts surfaced by search — see "Where the evidence is weak" at the end.

---

## 1. Major evolutionary transitions

### Maynard Smith & Szathmáry, *The Major Transitions in Evolution* (1995)

**Key finding.** They catalogue ~8 transitions (replicating molecules → molecules in
compartments; unlinked replicators → chromosomes; RNA gene+enzyme → DNA+protein;
prokaryotes → eukaryotes; asexual clones → sexual populations; solitary cells →
multicellular organisms; solitary individuals → colonies with reproductive division of
labor; primate societies → human societies with language). The unifying pattern,
stated as the book's own thesis: **entities that were capable of independent
replication before the transition can replicate afterward only as part of a larger
whole.** Fitness and reproductive potential migrate from the lower unit to the new,
higher-level unit. [The Major Transitions in Evolution — Wikipedia](https://en.wikipedia.org/wiki/The_Major_Transitions_in_Evolution); [The Major Evolutionary Transitions (ResearchGate PDF)](https://www.researchgate.net/publication/15314671_The_Major_Evolutionary_Transitions); [Toward major evolutionary transitions theory 2.0 — PNAS](https://www.pnas.org/doi/10.1073/pnas.1421398112)

**Implication for an agent system.** A "transition" only counts as real integration
when the lower unit gives up independent reproduction/initiative in favor of the
higher unit's success. Translated: a worker agent that can still unilaterally decide
to "just do the work itself" at the router level, or a router that can silently expand
its own scope, hasn't actually transitioned into a hierarchy — it's still a population
of independent replicators that happens to be co-located. The router doing the work
itself is a **reversion to the pre-transition state**: the higher-level unit (the
system-as-a-whole with router+workers as differentiated organs) collapses back into
one undifferentiated actor. This reframes "the router keeps doing the work itself"
not as a discipline failure but as evidence the transition to a genuine two-level
system was never structurally locked in — only asked for.

### Michod — evolution of individuality, conflict mediators, fitness reorganization

**Key finding.** Michod (*Darwinian Dynamics*, and multiple review papers) treats
evolutionary transitions in individuality as a multi-level-selection process:
cooperation among lower units creates group-level benefit, but cooperation always
creates an incentive for defection (a cell that replicates faster than its
neighbors, at the group's expense). Stable transitions require explicit **conflict
mediators** — germ-line sequestration, policing, apoptosis, mutation-rate reduction,
determinate growth/size control — that **suppress within-group (lower-level)
selection** so it can no longer undermine the whole. Only after suppression does
fitness "transfer" durably to the higher level. [On the Reorganization of Fitness During Evolutionary Transitions in Individuality — Oxford Academic](https://academic.oup.com/icb/article/43/1/64/604458); [Darwinian Dynamics — Princeton University Press](https://press.princeton.edu/books/paperback/9780691050119/darwinian-dynamics); [Cooperation and Conflict in the Evolution of Individuality I — American Naturalist](https://www.journals.uchicago.edu/doi/abs/10.1086/286012)

**Implication.** "Written instructions don't hold, only structural enforcement does"
is exactly Michod's finding restated for software: cooperation (the router agreeing
to route, not work) is evolutionarily/behaviorally **unstable** unless something
actively suppresses the lower-level "defection" (the router quietly executing the
task because it's faster/easier in the moment, exactly like a free-riding cell
replicating for itself). The fix pattern from biology is not exhortation — cells
don't get told to behave — it's **mechanism**: germline sequestration is a hard
structural partition (only germ cells get to reproduce the organism; soma cells
*cannot*, full stop, no matter what signal they receive). The agent-system analogue:
the router process should be structurally incapable of doing work — no execution
tools, no filesystem write access, no code-execution — the way soma cells are
biochemically incapable of contributing to the next generation. A permission a role
"shouldn't" use is a rule; a permission a role *doesn't have* is a mediator.

---

## 2. Evolution of modularity

### Clune, Mouret & Lipson, "The evolutionary origins of modularity," *Proc. R. Soc. B* 2013

**Key finding.** In evolving neural-network/circuit simulations, modularity does
**not** emerge from selection for performance alone — networks optimized purely for
performance stay densely, non-modularly connected. Modularity emerges reliably and
only once you add an explicit **cost for connections** (wiring cost) alongside the
performance objective. Quote surfaced directly: "Once you add a cost for wiring,
modules immediately appear. Without a cost, modules never form." Modular networks
that resulted were also **more evolvable** — able to adapt to new goals faster.
[The evolutionary origins of modularity — PubMed](https://pubmed.ncbi.nlm.nih.gov/23363632/); [arXiv preprint](https://arxiv.org/abs/1207.2743); [Cornell Chronicle summary](https://news.cornell.edu/stories/2013/01/scientists-find-holy-grail-evolving-modular-networks)

**Implication.** This is the single most direct evolutionary result for the specific
failure mode described: **a system that is only rewarded for getting the task done
(performance) will not spontaneously separate "routing" from "doing," no matter how
much you ask it to** — because in an unconstrained system, the cheapest path to
"performance" is the router just doing the work itself (zero communication/handoff
cost). Modularity (router vs. workers as separate specialized units) only becomes
the fitness-maximizing strategy once there is an explicit, structural cost attached
to "connections" — in software terms, a cost/friction attached to the router
holding context, executing tools, or doing multi-step reasoning itself. If the
router's context window, tool access, or "turn budget" is cheap and unlimited, the
system's incentive gradient runs *against* modularity, matching what's being
observed. The fix: make it structurally, not just normatively, expensive/impossible
for the router to hold long task context or invoke work-tools — a connection cost,
not a rule.

### Kashtan & Alon, "Spontaneous evolution of modularity and network motifs," *PNAS* 2005

**Key finding.** Modularity and recurring motifs evolve spontaneously under
**"modularly varying goals"** — an environment that repeatedly switches between
several goals, each built from a different combination of the same sub-goals.
Networks evolved under one single fixed goal stayed non-modular even after long
evolutionary time; switching goals (that share reusable sub-problems) is what
selects for modules that can be recombined. [Spontaneous evolution of modularity and network motifs — PNAS](https://www.pnas.org/doi/10.1073/pnas.0503610102)

**Implication.** This is a *second*, independent route to modularity (distinct from
connection-cost): if the router/worker system faces a genuinely varying stream of
task types built from recurring sub-tasks (research, code edit, deploy, notify), the
router and workers should be built as recomposable modules matched to those
recurring sub-goals — not a single monolithic "do whatever comes in" agent. This
argues for a **library of named worker roles** (each a stable module for a recurring
sub-goal) that the router recombines, rather than one generic worker reconfigured ad
hoc per task — mirroring how modularly-varying-goals selects for reusable,
recombinable parts rather than one flexible whole.

### Simon, "The Architecture of Complexity" (1962) — near-decomposability, Hora & Tempus

**Key finding.** Simon's watchmaker parable: Tempus builds each watch as one
inseparable assembly — any interruption means the whole thing falls apart and he
restarts from zero. Hora builds stable ten-part subassemblies that combine into
larger subassemblies, then into the whole watch — an interruption only loses the
one subassembly in progress. Hora's approach is enormously more likely to survive in
a world with interruptions, and Simon generalizes: complex systems that persist and
evolve are almost always **nearly decomposable** — hierarchies of subsystems where
interactions *within* a subsystem are much stronger/more frequent than interactions
*between* subsystems. [Text notes: Architecture of Complexity](https://www.infraculture.org/2020-09-10-text-notes-architecture-of-complexity/); [Parable of Two Watchmakers](https://www.noahbrier.com/archives/2018/09/framework-of-the-day-parable-of-two-watchmakers)

**Implication.** This maps almost literally onto "the router's context fills with
relaying workers' back-and-forth and it forgets its role after compaction."
Compaction is an interruption. A router that holds the *entire* task's live
context (like Tempus's undivided watch) loses everything meaningful when
interrupted/compacted — there's no stable subassembly to fall back to, just
compressed mush. A near-decomposable design (like Hora's) means the router's own
persistent state is a **small, stable, independently-meaningful subassembly** — e.g.
"which worker owns which open task, and what's the one-line status of each" — while
the *large*, frequently-changing content (workers' internal reasoning, back-and-forth
detail) lives inside worker subassemblies the router never has to hold. Compaction
of the router's context should only ever cost you the equivalent of "the
subassembly in progress," never the whole watch. This is an architecture argument
for keeping the router's held state minimal and structurally separate from workers'
verbose internal state, not just an instruction to "summarize before compacting."

---

## 3. Division of labor in social insects

### Response-threshold models (Bonabeau, Theraulaz, Deneubourg, multiple papers 1996–1998)

**Key finding.** Individual insects have (genetically or developmentally) different,
fixed **response thresholds** to task-associated stimuli (e.g., brood-care pheromone
concentration). Low-threshold individuals engage a task at low stimulus levels;
high-threshold individuals only engage when stimulus is high (task badly needs
doing). No central assignment exists — division of labor **emerges from the
distribution of thresholds across the population** reacting independently to shared
signals. The model reproduces observed colony-level task allocation and temporal
polyethism. [Fixed Response Thresholds and the Regulation of Division of Labor in Insect Societies (ResearchGate)](https://www.researchgate.net/publication/23740482_Fixed_Response_Thresholds_and_the_Regulation_of_Division_of_Labor_in_Insect_Societies); [Quantitative Study of the Fixed Threshold Model](https://www.researchgate.net/publication/230683291_Quantitative_Study_of_the_Fixed_Response_Threshold_Model_for_the_Regulation_of_Division_of_Labour_in_Insect_Societies)

**Implication.** Role assignment doesn't need a dispatcher deciding case-by-case; it
can be an emergent property of differently-configured units reacting to the same
signal at different thresholds. For a router system, this argues for encoding
**stable, differentiated response thresholds into worker types** (e.g., a
"specialist" worker session pre-loaded to only activate/accept a narrow class of
request) rather than routing every request through one generalist decision-maker
that must correctly classify and dispatch every single time. It reduces the router's
job from "correctly decide everything" to "broadcast the signal accurately," with
much of the actual allocation happening structurally.

### Deborah Gordon — harvester ant task allocation via interaction networks (no central control)

**Key finding.** Task allocation in harvester ant colonies happens with **no
central control and no hierarchy** — "no ant directs another." Individual ants
decide their task based on the *rate and pattern of brief antennal encounters* with
other ants, not on any message content or command. The queen "is not an authority
figure... does not decide what worker does what" — she only lays eggs. Colony-level
adaptive behavior (e.g., shifting foraging effort) emerges purely from statistics of
local, contentless interactions. [Deborah M. Gordon — Wikipedia](https://en.wikipedia.org/wiki/Deborah_M._Gordon); [Encounter rate and task allocation in harvester ants — Springer](https://link.springer.com/article/10.1007/s002650050573); [Decoding the Remarkable Algorithms of Ants — Quanta](https://www.quantamagazine.org/decoding-the-remarkable-algorithms-of-ants-20150625/); [Interaction rate informs harvester ant task decisions — Behavioral Ecology](https://academic.oup.com/beheco/article/18/2/451/204082)

**Implication — an important counterpoint to worry about, not just an analogy to
copy.** This is real evidence that **decentralized, non-hierarchical coordination
works extremely well in nature** for a colony that (a) has enormous numbers of
cheap, expendable, genetically-identical units, and (b) needs robustness to any
single unit's failure far more than it needs any one unit's outcome to be legible or
accountable to an outside observer. That's *not* Tejas's situation: he is one human
who needs (i) a single addressable point of contact, (ii) to be notified when his
input specifically is needed, and (iii) legible attribution of who did what. Pure
stigmergic/interaction-network allocation optimizes for colony robustness at the
cost of exactly the properties Tejas needs (a "front door," and legible individual
accountability). **The queen-is-not-a-manager finding argues against
over-centralizing internal work allocation between workers**, but it does *not*
argue against having a router as *external interface* — Gordon's ants have no
external stakeholder demanding status updates. The lesson is scoped: distribute
*internal* coordination between workers where possible (they can hand off to each
other via shared state/tags without going back through the router), but keep the
router as the *sole addressed interface to Tejas*, because that requirement doesn't
exist in the ant colony and isn't answered by the ant colony's design.

### Age polyethism (temporal division of labor)

**Key finding.** Worker honeybees change task with age, not by assignment: young
bees nurse brood in the (safer) hive center; middle-aged bees do nest maintenance
and food processing; oldest bees forage outside (most hazardous). This ordering
maximizes colony-level value: risky work is deferred to individuals with the least
remaining reproductive value to the colony. [Polyethism — ScienceDirect Topics](https://www.sciencedirect.com/topics/agricultural-and-biological-sciences/polyethism); [Within-nest temporal polyethism in the honey bee — Springer](https://link.springer.com/10.1007/s00265-007-0503-2)

**Implication.** Roles aren't just about current skill/context, they can be
profitably tied to a unit's "age" (how much has this session/worker already
accumulated context, trust, or track record) — a long-lived, well-tested worker
session might be trusted with more sensitive/foundational work, while
fresh/short-lived sessions handle low-stakes, disposable tasks. It's a weaker
analogy than the others (mapping "age" onto agent sessions is a stretch) but it
supports the general design instinct of matching task risk to a unit's track record
rather than treating every session as interchangeable.

### Seeley — honeybee nest-site selection, quorum sensing

**Key finding.** A swarm choosing a new nest site does *not* rely on a leader
deciding, or even total consensus. Scout bees independently evaluate candidate sites
and "vote" by spending time there and dancing for it; the deciding mechanism is a
**quorum threshold** (~15–20 scouts simultaneously present at one site) — once
reached at any one site, those scouts return and trigger a "piping" signal that
mobilizes the whole swarm to commit, without ever polling or aggregating every
scout's opinion centrally. [Group Decision Making in Honey Bee Swarms — American Scientist](https://www.americanscientist.org/article/group-decision-making-in-honey-bee-swarms); [Stop Signals Provide Cross Inhibition — Science](https://www.science.org/doi/10.1126/science.1210361)

**Implication.** This is a clean model for **decisions that require Tejas's input**
without requiring the router to synchronously supervise every worker: workers can
independently signal "this needs a decision" into a shared space (a quorum
mechanism — e.g., an inbox/attention queue), and only when a real threshold is
crossed (a genuine decision point, not routine chatter) does escalation to the human
fire. This maps directly onto the existing product concept of "needs_you" outcomes:
the underlying biological principle is that **committing to escalate should require
crossing an explicit, quantifiable threshold** (quorum), not a router's
in-the-moment subjective judgment call made once per event. It also explains *why*
"agents change foundations without approval" is dangerous by contrast: bees never
let a single scout unilaterally commit the swarm — commitment requires the quorum.
A single agent unilaterally deciding to change a foundation is the equivalent of one
scout dragging the whole swarm to her preferred site without quorum.

### Stigmergy (Grassé 1959; Theraulaz & Bonabeau 1999; Heylighen 2016)

**Key finding.** Grassé (1959) coined stigmergy to explain how termites build
complex, coordinated structures with no direct communication or planning between
individuals: **work done by one individual leaves a trace in the shared environment
(e.g., a pheromone-marked mud pellet) that stimulates the next appropriate action —
by the same or a different individual.** This resolves the paradox that individuals
"work as if they were alone" while the colony's output is highly coordinated.
Theraulaz & Bonabeau (1999, *Artificial Life* 5(2):97-116) formalize two varieties
(quantitative and qualitative stigmergy). Heylighen (2016, *Cognitive Systems
Research* 38:4-13) generalizes stigmergy far beyond insects: "virtually all evolved
processes that require coordination between actions seem to rely at some level on
stigmergy" — citing Wikipedia (every edit leaves a trace that stimulates the next
edit) as a paradigm human-scale example. [A Brief History of Stigmergy — MIT Press](https://direct.mit.edu/artl/article-abstract/5/2/97/2318/A-Brief-History-of-Stigmergy); [Stigmergy as a Universal Coordination Mechanism I — ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1389041715000327); [full text PDF](https://pespmc1.vub.ac.be/Papers/Stigmergy-varieties.pdf)

**Implication.** This is the strongest available model for **avoiding the router
having to relay worker back-and-forth through its own context at all.** Instead of
workers reporting *to* the router and the router holding/relaying that
conversation (which is exactly the described failure — context fills with
relaying), workers should leave traces in a **shared external medium** (a task
ledger, a status file, a ticket state) that the *next* relevant actor (another
worker, or the router only when a real decision/notification is due) reads
directly. The router's job shrinks to watching the medium for events that cross a
threshold worth surfacing to Tejas — it never has to be the pipe every message
flows through. This is a direct, evidence-backed architectural alternative to
"router relays everything."

---

## 4. Why specialization pays (and when it doesn't)

### Adam Smith, pin factory (background — not deeply re-verified here, standard reference)

**Key finding (well-established, not re-searched in depth).** Division of labor
into narrow specialized steps massively increases output per worker versus each
worker making a whole pin, through (a) increased dexterity from repetition, (b)
saved time from not switching tasks, (c) enabling task-specific tool/method
invention.

**Implication.** Two of Smith's three mechanisms are about **switching cost**, not
raw skill — which is echoed and formalized below.

### Rueffler, Hermisson & Wagner, "Evolution of functional specialization and division of labor," *PNAS* 2012

**Key finding.** Using a general mathematical model where modules (cells, organs,
colony members) trade off contribution to two different tasks, they derive the
**conditions under which specialization (division of labor) is favored over
generalism**: division of labor evolves when the trade-off between the two tasks is
sufficiently strong (concave/costly trade-off) and there's a fitness benefit to
performing each task at a high level, i.e. specialization pays specifically when
"jack of all trades" really would be "master of none" at the underlying performance
function. [Evolution of functional specialization and division of labor — PNAS](https://www.pnas.org/doi/10.1073/pnas.1110521109)

**Implication.** Specialization (dedicated worker roles vs. one generalist agent)
is only mathematically favored when the trade-off between "being good at routing"
and "being good at doing deep work" is real and steep — i.e. when a single agent
genuinely cannot be excellent at both holding minimal state / making dispatch
decisions *and* doing deep, tool-heavy, long-context work simultaneously. This is
falsifiable and worth stating explicitly as the design's justification: the claim
that a router and a worker must be separate roles is an empirical claim about a
real trade-off (context-holding vs. task-execution), not an aesthetic preference —
and the theory says specialization is favored exactly when that trade-off is steep,
which matches the observed failure (holding both roles in one context causes
collapse).

### Task-switching costs (Goldsby, Dornhaus, Kerr & Ofria, *PNAS* 2012, "Task-switching costs promote the evolution of division of labor and shifts in individuality"; and Duarte, Pen, Keller & Weissing, *Behav. Ecol. Sociobiol.* 2012, "Evolution of self-organized division of labor in a response threshold model")

**Key finding.** Goldsby et al. (digital-organism simulation) show that division of
labor evolves specifically **as a response to task-switching costs** — when
switching between tasks is costly, selection favors individuals (or, at the next
level, groups that behave as a single individual) that specialize rather than
multitask, and this can itself drive a shift in what counts as "the individual"
(a colony starts behaving as one fitness-relevant unit). Duarte et al. show
(response-threshold model, made evolvable) that division of labor emerges via
evolutionary branching of thresholds, but **only when there are clear fitness
benefits to individual specialization** — division of labor is not automatic or
free; note also (from Ant Encounters-adjacent literature) that field data on ants
found individual task efficiency was **not** strongly predicted by how specialized
a worker was — the "jack of all trades is master of none" assumption doesn't always
hold empirically for ants specifically. [Task-switching costs promote the evolution of division of labor — PNAS](https://www.pnas.org/doi/10.1073/pnas.1202233109); [Evolution of self-organized division of labor in a response threshold model — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC3353103/)

**Implication.** This directly targets "the router starts doing the work itself."
In an LLM agent, switching from "routing mode" (terse, dispatch-oriented,
low-context) to "doing mode" (deep tool use, long reasoning chains, large working
context) inside **one continuous context** is exactly a costly task-switch — every
switch degrades the router's own state (the context bloat described in the brief).
The evolutionary prediction is that **when task-switching is costly, division of
labor is favored precisely to eliminate the switching cost**, not merely to
parallelize. This means the fix isn't just "tell the router not to do work" —
it's "make switching structurally impossible/expensive," e.g. router and worker as
genuinely separate processes/sessions with no shared context to switch within,
so there is no "mode" to slip into. The caveat from ant field data is worth
carrying into the synthesis: don't assume specialization automatically improves
per-unit quality — the *evolutionary force* here is switching-cost elimination and
coordination legibility, not necessarily individual skill.

---

## 5. Organizations

### Stafford Beer, Viable System Model (VSM)

**Key finding.** Beer models any viable organization as five recursive
subsystems: **S1** (autonomous operational units doing the actual work), **S2**
(coordination/damping between S1 units, preventing oscillation/conflict), **S3**
(management of the "here and now" — resource bargaining and audit of S1), **S4**
(the "outside and future" — environment scanning, adaptation, strategy), **S5**
(identity/policy — ultimate closure, balancing S3's "run" pressure against S4's
"change" pressure, defining what the organization will/won't do). Requisite variety
is handled through each level being able to both **attenuate** variety flowing
inward (filter/compress/standardize before it reaches the next level up) and
**amplify** variety flowing outward (empower local autonomy so a small signal from
above produces rich, locally-adapted responses below). [Viable System Model — Umbrex](https://umbrex.com/resources/frameworks/organization-frameworks/viable-system-model-stafford-beer/)

**Implication.** This maps almost one-to-one onto the desired system: the router is
**S1/S2** — it should attenuate the enormous variety of "everything Tejas says" down
to dispatchable units, and coordinate/dampen conflict between concurrent workers —
but it is explicitly **not** S5. S5 (identity, policy, what the organization will/
won't do — i.e., foundational architecture decisions) must stay with Tejas, matching
his explicit rule that "foundations change only with his approval." VSM gives
principled language for *why* an operational coordination layer (S1/S2, the router)
must never be allowed to make S5-level (identity/foundations) decisions — they are
structurally different systems in Beer's model, not just different in degree, and
conflating them is a known viability failure mode (an S1 unit that starts making S5
decisions is by definition no longer viable as a hierarchy — Beer calls this a
collapse of recursion levels).

### Ashby, Law of Requisite Variety

**Key finding.** "Only variety can destroy variety" — a regulator can only control a
system whose disturbance-variety is at most equal to the regulator's own variety
(`Vo_min = Vd - Vr`). A regulator facing more variety in its environment than it can
itself represent/respond to will be dominated by that environment. [Ashby's Law of Requisite Variety](https://www.businessballs.com/strategy-innovation/ashbys-law-of-requisite-variety/); [W. Ross Ashby, Cybernetics and Requisite Variety (1956)](http://panarchy.org/ashby/variety.1956.html)

**Implication.** The router "forgetting its role" under context load is a
requisite-variety failure: the incoming variety (every message Tejas sends, every
worker's back-and-forth) exceeds the router's regulatory variety (a single
context window that must also retain "I am a router, not a worker"). Beer's
attenuation is the fix: the router must **reduce** incoming variety (via stigmergic
shared state, per §3, and structural connection costs, per §2) rather than try to
hold ever-more variety in one context and out-scale the problem. This is a
mathematical argument, not a stylistic one, for why "just give the router a bigger
context window" cannot fix the forgetting-its-role failure — the fix is reducing
variety at the source, not increasing capacity to hold it.

### Conway's Law

**Key finding.** "Any organization that designs a system will produce a design that
mirrors the organization's communication structure" (Conway 1968, popularized via
Brooks' *Mythical Man-Month*). The "Inverse Conway Maneuver" is deliberately
designing team/communication structure to *force* a desired system architecture.
[Conway's law — Wikipedia](https://en.wikipedia.org/wiki/Conway's_law)

**Implication.** If the router and workers all share one communication channel/
context (as apparently happens now — everything relays through the router), the
resulting "system" will be a single undifferentiated blob no matter what the org
chart says, because the *communication structure* is the real architecture. To get
a genuinely modular system, the **communication topology** itself must be
restructured first (workers report to a shared ledger, not to the router's live
context; router reads summaries, not transcripts) — using the Inverse Conway
Maneuver deliberately: redesign who-talks-to-whom in order to produce the desired
separation of concerns, rather than asking one flat communication graph to somehow
produce a layered result.

### Galbraith — organization design as information processing

**Key finding.** Organization structure is driven by the gap between the
information a task requires and the information the organization already has
("uncertainty"). Under low uncertainty, coordination-by-rule or hierarchy suffices.
Under high uncertainty, an org must either **reduce information-processing need**
(slack resources, self-contained tasks) or **increase information-processing
capacity** (better information systems, lateral relations). [A Summary and Review of Galbraith's Organizational Information Processing Theory](https://www.ajman.ac.ae/en/cba/staff/publication/YzhqYXB2OWIrQk5heDNaZEQwYml0dz09)

**Implication.** "Self-contained tasks" is the key lever available here: rather than
increasing the router's information-processing capacity (bigger context, more
relaying — which is the failing strategy), **reduce the information-processing need
by making worker tasks self-contained** — a worker owns everything it needs to
complete without round-tripping intermediate state through the router. The router
then only processes the (small) information of "task dispatched" / "task
done/blocked/needs-decision," not the (large) information of how the work
unfolded.

### Mintzberg — five coordinating mechanisms

**Key finding.** Mutual adjustment (informal peer-to-peer, control stays with
doers) → direct supervision (one person directs others) → standardization (of
process, of outputs, or of skills) — and, notably, **very complex/novel work often
cycles back to mutual adjustment** even in otherwise hierarchical organizations,
because standardization can't anticipate everything novel. [Mintzberg's Coordination Mechanisms Revisited](http://www.diva-portal.org/smash/get/diva2:251645/FULLTEXT01.pdf)

**Implication.** The router shouldn't try to be a permanent "direct supervision"
bottleneck for all coordination. Routine, well-understood work should be
coordinated by **standardization of outputs** (a worker just needs to produce a
result in a known shape/location — a file, a ledger entry — regardless of how it
gets there) rather than the router directly supervising process. Reserve direct
supervision (router actively directing) for genuinely novel or high-stakes
work — matching Tejas's own instinct that routine work should just get delegated
while foundational/ambiguous decisions come back to a human or an explicit
escalation path.

### Mission command / commander's intent

**Key finding.** Mission command doctrine explicitly combines **centralized
intent** with **decentralized execution**: a commander states the intent (what
success looks like and why) and subordinates decide *how* within delegated freedom
of action — because no plan survives contact and no central commander has requisite
variety to micromanage execution in real time. [Mission command — Wikipedia](https://en.wikipedia.org/wiki/Mission_command); [The Commander's Intent in Mission Command](https://fieldgradeleader.themilitaryleader.com/cdr-intent/)

**Implication.** This is close to a template for the router's *correct* role:
**translate Tejas's intent into a clear, bounded goal statement for a worker, then
get out of the way** — not micromanage the worker's steps, and not do the work
itself. It also implies the router's core deliverable per dispatch is an
**intent statement** (what done looks like, why it matters, what's out of scope) —
not a task queue entry. This is consistent with the project's own existing
instruction to give Codex "goal-only" prompts, and gives it an evidenced
justification beyond "Codex does better unconstrained": centralized-intent +
decentralized-execution is the load-bearing structure, and a router that instead
hands over a fully-prescribed step list (or worse, does the steps itself) is
collapsing the mission-command split back into direct micromanagement (or direct
execution).

### Chief-of-staff role: gatekeeper vs. coordinator

**Key finding.** A chief of staff's two named functions are distinct: **gatekeeper**
(filters/prioritizes what reaches the executive's attention, protecting their time)
and **coordinator** (aligns work and communication across the organization on the
executive's behalf) — plus an explicit "curated news feed" framing: synthesizing,
not filtering out things the executive shouldn't know, but processing/framing so
what reaches them is decision-ready rather than raw. [What Is A Chief Of Staff?](https://www.evinex.com/resources/articles/what-is-a-chief-of-staff-key-responsibilities-and-more/); Grokipedia summary.

**Implication.** This is the clearest human-organization analogue to the router
role Tejas actually wants (not a manager who directs, and not a doer, but a
**gatekeeper-coordinator**). The "curated news feed, not a filter that hides things"
distinction is important and matches an already-hard-won lesson in this very
project (the notification/attention design fought over this exact question) — the
router's job in the notification direction is synthesis for decision-readiness,
never silent suppression.

### Coase / Williamson — when to internalize coordination

**Key finding.** Firms (internal hierarchy) exist, versus using an open market of
independent contractors, specifically when the transaction costs of external
coordination — search, negotiation, contract-writing, guarding against
opportunism — exceed the cost of managing the same work internally; this is more
likely under high asset specificity, uncertainty, and frequency of the same kind of
transaction. [Organizational economics — Wikipedia](https://en.wikipedia.org/wiki/Organizational_economics); [Oliver Williamson: Transaction Cost Theory — UBS](https://www.ubs.com/microsites/nobel-perspectives/en/laureates/oliver-williamson.html)

**Implication.** This gives a principled test for *when a persistent worker role
should exist at all* vs. spinning up an ad hoc one-off agent: recurring,
frequent, similar tasks (e.g., "check deployment health," "watch for X") justify a
standing, specialized worker (internalized/"hired"); rare, unique, one-off tasks are
cheaper as ad hoc dispatch (the "market" case) rather than maintaining a permanent
role for them. Useful for deciding the shape of the worker-role catalogue rather
than only the router/worker split itself.

---

## 6. Engelbart and Kay — the human must remain able to steer

### Engelbart, "Augmenting Human Intellect: A Conceptual Framework" (1962)

**Key finding.** Engelbart's H-LAM/T frame treats augmentation as one integrated
system of **H**uman, **L**anguage, **A**rtifacts, **M**ethodology, **T**raining —
not a tool the human hands work to and disengages from. The explicit goal: increase
a person's capability "to approach a complex problem situation, to gain
comprehension to suit his particular needs, and to derive solutions" — i.e.
augmentation of the human's own comprehension and judgment, not replacement of it.
[1962 Summary Report — full text PDF](https://csis.pace.edu/~marchese/CS835/Lec3/DougEnglebart.pdf)

**Implication.** This is the direct grounding for "he isn't notified when something
needs him" being a first-order design failure, not a UX nicety: if the human's
comprehension of and engagement with the system's state degrades, the system has
stopped augmenting him and started operating *around* him. Engelbart's framework
implies notification/attention design is not adjacent to the "real" agent-system
architecture — it's a load-bearing part of what makes the system an augmentation
system at all, on par with the router and workers themselves.

### Alan Kay, "Personal Dynamic Media" (with Adele Goldberg, 1977) / Dynabook vision

**Key finding.** Kay's Learning Research Group work (Dynabook concept) aimed to make
a personal computer a medium the owner could understand, program, and reshape
themselves — not a fixed appliance operated by specialists on the owner's behalf.
The "user interface, a personal view" strand of Kay's writing (title surfaced in
search, not independently verified in full here — flagged as **Possible** not
**Confirmed**) argues the point of a personal computer is that its owner can grasp
and change how it works. [Personal Dynamic Media — Academia.edu](https://www.academia.edu/92735683/Personal_Dynamic_Media); [Dynabook — Wikipedia](https://en.wikipedia.org/wiki/Dynabook)

**Implication.** Directly supports the stated foundations-approval rule: a personal
multi-agent system, in the Engelbart/Kay lineage, is only legitimate as
*augmentation* if its owner can understand and reshape it as it grows — which is
precisely why "agents change foundations without his approval" is treated as a
first-order violation in this project's own instructions, not a process nicety.
Kay/Engelbart together are the philosophical backstop for why structural
enforcement of the approval boundary (not just a request not to) matters as much
here as it does for the router/worker split — both are cases of "the human must
remain able to steer."

---

## Synthesis — recurring principles, with evidence and confidence

1. **Cooperation between levels is not self-sustaining; it needs a structural
   suppressor, not an instruction.** *(Michod; Clune-Mouret-Lipson; this project's
   own "written instructions don't hold" observation.)* A role boundary that can be
   crossed by choice will eventually be crossed. Confidence: high — converges from
   evolutionary theory, digital-evolution experiment, and the project's own lived
   failure.

2. **Modularity is not free and does not emerge from wanting it — it requires an
   explicit cost on the thing you want separated (connections/context-holding), or
   an environment that forces recombination (varying goals).** *(Clune-Mouret-Lipson;
   Kashtan-Alon.)* Confidence: high, from controlled evolutionary-computation
   experiments specifically designed to test this.

3. **A near-decomposable structure survives interruption; an undivided one does
   not.** *(Simon.)* The router's own persistent state should be a small stable
   "subassembly," structurally separate from the large, volatile content of
   worker reasoning. Confidence: high as a general systems-theory principle;
   moderate specificity to LLM context/compaction (the mapping is an analogy,
   not a tested result).

4. **Coordination without central control is possible and often superior for
   the coordinated units — but it optimizes for colony robustness and anonymous
   throughput, not for a single external stakeholder's need for one addressable
   contact and legible accountability.** *(Gordon.)* Use decentralized worker-to-
   worker coordination *internally*; keep the router as the sole external interface
   *because that's a requirement the ant colony never had*, not because
   decentralization "doesn't work." Confidence: high on the biology; the
   qualification about scope is my own reasoned inference, not from a cited source.

5. **Escalation to the top should require crossing an explicit quorum/threshold,
   not a single unit's unilateral judgment call — for both "notify the human" and
   "change a foundation."** *(Seeley's quorum sensing, read together with the
   project's own foundations-approval and notification rules.)* Confidence:
   moderate — the biological mechanism is well evidenced; applying "quorum" to a
   single-human, mostly-single-agent-at-a-time system is an analogy that needs
   translation (e.g., quorum could become "crosses a stated severity/certainty
   bar," not literally multiple agents voting).

6. **Indirect coordination through a shared, persistent medium (stigmergy) beats
   direct relay through a central node — it's the mechanism, not just an option,
   for how "the router's context filling with relay chatter" gets solved.**
   *(Grassé; Theraulaz & Bonabeau; Heylighen.)* Confidence: high as a general
   coordination principle, extensively generalized beyond insects (Heylighen cites
   Wikipedia itself as a human-scale case) — this is the strongest, most directly
   actionable evidence-backed principle in this brief.

7. **Specialization pays specifically when the trade-off between the two roles is
   steep (concave) and when switching between them is costly — not automatically,
   and not just because parallelism is nice.** *(Rueffler-Hermisson-Wagner;
   Goldsby et al.; Duarte et al.)* This gives a testable justification for why
   router/worker must be separate *processes*, not separate *modes* of one
   process: if switching cost inside one context is the actual mechanism causing
   collapse, then the fix must eliminate the switch, not just discourage it.
   Confidence: high on the theory; the mapping of "task-switching cost" onto
   "LLM context/attention" is a reasoned analogy, not a measured result.

8. **A hierarchy needs a variety-reducing (attenuating) layer between raw input and
   any single decision-making unit, and the fix for an overwhelmed regulator is
   attenuation at the boundary, not more capacity inside the regulator.**
   *(Ashby; Beer's VSM S1/S2 attenuation-amplification.)* Directly explains why
   "give the router more context" is the wrong fix for it forgetting its role.
   Confidence: high as cybernetic theory, long-established and widely applied to
   organizations.

9. **Different organizational "systems" (operations vs. identity/policy) are
   categorically different, not just different in degree, and collapsing them is a
   named failure mode, not a style choice.** *(Beer's VSM: S1/S2 vs. S5.)* This is
   the clearest organizational-theory grounding for "agents change foundations
   without his approval" being treated as a distinct, severe violation rather than
   "scope creep." Confidence: high as organizational theory; VSM is a normative
   framework more than an empirically tested one, so treat it as a coherent
   argument rather than a measured finding.

10. **Coordinate by intent and self-contained tasks/outputs where possible; reserve
    direct supervision for the genuinely novel and reserve mutual-adjustment-by-
    relay for the truly ambiguous.** *(Mission command; Galbraith's self-contained
    tasks; Mintzberg's mechanism ladder.)* This is the organizational-theory
    version of "goal-only prompts, not prescribed steps" already practiced in this
    project — evidenced independently by military doctrine and organization
    design theory, not merely by this project's own prior experience with Codex.
    Confidence: moderate-high; well-established in their own domains, applied here
    by analogy.

11. **A gatekeeper's synthesis-for-decision-readiness must never become
    silent suppression — the two are easy to conflate and the failure (hiding real
    information) is worse than the failure of over-notifying.** *(Chief-of-staff
    "curated feed, not a filter" framing.)* Confidence: moderate — drawn from
    practitioner/role-description sources rather than peer-reviewed research, but
    directly corroborated by this project's own documented incident history
    (notices hidden by an `internal` flag).

12. **Augmentation is only legitimate, in the Engelbart/Kay sense, if its owner can
    still understand and reshape the system as it grows — which is a first-order
    design requirement, not an accountability afterthought.** *(Engelbart 1962;
    Kay's Dynabook philosophy.)* Confidence: high as intellectual grounding/
    philosophy; these are foundational visions, not empirical findings, so treat
    this as normative grounding for *why* the foundations-approval rule and
    notification design matter as much as the router/worker mechanics, not as
    engineering guidance on *how* to build either.

## Where the evidence is weak, or the analogy breaks

- **Everything above from biology and insect societies is an analogy, not a
  transferable mechanism.** Genes, pheromones, and antennal-contact rates are
  physically enforced; nothing in an LLM agent is enforced unless someone (a
  harness, a permission system, a process boundary) makes it so. The evolutionary
  material's real contribution is *diagnosing why unenforced cooperation fails*
  (principles 1–3, 6–8 above), not supplying a ready-made mechanism — the actual
  mechanism (tool permissions, separate processes, a shared ledger file, hook-based
  refusals) has to be built in software terms.
- **Ant-colony decentralization (Gordon) is the analogy most likely to be
  over-applied.** It is genuinely evidenced that colonies of interchangeable,
  disposable units coordinate well with no central control — but Tejas's system has
  exactly one human principal who needs a single point of contact, notification,
  and accountability, none of which the ant colony has any equivalent requirement
  for. Citing Gordon to argue "the router shouldn't be a bottleneck for internal
  worker-to-worker coordination" is sound; citing her to argue "the router isn't
  needed as external interface" would be a misapplication the evidence doesn't
  support.
- **Age polyethism → "session age determines trust/role"** is the weakest mapping
  in this brief — bee age is a hard biological clock tied to irreversible physical
  decline; an agent session has no equivalent forced trajectory. Flagged as
  Possible, not Confirmed, and offered only as a loose design intuition.
  I did not find dedicated literature evaluating this specific mapping.
- **Kay's exact phrasing** ("the user must understand and control the system") that
  the brief asked about was not found verbatim in the sources surfaced by search;
  I've represented the Dynabook/Personal Dynamic Media philosophy as the search
  results describe it (making computing "accessible... to nonspecialists" and a
  "vehicle for popular creative expression") rather than asserting an unverified
  direct quote. Treat the specific wording as Possible, the underlying philosophy
  as well-attested.
- **VSM and mission-command are normative/practitioner frameworks, not
  experimentally validated theories** in the way the evolutionary-biology and
  evolutionary-computation sources are. They're widely used and internally
  coherent, but "coherent and widely adopted" is a different, weaker evidence class
  than "measured in a controlled evolutionary simulation" (Clune-Mouret-Lipson,
  Kashtan-Alon, Rueffler-Hermisson-Wagner, Goldsby et al.). I've kept these
  distinctions explicit in the confidence markers above rather than presenting all
  twelve principles as equally evidenced.
- **I read search-result summaries, abstracts, and secondary sources (Wikipedia,
  press summaries, ResearchGate abstract pages), not the full original papers or
  books**, for essentially every citation above — I was not able to verify, e.g.,
  the exact phrasing of Grassé (1959) or Theraulaz & Bonabeau (1999) beyond what
  secondary sources quote, nor read Michod's or Beer's full books. Where a finding
  is load-bearing for a design decision, treat the citation as a pointer to go
  verify in the primary text before treating it as settled, not as already-checked
  original-source confirmation.
