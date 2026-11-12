---
failure: Concierge refused a one-step spoken launch test on a physical Echo as an only-he-can device question.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Echo launch question was refused

## What was seen

An agent reported that the Thinkering Box skill was built and enabled, but no real Echo
utterance had reached the server. The Inbox request needed a question asking Tejas to
say the launch phrase on his Echo. Concierge's installed device validator refused it.
The report is `capture:fd0ffb70629025de4a8e835877719ed8f121ba2677392be8281fe79c0f714a53`.

## Cause

The shared device-question gate admitted one physical step only from a short verb and
device set. It included unlocking a phone and starting an app on an e-reader, but no
spoken Echo launch.

## Fix

Admit one `Alexa, open …` utterance directed to an Echo through the same gate used
by session replies and Inbox questions. Retain the refusal of an
additional step, a phone app action, and a command that switches off Alexa+.

## Acceptance scenario

- **Seed:** Thinkering Box is enabled, with no confirmed Echo capture.
- **Action:** Ask Tejas to say `Alexa, open thinkering box` to his Echo, with his exact
  words and the reason the agent cannot perform the device test.
- **Expected:** Concierge admits the question and leaves the Alexa capture request open.
  Only a real Echo attempt and its observed outcome can settle that request.
- **Replayable offline:** yes for question admission; the physical Echo outcome is not.
