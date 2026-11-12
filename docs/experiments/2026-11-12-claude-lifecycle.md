# Native Claude lifecycle acceptance — November 12, 2026

Controller: GPT-6.1 Sol, server session `concierge:9501`, working in the isolated
`claude-lifecycle-9501` worktree. Parent request:
`d6f63731-ef12-4579-a4c8-a46f87ff586e`. This is a continuation of the account
experiments, limited to unfinished native Claude lifecycle/account movement.

## Pre-registered checks (v1)

The existing CLI concurrency, cross-home saved-conversation and repaired server
crash cases are not repeated. Mac crash acceptance remains with controller
`mac:314`, request `36e3daf6-0b8e-49fb-8485-30af5ebc12ac`.

| Cell | Starting state and actor | Required observation | Rejecting result |
| --- | --- | --- | --- |
| Pause holds accepted work | Separate Codex controller pauses one disposable completed Claude session, then sends one synthetic follow-up | Exact follow-up remains accepted and unstarted while suspension remains true, including after ordinary queue upkeep | Any provider invocation or final answer before Continue |
| Continue preserves context | Same controller explicitly continues that exact session | Same native Claude conversation recalls a fact supplied only on the earlier turn; real inherited login reported before/after; original follow-up settles once | New UUID, lost fact, changed input identity, duplicate settlement |
| Isolation | Controller and another disposable Claude conversation run through the single-session controls | Other conversation completes its own accepted work and controller remains active; no global pause mutation | Unrelated suspension/cancellation or controller interruption |
| Automatic account continuity | A real account refusal or natural dispatch change occurs in the disposable conversation | Same conversation continues on a different confirmed account, retains context and accepted request, and does not replay acknowledged effects | Only a manual CLI cross-home resume, fabricated production usage, or selection without an actual account change |

Pause is an admission hold in the current native per-session contract. It does not
claim to stop an already running provider. No Pause all, shared Codex login change,
credential copy, user app control, fabricated usage or authorization bypass is
permitted. No deliberate allowance spending is used to manufacture exhaustion.

## Initial observations

The marked Thinkering agent entrance refused the disposable session's Pause with
`AGENT_DOOR_CLOSED`: “This route is unavailable to agents. Use an explicitly scoped
capability for the information or action you need.” No mutation occurred. The
installed session command exposed global pause/status/resume, but no per-session
Pause/Continue. A source-checked single-session control is being added through the
normal reviewed release path; the human-authored route is not used as a fallback.

Baseline disposable session `concierge:9503`, address `session:WzIsOTUwMywxXQ`,
completed request `77d93bc3-a429-4a4c-b1ee-7d132838c550`, turn `29110`, native
conversation `b4de3d93-02eb-428b-895b-80d8bf94788c`. Its direct inherited
`claude auth status` reported `tejas@chann.app` and the corresponding account
home. The synthetic fact is retained in the baseline transcript and receipt;
the follow-up will ask for it without supplying it again.

At 20:22 UTC the installed usage entrance showed all three Claude accounts with
room (Chann weekly 81%, Gmail 5%, Hey 80%). A forecast of future exhaustion is
not an actual refusal or switch. Fresh exhaustion recovery remains **unrun**;
this report does not convert healthy account availability into that proof.

## Results

| Observation | Result | Evidence boundary |
| --- | --- | --- |
| Ordinary native account-route continuation | Observed: session `concierge:9470`, native UUID `71413915-fc5b-4986-8ae4-b724290e5dd6`, reported Chann at 19:34 UTC and Hey at 20:49 UTC | Direct inherited auth checks; ordinary addressed follow-up supplied no account pin; one final receipt per request |
| Original context under the later account | Observed with independent recorded-request reconstruction | Original Chann organization identifier recalled under Hey before tools; first email-recall probe remains contaminated and invalid |
| Same-account conversation memory comparator | Observed: session `concierge:9503` returned its earlier random fact while still on Chann | The fact was absent from the complete admitted follow-up; this does not prove different-account memory |
| Pause and isolation | Observed on installed control: target held its exact marked accepted input while comparison 9506 completed | Target-only controls retained agent provenance; no global Pause mutation |
| Continue of accepted input | Failed on installed 30091dda; original input completed after repair installation on a0cad8cd | Same accepted input, native UUID and earlier fact; one observed native admission and terminal answer, without a resend |
| Fresh exhaustion recovery | Not run | No genuine new refusal observed; ordinary account movement does not establish exhaustion recovery |

The different-account requests were `a5f2ba86-8a16-4511-8568-def18e77d37e`
and `3528218b-73fc-461e-8eac-07590464e327`. Both direct auth results belong
to the same native transcript. No account mutation or transcript/file search command
appears in that transcript; credential bytes and universal process survival were
not measured. An independent read-only GPT-6 Luna audit confirmed these narrow
claims and the contaminated recall boundary. Sanitized request, auth and admission
metadata are retained in
[the native continuation evidence](2026-11-12-claude-native-account-continuation.json).
The original full lifecycle request remains open.

## Installed control acceptance and observed release gap

The commit-scoped watch fired with three retained observation gaps (63 s, 45 s, 16 s).
Installed release 30091dda includes the reviewed control. Pause/Continue changed
only 9503; old-action retries returned the original control operation and current
state, and changed target/verb conflicted. This supports the captured target
states, not a universal claim about external side effects.

The marked entrance accepted input 71b9aeb2-54d5-4294-ba02-ff2afc33ac85
at 21:14:21 UTC while paused. It remained INPUT_HELD with no run or acknowledgement
after comparison 9506 completed request4b20d61c-96b6-4789-b0a0-4115ce166273.
Explicit Continue cleared suspension but did not submit that input. At that pre-repair checkpoint, the original
input was retained without resend and acceptance remained failed pending reviewed
normal recovery and the exact-input live check below. See
[raw sanitized control evidence](2026-11-12-claude-pause-live-gap.json) and
[the diagnosed recovery gap](../incidents/2026-11-12-marked-paused-input-not-released.md).


## Observed completion after installed recovery correction

Repair `0a5d63e7` merged through PR817 at `0b678389` and was observed installed
in release `a0cad8cd`. Its commit-scoped watch fired at 21:45:43 UTC with no
observation gaps. The previously accepted input `71b9aeb2-54d5-4294-ba02-ff2afc33ac85`
was queued once as turn29300 at 21:45:37 and completed at 21:46:02, without a
new input or additional Continue command. Its native conversation remained
`b4de3d93-02eb-428b-895b-80d8bf94788c`, binding1; its run was
`53f4bab6-839e-4a0f-93b7-eaf1d5143f5d`.

The complete admitted input was 1622 UTF-8 bytes. Its hash matched the retained
admission hash exactly, and the earlier synthetic fact was absent from it. The
native transcript contains one matching admitted input, one ordinary auth-status
command and one terminal answer recalling that fact. Actual inherited account
remained Chann. The owner events separately retain one accepted event and one
result for that input/run; the account event uses attempt2, so this is **not**
a one-dispatch-attempt claim. No universal external-effect exactly-once guarantee,
credential-byte comparison or all-process survival check is inferred.

Comparison9506 completed while the target was still held and remains unpaused;
global Pause remains false at generation12. Independent read-only GPT-6 Luna audit
passed this narrow repaired native context-and-isolation acceptance, after reading
the exact receipts and complete native input, command and terminal answer.
The sanitized completion record is
[retained separately](2026-11-12-claude-pause-installed-completion.json), alongside
the pre-repair failure evidence rather than replacing it.

A bounded account-event read for earlier cold9470 now independently identifies
its actual Chann-to-Hey selection as `moved-for-room`, with Chann expected. Its
20:58 synthetic fact seed remained on Hey for warm cache. This strengthens the
ordinary automatic account-route observation, while independent cross-account
recall was still unproved at that checkpoint; the later original-context check
below supplies its separate evidence. Fresh exhaustion remains unrun.


## Original-context check under the later account

The idle follow-up at 22:00 UTC recalled its seeded fact without the value in
its full 7927-byte newly admitted input. It remained on Hey; this is a clean
same-account control, not another account move. Its watch recorded a 24-second
update observation gap; a direct transcript check before admission found the
last user/assistant activity at 20:58:14.761 UTC, over an hour earlier.

A stronger original-context oracle uses the random organization identifier in
this conversation’s **first Chann auth result**, native message
`b9bd509d-8a6d-423a-b50e-236fc31639f1` at 19:34:25.964 UTC. That value was
absent from all later newly supplied native user text before the check. Request
`429a4b46-8332-46c3-874e-33dd105aac9b` asked for that original identifier without
supplying it, before running the current auth check.

In the same native UUID, its complete 7624-byte admitted prompt omitted the
original identifier. It stated the exact original value at 22:05:35.214 UTC,
before its first tool call at 22:05:35.222 UTC. The direct current auth result
at 22:05:35.820 UTC reported Hey and its different organization identifier.
The comparison is original Chann context under a later verified Hey execution,
following the already-observed automatic move at 20:49; no new move on the
22:05 follow-up is claimed. Independent read-only GPT-6 Luna audit supports
this original-context-under-later-account acceptance.

[Both context checks and source identities](2026-11-12-claude-original-context.json)
are retained separately. The earlier contaminated email-recall result remains
invalid; the new observation does not rewrite it. No fresh exhaustion event or
Mac acceptance is inferred. The preregistered automatic-account cell permits a
real refusal **or a natural dispatch change**; fresh exhaustion is a separate
unrun observation, not a required trigger for the natural-change branch.


The contamination audit initially flagged local credential-organization and
session-owner metadata that also carried the original identifier. The CLI’s
recorded API request before the answer resolves that ambiguity: its 34 message
references (32 unique) all reconstruct by canonical SHA-256, and its complete
system/tools shape matches its recorded hash. The original identifier occurs
only in the retained first auth-result message. It is absent from the newly
supplied input and selected system/tools material; the local metadata is not
selected request content. The independent auditor reconstructed this directly
from the native transcript. This establishes the recorded request construction
and observed answer, not an independent network capture.

All preregistered **server** native lifecycle/account-continuity cells now have
bounded acceptance evidence. Fresh exhaustion is separately unrun. The Mac
Pause/Continue and ordinary different-account continuation cells also have
bounded observations; see the [combined Mac evidence](2026-11-12-mac-native-lifecycle-acceptance.md).
The public-device capture hop, fresh exhaustion, and refusal recovery remain
unrun; they are not required to call the observed Mac lifecycle cells complete.
