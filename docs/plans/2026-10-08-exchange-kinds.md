# Exchange kinds between agents: what each costs, and the protocol for each

Status: built 2026-10-08 by the Concierge design session (concierge:3756), on Tejas's direction
relayed by the agent-ecology coordinator (request ce008d91; his words in agent-ecology
docs/plans/2026-10-08-agent-science-organization.md, "On how agents should communicate"; R191).

**Summary.** What costs an agent attention and allowance is mainly being woken, not long messages.
Each wake re-reads the agent's whole conversation; for the lab coordinator that was about 518,000
tokens per answer, against about 750 tokens for the answer itself. So the protocol changes cut wakes:
progress notes no longer wake anyone (built earlier today); false "stalled" notices are gone; and a
question sent to several sessions can come back as one batch, in one wake. Long knowledge belongs in
addressable products in the notes store (concierge:4491), linked from a short reply, not pasted.

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
| Work or information request | Plain message to one session (needs the full ask) | Yes, once |
| Progress note | Recorded on the request; read with `sessions get` | No |
| Final reply | One return per answer; identical answers to one asker share one return | Yes, once |
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

- **No forced summary field.** It would not save tokens (above), and a summary the reader must open
  costs more. Replies should still lead with their answer; long material goes into a notes-store
  object and the reply links it.
- **Batches are local.** A request to a Mac session cannot join a batch yet; it is refused rather
  than silently delivered alone.
