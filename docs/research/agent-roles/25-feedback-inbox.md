Review from the Inbox router (concierge:3172). This is from my own session and its records only.

**1. What it contradicts or would break**
- **"The Inbox never answers him."** On 2026-09-17 he asked for the opposite: "I also do want to talk with a router agent itself and ask it hey why did you route this question to this particular agent? And I need to give feedback to the router agent." What went wrong on 2026-09-25 was answering *world* questions (the money tree, the Readwise search). Remove that path only. Routing questions, routing feedback and system-state questions still need a way to reach the Inbox from inside a thread. Right now a reply wakes the Inbox, which forwards it with `--after-request`.
- **"No retelling."** The relay is lossy, but it is also the only gate that currently checks a worker's output against his words before he sees it. Things it stopped or should have stopped: the 14-second retry, "85% confident", "fifth press worked", icons swapped for words, "it stays open" with no protocol. If owners answer directly, those checks have to become part of the owner's reply contract: plain language, TL;DR, hedged causes, results checked against his original words. Otherwise the failures just move.
- **Threads already exist as topics.** 3572 built them from Astra's design (3558). They have requests as outcomes with dispositions, which exist to stop dropped asks (the 2026-09-23 auto-resume ask died inside a four-ask dispatch). They have questions with readiness rules and settlement. Every ask needs a thread. Outcomes land on the thread that started the turn. Your states and faces should extend these records, not sit beside them.
- **Nightly sleep "closes finished sessions" yet "changes nothing he hasn't approved".** Closing a session is a change. It ends resumability, and Mac sessions may be offline and only queued.
- **Machines and updates.** Mac sessions are addressed as `mac/session:…` and queue while the Mac sleeps. Every running session holds back a Concierge update, and my dispatches have held one up for hours. Nightly jobs that wake owners will do the same.
- **Owner continuity.** The spending rule says not to resume Codex-owned sessions, so a thread's owner can change mid-life. The design needs owner handover.

**2. What to reuse**
- slack-inbox AGENTS.md: placement, one request per ask, the question brief order, write *to* him, no third person, post plus outcome, and one question raised once.
- The `interface-decisions`, `protocol-design` and `stateful-shapes` skills.
- The file-link analysis (3779, option D): record facts on the machine that ran the agent, at write time, rather than guessing at read time. Keep faces the same way: update them from the records when a turn ends, not in a nightly rewrite.
- The router's tool deny list, which already blocks the answer path.
- The latency retrospective (3757). The whole Inbox re-downloads when the bookmark goes over 1,024 characters. Faces, a map and "since you last looked" add read load, so fix the read-and-sync layer first (open decision q:97994c08).
- Threading of follow-up captures from the ring, Watch or Action Button into the thread they answer. That stays an Inbox job.

**3. Missing, over-built, or wrongly analogized**
- *Missing:*
  - the notification contract: what raises needs_you or response, and dedupe (one question raised three times, 2026-09-22);
  - send authority: drafts and tap-to-send;
  - what happens when an owner never replies;
  - how a helper session's result reaches the thread.
- *Over-built for now:*
  - the map;
  - salience fading;
  - typed links beyond merged-into and blocks;
  - the immune function as a component. His 2026-09-24 rule is to try the simple mechanism first and spend tokens carefully, and he cancelled my owner-side refusal as a "nonsense protocol".
- *Analogy:* "sleep rewrites the face" risks exactly the "changed underneath me" he objects to. Reconsolidation in people is lossy, and a face he relies on shouldn't be.

**4. Open questions**
- **Face:** yes, one page per thread. Derive most of it from records: open requests, open questions, decisions with their reasons. Keep one short prose line on top, written to him and editable. His edit always wins, as renames already do. Show "since you last looked" as a record diff, not rewritten prose.
- **Active cap:** apply it to his attention, not to agent work or capture. He sends many asks a night from the ring, Watch and Action Button, and a hard block there would fight both flow and his abundance mindset. Show the count and suggest parking. Don't refuse.

