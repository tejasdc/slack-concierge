# How Tejas actually uses Thinkering/Concierge — a usage map from the ledger

Read-only investigation. No writes were made anywhere except this file and scratch scripts under
`/root/workspace/agent-scripts/` (`usage_map.py` and several one-off snippets quoted inline). Data
sources:

- Concierge's SQLite ledger, opened read-only: `file:/root/.local/state/concierge/state.db?mode=ro`.
  Tables used: `session_inputs`, `sessions`, `session_attachments`, `session_communication_requests`,
  `session_owner_events` (kinds `thread_link`, `topic`, …), `inbox_topics`, `inbox_topic_roots`,
  `inbox_requests`, `inbox_questions`.
- The Inbox router's own Claude transcript,
  `/root/.claude/projects/-root-workspace-slack-inbox/37d483bc-cc54-41a5-8525-ae6c2b5f5849.jsonl`,
  and the existing scripts `/root/workspace/agent-scripts/inbox_*.py`.
- `docs/contracts/native-inbox.md` for what the field names mean (topics, thread roots, `thread_link`,
  questions, requests).

Snapshot taken 2026-09-25 evening / early 2026-09-26 UTC. The ledger is a live production database —
counts shifted by a handful of rows between queries because Tejas kept using the app while this was
written; treat every count as "as of this snapshot," not a frozen historical fact. Native usage begins
2026-09-15 (Slack deprecated that day per this repo's `CLAUDE.md`); a short transition tail of
Slack-shaped inputs continues through 2026-09-15 only.

**Confidence key:** Confirmed = read directly off a column. Likely = derived from a clear but indirect
signal (e.g. content-type of an attachment). Unknown/caveat = flagged explicitly below; I did not guess.

---

## 0. Top-line counts

| | Count |
|---|---|
| Total human-origin rows in `session_inputs`, Sept 15–26 | 3,941 |
| Of those, real messages (`kind='input'`: text he actually wrote/spoke) | 1,064 |
| Of those, UI actions (`kind='action'`/`'topic-action'`: mark-read, dismiss, pin, expose, outcome-click) | 2,862 |
| Of those, session-management ops (create/fork/resurrect/reconcile/stop/reaction) | 15 |
| Distinct sessions ever created | 1,022 |
| Distinct worker sessions the Inbox has ever dispatched work to | 87 |
| Inbox topics that exist right now | 412 (357 closed, 55 open) |
| Topics created **after** the topics feature itself shipped (not migration artifacts — see §2.1) | 59 (8 closed, 51 open) |

The 2,862 UI actions are not conversation — they are read-marks, dismissals, pins, "expose" (a topic
being shown to him) and outcome-button taps. They matter for engagement cadence (§1.5) but are not
"messages" and are excluded from the door/length/voice analysis below.

---

## 1. Every human-origin message

### 1.1 How a message is categorized

Every real message (`kind='input'`) falls into exactly one of four shapes, read off the payload's own
structure (confirmed, not inferred):

| Category | Count | What it is |
|---|---|---|
| `direct-chat` | 521 | Typed/spoken straight into a session's own input box — no capture wrapper, no `door` tag. This is the majority mode: talking directly to a specific running session (Inbox or a worker). |
| `capture:thinkering` | 397 | Went through the capture/bug-report pipeline from the Thinkering app (`POST /sessions/v1/inbox`, kind `thinkering`) — usually a "Thinkering bug report" template with description + screenshots. |
| `capture:pebble` | 95 | Same pipeline, but from the physical Pebble device/app (a wearable capture button, not the Thinkering app itself). |
| `legacy-slack-transition` | 51 | Carries a `slack` block (`channel`/`messageTs`) — pre-cutover messages, all dated 2026-09-15, the day Slack was deprecated. Historical only. |

**The `door` field (web vs iPhone app) is not a reliable classifier.** It only started appearing on
2026-09-23 and even after that most `direct-chat` messages still don't carry it — out of 1,064 messages,
only 26 have a `door` value at all (17 `"iPhone app"`, 9 `"web"`). I cannot reconstruct which door every
message came through; I can only say that for the last ~2.5 days of the window, when present, it splits
roughly 2:1 iPhone-app-to-web. There is no `door` value observed for Watch, Mac, or share-sheet in this
window — either those paths don't tag `door` yet, or they route through the same capture pipeline as
Pebble/Thinkering above, which also doesn't record a device tag. **This is a real gap**, not a null
result: the app cannot currently answer "which physical door did this message come through" for the
large majority of its own traffic.

### 1.2 Voice — confirmed-low but almost certainly an undercount

Two independent signals, both weak:

- **Attachment content-type on the message itself:** of 1,064 messages, only 6 carry an attachment whose
  `content_type` starts with `audio/`. (Confirmed.)
- **Transcript-engine metadata** (`session_attachments.transcript_engine`, e.g. `apple.SpeechTranscriber`
  or `parakeet`) on any attachment referenced by the message: only **1** message in the entire window
  links to an attachment with engine metadata set. (Confirmed.)

Neither number is credible as "how much of his input was spoken." The ledger separately holds **2,479
`audio/mp4` and 255 `audio/webm` attachments** in `session_attachments` overall — far more audio than
either signal above accounts for. Reading the capture text itself (dictation-style run-ons, filler words
— "Okay, that makes sense," "Yeah, yeah," "Uh, I mean") strongly suggests the large majority of
`capture:thinkering`/`capture:pebble` messages, and a good share of `direct-chat` ones, originated as
speech. But Pebble does its own device/cloud transcription before the text ever reaches Concierge (per
`docs/architecture/CAPTURE-INGRESS.md`), so those attachments' transcript columns are simply never
populated here — the audio blob and the transcribed text are not both linked back to the same accepted
`session_input` in a way I can join. **Verdict: voice is very likely the dominant modality for captures,
but the ledger cannot currently prove a percentage, and the 6/1,064 and 1/1,064 numbers above should not
be quoted as "voice usage."** This is a design-relevant gap in its own right: the system doesn't durably
know, per message, whether it was typed or spoken.

### 1.3 Length

Average message length by day ranges ~250–3,000 characters (the 2026-09-26 spike is one very long
message, n=4 for that partial day). Typical days run 500–1,000 characters average — these are long,
conversational, often multi-topic messages, not short commands.

### 1.4 Destination

| | Count |
|---|---|
| Landed in the Inbox (session 3172) | 742 |
| Landed directly in a worker session (not the Inbox) | 322 |

Of the 742 Inbox messages, **492 opened/placed a new thread root** (a fresh capture or a plain typed
message with no `replyToMessage`) and **250 explicitly replied into an existing message**
(`replyToMessage` present — a thread reply, most often answering a question the router asked). So roughly
1 in 3 of everything he sends the Inbox is a reply into something already open, not a new topic.

### 1.5 Per-day and time-of-day

| Day | Total msgs | Voice (weak signal) | direct-chat | capture | legacy-slack |
|---|---|---|---|---|---|
| 09-15 | 48 | 0 | 5 | 0 | 43 |
| 09-16 | 182 | 2 | 86 | 88 | 8 |
| 09-17 | 44 | 0 | 25 | 19 | 0 |
| 09-18 | 157 | 0 | 90 | 67 | 0 |
| 09-19 | 5 | 0 | 2 | 3 | 0 |
| 09-20 | 17 | 0 | 3 | 14 | 0 |
| 09-21 | 173 | 4 | 97 | 76 | 0 |
| 09-22 | 168 | 0 | 67 | 101 | 0 |
| 09-23 | 156 | 0 | 80 | 76 | 0 |
| 09-24 | 55 | 0 | 32 | 23 | 0 |
| 09-25 | 55 | 0 | 31 | 24 | 0 |
| 09-26 (partial) | 4 | 0 | 3 | 1 | 0 |

09-19 and 09-20 are clear lulls (5 and 17 messages) between two dense stretches. 09-16, 09-18, 09-21,
09-22, 09-23 are the heavy build days (150–180 messages each).

**Time-of-day (hour histogram, `created_at` is stored in UTC; Tejas's default zone elsewhere in this repo
is America/New_York = UTC-4 during this window):**

Converting to Eastern, there are two clear peaks: **~10pm–2am ET** (the UTC 02:00–06:00 bucket, 71/71/89/79
messages) and **~1pm–3pm ET** (the UTC 17:00–19:00 bucket, 96/88 messages). The trough is mid-morning ET
(UTC 12:00–15:00 → 7am–10am ET, 7–23 messages). This is a late-night-and-early-afternoon usage pattern,
not a 9-to-5 one.

**Bursts:** 130 runs of ≥3 messages within 5 minutes of each other. Sizes cluster at 3–8 (a normal
back-and-forth) but the tail is long: five bursts of 18–24 messages inside a single hour-long window,
e.g. 2026-09-18 04:33–05:23 (24 messages across 5 sessions: Inbox + 4 workers) and 2026-09-21 03:09–03:53
(23 messages across 3 sessions). These are the "rapid iteration" sessions the instructions describe —
dense, multi-session, late-night steering runs.

**Engagement cadence (UI actions, for context):** 1,662 mark-read actions, 935 topic-read actions, 124
dismissals, 73 outcome-acknowledgements, 46 topic "expose," 11 pins, 7 saves, 3 archives. He reads/marks
far more than he writes — roughly 2.7 read/dismiss/pin actions for every one real message.

---

## 2. Thread lifecycles

### 2.1 Important caveat: most "topics" are a one-time migration artifact, not organic threads

412 topics exist. **353 of them (`recovered=1`) were bulk-created by the topics-feature migration**
(`docs/contracts/native-inbox.md`'s "one topic per existing thread root" rule), not opened by Tejas or the
router in the normal course of work. Worse: **all but a handful of those 353 were bulk-*closed* in the
same single administrative sweep** — every one of their `closure_json` rows carries the identical
`inputId`/`runId` and a near-identical generic reason ("The work here is finished and nothing is waiting
on you"), timestamped within the same few seconds on 2026-09-22 23:12:00. That is one agent action closing
~350 topics at once, not 350 independent thread endings. **Any lifecycle statistic computed over all 412
topics is dominated by this one-time event and is not a measure of how threads actually live and die.**

The genuinely organic population is the **59 topics created after that migration**
(`recovered=0`, created 2026-09-22 through 2026-09-26). All statistics in the rest of this section use
that set unless stated otherwise.

### 2.2 How a thread begins

Three confirmed origins, read off `inbox_topic_roots.root_input_id` prefix and `placed_by_json`:

1. **His capture** (dominant) — `capture:*` root, 126 of 141 organic roots. A new Thinkering/Pebble
   report, or a plain typed Inbox message, becomes a topic's first root.
2. **An agent's own follow-up becoming a root** — 4 organic roots start with `request:*`, `origin='agent'`.
   These are the router (session 3172) sending its own outbound request, which is then itself recorded as
   a thread root. In every case observed, this lands as an *additional* root inside the **same** topic the
   router was already working (a continuation), not a brand-new topic spun off elsewhere.
3. **A service notice** — 5 organic roots start with `service:service-notice:*`, e.g.
   `service:service-notice:retry:codex-session-observer:app-server:...`. These are automated retry/outage
   alerts (Codex conversation/Remote observation breaking) that open their own topic the moment they exist,
   per `resolveRetryNotices` — no human capture involved at all. **Notably, two simultaneous but distinct
   automated alerts about what reads like the same underlying incident** (Codex conversation observation
   and Codex Remote observation both stopped) **opened as two separate topics at the identical millisecond**
   (2026-09-25T03:23:39.519 / .531) rather than merging into one. Whether that should merge is a fair
   question for the design session — right now the system treats "which observer broke" as the identity
   of the incident, not "something broke."

**Zero organic roots are agent-initiated dispatches from a *worker* session** (i.e., no worker session has
ever independently opened a new thread root; `SELECT ... WHERE thread_root_input_id IS NOT NULL AND
source_session_id != 3172` returns 0 rows). All fan-out is strictly hub-and-spoke through the single Inbox
session — a worker never spins up its own side-thread with Tejas.

### 2.3 Fan-out: how many of his messages/captures merge into one thread

Roots-per-topic, organic set (n=59):

| Roots merged into one topic | # topics |
|---|---|
| 0 (topic created but empty — see §3) | 1 |
| 1 (single capture, no merges) | 37 (63%) |
| 2 | 8 |
| 3 | 4 |
| 4 | 3 |
| 5 | 1 |
| 8 | 1 |
| 9 | 1 |
| 11 | 1 |
| 14 | 1 |
| 16 | 1 |

**Nearly two-thirds of organic topics are one-shot**: a single capture or message, answered, done. The
tail is long and thin — a handful of topics (deployment/usage/account-switching, vocabulary research,
Dynamic Island) absorb 8–16 of his messages each over days. Those long-running topics are exactly the ones
this design session should look at closely, because they're where "what counts as the same thread" gets
tested hardest.

### 2.4 Depth: threads are flat by design, and the data confirms it

The contract states "every Inbox message resolves to one thread root" — there is no nesting beyond one
hop. Checking the `thread_link` events: even when a capture is attached to another *message* (a `post:` or
a bare input UUID) rather than directly to the root, that intermediate message's own root is always the
*same* root the capture ends up filed under. So there is no topic with effective depth >1: a thread is a
flat set of roots pointing at one anchor, never a chain of chains. "Depth" as a graph metric is
uninteresting here — the real variable is fan-**in** (§2.3), not fan-out-and-down.

### 2.5 Dispatch: how many worker sessions one thread spawns

Distinct worker sessions dispatched per organic topic:

| Distinct worker sessions | # topics |
|---|---|
| 0 (discussion only, no work dispatched) | 34 (58%) |
| 1 | 18 |
| 2 | 5 |
| 3 | 1 |
| 7 | 1 |

58% of organic topics never dispatch any work at all — they're pure conversation, a question answered, a
bug acknowledged, a note taken. Of the 25 that do dispatch, most spawn exactly one worker session. One
topic — **"Usage: live readings and resets"** — spawned **7** distinct worker sessions (3633, 3279, 3283,
3635, 3637, 3660, 3572) across 36 separate dispatch actions over roughly three days; this is the
deployment/usage-reset saga referenced elsewhere in this repo's history. It is the single most fanned-out
thread in the whole window, by both roots (16) and dispatches (36).

Across the *entire* ledger (not just organic topics), the Inbox has dispatched to **87 distinct worker
sessions** out of 1,022 sessions ever created — the rest are either direct sessions he opened himself,
worker-to-worker sub-dispatches invisible to the Inbox, or Slack-era debris.

### 2.6 How a thread ends

Of the 59 organic topics, **51 are still open**; only **8 have closed**. Closure reasons, all human-legible
sentences the router writes at close time:

- 5 of the 8 say some version of *"The work here is finished and nothing is waiting on you. Anything new on
  this subject starts it again."* — the generic default closure.
- 1 says *"Decision: keep today's engine plus your correction list; no switch."* (Vocabulary research — a
  substantive decision recorded as the close reason, not the generic sentence.)
- 1 says *"Fixed: the missed setup is applied and the step now reaches GitHub on its own."* (a genuine bug
  fix).
- 2 are the automated observer-recovery topics, closed with *"Codex conversation observation is running
  again as of September 25 at 2:28 AM ET. Nothing waits on you."* — closed by the same automated mechanism
  that opened them, no human action at all.
- **1 was closed 15 seconds after it was created**, reason: *"Created empty by mistake; the design session
  is tracked in the thread where you asked for it."* — the router opened a topic in error and immediately
  closed it once it realized the real conversation belonged elsewhere. (Title: "Designing how my agents are
  organized" — ironically, this very design question.)

Closed-organic-topic lifetimes (creation to closure) range from **15 seconds** (the mistake above) to
**1 day 15 hours** (Vocabulary research); most of the "generic reason" closures land same-day, 2–17 hours
after opening.

**No topic has ever been merged with another** in the organic set (`sessions topics merge` exists as a
command per the contract, but no merge event appears in this window's data). Given how many one-shot
topics exist alongside a few overloaded ones, merge is a plausible but unused tool.

### 2.7 Graph: a representative window (2026-09-22 through 2026-09-25)

This covers the entire organic-topic period. Rather than draw all 59 topics (most are single-node
one-shots, per §2.3), the graph below shows the Inbox hub, the handful of topics with real fan-out or
fan-out-to-workers, one pure-discussion topic, one automated-service-notice topic, and the one
misroute-then-correction sequence found in §3. Edge labels give root/request/dispatch counts where useful.

```mermaid
graph TD
  Inbox(["Inbox session\nconcierge:3172"])

  T_usage["Usage: live readings\nand resets\n16 roots / 36 dispatches"]
  T_switch["Switching which account\nmy agents use\n14 roots / 0 dispatch"]
  T_vocab["Vocabulary research:\ngetting my words right\n11 roots / 2 dispatch"]
  T_dynamic["Copy or send from\nthe Dynamic Island\n9 roots / 0 dispatch"]
  T_posting["Agents posting as you\n8 roots / 7 dispatch"]
  T_update["Knowing what an update\nbrings before it lands\n5 roots / 6 dispatch"]
  T_permissions["Asking for permissions\ninstead of showing errors\n4 roots / 0 dispatch"]
  T_mistake["Designing how my agents\nare organized\nclosed in 15s: created by mistake"]
  T_svc["Codex conversation\nobservation stopped\n(service-notice root)"]
  T_svc2["Codex Remote\nobservation stopped\n(service-notice root, same instant)"]

  W3633[["worker 3633"]]
  W3279[["worker 3279"]]
  W3283[["worker 3283"]]
  W3635[["worker 3635"]]
  W3637[["worker 3637"]]
  W3660[["worker 3660"]]
  W3572[["worker 3572"]]

  Cap1(["capture: 'sent this in\nthe wrong thread'"])
  Cap2(["a469e... direct message\nmisrouted"])

  Inbox -->|16 captures merge in| T_usage
  Inbox -->|14 captures merge in| T_switch
  Inbox -->|9 captures merge in| T_vocab
  Inbox -->|9 captures merge in| T_dynamic
  Inbox -->|7 captures + 1 direct msg| T_posting
  Inbox -->|5 captures merge in| T_update
  Inbox -->|"1 capture + 3 direct\nInbox messages"| T_permissions
  Inbox -.->|opened then closed 15s later| T_mistake
  Inbox -.->|auto-filed at incident time| T_svc
  Inbox -.->|auto-filed, same instant\n(not merged with T_svc)| T_svc2

  T_usage --> W3633
  T_usage --> W3279
  T_usage --> W3283
  T_usage --> W3635
  T_usage --> W3637
  T_usage --> W3660
  T_usage --> W3572
  T_vocab --> W3572
  T_posting --> W3637
  T_posting --> W3572
  T_update --> W3283
  T_update --> W3635

  Cap1 -.->|misfiled by router,\nagent notices| T_vocab
  Cap2 -.->|his correction:\n"move this thread\nto the right thread"| T_vocab
  Cap1 -->|thread_link fix,\n17s later| T_vocab
  Cap2 -->|thread_link fix,\n17s later| T_vocab

  classDef svc fill:#eee,stroke:#999,stroke-dasharray: 3 3;
  class T_svc,T_svc2,T_mistake svc;
```

**Fan-out summary for this window:** median organic topic = 1 root, 0 dispatch (a single answered
question). 90th-percentile topic ≈ 5–9 roots, 1–2 dispatches. The single outlier (Usage/resets) has 16
roots and 7 dispatches — 4–7x the next-busiest topic. Depth is always 1 (§2.4); the only structural
variation across topics is *width* (how many of his messages land in it) and *out-degree* (how many
worker sessions it spawns), not nesting.

---

## 3. Mistakes and corrections

**The dedicated "detach"/"unthread" self-service control appears to have never been used.** The contract
describes a human split action (`sessions thread --detach`, surfaced as an "unthread" message action) for
exactly this case. Across all 35 `thread_link` events in the ledger, **100% have `routedBy.kind:"agent"`
and `attached:true`** — every single placement was the *router* attaching a capture to a thread on his
behalf; none is a human-initiated detach, and none has `attached:false`. Either the control has genuinely
never been needed, or it's not discoverable/used in practice — the data can't distinguish those, but it
can say the ledger has zero recorded uses of it in this window.

**Full-text search across all 1,064 real messages** for correction language ("wrong thread," "wrong
session," "meant for," "ignore that," "move this," "never mind," "my mistake," etc.) returned 31 hits;
most were false positives (e.g. "let's not ignore this" about a real bug, "never mind, let me read that").
The genuine misroute/correction examples:

- **2026-09-21 03:47:28**, session 3425: *"Oops, that skill update was not uh for you, it was for a
  different agent. Skip that. Uh my inbox agent is already working on it."* — a message sent to the wrong
  worker session entirely (not a thread misroute, a session misroute).
- **2026-09-23 21:21:12**, Inbox: *"I think I like sent a request in the wrong thread here. move this
  thread to the right thread... I have the ability to like move it to the right thread here and start
  responding in the right thread."* This is the one clean, corroborated example: 17 seconds later, two
  `thread_link` events fire (21:21:29) attaching both the misplaced input and this very correction message
  into the "Vocabulary research" topic (§2.7 graph). Cause → agent-executed fix, in under 20 seconds.
- **2026-09-25T17:52:16 topic close**, *"Created empty by mistake; the design session is tracked in the
  thread where you asked for it."* — the router's own misfire (§2.6), self-corrected, no complaint from him
  required.
- **2026-09-23 23:50:34**, Inbox, a *different* kind of complaint — not a misroute but a UX/notification
  bug: *"Notification disappear as soon as I went to the inbox... I really like, you know, mixing them up,
  because now, when I open up... in the main inbox request, it clears up all of the different threads,
  notification again."* Worth noting because it's adjacent to threading (notification-clearing bleeding
  across threads) without being a misfile.

**No case was found of the Inbox misrouting a capture and Tejas correcting it after the fact via a UI
control** (as opposed to a verbal complaint the agent then acted on) — every correction observed was
agent-executed in response to his words, not a structural "move to thread X" click by him. Given only one
clean misroute example surfaced in ~10 days and ~500 merged captures, misrouting itself looks rare;
what's untested by this data is whether that's because routing is accurate, or because a misrouted capture
that never gets *mentioned* again would be invisible to this kind of text search.

---

## 4. Topic categories

Manually classified the 59 organic topic titles (titles are short and unambiguous enough to classify by
inspection; this is a judgment call, not a derived field):

| Category | # topics | Examples |
|---|---|---|
| Concierge/infrastructure (sessions, deployment, accounts, protocol) | 21 | "Switching which account my agents use," "Signing my other accounts in," "Usage: live readings and resets," "Server setup update failed," both Codex-observer service notices (×2 pairs) |
| Thinkering product (app UI/UX, iOS features, bugs) | 18 | "A big live widget on my iPhone," "Copy or send from the Dynamic Island," "No notifications on my phone," "Running sessions buried in the list," "Watch app: tap to open, record, upload directly" |
| Inbox/threading meta-design (about the Inbox itself) | 7 | "Questions and results landing in the right thread," "Agents posting as you," "Questions screen redesign," "A notification opened to 'not in a thread yet'," "Threads take seconds to open," "Designing how my agents are organized" |
| Life logistics (personal, non-build tasks) | 5 | "Email to building maintenance about low water pressure," "Sakagura reservation, tomorrow 6:30 PM for two," "Messages to Raghav," "My money tree by the south window," "Joining Google and Zoom calls with my chann.app email" |
| Research / notes-only (not meant to be built) | 5 | "Vocabulary research: getting my words right," "SoL-Pi paper: self-improving agent research loops," "My saved articles on third places," "Companies I'm collecting," "Looking back at what I've built since May" |
| Personal project ideas | 2 | "Same-song app," "My website header links" |
| Uncategorized/ambiguous | 1 | — |

(Counts sum to 59; a few topics could plausibly sit in two buckets — e.g. "Agents posting as you" is both
an Inbox-meta topic and a trust/safety complaint — I picked the primary reading.)

**Ideas/notes vs. requests to act:** using `inbox_requests` linkage as the proxy for "a formal request was
opened" (as opposed to pure discussion/consult), **20 of 59 organic topics (34%) never opened a single
request** — these are conversational: a question answered, a decision recorded, a note filed, with nothing
dispatched. That lines up closely with §2.5's "34/59 (58%) never dispatch a worker" — the two numbers
aren't identical because some topics get a *request* opened but never actually reach dispatch (e.g. still
queued, or answered directly by the router without spinning up a worker).

The clearest **pure-notes, not-meant-to-be-built** examples: "Companies I'm collecting," "My saved articles
on third places," "Looking back at what I've built since May" — all zero-request, zero-dispatch, read as
him thinking out loud or asking the router to remember something rather than do something. The clearest
**life-logistics-as-action** example is the opposite: "Sakagura reservation, tomorrow 6:30 PM for two" is a
short, direct request the router presumably acted on (an actual task, dressed as a one-line capture) —
distinguishing "note to self" from "please do this" by title alone is not always possible; request-count
is the better signal where it's available.

---

## 5. Open questions this raises for the design session (not recommendations)

These are observations, not proposals — deciding what a "thread" should be is the design session's job,
not this investigation's:

1. **Voice is probably dominant but the system can't currently prove it per-message** (§1.2). If "what door
   did this come through" matters to the thread model, that's a data-capture gap to close before design,
   not just an analysis gap.
2. **`door` tagging is inconsistent and recent** (§1.1) — most of the app's own history can't be attributed
   to web vs. iPhone vs. Watch vs. Pebble by device at all, only by capture-pipeline vs. direct-chat.
3. **Two-thirds of threads are one-shot** (§2.3) and **58% never dispatch work** (§2.5) — most of what lives
   in a "thread" is small and short. The design question this raises: should the thread model optimize for
   the long tail (the 16-root, 7-dispatch outlier) or the median (1 root, 0 dispatch), and can one shape
   serve both without the small case feeling like overhead?
4. **All fan-out is hub-and-spoke through one Inbox session** (§2.2) — no worker has ever opened its own
   thread. Is that a deliberate invariant worth keeping, or an artifact of no one having built the
   alternative yet?
5. **Simultaneous related service notices become separate, unmerged topics** (§2.2, §2.7) — is "same
   incident" or "same observer" the right unit of a thread for automated notices?
6. **The self-service unthread/detach control has zero recorded uses** (§3) — worth asking him directly
   whether he knows it exists, rather than inferring non-use as non-need.
7. **Roughly a third of organic topics are pure notes/consult with no request or dispatch** (§4) — if a
   redesigned thread model changes what "closing" or "acting on" a thread means, it should have a cheap,
   honest path for "this was never meant to be built," distinct from "this was meant to be built and
   wasn't."

---

## Appendix: scripts and reproducibility

- `/root/workspace/agent-scripts/usage_map.py` — categorizes every human `session_inputs` row, produces
  §1's per-day/per-hour/burst/category tables, pickles the parsed records to
  `/root/workspace/agent-scripts/_usage_map_records.pkl` for reuse.
- Ad-hoc queries for §2–§4 (topic/root/request/dispatch joins, `thread_link` inspection, capture-source and
  voice-attachment joins, correction-phrase text search) were run inline against the same read-only
  connection and are not separately saved as scripts; the exact SQL/Python for each figure above is
  reproducible from the table/column names cited in each section.
