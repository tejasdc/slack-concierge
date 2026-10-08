# What is a thread? A cross-disciplinary survey for Tejas's agent app

Research brief. For each model: what it is, how it handles branching/relating/resurfacing,
evidence/adoption, and the implication for a "thread" primitive that holds both live
agent work and not-yet-built ideas for an ADHD brain. Confidence is marked per claim
(Confirmed / Likely / Possible / Unknown) per the project's evidence rules.

---

## 1. Neuroscience and cognition of associative memory

### 1.1 Spreading activation (Collins & Loftus, 1975)

**Model.** Semantic memory is a network of concept-nodes connected by weighted,
labeled links. Activating one node sends activation outward along links to
neighbors, decaying with distance and dividing across branches (the "fan effect" —
more links from a node means less activation reaches any one neighbor). The model
extended Quillian's 1967 semantic-network theory and was built to explain priming,
typicality effects, and category-size effects. Published in *Psychological Review*
82, 407–428, and still described as "the dominant cognitive model of semantic
memory" in recent review literature. **Confirmed.**

**Branching/relating/resurfacing.** There is no single parent-child hierarchy —
every node can link to many others, and *any* link can fire retrieval, not just a
designated "primary" relation. Resurfacing is a *side effect of activating something
nearby*, not a scheduled event: thinking about "dog" partially activates "cat,"
"leash," "bark" whether or not you intended to think about them. Relatedness is
continuous (strength of link) rather than binary (linked / not linked).

**Evidence/adoption.** Directly cited as the design basis for modern PKM tools'
bidirectional-link graphs (Roam, Obsidian, Logseq) and for graph-based LLM-agent
memory retrieval (HippoRAG, HippoRAG 2 — see §5) which build entity/passage graphs
and use personalized PageRank, an explicit computational analogue of spreading
activation, to do multi-hop associative recall. **Confirmed** (architecture
lineage); **Likely** (causal inspiration for the specific tools, as most don't cite
Collins & Loftus directly but converge on the same shape).

**Implication.** A thread system that only resurfaces items via one dimension
(e.g., "same project" or "same tag") is throwing away the mechanism that makes
biological memory good at "resurface when relevant" — activation should be able to
spread through *multiple, weighted, weak-tie* relations (mentioned-same-person,
similar-words, temporally-near, previously-co-opened), not just an explicit
parent/child pointer.

Sources:
[A spreading-activation theory of semantic processing (Semantic Scholar)](https://www.semanticscholar.org/paper/A-spreading-activation-theory-of-semantic-Collins-Loftus/61374d14a581b03af7e4fe0342a722ea94911490),
[SYNAPSE: LLM Agents with Episodic-Semantic Memory via Spreading Activation](https://arxiv.org/pdf/2601.02744)

### 1.2 Schemas and episodic → semantic consolidation

**Model.** New experiences are encoded as hippocampus-dependent episodic memories
(rich, context-bound, one-shot). Over time — "systems consolidation" — the
specific episodic details fade and a more abstract, gist-like, schema-consistent
representation is retained, supported by extra-hippocampal (cortical) structures.
Pre-existing schemas *accelerate* this: information consistent with a schema
consolidates faster and is remembered better, because the schema supplies slots the
new content can be filed into rather than requiring the item to build its own
structure from scratch. Recent work (2023 *Nature Human Behaviour* generative
model) argues the relationship is bidirectional: consolidation itself builds the
shared vocabulary that later organizes new experience. **Confirmed** (transformation
hypothesis is mainstream); **Likely** (bidirectional refinement is newer, less
settled).

**Branching/relating/resurfacing.** A single episode isn't "resurfaced" as itself
forever — it's gradually absorbed into a general-purpose schema, and what
resurfaces later is often the *gist*, not the episode. This maps to something
Tejas will recognize: a thread that started as "the specific bug with the
Wednesday auth token" eventually becomes part of "how our auth retry logic works"
— the specific incident fades, the pattern persists and generalizes to future
similar bugs.

**Implication.** A pure list of discrete threads-as-episodes will accumulate
forever without the equivalent of consolidation. Something has to play the role of
"schema": a standing area/topic that absorbs the residue of finished threads so the
*pattern* is what resurfaces later, not the individual dead thread. This is close
to what Tiago Forte's PARA "Areas" are for (§2.4) and what Zettelkasten permanent
notes do relative to fleeting notes (§2.1) — both are the personal-note-taking
analogue of the episodic→semantic pipeline.

Sources:
[Memory transformation and systems consolidation (PubMed)](https://pubmed.ncbi.nlm.nih.gov/21729403/),
[A generative model of memory construction and consolidation (Nature Human Behaviour)](https://www.nature.com/articles/s41562-023-01799-z)

### 1.3 Reconsolidation

**Model.** Retrieving a stored memory doesn't just read it — it puts it into a
transiently labile state ("reconsolidation window") during which it can be
updated, strengthened, or weakened before it restabilizes. This is the mechanistic
basis for memory *updating* rather than memory being a write-once, read-many log.
**Confirmed** for animal models and increasingly for human episodic memory;
therapeutic exploitation (updating fear memories during extinction) is an active
clinical research area, not yet a mature standard treatment. **Likely** for humans
generally; **Possible** for reliable clinical protocols.

**Branching/relating/resurfacing.** The act of resurfacing a thread (reopening it,
rereading it) is not neutral — cognitively, re-engaging with an idea is exactly the
moment it's most editable/revisable. This argues for treating "resurfaced and
reopened" as a distinct, meaningful event (an update opportunity), not just a
read.

**Implication.** When an idea-thread resurfaces and Tejas engages with it, the
system should make it trivially easy to *revise* the thread's content/framing in
that moment (append, restate, fork a new angle) rather than only offering
"reopen unchanged" — that's the moment the brain is primed to update it.

Sources:
[An Update on Memory Reconsolidation Updating (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S1364661317300785),
[Memory Reconsolidation or Updating Consolidation? (NCBI Bookshelf)](https://www.ncbi.nlm.nih.gov/books/NBK3905/)

### 1.4 Context-dependent retrieval (Godden & Baddeley, 1975)

**Model.** Recall is better when the retrieval context (environment, internal
state) matches the encoding context — the classic finding: divers who learned
word lists underwater recalled them better underwater, and those who learned on
land recalled better on land; matching conditions produced roughly 50% better
recall than mismatched ones. **Confirmed** for the original result; a faithful
2021 replication by Murre *failed to reproduce the effect*, which is an important
caveat — the effect is smaller/less robust than the textbook version claims.
**Possible** (real but overstated) rather than **Confirmed** as a strong, reliable
effect.

**Branching/relating/resurfacing.** This is the strongest single argument for
*cue-based* over *pure-search* resurfacing: an idea captured "while working on the
onboarding flow" is more likely to resurface usefully when you're back in a
context that resembles that one (same project open, same person mentioned, similar
words used) than via undirected browsing.

**Implication.** Threads should carry cheap, ambient context tags at capture time
(what was open, what was being discussed) purely to support later
context-matched resurfacing — not necessarily for the user to see, but for a
resurfacing algorithm to match against. Given the failed replication, don't
over-engineer around environmental context (physical/audio/visual) — the safer bet
is *semantic and topical* context-matching, which has much stronger modern
evidence (§5, RAG/graph retrieval).

Sources:
[The Godden and Baddeley (1975) experiment: a replication (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8568063/),
[Context-dependent memory (Wikipedia)](https://en.wikipedia.org/wiki/Context-dependent_memory)

### 1.5 Prospective memory (McDaniel & Einstein)

**Model.** "Remembering to remember" splits into **event-based** (do X when Y
happens — cued by an external trigger) and **time-based** (do X at time T — no
external cue, must self-generate the check). Einstein & McDaniel's **multiprocess
theory** (2000) says retrieval of a pending intention can happen through two
different processes: **strategic monitoring** (effortfully scanning the
environment for the right moment) or **spontaneous retrieval** (the cue
automatically reactivates the intention with no deliberate search, when the
intention was well-encoded and the cue is distinctive/salient). Event-based cues
reliably outperform time-based ones because they support spontaneous retrieval;
time-based tasks force costly self-initiated monitoring. **Confirmed**, well
replicated, foundational and still cited (McDaniel & Einstein 2000, *Applied
Cognitive Psychology*; Einstein & McDaniel 2005 overview).

**Branching/relating/resurfacing.** This is *the* mechanism for "resurface when
relevant." The multiprocess theory says the two knobs available to a system
designer are: (1) make the intention's *encoding* distinctive/well-formed (so it
can be spontaneously retrieved later without effort), and (2) attach it to a
*specific, salient external cue* rather than a vague time or "someday." A
"someday/maybe" thread with no cue is structurally the worst-supported case in
prospective-memory research — it has neither a monitored deadline nor a
distinctive external trigger, so it depends entirely on the much weaker
undirected-browsing/serendipity pathway.

**Evidence/adoption.** This is why GTD's "next action" concept works
psychologically (§2.7) — a next action reframes a vague someday-intention into
either an event-cued action ("when I open the laptop, do X") or hands the
monitoring cost to a calendar/reminder system instead of the brain.

**Implication — the single most load-bearing finding for this brief.** A resting
idea-thread should not resurface through "the user remembers to look" (relying on
time-based self-monitoring, which is the weakest pathway and specifically the one
ADHD impairs most, per §1.6). It should resurface through an **event-based cue**:
being shown again when a *related* context recurs (same topic mentioned, same
project opened, similar words typed) — i.e., outsourcing the "monitoring" half of
prospective memory to the system so the user only needs "spontaneous retrieval"
triggered by the system surfacing the cue.

Sources:
[Prospective memory (Wikipedia)](https://en.wikipedia.org/wiki/Prospective_memory),
[Strategic and Automatic Processes in Prospective Memory Retrieval: A Multiprocess Framework (Wiley)](https://onlinelibrary.wiley.com/doi/10.1002/acp.775),
[The Dynamic Multiprocess Framework (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0010028513000327)

### 1.6 ADHD, prospective memory, and time blindness

**Model.** ADHD is associated with executive-function deficits concentrated
exactly in the weaker of the two prospective-memory pathways: time-based /
self-initiated monitoring. Studies find ADHD populations (children and adults)
specifically impaired on *time-based* prospective memory tasks and on strategic
time-monitoring, while performance gaps on *event-based* (externally cued) tasks
are smaller. "Time blindness" — inability to sense elapsed/remaining time — is
described as a core executive-function symptom. Practical guidance converges on:
externalize immediately in writing (don't trust working memory to hold it), and
make time visible externally (clocks/timers) rather than relying on internal
sense of time. **Confirmed** (ADHD/time-based PM deficit is a repeated finding
across multiple independent studies, including VR-task studies in children and
adults); **Confirmed** (externalization-over-memory as the standard clinical/OT
recommendation).

**Implication.** This directly answers part of Tejas's question: for an ADHD
brain, a system that requires *remembering to check back on a resting thread* at
a self-chosen time is fighting the exact deficit. A system built around
event-cued resurfacing (something external re-presents the idea when a relevant
trigger occurs) plays to the *relatively* intact pathway (event-based PM) instead
of the deficient one (time-based PM). This is strong independent support for the
cue-based resurfacing design implied by §1.5, specifically for this user.

Sources:
[Time Blindness: A Critical Executive Function In Adults With ADHD](https://www.occupationaltherapy.com/articles/time-blindness-critical-executive-function-5790),
[Complex Prospective Memory in Adults with ADHD (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC3590133/),
[Event- and time-triggered remembering: ADHD prospective memory (ScienceDirect)](https://www.sciencedirect.com/science/article/abs/pii/S0022096514000472)

---

## 2. Note systems

### 2.1 Luhmann's Zettelkasten — and what Schmidt's research corrects about it

**Model.** Luhmann kept ~90,000 numbered index cards (1950s–1990s). The
numbering scheme is the branching mechanism itself: note 1 can be extended by
1a, 1a can be extended by 1a1, and — critically — a *new* branch can be
inserted between any two existing notes by appending a letter/number (if 23
already exists, a new related note becomes 22a), so the address space is
infinitely subdividable without renumbering anything. Notes also carry explicit
forward/backward links citing other notes' addresses directly, independent of
numeric adjacency — Luhmann himself considered the breakdown of simple physical
proximity between related notes (having to jump far across the box to find a
link) to be *important*, not a flaw, because it forced him to record the link
explicitly rather than relying on physical nearness. Johannes Schmidt's research
(2016 essay "Niklas Luhmann's Card Index: Thinking Tool, Communication Partner,
Publication Machine") is the primary scholarly source correcting popular
oversimplifications: Luhmann ran **two separate slip-boxes** (not one unified
system as often retold), used **fixed, never-reused numbering** (an address, once
assigned, is permanent — nothing is ever renumbered even as the tree grows), and
described the box as a "communication partner" — something with enough of its
own associative structure that working with it felt like arguing with another
mind, not retrieving from storage. **Confirmed** (Schmidt's account is the
authoritative correction to the "one-box, purely hierarchical" popular myth).

**Branching/relating/resurfacing.** Branching (Folgezettel, "follow-up slips") is
explicitly *not* the same as an outline/hierarchy — a note can have exactly one
Folgezettel position but arbitrarily many cross-links, so the "official" tree
address is really just a stable *location*, and the actual thinking structure is
the web of links laid over it. Resurfacing was manual (a human paging through
by keyword register or by literally following link chains) but the design
premise was that following links would keep surprising Luhmann with connections
he'd forgotten making — a designed-in serendipity effect.

**Evidence/adoption.** Directly cited as the intellectual ancestor of Ahrens'
book (2.3), Matuschak's evergreen notes (2.2), and the entire modern PKM tool
category (Obsidian, Roam, Logseq) built around bidirectional links (§2.5).
**Confirmed** heavy adoption/lineage.

**Implication.** Two specific, non-obvious lessons for Tejas's system: (1) a
stable, permanent identifier for a thread (never reused, never renumbered) is
what let Luhmann's system scale to 90,000 items without maintenance collapse —
whatever "spawned-from" mechanism Tejas's threads use should assign a permanent
address at creation, never renumber siblings when new branches insert; (2) the
"communication partner" framing is a strong argument for a thread store that
*talks back* (surfaces links, contradictions, related old threads) rather than
being pure passive storage — which is exactly the affordance an LLM agent adds
that a physical card box never had.

Sources:
[Niklas Luhmann's Original Zettelkasten: Two Slip Boxes, Fixed Numbering, and Communication Partner](https://www.ernestchiang.com/en/posts/2025/niklas-luhmann-original-zettelkasten-method/),
[Niklas Luhmann's Card Index (ResearchGate)](https://www.researchgate.net/publication/345224535_Niklas_Luhmann's_Card_Index_Thinking_Tool_Communication_Partner_Publication_Machine),
[Folgezettel is Not an Outline (Bob Doto)](https://writing.bobdoto.computer/folgezettel-is-not-an-outline-luhmanns-playful-appreciation-of-disfunction/)

### 2.2 Matuschak's Evergreen Notes

**Model.** A refinement/loosening of Zettelkasten for digital tools: notes should
be **atomic** (one concept per note), **concept-oriented** (titled/organized by
idea, not by source document), **densely linked**, and **written to evolve** —
a note is expected to be rewritten and improved every time you revisit it, across
different projects and years, rather than being a frozen record of when it was
written. Matuschak's own explicit test: "if reading/writing notes doesn't lead to
surprises, what's the point" — the system is judged by whether it produces
unexpected connections, not by completeness of capture. **Confirmed** (his own
published notes, widely read/cited in PKM circles).

**Branching/relating/resurfacing.** No numbering system at all — pure link graph.
Resurfacing is entirely link- and search-driven; there's no separate "inbox" of
younger vs. older notes, an evergreen note is supposed to look the same whether
written yesterday or five years ago.

**Evidence/adoption.** Cited as the direct ancestor of the "atomic notes" norm in
Obsidian/Roam communities; explicitly less prescriptive than Zettelkasten
(deliberately "a set of principles," not a numbering procedure).

**Implication.** Evergreen notes work well for *stable knowledge* but Matuschak
himself and later commentary (Bob Doto's essays distinguishing "permanent" vs
"evergreen" notes) note this model is weaker for *time-bound work* — it has no
native concept of a task being "done" or "waiting," because it's optimized for
notes that never finish. This maps to Tejas's own instinct that "idea threads"
and "work threads" might need different handling: evergreen-note principles are a
good fit for the idea/incubating side, a poor fit for the work-with-a-deadline
side.

Sources:
[Evergreen notes (Andy Matuschak)](https://notes.andymatuschak.org/Evergreen_notes),
[Misconceptions About the Relationship Between Permanent & Evergreen Notes (Bob Doto)](https://writing.bobdoto.computer/misconceptions-about-the-relationship-between-permanent-and-evergreen-notes/)

### 2.3 Ahrens, *How to Take Smart Notes*

**Model.** Popularized/operationalized Zettelkasten for a general audience with a
specific pipeline: **fleeting notes** (quick, disposable capture) → **literature
notes** (in-your-own-words summaries while reading) → **permanent notes** (one
idea each, written to stand alone, immediately filed/linked into the
Zettelkasten) → output assembled **bottom-up** from clusters of existing
permanent notes rather than top-down from an outline. Central claim: don't trust
memory to hold an idea until you "have time to properly write it up" — capture
must happen immediately, in a form durable enough to survive without you
remembering the original context. **Confirmed** as the book's argument
(widely-summarized, consistent across independent summaries).

**Branching/relating/resurfacing.** Explicit **three-tier lifecycle by
permanence**, not just by topic — this is the clearest published precedent for a
"states" model of notes (fleeting → literature → permanent) as opposed to
threads existing in one undifferentiated pile. Resurfacing is designed to happen
specifically at the "bottom-up assembly" step: you don't decide in advance what
you're writing, you look at which permanent notes cluster together and let that
tell you what to write.

**Implication.** Direct precedent for a lifecycle with an early, cheap,
disposable-if-unused *capture* stage distinct from a promoted, connected,
durable stage — i.e., not every captured idea deserves the overhead of full
threading immediately; the system should support cheap capture that only gets
"promoted" into a fully-linked thread once it proves out.

Sources:
[How to Take Smart Notes (Sloww deep summary)](https://www.sloww.co/how-to-take-smart-notes/),
[Book Summary: How To Take Smart Notes](https://mattgiaro.medium.com/book-summary-how-to-take-smart-notes-d8c23c3e4291)

### 2.4 Tiago Forte — PARA and Progressive Summarization

**Model.** **PARA** organizes *everything* (notes, files, tasks) into exactly
four top-level buckets by **actionability and time horizon**, not by topic:
**Projects** (short-term, has a deadline/completion state — "write chapter 3"),
**Areas** (standing responsibility with no end date — "health," "finances"),
**Resources** (topics of interest, reference, no obligation attached), **Archive**
(anything from the other three that's inactive). Explicitly designed so the same
piece of information moves between buckets as its status changes (a Resource can
become a Project when you decide to act on it; a completed Project moves to
Archive). **Progressive summarization** is a separate, complementary technique:
each time you revisit a note, distill it further (bold the key line → highlight
the best of the bold → write an executive summary), so effort spent
organizing scales with how often something actually gets reused rather than being
front-loaded at capture time. **Confirmed** (both are Forte's own published,
widely-taught systems).

**Branching/relating/resurfacing.** PARA is explicitly the "active vs. resting"
distinction Tejas asked about, formalized: Projects and Areas are active-attention
buckets, Resources/Archive are the resting state, and the mechanism for
resurfacing is **moving something back into Projects when you decide to act**,
which is a deliberate, and typically manual, promotion. There is no automatic
cue-based resurfacing in the base PARA model — it depends on the human remembering
to browse Resources/Areas, which per §1.5–1.6 is exactly the weak, time-based-
monitoring pathway.

**Evidence/adoption.** Extremely widely adopted (a fixture of the "Second Brain"
online-course ecosystem); frequently criticized in practice for exactly the gap
above (Resources/Archive become "where notes go to die" because nothing pulls the
user back to them).

**Implication.** PARA's Project/Area split is a good model for **work threads**
(bounded, completable) vs. **standing threads** (never-ending topic areas an idea
might belong to), but its Resources/Archive tier is a cautionary example: without
an active cue-based resurfacing mechanism layered on top (which PARA itself
doesn't provide), a "resting" state becomes a graveyard, not an incubator.

Sources:
[The PARA Method: Simplify, Organize, and Master Your Digital Life (Goodreads)](https://www.goodreads.com/book/show/134634583-the-para-method),
[The PARA Method (Thomas Frank summary/notes)](https://thomasjfrank.com/productivity/books/the-para-method-by-tiago-forte-summary-and-book-notes/)

### 2.5 Bush's Memex and Nelson's Xanadu

**Model — Bush (1945, "As We May Think").** A hypothetical desk-scale device
holding a personal library on microfilm, whose core innovation was letting a user
build **associative trails**: linking any two documents/points the way "the human
mind operates ... by association," then naming, saving, and later re-walking or
sharing that trail as a first-class object distinct from the documents it
connects. **Confirmed**, historically foundational, universally cited as the
origin of hypertext thinking.

**Model — Nelson (Project Xanadu, from 1960).** Coined "hypertext"/"hypermedia."
Core innovation is **transclusion**: quoting content by *reference* rather than
copy, so the quoted fragment keeps a live path back to its original context and
any edit to the source is visible from every place it's transcluded. Nelson's
explicit critique of the Web that actually got built: HTML links are one-directional
and copy-paste culture lost the "path back to original context" that transclusion
guarantees. **Confirmed** (his own stated design goals and critique).

**Branching/relating/resurfacing.** Both models treat the *link/trail itself* as
a durable, nameable, saveable object — not just an implementation detail of how
two notes happen to reference each other. Xanadu's transclusion additionally
solves a specific problem relevant to "spawned threads": when thread B is spawned
from a paragraph in thread A, transclusion means B can *literally embed* that
originating fragment live (so if A's fragment is edited, B sees the update)
instead of copying frozen text and drifting from the source.

**Implication.** "Spawned-from" links in Tejas's system are more useful if
implemented as a transclusion-style reference to the originating message/thread
(with a live path back), not a one-way pointer or a copy — this preserves the
ability to walk backward from a spawned thread to see exactly what triggered it,
even after the parent thread has moved on.

Sources:
[Memex (Wikipedia)](https://en.wikipedia.org/wiki/Memex),
[Ted Nelson and the Xanadu Hypertext System (SciHi)](http://scihi.org/ted-nelson-xanadu-hypertext-system/),
[Hypertext, Transclusion, Xanadu (Terra)](https://terrahq.com/en/blog/ted-nelson-hypertext-xanadu-notion/)

### 2.6 Outliners and block-reference tools (Workflowy, Roam)

**Model — Workflowy.** Single infinitely-nestable outline tree; "zoom" lets any
node become the whole screen; **mirrors** are live-copy bullets that can appear
in multiple places in the tree simultaneously — editing one edits all copies.
Philosophy: the mind naturally thinks hierarchically, so one tree with no folders
and no separate documents is sufficient. **Confirmed** (product's own stated
design).

**Model — Roam.** Popularized **bidirectional linking** (link A→B automatically
creates a visible backlink B→A) as the *central* organizing principle, plus
**block references** — every atomic paragraph/bullet has a stable ID and can be
transcluded (embedded live) inside any other note, which is essentially Xanadu's
transclusion made real in a shipping product. Every page and block becomes a node
in a graph rather than a file in a folder. **Confirmed**; widely credited as
launching the 2019–2021 "graph-based PKM" tool wave (Obsidian, Logseq, Tana
followed the same core pattern).

**Branching/relating/resurfacing.** Workflowy's mirror mechanism is a clean,
concrete answer to "should a thread live in two places" — a mirror lets the
*same* item genuinely belong to two parents rather than forcing a single-owner
hierarchy (directly relevant to whether a spawned thread must "belong" to only
one parent). Roam's backlinks make resurfacing *ambient and automatic on the page
itself*: opening any note shows every other note that referenced it, without the
user having to search or remember to look — this is architecturally the closest
existing product analogue to a cue-based, no-monitoring-required resurfacing
mechanism.

**Implication.** Roam's "linked/unlinked references panel, shown automatically on
every page" is the strongest existing-product precedent for the resurfacing
mechanism §1.5–1.6 calls for: it costs the user zero monitoring effort because the
system, not the user, notices the relation and displays it whenever the related
page is opened.

Sources:
[Mirrors: Create live copies of any bullet (Workflowy blog)](https://blog.workflowy.com/mirrors-create-live-copies-of-any-bullet/),
[Roam Research Best Practices](https://ursb.me/en/posts/roam-research/),
[A Beginner's Guide to Roam Research (SitePoint)](https://www.sitepoint.com/roam-research-beginners-guide/)

---

## 3. Work tracking

### 3.1 Issue trackers — parent/child, linked, duplicate (Linear, GitHub)

**Model.** Modern issue trackers separate two distinct relation types that are
easy to conflate: **hierarchy** (parent issue / sub-issues, for decomposition —
Linear's sub-issues, GitHub's tracked-by) and **cross-cutting relations** (Linear:
blocks/blocked-by/related/duplicate-of; GitHub: closes/fixes via commit
references, "close as duplicate," and now native sub-issues as of the 2024
changelog). Linear supports workflow automation on the hierarchy edge (auto-close
parent when all children close); GitHub explicitly does **not** cascade closure
down the hierarchy (closing an epic leaves its stories open) — a known,
documented limitation, and GitHub sub-issues are strictly single-parent (no
issue can be tracked by two different epics natively). **Confirmed** for both
products' current documented behavior.

**Branching/relating/resurfacing.** These systems solve "spawned while working
on X, I noticed a bug" cleanly: a sub-issue or a linked issue is created with an
explicit, typed edge back to its origin, and that edge is queryable/visible from
both ends. "Duplicate" is a first-class terminal state distinct from "closed" —
recognizing that merge/dedup is a different event than completion.
"Resurfacing" in issue trackers is almost entirely **status- and
assignment-driven** (backlog views, "my issues," due-date reminders) rather than
associative — issue trackers are comparatively weak on serendipitous
resurfacing and strong on explicit, typed structural relations.

**Implication.** The blocked/duplicate/related distinction is directly
transferable and more precise than a generic "related-to": Tejas's threads
likely need at minimum **spawned-from** (hierarchy, single origin, like a
sub-issue), **related-to** (symmetric, weak, like Linear's "related"), and
**duplicate-of/merged-into** (a terminal collapse, not a soft link) as three
separate relation types rather than one catch-all "linked" relation — because
they have different implications for closure cascades and for what should
happen to a thread's own unresolved children when it's merged or closed.

Sources:
[Parent and sub-issues (Linear Docs)](https://linear.app/docs/parent-and-sub-issues),
[Issue relations (Linear Docs)](https://linear.app/docs/issue-relations),
[GitHub Issues & Projects changelog — close as duplicate, sub-issues](https://github.blog/changelog/2024-12-12-github-issues-projects-close-issue-as-a-duplicate-rest-api-for-sub-issues-and-more/)

### 3.2 Git branching and merging

**Model.** A branch is a cheap, disposable pointer into a shared commit graph.
The dominant modern pattern (feature/topic branches merged frequently into a
mainline) replaced older long-lived parallel branches specifically because
long-lived branches accumulate divergence that becomes expensive to reconcile —
the entire discipline of "trunk-based development" exists to keep branch lifetime
short. Merges themselves come in two flavors: fast-forward (trivial, no real
divergence to reconcile) vs. three-way merge (real concurrent work on both sides
that must be reconciled, sometimes with conflicts). **Confirmed** (standard,
well-documented software-engineering practice; e.g. the widely cited "successful
Git branching model," git-scm.com's own branching-workflows chapter).

**Branching/relating/resurfacing.** Git's model has no native "resurfacing" —
a branch that stops being touched simply sits inert with zero cost until someone
explicitly checks it out again; there's no serendipity mechanism, only explicit
lookup. But it has the cleanest available model of **merge as a real operation
with content consequences** (not just relabeling two things as "the same"): a
merge reconciles two histories into one, preserving both parents' provenance.

**Implication.** This is the sharpest available model for what "merge" should
*mean* for two idea-threads that turn out to be the same thing: not silently
picking one and deleting the other, but a reconciliation operation that
preserves both origins' provenance and reconciles content, with the old identities
still traceable afterward (git never truly deletes a merged branch's history,
it just stops being a separately-named tip). This argues against Tejas's threads
implementing "merge" as deletion-plus-redirect; it should behave more like a git
merge commit — new node, both parents recorded.

Sources:
[A successful Git branching model (nvie.com)](https://nvie.com/posts/a-successful-git-branching-model/),
[Git - Branching Workflows (git-scm.com)](https://git-scm.com/book/en/v2/Git-Branching-Branching-Workflows)

### 3.3 Case management

**Model.** Service/legal/support "cases" follow a lifecycle — commonly described
as intake → assessment → planning → intervention → review → closure (the exact
number of stages varies 4–9 across frameworks, but the shape is constant) — and,
importantly, industry sources explicitly describe this as **a cycle, not a
line**: closure on one goal routinely triggers a new assessment, i.e., "done"
is not always terminal, it can loop back to a new intake for the same underlying
client/relationship. Case management is explicitly distinguished from CRM: CRM
tracks the *relationship* across many cases; the case management system owns one
*episode's* lifecycle and outcome. **Confirmed** (multiple independent
industry sources converge on this framing).

**Branching/relating/resurfacing.** The case-as-episode-within-a-longer-
relationship structure is a good model for the earlier consolidation point
(§1.2): the *thread* (case) is the finite episode; the *person/topic* (CRM
relationship) is the standing container that persists across many finished
threads and is where a closed thread's residue should attach.

**Implication.** Reinforces that "done" for a work-thread shouldn't sever it
from the standing topic/relation it belongs to — a closed case is filed *under*
the ongoing relationship, not detached from it, so a new related need
automatically finds the history of prior cases with that same person/topic.

Sources:
[Case Management Process: The Stages, Made Readable](https://www.sopact.com/use-case/case-management-process),
[CRM vs Case Management System](https://www.sopact.com/use-case/case-management-crm)

### 3.4 Kanban

**Model.** Anderson's five components: visual signals, columns (workflow stages),
WIP limits (cap on cards per column, forcing pull instead of push), a commitment
point, and a delivery point. Swimlanes add an orthogonal grouping dimension
(e.g., by type or priority) crossing the column stages. **Confirmed** (standard
documented practice).

**Branching/relating/resurfacing.** Kanban's contribution is **WIP limits as an
attention-management device**, not a relation type — it's the most directly
actionable idea for the "active" state specifically: capping how many threads can
be simultaneously "active" forces old resting threads to actually rest instead of
silently accumulating as background guilt, and forces explicit promotion
decisions (something must complete or be demoted before something new can be
pulled into "active").

**Implication.** If Tejas's threads get an "active" state, bounding how many can
be active at once (a personal WIP limit) is a well-evidenced technique for an
ADHD-prone tendency to have too many things nominally "in progress" — directly
addressed by Kanban's core mechanism, not just incidentally related.

Sources:
[Kanban (development) (Wikipedia)](https://en.wikipedia.org/wiki/Kanban_(development)),
[What is a kanban board? (Atlassian)](https://www.atlassian.com/agile/kanban/boards)

### 3.5 GTD — projects, next actions, someday/maybe

**Model.** Allen's system distinguishes: **projects** (any outcome needing more
than one action), **next actions** (the single physical, visible, doable-right-now
step toward a project — critically, phrased as a concrete cued action, not a
restatement of the goal), and a **someday/maybe list** (things you might want to
do, deliberately parked with no commitment). The **weekly review** is explicitly
described by practitioners and by Allen as the "critical factor for success" —
the single mechanism responsible for someday/maybe items and stalled projects
getting reconsidered at all, and its absence is the most commonly cited reason
people's GTD systems fail. **Confirmed** (well-documented, first-person and
practitioner-consensus sources).

**Branching/relating/resurfacing.** This is the clearest prior-art demonstration
of the exact structural failure mode §1.5/§1.6/§2.4 all predict: someday/maybe
is a *time-based, self-monitored* resurfacing mechanism (you must remember to run
the review), and GTD practitioners' most common complaint is precisely that this
step gets skipped and the list becomes inert. GTD's own "next action" concept is
the applied version of turning a vague intention into an event-cued one (§1.5):
a next action's whole purpose is to be triggerable by a concrete
context/cue ("@computer," "@calls") rather than requiring the person to
reconstruct what to do from a project name.

**Implication.** Someday/maybe-style "resting" only works if something *external*
does the reviewing on a cadence, or — better, given §1.5/§1.6 — if resurfacing is
event-cued rather than review-cued. This is strong independent convergent
evidence (from a completely different literature than the neuroscience) for the
same design conclusion.

Sources:
[The Complete Guide to Getting Things Done (Asian Efficiency)](https://www.asianefficiency.com/getting-things-done/),
[next action vs. someday maybe (GTD Forums)](https://forum.gettingthingsdone.com/threads/next-action-vs-someday-maybe.9879/)

---

## 4. Conversation structure

### 4.1 Discourse topic segmentation

**Model.** Computational-linguistics research treats a conversation as a sequence
of **topic segments**, detected via lexical-cohesion and cue-phrase features
(word repetition/similarity across nearby utterances, discourse markers signaling
a shift). Rhetorical Structure Theory (RST) is the most-used framework for
modeling how utterances relate to each other beyond simple sequence. Multi-party
conversation segmentation is harder than single-document segmentation because
topic isn't decided by one author and can be locally negotiated. **Confirmed**
(mature, decades-old computational-linguistics subfield).

**Implication.** This validates that "when does a new thread start" is not
inherently obvious even to computers doing it after the fact — automatic segment
detection is imperfect and would be a *heuristic assist* (flag "this looks like a
new topic, want a new thread?") rather than a fully automatic splitter. Any
"auto-detect a new thread should start here" feature should be framed as a
suggestion, not silent auto-splitting.

Sources:
[With a Little Help from my (Linguistic) Friends: Topic segmentation of multi-party casual conversations (ACL Anthology)](https://aclanthology.org/2024.codi-1.16/),
[Automatic Discourse Segmentation: Review and Perspectives](https://arxiv.org/pdf/2005.00468)

### 4.2 Email and Slack threading — usefulness and fragmentation

**Model/evidence.** Grevet et al., "Overload is overloaded: email in the age of
Gmail" (CHI 2014) found email overload persists even with Gmail's threaded
conversation view, and specifically that **forwarded threads are an antecedent
of overload** — threading doesn't eliminate the underlying problem, it changes
its shape. Independent commentary on Slack's threading feature (Fast Company's
account of Slack's own design process, and independent practitioner reviews)
converges on a specific usability failure: threading doesn't match how people
actually type in chat (a burst of short, incomplete messages with crosstalk from
others), so it's frequently unclear whether a given reply belongs in a thread or
the main channel, and both end up used inconsistently for the same
conversation. **Confirmed** (peer-reviewed CHI study for email; **Likely**
consensus practitioner observation for Slack specifically, not a peer-reviewed
study).

**Implication.** Two cautions for Tejas's "thread" primitive: (1) threading is
not a free fix for overload — a pile of many small, live threads can itself
become the overload problem (this argues for the Kanban-style WIP cap in §3.4 and
for cheap merging in §5); (2) the *unit of a thread* has to tolerate messy,
multi-message, interrupted human input (bursts, corrections, crosstalk) rather
than assuming one clean message = one thread-worthy idea, because that's
specifically where Slack's threading model breaks down in practice.

Sources:
[Overload is overloaded: email in the age of Gmail (Semantic Scholar)](https://www.semanticscholar.org/paper/Overload-is-overloaded:-email-in-the-age-of-Gmail-Grevet-Choi/6856844de29b747a662d40ca012d082e21b999ea),
[The Unexpected Design Challenge Behind Slack's New Threaded Conversations (Fast Company)](https://www.fastcompany.com/3067246/the-unexpected-design-challenge-behind-slacks-new-threaded-conversations)

### 4.3 Branching LLM chat UIs

**Model — ChatGPT Branch (OpenAI, 2025).** Hover any past message → "Branch in
new chat" → opens a new, independent chat that inherits all context up to that
point, letting the user pursue multiple divergent continuations from the same
origin without them interfering with each other; explicitly pitched for
exploring competing hypotheses in parallel from one shared starting point.
**Confirmed** (shipped, documented product feature).

**Model — Loom (socketteer/"Janus," ~2021).** A much more radical, exploratory
tree interface to raw base-model completions: every generation step creates
*n* sibling children of the current node, the full tree is visualized and
navigable, and the point of the tool is deliberately non-linear "multiversal"
exploration rather than arriving at one answer — it treats every possible
continuation as worth keeping and comparing, not just the chosen path. Distinct
audience/use-case from ChatGPT Branch: Loom is a research/exploration tool for
power users probing model behavior, not a mainstream product feature.
**Confirmed** (open-source, documented).

**Implication.** These are two different points on a spectrum relevant to
Tejas's own "should I branch this" moment: ChatGPT's model (branch = fork off an
independent continuation, origin context preserved, siblings mostly ignored
once you commit to one) fits a **work thread** that diverges into two
independent approaches. Loom's model (keep and compare *all* siblings visibly)
fits **idea threads**, where the value is in seeing multiple half-formed
directions side by side rather than committing to one. This is direct evidence
that "branching" isn't one behavior — the right UI differs by whether the branch
is a commitment (pick a path, discard/ignore the rest) or an exploration (keep
all paths visible and comparable).

Sources:
[OpenAI Launches Branching Feature](https://eu.36kr.com/en/p/3453602336593541),
[Loom: interface to the multiverse (generative.ink)](https://generative.ink/posts/loom-interface-to-the-multiverse/),
[socketteer/loom (GitHub)](https://github.com/socketteer/loom)

### 4.4 LLM agent conversational memory research

**Model/evidence.** Current research (LoCoMo benchmark, Maharana et al. 2024;
Mem0; A-Mem; HippoRAG/HippoRAG 2; MGRetrieval) treats agent memory as three
tiers — working memory (live context window), episodic memory (record of past
interactions), semantic memory (distilled facts) — mirroring the human
episodic→semantic distinction in §1.2 almost exactly. Key documented failure
mode: even long-context models suffer "lost-in-the-middle" degradation, and raw
context-window extension is *not* sufficient for reliable very-long-term recall;
retrieval accuracy for old, buried information degrades sharply regardless of
window size. Graph-based retrieval (HippoRAG, using personalized PageRank over an
entity/passage graph — an explicit computational implementation of spreading
activation, §1.1) and reflective/guided retrieval strategies (MGRetrieval) are
the current state of the art for improving multi-hop associative recall in
agents. **Confirmed** (active, well-published research area; specific numeric
benchmarks are Likely-representative but a fast-moving field as of the
knowledge cutoff).

**Implication.** Directly validates that "just put everything in a bigger context
window" is not an adequate resurfacing mechanism for an agent-based version of
Tejas's threads — the field's own frontier is graph/relation-based retrieval,
which is architecturally the same conclusion as §1.1's spreading activation and
§2.6's Roam backlinks: relevant resurfacing needs an explicit, queryable relation
graph between threads, not reliance on a bigger buffer or a smarter single
search query.

Sources:
[Evaluating Very Long-Term Conversational Memory of LLM Agents (arXiv, LoCoMo)](https://arxiv.org/pdf/2402.17753),
[MGRetrieval: Memory-Guided Reflective Retrieval (arXiv)](https://arxiv.org/pdf/2605.27437),
[A-Mem: Agentic Memory for LLM Agents (arXiv)](https://arxiv.org/pdf/2502.12110)

---

## 5. Stigmergic/emergent organization and tags-vs-folders

### 5.1 Wikipedia article splitting and stigmergic coordination

**Model.** Wikipedia's own splitting guideline: when an article/section grows
disproportionately, it should split into a new article, with the norm being to
open discussion on the Talk page first for sensitive cases, but empirically **the
majority of actual article edits are not accompanied by any Talk-page
discussion at all** — coordination happens indirectly, through the artifact
itself (an editor sees the current state of the article and reacts to it, rather
than reading a plan and discussing it first). This is the empirical basis for
describing Wikipedia's growth as **stigmergic**: coordination through traces
left in a shared environment, not through explicit communication. **Confirmed**
(cited empirical research on edit/Talk-page co-occurrence rates; the "Splitting"
guideline itself is Wikipedia's own documented policy).

**Implication.** This is a real-world existence proof that **splitting (spawning
a new thread from an overloaded one) can be driven by the artifact's own growing
size/shape**, not only by explicit human decision — a thread that's clearly
accreted multiple distinct sub-topics is itself the signal, and a system could
flag "this thread has grown three distinct clusters of content, consider
splitting" the way Wikipedia editors visually/editorially notice an
overloaded article, without requiring the equivalent of a Talk-page discussion
for the ordinary case.

Sources:
[Wikipedia:Splitting](https://en.wikipedia.org/wiki/Wikipedia:Splitting),
[Full article: Stigmergy in Open Collaboration: An Empirical Investigation Based on Wikipedia](https://www.tandfonline.com/doi/full/10.1080/07421222.2023.2229119)

### 5.2 Tags vs. folders (Bergman) and Keeping Found Things Found (Jones)

**Model — Bergman.** Two controlled studies (a Gmail folder-vs-tag field study
with 75 participants; a Windows 7 tagging study with 23 participants) found a
**strong, consistent preference for folders over tags for both storage and
retrieval**, and — notably — a gap between stated preference and actual behavior:
people *say* they like tags when asked directly, but revert to folders in
practice. Proposed cognitive explanation: folder navigation is incremental,
visually cued, and draws on procedural/spatial memory (older, more automatic);
tag-based retrieval depends on declarative/effortful recall and search, which is
more cognitively costly. **Confirmed** (peer-reviewed, JASIST 2013, with a
direct empirical behavior/preference gap finding, which is the most
actionable/non-obvious part of this result).

**Model — Jones.** *Keeping Found Things Found* is the foundational PIM
textbook framing "keeping" (how you file/organize something) and "finding" (how
you retrieve it later) as two *tightly coupled* problems that must be designed
together — a system that makes filing easy but retrieval hard (or vice versa)
fails as a whole, even if each half looks fine in isolation. **Confirmed**
(foundational, widely cited academic text, University of Washington PIM
research group).

**Implication.** This is a direct, evidence-based caution against relying on
freeform tags as the *primary* organizing/relating mechanism for threads, despite
tags' apparent flexibility — real usage data says people navigate better via a
small number of stable, browsable structural categories (closer to Kanban
columns or PARA's four buckets) than via open tag clouds, even when they *say*
they'd prefer tags. Jones's framing means any capture UI (keeping) must be
evaluated jointly with its resurfacing UI (finding) — a system can't be judged as
"good capture" alone.

Sources:
[Folder versus tag preference in personal information management (Wiley/JASIST)](https://onlinelibrary.wiley.com/doi/abs/10.1002/asi.22906),
[Keeping Found Things Found (Goodreads/publisher summary)](https://www.goodreads.com/book/show/2135805.Keeping_Found_Things_Found)

---

## 6. Synthesis — a thread model for Tejas's system

**Confidence note on this section as a whole: this is a proposed design
synthesis, not a settled finding. Individual load-bearing claims are marked;
the overall architecture is my proposal, offered at Medium confidence, for
Tejas to react to — not a recommendation to be treated as decided.**

### 6.1 Is "thread" the right single primitive? — No; use one identity, two behavior profiles

The research converges on a clean answer to the framing question: **don't split
into two separate primitives with separate storage/relations (that recreates the
GitHub "an issue can only have one type of parent" rigidity, §3.1, and the
CRM-vs-case-management split, §3.3, without needing to)**. Instead, give every
thread one stable identity and relation graph (per Luhmann's permanent-address
lesson, §2.1, and the architecture-lessons principle that a value needing two
consumers should have one home, not two copies) — but let a thread carry a
**mode** that changes which behaviors are active, closer to Ahrens' fleeting →
literature → permanent tiers (§2.3) or PARA's Project-vs-Area distinction (§2.4)
than to two unrelated data models. A work thread and an idea thread are the same
kind of object at different points on the same lifecycle, not two databases.
**Confidence: Medium** — this is a design opinion synthesizing multiple
prior-art patterns, not a directly tested claim.

### 6.2 Proposed lifecycle states

- **captured** — the Ahrens "fleeting note" (§2.3) / GTD inbox equivalent: cheap,
  unfiled, no relation work done yet. Everything starts here, including a
  one-line idea typed mid-conversation.
- **incubating** — promoted out of raw capture, given at least one relation
  (spawned-from or related-to) and enough content to be findable, but not
  claiming any of the user's active attention. This is PARA's Resource/Area
  (§2.4) and GTD's someday/maybe (§3.5) — but see §6.4, it must NOT rely on
  manual review to resurface, per §1.5/§1.6/§3.5's convergent evidence.
- **active** — currently claiming attention; bounded by a personal WIP-style cap
  (§3.4) so "active" stays meaningfully small.
- **waiting** — active work blocked on something external (an answer, another
  thread, a person) — distinct from incubating because it has a known trigger
  condition and known owner, closer to the issue-tracker "blocked" relation
  (§3.1) than to a parked idea.
- **resting** — was active or incubating, no longer being pursued right now, but
  deliberately not closed — closer to Kanban's implicit "off the board" than to
  archive; still eligible for cue-based resurfacing.
- **done** — a work thread's terminal completion state.
- **merged/duplicate** — terminal, but (per the git-merge lesson, §3.2, not the
  issue-tracker duplicate-as-deletion pattern) preserves both origins' content
  and provenance rather than deleting the losing side.
- **archived** — the episodic→semantic endpoint (§1.2): content has been distilled
  into a standing Area/topic (the "schema"), and the specific episode is kept for
  provenance but is not expected to resurface on its own again.

### 6.3 Proposed relations (typed, not one generic "linked")

Following §3.1's Linear/GitHub lesson that collapsing all relations into one
"linked" bucket loses information needed for correct cascade behavior:

- **spawned-from** (asymmetric, single origin, like a sub-issue/Folgezettel) — a
  transclusion-style live reference back to the originating fragment (§2.5), not
  a frozen copy, so walking back from the child always shows exactly what
  triggered it even if the parent has since moved on.
- **related-to** (symmetric, weak-tie, many-to-many, like Roam backlinks §2.6 /
  Linear "related" §3.1) — the substrate spreading activation (§1.1) runs over;
  this is what powers resurfacing, not a manually curated list.
- **blocks / waiting-on** (asymmetric, has a known resolution condition, §3.1) —
  distinct from related-to because it changes *state*, not just *findability*.
- **duplicate-of / merged-into** (terminal, git-merge-style reconciliation, §3.2)
  — content combines, both provenances preserved, never a silent delete.

### 6.4 How a resting thread resurfaces — cue-based, not calendar-based

This is the best-evidenced single conclusion in the whole brief, converging from
three independent literatures: prospective-memory research generally (§1.5),
ADHD-specific prospective-memory deficits (§1.6), and the empirical failure mode
of every manual-review-dependent system studied here (GTD someday/maybe, §3.5;
PARA Resources/Archive, §2.4). **A resting/incubating thread must not depend on
the user remembering to check back on a schedule.** It should resurface when an
**external, event-based cue** recurs: a related thread becomes active (spreading
activation over the related-to graph, §1.1/§2.6/§4.4), a similar topic/person is
mentioned again (context-dependent retrieval, §1.4, tempered by that effect's
weak/non-replicating evidence — lean on *semantic* similarity, which has much
stronger modern support via graph-retrieval research, §4.4, rather than literal
environmental-context matching), or the standing Area/topic it's filed under gets
opened. The system, not the user, should own the "monitoring" half of
prospective memory (§1.5) — the user only needs to recognize and act on the cue
once it's surfaced (the pathway ADHD leaves comparatively intact, §1.6).
**Confidence: High** on the underlying claim ("cue-based beats calendar-based for
this population"); **Medium** on the specific implementation (graph-based
relatedness as the cue source) — that's a design choice, not a tested finding for
this exact application.

### 6.5 Branching and merging behavior, concretely

Branching should default to the "commitment" mode (ChatGPT Branch, §4.3): a
spawned thread gets the full context of its origin and then proceeds
independently, because most of what Tejas spawns mid-work (a noticed bug, a
tangent) is meant to be pursued separately, not compared side-by-side. Reserve
the "keep all siblings visible" (Loom, §4.3) behavior specifically for the
incubating/idea mode, where the value is genuinely in holding several half-formed
variants visible at once rather than committing early. Merging should never be
silent deletion of the "loser" (the issue-tracker duplicate pattern, §3.1, taken
naively) — it should behave like a git merge (§3.2): a new state that records
both parents, so nothing in either thread's history becomes unreachable.

### 6.6 What plays the role of "schema" / consolidation

Per §1.2/§2.4/§3.3, without a standing container above individual threads,
"done" and "archived" threads just accumulate as inert episodes with no way for
their *pattern* to resurface later — exactly PARA's documented Resources/Archive
failure mode (§2.4). Tejas's system needs the equivalent of PARA's Areas / a
case-management "relationship" (§3.3): a small number of standing topics that
threads attach to, which is what a later related thread should actually search
against first (spreading activation from the topic, not a flat search over every
historical thread). This is the concrete mechanism for "the pattern generalizes
even after the specific episode fades," matching the neuroscience in §1.2.

### 6.7 What remains genuinely uncertain

- Whether semantic/topical cue-matching (favored here per §1.4's replication
  caveat) will *feel* right to Tejas specifically, versus some role for literal
  context (what app/project was open) — this is an empirical question about his
  own usage, not resolvable from the literature alone. **Unknown.**
- The right personal WIP cap for "active" (§3.4) — Kanban gives the mechanism,
  not a number; that has to be tuned against his own real threads-in-flight.
  **Unknown.**
- Whether automatic split-detection (§5.1's Wikipedia-inspired "this thread
  looks overloaded, consider splitting" flag) would be a helpful nudge or an
  annoying false-positive generator for a fast-moving personal thread list —
  no direct evidence either way for this scale/use case. **Unknown.**
