---
failure: Concierge refused a named Maschine+ USB connection as a device question.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Named hardware connection was refused

## What was seen

The music agent's Mac route found the Maschine+ absent from USB. Its physical
connection question beginning "Please connect the Maschine+ to your Mac over USB"
was refused, so the agent had to ask Tejas to connect "the device" instead.
Its first body also contained later sentences that did not start with an allowed
agent-statement lead; after the agent rephrased those sentences, the generic
question was accepted. A separate attempt asking Tejas to report the device's
screen mode was correctly refused as a second action.
The agent report is
`req:agent-report:capture:364c74820e19417c1beeca96104d260b49c2c4f516ac824b1afbf11c96186930`.

## Cause

The device-question gate matched a hardcoded set of generic device nouns after
"connect".

## Fix

It now accepts a named hardware connection when the question names
both a host device and a USB cable transport. The existing first-sentence,
single-action and later-sentence guards still apply. The agent's required reason
records why the physical step cannot be performed through its own route.

## Acceptance scenario

- **Seed:** The Mac's USB route reports the Maschine+ absent.
- **Action:** The agent asks, "Please connect the Maschine+ to your Mac over USB."
- **Expected:** The owner admits the question and presents the named hardware;
  a second action, a later request, or a digital connection remains refused.
- **Replayable offline:** yes, through the deterministic device-question gate.
