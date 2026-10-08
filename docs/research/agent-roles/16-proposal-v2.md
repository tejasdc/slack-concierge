# Proposal v2: threads as the unit of attention (for an ADHD brain that works through agents)

Status: proposed to Tejas on 2026-09-25/26. Not approved, nothing built. Supersedes 10-proposal.md.
Evidence: 11 usage map · 12 unfinished and design sessions · 13 vault · 14 flow/ADHD/craft · 15 what is a thread ·
plus 01–09.

## What the data says about how he works
- Since Sep 15: 1,064 real messages; 521 typed straight into sessions, 492 captures. He's most active
  around 10pm–2am and 1–3pm ET. Voice dominates.
- Of 59 organic threads, 63% are one message and 58% never needed an agent. About a third are notes or
  research, not requests.
- On a typical day 10–24 sessions are running, but he writes into only 3–5. The rest are agents talking to agents.
- Design sessions stall after 1–3 of his messages. Later work pulls research from them and makes the
  decision implicitly. Example: the pinned "topic threads that keep collecting" brainstorm is still open,
  while a different session designed and shipped Threads.
- His vault: dictated bursts of 2,000–8,000 words mixing 3–8 topics. He already designed a capture
  pipeline (journalmaxx, paused 2026-04-19): capture the burst whole, split it later into typed atoms
  marked provisional, flag some captures for a later re-check, surface contradictions, and link
  ideas as edges. Latency to seeing the atoms is a named pain.
- Misroutes are mostly invisible. The unthread control was used 0 times out of 35 placements, and the door
  a message came through is recorded for only 26 of 1,064 messages.

## Principles (evidence strength in brackets)
1. Capture has no friction. Activation and parking do. [High: Masicampo & Baumeister 2011; Gollwitzer & Sheeran 2006]
2. Cap his own active threads, not the agents' work. [High: Little's law; attention residue, Leroy 2009]
3. Resurface resting ideas by cue (a related thread becomes active), with a review as the fallback.
   [High on cue beating calendar for ADHD: McDaniel & Einstein; the failure of GTD someday/maybe and PARA archives]
4. Parking to incubate is different from avoiding. [Medium: Sio & Ormerod 2009]
5. A decision needs a commitment device, not an endless discussion. [High: Bryan, Karlan & Nelson 2010]
6. Approval gates only where uncertainty or irreversibility is high. Everything else is legible after the fact. [High]
7. Measure outcomes, not felt speed. [High: METR 2025 found a 39-point gap between perceived and actual speed]
8. Honest progress signals on long work. [High: Amabile & Kramer]
9. Keep skill-growing work human-led. [SDT high; the exact boundary is his call]
10. One identity per thread, with a lifecycle and typed relations. [Medium: Luhmann, Ahrens, PARA, issue trackers, git]

## The model
A thread is one line of his attention, not one conversation.
- States: captured → incubating → active → waiting on you / waiting on agent → resting → done / merged.
- Relations: spawned-from (where he was when he opened it), related-to, blocks, merged-into (both
  histories kept).
- A thread may have no agent (an idea collecting material), one owning agent (active work), or several
  sessions under it (the owner plus the helpers it asked). Sessions nest under their thread.
- The owner runs in the project where the work is, because its instructions, tools and learning are
  there. The thread record lives in Concierge, not in a folder. Life things go to life logistics. Ideas
  with no project yet have no owner until activated. Learning about managing threads belongs to the
  Inbox project.

## Roles
- Him: chooses what is active, makes decisions, sets taste and accepts the work.
- Inbox (front door and directory): places every capture, including bursts split into several. It expands,
  links spawned-from and related-to, finds the existing thread instead of opening a duplicate, and hands
  off with a packet. It never answers and never relays.
- Owner agent: works the thread, restates its understanding first, posts in its own words, and keeps the
  thread's one-line status. It asks other sessions directly.
- Nightly consolidation ("sleep"): splits the day's captures into atoms linked to threads, refreshes
  related-to links, and queues cue-based resurfacing. It also runs the review counts (overload per project,
  misroutes, stalled decisions, repeats). Structure changes come to him as proposals. This merges the
  "weekly review" into the sleep idea he already had.

## Friction, placed deliberately
- Capture: none. Any door, any time, bursts welcome.
- Activation: past his cap on active threads, the app asks him to pick one to park. Parking requires a
  next step or a decision date. The default cap is 5, from his 3–5 per day, and he sets it.
- Design threads: can't rest without a decision record, meaning what was decided and which decisions are
  still open.
- Point of performance: when a build session pulls from an undecided design thread, the system asks him
  those open decisions then, in the build thread, as a small checklist. That is when the decision is concrete.
- Focus: while one thread is open in front of him, updates from other threads wait unless they need him or
  relate to what he is doing.

## Examples from today
- "Weekly review" idea → the Inbox finds his existing sleep/consolidation thread and attaches it as
  related instead of opening a new thread.
- Broken file link noticed while designing → a spawned-from bug thread owned by the Thinkering session,
  so the design thread stays in focus.
- Money tree question → a life-logistics thread. His follow-ups go there. The Inbox never answers.

## Open decisions for him
1. The model: one kind of thread with states and relations. Yes or no?
2. The active-thread cap, and its default.
3. The decision-record rule for design threads.
4. Resume his paused journalmaxx design as the capture/atom layer, or start fresh.
