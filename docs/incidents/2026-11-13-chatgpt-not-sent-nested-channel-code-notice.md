---
failure: A retained CHATGPT_NOT_SENT receipt woke the repair agent because its diagnostic message also named a nested browser failure.
date: 2026-11-13
fix_commits: []
cause_status: confirmed
---

# A not-sent receipt was filed as a channel failure

## What was seen

Two repair-notice service actions were accepted and recovered: one named
`repair-notice:chatgpt-channel:CHATGPT_BROWSER_OPERATION_FAILED:498503`, and another named
`repair-notice:chatgpt-channel:CHATGPT_BROWSER_UNAVAILABLE:498503`. Both retained capability
outcomes were `CHATGPT_NOT_SENT` with uncertainty false. Their diagnostic messages included the
nested browser code, which the notice classifier selected instead of the retained outcome code.

The affected turns were interrupted during Thinkering process shutdown (23:51:57 and 23:59:47).
One browser detail described a `page.goto` target closing while the process shut down. Both
owner receipts classified the capability outcome as `CHATGPT_NOT_SENT`; the native attempts
continued under their original identities. The first was Concierge session 9656, turn 30282,
run `a8e884c1-1240-4c4c-85a4-5e853aed0a68`; the second was session 9643, turn 30302, dispatch
attempt 4, run `a84865f0-d457-4ffe-9219-c50b4c5f9f14`, request
`cc3c7f9f-3317-4954-a6d3-850c44607c94`. Neither notice established a browser-channel fault.

## Cause

`ChatGptDispatchError` retains the capability receipt in `evidence.code`, but the notice path
selected its code by searching the rendered error message. A nested diagnostic code therefore
overrode the primary typed outcome.

## Fix

The notice path now checks a typed `ChatGptDispatchError`'s retained code against the existing
suppressed wait codes before parsing the message. Other errors keep the prior prose classification,
so a wrapped send failure whose message identifies a sign-in problem still reaches the sign-in
notice path. The original diagnostic message remains available on the error and in its retained
evidence; no error text is copied to a new human-facing notice.

## Acceptance scenario

- **Seed:** A typed dispatch error retains `CHATGPT_NOT_SENT` and has a message containing
  `CHATGPT_BROWSER_OPERATION_FAILED` or `CHATGPT_BROWSER_UNAVAILABLE`.
- **Action:** Pass the error through the channel-notice classifier.
- **Expected:** No repair notice is recorded. A typed `CHATGPT_SEND_FAILED` with a nested
  sign-in code retains the existing sign-in notice path; genuine browser, untyped and sign-in
  failures keep their existing notice behavior.
- **Replayable offline:** yes (the notice function is exercised with isolated notice sinks).
