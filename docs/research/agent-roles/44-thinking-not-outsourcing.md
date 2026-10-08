# Thinking with AI, not outsourcing it — research brief

**Question:** In a human+AI design session, how does the human do the reading, understanding
and synthesis himself, with AI as help, so the ideas are actually his? Is talking with agents
enough, or does he have to read sources firsthand?

**Short answer up front:** Talking with agents is not enough on its own — the mechanism of
"understanding" in every literature reviewed here (self-explanation, generation, retrieval,
writing-to-learn, syntopical reading) requires the human to *produce* something (an
explanation, a written note, a prediction, a synthesis) *before* consuming the AI's version,
not just to read or converse. Conversation alone, where the AI states things and the human
receives them, is close to reading a summary — measured to produce a *feeling* of
understanding (fluency) more reliably than actual understanding. The research converges on
one design principle: **generation before exposure to the AI's answer.** Everything below
supports and specifies that.

Confidence markers used throughout: **Confirmed** (directly reported in the primary source),
**Likely** (well-supported inference from the source, or convergent secondary reporting),
**Possible** (single study, small N, or contested), **Unknown** (no evidence found).

---

## Part 1 — HCI research on critical thinking with generative AI

### 1.1 Lee, Sarkar, Tankelevitch et al., "The Impact of Generative AI on Critical Thinking" (Microsoft Research, CHI 2025)

**Finding.** Survey of 319 knowledge workers, 936 first-hand examples of GenAI use at work.
Higher **confidence in the AI** was associated with *less* self-reported critical thinking;
higher **self-confidence** was associated with *more*. When workers trusted the AI's output,
they shifted from *task execution* effort (doing the work) to *verification* effort (checking
the AI's work) — and when trust was high, they often skipped verification too. Knowledge
workers described critical thinking as most often triggered by three things: unfamiliarity
with the domain, high stakes, and awareness that the AI can be wrong.

**Evidence strength.** Likely. Large-N, but self-reported (not observed) critical thinking,
single company's knowledge workers, cross-sectional. Confidence-driven mechanism is a
correlational finding, not causal, though it is consistent with automation-complacency
research more broadly.

**Concrete practice.** Track and *lower artificial confidence in the tool*: have the AI
attach explicit uncertainty ("this is my read of source X, I have not cross-checked Y") rather
than a flat, confident synthesis — confident-sounding output is exactly what the paper shows
suppresses critical engagement. Route this into the "AI never states its own synthesis until
asked" rule below.

Source: [Microsoft Research PDF](https://www.microsoft.com/en-us/research/wp-content/uploads/2025/01/lee_2025_ai_critical_thinking_survey.pdf), [publication page](https://www.microsoft.com/en-us/research/publication/the-impact-of-generative-ai-on-critical-thinking-self-reported-reductions-in-cognitive-effort-and-confidence-effects-from-a-survey-of-knowledge-workers/).

### 1.2 Tankelevitch, Kewenig, Simkute et al., "The Metacognitive Demands and Opportunities of Generative AI" (CHI 2024)

**Finding.** Frames GenAI use as a metacognitive task: the human must (a) decide *when* to
delegate, (b) *evaluate* AI output for correctness/relevance, and (c) *calibrate* how much to
rely on it — and current tools make all three demanding because output looks fluent and
plausible regardless of correctness ("plausible ≠ correct" is the core usability problem).
Recommends systems that reduce metacognitive load through explainability/customizability, or
— the opposite design choice, which this brief is built around — systems that deliberately
*increase* metacognitive engagement at the moments understanding matters.

**Evidence strength.** Likely. Conceptual/synthesis paper (not an experiment) but widely cited
and grounded in prior metacognition literature (Flavell, Nelson & Narens).

**Concrete practice.** Before the AI answers a design question, have it ask the human to state
(a) how confident he is in his own guess and (b) what would change his mind — this is the
"calibration" step Tankelevitch et al. identify as usually skipped.

Sources: [arXiv:2312.10893](https://arxiv.org/abs/2312.10893), [ACM DL](https://dl.acm.org/doi/fullHtml/10.1145/3613904.3642902).

### 1.3 Sarkar, "AI Should Challenge, Not Obey" (Communications of the ACM, Oct 2024)

**Finding.** Argues for the "AI provocateur": instead of an assistant that completes tasks
on command, an AI that *critiques* the human's work, surfaces weak arguments, and asks
questions — "not a tool of work, but a tool of thought." Explicitly contrasts this with the
dominant obedient-assistant paradigm, which optimizes for immediate task completion at the
cost of the human's own reasoning.

**Evidence strength.** Likely as argument/vision piece from a senior HCI researcher at
Microsoft Research (same group as 1.1/1.2); not itself an experiment, but it is the design
philosophy that the group's own later experiment (1.5, "provocations") tested and found
partial support for.

**Concrete practice.** Give the AI an explicit standing instruction in the design session:
default mode is questions and counter-examples, not answers; it only produces its own
proposed synthesis/design when the human explicitly asks for it (see Part 5).

Sources: [arXiv:2411.02263](https://arxiv.org/abs/2411.02263), [CACM](https://cacm.acm.org/opinion/ai-should-challenge-not-obey/).

### 1.4 Buçinca, Malaya & Gajos, "To Trust or to Think: Cognitive Forcing Functions..." (CSCW/CHI 2021)

**Finding.** Two controlled experiments (N=264, N=210) on AI-assisted decision tasks. Full
explanations of AI recommendations *increased* overreliance (people anchor on a fluent
justification and stop thinking). **"Cognitive forcing functions"** — interventions that make
the human commit to their own answer *before* seeing the AI's suggestion, or that force a
brief delay/deliberate step — significantly reduced overreliance and improved decision
accuracy, more than explanations alone. Effect was moderated by Need for Cognition (people
already disposed to effortful thinking benefited more).

**Evidence strength.** Confirmed — controlled experiment, replicated across two task domains,
peer-reviewed, widely cited as the origin of "cognitive forcing" in HCI.

**Concrete practice.** This is the single most actionable, causally-tested mechanism in the
whole brief: **structurally require the human to commit to an answer/hypothesis before the AI
reveals its own.** Not a suggestion — a forcing function, e.g. the AI literally withholds its
answer until the human's is recorded.

Sources: [arXiv:2102.09692](https://arxiv.org/abs/2102.09692), [Harvard EECS PDF](https://www.eecs.harvard.edu/~kgajos/papers/2021/bucinca21trust.pdf), [follow-up CSCW 2025 paper on partial explanations](https://dl.acm.org/doi/10.1145/3710946) (partial explanations land between full-explanation overreliance and cognitive-forcing engagement).

### 1.5 Drosos, Sarkar, Xu & Toronto, "'It Makes You Think': Provocations Help Restore Critical Thinking to AI-Assisted Knowledge Work" (2025)

**Finding.** Between-subjects study, N=24, AI-assisted shortlisting task. AI-generated
**"provocations"** (short critiques of the AI's own suggestion + alternative framings) measurably
increased critical/metacognitive engagement vs. plain AI assistance. But effect depended on
five moderators: task urgency, task importance, user expertise, provocation actionability, and
user's felt sense of responsibility for the outcome — provocations helped most when the human
felt *accountable* for the result and least when task urgency was high (people skip them under
time pressure).

**Evidence strength.** Possible→Likely. Small N (24), single task type, same research group as
1.1–1.3 (convergent internal validity, not independent replication), but it is the direct
experimental test of Sarkar's 2024 "provocateur" proposal and the mechanism generalizes to
Buçinca's cognitive-forcing result.

**Concrete practice.** Provocations only work if the human feels ownership/stakes in the
outcome and isn't rushed — so a design session run "as fast as possible with AI doing the
synthesis" is exactly the condition under which this literature says critical engagement
collapses. Budget time for provocations to land; don't run design-under-deadline and expect
the AI's challenges to be taken seriously.

Sources: [arXiv:2501.17247](https://arxiv.org/abs/2501.17247).

### 1.6 Bastani, Bastani, Sungu, Ge, Kabakcı & Mariman, "Generative AI without guardrails can harm learning" (PNAS 2025)

**Finding.** Field experiment, ~1,000 high-school students, two AI tutor variants: "GPT Base"
(plain ChatGPT-like access) vs. "GPT Tutor" (guardrailed — has the correct answer, gives hints
not solutions, structured to scaffold rather than complete). Both improved *in-session* practice
performance (48% and 127% respectively vs. no-AI). But when AI access was removed for a later
unassisted test, the **Base group performed *worse*** than a no-AI control (used AI as a
crutch, didn't learn the underlying skill), while the guardrailed **Tutor group's unassisted
performance held up** — the hint-based design prevented the skill-substitution effect.

**Evidence strength.** Confirmed. Large field RCT, published in PNAS, pre-registered
guardrail design, clean before/after-AI-removed comparison — one of the strongest causal
results in this brief.

**Concrete practice.** Directly transfers to design sessions: an AI that gives *hints, critique,
and partial structure* (what to check, what's missing, what contradicts what) protects the
human's own skill; an AI that gives finished answers on demand degrades it, even while making
the immediate session feel more productive. This is quantitative confirmation of the
Sarkar/Buçinca "don't just answer" principle, in a different domain (math tutoring, not
knowledge work), with the added finding that the *effect is invisible in the moment* — you
only see the damage once the AI is taken away, i.e. once you have to think without it.

Sources: [PNAS](https://www.pnas.org/doi/10.1073/pnas.2422633122), [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12232635/).

### 1.7 Anthropic, coding-skill formation study (Jan 2026)

**Finding.** RCT, 52 junior engineers learning an unfamiliar Python library (Trio), with/without
AI coding assistance, then a comprehension quiz. AI-access group averaged 50% on the quiz vs.
67% for the hand-coding group (reported as a ~17-percentage-point / "17%" gap across secondary
write-ups — note: this is the study's own headline framing, not independently replicated
elsewhere yet). Within the AI-access group, interaction *pattern* mattered far more than access
itself:
- **Low scorers (<40%)**: fully delegated to AI, or started independently and progressively
  handed more off, or used AI only to fix errors without building a model of why.
- **High scorers (≥65%)**: stayed cognitively engaged — generated code then interrogated it
  ("why did you do X"), or asked conceptual questions first and coded independently afterward,
  troubleshooting their own errors rather than asking AI to fix them.

**Evidence strength.** Likely. Controlled and randomized, but N=52, single skill domain
(a Python library), self-reported secondary coverage (I found trade/industry summaries, not
the primary Anthropic paper text directly — flag: I have not verified the primary PDF
[arXiv:2601.20245] loads correctly; treat exact percentages as reported-by-secondary-sources
until the primary is directly read).

**Concrete practice.** This is the closest available analogue to "AI did the reading, synthesis
and design and I suspect I outsourced my thinking" — same shape of problem, different domain.
The dividing line between the low- and high-scoring patterns is almost exactly the "generate →
interrogate" vs "delegate → accept" split. Practice: after the AI produces anything (a summary,
a design option, code), the human's next move must be a question that requires him to have a
model of it ("why does this follow", "what would break this"), not silent acceptance or an
edit request.

Sources: [ITPro coverage](https://www.itpro.com/software/development/anthropic-research-ai-coding-skills-formation-impact), [primary arXiv (unverified load)](https://www.arxiv.org/pdf/2601.20245).

### 1.8 AI co-writing, ownership, and the "AI ghostwriter effect"

**Finding.** Multiple 2024–2025 studies converge: (a) people feel more ownership over AI-assisted
output when they were *actively engaged* in producing it, and less when they used commercial
LLMs passively; (b) the "AI ghostwriter effect" — people are *less* likely to disclose AI's
role in writing than they would disclose a human collaborator's, even when they don't consider
themselves the "author" of the AI-generated parts, i.e. a dissociation between felt authorship
and actual disclosure behavior; (c) ownership is not binary but a "spectrum" that shifts across
the creative process — highest when the human led framing/structure and lowest when AI
generated wholesale content the human merely accepted.

**Evidence strength.** Possible→Likely per individual study (CHI 2025 attribution study,
"80% me, 20% AI" authenticity study, "AI ghostwriter effect" paper) — consistent direction
across independent groups, but self-report of a subjective state (felt ownership), not an
objective test of understanding.

**Concrete practice.** Ownership tracks *who did the structuring/framing move*, not who typed
the words. In a design session: the human should own problem framing and the final
synthesis-in-his-own-words step even when AI drafted supporting material — that's the leverage
point for actually feeling (and, per the self-explanation literature below, actually having)
ownership.

Sources: [CHI 2025 attribution study](https://dl.acm.org/doi/full/10.1145/3706598.3713522), ["80% me, 20% AI"](https://arxiv.org/html/2411.13032), ["AI Ghostwriter Effect"](https://dl.acm.org/doi/pdf/10.1145/3637875), ["Who Owns the Text?"](https://arxiv.org/html/2601.10236).

---

## Part 2 — Learning science: which techniques actually build understanding

### 2.1 Dunlosky, Rawson, Marsh, Nathan & Willingham (2013), "Improving Students' Learning With Effective Learning Techniques" — the authoritative ranking

**Finding.** Systematic review of 10 common learning techniques across four generalizability
dimensions (learning conditions, student characteristics, materials, criterion tasks).
Ratings:
- **High utility:** practice testing (retrieval practice), distributed practice.
- **Moderate utility:** elaborative interrogation, self-explanation, interleaved practice.
- **Low utility:** summarization, highlighting/underlining, rereading, keyword mnemonic,
  imagery use for text.

**This directly answers "is a summary enough": no.** Summarization and rereading — the two
techniques structurally closest to "read what the AI already synthesized" — are rated **low
utility** specifically because their benefit depends heavily on skill (most people summarize
badly) and doesn't reliably transfer to comprehension/retention gains. Self-explanation and
elaborative interrogation — techniques that require the learner to *generate* explanations or
answer "why/how" questions in their own words — rate moderate, above summarization.

**Evidence strength.** Confirmed. The canonical review in this space (Psychological Science in
the Public Interest), extremely widely cited, itself a synthesis of hundreds of primary studies.

**Concrete practice.** Never let "the AI wrote a good summary" substitute for the human doing
retrieval practice (recalling the source's argument from memory, unaided) or elaborative
interrogation (asking "why is this true / why does the author believe this" and answering it
himself) on at least the load-bearing sources.

Sources: [SAGE](https://journals.sagepub.com/doi/10.1177/1529100612453266), [full PDF](https://iverson.cm.utexas.edu/courses/310M/Handouts/Dunlosky%20et%20al.%20-%202013%20-%20Improving%20Students%E2%80%99%20Learning%20With%20Effective%20Learni.pdf).

### 2.2 Self-explanation effect — Chi et al. 1989, 1994

**Finding.** 1989 (physics worked examples): students who *spontaneously* generated more
self-explanations while studying scored more than 2x higher on a post-test; their explanations
were more principle-based. 1994 (biology, circulatory system): when self-explanation was
*prompted* (not spontaneous) during reading, "high explainers" reliably built the correct
mental model; unprompted/low-explaining students often did not, even having read the identical
text. The mechanism is that generating an explanation forces integration of new material with
existing knowledge and exposes gaps (you notice what you can't explain).

**Evidence strength.** Confirmed — original controlled studies, foundational and replicated
widely since (the Feynman-technique write-ups below cite a 2021 meta-analysis of 64 reports,
effect size g=0.55, and 40 studies/4,000+ students showing self-explanation beats passive
study).

**Concrete practice.** Before reading the AI's synthesis of a source, the human explains the
source's core claim/mechanism out loud or in writing, from memory or from a first pass at the
raw text — and *then* compares to see what he missed. The comparison, not the AI's version
alone, is what's instructive.

Sources: [1994 Cognitive Science paper (via Matuschak's notes)](https://andymatuschak.org/files/papers/Chi%20et%20al%20-%201994%20-%20Eliciting%20self-explanations%20improves%20understanding.pdf), [Wiley](https://onlinelibrary.wiley.com/doi/10.1207/s15516709cog1803_3).

### 2.3 Generation effect, retrieval practice (testing effect), elaborative interrogation

**Finding.** Generation effect: information you produce yourself (even a guess) is remembered
better than information you merely read — because generation forces deeper/more elaborate
encoding. Testing effect: retrieval practice (recalling from memory, e.g. via self-testing)
produces more durable long-term learning than rereading, *despite feeling less successful in
the moment* — the felt difficulty is part of the mechanism (effortful retrieval builds more
retrieval paths). Elaborative interrogation ("why would this be true?") works best when the
learner already has relevant background knowledge to connect to — it has less benefit for
total novices with nothing to elaborate onto.

**Evidence strength.** Confirmed for generation and retrieval practice (large, well-replicated
literatures, both rated by Dunlosky et al. among the strongest-evidenced techniques for
retrieval practice specifically). Elaborative interrogation: Likely, moderate per Dunlosky.

**Concrete practice.** In a design session: after the AI (or the human, from a source) states a
design fact/constraint, the human generates the "why" himself before the AI is asked to
confirm/correct it. And: periodically closing the AI window and reconstructing the state of the
design from memory is a literal retrieval-practice intervention, not busywork.

Sources: [Testing effect overview](https://notes.andymatuschak.org/Testing_effect), [Elaborative Interrogation](https://en.cognitivepsychology.com/Elaborative_Interrogation).

### 2.4 Writing-to-learn — Bangert-Drowns et al. 2004 meta-analysis; Graham & Hebert 2011

**Finding.** Bangert-Drowns et al. (48 school-based writing-to-learn programs): small-to-medium
positive effect on academic achievement, effect size grows with (a) longer sustained exposure to
writing-to-learn and (b) tasks that require **metacognitive** writing (reflecting on one's own
understanding, not just recording it) — and grows further with feedback (effect size 0.32) plus
reflection on that feedback (0.44). Graham & Hebert (meta-analysis of true/quasi-experiments):
writing *about* material read improves comprehension of it; teaching students to write better
improves their reading comprehension/fluency; and simply writing *more* (quantity) also improves
reading comprehension. Directionally: writing causes better reading understanding, not just the
reverse.

**Evidence strength.** Confirmed for both — both are meta-analyses of experimental/quasi-
experimental studies in the peer-reviewed education literature (Review of Educational Research;
Harvard Educational Review).

**Concrete practice.** The human writes his own synthesis of a source (not just notes/highlights)
*and* periodically writes reflectively about how his understanding of the design is changing —
the metacognitive-writing moderator is specifically what should show up in a design journal
("I used to think X, now I think Y because...").

Sources: [Bangert-Drowns 2004](https://journals.sagepub.com/doi/10.3102/00346543074001029), [Graham & Hebert 2011 PDF](https://media.carnegie.org/filer_public/9d/e2/9de20604-a055-42da-bc00-77da949b29d7/ccny_report_2010_writing.pdf).

### 2.5 Protégé effect (learning by teaching)

**Finding.** Expecting to teach material (and actually doing so) produces deeper learning than
studying for a personal test: greater effort, more organized/synthesized cognitive structures,
more awareness of one's own gaps. A 2013 study found that people who *expected* to teach but
didn't were outperformed by those who expected to teach *and did* — the effect is in the act of
explaining to another mind, not just the anticipation.

**Evidence strength.** Likely — well-established educational psychology effect (going back to
1980s motivation studies), reinforced by newer "teachable agent"/LLM-teaching studies (2024–2025),
though those newer ones are smaller and more exploratory.

**Concrete practice.** Have the human explain the design, as if teaching it, to a third party —
which can literally be the AI, *if* the AI is instructed to play a genuinely uninformed student
that asks naive/probing questions rather than nodding along (an AI that just says "great
explanation!" defeats the mechanism; an AI that says "wait, why does that follow?" exercises it).

Sources: [Stanford teachable-agents paper](https://aaalab.stanford.edu/assets/papers/2009/Protege_Effect_Teachable_Agents.pdf).

### 2.6 Illusion of explanatory depth / illusion of competence

**Finding.** Rozenblit & Keil (2002): people rate their own understanding of how everyday
mechanisms work as much higher than it is — the illusion collapses only when they're forced to
*actually write out* a step-by-step causal explanation; after attempting it, self-rated
understanding drops sharply. The illusion is strongest specifically for **explanatory/causal**
knowledge (mechanisms), much weaker for facts, procedures, or narratives — and strongest where
the environment presents fluent, visible-seeming mechanisms (exactly what a fluent AI answer
provides).

**Evidence strength.** Confirmed — the original, widely-replicated cognitive science study; the
"construal level" follow-up work further supports the general effect and its boundary
conditions.

**Concrete practice.** This is the mechanism risk of the whole "AI did the reading and design"
pattern: a fluent AI explanation of *why* a design works creates exactly the perceptual
conditions (visible-seeming, coherent mechanism) that produce the illusion most strongly. The
test that breaks the illusion is the same as the original study's method: **make the human
write the mechanism explanation himself, unaided, before or instead of reading the AI's** — if
he can't, the illusion is exposed immediately rather than persisting.

Sources: [Wiley abstract](https://onlinelibrary.wiley.com/doi/abs/10.1207/s15516709cog2605_1), [Decision Lab summary](https://thedecisionlab.com/biases/the-illusion-of-explanatory-depth), [Wikipedia](https://en.wikipedia.org/wiki/Illusion_of_explanatory_depth).

### 2.7 Does reading a summary produce understanding?

**Finding.** Mixed but instructive: *writing* a summary (a generative act) correlates with
comprehension gains, and summary-writing *quality* correlates with essay/test performance
(r=.82 with multiple-choice comprehension in one study) — but that's summary-*writing* by the
learner, not summary-*reading* of someone else's summary. Directly comparing summarizing vs.
rereading the full text: summarizers who wrote *low-quality* summaries did worse than rereaders;
only high-quality self-generated summaries matched or beat rereading. No evidence found that
reading someone else's (or an AI's) ready-made summary produces comprehension equivalent to
engaging with the source — the mechanism that makes summarizing work is the generation, not
the resulting artifact.

**Evidence strength.** Likely, with an important gap: **Unknown** specifically for
"reading an AI-written summary vs. reading the source" as a direct RCT — I did not find a study
that isolates that exact comparison; the inference that reading a summary is insufficient is
extrapolated from (a) Dunlosky's low-utility rating of summarization/rereading generally and
(b) the generation-effect literature (2.3), not from a study of AI-produced summaries
specifically.

**Concrete practice.** Treat an AI summary as an index/pointer, not a substitute: use it to
decide *which* sources are load-bearing enough to read firsthand (see Part 5's "how much
primary reading is enough"), not as the thing that gets read instead of the source.

Sources: [Summary vs rereading, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0361476X23000929), [Selective attention / eye-tracking summary quality study, PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7898009/).

---

## Part 3 — Reading and synthesis methods

### 3.1 Adler & Van Doren, syntopical reading (*How to Read a Book*)

**Finding.** The specific method for synthesizing multiple sources on one question (not just
reading many books): (1) survey the field to build a working bibliography; (2) inspect each
book not to master it but to extract what's useful *to your question*; (3) **bring the authors
to terms** — build your own neutral vocabulary, because different authors use different words
for the same idea (or the same word for different ideas) and you cannot compare them until you
translate; (4) get the questions clear — frame neutral questions every author is implicitly
answering; (5) define the issues — map where authors actually agree/disagree once put in common
terms. Adler's explicit framing: "it is you and your concerns that are primarily to be served,
not the books" — the reader, not the source, drives the synthesis.

**Evidence strength.** Confirmed as a described method (not an empirical study) — a normative
practice with 75+ years of pedagogical use, not itself experimentally validated, but structurally
identical to what modern research (self-explanation, generation effect) shows works: it forces
the reader to *produce* a comparative framework rather than just accumulate quotes.

**Concrete practice.** When the design pulls from multiple sources (competitor products,
papers, prior art), the human — not the AI — builds the comparison table/terms-in-common step.
The AI can gather candidate sources and passages; translating them into one vocabulary and
locating the actual disagreement is the step that must not be delegated, because that step *is*
the synthesis.

Sources: [Sloww summary](https://www.sloww.co/how-to-read-a-book/), [Farnam Street summary](https://fs.blog/how-to-read-a-book/).

### 3.2 Matuschak, "Why Books Don't Work" (2019/2021)

**Finding.** Diagnoses "transmissionism" — the false assumption that reading an author's
sentences transfers the author's understanding into the reader's head. Most readers forget most
of what they read specifically because books offload all self-monitoring/feedback onto the
reader with no check on whether it landed. Proposes memory- and testing-integrated media
(spaced-repetition-linked prose, e.g. Quantum Country) as a partial fix.

**Evidence strength.** Likely as diagnosis (aligns with the illusion-of-competence and
low-utility-of-rereading findings above); the proposed fix (embedded spaced retrieval prompts)
is Matuschak's own prototype work, promising but not independently RCT-validated at scale.

**Concrete practice.** An AI-authored synthesis of sources has exactly the "transmissionist"
failure mode Matuschak describes, at a higher risk level than a book, because it's *even more*
fluent and *even more* tailored-feeling — so it produces a stronger illusion of transfer with
no more actual transfer. Build in the check Matuschak's diagnosis implies: an explicit,
separate test of whether the idea actually landed (Part 5's "tests"), not trust in fluency.

Sources: [andymatuschak.org/books](https://andymatuschak.org/books/).

### 3.3 Evergreen notes / "Tools for Thought as practice" (Matuschak)

**Finding.** Core claims: (a) "better note-taking" is not the goal — better *thinking* is, and
notes are a byproduct/instrument of thinking, not an archive; (b) notes should be **written in
your own words** — copying a source's words (or an AI's words) into a note file is not the same
act and does not do the cognitive work; (c) notes should be atomic (one idea) and densely linked,
because the linking-and-revisiting process is itself a retrieval-practice + elaboration loop over
time, not a one-time capture.

**Evidence strength.** Likely as a described personal-practice methodology with strong internal
consistency with the learning-science findings above (self-explanation, generation effect); not
itself an RCT. Notably, a widely-shared critical response ("Reflection on two years of writing
evergreen notes: not optimal for skill acquisition") argues the practice can become an end in
itself and crowd out actual skill-building — a caution worth carrying into Part 5: note-writing
is a means, and can itself be gamed into another form of passive activity if not paired with
retrieval/testing.

**Concrete practice.** The design session's persistent record (see Part 5) should be notes the
human writes in his own words about what he now believes and why, atomically, linked to the
sources — not a transcript of the AI's outputs pasted in.

Sources: [notes.andymatuschak.org](https://notes.andymatuschak.org/), [critical response](https://engineeringideas.substack.com/p/reflection-on-two-years-of-writing).

### 3.4 Ahrens, *How to Take Smart Notes* / Luhmann's Zettelkasten

**Finding.** Systematizes three note types: fleeting (temporary reminders), literature notes
(summaries of what you read, **in your own words**), and permanent notes (well-formed ideas that
stand alone and connect to existing knowledge). The explicit mechanism claim: writing is not
separate from thinking — externalizing an idea in your own words *is* the act of understanding
it, and skipping straight to "permanent" note or synthesis without the in-your-own-words
literature-note step short-circuits the understanding.

**Evidence strength.** Likely — a described, hugely popular methodology (widely adopted, credited
with Luhmann's own extraordinary output), consistent with self-explanation/generation research,
but not itself independently tested as an intervention.

**Concrete practice.** Insert an explicit "literature note" step between reading a source (or
an AI's extraction of it) and using it in the design: the human writes, in his own words, what
that source claims and why it matters to this design question — before the AI is allowed to
fold it into any proposal.

Sources: [zettelkasten.de explainer](https://zettelkasten.de/posts/concepts-sohnke-ahrens-explained/).

### 3.5 Feynman technique

**Finding.** Explain a concept in plain language as if to a novice; the points where the
explanation breaks down or gets circular/jargon-laden mark exactly what isn't understood yet;
revise and re-explain. Secondary sources report this activates the same mechanisms validated
independently above: retrieval, self-explanation (effect sizes ~0.5–1.0 SD in cited studies),
and metacognitive monitoring (noticing the gap).

**Evidence strength.** Likely — the technique itself is not a single named study but a repackaging
of self-explanation (2.2) and metacognition (1.2) research that *is* independently validated;
treat "Feynman technique" as a mnemonic label for validated component mechanisms rather than a
separately-tested method.

**Concrete practice.** For any design decision the human wants to own, he explains it in plain
language to someone (or something) with zero context, out loud or in writing, without notes —
the AI's job is to be that low-context listener and flag exactly the point where the explanation
got vague, not to supply the missing piece itself.

Sources: [Noji breakdown](https://noji.io/blog/the-feynman-technique/), [Feynman technique effect-size synthesis](https://whennotesfly.com/concepts/learning-science-knowledge/feynman-technique-learn-anything-faster).

### 3.6 Newport, *Deep Work* / *Slow Productivity*

**Finding.** *Deep Work*: sustained, distraction-free concentration is what builds new
capability and produces high-value output; it is neurologically, psychologically, and
philosophically distinct from shallow, fragmented work, and it is a skill that atrophies without
practice. *Slow Productivity*: three principles — do fewer things, work at a natural (not
maximal) pace, and obsess over quality — as a corrective to "visible busyness" masquerading as
productivity, especially relevant to ADHD-affected attention where task-switching and urgency
signals are especially costly.

**Evidence strength.** Possible — Newport synthesizes cognitive-science and historical
case-study evidence but these are popular-press books, not peer-reviewed studies; treat as
well-argued synthesis, not primary evidence, though the "deep, sustained attention builds
capability" claim is broadly consistent with deliberate-practice research (Ericsson) which is
better-evidenced.

**Concrete practice.** For ADHD specifically: doing fewer sources more deeply (syntopical
reading's own instruction — quality of synthesis over quantity of books skimmed) and working at
a pace that allows the generation/retrieval steps to actually happen is a direct countermeasure
to the "AI did the reading" failure mode, which is often driven by time pressure/overload more
than by any preference to not think.

Sources: [Deep Work summary](https://www.runn.io/blog/deep-work-summary), [Slow Productivity summary](https://www.simplypsychology.org/slow-productivity.html).

### 3.7 Paul Graham, "Writes and Write-Nots" (Oct 2024)

**Finding.** Argues that because writing and thinking are so tightly coupled, a world where AI
does the writing for people who "can't write" doesn't just change who produces text — it risks
creating two classes: those who still think for themselves (because they still write for
themselves) and those who don't, widening rather than narrowing a gap. Central claim: writing
*is* thinking, made visible and revisable; outsourcing the writing risks outsourcing the thinking
it would have forced.

**Evidence strength.** Possible — an essay/opinion piece, not empirical, but directly consistent
with the writing-to-learn meta-analyses (2.4) and self-explanation literature; its predictive
claim about societal stratification is speculative and unverified.

**Concrete practice.** Directly on-point for the user's worry: the essay's thesis is precisely
"if AI writes it, you didn't think it" — reinforces that the human's own synthesis must be
written by the human, not edited from an AI draft, for the writing to do its thinking-work.

Sources: [paulgraham.com/writes.html](https://paulgrahamessays.substack.com/p/new-essay-writes-and-write-nots) (search did not surface a stable direct paulgraham.com link in this pass; verify at paulgraham.com/writes.html before citing further).

---

## Part 4 — Design practice: keeping ownership of a design

### 4.1 Design rationale, decision records, "strong opinions weakly held," pre-mortems

**Finding.** "Strong opinions, weakly held" (Paul Saffo): form a tentative, strongly-stated
hypothesis, actively seek disconfirming evidence, revise when contradicted — explicitly a
countermeasure to both analysis paralysis and to quietly drifting into whatever the last input
(including an AI's) suggested, because you must *state* a position to weigh it against new
evidence. Architecture/design decision records: the record's value is capturing *what was
rejected and why*, not just what was chosen — a future reader (or future self) needs the
rejected alternatives to trust the decision. Pre-mortems: assume the design has already failed
and write down why, before building it — surfaces risks that optimism (including AI-generated
optimism about its own proposal) suppresses.

**Evidence strength.** Likely — these are established practitioner methods with long track
records in software/design engineering, but (like Adler's method) are normative practices, not
themselves RCT-tested; their internal logic (commit → seek disconfirmation → revise) matches
Buçinca's experimentally-validated cognitive-forcing mechanism (1.4) closely.

**Concrete practice.** Every design decision in the session gets a one-line record in the
human's own words: what was chosen, what was rejected, and why — written by the human before
or immediately after the AI's input, not as a transcription of the AI's stated rationale.

Sources: [ADR guide](https://www.john-pratt.com/architecture-decision-record), [pre-mortem](https://www.researchgate.net/publication/3229642_Performing_a_Project_Premortem), [Saffo framework](https://medium.com/@ameet/strong-opinions-weakly-held-a-framework-for-thinking-6530d417e364).

### 4.2 Design fixation — Jansson & Smith 1991, and AI-specific fixation studies (2024)

**Finding.** Jansson & Smith (1991): showing designers an example solution (even one explicitly
flagged as flawed) causes them to fixate on its features in their own "improved" designs — both
novice and expert engineers were susceptible. **Wadinambiarachchi, Kelly, Pareek, Zhou & Velloso,
CHI 2024**, direct AI-era replication: N=60 visual ideation study found AI-generated image
examples caused participants to produce *fewer* ideas, *less* variety, and *lower* originality
than a no-AI baseline — AI-generated examples fixate designers more readily than human-made
ones, likely because they arrive faster, in greater volume, and looking more "finished," which
seeds anchoring before the designer forms an independent frame.

**Evidence strength.** Confirmed for the original 1991 effect (widely replicated foundational
result). Likely for the AI-specific 2024 replication — single study, N=60, one task domain
(visual ideation), but methodologically a direct extension of a validated paradigm and the
effect direction is exactly what fixation theory predicts, so it's a low-surprise, credible
result rather than a one-off anomaly.

**Concrete practice.** This is the most important design-practice risk in the whole brief for
"AI did the reading, synthesis, *and design*": if the AI shows its own candidate design/solution
before the human has generated his own independently, the human's own ideation is measurably
narrowed by it, even when he consciously disagrees with the AI's choice. **Sequencing matters
more than content**: the human must generate his own candidate design (even a rough one) before
seeing the AI's, not after.

Sources: [Jansson & Smith 1991 PDF](https://cecas.clemson.edu/cedar/wp-content/uploads/2016/07/9-JanssonAndSmith1991.pdf), [Wadinambiarachchi et al. CHI 2024, arXiv](https://arxiv.org/pdf/2403.11164).

---

## Part 5 — Synthesis: a concrete workflow for a human-thinks, AI-supports design session

Every finding above points the same direction. State it as one operating principle, then the
protocol:

> **The human generates and commits before the AI reveals.** Every mechanism shown to work
> (self-explanation, generation effect, retrieval practice, cognitive forcing functions,
> syntopical "bringing authors to terms," writing permanent notes in your own words, avoiding
> design fixation) requires the human to *produce something* — a guess, an explanation, a
> synthesis, a design — *before* consuming the AI's version of the same thing. Every mechanism
> shown to fail or mislead (reading summaries passively, fluent AI explanations, AI showing its
> design first, delegating fully) is exactly the reverse order: consume the finished artifact,
> then rubber-stamp or lightly edit it.

### What the human does

1. **Reads primary sources firsthand for anything load-bearing to the decision** — i.e., any
   source whose specific argument, evidence, or framing the design will actually turn on. Not
   every source: use the AI's summary/extraction as a *triage index* (3.7/2.7) to decide which
   2–4 sources out of a longer candidate list are load-bearing, then read those firsthand.
   Rule of thumb from Dunlosky + Adler: if you can't correctly state an author's specific
   argument (not just topic) from memory, you haven't read it firsthand yet, regardless of
   whether the AI has.
2. **Writes his own synthesis in his own words before reading the AI's** — a literature-note-
   style note per load-bearing source (Ahrens), then his own attempt at the syntopical
   cross-source synthesis (Adler steps 3–5: common terms, the real question, where sources
   actually agree/disagree) — before the AI is asked for its synthesis of the same material.
3. **Makes an explicit prediction/hypothesis and commits to it** before the AI states its
   analysis or proposed design (Buçinca's cognitive-forcing function — this is the one causally
   validated intervention in the whole brief).
4. **Generates his own first-pass design/option before seeing any AI-generated design option**
   (Jansson & Smith / Wadinambiarachchi — sequencing prevents fixation; an AI option shown
   first measurably narrows what follows even for a skeptical human).
5. **Explains the design back — to the AI playing a naive listener, or in writing — at each
   major decision point**, and treats the exact moment the explanation gets vague or circular
   as the location of a real gap, not a rounding error (Feynman/self-explanation/illusion of
   explanatory depth: fluency ≠ understanding, and the only way to find the boundary is to try
   to produce the explanation unaided).
6. **Decides.** Every decision gets a one-line record in his own words: chosen, rejected
   alternatives, why (4.1) — written by him, not transcribed from the AI.
7. **Periodically reconstructs the state of the design from memory, unaided** (closing the AI
   window and writing/saying what the design is and why) as a literal retrieval-practice
   checkpoint, not just at the end.

### What the AI does

1. **Fetches and prepares sources** — finds candidates, extracts passages, produces a *triage*
   summary explicitly labeled as such ("here's what's likely load-bearing, here's what
   probably isn't") — but does not present this as the synthesis to adopt.
2. **Asks questions before answering** — Socratic-provocateur mode by default (Sarkar 1.3,
   provocations 1.5): "what do you think this source is claiming," "what would change your
   mind," "what's the strongest argument against your current view" — not "here's what I
   think."
3. **Withholds its own synthesis and its own design proposal until explicitly asked**, and even
   then, states it *after* the human's own version is recorded, framed as critique/alternative
   rather than as the answer ("here's where your read differs from mine, and why mine might be
   wrong").
4. **Challenges rather than confirms** — plays devil's advocate against the human's stated
   position, flags where his self-explanation was vague or circular, points out disconfirming
   evidence he may have missed (this is the causally-validated cognitive-forcing role, and the
   provocation role).
5. **Checks understanding directly**, the way a test does, not the way a conversation does: asks
   the human to explain a point back, or to predict an outcome, and flags mismatches — rather
   than accepting "makes sense" as evidence of understanding.
6. **Keeps the record** — timestamps decisions, rejected alternatives, and the human's own
   stated rationale (from step 6 above) so the design session has an audit trail that is the
   human's thinking, not the AI's.
7. **States uncertainty and disagreement explicitly** rather than producing a single confident
   narrative (1.1's finding that AI confidence, not correctness, is what suppresses human
   critical thinking).

### How much primary reading is enough

No study in this brief gives a numeric threshold (this is an **Unknown** — I found no research
directly answering "how many sources must be read firsthand vs. summarized"). The best-supported
heuristic, synthesized from Adler (syntopical reading is about *your question*, not exhaustive
coverage) and Dunlosky (summarization/rereading are low-utility, so more secondary exposure
doesn't compensate for zero primary exposure): read firsthand **every source whose specific
argument the design decision actually turns on** — typically a short list even in a broad
research question — and use AI-prepared summaries only for triage (deciding which sources
matter) and for genuinely peripheral/context sources whose specific wording will never be
load-bearing to a decision. If in doubt whether a source is load-bearing, the test in the next
section (can you correctly state its specific claim from memory) resolves it after the fact.

### Tests for whether he is actually understanding, not just fluent

Drawn directly from the mechanisms validated above — these are checks, not vibes:

- **Unaided reconstruction test** (retrieval practice, 2.3): close everything and state, from
  memory, what the design is, why, and what it's not. Gaps = not-yet-understood, no matter how
  fluent the AI's version sounded.
- **Explain-to-a-novice test** (Feynman/self-explanation, 2.2/3.5): explain a decision in plain
  language with the AI playing a genuinely naive listener that asks "why" repeatedly; the exact
  spot the explanation breaks is the exact spot to go re-read the source, not re-ask the AI.
- **Prediction test** (cognitive forcing, 1.4): before the AI evaluates a design choice, predict
  what it will say and why; a consistent gap between prediction and AI feedback is the honest
  signal of a shallow model, better than any self-rating.
- **Explanatory-depth check** (2.6): write out the causal mechanism of *why* the design works,
  step by step, unaided — the moment this feels harder than expected is the illusion breaking,
  which is the point, not a failure.
- **Disagree-and-defend test**: state one place where he disagrees with the AI's proposed
  design and defend it in writing — inability to generate a defensible disagreement anywhere is
  itself a signal (either genuine full agreement after real engagement, or unexamined
  deference; the AI's provocations from step 4 above should have generated at least a candidate
  disagreement to test).

None of these is a substitute for the others — they test different mechanisms (retrieval,
explanation, prediction, causal depth, critical independence) and the research above validates
each separately, not as a combined battery.

---

## What I could not verify / open gaps

- **Anthropic coding-skill study (1.7):** I read secondary/trade coverage, not a confirmed clean
  load of the primary PDF (arXiv:2601.20245 returned inconsistently in search results). Treat
  exact percentages as reported, not independently confirmed against the primary text.
- **"Reading an AI-generated summary vs. reading the source" as a direct controlled comparison
  (2.7):** no study found that isolates this exact contrast; the conclusion is a reasoned
  extrapolation from adjacent, well-evidenced findings (Dunlosky's summarization rating,
  generation effect), not a direct measurement.
- **Numeric threshold for "how much primary reading is enough":** no research found; the
  heuristic offered is derived, not measured.
- **Paul Graham essay's stable URL:** search surfaced a Substack mirror reliably but not a
  directly-verified load of paulgraham.com/writes.html itself in this pass.
