---
failure: The test-capture command hid its admission result inside a clipped response preview.
date: 2026-11-17
fix_commits: []
cause_status: confirmed
---

# A successful agent test hid its diagnostic result

## What was seen

Live notification-reader acceptance on November 17 admitted five marked-agent
probes correctly. The first admission at 13:17:43 Eastern retained a result mark
and no human notification authority. However, the command printed only the first
2,000 characters of the owner response in `body`, ending before the diagnostic
field and leaving incomplete JSON inside that preview string. The frozen receipts
were recovered through the bounded canonical reader without replaying captures.

## Cause

The bounded raw-body preview was the only output representation. A preview is
appropriate for logs, but it cannot also serve as a structured admission receipt:
the response contains a retained request before its diagnostic observation.

## Fix

Parse the complete response before formatting the preview. Keep its existing
2,000-character limit, and add compact `operation` identity and `agentTest`
diagnostic fields outside it. Project only the named scalar fields, not the
retained request or unknown nested payloads. Preserve null classification as a
meaningful result. Malformed response text still produces a bounded preview
without throwing after a capture may have been accepted.

The helper is included through the existing sealed control artifact map. The
focused response fixture runs in the existing release gate. Capture identity,
admission, classifier semantics, agent provenance and phone authority are unchanged.

## Acceptance scenario

- **Seed:** A complete owner response larger than 2,000 characters, with operation identity and agent-test diagnostics after a large retained request.
- **Action:** Format it with the production test-capture response helper.
- **Expected:** The raw body preview stays at most 2,000 characters; compact identity and diagnostic fields remain available separately; the retained request is absent from those projections. Malformed text and nested wrong-type payloads do not throw or escape through structured fields.
- **Replayable offline:** yes; run `bun run scripts/agent-test-capture-response-fixture.ts` from `bot/`.

Installed acceptance uses one fresh marked agent capture through the ordinary
test-capture command and reads these fields from its output. That demonstrates
command presentation, not a human input or physical phone notification.
