# Retrospective: agent work, waking, and updates without waiting (2026-10-07)

What happened on 2026-10-07, what it cost, what the agreed design does about it, and what the
day taught about how we design. The design itself is
[the agreed plan](../../plans/2026-10-07-agent-work-and-updates-without-waiting.md). The generic
lessons went into the new `architecture-foundations` skill in the catalog; this file keeps the
Concierge-specific story.

## The day, in order

1. **An update waited 37 minutes for idle** (06:29 to 07:06 UTC). The crash fix could not install
   while any agent turn ran, because every Claude agent is a child of the service and a restart
   kills it. Agents ended their turns by hand to let it through.
2. **A fix held his messages behind agents.** d40d34b kept the update gate once claimed: running
   work finished, everything new queued, including his own messages. Tejas: "I need those things
   immediately… my requests are like the highest priority. I think that's the most idiotic thing
   that was actually done here." Reverted in f6f062e within hours; recorded as
   [decision: his-requests-come-first].
3. **A wait-only shell classifier refused real work.** Added the same day to stop agents building
   waiters, it refused a deliberate diagnostic (`sleep 25 && echo probe-done`), a read-only
   `pgrep … | while read` listing, and Astra's probe on the Mac, all within the review that was
   meant to evaluate it.
4. **A revert could not reach the Mac updater that was already running.** Pulling new shell text
   does not change a function already executing; the old policy ran until its next cycle.
5. **Instructions had taught agents to build waiters.** The codex-cli skill's old advice ("poll its
   own child" plus a wakeup safety net) produced a helper with five `sleep` jobs and a file-polling
   loop, and an update waited behind all seven.
6. **The design.** Tejas asked GPT-6 Astra for a read-only architecture (3471a7c) and then for a
   second model to review it with every relevant source and converge with Astra. Claude Fable 5.1
   did that: verified all 21 code citations (all true, two paths corrected), fetched the canonical
   pages (three "official" claims were third-party write-ups), ran probes on the server (Claude
   wakes itself on task completion in print mode; a repeated `initialize` returns a task snapshot;
   restart measured at 2.5 s; Claude children are in the service's cgroup, Codex's daemon is not),
   had Astra run the Mac probes (Codex 0.161.0 survives a lost client and reissues a pending
   approval; child completion and terminal exit are events, not wakes; `--bg` rejects `--print`),
   swept his Readwise library and the AI Engineer talks, and iterated three rounds to one
   document with no remaining disagreement.

## What changed between Astra's first draft and the agreed design

- Fenced blue/green coordinator handoff with a socket broker: withdrawn. The measured restart is
  2.5 seconds and Thinkering already has a restart-spanning retry policy; the whole front-door
  change is to apply it to message sends and the router helper, by identity.
- The execution host stays thin (pipes, journal, socket, exit); all policy lives in the
  coordinator and is rebuilt from the journal and ledger on adoption.
- Adoption consumes one ordered observation stream through the re-initialize snapshot; a
  coordinator restart never resets task membership.
- The first host-capable install waits once; afterwards nothing waits. Gate removal per machine
  depends on recovery for every execution kind that machine admits.
- The wait-only and self-matching refusals are removed as a separate scoped change; the hook
  keeps three named pre-effect checks and a growth rule.
- The durable watch is defined against the catalog's existing watch-and-notify standard, with two
  kinds and stated version semantics.
- Every user-visible claim narrowed to measured behaviour.

## Lessons, and where each now lives

| Lesson | Where it lives now |
|---|---|
| A rule that trades his latency for the system's convenience is checked against his recorded priorities before it is designed | `architecture-foundations` invariant 1; [decision: his-requests-come-first] |
| Separate the lifetime of what does the work from the lifetime of what coordinates it | `architecture-foundations` invariant 3; `stateful-shapes` guideline 14; the agreed plan §1–2 |
| A rollout must be able to reach code that is already running | `architecture-foundations` invariant 4; the agreed plan §3.1 step 2 |
| A classifier of free text in front of every action is not an enforcement boundary | `architecture-foundations` invariant 10; the agreed plan §8; `codex-cli` corrected |
| "Never build a waiter" is true, but the system wakes you natively; the skill must say what IS allowed | `codex-cli` corrected |
| The watch-and-notify schedule and the durable watch are siblings with a stated line between them | `scheduling-jobs` corrected; the agreed plan §7 |
| A foundation program is dependency-ordered complete deliveries, not phases of one feature | `review-gates` clarified |
| A "Confirmed" citation is one that someone re-verified at a named commit; web-search "official docs" are hypotheses until the canonical page is fetched | `architecture-foundations` invariant 12 and `converge-two-models.md` |
| Two models converge by evidence, with attribution checked and disagreement recorded verbatim | `architecture-foundations/references/converge-two-models.md` |

## What this retrospective does not claim

Nothing in the agreed design is built. The server's Codex login was found signed out during the
review (refresh token reused) and was not touched. The server cannot SSH to the Mac; Mac-only
reads went through Astra's session. The compiled server hook bundle's cost was not measured (the
Mac measurement was of the source path). All of these are recorded in the plan as unknowns with
their probes.
