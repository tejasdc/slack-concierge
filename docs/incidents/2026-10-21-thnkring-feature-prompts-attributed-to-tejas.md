---
failure: Prompts that thnkr.ing's writing partner, sentence feedback and Reader composed for agents appeared in conversations as messages Tejas had typed.
date: 2026-10-21
fix_commits: [0129f8d8]
cause_status: confirmed
---

# thnkr.ing feature prompts were shown as written by Tejas

## What was seen

The nightly review on 2026-10-21 (request `4c432627`) found that when the writing partner sent a thread's `%% … %%`
notes to its co-writer, when sentence feedback went to the agent that wrote a sentence, and when the Reader asked an
agent about a passage, the agent conversation showed the server-composed text as "You · web": a message from Tejas
that he never typed. He has called exactly this kind of misattribution lying (September 17–23).

## Cause

Those thnkr.ing features called Concierge's ordinary human route, `POST /sessions/v1/sessions/:id/inputs`. That route
is the trusted human surface: `SessionOwner.submit` in `bot/src/session-owner.ts` admits every input it receives with
human origin, and the author display (`doorOf` in `session-message-author.ts`) labels it as him through the web door.
Concierge had no general way for a thnkr.ing feature to say "this is from me, not from Tejas". The only service-origin
entrance was the journal keeper's narrow route, `POST /journal/observations`, added on 2026-10-15 by a4efff71 for
saved journal entries before any misattribution was reported there; it also fixes its destination, so the other
features could not reuse it.

## Fix

0129f8d8 adds `POST /sessions/v1/sessions/:id/feature-requests` with `{clientActionId:"feature:<feature>:<id>",
feature, text}`. `submitFeatureRequest` validates the feature name and action ID, prefixes one line naming the feature
and stating it is not a message Tejas typed, and admits the text with **service** origin; the same action ID returns
the same input. Where his own words matter, the feature quotes them inside the text. Thinkering moved its callers to
the route in its own repository (d4d6c4ef for the writing partner and sentence feedback, a76f27e3 for the Reader).
Contract: `docs/contracts/feature-request-admission.md`, with a row in `docs/contracts/session-owner-v1.md`.

Limit: this is a new route, not a refusal. Nothing in Concierge stops a future thnkr.ing feature from sending composed
text through the human inputs route again; that stays a convention on the Thinkering side.

## Acceptance scenario

- **Seed:** An agent session and a stand-in thnkr.ing server holding the trusted owner credential.
- **Action:** The stand-in posts `{clientActionId:"feature:writing-partner:t1", feature:"writing-partner", text}` to
  the feature-requests route, then posts the same body again.
- **Expected:** One accepted input with origin `service`, whose text begins with the line naming thnkr.ing's
  writing-partner feature; the conversation shows it as a service message, never "You · web"; the second post returns
  the same operation. A body whose action ID does not start with `feature:<feature>:` is refused with 400
  `FEATURE_REQUEST_INVALID`.
- **Replayable offline:** yes (owner socket on a scratch ledger; no provider turn needs to complete)
