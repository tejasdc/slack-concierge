# Exchange kinds between agents: what each costs, and the protocol for each

Status: built 2026-10-08 by the Concierge design session (concierge:3756), on Tejas's direction
relayed by the agent-ecology coordinator (request ce008d91; his words in agent-ecology
docs/plans/2026-10-08-agent-science-organization.md, "On how agents should communicate"; R191).

**Correction, 2026-10-08 ~07:40 UTC.** Tejas rejected the batched answers built below: "Please update as soon
as one agent you get there. What if one agent is like doing some minor work and an another agent is doing two hours
of work? So you're gonna wait until that two hour agent is waiting … because you you want to bash your motherfucking
answers" [decision: answers-delivered-when-they-arrive]. The batch option is removed before it installed; every answer
goes to the asker when it arrives. Token cost is being measured separately (caching and context size, concierge:4508).
He also named the real stall bug: "stalled" notices that reached the coordinator after the request was already
answered (4dbdf666, 252ca20d). A notice is now checked against the request at delivery and dropped when answered, and
an answer withdraws a notice not yet taken up. The design was not put to the lab's characters before it was built; it
is now on the board (thread 20261008-which-communication-protocol-fits-which--d6cfc4).

**Summary (as first written; batching since removed).** What costs an agent attention and allowance is mainly being woken, not long messages.
Each wake re-reads the agent's whole conversation; for the lab coordinator that was about 518,000
tokens per answer, against about 750 tokens for the answer itself. So the protocol changes cut wakes:
progress notes no longer wake anyone (built earlier today); false "stalled" notices are gone; and a
question sent to several sessions can come back as one batch, in one wake. Long knowledge belongs in
addressable products in the notes store (concierge:4491), linked from a short reply, not pasted.

## Summary first, for agents and for him (added after the coordinator's review)

Every request and every final reply now carries a one-line summary (`--summary`, required by the
router; a request or final reply without one is refused with the reason). The reader sees it first:
the worker's request opens with it, the asker's return opens with it, a batch return lists each answer
under its responder with its summary first, and the Lab page reads it from the owner (`summary`,
`answerSummary`, with `summaryWritten:false` when an older exchange has only its first line). The
asker chooses the view per request (Engelbart's view control): `--answer-view summary` wakes it with
the summary and the command that opens the body (`sessions get`); the default shows the body after
the summary, because opening a body later costs one more full re-read.

## Measured on tonight's real traffic (2026-10-07 20:00 to 2026-10-08 07:30 UTC)

The coordinator (concierge:4168, Claude Opus) sent 92 requests. What came back:

| Exchange kind | Count | Average size | Context re-read per wake | Wakes it caused |
| --- | --- | --- | --- | --- |
| Final reply (return) | 75 events, 64 wakes | 2,500 chars (~620 tokens) | 517,624 tokens | 64, total 33.1M tokens |
| Progress note | 13 | 2,170 chars | ~518k each while they woke (now: 0) | 0 since today's change |
| Overdue / stalled notice | 8 | 900 chars | ~518k | 8, of which 5 were false |
| Work request received | 14 | 17,250 chars | 294k | 14 |

Measured with agent-scripts/wake-cost.py on the coordinator's transcript (input + cache-read +
cache-creation tokens of the first model call after each delivered message). Cache reads are cheaper
per token than fresh input, but they count against the allowance and they are where the volume is.

**Consequence for the design:** shortening a reply from 2,500 to 250 characters saves ~560 tokens
per wake; avoiding one wake saves ~518,000. A "summary now, full body on demand" scheme that makes
the reader fetch the body costs one more model call, i.e. another full re-read, whenever the reader
needs the detail, which for the lab is usually. So the body stays in the return, and the protocol
removes wakes instead.

## The kinds, and the protocol each now uses

| Kind | Protocol | Wakes the reader? |
| --- | --- | --- |
| Work or information request | Addressed message to one session, opening with its one-line summary | Yes, once |
| Progress note | Recorded on the request; read with `sessions get` | No |
| Final reply | Summary line first, then the body or (asker's choice) only the summary and how to open the body; identical answers to one asker share one return | Yes, once |
| Final replies to a fan-out | **New:** `sessions ask … --batch <name>`. Every answer waits until the last one in the batch is answered, then one return carries them all, each under a heading naming who answered and how it ended | Once per batch |
| Stalled / overdue notice | Only when nothing in flight will wake the worker. **Fixed:** a worker waiting on its own request to another session, or whose sub-request has just been answered and not yet taken in, is not stalled | Only when real |
| Group discussion | The board (moving into the notes store as dialog records, concierge:4491); mentions wake once, as notices that owe no reply | Once per mention |
| Knowledge product (finding, decision, skill) | Addressable object in the notes store, linked from replies by its lasting address (Engelbart's OHS: every object addressable, views chosen by the reader) | No |
| Relay to Tejas | Agent answers go into his thread directly; only questions only he can answer raise attention | His choice |

The batch is Engelbart's view control applied to time: the reader chooses to see the round's
answers as one unit rather than one interruption each.

## What it saves (projected from tonight; measured live after install)

- False stall notices: 5 wakes × ~518k ≈ 2.6M tokens tonight.
- Batches: the E1 round asked five characters the same question; as one batch, 5 wakes become 1,
  saving ~2.1M tokens per round at the coordinator's current size.
- Progress notes (built earlier today): 13 wakes ≈ 6.7M tokens tonight.

## Not done, and why

- **Summaries-only is not the default.** It saves attention, not tokens, when the reader needs the
  body; the asker turns it on per request. Long material goes into a notes-store object and the reply
  links it.
- **Board posts** get their summary line when the board moves into the notes store (concierge:4491).
- **Batches are local.** A request to a Mac session cannot join a batch yet; it is refused rather
  than silently delivered alone.
