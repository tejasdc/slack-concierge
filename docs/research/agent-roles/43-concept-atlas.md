# Concept atlas: every thread we've pulled on, and how they tie together

This page isn't a design. It lays out every idea we used (from the brain, biology, ant colonies, companies,
hospitals, air traffic control, classic multi-agent software, the tools-for-thought thinkers and Engelbart),
explains each one plainly with an example, and shows where the same pattern turns up in different places. The
evidence and citations are in the numbered files in this folder.

---

## Part 1. The patterns that recur across domains

Each pattern turns up independently in several domains. When the brain, a hospital and an ant colony all solve
the same problem the same way, that's worth taking seriously. The last line of each pattern ties it to
something you lived through.

### P1. The one who chooses is not the one who does
- **Brain:** the basal ganglia pick which action gets released, but can't perform any action themselves. The
  default is "block everything" and "release one".
- **Hospital:** the triage nurse decides where you go and how urgently, then steps back. A doctor treats you.
- **Emergency dispatch:** the call-taker structures the call, the dispatcher assigns a unit, and the responder
  talks to you at the scene. Call-takers settle about half of calls without dispatching anyone.
- **Air traffic control:** when a plane changes sectors, the radio moves to the new controller. The old one
  never relays.
- **Software:** the contract net protocol (1980) has a manager announce a task and award it; after the award,
  the manager isn't part of the work. Jev (TypeSafe AI, September 2026) is a model that can only pick from a
  fixed list, so answering isn't something it can do.
- **Your life:** the Inbox answering the money-tree question. The chooser started doing.

### P2. Keep an index, not the content
- **Brain:** the hippocampus doesn't store your memories. It stores pointers to where the pieces live across the
  cortex and reassembles them when needed (hippocampal indexing theory).
- **Teams:** "transactive memory": good teams share a directory of who knows what, not everyone knowing
  everything. The measured benefit is less traffic through any one person.
- **Libraries and Engelbart:** catalogs, and the knowledge repository's shared directories (Part 2).
- **Your life:** the Inbox's context filled with other agents' answers (59% of what it read). It was holding
  content when it needed an index. Its genuinely useful skill, "talk to the session that built X", is a
  directory lookup.

### P3. Fast, fragile memory and slow, durable memory are kept apart
- **Brain:** working memory and the hippocampus learn fast and forget easily. The cortex learns slowly and
  keeps. Sleep replays the day to move what matters across (complementary learning systems).
- **Biology:** mitochondria moved most of their genes into the nucleus, where they're protected from the damage
  energy production causes. They kept a small local copy for quick decisions.
- **Hospital:** the chart outlives the shift. Handovers use a fixed script that ends with the receiver saying
  back what they understood (I-PASS, 23% fewer errors).
- **Your life:** an agent loses its role when its conversation is summarized. The fix is that role and knowledge
  live outside the conversation. Sessions are the fragile store.

### P4. Filter at the boundary, don't enlarge the brain
- **Cybernetics (Ashby):** only variety can absorb variety. A controller that is overwhelmed is fixed by
  filtering what reaches it, not by giving it more capacity.
- **Beer's viable system model:** each unit handles its own complexity, and only what needs the centre goes up.
- **Brain:** the salience network decides what deserves attention. The thalamus gates what reaches the cortex.
- **Companies:** a good chief of staff runs a curated feed, not a silent filter. Real CoS guidance says they
  don't sit in every meeting.
- **Interruption research (Horvitz):** whether to interrupt is a per-item cost-benefit judgement.
- **Your life:** "Why was I not notified?" and "why are you relaying everything?" are both boundary-filter
  problems.

### P5. Cooperation between levels needs structure, not good intentions
- **Evolution (Michod):** when cells became multicellular organisms, cooperation held only because of
  structural "conflict mediators", such as setting the germline aside and policing. Asking nicely never worked.
- **Evolved networks (Clune 2013):** modularity only appeared when connections had a cost. It never appeared
  just because it would have helped.
- **Hospitals and air traffic control:** checklists and fixed phraseology instead of relying on memory.
- **Software:** typed message kinds (FIPA), in which "refuse" is a legal move. Mandatory fields.
- **Your life:** the golden rule ("we fall to the level of our systems"). Failures fixed only with instructions
  kept coming back; failures fixed in structure stopped.

### P6. Specialization evolves when switching is costly, and only then
- **Theory:** specialization pays when doing two jobs in one unit is costly (Rueffler 2012; Goldsby 2012).
- **Ants:** workers take a task when its stimulus crosses their personal threshold (response thresholds). No one
  assigns jobs. Harvester ants adjust foraging from how often they bump into returning foragers (Gordon).
- **Companies:** the pin factory; the divisional firm, where headquarters stopped running day-to-day operations
  (Chandler, Williamson).
- **Colony-lab (your experiment):** a coordination structure only emerges where the environment puts a price on
  the problem it solves.
- **Your life:** the Inbox's two jobs, choosing and carrying conversations, pulled against each other. The
  question of a per-project chief of staff is P6 again: add one only once the switching cost is visible.

### P7. Coordinate through a shared environment (stigmergy)
- **Termites:** nobody holds the plan. Each termite reacts to the structure the others have left, and the mound
  builds itself (Grassé 1959).
- **Honeybees (Seeley):** scouts go and look independently, and the swarm commits only when enough of them are
  at one site at the same time (a quorum). No single bee decides.
- **Human scale:** Wikipedia; tuple spaces and blackboard systems in software.
- **Engelbart:** the knowledge repository is exactly this, a shared, evolving environment everyone works in.
- **Your life:** threads, requests and questions in the record are the shared medium. The mistake was routing
  every exchange through one agent instead of through the medium.

### P8. Hierarchy as nested modules, added when needed
- **Simon's two watchmakers:** the one who builds in stable sub-assemblies survives interruptions; the one who
  builds everything as one piece keeps losing work.
- **Roman legion:** 8 → 80 → 480 → 5,000 soldiers. Hierarchy as a routing protocol sized to how many people one
  leader can manage.
- **Galbraith and Mintzberg:** a ladder of coordination tools (direct contact → liaison → integrating manager →
  matrix). Climb a step only when the lower one fails.
- **Octopus:** two-thirds of its neurons are in the arms, which handle local work themselves while the brain
  gives high-level direction.
- **Beer:** the pattern repeats: every unit is itself a viable system.
- **Your life:** "how do we recognise when to evolve the hierarchy?" Measure the switching cost and climb the
  ladder one step at a time.

### P9. Recalling something changes it; a representation should be alive
- **Brain:** recalling a memory makes it changeable again, and it gets saved back in altered form (Nader 2000).
  That is how memories update, and how they get distorted.
- **Matuschak:** "evergreen" notes are revised over time rather than filed once.
- **Victor, Kay:** the computer as a dynamic medium you think inside, not a place for static pages.
- **Nelson:** links visible from both ends; quoting content by reference instead of copying it (transclusion).
- **Your life:** a thread is currently a chat log. The humane version is a living page you can see and shape,
  with the history kept underneath and every claim sourced so it can't quietly drift.

### P10. Symbiosis: who supplies energy, and who supplies meaning
- **Biology:** mitochondria gave cells so much energy per gene that complex life became affordable. The
  bottleneck then moved to regulation, meaning which genes get used when (Lane & Martin; the figures are disputed).
- **Rao, "Our Eukaryotic Moment":** AI is the nucleus and humans are mitochondria supplying "liveness":
  attention, desire, stakes, taste.
- **Your note, "Agents as Mitochondria":** agents power your thoughts into reality.
- **Licklider (1960):** humans set the goals and machines do the routine work.
- **Your life:** building is now cheap and your decisions are scarce. That's why design threads stall and why
  you spread thin.

### P11. Augment the human; don't replace their understanding
- **Engelbart:** H-LAM/T. The human, language, artifacts and methodology, plus training, improve together as one
  system.
- **Victor:** "A book cannot do something for you… reading a book can change you." He calls AI products
  "outsourcing understanding".
- **Research:** handing off memory weakens memory of what was handed off. Three 2025–26 studies found AI hurts
  learning only under pure delegation, and engaging with it protects learning. The illusion of understanding
  shows up when you try to explain something without notes.
- **What experts hold:** structure, meaning how things fit, what to expect and why (chunking; Endsley's levels 2–3).
- **Your life:** "none of your responses have any information on what is getting built." You need the
  structure; agents can hold the details.

### P12. Attention and an ADHD brain
- **Flow:** clear goals, immediate feedback, and challenge matched to skill (Csikszentmihalyi).
- **Open loops:** an unfinished goal keeps nagging until a concrete plan is written down, and writing the plan
  frees the mind (Masicampo & Baumeister). Capture alone doesn't close a loop; a next step or a decision date does.
- **Remembering later:** cue-based reminders ("when X happens") work far better than time-based ones, and ADHD
  weakens the time-based kind specifically. So ideas should resurface when something related comes up, not on a
  calendar.
- **Work in progress:** Little's law says more open items means each takes longer. Each switch leaves attention
  behind in the last task.
- **Commitment devices:** a decision that can be reopened for free will be reopened.
- **Friction:** good in the right places (Bjork's "desirable difficulties"), harmful at capture.
- **Your life:** spreading thin, stalled design sessions, and "I want a system I can trust to capture ideas".

### P13. Defence against damage
- **Immunology:**
  - "danger theory": the immune system reacts to signs of damage, not to novelty;
  - it waits for two signals before acting;
  - responses are specific to one threat;
  - "autoimmunity" is when the system attacks the body itself.
- **Ants:** there is no generic defence. Each defence tracks a specific parasite.
- **Your self-healing agents project:** fast innate checks, slow adaptive learning, and memory of past fixes.
- **Your life:** agents repeating mistakes (the thing you wanted most in August). The Inbox building its own
  refusals was an autoimmune attack on your foundations.

### P14. Name it, or let it emerge?
- **Your agent-ecology stance (2026-09-01):** don't pre-name sleep or immune systems; see if they emerge.
- **Self-healing agents:** named them and built them.
- **What decides it:** name a part only where a failure has been measured. Keep open questions open.

---

## Part 2. Engelbart's framework (CoDIAK, the knowledge repository, OHS, A/B/C)
Sources: file 41, from dougengelbart.org primary texts (1962, 1990, 1992, 1995, 1998, 2002). Audit of Thinkering: file 42.

- **H-LAM/T.** The unit that gets smarter is the Human, using Language, Artifacts and Methodology, in which they
  are Trained, all improving together. The Human System (skills, methods, culture) co-evolves with the Tool
  System. Engelbart in 2002: a system is *augmentation* when the human–machine interface is high-bandwidth. It
  slides into *automation* when that interface is narrow, and the machine acts on the human's behalf while the
  two are "kept apart".
  - Example: a chat where an agent does the work and hands you three sentences is a narrow interface. That's
    automation.
- **CoDIAK** (Concurrent Development, Integration and Application of Knowledge) is the knowledge process that
  matters most, with three streams running at once:
  1. *intelligence collection*: what comes in from outside;
  2. *dialog records*: the discussions and decisions, with their reasons;
  3. *knowledge products*: the current, integrated state (specs, plans, the "handbook").
  - Example: this design session. Research = 1; this conversation = 2; the design and atlas = 3.
- **DKR** (Dynamic Knowledge Repository) is the shared living home for all three streams. It is always current,
  every piece can be addressed, and it is linked together.
- **OHS** (Open Hyperdocument System) is the technology layer underneath. Its requirements:
  - documents that mix kinds of objects (text, graphics, code…);
  - explicit structure;
  - views you can switch (outline, filter, level of detail);
  - links to *any* object, which a person or an automatic process can follow;
  - back-links;
  - a library system;
  - a personal signature;
  - access control;
  - addresses that humans can read;
  - every object addressable;
  - external document control;
  - the **Journal**: a recorded, unchangeable store with guaranteed, citable addresses, as opposed to throwaway mail.
- **A/B/C levels.** A is doing the work. B is improving how the work is done. C is improving how the
  improvement happens. His investment argument: A is a one-time gain, B is the rate of gain, C is the rate at
  which that rate improves.
  - Example: A is building the Threads feature. B is the rulebook and skills that make agents build better. C is
    this session: designing how you and your agents improve how you work.
- **NIC** (networked improvement community): groups that pool their C-level work.
- **Bootstrapping:** use what you build to build it. The tool that improves the work is used on its own improvement.
- **Agents in Engelbart:** he never says "agent". He does design automation in: links that "an automatic
  process" can follow, a clerk that keeps the Journal, smart retrieval, macros. All of it sits on the
  augmentation side of his own line.

**How Thinkering measures up (file 42).**
- **Met in code:**
  - explicit structure;
  - lenses as switchable views;
  - an immutable Journal (append-only, causally ordered);
  - every object addressable;
  - 18 typed links with reasons;
  - back-links;
  - dialog and rationale kept together;
  - provenance on every change;
  - external document control.
- **Partial:** mixed-object documents (code and audio sit in separate stores) and the library system.
- **Deferred:** shared catalogs across many users, since this is a single-operator system.
- **Diverged:** access control, now a passkey boundary plus a human-versus-agent authority check.
- **The biggest gap is not the hyperdocument; it's the A/B/C loop.**
  - A happens in your projects.
  - B lives outside the app, in each project's instructions, the skills catalog and the lessons log.
  - C happens in sessions like this one and never lands back in the repository as a living knowledge product.
  - Your Topic → Branch → Thought model, from another session, was never built.

**How it ties back.**
- The CoDIAK streams are the three layers we kept rediscovering:
  - raw captures = intelligence collection;
  - thread conversations = dialog records;
  - a thread's living page = the knowledge product.
- The OHS Journal is the "immutable episodes" layer (P3, P9).
- The augmentation/automation line is Victor's objection (P11), stated in Engelbart's own terms.
- A/B/C is the frame for "which work is mine": you live at C and at the decisions in B, agents do most of A,
  and nothing should push you out of C.

---

## Part 3. Where the analogies break
- Biology and ants optimise for a colony's survival, not for one person's understanding. You need one
  accountable contact and a system you can read, which no ant colony needs.
- Recalling a memory can distort it, so a living page needs sources and your edits must win.
- The mitochondria energy figures are disputed. Treat that pattern as a lens, not a law.
- Hospitals and air traffic control protect strangers from catastrophe. Their handover discipline carries over;
  their heaviness doesn't.
- Victor would object to talking with agents at all. The honest answer is that agents stay, but the medium you
  think in must not be a chat.
