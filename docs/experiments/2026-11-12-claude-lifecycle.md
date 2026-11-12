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
| Independent memory across that account change | Not proved | Automatic earlier-work context supplied the first account value in the complete follow-up, contaminating the recall check |
| Same-account conversation memory comparator | Observed: session `concierge:9503` returned its earlier random fact while still on Chann | The fact was absent from the complete admitted follow-up; this does not prove different-account memory |
| Pause, Continue and isolation | Not run | Reviewed capability merged; installed acceptance still awaits its commit-scoped release watch |
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
