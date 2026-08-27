# Retrospective: sandbox review became a second product authority (2026-08-27)

## Outcome

Slack Concierge's four-lane sandbox worked in live Slack, but its independent
foundation review still tried to add three unrequested lifecycle protocols. The
cause was not a missing warning about proportionality. The review prompt labeled
the entire sandbox `HIGH-RISK` and required a binary `SHIP` or `NO-SHIP` verdict,
while the simpler operating-profile rules were advisory prose. That structure
gave the reviewer product authority over already-tested behavior.

The durable correction is narrower authority, not another review process:

- exact-source focused tests plus the real Slack sandbox are the behavioral gate;
- review may veto only a reproduced failure, deterministic failing check,
  documented upstream-contract violation, observed incident, direct conflict
  with requested behavior, or user-named trust risk;
- source-constructible but unobserved scenarios are advisory;
- review findings cannot authorize new persistent state, protocols, or lifecycle
  ownership gates; and
- a new prerequisite pauses only dependent work, never unrelated agents already
  running in parallel.

## What happened

The operator repeatedly specified a trusted, single-operator facility: four
fixed Slack app lanes, one worktree candidate per claimed lane, real provider
turns, browser screenshots, focused feature cases, and normal deployment only
after the implementing agent had confidence.

The foundation then passed live evidence for four concurrent lanes, a waiting
fifth claimant, persistent browser authentication, an exact provider turn, and
zero unsettled work. Its review prompt nevertheless called the change
`HIGH-RISK` because it touched sandbox credentials, Socket Mode, browser
profiles, and process lifecycle, and required one general `SHIP` or `NO-SHIP`
verdict.

The reviewer found one real regression: a removed `homedir` import while
`/auth-refresh` still called `homedir()`. It also declared three speculative
protocols blocking: a candidate-authored settlement receipt, browser ownership
state tied to release, and persisted reauthorization intent around attended
manifest updates. The coordinator initially started implementing all three,
despite the operator's explicit instruction that real sandbox evidence was the
primary gate. Those uncommitted changes were later removed; only the compile
fix shipped.

The coordinator then made a second orchestration error by interrupting three
independent feature agents when the operator requested this retrospective. The
retrospective was a prerequisite for later integration decisions, not for the
agents' already-safe sandbox work. The agents were resumed with their worktrees
intact and continued in parallel.

## Why the existing rules failed

The project already said to earn complexity, respect the real operating profile,
and keep scope with the user. Those rules should have stopped the coordinator.
They did not constrain the reviewer structurally:

1. `HIGH-RISK` plus a mandatory binary verdict outweighed advisory
   proportionality language.
2. “Concrete reachable path” admitted any interleaving that could be constructed
   from source, without reproduction, incident, provider contract, or observed
   consequence.
3. Broad non-atomic-boundary invariants supplied textual justification for new
   persistence even when no current failure earned it.
4. The sandbox runbook overstated release JSON as a drain proof. The selected
   live case proves zero unsettled durable work; release proves supervisor exit
   and lock availability.
5. The coordinator treated the reviewer as the decision-maker instead of
   adjudicating each finding against the user's accepted scope.

This repeats the 2026-08-25 retrospective's central warning: prose
counterweights lose to structural incentives. Limiting the number of verdicts
does not help when one 261,238-token review has general veto authority.

## Finding disposition

| Finding | Disposition |
| --- | --- |
| Missing `homedir` import | Confirmed regression. Fixed in `b862d01`; a focused source regression assertion now preserves it. |
| Candidate settlement receipt | No reproduced release failure or cross-run contamination. Correct the runbook's proof claim; add no protocol. |
| Browser release state | No reproduced concurrent-profile failure. Keep the active-claimant operating rule; revisit only after observed misuse earns a simple check. |
| Manifest update intent | Constructible attended-setup ambiguity, not an observed feature-loop failure. Reauthorization remains visible and attended; no persistent workflow added. |

## Review contract going forward

Independent review remains useful for a named trust boundary or as an advisory
regression scan on a large diff. For the sandbox foundation, the legitimate
named risks were production/sandbox separation and secret exposure. A reviewer
could return `SHIP` or `NO-SHIP` for those risks only, report deterministic bugs
separately, and label other unobserved scenarios advisory.

The forward test is the feature exercise already running across independent
worktrees: each agent owns its focused tests and exact-source Slack evidence,
captures the relevant native UI, proves zero unsettled work, cleans its exact
test messages, and releases its lane. Success means real regressions are still
caught, speculative protocols are not introduced, and unrelated agents are not
interrupted by retrospective or review work.
