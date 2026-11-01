---
failure: An agent's AI account ran out of allowance before it started, and his request ended with the provider's raw error instead of moving to an agent with room or waiting.
date: 2026-10-31
fix_commits: []
cause_status: confirmed
---

# "Not done: The recipient execution ended with error: ProviderDispatchError: Individual quota reached."

## What was seen

At 4:17 AM ET on October 31 Tejas asked the Inbox for afterparties. The router created
concierge:7688, which Automatic placement put on Google (Gemini 4 Argon High). Google refused
the first turn two seconds after it started ("Individual quota reached … Resets in 65h12m9s").
Twenty-four seconds after he asked, his notice read the line above. Nothing retried or moved the
work, and his Inbox request stayed open with no answer.

The same morning a phone repair request (aaaad41d) closed as "The work sent for it answered as
done" 45 seconds after the agent's final said his phone had not yet run the fix; that final was
recorded "Not checked live".

## Cause

Google's result for the refusal carried `num_turns: 1` and zero tokens, and its stream carried an
`error_message` step. The Google adapter required `num_turns === 0` for zero-work proof and
reported every non-reply step as a tool, so the turn counted as worked-on. It skipped both the
existing first-turn move and the allowance wait and failed terminally. The request notice then
quoted the provider's error text verbatim (added 2026-09-23 so refusals were not misread).

The thread request closure used one fixed reason for every completed final, whether or not it was
checked live.

## Fix

- A Google `error_message` step is not a tool; zero tokens with no tool or output is zero work.
- A zero-work allowance refusal of an Automatic session's first turn moves to another provider
  with fresh room (the same move capacity refusals use), else waits on its own reset.
- A request whose work ends in error says why in plain words and that nothing retries it; the
  provider text is kept on the request as `providerError`.
- A completed final recorded "Not checked live" closes its thread request with "Shipped, but not
  yet seen working: …" instead of "answered as done".

## Acceptance scenario

- **Seed:** Google's allowance is spent; an Automatic small-task session is created on Google.
- **Action:** its first turn is refused with "Individual quota reached" and zero tokens.
- **Expected:** the session moves to Claude or Codex with the same turn, input and request, and
  the request is answered there; no notice quotes the provider's error.
- **Replayable offline:** no (needs a real spent Google allowance, or a stand-in Google CLI result)
