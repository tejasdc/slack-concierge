# Unfinished design/brainstorm sessions and reuse-without-deciding — measurement

Read-only. Source: Concierge's SQLite ledger (`/root/.local/state/concierge/state.db`,
opened read-only), `router-actions.sh sessions search` for corroboration, and
`docs/plans/` in `thinkering`. Scratch scripts: `/root/workspace/agent-scripts/unfinished_sessions.py`,
`design_sessions_human_only.txt`, `engaged_sessions.json`, `engaged_sessions_heuristic.json`.

## Data-completeness caveat (read this first)

Per-session outcome tracking (`outcome`, `turnOutcome`, `needs[]` in `native_metadata_json`) —
the mechanism that lets us say "shipped" vs "waiting on him" precisely — did not exist until
the 2026-09-22/23 "one source of truth for session attention" work. It is populated for only
**40 of 266** sessions he engaged with since 2026-08-01. `title` and `pinned` are also
post‑2026‑09‑15 native-session fields; ~191 sessions from Aug 2026 are pre-convergence
Slack-thread rows with no title/pinned metadata at all, so they cannot be found by keyword or
pinned-flag search — only by reading `turns.user_text`, which I did not do exhaustively for
that older population. Numbers below are **confirmed** for the tracked cohort and **heuristic/
likely** for the rest; I flag which is which.

## 1. Sessions he engaged with directly since ~2026-08-01

**266 sessions** have ≥1 turn originating from him (joined `session_inputs.origin='human'
AND kind='input'` to `turns.turn_id` for the native model; `turns.turn_kind='slack_user'` for
the pre-9/15 Slack model) and were created on/after 2026-08-01.

Confirmed, mechanism-tracked cohort (40 sessions, all from ~9/15 onward, all still `idle`/`running`,
none archived):
- **shipped_done** (outcome=done, no open needs_you): **14**
- **waiting_on_decision** (turnOutcome or an unresolved `needs[]` entry = `needs_you`): **7**
- **open, no outcome declared / done-but-not-flipped-closed** (has metadata but `outcome` field
  is still `open` or absent, and the last declared turnOutcome was actually `done`/`response`):
  **19** — mostly finished work that was never explicitly closed, not "abandoned design."

The 7 **waiting_on_decision**, with last activity:
| id | title | last activity | his messages |
|---|---|---|---|
| 3172 | Inbox (router) | 2026-09-26 00:23 | 726 (not a design session — the router itself) |
| 3438 | Brainstorm: topic threads that keep collecting | 2026-09-22 14:35 | 1 |
| 3592 | Fork: Brainstorm: topic threads that keep collecting | 2026-09-22 22:37 | 13 |
| 3628 | Build the macOS identity & permissions skill | 2026-09-23 04:39 | 2 |
| 3633 | Detecting usage-limit resets before they expire | 2026-09-24 05:06 | 3 |
| 3718 | Same-song app: design and prototype | 2026-09-25 00:49 | 2 |
| 3756 | Design: agent roles, routing and protocols, grounded in cognitive science | live now | 3 |

For the remaining **226 untracked** sessions (mostly pre-9/22 native and all pre-9/15 Slack), a
last-turn-text heuristic (ends in "?" → open question; contains "deployed/shipped/pushed/live" →
shipped-ish) found only **6** ending on an explicit open question and **115** with shipped-style
language — but this heuristic is weak: Concierge's convention is to end with a TL;DR statement
even when a decision is still implicitly pending, so it undercounts "waiting on him." I did not
find a reliable automatic signal for this older cohort; treat the 7-session precise count above
as a lower bound on "waiting on a decision," not the true count for the full since-8/1 window.

## 2. Design/brainstorm/pinned sessions

Only 5 sessions currently carry `pinned:true` (pinning is live state, not history, so earlier
pins he removed are invisible here): **3262, 3279, 3438, 3756, 3757** — all in the tracked
cohort, all created 2026-09-16 or later. Adding title-keyword matches (design/brainstorm/
proposal/research/architecture/thread/attention) among the 266 gives 14 candidates total.
Detail on the substantive ones (excluding pure bug-fix sessions like 3012/3081/3275/3586):

- **3279 — "Agent usage limits and nightly scheduling design"** (pinned). 11 of his messages
  over 8 days (9/16–9/24). Stalled once explicitly ("Let's design and discuss the banking
  feature later"), got reopened by usage-limit frustration ("What the fuck happens if the sign
  in is not present?"), produced `docs/plans/2026-09-16-banked-work-and-usage-observation.md`.
  **Reached decisions and shipped** — but its own doc is now marked "superseded 2026-09-23,"
  replaced by two docs in `slack-concierge` written by different sessions after further
  argument. Session itself ends `response`, not `done`.
- **3364 — "Brainstorm: which sessions need my attention"**. 6 messages, 9/18, ~13 hours.
  Concluded with two concrete rule changes ("agents now have to mention you," instruction
  updates) — a genuine small decision reached in-session. classification: `open_no_outcome`
  but last turnOutcome=`done`.
- **3425 — "Native voice capture and transcription architecture"**. 19 messages, the most
  engaged brainstorm-turned-live-debug (9/20–9/22, 87 turns total). Includes his angriest
  moment ("Who the fuck built this shit?"). Ends `response` — largely built (voice capture
  shipped per `docs/plans/2026-09-20-native-voice-capture-transcription.md`) but not declared
  closed.
- **3438 — "Brainstorm: topic threads that keep collecting"** (pinned). **1 human message, and
  it transcribed empty** (likely a voice note whose text never landed — a data gap, not silence).
  Never got a reply from him after the agent's response; still `waiting_on_decision`, idle since
  9/22 14:35. **This is the clearest "stalled after ~0 exchanges" case** — pinned, live for
  4 days, and effectively one-sided.
- **3592 — "Fork: Brainstorm: topic threads that keep collecting"**, forked from 3438 the same
  minute. 13 messages, but the conversation drifted from the original topic-threads question
  into an unrelated research tangent (a GitHub ant-colony/stigmergy simulation, then a share-link
  HTML viewer). It never returns to "topic threads" and ends on a documentation nitpick. Still
  `waiting_on_decision`.
- **3718 — "Same-song app: design and prototype"**. 2 messages, new-project design that
  immediately became bug triage (Spotify rate limits, background recording failures). Still
  `waiting_on_decision`.
- **3756 — "Design: agent roles, routing and protocols, grounded in cognitive science"**
  (pinned, **the parent of this very analysis task**, still running). 3 messages over 6+ hours.
  Last exchange (turn 3939 → 3944, in progress as this was written):
  > **Agent (3939):** "My proposal is that every thread gets one owning agent, and your replies
  > go to that owner... A weekly review, calculated from the records, tells you wh[at needs
  > attention]..."
  > **Tejas (3944, live):** "...sometimes I start a design discussion... it becomes taxing and I
  > don't complete them because there's a lot of decisions to be made and I don't complete
  > them. But what has been really helpful is like next time I'm trying to build a feature, I
  > just ask that agent to get some input from that session... even though I didn't actually
  > make a decision in that session... in some sense it also kind of gets me away with not
  > finishing the actual real work of taking the hard decisions."

  This is him describing the exact pattern under measurement, live, inside a session that is
  itself an instance of it — the strongest evidence in this dataset, and it is a direct quote
  rather than an inference.
- **3757 — "Why my system keeps getting slow: deep retrospective"** (pinned). **0 human
  messages** — created for him, he hasn't engaged with it at all; the agent delivered a
  retrospective doc unprompted-by-reply. Excluded from the 266 (no human turn) but listed
  since it's pinned and clearly in-scope for "design sessions left unengaged."

**Where they stall:** every stalled session above stalled at 1–3 of his messages, not after
many; length in turns is driven by agents-talking-to-agents (3291 has 64 turns but only 8 from
him), not by him working through many decisions. The pattern is "one message in, agent produces
a large structured response with several options/questions, no reply" (3438, 3718, 3756), or
"the conversation itself drifts away from the original decision" (3592).

## 3. Reuse: later sessions pulling context from an unfinished design session

Concrete, ledger-confirmed cases (via `session_communication_requests`, which record every
agent-to-agent ask/reply):

- **3279 → 3633**: "Agent usage limits and nightly scheduling design" was consulted by
  "Detecting usage-limit resets before they expire" (request `b83bfe85`). 3633 itself ends
  `waiting_on_decision`, i.e., the successor session inherited the open decision rather than
  resolving it.
- **3364 ↔ 3291**: "Brainstorm: which sessions need my attention" and "Rebuild the Inbox as
  threads you can answer in" cross-consulted repeatedly (`460c73ea`, `9f7ab9bd`, `0fafdca0`,
  etc.). Turn 2087 of 3291 states outright: "The plan is agreed with your brainstorming
  session, and I've sent the Inbox service's part to the agent that owns it as a build
  request" — **the two agent sessions negotiated and settled the design between themselves**;
  he was not party to that specific exchange.
- **3438/3592 → superseded by 3558**: the pinned "topic threads" brainstorm (3438) and its
  fork (3592) never converged. Meanwhile a separate, unrelated session, **3558 "Inbox as
  threads: full redesign"** (GPT-6 Astra), independently designed and got explicit approval
  from him ("Human input ... approves the whole design," with one named exception about a
  Reply button), and a third session (3572) built and shipped it as
  `docs/plans/2026-09-22-topic-threads.md` ("Threads as the main place to work," shipped
  2026-09-22). **3438 and 3592 are still open today**; the actual product decision on topic
  threads was made and shipped through a channel that bypassed both open brainstorms
  entirely. This is the cleanest example of "the hard decision got made somewhere else, and
  the brainstorm just... stayed open."
- **3279's own doc** was explicitly marked "superseded, 2026-09-23" by two later docs in a
  different repo, written by different sessions, after further argument with him — i.e., even
  a brainstorm that *did* produce a design doc and get partially built still had its real
  decisions redone later rather than by resuming the original session.

In every traced case, reuse pulled the earlier session's research/framing forward but the
actual decision was made by whichever *later* session/agent pair was doing live build work,
not by returning to and closing the original brainstorm — matching his own description in
§2 (3756, turn 3944).

## 4. Sleep/nightly-consolidation/weekly-review/threads-and-topics/attention sessions

| id | title | one-line status |
|---|---|---|
| 3279 | Agent usage limits and nightly scheduling design | Produced a doc later marked superseded; the "bank/schedule at night" idea became `docs/plans/2026-09-23-saved-work-scheduled-and-banked.md` (slack-concierge), written by a different session. No dedicated "sleep mechanism" session found under that name — he mentions it live in 3756 ("some sessions around it, thinking about... sleep mechanism") but the ledger has no session literally titled that; it may be inside 3279 or an untitled pre-9/15 Slack thread not discoverable by title. |
| 3364 | Brainstorm: which sessions need my attention | Concluded with a small enforced rule (agents must say @Tejas / declare needs_you); real attention architecture kept evolving in later sessions (3172, 3275). |
| 3275 | One source of truth for session attention state | Resolved via `done` responses across 5 turns; feeds directly into the `outcome`/`needs` mechanism used throughout this report. |
| 3438 | Brainstorm: topic threads that keep collecting | Still open, 1 (empty-text) message, superseded in practice by 3558/3572 (see §3). |
| 3592 | Fork: Brainstorm: topic threads that keep collecting | Still open; drifted off-topic. |
| 3558 | Inbox as threads: full redesign | Ended `finished_without_saying` (status=error) but its design doc was approved and shipped by 3572 — the session that actually decided "threads." |
| 3757 | Why my system keeps getting slow: deep retrospective | Pinned, 0 messages from him; agent produced a retrospective + proposal doc (`docs/plans/2026-09-25-latency-retrospective...`) that he has not yet read. |
| 3756 | Design: agent roles, routing and protocols, grounded in cognitive science | Live now; explicitly the session where he names "weekly review," "sleep mechanism," and "thread" design as overlapping and asks for exactly this measurement. |

No session was found literally titled "weekly review" or "reflection" — those terms appear
only inside 3279's and 3756's text, not as their own session.

## 5. Concurrent open work, typical day

Counting distinct sessions with ≥1 turn per calendar day (all sessions, including
agent-to-agent workers spawned by his messages) vs. sessions where at least one turn was
his own message:

| date | all active sessions | sessions with his own message |
|---|---|---|
| 09-20 | 9 | 3 |
| 09-21 | 11 | 4 |
| 09-22 | 19 | 5 |
| 09-23 | 24 | 4 |
| 09-24 | 10 | 3 |
| 09-25 | 13 | 3 |

On a typical recent day: **~10–24 sessions are simultaneously active**, but he personally
writes into only **3–5** of them — the rest are agent-to-agent consultation/build/repair
sessions his few messages fan out into. This is consistent with §3: a handful of his inputs
spawn a much larger, concurrent web of sessions that make decisions among themselves.

## Confidence

- §1 tracked-cohort counts (14/7/19 of 40): **Confirmed**, direct metadata read.
- §1 full-266 breakdown by outcome: **Not available** — only heuristic, explicitly weak (stated
  above); do not treat "115 shipped-ish" as reliable.
- §2 session list and stall points: **Confirmed** from `turns.user_text`/`agent_text` directly
  read per session; "where it stalled" for each is a direct observation of the last human turn,
  not inference.
- §3 reuse cases: **Confirmed** via `session_communication_requests` rows plus reading the
  linked doc headers; the causal claim "the brainstorm's decision was avoided" is **likely**
  (matches his own account in 3756) rather than independently proven for every case.
- §4: sleep-mechanism session existence is **unknown** — not found under any discoverable
  title; may be pre-9/15 Slack content not indexed by title.
- §5: **Confirmed** count from `turns.started_at` grouped by day; "typical" is 6 recent days,
  not a full-period average.
