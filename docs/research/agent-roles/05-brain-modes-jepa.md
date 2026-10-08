# Brain science for multi-agent role design: router, controller, workers, memory

Research brief response. Failures being addressed: router answers instead of routing;
router's context fills with worker back-and-forth; router forgets its role after
compaction; written rules don't hold. Goal: ground role design in "the right mode of
cognition for the right job."

---

## 1. Action selection & gating

### Basal ganglia as a centralized selection device
**Citation:** Redgrave, Prescott & Gurney (1999), "The basal ganglia: a vertebrate
solution to the selection problem?" *Neuroscience* 89(4):1009-23.
[PubMed](https://pubmed.ncbi.nlm.nih.gov/10362291/) ·
[preprint PDF](https://eprints.whiterose.ac.uk/id/eprint/107033/1/Redgrave%20Neuroscience%201999%20preprint.pdf)

**Core finding:** A "selection problem" arises whenever multiple competing
subsystems seek simultaneous access to a shared, limited resource (a muscle group, a
cognitive resource, an output channel). The authors argue the vertebrate basal
ganglia evolved specifically as a **centralized, domain-general selection device**
sitting between many candidate-generating systems and one execution channel — it does
not generate behavior itself, it arbitrates among proposals from elsewhere in the
brain and disinhibits exactly one winner.

**Implication for routing:** This is the cleanest brain analogue of "a router that
routes and does not do the work." The basal ganglia's whole job is comparison and
gating of *already-formed* proposals from cortex, not proposal generation. Structurally
it is a separate, simple, fast circuit — not an elaborated version of the systems it
selects among. A router agent should be architecturally minimal and generic: it does
not need domain expertise in the tasks it dispatches, only a comparison/selection
function over candidate actions ("which worker session should get this capture") and a
gate that gets flipped (dispatch) or not (hold). The temptation to let the router
"just answer" is structurally equivalent to the selection circuit trying to also do the
motor act — a category error the basal ganglia's architecture is built to avoid by not
having the capacity to execute anything itself.

### Thalamic gating
**Citation:** Crick (1984) "searchlight" hypothesis on the thalamic reticular
nucleus (TRN); reviewed via [ScienceDirect topic overview](https://www.sciencedirect.com/topics/neuroscience/thalamic-reticular-nucleus)
and [attentional-gating studies](https://www.jneurosci.org/content/20/23/8897).

**Core finding:** The TRN is a thin inhibitory shell wrapped around the thalamus,
positioned as the single choke point between thalamus and cortex. Its output is purely
inhibitory: it does not add content, it *suppresses* thalamocortical channels it is not
currently selecting, sharpening which signals reach cortex ("searchlight of
attention"). Gating here is achieved by default-inhibit-everything, then
selectively-disinhibit-one-channel — not by an accumulating filter that has to
positively decide what to admit.

**Implication:** A router's default state should be "block/hold," with dispatch as
active, deliberate disinhibition of exactly one destination — not a chat participant
that has to be told "please don't answer" as an added rule. The rule should be load-bearing
in the architecture (nothing gets to the user/output channel except through an explicit
dispatch act) rather than a written instruction the router is expected to remember to
follow every turn.

### Prefrontal working-memory gating: PBWM
**Citation:** O'Reilly & Frank (2006), "Making Working Memory Work: A Computational
Model of Learning in the Prefrontal Cortex and Basal Ganglia," *Neural Computation*
18(2):283-328. [PDF](https://cseweb.ucsd.edu//~gary/PAPER-SUGGESTIONS/OReillyFrank06_pbwm-neural-comp-2006.pdf) ·
[PubMed](https://pubmed.ncbi.nlm.nih.gov/16378516/)

**Core finding:** Working memory is not just "PFC holds things." The PBWM model shows
PFC representations are organized into separately-updatable **stripes**, each gated
independently by basal-ganglia signals (striatum → disinhibits thalamus → allows a PFC
stripe to update). Critically the same BG circuitry does **maintenance gating** (hold
this, protect it from being overwritten) and **output gating** (release this
representation to influence downstream behavior) as two distinct signals. Dopamine
reward-prediction-error signals train which gating actions are useful.

**Implication:** This is the mechanism that should prevent "context fills with worker
back-and-forth" and "forgets its role after compaction." The brain's answer is: don't
hold everything in one undifferentiated buffer that anyone can write to. Have
separately gated slots, and a trained/explicit **policy for what gets written into the
maintained slot at all** — most incoming activity is not gated in. Applied to the
router: the router's own persistent context (its "stripe") should be gated so that
worker chatter is *never admitted* to it by default; only specific, small, structured
signals (task complete / task failed / needs escalation) should have a gating action
that writes them in. This argues for the router not being the same process/context that
talks to workers turn-by-turn at all — the gate should be a structural boundary (a
separate summarization/interface step), not a self-discipline the router exercises
inside one long-lived context window.

---

## 2. Cognitive control

### Miller & Cohen 2001 — PFC biases, doesn't do
**Citation:** Miller & Cohen (2001), "An Integrative Theory of Prefrontal Cortex
Function," *Annual Review of Neuroscience* 24:167-202.
[PDF](https://ekmillerlab.mit.edu/wp-content/uploads/2025/06/Miller-Cohen-2001.pdf) ·
[Annual Reviews](https://www.annualreviews.org/content/journals/10.1146/annurev.neuro.24.1.167)

**Core finding:** Cognitive control comes from PFC **actively maintaining** patterns
representing goals and task rules, and using those maintained patterns to send
top-down **bias signals** to other (posterior, sensory/motor) brain areas. PFC does not
perform the perceptual or motor computation itself — it biases the competition among
already-existing pathways in other regions so the *task-relevant* mapping wins, especially
when that mapping is weak, novel, or must override a stronger habitual response. Control
is needed precisely when automatic/habitual processing would give the wrong answer.

**Implication:** This is the single best model for a "controller" role distinct from
both router and workers: a controller holds the goal/rules and *biases* which worker or
which of a worker's outputs gets weight — it does not do the domain work. It should be
invoked specifically when the default/habitual path (a worker's specialty, or the
router's simple classification) would misfire — i.e., control is a scarce, effortful,
selectively-deployed resource, not something running continuously on every request.

### Botvinick — conflict monitoring triggers control
**Citation:** Botvinick, Cohen & Carter (2004), "Conflict monitoring and anterior
cingulate cortex: an update," *Trends in Cognitive Sciences*.
[PubMed](https://pubmed.ncbi.nlm.nih.gov/15556023) ·
[Princeton](https://collaborate.princeton.edu/en/publications/conflict-monitoring-and-anterior-cingulate-cortex-an-update/)

**Core finding:** Anterior cingulate cortex monitors for **conflict** — simultaneous
activation of competing response representations — and that conflict signal is what
*triggers* recruitment of additional (PFC-mediated) control, rather than control running
by default. Control is reactive to detected difficulty, not a constant background
process.

**Implication:** Escalation from router → controller/deliberation should be triggered by
a detectable conflict signal (ambiguous intent, competing candidate destinations, low
classifier confidence) rather than happening on every request or never happening at
all. This maps directly onto the existing "escalate up" pattern in this codebase's own
instructions (stuck problem, repeated failure, contradictory evidence) — conflict
monitoring is the biological version of "count fixes per symptom, escalate on trigger."

### Koechlin — cascade model / hierarchical timescales of control
**Citation:** Koechlin, Ody & Kouneiher (2003), "The Architecture of Cognitive
Control in the Human Prefrontal Cortex," *Science* 302:1181-1185.
[Science](https://www.science.org/doi/abs/10.1126/science.1088545) ·
[PubMed](https://pubmed.ncbi.nlm.nih.gov/14615530/)

**Core finding:** Lateral PFC is organized as a **cascade** along the
posterior-to-anterior axis: premotor cortex selects actions given immediate stimuli
(sensorimotor control); posterior LPFC selects among action rules given the current
perceptual context (contextual control); anterior/frontopolar cortex selects among
context-rules given the broader temporal episode the agent is in (episodic control).
Each level's output constrains/gates the level below it; higher levels operate over
longer timescales and more abstract, less frequently updated information.

**Implication:** This maps directly onto a three-tier agent hierarchy: fast
stimulus-bound classification (router, updates every message) → contextual
policy that says which rules apply in this kind of situation (a controller/orchestrator,
updates per task or per session) → episodic/goal-level policy that rarely changes
(the standing instructions/mission, e.g. AGENTS.md, updates rarely and deliberately). The
brain does **not** put all three in the same circuit updating at the same rate — this is
a strong argument that router logic, task-orchestration logic, and standing-goal logic
should live in different processes/timescales, not the same context window doing all
three jobs at once.

### Badre — rostro-caudal abstraction hierarchy
**Citation:** Badre (2008), "Cognitive control, hierarchy, and the rostro-caudal
organization of the frontal lobes," *Trends in Cognitive Sciences*.
[ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S1364661308000612) ·
[Badre Lab](https://sites.brown.edu/badrelab/our-work/publications/)

**Core finding:** Converges with Koechlin: progressively anterior PFC regions
represent progressively more abstract control policies, with posterior regions handling
concrete, stimulus-bound decisions. Frontal-lobe damage produces control deficits
specifically calibrated to the abstraction level of the damaged region — a caudal lesion
impairs concrete action selection while sparing abstract rule use, and vice versa.

**Implication:** Reinforces that abstraction level should be an architectural property
(which agent/layer you're in) rather than something one agent context is expected to
track across levels simultaneously. Also suggests: if the router (concrete,
stimulus-bound layer) is damaged/degraded (context overflow, compaction), the
*abstract* rule layer (its instructions, its role definition) should be recoverable
independently — stored where corruption of the fast layer cannot touch it. This is a
biological argument for the router's role definition living outside its own
conversational context (e.g., re-injected system prompt / external config it reloads),
not inside the same rolling buffer that gets compacted.

---

## 3. Global workspace theory

**Citation:** Baars (1988, foundational); Dehaene & Changeux, formalized as the Global
Neuronal Workspace Theory (GNWT). Overview:
[Frontiers 2021 review](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2021.749868/full) ·
[Dehaene–Changeux model, Wikipedia](https://en.wikipedia.org/wiki/Dehaene%E2%80%93Changeux_model)

**Core finding:** Cognition consists of many **specialized, parallel, unconscious
processors** (perceptual, memory, motor) that ordinarily work independently and locally.
A small subset of their outputs gets selected for **global broadcast** through a
long-range, capacity-limited "workspace" (heavily involving PFC and parietal cortex),
which is what makes that content available system-wide — to language, planning,
report, memory encoding. Access to the workspace is itself competitive and gated
(bottom-up salience and top-down attention jointly determine what "ignites" into global
broadcast); only ignited content becomes reportable/consciously available. Most
processing never reaches the workspace at all.

**Implication:** This is a strong structural analogue for what should and should not
reach the router's/orchestrator's shared attention. Workers are the "specialized
unconscious processors" — they should run locally, verbosely, and mostly invisibly.
Only a deliberately gated, low-bandwidth summary ("ignition") should ever be broadcast
into the shared/attended context (the router, the human-facing surface, memory). The
router's context filling with worker back-and-forth is exactly the failure mode of
*not* having a workspace-admission gate — i.e., treating every worker token as if it
had already "ignited" and deserved global broadcast, rather than filtering almost all
of it out by design and passing forward only what won the competition for global
relevance.

---

## 4. Dual-process theory & metacognitive routing

### Kahneman / Evans & Stanovich
**Citation:** Evans & Stanovich (2013), "Dual-Process Theories of Higher Cognition,"
*Perspectives on Psychological Science*.
[SAGE](https://journals.sagepub.com/doi/full/10.1177/1745691612460685); popularized in
Kahneman, *Thinking, Fast and Slow* (2011). Stanovich coined "System 1/2"; Kahneman
adopted the terms.

**Core finding:** Two functionally distinct clusters of processing: **Type 1** —
fast, automatic, parallel, low-effort, associative/pattern-based, doesn't require
working memory; **Type 2** — slow, effortful, serial, rule-based, requires working
memory and can override Type 1 outputs. The "two systems" label is a simplifying
metaphor over what's really a cluster of correlated properties (speed, effort,
automaticity, working-memory demand), not two literal anatomical systems — Evans &
Stanovich are explicit that the field has moved past treating this as two clean boxes.

**Implication for the design brief's explicit ask:** map router→System-1-like
(fast, pattern-matching classification, no deliberation) and deep-work
agents→System-2-like (slow, effortful, working-memory-heavy, can revise System 1's
default). The weak-analogy flag: don't over-literalize "System 1 lives in one brain
region" — it's a processing *mode*, so the practical translation is "cheap
non-deliberative classifier vs. expensive deliberative agent," which is a legitimate
engineering distinction even though the neural "two systems" framing is contested.

### Daw, Niv & Dayan 2005 — uncertainty-based arbitration
**Citation:** Daw, Niv & Dayan (2005), "Uncertainty-based competition between
prefrontal and dorsolateral striatal systems for behavioral control," *Nature
Neuroscience* 8:1704-1711. [Nature](https://www.nature.com/articles/nn1560) ·
[PDF](http://matt.colorado.edu/teaching/highcog/fall11/outlines/Daw%20et%20al.%202005.pdf)

**Core finding:** The brain runs both a **model-free** controller (dorsolateral
striatum — cheap, cached, habitual, "what worked before here") and a **model-based**
controller (PFC — expensive, simulates forward, flexible) concurrently and
**arbitrates between them by relative uncertainty**: whichever system's value estimate
is currently more reliable (lower estimated uncertainty/variance) gets to drive
behavior on that trial. This is a genuine computational (Bayesian) account of *when to
escalate from habit to deliberation* — not a fixed threshold or schedule, but a
running estimate of confidence in the cheap answer.

**Implication:** This is the most directly actionable brain-science finding for the
router. Don't route by a fixed rule ("always ask an LLM to classify") or a fixed
schedule; route by an **explicit, tracked confidence/uncertainty estimate** on the fast
path's output, and escalate to a slow/deliberative path specifically when that estimate
is high (novel phrasing, no strong precedent, competing candidate destinations). This
also argues for keeping a running record of the fast classifier's calibration/accuracy
over time (like the striatal system's learned reliability) so the threshold for
escalation is itself data-driven, not a guessed constant — directly relevant to the
global instructions' own warning about "a limit you budget around is a primitive you're
misusing": arbitration-by-uncertainty is the right primitive, a fixed confidence
threshold tuned by hand is the anti-pattern.

---

## 5. Salience/executive/default-mode network switching

**Citation:** Menon & Uddin (2010), "Saliency, switching, attention and control: a
network model of insula function," *Brain Structure and Function* 214:655-667.
[PubMed](https://pubmed.ncbi.nlm.nih.gov/20512370/)

**Core finding:** A third network — the **salience network**, hubbed on the anterior
insula — is neither the task-focused executive network nor the introspective
default-mode network. Its job is to detect salient (behaviorally relevant) internal or
external events and, on detecting one, **actively switch** which of the other two
large-scale networks is in control — suppressing default-mode, engaging the executive
network, or vice versa. It is a dedicated switcher, distinct from either mode it
switches between.

**Implication:** This maps onto a distinct architectural role separate from both
"router" and "worker": something whose only job is deciding *which mode the whole
system should currently be in* — is this attention-worthy enough to interrupt/escalate
at all, or should it stay in default (queued/passive) processing. This is arguably the
correct home for "should this even reach a human / does this need
`needs_you` vs `done`" logic — a dedicated salience/notification layer, not folded
into the router's classification job or the worker's task-completion job.

---

## 6. Memory: complementary learning systems

**Citations:**
McClelland, McNaughton & O'Reilly (1995), "Why there are complementary learning
systems in the hippocampus and neocortex," *Psychological Review* 102:419-457.
Kumaran, Hassabis & McClelland (2016), "What Learning Systems do Intelligent Agents
Need? Complementary Learning Systems Theory Updated," *Trends in Cognitive Sciences*.
[PubMed 1995](https://pubmed.ncbi.nlm.nih.gov/7624455/) ·
[Stanford PDF 2016](https://web.stanford.edu/~jlmcc/papers/KumaranHassabisMcC16CLSUpdate.pdf) ·
[PubMed 2016](https://pubmed.ncbi.nlm.nih.gov/27315762/)

**Core finding:** The brain needs **two** learning systems because one system can't do
both jobs well: the **hippocampus** does fast, sparse, pattern-separated one-shot
encoding of specific episodes (today's meeting, this exact request) — but this
representation is not yet integrated with existing knowledge and would cause
catastrophic interference if written directly into cortex. The **neocortex** does
slow, overlapping, interleaved learning that gradually extracts generalizable structure
across many episodes (semantic knowledge, stable "how things work" rules) — deliberately
slow so that new information doesn't overwrite old structure. Sleep/rest-driven
**replay** transfers/consolidates hippocampal episodic traces into cortex over time
without direct fast writing. The 2016 update explicitly reframes this as a
recommendation for AI systems: agents need both a fast episodic buffer *and* a slow
consolidation process, and note (per Hassabis, DeepMind) this was already informing
experience-replay design in RL.

**Implication — this is the direct answer to "forgets its role after compaction":**
The failure is a complementary-learning-systems violation: the router's role/rules are
being stored *only* in the fast, volatile, high-interference buffer (the live context
window, which is literally overwritten/compacted under pressure — the hippocampal
failure mode, catastrophic interference) with **no slow consolidated store** the role
can be recovered from. The fix implied by CLS is architectural, not motivational: role
definition, standing protocol, and durable facts belong in a "neocortex" — a
stable store loaded fresh at the start of every episode (a system prompt / config file
re-read every turn, e.g. this project's own AGENTS.md pattern) — while the "hippocampus"
(the live conversation, worker exchanges, in-flight task state) is expected to be
volatile and is *not* where durable identity should ever live. Compaction destroying
role-adherence is exactly analogous to hippocampal damage erasing recent episodic memory
while leaving consolidated semantic knowledge (in cortex) intact — except in the current
design there is no cortex-equivalent, so everything is hippocampal and everything is lost.

---

## 7. Predictive processing / free energy (brief, as requested)

**Citation:** Friston, "The free-energy principle: a unified brain theory?" *Nature
Reviews Neuroscience* (2010). [Nature](https://www.nature.com/articles/nrn2787)

**Core finding:** The brain is framed as continuously predicting its own sensory
input top-down, with only the *prediction error* (mismatch) propagating upward to
update the model; action is a way of changing input to match prediction rather than
the reverse.

**Bearing on routing (limited):** The one transferable idea is **error-driven, not
content-driven, upward signaling** — a lower layer (worker) should only pass
information up to a higher layer (router/controller) when it deviates from
expectation (task failed, unexpected branch, needs a decision), not by default
streaming everything upward. This reinforces the global-workspace/CLS argument above
from a different angle but adds no new mechanism beyond it; flagged as the weakest,
most speculative fit to routing of the topics researched — treat as a supporting
frame, not a load-bearing citation.

---

## 8. Hierarchical modular brain networks — cost/efficiency

**Citation:** Meunier, Lambiotte & Bullmore (2010), "Modular and hierarchically
modular organization of brain networks," *Frontiers*;
Bullmore & Sporns, "The economy of brain network organization," *Nature Reviews
Neuroscience* (2012). [PubMed](https://pubmed.ncbi.nlm.nih.gov/21151783/) ·
[Nature](https://www.nature.com/articles/nrn3214)

**Core finding:** Brain networks are organized as **modules nested within
modules within modules** (hierarchical modularity), not as one flat densely-connected
graph. This shape is explained by an economic trade-off: dense long-range wiring is
metabolically and physically expensive, so the brain buys most of its needed
computation with cheap short-range connections *within* modules, and pays for a much
smaller number of expensive long-range connections only where they buy outsized
integration benefit (the network's "rich club" hub connectors).

**Implication:** Supports a many-small-cheap-workers / few-expensive-long-range-links
topology over one flat mesh of agents all able to talk to each other. Concretely:
most communication should be cheap and local (within a worker's own task), and the
expensive "long-range" links (router↔controller, controller↔memory store) should be
few, deliberate, and reserved for information that actually needs to cross module
boundaries — not a default fully-connected chat log everyone reads.

---

## 9. "Jao/Jev" — model identification

Two real candidates were found; they answer different parts of "does classification."

### Candidate A: JEPA (Joint-Embedding Predictive Architecture) — Yann LeCun
**Citations:** [I-JEPA (Meta AI, 2023)](https://ai.meta.com/blog/yann-lecun-ai-model-i-jepa/) ·
[V-JEPA 2 (Meta AI, June 2025)](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) ·
[TechCrunch on V-JEPA 2](https://techcrunch.com/2025/06/11/metas-v-jepa-2-model-teaches-ai-to-understand-its-surroundings/) ·
[AMI Labs / LeCun leaving Meta, March 2026, $1.03B raise](https://techcrunch.com/2026/03/09/yann-lecuns-ami-labs-raises-1-03-billion-to-build-world-models/)

**What it is:** A self-supervised architecture with three parts — a context encoder,
a target encoder, and a predictor — that predicts the **embedding** of a masked/future
part of the input from the embedding of the visible/context part, entirely in latent
(representation) space, rather than predicting raw pixels or tokens. This lets it
discard unpredictable low-level noise and keep only structure that matters for
downstream tasks. LeCun left Meta in Nov 2025 and founded AMI Labs (Paris, $1.03B seed,
March 2026) explicitly to build world models on this bet, in opposition to
continuing to scale LLMs.

**What it's good at:** I-JEPA representations transfer very well to downstream
**classification via linear probing** — outperforming MAE/DINO-style methods on
ImageNet, CIFAR100, low-shot classification (as few as 12 labeled examples/class) —
and V-JEPA/V-JEPA 2 extend this to video for physical world models used in robot
planning. The strength is *general-purpose representation quality*, not routing per se.

**Fit to routing role:** Indirect. JEPA-style embeddings are a plausible *substrate*
for a fast, cheap intent classifier (embed the incoming capture, nearest-neighbor or
lightweight classifier against known worker/destination categories) instead of running
a full LLM call for triage. This is architecturally the same idea as "System 1 as a
non-generative embedding step," but JEPA itself is a vision/video-first self-supervised
pretraining method, not a shipped text-classification-for-routing product.

### Candidate B: Jev — TypeSafe AI's "System One model" (much stronger phonetic and functional match)
**Citations:** [Jev, Wikipedia](https://en.wikipedia.org/wiki/Jev_(AI_model)) ·
[TechCrunch, Sept 18 2026](https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/) ·
[Business Standard](https://www.business-standard.com/technology/artificial-intelligence/what-is-jev-inside-the-new-ai-model-built-to-make-software-decisions-126092200452_1.html)

**What it is:** Released in limited early access Sept 15, 2026 by TypeSafe AI (founded
by Diogo Almeida, an OpenAI researcher who helped invent RLHF and build ChatGPT), with
a $40M seed from DCVC. Explicitly branded "the first **System One model**" — named for
Kahneman's fast/intuitive System 1, and separately named after economist William
Stanley Jevons. It is transformer-based but **non-autoregressive** and does not
generate natural language: a request is a text/JSON "state" plus a typed "question"
(Choice / Score / Yes-No), and it returns a value from a **predefined schema** plus a
calibrated probability/confidence score. Trained with "Reinforcement Learning for
Calibrated Decisions" (RLCD) on synthetic data. Reported latency 70–500ms, claimed
40–200x faster and 40–400x cheaper than frontier LLMs (company-reported benchmarks;
independent numbers are mixed — Vercel reported 5–18x speedups, one integrator reported
it as *more* expensive than Gemini for email classification, so treat the headline
multiplier as a range, not a settled fact).

**Fit to routing role — direct, and explicitly named as a use case:** TechCrunch's
reporting names **"Model routing: determining which specialized model should handle
specific workloads"** as one of the launched use cases developers are already using it
for, alongside classification (email/safety categorization) and agent monitoring
(cheap, fast confidence check on an LLM agent's outputs to catch jailbreaks/drift
before they reach the user). Because the schema is fixed in advance, the model
structurally **cannot** answer outside its lane — it cannot "decide to answer the
question itself" the way an LLM router can, because "answer the question" isn't a
value in its schema. That property is a direct, mechanical fix for exactly the first
failure named in the brief (router answers instead of routing): if the router's core
decision were implemented as a typed Choice call rather than an open-ended chat turn,
"answer the question myself" would not be an expressible output at all.

**Verdict:** Jev is almost certainly the intended reference — phonetically closer
("Jev" vs. transcribed "Jao/Jev"), released 10 days before this brief, explicitly
described as doing classification, and explicitly used today for model/agent routing.
JEPA is worth keeping in the discussion because LeCun's world-model framing is the
better-known "does classification via embeddings" story and may be what Tejas half-recalled
alongside it — recommend confirming with him directly which (or both) he meant, since
they solve related but distinct problems (JEPA: build good general-purpose embeddings;
Jev: make a fast, schema-constrained, non-generative decision).

**Other candidates checked and ruled out:** Genie / Genie 3 (Google DeepMind,
generative interactive world model, not a classifier — [Wikipedia](https://en.wikipedia.org/wiki/Genie_(world_model)));
no other 2025–2026 model name matching "Jao" was found.

---

## 10. Synthesis: mapping brain mechanisms to agent-system roles

| Agent-system role | Brain mechanism(s) it maps to | What that mechanism structurally guarantees |
|---|---|---|
| **Router / front door** | Basal ganglia central selection circuit (Redgrave et al. 1999) + thalamic/TRN gating (default-inhibit, selective disinhibit) | Cannot execute — architecturally incapable of "doing the work," only of gating access to one of several downstream channels. Default state is block, not pass-through. |
| **Fast intent classification inside the router** | Type 1 / System 1 processing (Evans & Stanovich); functionally, a JEPA-style embedding classifier or a schema-constrained model like Jev | Output space is small and fixed (a destination, a category) — cannot emit an open-ended "answer," which is the mechanical fix for "router answers instead of routing." |
| **Escalation from router to deliberation** | Daw/Niv/Dayan uncertainty-based arbitration; Botvinick conflict monitoring (ACC) | Escalation is triggered by a *measured* confidence/conflict signal, not a fixed schedule or a hand-tuned threshold — the threshold itself should be learned/tracked, not guessed. |
| **Controller / orchestrator** | Miller & Cohen's PFC-as-bias-signal; Koechlin's cascade / Badre's rostro-caudal hierarchy | Controller biases which worker/branch wins, at a slower update rate and higher abstraction than the router; does not perform worker-level computation itself. Different abstraction levels are different circuits/timescales, not one context tracking all of them. |
| **Workers** | GWT's "specialized unconscious processors"; model-free habitual striatal system (cached, cheap, task-specific) | Run locally and mostly invisibly; their raw process is never, by default, "broadcast" to the shared/attended layer. |
| **What reaches the router/human's attention** | Global workspace "ignition" (Baars; Dehaene & Changeux); salience-network switching (Menon & Uddin) | A dedicated, separate gate decides what's salient enough to broadcast/interrupt — this is not the router's job and not a worker's job, it's a third function (maps to this system's own `needs_you`/`done`/`response` outcome protocol). |
| **Durable role/identity/instructions** | Neocortical slow-consolidated knowledge (McClelland/McNaughton/O'Reilly CLS; Kumaran/Hassabis/McClelland 2016) | Lives in a stable store reloaded fresh every episode (system prompt / AGENTS.md), structurally separate from and immune to the volatile live-conversation buffer. This is the mechanism that makes "forgets its role after compaction" impossible in the brain's version: compaction only ever destroys the hippocampal/episodic buffer, never the consolidated cortical store. |
| **In-flight task state / worker exchange** | Hippocampal fast episodic buffer | Expected to be volatile and lossy by design — the brain does not try to make this buffer durable, it relies on the *other* store for durability. Treating live context as the durable home for role/rules is the architectural bug. |
| **Topology of who talks to whom** | Hierarchical modular networks (Meunier; Bullmore & Sporns) | Mostly cheap short-range links within a worker's task; few, deliberate, expensive long-range links between router/controller/memory — not a flat all-to-all chat transcript. |

### What makes "the controller forgets its role" essentially impossible in the brain, and why the current design lacks that protection

The brain never stores identity/rules/goals in the same substrate that gets
overwritten under load. Working memory (PFC active maintenance, hippocampal episodic
traces) is explicitly *designed* to be volatile, capacity-limited, and subject to
interference/decay — and evolution's answer to that fragility was never "make working
memory more durable," it was "don't rely on working memory for anything you need to
survive a reset." Durable task-general knowledge (semantic memory, procedural
skill, standing goals) is consolidated into a physically separate, slow-changing
substrate (neocortex) that ordinary momentary overload cannot touch. A "controller
forgets its role" failure is, in these terms, the equivalent of expecting the
hippocampus to hold your name for the rest of your life — it isn't built for that,
and nothing in the brain expects it to. The fix is not a stronger rule inside the
volatile context ("remember you are the router"); it's making sure the role
definition is not stored in the volatile context in the first place — reloaded from
outside on every turn, the way this project's own AGENTS.md pattern (and the global
CLAUDE.md's own "systems, not good intentions" principle) already argues for
everywhere else.

### Weak analogies to flag explicitly
- **Dual-process "two systems"** is a correlated-properties cluster, not two literal
  anatomical modules — useful as an engineering metaphor (cheap-fast vs.
  expensive-slow path), not as a literal brain-mapping claim.
- **Predictive processing / free energy** contributes one transferable idea
  (error-driven upward signaling) but is largely redundant with the global-workspace
  and CLS arguments above; it is the least load-bearing citation in this brief and is
  included only because it was explicitly requested.
- **Basal ganglia "selection"** is a well-evidenced account of motor/action selection;
  its extension to abstract "cognitive resource" selection (as opposed to motor
  output) is Redgrave et al.'s own explicit generalization/hypothesis, not as fully
  established experimentally as the motor case — treat the cognitive-selection
  reading as a reasonable but somewhat extrapolated application.
- **JEPA-as-router** is speculative on our part — no publisher currently ships JEPA as
  a text-intent classifier for agent routing; the fit is architectural/conceptual
  (embedding-space classification vs. generative reasoning), not a demonstrated
  product use case the way Jev's "model routing" use case is.
