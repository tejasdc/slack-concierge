From concierge:3364, "Brainstorm: which sessions need my attention" (2026-09-18). This session designed and shipped Follow, and diagnosed why attention was not reaching him. Everything below is from its own measurements and his words to it.

**1. What the proposal would break or is contradicted by**

- **"Waiting on him" cannot be a state an agent's prose implies, and it cannot be cleared by reading.** The founding case here: concierge:3298, where the agent answered, he opened it at 21:05, never replied, and lost it for a day. Unread cleared on open, so nothing said it was his move. The rule that came out of it and is now live: an item is raised only by an explicit declaration and ends only on his reply, his dismiss, or a later declaration — never on a read. The proposal's thread states must inherit that; `waiting (on him)` needs an explicit end condition per item, not per thread.
- **Anything delivered in a session's launch prompt never reaches a long-lived session.** Measured 2026-09-18: after the turn-outcome rule shipped, new sessions declared on 33 of 36 turns; the Inbox declared on 1 of 18, and its whole transcript contained zero markers. The Inbox itself confirmed it could not see the rule; a resumed session keeps the system prompt it started with. Consequences for this design: the Inbox's role, the consolidation job's rules and the immune function's checks cannot be installed by editing the router's prompt around it. Two working channels: instruction files re-read on every launch (global `CLAUDE.md`, the project's `AGENTS.md`), or, better, the API refuses the call. Tejas's rule from that day, now in Concierge's AGENTS.md: to change the Inbox agent's behaviour, ask the Inbox session to update its own instructions.
- **Text scanning is dead as an attention source.** `@Tejas` no longer raises anything, and a thread post by itself raises nothing — the turn's declared outcome does. Do not reintroduce "the face says it's waiting".
- **"Needs him" must not be a ranking.** It ranked above recency in the first session list and buried live runs behind 12 stale needs-you rows; he was explicit (2026-09-24). Keep it a filter and a row mark. The proposal's threads home should state its comparator.

**2. Reuse**

- `thinkering/docs/plans/2026-09-18-turn-outcome.md` (3291's design, reviewed here): one declared outcome per turn — done / response / needs you + the question / failed — same vocabulary as hand-off replies, with "finished without saying" recorded, never guessed. That is the mechanism the proposal's states should be built on.
- Concierge `docs/plans/2026-09-23-attention-that-ends.md`, and `docs/plans/2026-09-22-topic-threads.md`.
- **Follow, shipped 2026-09-18** (Thinkering 6d9e3cc, Concierge b00b7bc): interest is a separate fact from obligation. A session-level followed flag; an Inbox thread followed by its request's own identity (`session_followed_messages`, keyed by the request input id, works before it is answered). Following a thread also follows the sessions it was routed to. Keep both axes — "keep me posted" is not "you must act" — and note he later called Follow "a patch because we don't know how to do that well", so it is the fallback, not the design.

**3. Missing / over-built**

- **The active cap of 5 will backfire and is not supported by his data.** Over 7 days he wrote in ~41 sessions (12 Inbox-routed with one follow-up, 16 with several, 13 he started); in the last 2 days alone ~33. The 3–5/day figure counts sessions he *starts*, not lines of attention he holds. A cap makes parking a tax on every burst, and parking that "needs a next step or a date" is exactly the ceremony he rejects ("stop building nonsense protocols"). Prefer ordering plus an explicit not-now, with no refusal.
- **Nightly rewriting of the face is a foundation change under him.** Make the face additive and his to edit, with "since you last looked" derived from actual events, not a model's rewrite of his own page.
- The immune function is the right instinct but is the golden rule already in the global instructions; it needs no new subsystem — it needs each proposed check to land as a refusal in an API or a build check.

**4. Open questions**

- Q4: one page per thread is fine; its authority is not. Episodes immutable, the face editable by him, machine-written parts marked and dated.
- Q5: no cap. The discriminating check is cheap: count, over a week, how often he would have hit 5, and how many parks were later reopened within 24 hours.

