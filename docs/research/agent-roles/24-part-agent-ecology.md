# agent-ecology's answer to the threads/roles proposal

Consulted: `/root/workspace/agent-ecology/` — `AGENTS.md`, `BOOTSTRAP.md`, `LAB_CONSTITUTION.md`,
`README.md`, everything under `docs/`, `notes/inbox.md`, and the four Claude session transcripts
under `/root/.claude/projects/-root-workspace-agent-ecology/` (2026-09-01 x3, 2026-09-10 x1; no
later Claude sessions exist for this project).

## 1. What was discussed, decided, or built here that bears on this proposal

This project exists because of a direct instruction from Tejas about exactly this question — not
pre-naming mechanisms. In the founding session (transcript `5a245493…`, 2026-09-01), after an
assistant draft he judged as "complete nonsense," he wrote:

> "Look at what layers are present what layers or not present and what we're trying to evolve and
> like verify right there's a lot of interesting ideas lots of interesting principles like you
> know sigma g sleeping, immune systems and we are deliberately choosing not to include those like
> see if that actually evolves, right? But there is a physical layer that is present."

That sentence is now encoded directly in `BOOTSTRAP.md`:
- Line 43: "Do not assume that human social metaphors such as managers, identity, reputation,
  courts, markets, **sleep, immune systems**, specialization, companies, or ant colonies are
  necessarily the right abstractions."
- §6 "Physics affordance test" (lines 435–528) names **sleep** and **immune-system** behavior
  specifically as things to *not* implement — instead give agents persistent state, multiple
  action cycles, resource budgets, and provenance/isolation primitives, and see whether
  sleep-like consolidation or immune-like quarantine/trust behavior evolves on its own.
- §10 (line 695–737): the seed colony starts with "no permanent public identity, no named roles,
  no manager, no planner, no reviewer, no security agent, no explicit hierarchy." If workers
  invent TODO files, claims, locks, or status ledgers, "record the fact that these emerged. Do
  not prematurely promote them to permanent institutions."
- Milestone 2 (line 1582–1592): "Run three identical workers against shared state. No roles. No
  identity. No messaging infrastructure beyond world artifacts. Observe what happens."
- `LAB_CONSTITUTION.md` rule 11: "An agent, role, manager, reviewer, hierarchy, market, court,
  reputation system, or lifecycle is never assumed fundamental." Rule 12 requires every proposed
  institution to pass "the physics-affordance test: could agents construct an analogue from
  lower-level capabilities?"

This is a live, decided lab policy, not idle speculation — it is the specific thing this project
was created to test, and Tejas named "sleep" and "immune systems" by name as the two paradigm
cases *because* they are tempting to just build in.

Bootstrap review (`docs/plans/bootstrap-review.md`, independent review, SHIP verdict) reinforces
it: "The constitution successfully keeps sophisticated organization outside the organism... treats
new infrastructure as requiring experimental justification."

No experiment has actually run yet (repo is still pre-Milestone-0; `docs/README.md` and `AGENTS.md`
both say no runtime exists), so this project has **no empirical finding yet about whether roles do
or don't emerge** — only the pre-registered stance and the falsifiability design. Be honest about
that limit rather than inventing a result.

## 2. What in the proposal contradicts what this lab found

Direct tension: the proposal's Roles table names five fixed roles up front — Tejas / Inbox / Owning
agent / **Nightly consolidation ("sleep")** / **Immune function** — each with prescribed "does" /
"never does" columns, before any evidence that this decomposition is the one that earns its keep.
That is precisely the move BOOTSTRAP.md §6 tells us not to make: it *names* sleep and an immune
function as institutions rather than asking whether consolidation-like and quarantine-like behavior
would emerge from lower-level primitives (persistent state, review counts, damage signals) it
already has anyway (the review counts and failure-family table are exactly such primitives).

The "How structure evolves" section (triggers → proposal → his approval, e.g. "a per-project
coordinator") is a real improvement over silently hardening structure, and it does track this lab's
distinction between "emergence generates hypotheses" and "ablation/approval establishes value"
(`LAB_CONSTITUTION.md` rules 13, 21; BOOTSTRAP.md §26). But it only applies emergence-first
thinking to *future* structure. It does not defer the *initial* five roles, two of which (sleep,
immune) are named with loaded biological metaphors this lab flagged as a specific trap ("do not
romanticize emergence," §1.2 — a spontaneously-emerging institution can be "socially elaborate but
functionally useless"). Naming them at t=0 forecloses the two most interesting comparisons this
project's whole design exists to run: nightly consolidation vs. no consolidation, and a
damage-signal-triggered proposal mechanism vs. no immune function at all. The trigger mechanism
defers *evolution of new roles beyond these five*; it does not defer or test the five themselves.

## 3. What should the proposal explicitly reuse from here

- **The "physics affordance test" itself** (BOOTSTRAP.md §6, line 439): "Could some functional
  analogue emerge from the lower-level physics without us naming it?" Apply it to Nightly
  consolidation and Immune function specifically before committing the table: what lower-level
  primitives (a capture log, the review counts, a damage-signal event) would let something
  sleep-like or immune-like show up without being named that from day one?
- **The emergence vs. ablation distinction** (constitution rules 13, 20, 21, 26; BOOTSTRAP.md §26):
  ship the two roles as a hypothesis with a named alternative ("no nightly pass; agents update
  faces inline instead") and a way to tell afterward whether the consolidation pass actually
  helped versus just running.
- **"Record the fact that these emerged. Do not prematurely promote them to permanent
  institutions"** (line 735) as the literal operating instruction for the trigger mechanism — i.e.,
  a proposed-and-approved role should stay revocable/observed, not silently become a fifth
  permanent row.
- **Tejas's own framing**, quoted above, as the standing objection any reviewer here would raise:
  he asked, by name, for sleep and immune systems to be left out and watched for. A proposal
  reusing his own two example institutions as prescribed roles should say explicitly why this
  system (a personal single-operator tool, not the ecology's experimental colony) is a different
  operating profile where pre-specification is the right call — the global CLAUDE.md's "engineer
  for the real operating profile" principle actually supports doing this differently here, but the
  proposal should make that argument rather than silently reusing the metaphor.

## 4. What this project thinks is missing from the proposal

- No falsification path for the two named institutions. If nightly consolidation or the immune
  function turn out to be dead weight (busywork faces, proposals he always rejects), what's the
  signal and who removes the role? The "how structure evolves" section only grows structure.
- No smallest-alternative comparison, which this lab's constitution treats as mandatory before
  adopting an institution (rule 23, "novelty claims require a fixed-versus-mutable comparison").
  What would the same failure family (§ "Failure family → structural answer") look like with one
  fewer role — e.g., owning agents refreshing faces themselves, no separate sleep pass?
- No plan to watch for role behavior that *isn't* in the table. This lab's whole method is to keep
  a ledger of what spontaneously appears (`docs/emergent-institutions.md` pattern, §24) — the
  proposal has review counts and triggers pointed at project-level coordination, but nothing that
  would notice, say, an owning agent starting to police other agents' work uninvited (a proto
  "immune" behavior evolving somewhere the fixed table didn't expect it).

Honest caveat: this project has produced no runtime and no experimental evidence yet on whether
roles emerge or fail to emerge among real agents — only a strongly and explicitly pre-registered
stance against naming them early, direct from Tejas's own words, and a constitution built to make
that falsifiable. Treat this answer as "here is the standing objection and its grounding," not as
a result that roles definitely don't work.
