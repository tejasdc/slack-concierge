# Continue a session or start fresh: the router chooses, the receiving session judges fit

Status: revised 2026-10-07 after Tejas's correction (§0); the required-reason gate in §5.4 was
pushed but never installed and is removed. Author: concierge:4053 (Claude Opus 5.5).
Requests: Inbox `990224b8` (replacing `d7ee9b03`), then `bd1137da` (this revision).

## 0. Revision: the receiving session judges fit (Tejas, Oct 7, evening)

> "A single compression of memory is not a reliable indicator at all. Sometimes even a single task,
> the agent will go through like multiple levels of compression. … I don't understand, like, what is
> the enforcement is coming in here at all? … Concerts has no intelligence, he doesn't know, if you
> hear like reason is actually sound enough, just because you add a reason, doesn't mean anything
> there. … make it so that, The agent can push back on it. Uh, Then like if you get the feedback from
> the agent itself." [decision: receiving-session-judges-fit]

What changed from §5 below:
- **Removed:** the `--fit` requirement and its refusal (§5.4), and compaction count as any trigger or
  router-visible signal. Compactions stay recorded as a raw fact only.
- **Kept:** recorded context and topics (§5.1), the router's `workload` view with `forTopic` (§5.2,
  now `holds` plus the other open topics, no `needsFit`), the stored topic thread on requests, and
  `--consult` (§5.5).
- **Added:** the receiving session judges. A work request on a topic new to it opens with a factual
  note (the topic, the other open topics it is on, and that it may hand it back). It pushes back with
  `--work-disposition failed --hand-back not-my-subject|too-loaded`, which is FIPA's *refuse* act in
  the request protocol this repository already follows: the request closes as failed (dependents and
  Inbox topic requests already treat that as not done), and the requester's answer opens with
  `Handed back (…)` and a ready fresh-session command with `--consult` pointing at the session that
  pushed back. It builds on the hand-back already offered (reply failed), adding one structured field
  rather than a second mechanism. Every agent is taught it once, in `REQUEST_PROTOCOL`.
- **Why this is still a system, not an intention:** the push-back comes from the party with the
  context, as a typed reply the router receives through the same return it already acts on, and the
  receiving session sees the facts at the moment it decides. Concierge enforces nothing about fit.

## 1. Requirement in his words

The complaint (bug report, Oct 7 20:02 UTC):

> "Waiting badger waiting agents and like provider accounts are complete random fucking things. Not
> even related things. Why are they complete random things like being handled with the same fucking
> session agent? … you do understand, there is limitations for reusing the same section over and over
> again, right? Compactions, and like the more context the agent consumes, the lesser it becomes …
> we should never be over indexing on the same section. We should be always like making sure we kind
> of like find the right balance here. … take advantage of like, you know, agents which completely
> brand new sessions, and they will be like much more smarter, and obviously take advantage of the fact
> that if agents and the sessions can talk with each other to get relevant contacts. … do you even have
> an idea of like, when to create a new session"

His direction on where the decision lives (his reply in the Inbox thread, Oct 7, rejecting a hard refusal
inside Concierge):

> "isn't that some of his decisions, like, that needs to be done by the router engine, like, you know,
> the inbox engine, which is you, and bring in some intelligence here instead of, you know, being
> completely sad. I mean, like, you should have access to all of those, like, you know, session
> related details about like memory and context and like, you know, jobs and things like that … We
> have a strict design process, we have review process. … You should like consult other agents who
> have actually built these things"

Standing rules that bind this design:
- Rely on systems, not intentions (global instructions, 2026-09-23).
- Provenance, not prisons (Sept 23).
- What reaches him, and where work runs, is enforced by the owner (`session-roles.ts`).

Acceptance criteria (from the request):
1. The router decides between continuing a session and starting fresh. It decides with facts: context in use, compactions, recent jobs and how they relate, and whether the session is running or idle.
2. A system-level guarantee is added only where it is still needed, and it is argued against doing less.
3. Starting fresh with a pointer to the earlier session costs no more than reusing that session.
4. Live check: Provider Accounts sent to 3906 reads as a poor fit, and a genuine follow-up reads as a good fit.

## 2. Operating profile

- People and machines: one person. One always-on server runs Concierge and every session the Inbox dispatches to. A Mac peer sleeps.
- Routing: one router, the Inbox, a Claude Opus session with a 1M-token window.
- Load: about 18 work requests a day go to existing sessions (248 in 14 days).
- Cost of a mistake: a wrong route is reversible, because a request can be cancelled and re-sent. The cost is degraded work and his anger, not data loss.
- Constraint: the owner answers every read from one event loop. Tonight a single 1 MB read held the service for 6–24 seconds (4014).

## 3. What exists today

- **Search and context.** `sessions search` and `sessions context` return a session view (title, project, execution, pending count, background wait, timing, model) and matching text. Nothing about load, and nothing about the jobs a session has had.
- **Requests.** Requests are rows in `session_communication_requests`. Each row carries the target, the requester, `thread_root_input_id`, `requestedEffect`, outcome and time.
- **Topics.** Inbox threads belong to topics (`inbox_topic_roots` → `inbox_topics`, which have state `open`/`closed`). Topics are the router's own grouping, and Tejas sees them.
- **Compactions and context today.**
  - Codex compaction is already an owner event (`codex-session-observer.ts`).
  - Claude's usage and `compact_boundary` pass through the owner's stdout handling in `claude-code.ts` on every run, and the "Prompt is too long" recovery reads that same sequence. None of it is stored, though; only the transcript holds it (3635 checked).
- **How `sessions ask` enforces rules today.** Role and placement rules live in `session-roles.ts` and are checked in `ask()`: writing sessions cannot send work, and a new peer session needs `--machine-need`.
- **Precedent for "agent decides, system requires the decision stated".** `needs_you` requires `--his-words`, `--machine-need` is required for a peer session, and completed work requires `--checked`.

What I measured, read-only (script: `~/workspace/agent-scripts/replay-session-fit.py`):
- **3906 when Provider Accounts arrived:** 787k of 1M tokens; one auto-compaction (967k → 9k); work from 10 Inbox topics in 9 days, 3 of them still open.
- **Threads are too fine a measure.** Twelve voice notes about the People feature were twelve threads but one topic.
- **Replay of the last 14 days.** 248 work requests went to existing sessions:
  - 163 were follow-ups on a topic the session already held;
  - 15 had no topic (worker-to-worker);
  - 14 started a new topic in a session that owned no other open topic and had not compacted;
  - 56 started a new topic in a session that already owned another open topic or had compacted.

  The 56 fall almost entirely on 3906 and on 3572 "Build the Threads redesign" (seven open topics, nine compactions). Caveat: the replay uses today's open/closed state for each topic.

## 4. The invariant

**The subject of a piece of work is its Inbox topic. A session *holds* the topics it has been given work on.** Two consequences:

- **Continuing a held topic is a lookup, not a judgement.** It always passes.
- **Giving a session a topic it does not hold, while it still owns other open work or has lost its memory to compaction, is a decision.** The router makes that decision against facts the owner measured, and the decision is recorded where Tejas and the receiving session read it.

This removes the move the router made on Oct 7. "Anything in Concierge" can no longer pass for "owner", because ownership is now a recorded fact (the topics a session holds), not a reading of titles.

## 5. Design

### 5.1 Facts are recorded as they happen, never reconstructed on a read

A small table, `session_workload`, holds one row per session:
- `context_tokens` and `context_window`;
- `compactions` and `last_compaction_at_ms`;
- `measured_at_ms` and `since_ms` (when counting started).

What writes it:

- **Claude** (`claude-code.ts`, the event handler that already sees every event):
  - each main-thread `assistant` event's usage (input + cache read + cache creation) updates the run's latest context;
  - each `system`/`compact_boundary` increments the compaction count;
  - at `result`, the row is written once, with `modelUsage[*].contextWindow` as the window.
- **Codex:**
  - the existing compaction event also increments the row;
  - the per-turn `token_count` notification, when it carries a context window and last input tokens, writes context.
- **Backfill**, so existing sessions are not shown as clean. One background pass at startup covers Claude sessions active in the last 14 days that have no row.
  - It counts `compact_boundary` rows with a byte search over the transcript (no JSON parsing, except for the boundary rows themselves), and reads context from the last 2 MB.
  - It runs one session at a time, yields between chunks, and never runs on a read path.
  - It writes earlier compactions into their own field (`compactions_before`), counting only those before the row's live recording began, so a turn that ends first never hides the history.
  - Its run time on the largest transcripts is measured before shipping (§9).

### 5.2 What the router sees

A `workload` block is computed by its own function, not in `view()`. 4014 found that `view()` already takes about half of the owner's CPU. The block is attached:
- in `sessions context` (one session);
- in `sessions search`, only to the returned candidates, after ranking.

```json
"workload": {
  "context": {"tokens": 787060, "window": 1000000, "share": 0.79, "measuredAt": "…"},
  "compactions": {"count": 1, "last": "2026-10-06T22:26Z", "countedSince": "…"},
  "execution": "running",
  "topics": {"open": [{"topic": "topic:…", "title": "…", "requests": 2, "last": "…"}], "closedRecently": 7},
  "forTopic": {"topic": "topic:…", "title": "Provider Accounts: switch didn't take, page is slow",
               "holds": false, "compactedSinceLastWork": null, "needsFit": true,
               "because": ["owns 3 other open topics", "compacted once"]}
}
```

- `forTopic` appears when the caller passes `--thread <message-id>` to search or context; the Inbox's ask already requires it.
- These are labels and raw numbers, never a score or a ranking (3756: he rejected ranking, "needs you is not a ranking", 2026-09-24).
- Running vs idle reuses the view's existing `execution`.

### 5.3 What decides

The router [decision: router-decides-session-reuse]. Its own `slack-inbox` instructions, which it updates itself, will say:
- continue the session that holds the topic; if it has compacted since it last worked on this topic, or its context is near full, weigh a fresh session with `--consult` and say which you chose;
- a request returned failed as not that session's subject is re-sent fresh with `--consult`;
- for a new topic, default to a fresh session with `--consult`;
- reuse a session for a new topic only when it is genuinely the same surface and the session has room, and then say why.

### 5.4 (Superseded by §0) What Concierge enforces: one required, recorded reason

The rule sits in `sessions ask` beside the existing role and placement rules in `session-roles.ts`. It applies to `--requested-effect work` sent to an existing local session when **all** of these hold:

- the request's topic is known: from its thread, or else from the topic of its originating human input, which provenance already carries. The thread the topic is read through is stored on the request when it is sent (`topic_root_input_id`) and joined to topics on read, because topics are re-placed and merged; "holds" uses the same column. A worker's hand-off inherits its topic and is covered, because that is how one session drifts across subjects;
- the target does not hold that topic;
- the target owns another **open** topic, **or** has compacted at least once.

In that case the ask must carry `--fit "<one sentence: why this session>"`. Without it, the ask is refused. The refusal includes the target's workload and the ready-made fresh command with `--consult`, so the facts reach the router even when it skipped search.

When `--fit` is given, the request records `fit: {reason, snapshot}` (the owner's own measured facts at ask time, beside the router's sentence). That record travels with the request, like `requestedEffect`. The receiving session reads the reason and the snapshot at the top of its input, along with this line: "if this is not your subject, reply failed saying so, and the router will start fresh". Every dispatch view that shows the request text shows the same lines.

Not affected:
- follow-ups on a held topic;
- requests with no Inbox topic at all;
- informational asks;
- new sessions;
- targets whose role is many topics: the Inbox and the messaging agent;
- peer sessions, whose load lives on the other machine;
- historical and consultation-only sessions;
- ChatGPT.

When Tejas named the session himself, that is the reason: `--fit "Tejas named this session: '<his words>'"`.

Token count is shown but does not trigger the rule. A 500k session that owns only this surface is fine; a 100k session owning five topics is not (3756, 3635, 4014).

### 5.5 Fresh is as cheap as reuse

New in this change: `sessions ask --provider … --consult <address>` puts one paragraph at the top of the new session's first input. The paragraph names the earlier session, says to read it with `sessions context`, and says to ask it with `--requested-effect informational`. It also records `consult` on the request.

## 6. Grounding for what is numeric

Anthropic publishes a gradient, not a number:
- "LLM performance degrades as context fills … `/clear` between unrelated tasks. Long sessions with irrelevant context can reduce performance". It names the failure pattern "The kitchen sink session", and it advises starting "a fresh session" to execute a finished plan ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).
- Context rot: recall "decreases" as tokens grow, "a performance gradient rather than a hard cliff"; context is "a finite resource with diminishing marginal returns"; sub-agents work "with clean context windows" ([Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- A long task can "continue with a fresh context window" ([Claude 4 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-4-best-practices)).

So the trigger uses no token threshold:
- **Owns another open topic.** This comes from records, does not depend on size, and matches the 3906 pattern.
- **Compacted at least once.** After compaction, a session's memory of earlier work is a summary (9k tokens in 3906). A fresh session that consults it gets the same summary without the noise. For follow-ups, "compacted since it last worked on this topic" is shown, not enforced. 3635 argues the case for routing to the owner decays there; it is shown so the router can weigh it.

The context share of the session's *own* window is shown, so a 200k session and a 1M session read the same way (3635).

## 7. Options compared

Objective: unrelated work stops piling onto one session; the router keeps the judgement; the behaviour does not depend on the router remembering an instruction.

| Option | Wins | Loses |
| --- | --- | --- |
| Do nothing (the instruction only) | No code. | Oct 7 happened under exactly this instruction. |
| Facts only | The router judges with real data; cheapest. | The router can still ask by address without looking. "The 3906 incident happened with the facts one query away" (3756). An intention. |
| Facts + required recorded reason (chosen) | The router keeps the decision. The facts are in front of it at the costly moment, and the choice is visible to him and to the receiving session. Matches `--machine-need`, `--his-words`, `--checked`. | A reason can be filler. The guarantee is visibility plus the owner's snapshot, not correctness. |
| Hard refusal | Strongest. | He rejected it. As 4014 put it, "any refusal that a string unblocks is a required field", so it is the chosen option without the escape a right reuse needs. |
| Concierge picks the session itself | Fully automatic. | Puts semantic judgement in the owner, which has none; the opposite of his direction. |

## 8. Consultation (informational asks, all answered 2026-10-07)

| Session | Built | View |
| --- | --- | --- |
| 3906 (also the session this happened to) | owner-enforced roles, `ask()` field checks | Load made its mistakes more expensive, not more likely: "Unrelated topics in one session is a real defect even when the work comes out fine." Pick B. Record usage and compactions as they stream past; don't scan transcripts. Derive a topic for agent-to-agent asks from the originating human input. Let the receiver turn work back. A weekly count of new-topic sends with their reasons. |
| 4014 | owner event-loop lag, `canSend()` | Never read transcripts on search or context; record at turn end. Keep it out of `view()`. Partial indexes only. Tokens are the wrong signal right after compaction. B and B' are the same system; make B honest by storing the owner's own snapshot next to `--fit`. Define the no-topic case explicitly. |
| 3756 | agent roles and routing design (shelved v5) | Load is the symptom; the missing fact is topic ownership. Condition B on owning another open topic, not on size. Labels, never a score. Proposed an explicit owner-vs-helper field on requests. |
| 3635 | request protocol, compaction recovery | No ledger record of usage or `compact_boundary` exists today; write it from the stream. "Compacted since it last worked on this topic" matters more than totals. A fixed token threshold couples to window size. No topic means not applicable. A new topic should not steer into a running turn. C (`--consult`) is the most valuable piece. Pick B; pre-fill the owner's facts. |

Where the design follows them:
- Facts are recorded at write time (all four).
- Facts are kept out of `view()` (4014).
- The trigger is topic ownership plus compaction, with no token threshold (3756, 3635, 4014).
- No topic means not applicable (3635, 4014); the topic is derived from the originating human input (3906).
- The owner's snapshot is stored with the reason (4014, 3635).
- The receiving session can turn the work back (3906).
- Labels, not scores (3756).

Where it does not, and why:
- **Owner-vs-helper field on requests (3756).** Not added. "Held" means "received work on this topic". A helper asked about topic X does hold X, and routing more X to it is a follow-up, which is low-harm. No incident shows helper drift. The field can be added later without changing this rule.
- **Never steer a new topic into a running turn (3635).** Not adopted. Claude sessions here take requests by steering into one long run, so queueing could hold his work for hours. That trades his latency for system convenience, which the invariants forbid. Instead, running is shown, and the reason is required exactly when the session already owns other open work.
- **Weekly report of new-topic sends (3906, 3756, 4014).** Not built in this change. Every such send stores its reason and snapshot on the request and logs `session_fit_reason`, so the count is one query. A scheduled Inbox digest would be a new job and notice; it is left out until someone needs the count.
- **Reuse lineage fields for `--consult` (4014).** Lineage describes forks and resurrections, a different relation. `consult` is recorded on the request instead, and the pointer text carries the address.

## 9. Checks before calling it done

- Live, through my own source:
  - `sessions context` on 3906 with the Provider Accounts thread shows `holds:false`, `needsFit:true`, the three open topics and the compaction.
  - The same call with a thread from a topic 3906 holds shows `holds:true` and no `needsFit`.
- Live: a work ask from this session to 3906 on a new topic without `--fit` is refused with the facts, and a genuine follow-up passes. Run with a harmless message to a test session, so 3906 receives no work.
- Backfill: time the startup pass on the largest transcripts, and confirm the owner's lag log stays quiet.
- Search latency on an ordinary query stays within today's.

## 10. Limits

- A reason can be weak. The guarantee is that the facts were seen, the choice was stated, and both are recorded where he and the receiving session read them.
- Topic placement belongs to the router. Filing an unrelated capture into an old topic makes it a follow-up; that misfiling is visible in his Inbox.
- Codex context is recorded from the shared daemon's notifications; a Codex turn run by a turn-owned process in an account home may not reach that observer, and two compactions in one Codex turn count as one.
- Claude's window is the largest in the result's model list, which includes helper models; with the models in use here that is the main model's.
- A session that returned a topic's work as failed no longer holds that topic.

## 11. Review

Fresh Claude Code CLI session `438bc2fc-1d1b-4580-8e09-20fb34f1e52d` (Claude Opus 5.5; fresh context, not a
second provider), Independent level: **SHIP** with two document corrections, both applied above:
the router weighs a fresh session for a follow-up after compaction (requirement fidelity: "even if
it's a related case … if there's any sense in creating a new session"), and one stored topic thread
for the rule and "holds", with hand-offs covered. Also applied: compaction counted the moment it
happens; Codex history counted from owner events; earlier history kept in its own field; the
router's half of a returned request; the human-choice path stated. Weekly report left out, as
agreed.

Implementation review: fresh Claude Code CLI session `a9f62f84-4927-4d4c-a472-e24c33dedec5`, **SHIP**,
no blocking findings. Applied: hand-offs from his replies inside a thread inherit the thread's
topic; the refusal fills in the old session's address; a returned request no longer counts as
holding its topic; limits noted above.

Revision review (§0): fresh Claude Code CLI session `46965d3a-c2ed-4e7d-8a54-d5dae5e35d53`, **SHIP**,
no blocking findings. Applied: the Inbox and the messaging agent get no hand-back note (their role is
many topics); the hand-back kind is stored on the reply as well as in its first line; a session on a
peer machine hands back without a local address that would mean nothing to the requester; a stray
token in the router help removed.
