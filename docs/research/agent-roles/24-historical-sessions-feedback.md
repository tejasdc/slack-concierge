# Historical/Mac sessions weigh in on 22-proposal-for-review.md

Five past projects and one prior brainstorm, read from their transcripts and speaking for
themselves (they were not reachable live). Each answers: what bears on this, what it
contradicts, what to reuse, what's missing. Full detail in the companion files
`24-part-*.md` in this directory; this file is the synthesis.

---

## 1. self-healing-agents ("Do Agents Dream of Electric Sleep")

**Bears on this:** Already built a working four-stage nightly cycle (N1 Measure → N2 Prune →
N3 Repair → REM Create) plus a *separate* immune system, with sleep and immune split by speed
(immune: real-time + slow-adaptive; sleep: a third, distinct layer), not by time-of-day. Tejas,
2026-02-21: "Desire paths are the signal... like the immune system detecting a repeated
pathogen," and "Dream about solved problems too... Propose fresh insights next morning."

**Contradicts:** The proposal's sleep "never changes anything he hasn't approved" is the
opposite of what was actually built and decided (`SYNTHESIS.md:582`: sleep should be
"autonomous with next-session reporting," N2/N3 modify files directly, REM creates artifacts).
If the design intent has genuinely shifted to propose-then-approve, that's a reversal worth
stating explicitly, not silent continuity. Also: proposal collapses sleep+immune into one
nightly slot; the original split them by speed with defined crosstalk.

**Reuse:** The tuned decay formula for "fades all salience a little" — `relevance(t+1) =
0.9*relevance(t) + reinforcement`, new items start at 1.0, prune below 0.2, **never prune
anything younger than 3 cycles**. The two-signal activation rule (pattern must appear this
cycle *and* have been pending from a previous cycle) as the concrete mechanism behind "how
structure evolves" triggers — prevents one-off noise from becoming a proposal. Confidence
tiers (2 signals=0.65, 3+=0.85, cross-session+cross-pattern=0.95).

**Missing:** No stop signal / autoimmune guard against runaway *structural* churn from sleep
or immune proposing the same restructuring nightly if declined (an unsolved tension there too).
Sleep should also review already-closed threads, not only the day's captures — dropped from a
named principle. "How do we measure link/rule freshness" was never solved there either; don't
assume it's solved here.

---

## 2. journalmaxx (Obsidian vault)

**Bears on this:** Ships a running, not hypothetical, atom format: `- [rN] <sentence>.
#type/<t> #<namespace>/<value> [status:: provisional] [provenance:: inferred]
[day:: YYYY-MM-DD]`, inferred in real time ("Tejas can't wait; if atoms don't surface
in real-time he won't use the tool"), later promoted to a permanent block ID on endorsement.
Hierarchy: note ⊂ thread ⊂ project. Six-pair typed-link vocabulary (`seed`/`sprouted`,
`supports`/`supported_by`, `contradicts` — kept deliberately unresolved, `next`/`prev`,
`part_of`/`contains`, `example_of`), chosen live over tags and a rejected plugin. Tejas,
2026-09-02, rejecting the old tag scheme: "I think this is completely bullshit... That's not
a good model at all," and on automation: "Why are we doing things that agents can automate?"

**Contradicts:** Naming collision, not just overlap — the proposal's "thread" (top-level unit
of attention) is journalmaxx's **project**; journalmaxx's own "thread" is a smaller unit
*inside* a project. No "blocks"/"merged-into" analog exists; the nearest typed link
(`contradicts`) was built to deliberately *stay open*, the opposite intent. No salience/decay
model was ever attempted here — the lifecycle is human-gated (provisional → endorsed via
`/review`), not automatic fading.

**Reuse:** The atom line format and lifecycle, verbatim. The typed-link vocabulary and its
elimination log (`seed`/`sprouted` maps directly to "spawned-from"). `projects/<slug>.md` as
a working prototype of "the face" — already a page Tejas edits directly and the agent updates
from evidence: "Human writes at the point of thought, agent files." The `captured_at` routing
rule: atoms land on the day they were *dictated*, not processed, so time-windowed
consolidation isn't corrupted by late arrivals.

**Missing:** No "TFC"/extreme-capture precedent found here (likely a different project) — don't
cite this project for burst-splitting; its auto-capture companion is a thin bug-fix session,
not a design discussion. The real lesson: sleep's replay must key off original capture time or
it corrupts like an unrouted backfill would have here. Second, sharper warning: before shipping
automatic salience decay, ask what happens when Tejas skips a week of review — this project's
whole crisis was an unreviewed backlog, and decay dressed as help could quietly bury exactly
what an ADHD user forgot to look at.

---

## 3. claritymaxxing (brain-dump → blog)

**Bears on this:** This is where "threads" as a word for open lines of attention was actually
born, 2026-04-19: "can you walk me through all of the things... identify the different threads
so we can start tracking at least the threads that we have open." A `threads/` directory with
living per-thread docs, and three lanes (capture-engineer, synthesist, publisher) coordinating
through a polled inbox — modeled on Ink & Switch and Engelbart's OHS — were actually built that
day. He also fought through an episodes-vs-face-shaped design live: rejecting verbatim copying
of a voice log into a note (04-20), then reversing on hashtags-verbatim ("the agent should be
inferring and creating those tags"), then later asking when raw capture should graduate to a
page (05-26: "why can't Goal be a page... this kind of tag or type is actually evolving into
something").

**Contradicts:** The proposal states the episodes/face split as settled architecture, but this
project's evidence is that the boundary is content-dependent and he relitigates it live, several
times an hour — not fixed once. Bigger risk: this project's worst failures were an agent
over-compressing a raw dump before he reviewed it — 2026-04-19: "we had a huge research file
landed and you gave me three sentences. What the hell is this?... I want in detail depth." A
face silently rewritten nightly, unattended, is exactly this failure mode, automated and
recurring, with no size limit or objection path defined.

**Reuse:** The three-lane split (capture/synthesis/publish) as concrete precedent for "owning
agent keeps the face current" — this project already built and named the roles the new proposal
re-derives from scratch. The lesson that verbatim-vs-distilled is not one global policy:
preserve raw text by default, fold into structure only on a visible, reversible promotion step
he can see — never silently inside a rewrite. The "why does this deserve its own page" test from
05-26 as the actual formation rule for when a face should exist at all.

**Missing:** What happens when the face gets his summary wrong. Here he caught errors
immediately because he was present; a face rewritten during sleep, while he's asleep, has no
equivalent moment — he'd only find an error hours or days later. The proposal has "a review
counts report," not a shown diff of what sleep changed in a face. Given how much editorial
license this project caught agents taking in real time, show him what changed, not just that
something changed.

---

## 4. agent-ecology (server research lab)

**Bears on this — directly, by name.** The founding session (2026-09-01) is Tejas explicitly
choosing to leave sleep and immune systems *out*, to see if they evolve: "there's a lot of
interesting ideas... you know, sigma g sleeping, immune systems and we are deliberately
choosing not to include those like see if that actually evolves, right?" This is now standing
lab policy: `BOOTSTRAP.md` line 43 names "sleep, immune systems" specifically as metaphors not
to assume are the right abstraction; §6 (the "physics affordance test") asks whether
sleep-like or immune-like behavior would emerge from lower-level primitives instead of being
named upfront; §10 starts the seed colony with "no permanent public identity, no named roles...
record the fact that these emerged, do not prematurely promote them to permanent institutions."
`LAB_CONSTITUTION.md` rule 11/12 makes this a general rule, not sleep/immune-specific. No
experiment has run yet — this is a pre-registered stance, not an empirical finding, and the
project is honest about that limit.

**Contradicts:** Directly. The proposal's Roles table names five fixed roles up front,
including **Nightly consolidation ("sleep")** and **Immune function** verbatim — precisely the
two institutions Tejas named as the paradigm case for *not* pre-specifying. The "how structure
evolves" trigger mechanism is a real improvement (it does defer *future* structure to
evidence+approval), but it only applies emergence-first thinking going forward — it does not
defer or test the initial five roles it starts with, two of which reuse his own named examples.

**Reuse:** The physics-affordance test itself — apply it explicitly to consolidation and
immune-function before committing the table: what lower-level primitives (a capture log, review
counts, a damage-signal event) would let something sleep-like or immune-like show up without
being named that from day one? The emergence-vs-ablation distinction: ship the two roles as a
named hypothesis with a stated alternative ("no nightly pass; agents update faces inline
instead") and a way to tell afterward whether the pass helped. "Record the fact that these
emerged, do not prematurely promote them" as the literal operating rule for the trigger
mechanism, so an approved role stays revocable, not silently permanent.

**Missing:** No falsification path for the two named institutions — if nightly consolidation or
immune-function turn out to be dead weight (busywork faces, proposals he always rejects), what's
the signal and who removes the role? No smallest-alternative comparison (this lab's constitution
treats that as mandatory before adopting any institution). No plan to notice role behavior *not*
in the table — e.g., an owning agent starting to police other agents' work uninvited, a proto
"immune" behavior evolving somewhere the fixed table didn't expect.

Caveat this project itself raises: a personal single-operator tool is a different operating
profile than an experimental multi-agent colony, and CLAUDE.md's "engineer for the real
operating profile" principle could genuinely justify pre-specifying here — but the proposal
should make that argument openly rather than silently reusing the metaphor without addressing
the tension its own author (Tejas) raised three weeks ago about these exact two words.

---

## 5. The stalled-threads brainstorm (concierge:3438, 2026-09-20 — Thinkering's own prior effort)

**Bears on this:** This is the direct predecessor design conversation, and most of it traces to
even earlier ChatGPT sessions. Tejas converged there on an **attractor** as "a standing
knowledge product with a recognition function, an evidence reservoir, and a path toward
action... I would not implement an attractor as a folder," on **three** extraction timescales
(a working agent marking as it goes, a middle steward consolidating after a transition, a slow
steward looking across sessions) "so the same agent that made a decision doesn't also become the
unquestioned historian of why it was correct," and — after rejecting a ten-entity taxonomy as "a
harsh mash of mostly garbage things" — on **Topic (territory) → Branch (a visible growth path,
created only once a thought accumulates children) → typed Thought**. Thinkering already ships
18 typed links with required reasons, pinned revisions, retraction history, and an endorsement
rule (propose/accept/edit/reject). A `feedback-3756.md` in this same brainstorm folder already
reviewed an earlier draft of the *current* proposal.

**Still contradicts/drops (per that earlier review, still unaddressed in v22):** No recognition
rule on the face (no "what belongs here" criterion for nightly filing). Face rewritten solely by
the owning agent with no endorsement split — collides with the project's own
`HUMAN_ENDORSEMENT_REQUIRED` rule and the "decision-maker shouldn't be the historian" principle.
Two timescales, not three — still drops the middle steward. A new four-link vocabulary
(spawned-from/related-to/blocks/merged-into) sitting beside the 18 that already ship with
reasons and pinned revisions — a second table for the same knowledge. Topic vs. Branch still
flattened into one thread state machine covering both a one-message capture and a multi-month
territory. Two thread stores now explicit but unreconciled ("the thread record lives with the
session owner... not in a folder," alongside Notes/Timeline, which are already threads). The
immune function is still a named subsystem, unremarked — this brainstorm's own earlier feedback
already asked for the agent-ecology tension (above) to be surfaced, and v22 still doesn't.
Progress since that earlier review: decay is now addressed ("fades all salience... prunes dead
links"), and the active cap — previously told not to ship — is now posed as an open question
rather than shipped silently.

**Reuse:** The attractor's field list wholesale onto the face — purpose/recognition-rule,
evidence, maturity criteria, review trigger, steward (the face is currently missing recognition
and steward). The 18 existing typed links instead of a new four. Topic/Branch/Thought instead of
one lifecycle for every thread. self-healing-agents' concrete mechanics (rejection-is-signal,
trail evaporation, two-signal activation) as *what the immune function is made of*, not a fifth
named role.

**Missing:** Everything above, plus: what sleep actually reads (final reports and messages, not
full transcripts — a stated cost decision here, still unstated in v22), and the Map, which this
brainstorm already called over-built and v22 keeps unchanged.

---

## Cross-project pattern

Three independent projects (self-healing-agents, agent-ecology, and this brainstorm's own prior
feedback) converge on the same specific objection: naming "sleep" and "immune function" as fixed
roles at t=0, rather than as emergent behavior earned by evidence, contradicts a stance Tejas
stated explicitly and by name on 2026-09-01. Two independent projects (journalmaxx,
claritymaxxing) converge on a second objection: an automatic, unattended, silently-rewriting
consolidation pass (salience decay, face rewrites) is exactly the failure mode both of those
projects already lived through when review lapsed or an agent over-compressed — and both ask for
a visible diff/promotion step, not a "review counts" report after the fact. A third,
narrower point recurs in journalmaxx and this brainstorm: the proposal invents new vocabulary
(a new "atom," a new four-link set, a new thread state machine) where working, tested, or
already-decided vocabulary exists and should be reused instead.
