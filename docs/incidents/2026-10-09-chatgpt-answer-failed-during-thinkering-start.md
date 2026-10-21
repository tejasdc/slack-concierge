---
failure: A ChatGPT answer that was still being written was reported failed because Thinkering answered a bare 503 while it started after an update.
date: 2026-10-09
fix_commits: [fd1300bb]
cause_status: confirmed
---

# An in-progress ChatGPT answer was marked failed while Thinkering restarted

## What was seen

An update at about 7:06 PM on October 9 lost a ChatGPT Pro answer that had already reached ChatGPT; f970d7eb fixed that by
making Concierge keep following the run through a Thinkering restart. The live restart check at 7:25 PM then still reported
the run failed, although Thinkering went on to resume reading the answer.

## Cause

Concierge's capability client (`bot/src/session-capability-client.ts`) follows an acknowledged ChatGPT run and treats
"Thinkering is restarting" as a reason to keep waiting (back off to 30 s, up to 20 minutes). The recognised signals were
only `CAPABILITY_DISCONNECTED` and `CHATGPT_CAPABILITY_UNAVAILABLE`. While Thinkering is starting, its server answers a bare
HTTP 503 with neither code, so the follow treated it as a real failure and ended the run. Confirmed by the live check
quoted in the commit.

## Fix

fd1300bb adds `outcome.error.status === 503` to the restart-signal condition, so a bare 503 during the follow keeps the
waiting loop going. f970d7eb (same day, earlier) introduced the waiting loop and is the context for this narrower gap.

## Acceptance scenario

- **Seed:** An acknowledged ChatGPT run (request sent, answer not yet read) recorded in the ledger; a stand-in Thinkering
  capability endpoint that is stopped, then restarts answering plain 503 with no error code for 20 seconds before serving.
- **Action:** Concierge follows the run across that window.
- **Expected:** The run stays running (not failed, not uncertain) through the 503s and settles with the answer once
  Thinkering serves again.
- **Replayable offline:** yes (stand-in capability server that returns 503 for a fixed period; no real ChatGPT needed)
