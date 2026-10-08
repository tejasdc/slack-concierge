# Minsky's agents, K-lines, frames and scripts — and how they differ from routines, processes and workflows

Research method: primary-source reading. The book text is from the Minsky-authorized web
archive of *The Society of Mind* (1986) mirrored at `aurellem.org/society-of-mind/`
(section URLs `som-<chapter>.<section>.html`, e.g. `som-8.1.html` = section 8.1), fetched
directly and cleaned of HTML. Every SOM quote below is tagged with its section number,
which is Minsky's own numbering (confirmed against the book's own glossary, which cites
itself by section). *The Emotion Machine* (2006) quotes are from Minsky's own public
draft mirror (`web.mit.edu/dxh/www/marvin/web.media.mit.edu/~minsky/eb3.html`), section
numbers as Minsky wrote them (`§3-5` etc.). Brooks 1991 is from the published PDF at
`people.csail.mit.edu/brooks/papers/representation.pdf`, text-extracted directly.
Secondary sources (Wikipedia, blog summaries, search-engine syntheses) are explicitly
labeled as such and used only to corroborate or to fill a gap where the primary text was
unreachable — see the note on the 1980 K-lines paper below.

**One access gap, stated up front, per the research-framing rule of not papering over a
blocked source:** Minsky's original 1980 Cognitive Science paper / MIT AI Memo 516,
"K-Lines: A Theory of Memory," could not be fetched directly — MIT DSpace
(`dspace.mit.edu/handle/1721.1/5739`) serves the PDF behind an AWS WAF bot-check
(CAPTCHA) that blocked `curl`, a `r.jina.ai` proxy, and the WebFetch tool alike; Wiley's
paywalled reprint (`onlinelibrary.wiley.com/doi/10.1207/s15516709cog0402_1`) returned 403.
What follows on K-lines instead draws on *The Society of Mind* chapter 8, "A Theory of
Memory" (1986), which is Minsky's own later, expanded restatement of the same paper in
his own words, including the same core mechanism, terminology, and (per section 8.1) the
same bicycle-repair example attributed to the same source (Kenneth Haase). Where the 1980
paper is known to differ from or predate the 1986 book — notably, "polynemes" and
"isonomes" are *not* in the 1980 paper; Wikipedia's K-line article says Minsky introduced
polynemes/micronemes only "in a 1991 response" and they appear in SOM chapters 19 and 22
— this is flagged. Confidence on 1980-paper-specific claims (vs. the 1986 book) should be
read as *Possible* rather than *Confirmed* unless marked otherwise.

---

## 1. Agents and agencies

### The core claim: agents are mindless; intelligence is a property of the society

Minsky's agent is explicitly defined — not a loose metaphor — in the book's own glossary:

> "**Agent** (1.4) Any part or process of the mind that by itself is simple enough to
> understand — even though the interactions among groups of such agents may produce
> phenomena that are much harder to understand." — Glossary, s.v. "Agent"

> "**Agency** (1.6) Any assembly of parts considered in terms of what it can accomplish as
> a unit, without regard to what each of its parts does by itself." — Glossary, s.v.
> "Agency"

The opening section states the thesis directly:

> "To explain the mind, we have to show how minds are built from mindless stuff, from
> parts that are much smaller and simpler than anything we'd consider smart. Unless we
> can explain the mind in terms of things that have no thoughts or feelings of their own,
> we'll only have gone around in a circle." (1.1, "The agents of the mind")

And the book's title-giving sentence:

> "This is the subject of our book... But once we see the mind as a society of agents,
> each answer will illuminate the rest." (1.1)

This is the "seen from outside vs. agents inside" distinction the brief asks about: an
**agency** is a label applied by an observer to what a group of agents *accomplishes as a
unit* ("Any assembly of parts considered in terms of what it can accomplish as a unit,
without regard to what each of its parts does by itself" — glossary, "Agency"); the
**agents** inside it have no access to, and no need to understand, that external
description. A single agent (e.g., `Find`, `Grasp`) does one small mechanical thing and
has no model of the goal its activity serves.

### The Builder example

Minsky's running example for the whole first third of the book is a child stacking
blocks:

> "Imagine a child playing with blocks, and imagine that this child's mind contains a
> host of smaller minds. Call them mental agents. Right now, an agent called Builder is
> in control. Builder's specialty is making towers from blocks... But building a tower
> is too complicated a job for any single, simple agent, so Builder has to ask for help
> from several other agents... In fact, even to find another block and place it on the
> tower top is too big a job for any single agent. So Add, in turn, must call for other
> agents' help." (1.4, "The world of blocks")

This cascades: `Builder` calls `Begin`, `Add`, `End`; `Add` calls `Find`, `Put`, `Get`;
these call `Move`, `Grasp`, `See`. Minsky's point is explicitly about where competence
lives:

> "As an agent, Builder does no physical work but merely turns on Begin, Add, and End...
> Thus Builder is like a high-level executive, far removed from those subordinates who
> actually produce the final product. Does this mean that Builder's administrative work
> is unimportant? Not at all. Those lower-level agents need to be controlled." (3.3,
> "hierarchies")

But Minsky immediately undercuts the human-organization analogy he just invited:

> "How much of ordinary human thought has Builder's character? The Builder we described
> is not much like a human supervisor. It doesn't decide which agents to assign to which
> jobs, because that has already been arranged. It doesn't plan its future work but
> simply carries out fixed steps until End says the job is done." (3.3)

This matters for the brief's later question (agent vs. routine): *Builder itself*, as
specified in chapter 3, is closer to a fixed routine than to what we'd now call an
autonomous agent — the real "agent-ness" in Minsky's sense is the property of the whole
society, not of any one named box in the diagram. Minsky is explicit that the analogy to
human bosses/workers must not be stretched (3.3), and that hierarchy is not even the
general case — see heterarchies below.

### Managers and conflict resolution; the noncompromise principle

Minsky pairs `Builder` with `Wrecker` (a demolition agent) to introduce conflict:

> "Suppose Wrecker gets aroused, but there's nothing in sight to smash. Then Wrecker will
> have to get some help — by putting Builder to work, for example. But what if, at some
> later time, Wrecker considers the tower to be high enough to smash, while Builder wants
> to make it taller still? Who could settle that dispute?" (3.1, "conflict")

His answer is that conflicts are not negotiated locally by the agents in conflict — they
are resolved by escalation to a shared manager, and *unresolved* conflict weakens that
manager's own standing against its rivals:

> "**The Principle of Noncompromise**: The longer an internal conflict persists among an
> agent's subordinates, the weaker becomes that agent's status among its own competitors.
> If such internal problems aren't settled soon, other agents will take control and the
> agents formerly involved will be dismissed." (3.2, "Noncompromise")

And in the glossary, more tersely:

> "**Noncompromise Principle** (3.2) The idea that when two agencies conflict it may be
> better to ignore them both and yield control to yet another, independent agency."

Minsky traces this upward explicitly: unresolved `Builder`/`Wrecker` conflict weakens
their shared supervisor `Play-with-Blocks`, which lets its sibling rivals
`Play-with-Dolls` or `Play-with-Animals` take over; unresolved conflict at that level
weakens `Play` itself, letting `Eat` or `Sleep` seize control (3.1, 3.2). Crucially, he
is explicit that *tiny* agents cannot negotiate the way human organizations do — only
larger agencies can:

> "We should not try to find a close analogy between the low-level agents of a single
> mind and the members of a human community. Those tiny mental agents simply cannot know
> enough to be able to negotiate with one another... Only larger agencies could be
> resourceful enough to do such things." (3.2)

He also shows that hierarchy is not universal — some agents need each other both ways at
once, which a strict tree cannot represent:

> "A hierarchical society is like a tree in which the agent at each branch is exclusively
> responsible for the agents on the twigs that branch from it... But hierarchies do not
> always work. Consider that when two agents need to use each other's skills, then
> neither one can be on top... At such a moment, Move would be working for See, and See
> would be working for Move, both at the same time. This would be impossible inside a
> simple hierarchy." (3.4, "Heterarchies")

**Confidence: Confirmed** (direct primary-source quotes with section numbers, cross-checked
against the book's own glossary).

---

## 2. K-lines (knowledge-lines)

### The mechanism: a K-line is a list of which agents were active

> "The theory is based on the idea of a type of agent called a Knowledge-line, or K-line
> for short. Whenever you get a good idea, solve a problem, or have a memorable
> experience, you activate a K-line to represent it. A K-line is a wirelike structure
> that attaches itself to whichever mental agents are active when you solve a problem or
> have a good idea. When you activate that K-line later, the agents attached to it are
> aroused, putting you into a mental state much like the one you were in when you solved
> that problem or got that idea." (8.1, "k-lines: a theory of memory")

Glossary definition, with its own citation back to the 1980 paper:

> "**K-Line** (8.1) The theory that certain kinds of memories are based on turning on
> sets of agents that reactivate one's previous partial mental states. This idea was
> first described in my essay *K-lines: A Theory of Memory*, Cognitive Science, 4(2),
> April 1980."

### The bicycle example (verified — it is in the primary text, attributed, not Minsky's own invention)

> "Here is another image of how K-lines work, suggested by Kenneth Haase, a student at
> the MIT Artificial Intelligence Laboratory who had a great deal of influence on this
> theory. You want to repair a bicycle. Before you start, smear your hands with red
> paint. Then every tool you need to use will end up with red marks on it. When you're
> done, just remember that red means 'good for fixing bicycles.' Next time you fix a
> bicycle, you can save time by taking out all the red-marked tools in advance. If you
> use different colors for different jobs, some tools will end up marked with several
> colors. That is, each agent can become attached to many different K-lines." (8.1)

This nails the brief's request to "verify" the bicycle example: it is real, it is in
section 8.1, and it is explicitly credited to Kenneth Haase rather than being Minsky's
own metaphor — useful because it shows K-lines as *reusable, overlapping tags* on
agents/tools, not as a single linear memory trace.

### K-lines as partial mental states

Minsky defines a precise vocabulary for "how much of the mind is on" at once:

> "A **total state of mind** is a list that specifies which agents are active and which
> are quiet at a certain moment. A **partial state of mind** merely specifies that
> certain agents are active but does not say which other agents are quiet." (8.4,
> "partial mental states")

> "Notice that according to this definition, a mind can have exactly one total state at
> any moment, but it can be in many partial states at the same time — because partial
> states are incomplete descriptions." (8.4)

This is the load-bearing idea for "K-lines as partial mental states": reactivating a
K-line doesn't restore your *whole* mind to some past instant (impossible — "it would
have to be larger than itself," 6.5), it re-arouses a *subset* of agents, which then
coexists and competes/cooperates with whatever else is currently active (8.2,
"re-membering"). Two K-lines can also collide inside the same agency: "when you try to
imagine a round square, your agents for round and square are forced to compete to
control the same set of shape-describing agents. If the conflict is not settled soon,
noncompromise may eliminate both" (8.4) — the noncompromise principle from §1 recurs here
as the collision-resolution rule for memory itself, not just for action.

### Level-bands: why only a middle level gets reactivated

This is Minsky's answer to why remembering "Jack is flying his kite" doesn't either (a)
recall nothing, or (b) flood you with every possible kite-fact:

> "The basic idea is simple: we learn by attaching agents to K-lines, but we don't attach
> them all with equal firmness. Instead, we make strong connections at a certain level of
> detail, but we make weaker connections at higher and lower levels... Whenever we turn
> on this K-line, it tries to activate all these agents, but those near the fringes are
> attached as though by twice-used tape and tend to retreat when other agents challenge
> them." (8.5, "level-bands")

He generalizes the mechanism from *descriptions* of things to *processes* for doing
things, using a second return of the Builder example — now grown up:

> "let's now return to Play-with-Blocks — but this time let's suppose that our child has
> grown to maturity and wants to build a real house. Which agents from the old
> building-society can still be applied to this new problem?... House Builder won't have
> so much use for Tower Builder's highest-level agents like Begin and End — because these
> were specialized for making towers. Nor will it have much use for Builder's lowest-level
> skills, like those in Grasp... But most of the skills embodied in Builder's middle
> level-bands will still apply. These seem to embody the sort of knowledge that is most
> broadly and generally useful, whereas uppermost and lowest level-bands are more likely
> to be based on aspects of the problem that are specific to an older goal or to the
> particular details of the original problem." (8.6, "levels")

And the two-sided reason the fringes must be weak, stated as two named failure modes:

> "**Lower Band**: Beyond a certain level of detail, increasingly complete memories of
> previous situations are increasingly difficult to match to new situations." /
> "**Upper Band**: Memories that arouse agents at too high a level would tend to provide
> us with goals that are not appropriate to the present situation." (8.7, "fringes")

— with the extreme case spelled out: "Suppose some memory were so complete that it made
you relive, in every detail, some perfect moment of your past. That would erase your
present you — and you'd forget what you had asked your memory to do!" (8.7). The
level-band theory is the single most directly reusable idea in this whole research
question for a system of "threads re-summoning sessions": too-literal reactivation of an
old session's exact state is a failure mode, not the goal; a workable K-line should
reactivate a *band* of the old context, not all of it.

### Polynemes and isonomes (book terminology, post-dates the 1980 paper)

> "**Polyneme** (19.5) An agent that arouses different activities, at the same time, in
> different agencies — as a result of learning from experience." — glossary
> "Your word-agent for the word apple must be a polyneme because it sets your agencies
> for color, shape, and size into unrelated states that represent the independent
> properties of being red, round, and apple-sized... Because polynemes, like politicians,
> mean different things to different listeners, each listener must learn its own,
> different way to react to that message." (19.5, "polynemes")

> "**Isonome** (22.1) A signal or pathway in the brain that has similar effects on
> several different agencies." — glossary
> "An isonome has a similar, built-in effect on each of its recipients. It thus applies
> the same idea to many different things at once. A polyneme has different, learned
> effects on each of its recipients. It thus connects the same thing to many different
> ideas." (22.2, "isonomes")

> "Polynemes are permanent K-lines. They are long-term memories. Pronomes are temporary
> K-lines. They are short-term memories." (22.1, "pronomes and polynemes") — a **pronome**
> is Minsky's term for a short-lived, reassignable K-line, analogous to a pronoun ("it",
> "her") that temporarily points at whatever is currently relevant (21.1, 21.7).

These three terms did not exist in the 1980 paper (per the K-line Wikipedia article,
polynemes/micronemes appear "in a 1991 response" and are elaborated in the 1986 book) —
**Confidence: Confirmed for book usage, Possible/Unverified for exact 1980-paper
wording**, given the access gap stated above.

### Memorizers

> "**Memorizer** (19.5) An agent that can reset an agency into some previously useful
> state. See Recognizer and Distributed Memory." — glossary

> "If each polyneme were connected to a K-line in each agency, each of those K-lines
> would need only to learn what partial state to arouse inside its agency. The drawing
> below suggests that those K-lines could form little memorizers next to the agencies
> that they affect. Thus, memories are formed and stored close to the places where they
> are used." (19.5)

Minsky later generalizes this into a structural claim about *all* agencies, not just
memory ones: "not only frames but agencies in general might be organized in the form of
agents sandwiched between recognizers and memorizers" (24.9, "recognizers and
memorizers") — a **recognizer** is explicitly "the opposite of a K-line — since instead
of arousing a certain state of mind, it has to recognize when a certain state of mind
occurs" (24.9).

**Confidence: Confirmed** for the Society of Mind restatement (direct quotes, section
numbers verified against the glossary's self-citations). **Possible** for claims specific
to the original 1980 paper's wording, bicycle example framing, or figures, since that PDF
could not be retrieved (see access-gap note above); the book's chapter 8 is presented by
Minsky as "the next few sections explain a theory of memory" built on exactly this
mechanism, so the conceptual content is very likely unchanged, but exact 1980 phrasing is
unverified.

---

## 3. Frames, trans-frames, and scripts (Schank & Abelson)

### Frames (Minsky 1974/1975)

The glossary traces frames to Minsky's earlier, separate paper:

> "**Frame** (24.2) A representation based on a set of terminals to which other
> structures can be attached. Normally, each terminal is connected to a default
> assumption, which is easily displaced by more specific information. Other ideas about
> frames that are not discussed within this book were published in my chapter 'A
> Framework for Representing Knowledge,' in *Psychology of Computer Vision*, P. H.
> Winston (ed.), McGraw-Hill, 1975." (the chapter itself circulated as an MIT AI Memo in
> 1974, hence "Minsky 1974" in the literature)

The book's own exposition:

> "A frame is a sort of skeleton, somewhat like an application form with many blanks or
> slots to be filled. We'll call these blanks its terminals... To represent a particular
> chair or person, we simply fill in the terminals of the corresponding frame with
> structures that represent, in more detail, particular features... It can be a K-line,
> polyneme, isonome, memory-control script, or, best of all, another frame." (24.2,
> "frames of mind")

Default values live on unfilled terminals:

> "Default assumptions fill our frames to represent what's typical... As soon as you hear
> a word like person, frog, or chair, you assume the details of some typical sort of
> person, frog, or chair." (24.2)

This is explicitly the *same* mechanism as the level-band fringe from chapter 8 — Minsky
says so directly: "It is no surprise that frames share so many properties of K-lines,
since the terminals of frames themselves will lie in level-bands near the K-lines whose
fringes represent our expectations and default assumptions." (24.4, "default
assumptions")

### Trans-frames

A trans-frame represents an event with role-slots ("pronomes") rather than a static
object:

> "Consider, for example, a Trans-frame that is filled in to represent this sentence:
> 'Jack drove from Boston to New York on the turnpike with Mary.' Whenever this
> particular frame is active, if you wonder about the Destination of that trip, you'll
> almost instantly think of New York... According to this simple scheme, a frame could
> consist of little more than a collection of AND-agents, one for each of the frame's
> pronome terminals!" (24.3, "How trans-frames work")

### Scripts — Minsky's own, explicit comparison to Schank & Abelson

This is the single most load-bearing primary quote for the brief's "script vs. agent"
question, and it is a glossary entry, i.e., Minsky's own considered, compact definition:

> "**Script** (13.5) A sequence of actions produced so automatically that it can be
> performed without disturbing the activities of many other agencies. The action script
> in section 21.7 accomplishes this by eliminating all the higher-level managers like Put
> and Get. A script-based skill tends to be inflexible because it lacks bureaucracy; one
> gains speed by removing higher-level anchor points but loses access to alternatives
> when things go wrong; script-based experts run the risk of becoming inarticulate. The
> book by Roger Schank and Robert Abelson, *Scripts, Goals, Plans and Understanding*,
> Erlbaum Associates, 1977, speculates about the human use of scripts." — glossary, s.v.
> "Script"

Minsky's worked example (section 21.7) is a concrete demonstration of exactly this
trade-off. He first builds a literal, hard-wired script for "put the apple in the pail":

> "if you were to play back the Trans-script shown above, your arm would find and put a
> second apple in that pail — without invoking any higher-level agencies at all!
> However, this script has a dreadful limitation: it will work only to put apples into
> pails." (21.7, "generalizing with pronomes")

— and then shows the fix is to route the script through **pronomes** (temporary,
reassignable K-lines) rather than hard-coded objects:

> "We could do that by dividing the process into two scripts: a pronome-assignment
> script and an action script... Now notice that the action script never actually
> mentions the apple or pail at all but refers only to the pronomes that represent them.
> Thus the same action script will serve as well for putting a block into a box as for
> putting an apple into a pail!" (21.7)

So, in Minsky's own system: a **script** is what you get once an **agency** (a society of
managers, like `Builder`→`Add`→`Find`/`Put`/`Get`) has been compiled down into a fixed,
fast, un-reflective sequence that "eliminat[es] all the higher-level managers" — speed
and automaticity are bought by giving up the escalation/negotiation/noncompromise
machinery that made it an *agency* in the first place. The direct statement of this
trade from chapter 13's worked example (a child learning to draw a person):

> "The people we call experts seem to exercise their special skills with scarcely any
> thought at all — as though they were simply reading preassembled scripts. Perhaps when
> we practice to improve our skills, we're mainly building simpler scripts that don't
> engage so many agencies." (13.5, "learning a script")

**Relation to Schank & Abelson's restaurant script (1977).** Schank and Abelson's own
restaurant script is a fixed sequence of named "scenes" — Entering, Ordering, Eating,
Exiting — each decomposed into stereotyped sub-actions (customer enters, finds a table,
picks up the menu, orders, is served, eats, pays, leaves), written in Schank's
Conceptual-Dependency primitives (PTRANS for physical transfer, ATRANS for abstract/
ownership transfer, INGEST for eating) [secondary source: search-engine synthesis of
Schank & Abelson 1977, corroborated by multiple academic summaries including a
ResearchGate reproduction of the original script diagram; the original monograph itself
was not directly fetched for this research pass]. Schank and Abelson's own framing (as
widely summarized) is that a script is knowledge of a *stereotyped sequence of events*
used to fill in and predict the unstated steps of a story — it is a *content* structure
for prediction/comprehension, built at the level of "what normally happens at a
restaurant," not a claim about the architecture of mind in general. Minsky's script is
narrower and more mechanistic: it is what one particular agency becomes after repetition
strips out its internal managers, and he cites Schank & Abelson by name as the place to
read more about "the human use of scripts" — i.e., he treats their script as a special,
degenerate case of a more general agent/society architecture, not as a competing theory
of mind.

**So, concretely: script vs. agent vs. K-line, in Minsky's own vocabulary:**
- An **agent** is a standing part of the architecture (`Builder`, `Find`, `Grasp`) that
  can always, in principle, be called again and can participate in different jobs.
- A **script** is a *compiled, flattened trace through* a set of agents — fast,
  reflexive, but blind to anything outside its fixed path (no escalation, no
  noncompromise negotiation, because the managers that would do that have been removed).
- A **K-line** is the thing that *reactivates* a group of agents into a past partial
  state; a script can be understood as a K-line-driven replay that has been additionally
  stripped of its higher-level managers, trading generality for speed (13.5, 21.7).

**Confidence: Confirmed** for Minsky's definitions and his own Schank/Abelson citation
(primary source, glossary + direct text). **Confirmed-secondary** for the restaurant
script's exact scene structure (multiple converging secondary summaries, original
monograph not independently re-verified in this pass).

---

## 4. A-brain/B-brain, censors/suppressors, difference-engines

### B-brains: an overseer that doesn't understand the world

> "There is one way for a mind to watch itself and still keep track of what's happening.
> Divide the brain into two parts, A and B. Connect the A-brain's inputs and outputs to
> the real world — so it can sense what happens there. But don't connect the B-brain to
> the outer world at all; instead, connect it so that the A-brain is the B-brain's
> world! Now A can see and act upon what happens in the outside world — while B can see
> and influence what happens inside A." (6.4, "B-Brains")

Minsky gives a list of exactly the kind of health-monitoring judgments an overseer makes
without understanding the underlying task:

> "A seems disordered and confused. Inhibit that activity. A appears to be repeating
> itself. Make A stop. Do something else. A does something B considers good. Make A
> remember this. A is occupied with too much detail. Make A take a higher-level view. A
> is not being specific enough. Focus A on lower-level details." (6.4)

And the key claim for an "overseer agent that doesn't need domain understanding" design:

> "This is because a B-brain could learn to play a role somewhat like that of a
> counselor, psychologist, or management consultant, who can assess a client's mental
> strategy without having to understand all the details of that client's profession.
> Without having any idea of what A's goals are, B might be able to learn to tell when A
> is not accomplishing them but only going around in circles or wandering, confused
> because certain A-agents are repeating the same things over and over again." (6.4)

Minsky flags the failure mode directly — a worked example of a B-brain actively
*hurting* a legitimate repetitive task because it misreads repetition as confusion:

> "if A had the goal of adding up a long column of numbers, B might start to interfere
> with this because, from B's point of view, A appears to have become trapped in a
> repetitive loop. This could cause a person accustomed to more variety to find it
> difficult to concentrate on such a task." (6.4)

And he explicitly generalizes past two levels: "there is no reason to stop with only two
levels; we could connect a C-brain to watch the B-brain, and so on." (6.4) — the glossary
entry reinforces the "doesn't understand the world" property as definitional: "**B-Brain**
(6.4) Any part of the brain connected not to the outside world, but only to another part
of the same brain. Like a manager, a B-brain can supervise an A-brain without
understanding either how the A-brain works or the problems with which the A-brain is
involved."

Chapter 6.5 connects B-brains directly back to K-lines as the recording mechanism an
overseer would need: "We'll conjecture that your brain contains a host of agents called
K-lines, which you can use to make records of what some of your brain-agents are doing at
a certain moment." (6.5, "Frozen reflection")

**The Emotion Machine (2006) extends this**, without renaming A/B-brain but elaborating
the overseer's internal taxonomy into named "Critics" (draft chapter III, §3-5,
"Correctors, Suppressors, and Censors" — Minsky's public draft, `eb3.html`):

> "we'll conjecture that our minds accumulate resources that we shall call Critics —
> each of which learns to recognize a certain particular kind of mistake... **A Corrector
> Critic** warns you that you have started to do something dangerous... But such a
> warning may come too late. **A Suppressor** can warn you of a danger you face, and can
> veto an action that's being considered, to stop you from acting before it's too late...
> **A Censor** works early enough to keep you from having that dangerous thought — so it
> never even occurs to you to put your finger into that flame. A Censor can work so
> effectively that you don't even know that it's working for you." (Emotion Machine,
> §3-5)

> "Suppressors are safer than Correctors are, but both of them tend to slow you down,
> while you think of something else to do. However, Censors waste no time at all,
> because they deflect you from risky alternatives without interrupting your other
> thoughts, and therefore can actually speed you up. This could be one reason why some
> experts can do things so quickly: they don't even think of the wrong things to do."
> (§3-5)

### Censors and suppressors in Society of Mind (1986) — "negative expertise"

> "**Suppressor-agents** wait until you get a certain bad idea. Then they prevent your
> taking the corresponding action, and make you wait until you think of some
> alternative. If a suppressor could speak, it would say, 'Stop thinking that!'" (27.2,
> "suppressors")

> "**Censor-agents** need not wait until a certain bad idea occurs; instead, they
> intercept the states of mind that usually precede that thought. If a censor could
> speak, it would say, 'Don't even begin to think that!'" (27.2)

> "Censors avoid this waste of time by interceding earlier. Instead of waiting until an
> action is about to occur, and then shutting it off, a censor operates earlier, when
> there still remains time to select alternatives... Clearly, censors can be more
> efficient than suppressors, but we have to pay a price for this... each censor may, in
> time, require a substantial memory bank. For all we know, each person accumulates
> millions of censor memories, to avoid the thought-patterns found to be ineffectual or
> harmful." (27.3, "censors")

Minsky explicitly calls out introspective blindness as the reason this category is
understudied — directly relevant to "overseer agent" design because it means a
censor/suppressor's effect is invisible from the inside unless specifically instrumented:

> "it is easier to notice what your mind does than to notice what it doesn't do, and this
> means that we can't use introspection to perceive the work of these inhibitory
> agencies... I suspect that this effect has seriously distorted our conceptions of
> psychology." (27.3)

He also warns that over-suppression is itself a failure mode that must sometimes be
suppressed — relevant to "when should the overseer back off":

> "Sometimes, though, our censors and suppressors must themselves be suppressed. In order
> to sketch out long-range plans, for example, we must adopt a style of thought that
> clears the mind of trivia and sets minor obstacles aside. But that could be very hard to
> do if too many censors remained on the scene." (27.3)

### Difference-engines

> "**Difference-Engine** (7.8) An agency whose actions tend to make the present state of
> affairs more like some goal or desired state whose description is represented in that
> agency. This idea was developed by Allen Newell, C. J. Shaw, and Herbert A. Simon into
> an important theory about human problem solving." — glossary

> "A difference-engine must contain a description of a desired situation. It must have
> subagents that are aroused by various differences between the desired situation and the
> actual situation. Each subagent must act in a way that tends to diminish the difference
> that aroused it." (7.8, "difference-engines")

Minsky is explicit this is not his own invention but Newell/Shaw/Simon's General Problem
Solver, renamed: "Originally, these systems were called general problem solvers, but I'll
simply call them difference-engines." (7.8) He uses it as his model for what a "goal"
*is* mechanistically — not a mysterious intention but the behavior of a particular,
fully specifiable agency type.

**Confidence: Confirmed** for all SOM and Emotion Machine quotes (direct primary text,
sections/§ numbers verified).

---

## 5. The Self: a useful fiction, not a single agent

> "**Single-Agent Fallacy** (4.1) The idea that a person's thought, will, decisions, and
> actions originate in some single center of control, instead of emerging from the
> activity of complex societies of processes." — glossary (cross-referenced from the
> "Self" entry itself)

> "One common image of the Self suggests that every mind contains some sort of
> Voyeur-Puppeteer inside — to feel and want and choose for us the things we feel, want,
> and choose. But if we had those kinds of Selves, what would be the use of having Minds?
> And, on the other hand, if Minds could do such things themselves, why have Selves? Is
> this concept of a Self of any real use at all? It is indeed — provided that we think of
> it not as a centralized and all-powerful entity, but as a society of ideas that include
> both our images of what the mind is and our ideals about what it ought to be." (4.2,
> "one self or many?")

Minsky states the paradox of why the single-self myth persists, given that (in his
theory) there is no one there to hold it:

> "if there is no single, central, ruling Self inside the mind, what makes us feel so
> sure that one exists? What gives that myth its force and strength? A paradox: perhaps
> it's because there are no persons in our heads to make us do the things we want — nor
> even ones to make us want to want — that we construct the myth that we're inside
> ourselves." (4.2)

But — important nuance the brief should not flatten — Minsky does not say the Self is
*useless*, only that it is not a control center. He gives it a specific function:
stability against your own future changes of mind:

> "One function of the Self is to keep us from changing too rapidly. Each person must
> make some long-range plans in order to balance single-purposeness against attempts to
> do everything at once. But it is not enough simply to instruct an agency to start to
> carry out our plans. We also have to find some ways to constrain the changes we might
> later make — to prevent ourselves from turning those plan-agents off again!" (4.4, "the
> conservative self")

And he distinguishes `self-images` (beliefs about what you can/tend to do) from
`self-ideals` (beliefs about what you ought to be), both useful, neither a homunculus
(4.1). So: "self" (lowercase) is ordinary personal identity; "Self" (capitalized, in
Minsky's typographic convention) is the suspect myth of a unified inner controller — a
myth he explains functionally rather than dismisses as meaningless.

**Confidence: Confirmed.**

---

## 6. Beyond Minsky: agents vs. routines, processes and workflows

Minsky's own vocabulary already distinguishes **agent** (a standing, reusable, simple
part) from **script** (a compiled, inflexible, fast trace through a set of agents that
has had its managers stripped out, §3 above). The broader literature on
procedural/habitual cognition and on software agent architectures sharpens this same
line from several independent directions:

**Procedural memory and habits.** Habitual, "scripted" action in biological brains is
associated with the basal ganglia compressing a learned sequence of steps into a single,
fast-executing unit — directly structurally analogous to Minsky's "script [that]
eliminat[es] all the higher-level managers." Ann Graybiel's influential account:

> Graybiel, A. M. (1998), "The Basal Ganglia and Chunking of Action Repertoires,"
> *Neurobiology of Learning and Memory* 70(1–3): 119–136. Central claim (as reported by
> multiple secondary summaries of the paper, not independently re-extracted from the PDF
> in this pass): recoding within the striatum can "chunk" the representations of motor
> and cognitive action sequences so they can be executed as single performance units,
> generalizing Miller's notion of information chunking to action control; this underlies
> habit and stimulus-response learning, which is acquired slowly and, once formed, can run
> largely without conscious, step-by-step awareness.

This is the biological version of Minsky's claim in 13.5 that "practice" works by
*replacing* a many-agency program with a shorter script — and it shares the same
trade-off Minsky names (fast but inflexible, hard to interrupt or re-purpose
mid-sequence).

**Brooks's subsumption architecture — agents with no shared model, not even a manager.**
Rodney Brooks's 1991 paper explicitly cites Minsky's Society of Mind as a kindred account,
while pushing further: Brooks removes not just the central executive but *any* shared
representation at all.

> "Just as there is no central representation there is not even a central system. Each
> activity producing layer connects perception to action directly. It is only the
> observer of the Creature who imputes a central representation or central control. The
> Creature itself has none; it is a collection of competing behaviors. Out of the local
> chaos of their interactions there emerges, in the eye of an observer, a coherent
> pattern of behavior. There is no central purposeful locus of control. **Minsky [10]
> gives a similar account of how human behavior is generated.**" (Brooks 1991, §5.1, "No
> representation versus no central representation"; reference [10] in Brooks's own
> bibliography is "M.L. Minsky, Society of Mind (Simon and Schuster, New York, 1986)")

> "The key idea here is to be using the world as its own model and to continuously match
> the preconditions of each goal against the real world." (Brooks 1991, §5)

This is a meaningfully different architecture from Minsky's: Minsky keeps managers,
escalation, and the noncompromise principle (a real, if minimal, conflict-resolution
protocol among agencies); Brooks's layers have *no* arbitration mechanism at all — they
simply run in parallel, wired directly from sensors to actuators, and whatever coherent
behavior results is an artifact of engineering the interactions, not of any agent
deciding anything (Brooks is explicit that this isn't claimed to be "chaos," but that the
order is in the wiring, not in any internal negotiation).

**The actor model (Hewitt, 1973).** A computational formalism, not a theory of mind, but
frequently paired with Minsky's "agent" because of vocabulary overlap: an actor is
defined by exactly three capabilities — it can create new actors, send messages to
actors it knows about, and designate how it will behave on its next message [secondary
source: standard summaries of Hewitt, Bishop & Steiger, "A Universal Modular ACTOR
Formalism for Artificial Intelligence," IJCAI 1973]. Actors communicate only by
asynchronous message-passing and encapsulate their own state. The resemblance to
Minsky's agents is about *encapsulation and message-passing*, not about mindlessness or
intelligence-as-emergent-property — Hewitt's actors are a concurrency/distributed-systems
primitive; nothing in the formalism requires or implies that any individual actor is
"too simple to understand," which is Minsky's defining property of an agent.

**Workflow/BPM vs. autonomous agents — who decides the next step.** This is the cleanest
modern restatement of Minsky's script-vs-agency distinction, from Anthropic's own
engineering guidance on building LLM-based systems:

> "Workflows are systems where LLMs and tools are orchestrated through predefined code
> paths." / "Agents, on the other hand, are systems where LLMs dynamically direct their
> own processes and tool usage, maintaining control over how they accomplish tasks."
> (Anthropic, "Building Effective Agents," `anthropic.com/engineering/building-effective-agents`)

> "Workflows offer predictability and consistency for well-defined tasks, whereas agents
> are the better option when flexibility and model-driven decision-making are needed at
> scale." / "Agents can be used for open-ended problems where it's difficult or
> impossible to predict the required number of steps, and where you can't hardcode a
> fixed path." (same source)

Map this onto Minsky's own vocabulary and it lines up almost exactly: a **workflow** is a
**script** in Minsky's sense — a fixed, predetermined path, fast and predictable, but
blind outside that path, with no manager left to escalate to if something unexpected
happens. An **agent** (in both Minsky's and Anthropic's sense, though for different
underlying reasons — Minsky's agents are mindless and simple; an LLM-based "agent" is a
single component capable of judgment) is the thing that still has live managers: it can
notice a conflict or a novel situation and decide what to do about it, rather than
executing a pre-compiled trace.

**Confidence: Confirmed** for the Anthropic and Brooks quotes (primary text, direct
fetch/extraction). **Likely** for the Graybiel and Hewitt summaries (secondary-source
syntheses, not independently re-extracted from the primary PDFs in this research pass,
but each drawn from multiple converging academic summaries of well-established,
frequently-cited papers).

---

## Plain glossary

- **Agent** — the smallest unit Minsky's theory uses: a part of the mind "simple enough
  to understand" by itself, with no awareness of the larger job it serves (SOM 1.4).
- **Agency** — a group of agents, described *from the outside* by what it accomplishes as
  a whole, regardless of how its parts work internally (SOM 1.6).
- **K-line** — a record-and-replay device: it remembers *which agents were active* during
  some experience, and reactivating it re-arouses (a band of) those same agents later,
  producing a "partial mental state" similar to the original one (SOM 8.1–8.4).
- **Frame** — a reusable skeleton with labeled blanks ("terminals"), each pre-filled with
  a "default" that gets overridden by better information when available (SOM 24.2).
- **Script** (Minsky's sense) — a frame/agency that has been compiled down into a fast,
  fixed sequence by stripping out its higher-level managers; gains speed, loses the
  ability to handle anything off the beaten path (SOM 13.5, 21.7, glossary "Script").
  **Script** (Schank & Abelson's sense) — stored knowledge of a stereotyped sequence of
  events (e.g., the restaurant: entering → ordering → eating → exiting), used to predict
  and fill in the unstated parts of a story.
- **Routine / process** (ordinary computing sense, not Minsky's) — a predefined sequence
  of steps executed the same way each time; the thing a script becomes once it is
  written down as code rather than compiled by practice into a brain.
- **Workflow** — in modern agent-system usage (Anthropic), an LLM-based system wired
  through "predefined code paths" — architecturally the same role as Minsky's script:
  something decided the whole path in advance.
- **B-brain** — an overseer wired only to watch and influence another part of the system
  (the A-brain), never the outside world directly; it can usefully intervene (e.g.,
  "you're stuck in a loop") without understanding the task's content, but it can also
  misfire by misreading legitimate repetition as a problem (SOM 6.4).

---

## Mapping candidates to Tejas's thread/session system

Read as hypotheses to test against the actual design, not conclusions.

**An AI session ≈ an agent.** *Confidence: Likely, with a real mismatch.* A session does
one bounded piece of work and (mostly) doesn't need to understand the whole thread it
serves — that much matches Minsky's "simple enough to understand by itself." But Minsky's
agents are *permanent, reusable* parts of a fixed architecture (`Builder`, `Find`,
`Grasp` exist whether or not they're currently active); a Thinkering session is usually
spun up, does its job, and is gone — closer to Minsky's *script* (a one-shot compiled
trace) than to a standing agent, unless the system is specifically designed so that a
*kind* of session (e.g., "the reviewer") is a standing, reusable role that many threads
call into — which would make *that role* the agent and each invocation its activation.
Where the mapping breaks: Minsky's agents have no persistent "self" across activations
and don't accumulate memory on their own — a session that remembers things between
activations is already doing something closer to a K-line-bearing agency than a bare
agent.

**A thread re-summoning its sessions ≈ a K-line.** *Confidence: Likely, this is probably
the strongest mapping in the set.* A K-line's whole purpose is to reactivate a *band* of
previously-active agents to recreate a useful partial state — not the full prior state
(SOM 8.4, 8.7), and not just the content, but the *configuration of which agents were
working*. A thread that "re-summons" the sessions that worked on it before is doing
exactly this: restoring a working configuration rather than replaying a transcript. The
level-band warning (8.5–8.7) maps onto a concrete design risk: reactivating *too much*
(the exact prior session state, verbatim) risks the failure Minsky names explicitly — "it
would erase your present you" — i.e., a resumed session that is too faithfully restored
stops adapting to what's actually needed *now*; reactivating *too little* loses the
generally-useful middle layer of context. Where the mapping breaks: a K-line in Minsky's
theory is a single, learned, largely automatic attachment formed once, during the
original experience; a thread's choice of which sessions/context to re-summon is (at
least today) more deliberate/designed than an automatically-learned attachment — there is
no obvious equivalent yet of the *default, learned* weakening of fringe connections that
makes level-bands work on their own.

**A design→review→code→review→test→ship routine ≈ a script, not an agent.** *Confidence:
Confirmed, by Minsky's own vocabulary.* This is close to a textbook case of what Minsky
calls a script: a fixed sequence, run the same way regardless of content, with "the
higher-level managers" (a human or an agent that would otherwise decide whether to skip
review, loop back, or escalate) compiled out in favor of speed and predictability (SOM
13.5, glossary "Script"). It is also, independently, what Anthropic's engineering
guidance calls a *workflow* rather than an *agent*: "orchestrated through predefined code
paths." The place this breaks is instructive: Minsky's whole point about scripts is that
they are "inflexible because [they lack] bureaucracy" and "lose access to alternatives
when things go wrong" (glossary, "Script") — so the open design question is not whether
this routine is a script (it is, by definition, if it's fixed) but whether each *step* in
it is itself staffed by an agent capable of noticing something is wrong and escalating,
the way `Find` can in principle refuse and let a manager decide what to do next. A script
with no agents left inside any of its stations is exactly the brittle case Minsky warns
about.

**An overseer like an Inbox ≈ a B-brain.** *Confidence: Likely, and well-supported by
the primary text.* The Inbox (or any session-health/attention-routing layer) watching
sessions without needing to understand each session's task content is almost exactly
Minsky's B-brain: "a counselor, psychologist, or management consultant, who can assess a
client's mental strategy without having to understand all the details of that client's
profession" (SOM 6.4). The B-brain's example interventions — "A appears to be repeating
itself. Make A stop." / "A is occupied with too much detail. Make A take a higher-level
view." — map directly onto things an attention-routing overseer plausibly does (detect
loops, detect stalls, decide something needs the human's attention). Minsky's own named
failure mode is the one to design against explicitly: a B-brain misreading *legitimate*
repetition (adding up a long column of numbers) as a problem (SOM 6.4) — i.e., an
overseer that flags a long-running-but-healthy session as stuck. The Emotion Machine's
later refinement (Corrector / Suppressor / Censor, §3-5) offers a ready-made taxonomy for
*how early* an overseer intervenes — warn after the fact (Corrector), veto just before
acting (Suppressor), or prevent the situation from ever arising (Censor) — which could be
a useful vocabulary for distinguishing levels of an Inbox's intervention aggressiveness.
Where the mapping breaks: Minsky's B-brain only ever watches *one* A-brain; an Inbox
watching *many* concurrent threads is structurally more like Minsky's generalization "we
could connect a C-brain to watch the B-brain, and so on" (SOM 6.4) applied sideways
rather than upward — Minsky never actually works out the one-overseer-many-subjects case,
so this part of the mapping has no primary-source backing, only extrapolation.

**Not mapped, flagged as open:** Minsky's **noncompromise principle** (unresolved
conflict escalates and weakens the party that can't resolve it) has no obvious analogue
yet in the sketch above — if two sessions on the same thread disagree (e.g., two review
passes reach different verdicts), does the system have anything that behaves like
escalation-with-cost, or does it currently rely on a human noticing? This looks like a
genuine design gap worth deciding on purpose rather than leaving implicit, given how
central the principle is to how Minsky's societies avoid deadlock.

---

## Sources

- Minsky, M. (1986). *The Society of Mind*. Simon & Schuster. Full text consulted via
  the author-licensed web mirror `aurellem.org/society-of-mind/` (Creative Commons
  BY-NC-SA), sections cited by Minsky's own numbering, cross-checked against the book's
  own glossary (`som-glossary.html`), which cites itself by section number.
- Minsky, M. (1980). "K-Lines: A Theory of Memory." *Cognitive Science* 4(2): 117–133 /
  MIT AI Memo 516. **Not directly accessible in this research pass** — MIT DSpace serves
  it behind an AWS WAF CAPTCHA (`dspace.mit.edu/handle/1721.1/5739`); Wiley's reprint
  returned 403. Represented here via its 1986 book restatement (chapter 8) plus
  Wikipedia's "K-line (artificial intelligence)" article as secondary corroboration.
- Minsky, M. (2006 draft). *The Emotion Machine*. Chapter III, "From Pain to Suffering,"
  consulted via Minsky's own public draft mirror,
  `web.mit.edu/dxh/www/marvin/web.media.mit.edu/~minsky/eb3.html`.
- Minsky, M. (1974/1975). "A Framework for Representing Knowledge." MIT AI Memo 306 /
  published as a chapter in *The Psychology of Computer Vision*, P. H. Winston (ed.),
  McGraw-Hill, 1975. Cited via the Society of Mind glossary's own reference to it; not
  independently fetched in this pass.
- Schank, R. C., & Abelson, R. P. (1977). *Scripts, Plans, Goals and Understanding*.
  Lawrence Erlbaum Associates. Restaurant-script structure and Conceptual-Dependency
  framing drawn from converging secondary summaries (search-engine synthesis); original
  monograph not independently fetched in this pass.
- Brooks, R. A. (1991). "Intelligence Without Representation." *Artificial Intelligence*
  47: 139–159. Fetched and text-extracted directly from
  `people.csail.mit.edu/brooks/papers/representation.pdf`.
- Hewitt, C., Bishop, P., & Steiger, R. (1973). "A Universal Modular ACTOR Formalism for
  Artificial Intelligence." IJCAI 1973. Summarized via secondary sources; not
  independently fetched in this pass.
- Graybiel, A. M. (1998). "The Basal Ganglia and Chunking of Action Repertoires."
  *Neurobiology of Learning and Memory* 70(1–3): 119–136. Summarized via secondary
  sources; PDF located (`cs.ou.edu/~fagg/umass/classes/691c/papers/Graybiel.pdf`) but not
  independently text-extracted in this pass.
- Anthropic (2024/2026). "Building Effective Agents."
  `anthropic.com/engineering/building-effective-agents`. Fetched and quoted directly.
