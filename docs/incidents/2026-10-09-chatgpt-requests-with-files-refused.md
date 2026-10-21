---
failure: Every agent request to ChatGPT that carried a file was refused, from the time recordings started carrying transcripts.
date: 2026-10-09
fix_commits: [5113d03f]
cause_status: confirmed
---

# ChatGPT requests with attachments were all refused

## What was seen

The live ChatGPT Pro check on October 9 found that any ChatGPT request with a file failed as an unsupported field. No
agent had been able to attach a file to ChatGPT since attachment rows gained a transcript field for recordings.

## Cause

Thinkering's ChatGPT capability accepts only a file's custody pin (id, name, type, digest, bytes) and refuses any other
field. When attachment rows gained `transcriptText`, `bot/src/session-execution-host.ts` passed it through in both the
provider creation and the admission's attachment list.

## Fix

5113d03f strips `transcriptText` (and `base64`) from attachments sent to ChatGPT, leaving only the pin. AGENTS.md records
the rule that a ChatGPT attachment carries only its custody pin.

## Acceptance scenario

- **Seed:** A retained audio attachment with a transcript; a stub ChatGPT capability that rejects unknown attachment
  fields exactly as Thinkering does.
- **Action:** An agent asks ChatGPT with that file attached.
- **Expected:** The stub accepts the request; the attachment object it received has only pin fields.
- **Replayable offline:** yes (stub capability with strict schema)
