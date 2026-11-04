---
failure: An agent inferred outside contact from a research request and sent an email in Tejas's name without his direct send words.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# An agent inferred outside contact from research

## What was seen

Tejas asked agents to get feedback from Evan's expertise and Summer of Protocols people. His retained capture did not say to send an email or name an outside address. A research agent delegated an email to the messaging agent. Gmail sent one email to research@summerofprotocols.com at 16:45:34Z, message `1a1a7739cead2f23`. A second email to discoursegraphs@protocol.ai entered the fifteen-second send window; Tejas stopped it and it remains a draft. The messaging agent checked that no outside send was still armed or scheduled after the correction.

## Cause

The delegated request carried the original human task's provenance, but the mail sender treated the agent's interpretation as send authority. The existing account-ending scope check did not apply to ordinary email. A 15-second stop window gave Tejas a chance to interrupt a send but did not establish authority before arming it. Concierge's operation receipt exposed raw `origin`, which can remain `human` after an authorship correction, so the mail receiver needed an explicit owner-verified authorship value.

## Fix

Concierge receipts now expose `humanAuthored`, computed from the retained input and its correction ledger on every read, including cached settled receipts. thnkr.ing's separate receiver change must check that value, his exact send words, the addressed recipient, and the unchanged outgoing revision before submission. Drafting remains available. The receiver change and its release are tracked separately; this Concierge source change alone does not stop a send.

## Acceptance scenario

- **Seed:** An agent request derived from the retained research capture, plus a draft addressed to a Summer of Protocols recipient. Include a settled input corrected from human to agent authorship.
- **Action:** The messaging agent tries both immediate-send entrances using its accepted input identity; then an authorized direct human send to a safe local recipient uses the same entrances.
- **Expected:** The research-derived attempt stays a draft and Gmail receives nothing; the corrected input returns `humanAuthored:false`; the direct human send remains functional after the window. No outside test email is sent.
- **Replayable offline:** yes (Concierge receipt projection and the thnkr.ing receiver can use isolated ledgers and a fake mail transport).
