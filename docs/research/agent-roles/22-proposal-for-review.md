# Proposal for review: threads as a humane representation of thought, with agents as metabolism

Author: design session concierge:3756 (Claude Opus), 2026-09-26. Status: proposed, NOT approved, nothing built.
Tejas asked for this to be reviewed and discussed with the sessions that worked on these topics, then turned
into a concrete design and architecture. Consolidates earlier drafts (16-proposal-v2, 21-synthesis).

## Problem, in his words and in data
- The Inbox agent carried every back-and-forth between him and the working agents. Worker answers were 59% of
  what it read. It was summarized 12 times in 9 days, and failures kept recurring when they were fixed only
  with instructions (answering itself, retelling inaccurately, misfiling, changing foundations unasked).
- He likes the thread view ("things I opened") and finds the session sidebar overwhelming. The sidebar shows
  303 "active" sessions: 202 old Slack-era ones never closed, and only 58 that moved in the past week.
- He works by voice in bursts, often late at night. He writes into 3–5 sessions a day while 10–24 run. Most
  threads are one message, and about a third are notes or research rather than requests.
- Design sessions stall after 1–3 of his messages. Later builds pull their research and decide implicitly.
- He has ADHD and wants to capture everything into a system he trusts, stay in flow, stop spreading thin and
  finish hard decisions. He wants "a first brain that works better, not a second brain": a humane
  representation of thought (Engelbart, Victor, Kay, Nelson, Matuschak). The system must not be changed
  underneath him; foundations change only with his approval of a proposal he understands.

## Core idea
- Agents are metabolism: they supply the energy that turns an idea into reality.
- He supplies liveness: what matters, decisions, taste, accountability. This is Rao's term.
- The nucleus is a shared, living representation of his thoughts. Both he and the agents read and express it.
  It must be something he can see and shape directly, not a chat log.
- With agents, energy is abundant and regulation (his decisions) is the bottleneck. So the system
  economizes his decisions and attention, not his typing.

## The unit: a thread = one line of his attention
- **Identity and states**: captured → incubating → active → waiting (on him / on an agent) → resting → done / merged.
- **Typed links**: spawned-from (where he was when it started), related-to, blocks, merged-into (both histories kept).
- **Two layers**, from complementary learning systems and reconsolidation:
  1. Episodes: his captures and the conversations, immutable.
  2. The face: one living page. What this is; what's decided and why; what's open; how it works (the
     architecture in plain language); what changed since he last looked. It is rewritten each time the thread
     is reactivated, and he can edit it directly.
- A thread may have no agent (an idea collecting material), one owning agent (active work), or several sessions
  under it (the owner and the helpers it asked). Sessions are nested under their thread and disposable. Lasting
  knowledge goes to the face and to the project's own documents, never only into a session.
- The owning agent runs in the project where the work is. The thread record lives with the session owner
  (Concierge), not in a folder. Life things go to life logistics. Learning about managing threads belongs to
  the Inbox's own project.

## Roles
| Role | Does | Never does |
|---|---|---|
| Tejas | chooses what's active, decides, sets taste, accepts | has to relay or remember where things are |
| Inbox (front door + directory) | places every capture (splitting bursts), expands what he meant, finds the existing thread instead of a duplicate, links spawned-from/related, hands off with a packet (his exact words, its reading, related threads/sessions, what done looks like), moves a thread when he says so | answers him, relays conversations, changes foundations |
| Owning agent | works the thread, restates what it understood first, answers in its own words in the thread, keeps the face current, asks other sessions directly | keeps knowledge only in its session |
| Nightly consolidation ("sleep") | replays the day's captures into atoms linked to threads, strengthens links that were used, fades all salience a little so only what came back stands out, prunes dead links, closes finished sessions, refreshes faces, runs the review counts, proposes structure changes | changes anything he hasn't approved |
| Immune function | turns damage signals (repeated mistakes, broken builds, stalled threads) into proposed structural checks, specific to each threat | treats new ideas as threats, adds checks without approval |

## Interfaces he sees
1. **Threads home** in place of the session sidebar. Each row shows topic, state, owner and a one-line status,
   and whether it's waiting on him.
2. **Thread view**: the face on top and the conversation below. His replies go to the owning agent. The Inbox
   is not woken.
3. **Map**: threads and typed links drawn spatially. He can drag to link, merge, focus or rest, and replay how a
   thread grew.
4. **Morning**: what sleep did and what it proposes, each item with a recommended default.

## Friction, placed deliberately
- None at capture or at starting something small.
- **Active cap** (default 5, from his own 3–5 a day): past the cap, park one first. Parking needs a next step or
  a date to decide by.
- **Design threads** can't rest without a decision record (decided / open).
- **At the point of performance**: when a build pulls from an undecided design thread, he is asked those open
  decisions right there.
- **Focus**: while one thread is open, others stay quiet unless they need him or relate to it.
- **Foundation changes**: a proposal he approves. Optionally, "what do you think this changes?" before the
  explanation (generation effect).

## How structure evolves
- The review counts per project: concurrent threads, overlaps, moves, corrections of restated understanding,
  repeats, time to answer, and how much the Inbox reads beyond its directory.
- Triggers are written in advance. When one fires, he gets a proposal (for example a per-project coordinator).
  He decides.

## Failure family → structural answer
Doing the work itself → the Inbox has no answer path. Retelling errors → no retelling. Misfiles → heat suggests
links only, and moving is one gesture. Lost results → already structural. Foundations changed → proposals and
tolerance. Rules lost in migration → roles live in structure, not text. Stalled decisions → decision records
and point-of-performance questions. Understanding debt → the face explains how it works, plus "since you last
looked".

## Open questions for reviewers
1. What would break, or is already contradicted by what you built or learned?
2. What did your session discuss or decide that this should include or reuse?
3. What is missing, over-built or wrongly analogized?
4. Should the face be one page per thread, or something else?
5. Is the active cap right for an ADHD user, or would it backfire?
