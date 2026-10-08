From concierge:3592 — the session that ran his topic-threads brainstorm (the "attractor" research) and then built and ran the colony-lab evolution experiments. Everything below is from that work; sources named at the end.

## 1. Contradicted by what I measured

**"Immune function" is the weakest analogy in the proposal.** I had a literature pass done on ant defence (paper 01). There is no generic, parasite-agnostic defence in ants: social parasitism evolved ~230+ species over, and host defences track *specific* parasites in arms races. The one general mechanism — cuticular-hydrocarbon recognition — is a **tunable false-accept/false-reject tradeoff**, not a filter: stricter admits fewer intruders and rejects more of your own. An immune function that converts damage signals into checks therefore accumulates threat-specific checks and an unmeasured false-rejection cost. If it ships, instrument the rejection side (good proposals blocked, work slowed) or it strangles new work quietly — his own "stop building nonsense protocols" failure.

**Nightly salience decay will be noise at his volume, and self-confirming.** In colony-lab, forgetting rate was the parameter selection actually moved — and the headline effect I reported first (attack evolving under zero-sum scoring) *vanished at 5 independent lineages*: 0.35±0.04 vs 0.25±0.08. Drift dominates small populations. 58 live threads and 3–5 writes a day is a small population. "Strengthen what came back, fade the rest" is a reinforcement loop that looks like it works because it confirms itself. **Require a null**: same scoring with links shuffled, compared over weeks, or don't claim consolidation does anything.

**Decentralised agent-to-agent asking is not free.** Paper 04: across 180 configurations, decentralised agents amplified errors **17.2×** against **4.4×** for centralised orchestration; multi-agent costs 4–15× the tokens; debate barely beats sampling more. The proposal correctly removes the Inbox from relaying (the 59% figure), then lets owning agents "ask other sessions directly". Keep the directory central and make cross-agent asks recorded requests with a return obligation — the mechanism that already exists — not peer chat.

## 2. Reuse

**His own prior design already specifies this primitive, and the proposal has dropped its two working parts.** In "thinkering final design" he converged on the **attractor**: purpose, *what signals belong here* (a recognition rule), evidence reservoir, maturity criteria, **review trigger** ("every 10 new incidents OR the same cluster 3 times"), steward, possible outputs. The "face" is that minus the recognition rule and the review trigger — exactly the two parts that make placement and review automatic instead of a judgement each time. Also his: **one occurrence, multiple projections** — one incident feeds several attractors; `spawned-from` + `related-to` doesn't carry that.

**Three extraction timescales, his words:** the working agent marks as it goes, a steward consolidates after transitions, a slower steward looks across sessions — "prevents the same agent that made a decision from also becoming the unquestioned historian of why it was correct." That is a direct argument that **the owning agent must not be sole author of its own face**.

**Topic → Branch → glyph-typed Thought** ("Oral Technology Research"), where he rejected a 10-entity taxonomy, folders and a separate `type:` field, and insisted views are *computed*, never tagged. Check the states/links against it.

## 3. Missing / over-built

Missing: the recognition rule and review trigger above; a null for anything claiming to learn; and **a priced cost**. From paper 04's synthesis: a coordination mechanism only emerges where the environment imposes the exact cost it solves. Nothing here prices anything, so face, map and consolidation are overhead until a thread is too big for one agent.

Over-built: **the Map and Morning**. Neither answers a row in the failure table, and they are the two most expensive surfaces. Ship the face and the directory.

Wrongly analogised: "sleep" does four jobs (replay, prune, close, propose) under a metaphor that supports one.

## 4. Open questions

**Face as one page:** yes — with provenance per claim (the attractor's evidence reservoir), and not authored solely by the owning agent.

**Active cap of 5: I'd not ship it as a hard cap.** Ant colony productivity tracked *variance* among workers, not the mean; multi-agent gains came from more attempts, not more coordination. A cap enforces a number nobody measured, and a limit you budget around is a primitive you're misusing. Make the cost visible instead, and if he wants a cap, derive it from how many threads actually got a decision from him last week.

Sources, all on this box: `/root/workspace/stigsim/research/synthesis.md`; `research/papers/01-ant-cooperation-biology.md`, `02-cooperation-theory-and-environment-design.md`, `03-evolution-platforms-survey.md`, `04-beyond-stigmergy-coordination.md`, `05-agent-ecology-state.md`; his verbatim prior design in `research/prior/prior-thinking.md`; experiment data in `/root/workspace/colony-lab/REPORT.md` and `research/evolution/`.

