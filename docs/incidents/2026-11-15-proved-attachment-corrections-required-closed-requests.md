---
failure: A genuine unsent attachment rejection could not use the supported correction command while its answer was still owed.
date: 2026-11-15
fix_commits: []
cause_status: confirmed
---

# Proved attachment corrections required closed requests

## What was seen

In repair request `a48b79be-c24d-480b-b2a4-d18e21594c15`, the separately marked benign
request `9414b645-b6c1-43f2-a05c-a3c71c375680` reached a genuine native attachment
rejection at 04:24:33 UTC. Its original run `6a7dc206-ecd2-462b-bc86-b2efd91b670e`
remained prepared with no message, acknowledgement or answer. The actual retained error
was `CHATGPT_ATTACHMENT_REJECTED`, with ChatGPT's 20-file refusal for 22 synthetic files.

The same asker then supplied complete indexed contents of those synthetic files in one
changed file, with the exact original question, task and target, using `--correction-of`.
The supported command refused before admission: the original request did not own the
unanswered question, task and target. The unsuccessful action retained no new request;
its same stable action identity remains available for the corrected acceptance check.

A bounded read-only owner ledger query confirmed all identity/task/question fields match.
The question state remained `awaiting_answer`; the communication request outcome was null.
No original formal review was retried, canceled, repackaged or manually changed.

## Cause

The answer guarantee intentionally keeps a communication request open after its provider
attempt fails. The correction entrance nevertheless required its outcome to be `failed`.
Both local and peer entrances also required the advisory question state to have moved to
`reconcile_receipt`, even after the native provider had a definitive terminal rejection.
Recovered requests reuse their request/run identities; a prior result transition can
remain idempotently recorded while the question again says `awaiting_answer`.

## Fix

One shared predicate identifies pending custody of the original question across local,
peer and final correction admission: original active request, open awaiting/reconciliation
state, and either a still-open communication request or a historical failed one. This
predicate grants no send authority. Existing live reconciliation must still prove the
exact original terminal attachment rejection, no Send acknowledgement/provider turn/text,
unchanged binding, same actor/question/task/target, and changed file bytes. The final
admission additionally requires the retained rejection reason and original run identity.
Answered, canceled, withdrawn, superseded, ambiguous and unproved attempts remain refused.

State card: canonical Concierge owns the answer duty and immutable attempt mapping. A
provider attempt's terminal result does not settle its question. The old receipt remains
evidence; a corrected packet is a new immutable request under that same duty. Local and
peer custody use the same predicate and their existing live-proof entrances. No schema,
new route, message, retry, scheduler or original-request rewrite is introduced.

## Acceptance scenario

- **Seed:** The installed native channel has a genuine marked benign attachment rejection,
  while its original question remains open and its request outcome is null.
- **Action:** Submit changed synthetic file bytes through the existing correction command,
  preserving the exact question, actor, task and target.
- **Expected:** The owner first reconciles the actual original no-Send rejection, then
  admits one new attempt under the same answer obligation. Its native answer returns and
  can be explicitly handled. The failed original and the formal review remain unchanged.
- **Replayable offline:** no (the requested acceptance crosses the installed native channel).

Source bundling passed. Installed correction acceptance remains pending at this commit.
