# Design v4: owned threads over the existing records
2026-09-26 · design session concierge:3756 · Status: proposed, NOT approved, nothing built.

## Round-one input
- 8 live sessions: the Inbox (3172), threads design (3558), threads build (3572), inbox thread view and
  notifications (3291), threads brainstorm (3438) and its colony-lab fork (3592), attention (3364), and the
  early thread-per-request design (3188). Files 25–33.
- Latency retrospective (3757). File 33.
- A fresh Claude reviewer. File 23.
- Historical sessions, read from transcripts because they can't be messaged: self-healing-agents,
  journalmaxx, claritymaxxing, agent-ecology, and the stalled threads brainstorm. File 24.

## What changed from v3, and why
1. **Build on what exists; no new vocabulary.** A thread is today's Inbox topic. It already has requests with
   dispatches and outcomes, questions of type decision/reading with explicit ends, posts, a Timeline, reading
   marks, and one notification slot. Links reuse Thinkering's 18 typed links (reason required, retraction
   history); Topic → Branch → Thought stays as he corrected it; journalmaxx atoms stay as they are. [3558,
   3572, 3438, 3188, historical]
2. **Sleep and immune are not named organs.** On 2026-09-01 he chose, by name, not to pre-specify them
   ("we are deliberately choosing not to include those … see if that actually evolves"). The agent-ecology
   constitution makes that a standing rule. v4 keeps two lower-level primitives: consolidation when a request
   settles, and grouped incident detection. The review then shows whether anything sleep-like or immune-like
   is needed. The self-healing sleep agent (N1–REM, decay 0.9 per cycle, prune below 0.2, never younger than 3
   cycles, two-signal activation) is the ready candidate if the evidence calls for it. [historical, 3592, 3572]
3. **Nothing he reads is rewritten unattended.** Agents propose; he endorses. His edits lock agents out
   (drafts' edit lock). Every machine-written line cites its source and has a date. "Since you last looked"
   is a record diff against his reading mark, not rewritten prose. Decay may reorder; it may never retire an
   unanswered question, an unread result or anything he captured. [3291, 3572, 3438, 3364, 3558, claritymaxxing]
4. **The Inbox keeps a voice for routing.** It still answers routing and system questions ("why did you send
   this there?", his 2026-09-17 request), confirms placement and asks where something belongs. It never
   answers world questions; the tool deny list already blocks that path. [3172, 3188, reviewer A14]
5. **No hard cap.** It shows a count of threads he steers or that wait on him, and offers "not now" without
   paperwork. First we measure how often he'd pass 5 and how many parked threads reopen within 24 hours.
   [every reviewer]
6. **The grounding is restored for each role** (below). [reviewer A1]
7. **Split into a core and options.** [reviewer B9]

## Core (the one change to approve)

### Parts and where they run
- **Session owner (Concierge, server; its peer on the Mac).** Holds threads, requests, questions, posts, reading
  marks and notification slots. New in v4: each thread records its current owning request and the owning
  session; replies to a thread are routed by the owner; owning sessions may post into the thread they hold.
- **Inbox (Claude session in the Inbox project, server).** Front door and directory.
- **Owning sessions (in each work's project, on the server or the Mac).** Do the work and talk in the thread.
- **thnkr.ing (web and iPhone).** The Threads home replaces the session sidebar, and each thread has a brief.

### Flows
**(a) A capture arrives**
1. The owner records it.
2. The Inbox gets a turn.
3. The Inbox reads the directory: thread titles, state, one-line status, owner, and the recognition rule
   "what belongs here". It never reads conversations.
4. It places the capture in an existing thread, or creates one.
5. For work, it sends a request carrying the hand-off packet: his exact words kept separate from its reading,
   related threads and sessions, and what done looks like.
6. That request's destination becomes the thread's owner.

**(b) The owner answers**
1. It posts in the thread in its own words, under the reply contract: TL;DR, plain language, causes hedged,
   the result checked against his words. This contract keeps the checks the relay used to perform.
2. It declares its outcome. needs_you or response files a question on the thread, as today.
3. The owner updates the thread's status line from that declaration.
4. The Inbox receives the status fact, not a turn.
5. The notification names the exact message ID and the thread root. [3291: addressing first]

**(c) He replies in a thread**
1. The owner delivers the reply to the owning session as a new input. It keeps his authorship, the thread
   link and the message it answers.
2. The Inbox is not woken.
3. If the owner is not running, the reply shows as Queued.
4. If the owner is on the Mac, it goes over the existing peer channel. It waits if the Mac is asleep and
   shows as Queued.

**(d) The reply went to the wrong place**
- If he tells it so, the owning session calls "not mine, back to the front door". The Inbox gets one turn with
  his text and places it.
- He can also call the Inbox into any thread himself, using "Ask the Inbox" or by mentioning it.

**(e) Several owners in one thread**
- One human request can have several destinations, each with its own delivery, progress and result.
- The thread shows "in progress" while any of them is open, and never collapses partial delivery into "Failed".
- A session can serve several threads, since 257 of 281 dispatches went to reused sessions. Sessions link to
  threads through requests; they are not nested exclusively under one.

**(f) Guards that move with the answers**
- A quiet end on his own message needs a stated reason. Today that rule covers only the Inbox; it moves to
  every owning session.
- Posts carry exact message identity. Attention ends only on his reply, his dismiss or a later declaration.

### What he sees
- **Threads home.**
  - One row per thread: title, owner and machine, status line, a waiting-on-you mark, and a count of what
    changed since he last read it.
  - Order is recency. "Needs you" is a filter and a mark on the row, never a ranking.
  - Sessions agents started are hidden, reachable inside their thread.
  - The 202 Slack-era rows are marked done; nothing is deleted.
- **A thread.**
  - A collapsible brief at the top:
    - his purpose line, editable and locked against agents;
    - "what belongs here";
    - decisions with their source links;
    - open questions and requests, from the records;
    - "since you last looked".
  - Below it, the conversation, which holds only him, the owner and the Inbox's deliberate posts.
  - Then the Timeline.
  - A thread that is just one capture shows the capture as its brief.
- **Controls.** Move, Ask the Inbox, Not now, Follow. These already exist or are small.

### Prerequisites (sequencing inside the one change, not phases)
- **Stable message IDs** in notifications. [3291]
- **Bounded reads.** Opening a thread costs one page; an update costs only what changed. [3757]

### What this replaces
- The Inbox relaying answers: 59% of what it read, 12 compactions in 9 days.
- The flat session sidebar.
- Growth of the Inbox's rulebook. Its role now comes from the directory and a limited set of tools.

## Grounding, per role
| Role | Why this shape | Evidence |
|---|---|---|
| Inbox chooses and never does the work | the brain's selector gates actions without executing them; the planning cortex biases other areas rather than doing their work | Redgrave 1999; Miller & Cohen 2001 |
| Inbox reads a directory, not conversations | memory keeps an index to where content lives, not the content; teams work through "who knows what" | Teyler & DiScenna 1986; Wegner 1987; Ren & Argote 2011 |
| Relay-free: the Inbox stops reading conversations | protect a regulator by filtering what reaches it; the centre stays out of day-to-day operations | Ashby; Beer; Chandler/Williamson |
| One owner per thread, and the Inbox steps out after hand-off | after the award the manager is not a party; only one controller talks to a plane; one doctor owns a patient | Smith 1980; FAA transfer of control; I-PASS (−23% errors) |
| Hand-off packet plus the owner restating its understanding | structured hand-off with read-back | I-PASS (Starmer 2014) |
| Separate processes, not modes of one agent | specialization pays when switching roles is costly | Rueffler 2012; Goldsby 2012 |
| Structure is added only on measured need | climb the coordination ladder only when direct contact fails; coordination emerges where the environment prices its cost | Galbraith; Mintzberg; colony-lab paper 04 |
| Agents as metabolism, his decisions as regulation | cheap energy makes regulation the bottleneck | Lane & Martin 2010 (contested); Rao 2026 |
| A brief whose sources are kept and which he can edit | the episode store and the consolidated store are separate; recall can distort, so provenance is kept | McClelland 1995; Nader 2000 |

## How structure evolves (the tracker)
Code computes this weekly from the records, and on request. It reaches him as one reading item in a
"System" thread. Two-signal rule: a trigger must hold this week and last week before it proposes anything.
Each proposal names its smallest alternative and how it would be undone.

| Signal | Threshold (first guess, tuned by data) | Proposal it raises |
|---|---|---|
| Open threads in one project | ≥10, with ≥3 sharing work, two weeks running | a coordinator for that project, which keeps its own directory and does not relay |
| Moves/returns to front door | ≥15% of placements | routing changes or a classifier experiment on his real captures |
| Owner answers he corrects ("that's not what I said") | ≥3 a week in one project | a stronger hand-off packet for that project |
| Design threads with open decisions older than 7 days | any, pulled by a build | ask the decisions in the build thread |
| The same failure signature | ≥3 occurrences | one grouped incident with a proposed structural check (monitoring, not autonomous repair) |
| Inbox reading beyond the directory | above a set limit | directory changes |
| Threads he'd have exceeded 5 on / parks reopened in 24h | measured | whether a focus limit helps |

## Options (separate proposals, each depends on the core)
- **O1. Consolidation on settlement.** When a request settles, an agent that isn't the owner proposes brief
  updates: decisions with sources. This is his "the same agent should not be the historian of why it was
  correct". He accepts in one tap.
- **O2. Grouped incident detection.** Monitoring that groups repeated failure signatures into one incident
  with a proposed check.
- **O3. Nightly pass,** built on the self-healing sleep agent. Only if O1 plus the tracker show an unmet
  need. Undoable housekeeping in one class, proposals in the other.
- **O4. Map view.**
- **O5. Routing experiment.** The Inbox compared with a constrained model on his ~700 captures that already
  have recorded destinations. It needs no new model access.
- **O6. Journalmaxx capture layer.** Resume his paused atom pipeline for voice bursts; the atom format is
  unchanged.
- **O7. The test-and-report loop.** Owners state what to try, and his failure report goes straight to the
  owner. Mostly delivered by the core already.

## The least option, for comparison
**D. "A thread is a session he opened."**
- Agent sessions are hidden under it, and the Inbox only binds and stops relaying.
- It is smaller, and has no second store.
- It loses:
  - identity when work moves across sessions or projects;
  - idea threads with no agent;
  - multiple destinations;
  - the brief.
- Deciding count: how often one line of his attention moves across sessions or projects. The spawned-from and
  retargeting cases in the usage map show it happens, since 257 of 281 dispatches reuse sessions. So v4
  recommends the core over D, with that count as the evidence.

## Deliberately excluded
Faces rewritten unattended, a hard cap, named sleep/immune organs, a new link vocabulary, a new state chain
(attention, execution and maturity stay separate axes), and peer-to-peer chat between agents (cross-agent
asks stay as recorded requests with a return obligation).

## Decisions for him
1. Approve the core, or the least option D?
2. Keep sleep and immune unnamed, per his 2026-09-01 stance, with O1/O2 as primitives?
3. Which options, if any, go in the same change?
