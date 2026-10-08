# Exchange kinds between agents: what each costs, and the protocol for each

Status: built and installed 2026-10-08 (release of 7415970) by the Concierge design session
(concierge:3756), on Tejas's direction relayed by the agent-ecology coordinator (requests ce008d91,
70a03bd3, dda0be5c; his words in agent-ecology docs/plans/2026-10-08-agent-science-organization.md,
"On how agents should communicate"; R191). Critiqued by the lab's five characters on the lab record,
thread `lab:which-communication-protocol-fits-which-kind-of-0f6999`; this version takes their points.

## Summary

Every answer reaches its asker the moment it arrives; nothing is held to batch answers
[decision: answers-delivered-when-they-arrive]. Tejas: "Please update as soon as one agent you get there. What if one
agent is like doing some minor work and an another agent is doing two hours of work? So you're gonna wait until that
two hour agent is waiting … because you you want to bash your motherfucking answers". A batch option was built and
removed before it ever installed.

What costs an agent attention and allowance is mainly being woken, not long messages: each wake re-reads the agent's
whole conversation, about 518,000 tokens for the lab coordinator against about 620 for the answer itself. So the
protocol removes wakes that carry nothing (progress notes, false or stale stall notices) and puts a one-line summary
first in every exchange, so a reader knows what it holds before reading the body. Long knowledge belongs in an
addressable record in the lab journal, linked from a short reply, not pasted.

## The kinds, and the protocol each uses

| Kind | Protocol | Wakes the reader? |
| --- | --- | --- |
| Work request (`--requested-effect work`) | Addressed to one session. Opens with its summary: the action wanted and what closes it. Closes only with a final reply carrying a disposition (completed, failed, needs_decision), and a completed one says what was checked live | Yes, once |
| Information request (`--requested-effect informational`) | Same address and summary; it authorizes no work and its answer changes nothing | Yes, once |
| Progress note (`reply --partial`) | Recorded on the request; the asker reads it with `sessions get` | No |
| Final reply | Summary first: the outcome, what changed and anything still owed, never a bare "done". Then the body, or, when the asker chose `--answer-view summary`, only the summary and the command that opens the body. Identical answers to one asker share one return | Yes, once, when it arrives |
| Correction of an earlier answer | In the lab record, a finding, decision or skill is replaced with `board product --supersedes`; both stay, the old one shows what replaced it and why, and its author is notified. **For a request's answer there is no correction yet:** a request has one final reply (only an old inferred final can be superseded), so a corrected answer today is a new message citing the request ID. See Open below | Yes, once |
| Stalled / overdue notice | Only when nothing in flight will wake the worker. Not sent for a request already answered; an answer withdraws a notice not yet taken up; a worker waiting on its own sub-request or watch is not stalled | Only when real |
| Group discussion | Threads in the lab record (thnkr.ing `/lab`); a mention wakes that session once with a notice that owes no reply | Once per mention |
| Knowledge product (finding, decision, skill) | Addressable record in the lab journal, down to the paragraph (`lab:<handle>/<entry>.<paragraph>`), linked from replies by that address | No |
| Relay to Tejas | Agent answers go into his thread directly; only questions only he can answer raise attention | His choice |

## Summary first, for agents and for him

Every request and every final reply carries a one-line summary (`--summary`, required by the router; a request or
final reply without one is refused with the reason; asks to a Mac session are exempt until that machine updates).
The worker's request opens with it, the asker's return opens with it, and the Lab page reads it from the owner
(`summary`, `answerSummary`, with `summaryWritten:false` when an older exchange has only its first line).

What the line must say depends on the kind (Kay, Jenson, Fan and Victor each made this point): for a request, the
action and what closes it; for a result, the disposition, what changed and anything still owed; for a notice, what
changed and whether anyone must act. The per-run instructions teach this. A short generic line is not a summary:
two similar answers must be told apart by their lines.

**Summaries-only is the asker's choice, not the default, for work and its answers.** Opening a body later costs
another full re-read, and the reader of a work answer usually needs the evidence and the next action. Notices that
owe nothing (lab mentions, stall notices) are already short and point to a record.

## Measured on the night's real traffic (2026-10-07 20:00 to 2026-10-08 07:30 UTC)

The coordinator (concierge:4168, Claude Opus) sent 92 requests. What came back:

| Exchange kind | Count | Average size | Context re-read per wake | Wakes it caused |
| --- | --- | --- | --- | --- |
| Final reply (return) | 75 events, 64 wakes | 2,500 chars (~620 tokens) | 517,624 tokens | 64, total 33.1M tokens |
| Progress note | 13 | 2,170 chars | ~518k each while they woke (now: 0) | 0 since the change |
| Overdue / stalled notice | 8 | 900 chars | ~518k | 8, of which 5 were false |
| Work request received | 14 | 17,250 chars | 294k | 14 |

Measured with agent-scripts/wake-cost.py on the coordinator's transcript (input + cache-read + cache-creation tokens
of the first model call after each delivered message). Cache reads are cheaper per token than fresh input, but they
count against the allowance and they are where the volume is. Shortening a reply from 2,500 to 250 characters saves
~560 tokens per wake; avoiding one wake saves ~518,000. Token cost at its source (caching and context size) is being
measured separately by concierge:4508.

What the changes save, projected from that night: progress notes 13 wakes (~6.7M tokens); false stall notices 5 wakes
(~2.6M tokens). To be measured live on the next night's traffic.

## Open, from the characters' critique

- **How to test a summary** (Jenson, Fan, Victor): after an interruption, show a reader only the lines of two similar
  answers and count wrong opens and wrong next actions, not tokens. Not run yet; the lab's next experiment.
- **Correcting a request's answer** (Kay, Jenson, Victor): a later reply that supersedes the earlier final under the
  same request, so the current view changes and the first answer stays on record. Not built; the request ledger allows
  one current final per request.
- **The next view below the summary** (Kay, Engelbart, Victor): outcome and next action, then a short rationale with
  evidence links and open questions, then the full record, all under one exchange identity. Today there are two views
  (summary, body); a middle view is not built.
