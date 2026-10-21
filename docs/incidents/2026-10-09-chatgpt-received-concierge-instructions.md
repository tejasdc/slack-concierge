---
failure: ChatGPT was sent Concierge's internal request header and reply instructions, and tried to run Concierge's command line in its sandbox.
date: 2026-10-09
fix_commits: [6d06cf6e]
cause_status: confirmed
---

# ChatGPT read Concierge's reply protocol as its task

## What was seen

During the live ChatGPT Pro check on October 9, ChatGPT treated the request header and protocol pointer as part of the
question and tried to run `router-actions.sh` in its own sandbox instead of just answering.

## Cause

`sessions ask` built every request's first input in `bot/src/session-communication.ts` as "Session request <id> from
concierge:<n> … Close it with sessions reply …" plus `REQUEST_PROTOCOL_POINTER`, summary and fit note, then the asker's
text. ChatGPT has no session tools and answers with its turn, so those agent instructions were noise it tried to follow.

## Fix

6d06cf6e sends only `input.text` when the target provider is ChatGPT (by request provider or the target session's
`provider_id`); other providers keep the full header.

## Acceptance scenario

- **Seed:** A requesting agent session and a ChatGPT target; a stub capability that records the sent text.
- **Action:** The agent runs `sessions ask --provider chatgpt` with a one-line question.
- **Expected:** The recorded text equals the question exactly, with no request id, `sessions reply` instruction or
  protocol pointer.
- **Replayable offline:** yes (stub ChatGPT capability)
