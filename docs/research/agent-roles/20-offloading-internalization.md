# Cognitive offloading and internalization: what research says about deciding what to know vs. what to delegate

Research brief for: deciding what Tejas must understand/internalize when agents build things for him,
so that understanding compounds rather than erodes. Read-only research; primary sources where available,
confidence marked per claim.

---

## 1. Extended mind (Clark & Chalmers, 1998) and its critiques

**Finding.** Clark & Chalmers, "The Extended Mind" (*Analysis* 58(1), 7–19, 1998), argue cognition is not
bounded by skull and skin: when an external resource (notebook, calculator, environment) is reliably
available, trusted, and functionally integrated into a person's reasoning the way biological memory is,
it is *part of* the cognitive system, not merely a tool it uses ("active externalism"). Their canonical
case: Otto, who has Alzheimer's and uses a notebook the way Inga uses biological memory — both "believe"
the museum is on 53rd Street, one via brain, one via notebook. The criterion for inclusion is functional
parity: constant availability, automatic endorsement without critical scrutiny, and easy retrieval.

**Critiques.**
- **Coupling-constitution fallacy** (Adams & Aizawa): being causally coupled to a process that
  contributes to cognition doesn't make that process *part of* cognition — the pen isn't part of your
  arithmetic just because arithmetic depends on it. They argue for a "mark of the cognitive" (intrinsic,
  content-bearing, non-derived representation) that external artifacts lack.
- **Boundary thesis / reliability objection**: Otto's notebook lacks the constancy and privileged
  access biological memory has (Inga can always introspect; Otto must physically locate and open the
  notebook, and it can be lost, stolen, or wrong without his knowing). Critics argue this asymmetry
  matters and blocks true parity.
- Clark's later work ("Supersizing the Mind," 2008) and Chalmers' own extended-consciousness essays
  respond that the parity argument was never meant to require *identical* reliability, only functional
  sufficiency for the task.

**Evidence strength:** Philosophical argument, not empirical — Confirmed as an influential, contested
position; not a testable claim in the scientific sense. Treat as a *framework*, not a finding.

**Implication for Tejas's decision:** The extended-mind framing legitimizes treating agents/tools as
part of "his" cognitive system for well-understood, reliable, low-stakes retrieval (the Otto case). But
the critiques identify exactly the failure mode to watch for: an externalized process only safely
substitutes for internal understanding when it has notebook-like reliability *and* he retains a way to
notice when it's wrong. An agent's output that he cannot spot-check is not functionally equivalent to
his own belief — it fails the parity condition the whole theory rests on.

Sources: [Clark & Chalmers PDF](https://www.alice.id.tue.nl/references/clark-chalmers-1998.pdf), [Extended mind thesis — Wikipedia](https://en.wikipedia.org/wiki/Extended_mind_thesis), [NDPR review](https://ndpr.nd.edu/reviews/the-extended-mind/), [Mark of the Cognitive and Coupling-Constitution Fallacy — PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5712358/)

---

## 2. Distributed cognition (Hutchins, *Cognition in the Wild*, 1995)

**Finding.** Hutchins' ethnography of U.S. Navy ship navigation teams shows cognition as a property of a
whole socio-technical system — people, instruments, charts, procedures, and communication protocols —
not any individual's head. No single crew member holds the full representation needed to navigate; the
"mind" that navigates is the assembly. Distributed cognition asks where information flows, how
representations are transformed as they move between people and artifacts (a bearing becomes a pencil
mark becomes a spoken number), and how the system as a whole remembers and computes, including its
resilience when one node fails.

**Evidence strength:** Confirmed as a foundational qualitative/ethnographic finding, widely replicated
in other high-stakes team settings (aviation cockpits, air traffic control, surgical teams). Not a
controlled experiment; strength comes from convergent case studies across domains (Hutchins himself, plus
aviation human-factors literature that followed).

**Implication:** Distributed cognition is the organizational analogue of what Tejas is trying to design:
a person + multiple agents is already a distributed cognitive system. The key transferable lesson from
Hutchins is that such systems fail not when one member lacks a fact, but when the *representation* that
should carry a fact between members is lost, garbled, or never made explicit (a chart mark nobody reads).
This argues for making agents' outputs into stable, inspectable representations (docs, invariants, diffs)
rather than transient chat — matching the CLAUDE.md instruction that agent work must be written to files,
not just returned in messages that vanish on compaction. The distributed-cognition lens also cautions that
"the system knows it" is not the same as "Tejas knows it" — he is one node, and if he is the node that
must catch errors or make judgment calls, the representations reaching him must be at the right altitude.

Sources: [Cognition in the Wild — Internet Archive](https://archive.org/details/cognitioninwild0000hutc), [Distributed cognition — Wikipedia](https://en.wikipedia.org/wiki/Distributed_cognition), [Hutchins summary](https://ferd.ca/notes/hutchins-distributed-cognition-in-the-wild.html)

---

## 3. Cognitive offloading review (Risko & Gilbert, 2016, *Trends in Cognitive Sciences* 20(9): 676–688)

**Finding.** Offloading is "the use of physical action to alter the information-processing requirements
of a task so as to reduce cognitive demand" (e.g., writing a list instead of remembering, tilting your
head instead of mentally rotating an image, setting a phone reminder instead of holding an intention in
mind). Risko & Gilbert's review establishes two key empirical patterns:
- **When offloading helps:** it reliably improves *task performance* (fewer errors, faster completion)
  when the external store is available and reliable — the whole point of using it.
  Metacognitively well-calibrated people offload more when their own memory would be worse, and this
  matches actual capacity (i.e., people know when to offload).
- **When offloading harms:** it degrades memory encoding of the offloaded content itself, and this cost
  shows up specifically *when the external aid is unexpectedly unavailable later*. Their cited paradigm
  (Risko et al., trivia-typing task): participants told information would be *erased* remembered it
  better than participants told it would be *saved* — expecting an external store measurably reduces
  internal encoding of the same content, not just retrieval strategy. A GPS-navigation study found
  drivers who offloaded wayfinding onto GPS could not later recall route scenes or re-drive the route
  without the aid, unlike unaided drivers.

**Evidence strength:** Likely-to-Confirmed — this is a synthesis of many converging experimental
studies (not one dataset), the core save/erase encoding result and GPS wayfinding result are specific,
replicated paradigms, and the review is highly cited (1000+ citations) as the standard reference.

**Implication:** This is close to the operative rule for Tejas's problem. Offloading is *net positive*
for the task at hand when the tool is expected to remain available and reliable (which is the normal
case for "let the agent hold it and I'll ask again"). It becomes a liability specifically for content he
might need *without* the agent present, under time pressure, or when judging whether the agent's answer
is right — i.e., exactly the situations where he needs internalized structure to sanity-check output or
act independently. The mechanism (expectation of availability suppresses encoding, not just retrieval)
means the failure is invisible until the moment the aid is gone — which maps directly onto "understanding
debt" surfacing only when something breaks.

Sources: [Risko & Gilbert 2016 PDF](https://samgilbert.net/pubs/Risko2016TiCS.pdf), [ScienceDirect abstract](https://www.sciencedirect.com/science/article/abs/pii/S1364661316300985), [PubMed](https://pubmed.ncbi.nlm.nih.gov/27542527/)

---

## 4. The "Google effect" (Sparrow, Liu & Wegner, 2011, *Science* 333: 776–778) and replication status

**Finding.** Four experiments found that (a) difficult trivia questions prime thoughts of computers
(Stroop interference on tech-related words), (b) expecting future access to information *reduces* recall
of the information itself while *improving* recall of where to find it, and (c) people are better at
remembering the file location of saved information than the information's content. Popularly summarized
as "the internet as external/transactive memory" — an empirical instance of offloading applied to search.

**Replication status — genuinely mixed, not clean.** A direct replication attempt of the "Google Stroop
effect" component (PeerJ, Camerer-style replication) found **no conclusive evidence** for that specific
sub-effect. This tracks with the broader 2015–2018 replication crisis pattern in social psychology
(Camerer et al.'s Nature/Science replication project recovered only ~62% of effects, at roughly half the
original effect size). However, a 2024 meta-analysis in *Frontiers in Public Health* pooling 35 studies
across 22 articles found the broader "Google effect" on memory is real but **moderated**: stronger for
people with a smaller existing knowledge base, more pronounced on mobile than desktop, and tied to
cognitive load and self-esteem about one's own memory. So: the original *specific* Stroop-priming result
looks fragile; the *general* phenomenon (reduced recall of retrievable content, moderated by expertise and
device) has more support across a wider literature.

**Evidence strength:** Possible-to-Likely for the general phenomenon; the original 2011 paper's specific
mechanism (Stroop priming) should be treated with lowered confidence given a direct non-replication.

**Implication:** The critical qualifier from the meta-analysis — effect is *weaker for people with a
larger existing knowledge base* — is the single most decision-relevant fact in this whole brief for
Tejas. It says offloading-induced forgetting is not a fixed cost; it is worse for novices and mitigated
by prior expertise. That argues for front-loading his own understanding of a domain (even shallowly)
*before* relying on agents in it, because the size of his own knowledge base determines how much the
Google/agent effect will erode what could have stuck.

Sources: [Sparrow et al. 2011 PDF](https://dtg.sites.fas.harvard.edu/DANWEGNER/pub/Sparrow%20et%20al.%202011.pdf), [Google effect — Wikipedia](https://en.wikipedia.org/wiki/Google_effect), [PeerJ replication (no effect found)](https://peerj.com/articles/10325/), [2024 meta-analysis — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10830778/), [Camerer et al. 2018 replication project — Nature Human Behaviour](https://www.nature.com/articles/s41562-018-0399-z)

---

## 5. Generation effect (Slamecka & Graf, 1978) and testing effect (Roediger & Karpicke, 2006)

**Generation effect finding.** Slamecka & Graf, *JEP: Human Learning & Memory* 4(6): 592–604 — across
five experiments, words a subject *generated themselves* (given a rule and a fragment, e.g. antonym of
"hot" + first letter "c___") were recalled/recognized far better than words merely read. The effect held
across generation rules (synonym, antonym, rhyme, category) and recall methods. Notably, the authors say
they had no prior hypothesis — the effect emerged empirically.

**Testing effect finding.** Roediger & Karpicke, *Psychological Science* 17(3), 2006 (and companion
*Perspectives on Psychological Science* review same year) — students who took repeated recall tests on
studied material outperformed students who simply re-read/re-studied the same material on delayed tests
(2 days to 1 week later), even though re-studying looked *better* on immediate tests. The core finding:
retrieval practice is not just an assessment of learning, it is itself a more powerful learning event than
additional exposure — and this reverses on a lag, meaning short-term performance is actively misleading
about long-term retention.

**Evidence strength:** Confirmed for both — these are among the most replicated findings in cognitive
psychology, forming the basis of "retrieval practice" as an educational recommendation (a decade-plus of
follow-up work, e.g. Karpicke & Roediger 2007 on repeated retrieval).

**Implication:** This is the strongest empirical lever available for the "make internalization happen"
half of the synthesis question. It says: the way to make something stick is not to be shown the answer
(reading an agent's explanation) but to be made to *produce* it — even partially, even by attempting
recall before it's revealed and getting corrective feedback. It also gives a testable warning sign: if
Tejas's *immediate* comprehension of an agent's explanation feels smooth and complete, that is exactly the
condition (like re-reading) associated with retention that evaporates — smooth-now is not a proxy for
durable-later.

Sources: [Roediger & Karpicke 2006 PDF](http://psychnet.wustl.edu/memory/wp-content/uploads/2018/04/Roediger-Karpicke-2006_PPS.pdf), [Test-Enhanced Learning — SAGE](https://journals.sagepub.com/doi/10.1111/j.1467-9280.2006.01693.x), [Slamecka & Graf notes](https://notes.andymatuschak.org/zWvCEwYz4Uv1dMHXynq3H5w), [Repeated retrieval — Karpicke & Roediger 2007 PDF](https://learninglab.psych.purdue.edu/downloads/2007/2007_Karpicke_Roediger_JML.pdf)

---

## 6. Desirable difficulties (Bjork, 1994 onward)

**Finding.** Robert Bjork's umbrella term for practice conditions that *slow down or worsen* performance
during learning but *improve* long-term retention and transfer: spacing sessions apart, interleaving
different problem types, varying conditions, and testing instead of re-reading. Theoretical mechanism (New
Theory of Disuse): memories have both *storage strength* (how well-learned, essentially permanent once
built) and *retrieval strength* (how currently accessible, volatile). Effortful, harder retrieval — done
successfully — builds storage strength more than easy, high-retrieval-strength access does. Critically,
Bjork stresses these difficulties are "desirable" only up to the point the learner can still succeed;
past that point they become simply difficult (undesirable), i.e. this is not "more friction is always
better."

**Evidence strength:** Confirmed as a well-supported synthesis (Bjork & Bjork have decades of studies
behind spacing, interleaving, and testing individually); the unifying "storage vs. retrieval strength"
theory is influential but is itself a theoretical model, somewhat less directly falsifiable than the
individual empirical effects it explains.

**Implication:** Directly actionable for system design: an agent explaining its own architecture to
Tejas in one smooth pass is the "easy" condition Bjork's theory predicts will not stick. Deliberately
inserting retrieval attempts (ask him to predict/explain before revealing), spacing (revisit an
architecture explanation later rather than only once), and interleaving (mixing review of different
subsystems) should all improve retention of the same information at the same information cost — this is
a lever with no added information overhead, only added friction of the *right kind*.

Sources: [Bjork & Bjork — Introducing Desirable Difficulties (UNH)](https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-introducing-desirable-difficulties-into-practice-and-instruction-bjork-and-bjork.pdf), [Desirable Difficulties — Structural Learning](https://www.structural-learning.com/post/desirable-difficulties)

---

## 7. Illusion of explanatory depth (Rozenblit & Keil, 2002, *Cognitive Science* 26: 521–562)

**Finding.** People rate their understanding of how everyday mechanisms work (zippers, toilets, sewing
machines, cylinder locks) as much higher *before* attempting to write a step-by-step causal explanation
than *after* — the act of trying to explain collapses the confidence. The illusion is specific to
*explanatory* knowledge (causal, mechanistic "how/why") — it is much weaker or absent for facts, procedures,
narratives, and even for one's own beliefs/preferences (which people know accurately). Mechanism proposed:
people conflate a *recognition-based* familiarity ("I've seen this, I could identify it") with generative,
mechanistic understanding, because in everyday life we rarely have to produce the mechanistic explanation
and get corrective feedback.

**Evidence strength:** Confirmed and widely replicated; a notable extension (Alter et al., construal-level
account) refines *when* the illusion is strongest (concrete/near constructs vs abstract), but the core
pre/post explanation confidence-drop effect itself is robust.

**Implication:** This is the direct, empirically-validated diagnostic tool for "understanding debt": you
cannot self-report your way to knowing whether you understand a system — you have to actually try to
explain its mechanism step-by-step and watch your own confidence collapse (or not) as the test. This maps
onto agent-built systems precisely: skimming an agent's summary produces recognition-level familiarity
("yes, that sounds right, I've seen those words") that is exactly the false signal Rozenblit & Keil show
people mistake for real understanding. The only validated countermeasure the literature offers is forcing
generation of the explanation, not re-reading it.

Sources: [Rozenblit & Keil 2002 abstract](https://onlinelibrary.wiley.com/doi/abs/10.1207/s15516709cog2605_1), [Illusion of explanatory depth — Wikipedia](https://en.wikipedia.org/wiki/Illusion_of_explanatory_depth), [Edge.org piece by Rozenblit/Keil](https://www.edge.org/response-detail/27117), [Construal-level account — Alter et al. PDF](https://pages.stern.nyu.edu/~aalter/jpspioed.pdf)

---

## 8. Automation complacency and skill decay (Bainbridge 1983; Parasuraman & Manzey 2010)

**Bainbridge, "Ironies of Automation" (*Automatica* 19(6), 1983).** Central irony: automating the routine
parts of a job leaves the human operator with (a) monitoring duty — which humans are poor at sustaining —
and (b) responsibility for the rare, hard cases automation *can't* handle, precisely the cases requiring
the *most* skill and situational understanding, at the moment the operator has had the *least* recent
practice. A second irony: because the operator practices the underlying skill less, by the time they must
intervene, their skill has decayed relative to what the situation demands — automation doesn't reduce the
need for expertise, it relocates and defers it to rarer, higher-stakes moments while eroding the very
practice that built it.

**Parasuraman & Manzey, "Complacency and Bias in Human Use of Automation" (*Human Factors* 52(3), 2010).**
Meta-review integrating decades of empirical studies. Key findings: automation complacency (reduced
monitoring of automated systems) reliably occurs under multi-task load, when a manual task competes with
overseeing the automated one for attention — and occurs in *both* novice and expert operators. Automation
bias (over-relying on automated recommendations, including making errors of omission and commission when
the aid is subtly wrong) likewise occurs in experts, and critically: **neither complacency nor automation
bias is reliably prevented by simple practice, training, or explicit instruction to be vigilant** — these
are structural, attentional phenomena, not knowledge gaps that more warning labels fix.

**Evidence strength:** Confirmed. Bainbridge is a canonical, heavily cited theoretical/observational
paper from aviation/industrial-control human factors; Parasuraman & Manzey is a systematic empirical
review (1000+ citations) whose central claim — that training/instruction alone doesn't fix complacency
or automation bias — is unusually strong and specific for this literature.

**Implication:** This is a load-bearing and somewhat sobering finding for the whole brief: telling Tejas
"just pay closer attention when it matters" is exactly the intervention this literature shows does *not*
work. The system-level fix has to be structural — e.g., forcing an active, deliberate checkpoint (not
optional vigilance) at defined moments, and — per Bainbridge — deliberately preserving practice
opportunities on the skill that would otherwise decay, *before* an emergency forces reliance on
unpracticed judgment. This is also a direct empirical argument against pure delegation as a stable
long-term strategy for anything Tejas may someday need to catch failing silently.

Sources: [Bainbridge 1983 PDF](https://ckrybus.com/static/papers/Bainbridge_1983_Automatica.pdf), [Ironies of Automation — Wikipedia](https://en.wikipedia.org/wiki/Ironies_of_Automation), [Parasuraman & Manzey 2010 — SAGE](https://journals.sagepub.com/doi/10.1177/0018720810376055), [PubMed abstract](https://pubmed.ncbi.nlm.nih.gov/21077562/)

---

## 9. Recent AI-assistance-and-learning studies (2024–2026)

### Bastani, Bastani, Sungu et al., "Generative AI Without Guardrails Can Harm Learning" (*PNAS* 2025;
preprint 2024)
**Finding.** Field RCT, ~1,000 Turkish high-school students, math practice with GPT-4 access. Two AI
conditions: unrestricted "GPT Base" (behaves like plain ChatGPT) vs. "GPT Tutor" (prompted to give hints,
not answers). During practice-with-access: GPT Base improved scores 48%, GPT Tutor 127%. **The reversal**:
once AI access was removed, GPT Base students scored **17% worse** than students who never had AI access
at all — net negative relative to no intervention. GPT Tutor's guardrails largely protected against this;
students used AI as a crutch (submitting problem statements verbatim for solutions) far more under
unrestricted access.

**Evidence strength:** Confirmed — pre-registered field RCT with a large N, a real behavioral mechanism
(verbatim answer-copying), and a dose-response-style comparison across two AI designs isolating the
guardrail as the causal lever.

### MIT Media Lab, "Your Brain on ChatGPT" (2025, revised Dec 2025)
**Finding.** 54 participants, 3 groups (LLM / search engine / brain-only) wrote SAT-style essays across 4
sessions with 32-channel EEG, plus a crossover session. ChatGPT users showed the weakest neural
connectivity across memory/attention/executive networks, lowest sense of ownership of their own writing,
and impaired recall of what they'd just written — effects that *persisted* into a later unaided session
("cognitive debt": short-term effort savings, longer-term costs to critical thinking, reduced creativity
and independent thought, and increased vulnerability to bias in the delivered content).

**Evidence strength:** Possible-to-Likely, not Confirmed — small N (18 per group), essay-writing is a
narrow task domain, EEG connectivity measures are a step removed from directly validated cognitive
outcomes, and (per the authors' own caveat) the study cannot be generalized beyond ChatGPT/this task to
other models or domains. Directionally consistent with Bastani et al. and the older offloading literature,
which raises confidence in the *pattern* even though this specific study alone is modest evidence.

### Anthropic, "How AI assistance impacts the formation of coding skills" (Jan/Feb 2026)
**Finding.** RCT, 52 mostly-junior engineers, 1+ year Python experience, learning an unfamiliar library
(Trio) with vs. without an AI coding assistant. Assessed via quiz on debugging, code reading, code
writing, and conceptual understanding, shortly after the coding task. AI group scored **50% vs. 67%** for
the manual group (Cohen's d = 0.74, p = 0.01 — a large, "nearly two letter grades" effect), with the
*largest* gap on debugging questions specifically. Speed gain for the AI group (~2 min) was **not**
statistically significant — meaning in this study, AI assistance cost comprehension without a proven
productivity win. Critically, the paper distinguishes *how* AI was used: participants who used it to
generate-then-request-explanation, or asked conceptual/follow-up questions, scored well; participants who
delegated code generation/debugging outright scored worst. Authors' own limitations: small sample,
measured comprehension shortly after the task (long-term retention unverified), doesn't establish causal
interaction-pattern mechanisms, and explicitly says this is about *learners* forming skill, not necessarily
about experienced developers using AI in a domain they've already mastered.

**Evidence strength:** Likely — a real RCT with a clear, large, statistically significant effect and an
identified behavioral moderator (usage pattern), but self-described as preliminary (small N, short
follow-up window, one library/domain).

**Implication (all three studies together):** These are the most directly relevant empirical evidence for
Tejas's actual situation (agents building things for him) available as of this writing, and they converge
on the same structural finding as Bastani/Anthropic: the *harm is not inherent to AI assistance* — it is
specifically caused by the *unguarded, generation-only mode of use* (take the answer, don't engage). All
three studies find that use patterns involving active question-asking, explanation-seeking, or delayed/
guarded reveal are protective or neutral, while direct delegation-and-accept is what produces the
measurable comprehension/skill deficit. This is a strong, converging, mechanistic answer to "how do you
use agents without eroding understanding": the guardrail is not *whether* you use the agent, it's whether
the interaction includes a forced or voluntary generation/explanation step before you accept the output.

Sources: [Bastani et al. — PNAS](https://www.pnas.org/doi/10.1073/pnas.2422633122), [Wharton summary](https://knowledge.wharton.upenn.edu/article/without-guardrails-generative-ai-can-harm-education/), [MIT Media Lab project page](https://www.media.mit.edu/projects/your-brain-on-chatgpt/overview/), [Your Brain on ChatGPT — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12723506/), [Anthropic — How AI assistance impacts the formation of coding skills](https://www.anthropic.com/research/AI-assistance-coding-skills), [devclass coverage](https://www.devclass.com/ai-ml/2026/02/02/anthropic-research-skilled-devs-make-better-use-of-ai-but-using-ai-is-bad-for-learning-skills/4079561)

---

## 10. Comprehension debt / "understanding debt" in AI-written codebases

**Finding.** Not an academic term (no controlled study defines it) but an increasingly common industry
term (Addy Osmani, ~March 2026; related "cognitive debt" coinage by Margaret-Anne Storey, Feb 2026;
O'Reilly Radar coverage). Defined as the growing gap between how much code/system exists and how much of
it any human genuinely understands. Distinguished from classic technical debt (which announces itself via
friction — slow builds, brittle code) by being *invisible until it breaks*: it produces false confidence
because AI-generated code can look clean and pass tests while nobody involved could explain *why* a
design choice was made. Cited (unverified, industry-reported, not peer-reviewed) statistics: developer
trust in AI-generated code accuracy fell from ~40% (2024) to ~29% (2025) even as adoption rose past 84%,
and production incidents per pull request reportedly rose ~23.5%.

**Evidence strength:** Unknown/Possible for the term and framework itself (coherent, resonates with the
peer-reviewed literature above, but not independently validated); the cited statistics are industry-survey
figures, not peer-reviewed data, and should be treated as directional claims, not established facts.

**Implication:** This is essentially "understanding debt operationalized for the specific case Tejas is
in" — and its recommended countermeasures (treat genuine understanding as non-negotiable, not just
"tests passed"; use AI for conceptual inquiry rather than passive delegation; maintain system-level mental
models explicitly) are the same shape as what the peer-reviewed generation-effect/testing-effect and
Anthropic-study evidence supports, just applied to codebases. The "tests passed ≠ I understand this" framing
is a good practical proxy for the illusion-of-explanatory-depth trap in software specifically.

Sources: [Addy Osmani — Comprehension Debt](https://addyosmani.com/blog/comprehension-debt/), [O'Reilly Radar](https://www.oreilly.com/radar/comprehension-debt-the-hidden-cost-of-ai-generated-code/)

---

## 11. Situational awareness (Endsley) — levels 1–3

**Finding.** Endsley's model (*Human Factors* 37(1), 1995, "Toward a Theory of Situation Awareness in
Dynamic Systems") defines three hierarchical levels an operator (e.g., a pilot, controller, or — by
extension — a supervisor of agents) needs, in order:
- **Level 1 — Perception:** noticing the relevant elements exist and their current state (what changed,
  what happened, what's true right now).
- **Level 2 — Comprehension:** integrating Level-1 elements with existing knowledge into a holistic
  understanding — what it *means*, how pieces relate, why it matters relative to goals.
- **Level 3 — Projection:** using Levels 1–2 plus knowledge of dynamics to forecast future states —
  what will happen next, what could go wrong, what to do about it *before* it happens.
Failure to reach a lower level caps the levels above it — you cannot comprehend what you never perceived,
and cannot project from a comprehension you don't have.

**Evidence strength:** Confirmed as an influential, widely-adopted applied model in aviation/human factors
(originally validated via pilot studies and operationally used across ATC, military C2, and healthcare); it
is a descriptive/organizing framework more than a single falsifiable hypothesis, but its component claims
(SA level predicts task performance, SA levels are hierarchically dependent) have substantial applied
validation literature behind them.

**Implication:** This gives the brief's synthesis its most directly reusable vocabulary. Applied to
agent-built systems: Level 1 (perceiving *that* something changed/was built) is cheap and does not need to
be internalized by Tejas — it can live entirely in the medium (commit logs, changelogs, notices). Level 2
(comprehension — how the pieces relate, what invariant is being preserved, why a design choice was made)
is the level that must be *his*, because Level 3 projection (what will break, what to be alert to, what
decision to make next) is impossible without it. This maps almost exactly onto the target rule the brief
is asking for.

Sources: [Endsley 1995 — ResearchGate](https://www.researchgate.net/publication/210198492_Endsley_MR_Toward_a_Theory_of_Situation_Awareness_in_Dynamic_Systems_Human_Factors_Journal_371_32-64), [Comprehensive review of SA theory](https://medium.com/prompt-engineering/a-comprehensive-review-of-situational-awareness-theory-application-measurement-and-future-6c6980f6da94)

---

## 12. Chunking and expertise (Chase & Simon, 1973) and deliberate practice / mental representations (Ericsson)

**Chase & Simon, "Perception in Chess" (*Cognitive Psychology* 4, 1973).** Chess masters can reconstruct
a mid-game board almost perfectly after 5 seconds' viewing; novices cannot. But this advantage
**disappears entirely for random (non-game-legal) piece arrangements** — masters do no better than
novices on random boards. This isolates the mechanism: masters aren't storing more raw positions in
short-term memory (they have the same severe STM limits as anyone), they have internalized thousands of
recurring *chunks* — meaningful sub-patterns — in long-term memory, so a "board" is perceived as a small
number of familiar chunks rather than 20+ independent pieces. Expertise is compression via structure, not
expanded raw capacity.

**Ericsson (deliberate practice; "Peak" with Pool, 2016; decades of prior journal work).** Extends the
chunking finding into a general theory: what separates experts is the quality and quantity of *mental
representations* — structured, retrievable, situation-linked knowledge structures that let an expert
recognize patterns and generate near-instant, accurate responses others must reason out slowly. Deliberate
practice (focused, feedback-driven, pushing just past current ability) is theorized as the mechanism that
builds these representations over time; skill breaks down and rebuilds representations component by
component rather than accumulating isolated facts.

**Evidence strength:** Confirmed for Chase & Simon (a landmark, extensively replicated finding, though the
precise nature/size of "chunks" has been revisited and refined by later work, e.g. Gobet & Simon's "template
theory"); Likely for the general deliberate-practice/mental-representation theory (well-supported for
domains with objective performance ladders — chess, music, sport — more contested for domains lacking such
clear feedback, per the "10,000 hours" controversy literature).

**Implication:** This is the clearest empirical support for "internalize structure, not details" as
literally how expertise works, not just as a good-sounding heuristic. What an expert holds in memory is
not more raw facts but better-compressed relational structure — which is exactly what "the invariants,
decisions, and reasoning, not the details" (Level 2 SA) would look like if it worked. It also implies a
concrete test: can Tejas recognize a *recurring pattern* across different agent-built systems (the way a
master recognizes a chess motif across different boards), or does every new system feel equally
unfamiliar? The latter would indicate chunks aren't forming — i.e., exposure without structure-building.

Sources: [Chase & Simon 1973 PDF](https://andymatuschak.org/prompts/Chase1973.pdf), [Chunking hypothesis revisited](https://www.tandfonline.com/doi/abs/10.1080/741942359), [Peak — Ericsson & Pool summary](https://notes.andymatuschak.org/Peak_-_Ericsson_and_Pool), [Deliberate practice overview — ScienceDirect](https://www.sciencedirect.com/topics/psychology/deliberate-practice)

---

## 13. Polanyi — tacit knowledge

**Finding.** Michael Polanyi (*Personal Knowledge*, 1958; *The Tacit Dimension*, 1966): "we can know more
than we can tell." All explicit knowledge is argued to rest on a substrate of tacit, largely inarticulable
knowing (recognizing a face, riding a bike, diagnosing by feel) that cannot be fully captured in rules or
documentation — "a wholly explicit knowledge is unthinkable." Personal, embodied skill (active
comprehension requiring practice) is foundational, not incidental, to expertise.

**Evidence strength:** Confirmed as an influential epistemological argument (not an empirical study);
its core claim — that some real expertise resists full explicit codification — is broadly accepted across
philosophy of science, expertise research, and knowledge management, though it is a conceptual thesis, not
a falsifiable experimental result.

**Implication:** This is the counterweight to the idea that "write it all down in a doc and Tejas can read
it later" fully substitutes for internalization. Polanyi's claim implies some understanding of a system —
especially judgment calls, "this smells wrong," recognizing which agent behavior is normal vs. a red flag
— can only be built through his own repeated, embodied engagement (making decisions, being wrong,
correcting), not by reading an agent's written explanation, however good. This bounds how far "put it in
the medium, not in his head" can go: documentation captures explicit knowledge; it structurally cannot
transmit the tacit judgment layer on top of it.

Sources: [Tacit knowledge — Wikipedia](https://en.wikipedia.org/wiki/Tacit_knowledge), [Polanyi's paradox — Wikipedia](https://en.wikipedia.org/wiki/Polanyi%27s_paradox)

---

## Synthesis

**The rule.** Internalize *structure* — invariants, the decisions made and why, the failure modes and
their signatures, and the mental model that lets you predict what a change will do — and let the medium
(docs, commit logs, agents' own memory, retrieval) hold *details* — the specific values, the literal code,
the retrievable facts you can look up faster than you can recall. This is not a new idea invented for this
brief: it is the same line Endsley's SA levels draw (internalize Level 2 comprehension and enough
Level 3 projection to act; Level 1 perception can be re-fetched on demand), the same line Chase &
Simon/Ericsson describe as what expertise actually is (compressed relational structure, not stored raw
data), and the same line the extended-mind critiques draw around Otto's notebook (the parity condition —
constant availability and the ability to notice when it's wrong — is met for lookups, not for judgment).
Concretely, for an agent-built system: internalize *why* a design exists, what invariant it protects, what
"broken" looks like, and what would make you distrust its output. Let the agent and the docs hold the
exact file paths, the literal function signatures, the day-to-day execution.

**How to make internalization actually happen (not just intend it).** Good intentions to "understand it
later" don't survive contact with a fast-moving agent workflow — this is the whole reason the golden rule
in this codebase's own instructions insists on systems over intentions, and the learning-science evidence
says the same thing about individual cognition:
1. **Retrieval before reveal.** Per the testing/generation effect (Roediger & Karpicke 2006; Slamecka &
   Graf 1978) and Bjork's desirable difficulties, the highest-leverage moment is *before* reading an
   agent's explanation: attempt to predict or explain it first, even briefly and even wrongly, then
   compare. This single ordering change is free in information cost and has among the largest,
   most-replicated effect sizes in this brief.
2. **Force generation of the explanation, not consumption of it.** Per the illusion of explanatory depth
   (Rozenblit & Keil 2002), skimming an agent's summary produces recognition-level false confidence that
   feels identical to real understanding until tested. The validated test is: can Tejas explain the
   mechanism (not just gist) unprompted? If not, the "I understand this" belief is likely illusory,
   regardless of how fluent the agent's explanation was.
3. **Guard the interaction pattern, not the tool.** Per Bastani et al. 2025, MIT 2025, and Anthropic 2026 —
   all three studies independently found the harm is concentrated in *pure delegation* (accept output
   without engaging) and is mitigated or absent when the interaction includes follow-up questions,
   requested explanations, or a guardrail delaying the full answer. The actionable version: agents should
   default to a "hint/explain-then-confirm" mode for anything in the "must internalize" category, not a
   "here's the finished answer" mode.
4. **Space and interleave revisits**, not one-shot exposure (Bjork) — a single walkthrough of an
   architecture, however thorough, is the "easy re-study" condition associated with retention that
   evaporates; revisiting later and across different systems is what builds durable, transferable chunks
   (Chase & Simon; Ericsson).
5. **Structural checkpoints beat vigilance.** Per Parasuraman & Manzey 2010, telling yourself to "watch
   more carefully" for automation errors does not work, in experts or novices, and is not fixed by
   training. The fix has to be a forced, scheduled checkpoint (a review step that must happen, not a
   background awareness) — matching this codebase's own "systems, not good intentions" principle.

**How to detect "understanding debt."** Four converging, evidence-backed diagnostics from this brief,
in order of ease:
- **The explain-it-cold test** (Rozenblit & Keil): pick a system Tejas believes he understands and ask him
  to explain its mechanism/decision logic unprompted, without looking anything up. A confidence drop
  during the attempt is the debt surfacing safely, before it surfaces as a production incident.
- **The pattern-recognition test** (Chase & Simon): does a new agent-built system feel structurally
  familiar ("this is the same shape as X"), or does every one feel equally opaque? The latter indicates
  chunks aren't forming — exposure without internalized structure.
- **The unaided-recall test** (Google effect / offloading literature): can he recall or reconstruct
  something *without* the agent/doc present, under mild time pressure? Offloading-induced forgetting is
  invisible until the aid is unavailable — so periodically remove it on purpose, in a low-stakes setting,
  rather than discovering the gap during an outage.
- **The "tests passed" trap** (comprehension debt framing): treat "it works and the tests are green" as
  categorically different from "I understand why it works" — the former is necessary but has zero
  correlation with the latter in the AI-assistance studies above.

**Confidence summary.** High confidence: cognitive offloading review, testing/generation effect,
illusion of explanatory depth, automation complacency, Chase & Simon chunking, Endsley SA model, Anthropic
2026 coding-skill RCT, Bastani et al. 2025 PNAS study — these rest on replicated experiments or
large/pre-registered studies with clear mechanisms. Medium confidence: Google effect general phenomenon
(real but moderated, original Stroop mechanism specifically weakened by non-replication), MIT "Your Brain
on ChatGPT" (suggestive, small-N, single-task, authors' own caveats), Ericsson's deliberate-practice theory
as a general causal account (strong in some domains, contested in others). Low confidence / not
independently verified: "comprehension debt" as a term and its cited industry statistics (coherent
framework, resonant with the peer-reviewed evidence, but sourced from blog posts/industry surveys, not
peer review). Philosophical, not empirical (treat as framework/vocabulary, not as tested claims): extended
mind thesis and its critiques, distributed cognition, Polanyi's tacit knowledge.
