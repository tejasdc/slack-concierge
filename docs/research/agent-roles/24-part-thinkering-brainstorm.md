# The stalled-threads brainstorm (concierge:3438, 2026-09-20) on the new proposal

## 1. What bears on this

This is exactly our topic — "threads that keep collecting" — and most of it traces further back
than us. In ChatGPT `session:WzIsMzIwOSwxXQ` (Sept 2026) Tejas converged on the **attractor**:
"An attractor should not merely be a bucket. It should be a standing knowledge product with a
recognition function, an evidence reservoir, and a path toward action... I would not implement
an attractor as a folder." He also specified **three** extraction timescales, not two — a working
agent marks as it goes, a middle steward consolidates after a meaningful transition, a slow
steward looks across sessions — "prevents the same agent that made a decision from also becoming
the unquestioned historian of why it was correct." In `session:WzIsMzM3MiwxXQ` (Sept 18) he
rejected a ten-entity taxonomy ("a harsh mash of mostly garbage things... proliferation of text")
and converged on Topic (territory) → Branch ("a visible growth path," created only once a thought
accumulates children) → typed Thought — explicitly not one entity wearing every hat. Thinkering
already ships 18 typed links with required reasons, pinned revisions and retraction history, and
an endorsement rule: agents propose, Tejas accepts/edits/rejects (`options.md`, `prior-thinking.md`
§2). Our own pick was **"0 + C"**: no mandatory per-turn thread step (explicitly rejecting that —
"relying on cognition while doing the task... we could forget," his own words), just a cheap
default plus a nightly sleep pass over the day's final reports and his messages, never full
transcripts. The readwise sweep's strongest match is stigmergy — coordination through visible
traces in a shared environment, not central telling — which argues for the face/thread itself as
the discovery surface, not the Inbox pointing agents at it.

## 2. What v22 still contradicts or drops

We already reviewed an earlier draft of this exact design (`feedback-3756.md`, on concierge:3438's
own artifacts) and most of that feedback is **still unaddressed** in this version:

- **No recognition rule.** The face carries decided/open/changed but still no "what belongs here"
  field. Without it, nightly consolidation has no criterion to file by.
- **Face rewritten by the owning agent, with no endorsement split.** Still collides with
  `HUMAN_ENDORSEMENT_REQUIRED` and his own point that the agent that made a decision shouldn't
  also be its unquestioned historian.
- **Two timescales, not three.** Owning agent + nightly sleep still drops the middle steward.
- **A new four-link vocabulary** (spawned-from/related-to/blocks/merged-into) sits beside the 18
  that already ship with reasons and pinned revisions — still a second table for the same
  knowledge, not reuse.
- **Topic vs. Branch is still flattened** into one thread state machine covering both a
  one-message capture and a multi-month territory.
- **Two thread stores** — now made explicit rather than resolved: "the thread record lives with
  the session owner (Concierge), not in a folder," alongside Notes/Timeline, which are already
  threads. No rule reconciles them.
- **Immune function is still a named subsystem**, unremarked. Tejas's own agent-ecology stance was
  "we should not define sleep or immune system... define the physics." v22 doesn't even surface
  that tension, which our earlier feedback asked for.

One thing v22 *does* now address: decay. "Fades all salience a little so only what came back
stands out" and "prunes dead links" answers our earlier "missing: the decay rule." And the active
cap, which we said not to ship, is now posed back as an open question ("Is the active cap right...
or would it backfire?") rather than shipped silently — progress, not resolution.

## 3. What to reuse, concretely

Pull the attractor's field list wholesale onto the face: purpose/recognition-rule, evidence,
maturity criteria, review trigger, steward — the face is missing at least recognition and steward.
Reuse the 18 existing typed links instead of the new four. Reuse Topic/Branch/Thought rather than
one lifecycle for every thread. Reuse self-healing-agents' concrete mechanics — rejection-is-signal,
edit-vs-deletion, trail evaporation, two-signal activation — as *what the immune function is made
of*, not a fifth named role.

## 4. Still missing

Everything in section 2 above, plus: what sleep actually reads (final reports and messages, not
full transcripts — a cost decision, still unstated in v22), and the Map, which our feedback called
over-built and v22 keeps unchanged as one of four interfaces.
