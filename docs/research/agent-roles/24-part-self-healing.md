# Self-healing-agents review of "threads as a humane representation of thought"

## 1. What we already discussed, decided, or built

We built a working four-stage nightly cycle — N1 Measure → N2 Prune → N3 Repair → REM Create
(`sleep-agent/sleep.sh`, `sleep-agent/stages/*.md`) — that already does most of what the proposal's
"sleep" role describes, plus a **separate** immune system that the proposal does not clearly
separate out (`SYNTHESIS.md:441-624`, `docs/metaphors.md` "Immune System Layers").

Tejas's own words, from a voice brain-dump captured 2026-02-21 06:08 UTC
(`mac-claude-projects/.../agent-a4e842da20e2f11e5.jsonl`, written into `docs/principles.md` #26-38):

- "Desire paths are the signal. When users repeatedly do something the hard way, that's the
  detection trigger. Like the immune system detecting a repeated pathogen." (#29) — this is
  exactly the proposal's "immune" damage-signal detection, in his words, from February.
- "Gradual signals, not binary triggers... Severity weighting with confidence levels" (#32) —
  he explicitly rejected hard cutoffs in favor of graduated escalation.
- "Focus mode vs diffuse mode... focused sessions for tasks, diffuse dream sessions for creative
  recombination" (#30) — the active/resting split the proposal now reinvents.
- "Dream about solved problems too. Review Git history of solved problems... Propose fresh
  insights next morning." (#36) — sleep should revisit closed work, not only the day's captures.
- "Convergence across sources = high signal" (#38) — patterns that show up across immune, sleep
  and feedback loops independently get priority.

We also settled the sleep/immune split architecturally at `SYNTHESIS.md:518-565`: homeostasis
monitors continuously, triggers immune response on deviation and deepens sleep on fatigue;
immune and sleep are two systems with defined crosstalk, not one role.

## 2. Where the proposal contradicts or diverges from what we built

- **Approval gating is backwards from what we shipped.** The proposal's "sleep" role "never
  changes anything he hasn't approved." Our actual `sleep.sh` does the opposite by design: N2 and
  N3 modify files directly (`n2-prune.md`: "You CAN modify files"; `n3-repair.md`: "You CAN modify
  files and run bash commands") and REM "CAN create new artifacts" (`rem-create.md`) — all
  autonomous, backed up, reported afterward in a morning report, never pre-approved. This was a
  deliberate choice (`SYNTHESIS.md:582`: "Layer 3 (sleep) should be autonomous with next-session
  reporting"). If the design intent has genuinely shifted to propose-then-approve, that's a real
  reversal of our finding, not a detail — say so explicitly rather than treating it as continuity.
- **"Sleep" and "immune" are folded into one temporal slot in the proposal** (both apparently
  nightly/batch), but we split them by *speed*, not by *when*: immune Layer 1 is real-time,
  per-tool-call (PreToolUse hooks), immune Layer 2 is adaptive/slow (episodic memory). Sleep is a
  third, separate layer. The proposal's immune role ("turns damage signals... into proposed
  structural checks") only matches our slow/adaptive immune layer — it has no equivalent to our
  fast layer that blocks in the moment. That may be fine for a thread-management surface, but it's
  a scope narrowing worth naming, not an oversight to silently inherit.
- **Terminology drift**: the proposal's "salience" is our "relevance," with a specific formula
  (`sleep-agent/stages/n2-prune.md`): `relevance(t+1) = (1-0.1) * relevance(t) + reinforcement`,
  new artifacts start at 1.0, prune below 0.2, and — a rule the proposal omits — **never prune
  anything younger than 3 cycles**, regardless of relevance.

## 3. What the proposal should explicitly reuse

- The **trail-evaporation formula above**, verbatim, for "fades all salience a little": it is
  already tuned (10%/cycle decay, 1.0 start, 0.2 floor, 3-cycle minimum age) rather than invented
  fresh.
- **Two-signal activation** (`rem-create.md`, `docs/metaphors.md`): a pattern must appear in *this*
  cycle's evidence *and* have been pending from a *previous* cycle before "sleep" or "immune"
  proposes a structural change. This is the concrete mechanism the proposal's "how structure
  evolves" triggers should be built on — it directly prevents one-off noise from becoming a
  proposal.
- **Confidence tiers on generated artifacts**: 2 signals = 0.65, 3+ = 0.85, cross-session +
  cross-pattern = 0.95 (`rem-create.md`) — reuse this instead of inventing a new severity scale for
  "review counts... triggers."
- **The severity-escalation idea Tejas stated directly** (#32, above): gradual thresholds, not a
  single active-cap cliff.

## 4. What we think is missing, learned the hard way

- **No stop signal / autoimmune guard.** We spent real design time on Tension 3
  (`SYNTHESIS.md:592-598`, "over-eager self-correction could create a system... never achieving
  stability") and never fully solved it even for our own scope. The proposal's active cap and
  "friction placed deliberately" are the human-facing analogue, but nothing in it addresses runaway
  *structural* churn from the sleep/immune roles themselves — e.g., what stops sleep from proposing
  the same restructuring every night if he keeps declining it.
- **Reviewing solved threads, not just open ones.** Tejas said this explicitly (#36): dream about
  problems already closed, not only the day's captures. The proposal's sleep role only replays
  "the day's captures" — it drops retrospective value we already flagged as a named principle.
- **We never solved "how do we measure rule/link freshness" for our own artifacts either**
  (`SYNTHESIS.md:590`, Tension 2, still open) — the proposal should not assume its link-strengthening
  mechanism is a solved problem; it inherits an open question from us, not a finished answer.
