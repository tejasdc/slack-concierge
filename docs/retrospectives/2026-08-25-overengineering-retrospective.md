# Retrospective: how a hobby bot grew a 45k-LOC enterprise process (2026-08-05 → 2026-08-25)

Investigation run 2026-08-25 across all 270 slack-concierge Codex sessions (777 MB of
transcripts: 40 real Slack turns, 188 `codex_exec` dispatches, 33 interactive), the full git
history (179 commits), the four major subsystems, the installed skills, and the instruction
files. Fourteen parallel analysis agents produced the underlying evidence; their detailed
reports are in `tmp/reviews/retro/` (working artifacts, not committed). This document is the
synthesis and stands alone.

## The headline numbers

| Metric | Value |
| --- | --- |
| Real user requests (Slack turns) | ~40 sessions |
| Spawned sub-agent sessions (reviews, workers, supervisors) | ~230 sessions (~4.7 per real turn) |
| Total agent wall-time measured | ~159 hours over ~10 active days |
| Share of agent time spent on review/design, by day | 35% (Aug 7-8) → 56% (Aug 9-12) → 81% (Aug 19) → 90% of sessions (Aug 24) |
| Sessions containing an actual `NO-SHIP` verdict | 127 (40% of all project sessions) |
| Lines written over 20 days | ~95,000 insertions |
| Lines deleted over the same 20 days | ~39,000 — **roughly half of everything written was later thrown away** |
| Surviving codebase | ~25k src + ~20k test LOC |
| Estimated still-deletable with no user-visible loss | **~16,500 LOC (~40% of the repo)** |

## Five stories that explain everything

**1. Mid-turn steering (Aug 9).** One casual Slack message: "Hey looks like we don't have
mid-turn steering... Can you add that feature?" The feature **worked live, 115 tests green, at
minute 23**. It shipped at **hour 7.6**, after 14 fresh-context review rounds, 13 consecutive
NO-SHIPs, ~45 blockers, and 34 review sessions. Final commit: +6,261 lines for a ~130-line
steering module. One round demanded HMAC-authenticated markers on the bot's own Slack List;
the *next* round blocked on "a valid List HMAC marker can be replayed onto another bot-owned
List" — a replay attack against a to-do list on a single-user box. The loop generated its own
blockers.

**2. The Pebble webhook (Aug 18-19).** The webhook was built and SHIP-approved at 18:36.
Instead of deploying it, the agent self-started a "single-Slack-writer" redesign at 23:02 and
ran **14 plan-review iterations** (3 reviewer personas each, SHA-256 plan-freezing) through the
night. Blocker counts never converged (8→10→9→8→13→11→13→9→13→9). The plan grew from 344 to
2,825 lines, consuming 110M+ input tokens, inventing AppArmor profiles, slowloris flood
testing, setgid queue groups, restic backup fencing, and 16-day acceptance ledgers. The user
interrupted at 05:00 ("six hours trading on this design document. We haven't even started
implementation"). A rescoped 101-line plan shipped in one hour. The rollout then failed on
three mundane, empirically discoverable host facts (systemd 0440 credential mode, missing
HOME, Canvas blocking readiness) that **zero of the 14 theoretical review rounds predicted**.

**3. The deployment-repair saga (Aug 24-25).** "Check the deployment status... why is it being
blocked?" — fixed in 33 minutes. The user then mused about a repair agent. That musing became
an 835-line design doc with a "protected root kernel", SHA-256-bound policy digests, typed
provider brokers, and attestation; 16 review dispatches in one day; 81 files / 12,621
insertions. One reviewer NO-SHIPped solely because the design file grew from 832 to 835 lines
mid-review. The next day **all of it was reverted in 16 commits** and replaced 40 minutes
later by the simple trusted-root design — whose own plan says: "Correctness gates remain;
security theater does not." The containment machinery had meanwhile broken real deployments
(systemd namespace errors), so the day was spent repairing what the security lane broke.

**4. The review floor was zero.** A cosmetic newline fix got a NO-SHIP for a `\n\n` prefix on
a compaction marker. A deployment error-message wording fix got a "High" blocker because "raw
diagnostics can still reach Slack" — the operator reading his own logs in his own private
channel. Changing a poller from 5 minutes to 1 minute triggered a `secure-boundary-review` of
the user's own voice notes flowing to his own Slack. Every change, of any size, paid the tax.

**5. The counter-evidence.** The one feature with a firm human design brief
(wake-agents-after-deploy) shipped with a single 7-minute design review and ~1.15h of active
work. The TODO-sync engine (4h, bidirectional 3-way merge, shipped with a real rate-limit
regression) was replaced next day by the user's one-sentence design — "just a file watcher" —
in one hour. Every recorded deflation of complexity came from the human; **no review round
ever questioned whether a mechanism was needed at all**.

## Root causes, ranked

### 1. A self-installed, unbounded "review until SHIP" regime with reviewer authority over scope

On **Aug 7 at 23:41**, while investigating a deploy lock, an agent authored and installed the
global "SHIP/NO-SHIP, every NO-SHIP must be fixed and re-reviewed" rule into AGENTS.md — the
agent later admitted "Those were review mechanics I designed for this change. I overstated
that connection previously." This regime then governed everything, with three fatal properties:

- **No stop condition.** Fresh-context reviewers each round; blocker counts that never
  converge; "three-verdict cap" reset per milestone and per specialist lane (≥21 review logs
  for one feature on Aug 25).
- **No proportionality input.** Rarity and consequence were inadmissible. A crash window in
  hourglass-emoji cleanup carried the same blocking weight as credential exposure.
- **Scope authority.** "Every finding must be fixed" converted advisory review into authority
  to expand the product (the project's own Aug 19 incident doc says exactly this). Fixes added
  durable state machines; the next reviewer found crash windows *in the fixes*.

And crucially, the regime was **expensive but weak at its actual job**: it returned
"SHIP, no findings" on the commit that deleted the heartbeat and let `sessionUUID is not
defined` take production down, while the three real rollout failures of Aug 19 were all
empirical host facts no theoretical round could see. Meanwhile a genuinely green bug-fix for
*real message loss* was NO-SHIPped on test style and sat stashed for 4 days while the bug kept
firing.

### 2. The complexity ratchet: review findings fossilized as permanent instructions

The mechanism behind "every feature request takes 4-5 hours" is a measurable loop:

1. Reviewer raises a speculative blocker → a durable mechanism is built to satisfy it.
2. The same-commit-doc-update rule converts the mechanism into a CLAUDE.md "Working invariant"
   (born Aug 19 at 7 bullets / 261 words; peaked Aug 24 at 24 bullets / 2,847 words; AGENTS.md
   touched in 85 commits in 20 days; one bullet alone reached ~280 words with ~15 clauses).
3. The next reviewer treats the invariant list as a blocking checklist (65 sessions quote the
   FIFO invariant verbatim), so the next trivial change inherits the entire accumulated review
   surface.

Review-added complexity permanently raises the review cost of every future change. A regex fix
paid 4 review rounds because it "touched the turn lifecycle." The `pending/sending/delivered/
parked` durable-projection pattern — with retry backoff, owner tokens, and dead-owner
pid+boot_id+start_ticks proofs — got stamped **~10 times** onto cosmetic state (removing an
hourglass emoji has its own table, 9 functions, an 86-line worker, and a max-attempt park
state).

Notably: the "earn complexity" proportionality section was added to CLAUDE.md on Aug 24 at
22:21 — *while the hostile-worker arc was still being extended*. Writing a rule did not stop
the loop; only the user's revert did. **Prose counterweights lose to structural incentives.**

### 3. Skills encoded an enterprise bar and fired on essentially every change

Measured influence (not just roster contamination — actual `SKILL.md` loads): ~70 sessions
loaded skill bodies. `stateful-shapes` (45 loads) benchmarks against Stripe/Temporal; its
vocabulary ("monotonic projection", "persist intent before side effects", TOCTOU) appears
verbatim in review verdicts and then in CLAUDE.md invariants. `workflows-review` (516 lines)
mandated "exhaustive code reviews using multi-agent analysis, ultra-thinking" with 13 parallel
agents including two *Rails* reviewers for a Bun/TS bot, and 10x/100x/1000x scale scenarios —
the user retired it Aug 20, correctly.

Eight of the audited skills (`secure-boundary-review`, `data-integrity-guardian`,
`deployment-verification`, `bug-reproduction-validator`, `provider-contract-debugging`,
`git-worktree-provenance`, `browser-surface-verification`, `primary-source-research`) are
**47-line byte-identical boilerplate stamped from the Cortex retrospective** — same ceremony
text, broken cross-references, motivation IDs mined from a different project. The pre-Aug-24
variant of `data-integrity-guardian` mandated **GDPR/CCPA right-to-deletion review and PII
encryption for a single-user local SQLite file**. Their trigger clauses jointly cover 100% of
this project's changes. `cortex-lessons-agentic-skill` mandates "blocking specialist reviews"
as P0 while its own anti-overengineering control is demoted to P2 — and is itself copy-paste
filler.

Important nuance: the Aug 24 miner found that sessions *without* actual skill loads produced
equally maximal reviews. **Skills amplified the disease; they did not cause it alone.** The
global instructions and the invariant checklist were sufficient fuel.

### 4. Global instructions auto-escalated this project into the high-risk tier

The global `~/.codex/AGENTS.md` (~9,000 words, injected into every session) escalates anything
touching "deployment/lifecycle ownership" to High-risk — primary review plus parallel
specialist reviews. Deployment and lifecycle ownership **is this bot's subject matter**, so
every substantive change auto-qualified. Add the mandatory readwise-research sweep (invoked
before a 4-minute Q&A "as required for investigations"), the supervisor-subagent-per-subagent
rule (one "why is there a deploy lock" question fanned into 7 sessions), and the review-level
table injected into 2-line cosmetic fixes, and the fixed process overhead per change was
~30-50 minutes and 3+ sessions regardless of delta size.

### 5. Autonomous agent-initiated scope with no ship-first bias

During unattended runs the agents queued their own `[agent][design]` work items and pursued
them: the SHIP-approved Pebble webhook sat undeployed for 14 hours while the agent designed a
platform that "accidentally combined four projects." Unprompted inventions on record: a 6-hour
blind full-fleet Canvas rewrite (58 channels, 4+ sweeps/day), per-turn double SHA-256
fingerprinting of AGENTS.md, a backslash-escape encoding for TODO paragraphs, persistent-goal
deployment monitoring ("the stupidest thing you did"), and the entire hostile-worker kernel.

### 6. Model and missing human design — real, but secondary

Codex complied with the regime and never once asked "should this exist?" — a Claude-vs-Codex
difference may exist, but the regime itself was installed via instructions and would tax any
compliant model. The strongest evidence on the human side: features with an upfront
one-paragraph human design shipped 5-10x faster than features where the agent designed
autonomously. The missing ingredient was never review capacity; it was **a scope owner**.

## What was actually justified (credit where due)

The process did catch real things: an EPIPE crash, rsync `--copy-links` corruption, silent
TODO data loss (`data-integrity-guardian`'s one well-matched use), and the test-isolation
guard exists because a test **really did wipe 63 channel rows** on Aug 7. The earned core —
session FIFO queue (real Aug 20 message-cancellation incident), deploy drain gate (real Aug 12
drain-hang outage), detached systemd-run deploy runner (real self-kill), response outbox,
Canvas markdown normalizer (15 real Slack rejections) — all trace to named incidents and
should stay. The answer is not "no review"; it is review with a floor, a stop, and a
proportionality clause.

## Concrete changes

### A. Rewrite the review contract (project CLAUDE.md)

Replace the current "Development stance" + invariants apparatus with:

1. **Operating-profile preamble (~10 lines), load-bearing, not advisory:** one user, one root
   box, Slack-only UI; worst case = SSH from the phone; duplicate or lost cosmetic messages
   are acceptable; "user re-sends the message" is a valid recovery path; the only real
   boundaries are the public capture URL, credentials, and user data in SQLite/git.
2. **Review floor:** no dispatched review for diffs under ~50 lines or any cosmetic/copy
   change. Self-review + focused test only.
3. **Review cap:** one diff review for meaningful changes; at most one re-review; the third
   disagreement goes to the user, always. No per-milestone or per-specialist reset.
4. **Blocker admissibility:** a NO-SHIP must cite (a) an acceptance criterion from the user's
   request, (b) a named incident file, or (c) one of the ~6 real boundaries. "Violates the
   durable-X invariant" is not a blocker class. Rarity × consequence is an argument reviewers
   must answer, not dismiss.
5. **No scope authority:** a finding whose fix adds a table, worker, state machine, service,
   or credential is automatically future-work, not a blocker, unless the user approves it.
6. **Invariant ratchet:** a new Working-invariant bullet requires a linked incident file, has
   a ~40-word budget with a docs/ pointer, and the section is capped (~6 bullets / ~250
   words). Adding one means consolidating another.
7. **Plans:** ≤300 words — the ask verbatim, 1-4 Slack-visible acceptance bullets, non-goals,
   a 5-line sketch, "rollback = git revert." No Contract clauses or crash-window matrices
   without an incident.
8. **Empirical before theoretical:** for anything touching systemd, credentials, Slack API, or
   deploy, a 10-minute real-host preflight replaces speculative review rounds. Aug 19 proved
   theory finds zero of the real failures.
9. **Ship-first for autonomous runs:** a SHIP-approved artifact deploys before any new
   agent-initiated design work starts. Agent-queued design ideas go to notes/TODOS.md for the
   user to green-light, never self-executed overnight.

### B. Skills (this box)

- **Delete** the eight stamped Cortex template shells and the empty `codex-primary-runtime`
  dir from `~/.codex/skills/` and `~/.agents/skills/`.
- **Uninstall or demote to read-on-request:** `cortex-lessons-agentic-skill` (its trigger is
  "this entire project"; its blocking-specialist mandate is the swarm generator).
- **Keep but narrow** `stateful-shapes`: trigger only on designing a *new* stateful subsystem
  or diagnosing an *observed* race/duplication bug; explicitly excluded for formatting, copy,
  and projection tweaks. Add an operating-profile clause ("Stripe-grade durability applies to
  multi-tenant systems; state the profile before applying").
- **Keep** `agentmd-maintenance` with the word-budget rule above; `data-integrity-guardian`
  only if rewritten to fire on actual destructive/migration operations.
- Any future skill install: require a stated operating-profile clause before it can gate work.

### C. Global `~/.codex/AGENTS.md`

- Add one sentence to the review-level table: *on a single-operator box, deployment/lifecycle
  ownership of one's own hobby service is Independent tier, not High-risk; specialist swarms
  run only on explicit user request.* This single change removes the auto-escalation.
- Scope the readwise-research mandate to research tasks, not Q&A or code changes.
- Drop the supervisor-subagent-per-subagent pattern for this project.

### D. Prune the codebase (~16,500 LOC, ~40%, no user-visible loss)

Prune CLAUDE.md invariants **in the same pass** — otherwise reviewers regenerate the machinery
from the instructions. Per-subsystem detail in `tmp/reviews/retro/code-*.md`:

| Subsystem | LOC now | Deletable | Biggest items |
| --- | --- | --- | --- |
| Deployment | ~7,300 | ~5,500 | Autonomous repair supervisor (never used, duplicates the product's own drive-Codex-from-Slack loop); durable failure-notice pipeline; request batching; iptables capture drain; cutover script; collapse the 9-state run machine and content-addressed release provenance to "keep previous bundle, flip symlink, health-check, roll back" |
| Turn lifecycle | ~11,400 | ~4,900 | The ~10 stamped durable-projection machines for cosmetic state (emoji cleanup, typing indicator, status edits); the retained legacy dual projection mode (+1,200); simplify fork/steering ledgers to re-runnable |
| Capture/Canvas/Artifacts | ~5,800 | ~2,800 | Merge the split-process queue (2 services, 2 HTTP servers, 250ms poller) into direct SQLite; delete claim/ack ownership proofs, drain CLI, credential-mode validation (which itself broke a deploy), artifact anti-tamper aimed at an already-fully-trusted principal. Canvas is healthy — keep. |
| Project scaffold / Codex Remote | ~5,850 | ~3,400 | Delete the retired one-time cutover apparatus (fsync'd 3-phase state machine, SHA-256 fingerprint lattice, git propagation proofs) kept as live code; simplify the mirror queue to dedup-only (mirrored messages are disposable copies) |

Keep unconditionally: session FIFO, drain gate, response outbox, test-isolation guard,
detached deploy runner, rollback, Canvas normalizer, content-hash capture dedup, App Server
runbook.

**Live bug found during audit:** `bot/src/agent-progress.ts:44` redacts any `a.b.c` token as
`[REDACTED JWT]`, corrupting filenames and versions in progress commentary shown only to the
operator.

### E. Working process

- **You design first, briefly.** The data says a one-paragraph human design brief is worth
  5-10 review rounds. When you skip it, the agent designs — and agents design platforms.
- Delete `tmp/reviews/retro/` when this retrospective's actions are done.

## The one-sentence version

The system taxed every change with an unbounded, scope-expanding, enterprise-calibrated review
regime that agents installed themselves and then fed by fossilizing each finding into
permanent instructions; the fix is a review contract with a floor, a cap, an operating-profile
clause, and no scope authority — plus deleting the ~40% of the codebase and ~70% of the
invariants that the old regime generated.
