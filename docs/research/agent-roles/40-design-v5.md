# Design v5: threads with owners, on the existing records
2026-09-26 · design session concierge:3756 · Status: PROPOSED to Tejas. Nothing approved, nothing built.

**How this was made.**
- Research: files 01–21.
- A first proposal (22), reviewed by a fresh Claude reviewer (23).
- Round one, eight live sessions: the Inbox 3172, threads design 3558, threads build 3572, notifications and
  inbox view 3291, threads brainstorm 3438, colony-lab 3592, attention 3364, first thread design 3188. Plus
  the latency retrospective 3757 (files 25–33).
- Historical sessions read from their transcripts: self-healing-agents, journalmaxx, claritymaxxing,
  agent-ecology (file 24).
- Design v4 (34), with round two from 3172, 3558, 3572, 3291 and 3438 (files 35–39).
- This version takes in every blocking point from round two.

## 1. The problem
- The Inbox carried every back-and-forth between him and the working agents. Worker answers were 59% of what
  it read, it was compacted 12 times in 9 days, and fixes made only through instructions kept failing.
- He prefers threads to the sidebar, which lists 303 "active" sessions, 202 of them from the Slack era.
- He values the Inbox's wide context: it expands cryptic messages and points to related sessions.
- He wants the back-and-forth to happen directly with the agent doing the work.
- Rule: foundations change only with his approval.

## 2. The change in one sentence
Every thread has one designated owner: the session he converses with. His replies in the thread go to that
owner, and the owner answers in the thread in its own words. The Inbox places captures, keeps a directory of
threads, and speaks only about routing. It no longer relays.

## 3. Parts and where they run
| Part | Runs on | Holds / does | New in v5 |
|---|---|---|---|
| Session owner (Concierge) | server; its peer on the Mac | ledger of sessions, inputs, requests, topics (= threads), questions, posts, reading marks, notification slots | a thread's **designated owner**; routes his thread replies to that owner; records owner posts under the thread; refusal and closure rules below |
| Inbox | Claude session in the Inbox project, server | front door: places captures, drafts the thread's "what belongs here", hands off, answers routing questions, moves threads | reads the directory (plus bounded source retrieval when placement is unclear), not worker conversations; gets status as facts, not turns |
| Owning session | the work's project, server or Mac | does the work and converses in its thread | posts into its thread; closes the requests it served |
| Helper sessions | any project | work on requests the owner or Inbox sends | none (ownership never moves silently) |
| thnkr.ing | web and iPhone | Threads home, thread view with brief | replaces the session sidebar |

## 4. Flows (✱ marks behavior that is new)
**(a) Capture**
1. The owner records the capture.
2. The Inbox takes a turn. It reads the capture in full, with attachments.
3. It reads the directory: titles, one-line status, designated owner, "what belongs here".
4. ✱ When placement is unclear, it may retrieve a bounded amount of source material.
5. It places the capture into an existing thread or creates a new one. On creation it drafts a one-sentence
   "what belongs here" ✱, which he can accept or edit.
6. For work, it sends a request with a hand-off packet: his exact words kept separate from its own reading,
   the related threads and sessions, and what done looks like.
7. ✱ The first request's destination becomes the designated owner.
8. A spoken capture that covers several owners' questions is split by the Inbox. Clauses that don't get
   answered stay open.

**(b) The owner answers**
1. ✱ It posts into its thread. The owner records the post in the thread's ledger under the thread root, with
   the posting session as author, using the mechanism that already relays posts made on another turn's behalf.
2. The post follows the reply contract: a TL;DR, plain language, hedged causes, the result checked against
   his words, and drafts that are not sends (only his tap sends).
3. It declares its outcome. A question is filed only through the question command, as today.
4. ✱ It closes the topic request it served, with a disposition and a reason, in the same declaration.
5. ✱ The owner refuses to settle a dispatch whose linked request is still open with no disposition. This
   keeps in place the guard added after 2026-09-23.
6. The status line comes from requests, dispatches and declarations.
7. ✱ The Inbox gets this as a fact, not a turn.

**(c) He replies in a thread**
1. ✱ The reply is kept as the thread entry in the Inbox ledger: one identity, so the thread root, Timeline and
   slot all resolve.
2. The same input is delivered to the designated owner, keeping authorship, the thread link and the message
   it answers.
3. The Inbox is not woken.
4. Delivery by the owner's state:
   - idle but able to start: it starts;
   - running: the reply queues behind its own run;
   - on a Mac that is asleep: it waits on the peer channel and shows Queued.
5. ✱ If the owner can't take it (archived, stopped, or a Codex session under the spending rule), the reply
   goes back to the front door. It is never queued forever.

**(d) Wrong place**
- ✱ The owner can hand a reply back to the front door ("not mine"). The Inbox then places it with his text.
- "Ask the Inbox" already exists in the reply sheet, for routing questions ("why was this sent there?").

**(e) Several agents on one thread**
- Helpers get requests. Each destination has its own delivery, progress and result.
- The thread shows "in progress" while any of them is open, and never collapses to Failed.
- ✱ Ownership moves only through an explicit transfer, by him or by the Inbox, and the transfer is recorded.
- A session may serve several threads.

**(f) Guards and attention**
- ✱ A quiet end on his own message needs a reason. The condition becomes "this input arrived through a
  thread", not "this session is the Inbox".
- Attention ends on any of these, never on a blanket reply:
  - his answer to that particular question;
  - his Read, for reading items;
  - a dismiss;
  - explicit supersession, with a replacement;
  - the owner settling it, for example when a notice's condition clears;
  - the thread closing.

**(g) Notifications**
- ✱ The notification slot is keyed on the thread, not on the Inbox session.
- ✱ The reply route resolves thread → designated owner → session, so press-and-hold reply on the iPhone still works.
- Every notification names the exact message ID.
- ✱ The device refuses to settle on a candidate built from data older than the moment the question was asked.
  That is the cause of the 196 ms "correct landing" on the wrong message.

**(h) Updates**
- Turns started by direct replies count as running work, and running work holds back a Concierge update, as it
  does today.
- The update line already shows what is waiting, and it shows these turns too.

## 5. What he sees
**Threads home**, replacing the sidebar:
- One row per thread: title, designated owner and machine, status line, a waiting-on-you mark, and changed
  since last read. That count comes from his reading mark in the records, never counted in the view.
- Order: running, then pinned, then recency.
- "Needs you" is a filter and a mark on the row, not a ranking. This replaces the older
  oldest-unresolved-decision order, and the change is named here on purpose.
- Order stays stable during live updates.
- Sessions that agents started are reachable only inside their thread.
- The Slack-era sessions are archived out of view, not marked done. Their unresolved requests and questions
  are kept.

**Thread view**:
- A collapsible brief at the top:
  - his purpose line, editable and locked against agents;
  - "what belongs here";
  - open questions and requests, taken from the records;
  - decisions with source links;
  - "since you last looked", as a diff against his reading mark.
- A single-capture thread shows the capture itself as its brief.
- Below the brief: the conversation (him, the owner, and the Inbox's deliberate posts), then the Timeline.
- Attachments, viewing and pinned capture targets are unchanged.

## 6. Prerequisites (part of the same change, not phases)
1. **Exact message IDs in notifications**, plus the device refusing stale candidates.
2. **Bounded reads.**
   - Today the Inbox's receipt cursor is 1,348 characters. The proxy accepts 1,024, so the page falls back to
     the full 23 MB list (515 refusals in 3 hours).
   - Replace the cursor with a watermark and an open set held on the server.
   - Opening a thread costs one page. An update costs only what changed.

## 7. What it replaces
- The Inbox relaying answers.
- The flat sidebar.
- The Inbox's rulebook growing by one paragraph per incident. Its role now comes from the directory and a
  limited set of tools. The deny list already blocks answering world questions.

## 8. Grounding (why each role has this shape)
| Shape | Evidence |
|---|---|
| The Inbox chooses and does not do the work | the basal ganglia select without executing (Redgrave 1999); the prefrontal cortex biases, it doesn't perform (Miller & Cohen 2001) |
| A directory, not conversations | hippocampal indexing (Teyler & DiScenna 1986); transactive memory, where a trusted directory means less traffic (Wegner 1987; Ren & Argote 2011) |
| No relay | protect the regulator by filtering what reaches it (Ashby; Beer); headquarters out of operations (Chandler; Williamson) |
| One owner, the dispatcher steps out | the contract net (Smith 1980); air traffic transfer of control, one voice on the radio; one attending physician |
| Packet plus read-back | I-PASS handoffs, −23% medical errors (Starmer 2014) |
| Separate processes, not modes | specialization pays when switching is costly (Rueffler 2012; Goldsby 2012) |
| Structure added only on measured need | the Galbraith/Mintzberg ladder; coordination emerges where its cost is priced (colony-lab, paper 04) |
| No named sleep or immune organs | his own 2026-09-01 stance and the agent-ecology constitution (emergence first) |
| Brief with provenance, his edits win | separate episodic and consolidated stores (McClelland 1995); recall distorts (Nader 2000) |

## 9. How structure evolves (tracker)
- Computed weekly by code from the records, and on request. It posts one reading item into a "System" thread.
- A trigger must hold two weeks running before it proposes anything.
- Every proposal names its smallest alternative and how to undo it.

| Signal | First threshold | Proposes |
|---|---|---|
| Open threads in one project | ≥10 with ≥3 overlapping, 2 weeks | a coordinator for that project: its own directory, no relay |
| Returns to front door / moves | ≥15% of placements | routing changes, or the routing experiment (O5) |
| Corrections of owner read-backs | ≥3/week in a project | a stronger hand-off packet there |
| Design threads with open decisions older than 7 days, pulled by a build | any | ask those decisions inside the build thread |
| Same failure signature | ≥3 | one grouped incident with a proposed check (monitoring, not autonomous repair) |
| Inbox reading beyond the directory | above a limit | directory changes |
| Threads he steers beyond 5 / parks reopened within 24h | measured | whether a focus limit helps |

## 10. Options (separate proposals, each depends on the core)
- **O1. Consolidation on settlement.** A non-owner agent proposes brief updates, with sources; he accepts in one tap.
- **O2. Grouped incident detection** (monitoring).
- **O3. Nightly pass** on the self-healing sleep agent (decay 0.9, prune below 0.2, never under 3 cycles,
  two-signal). Only if O1 and the tracker show a need. Undoable housekeeping is kept separate from proposals.
  Decay only fades a mark; it never reorders or retires.
- **O4. Map view.**
- **O5. Routing experiment:** today's Inbox against a constrained model, on about 700 captures whose
  destinations are already recorded.
- **O6. Journalmaxx atom layer** for voice bursts, unchanged format.
- **O7. Cross-store link:** one pointer from a thread to a workspace note, so idea threads (notes) and work
  threads (topics) don't drift apart. Thinkering's 18 typed links live in the note store and don't span to
  topics today, and agents can't write into notes. This is new work, not something inherited.

## 11. The least option, for comparison
**D.** A thread is simply a session he opened. The agent sessions are hidden under it. The Inbox only binds
captures and stops relaying.
- **Where it wins:** it's smaller and uses one store.
- **Where it loses:**
  - a thread has no identity once work moves to another owner;
  - idea threads have no agent;
  - it can't have several destinations or a brief.
- **What decides between D and the core:** read the payloads in Thinkering's thread-history plan. Count how
  often one line of his attention moved across sessions or projects. (The 257-of-281 reuse figure shows
  destinations being reused, not threads moving, so it does not decide this.)

## 12. Excluded on purpose
- Unattended rewrites.
- A hard cap.
- Named sleep or immune organs.
- A new link vocabulary.
- One combined state chain. Attention, execution and maturity stay separate axes.
- Agents chatting peer to peer. Cross-agent asks stay as recorded requests.
- Salience ranking.

## 13. Decisions for him
1. The core, or least option D?
2. Keep sleep and immune unnamed (his 2026-09-01 stance)?
3. Which options, if any, go into the same change?
