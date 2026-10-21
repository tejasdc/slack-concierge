---
failure: One agent final appeared six times in one Inbox topic and filed six reading items.
date: 2026-10-21
fix_commits: []
cause_status: confirmed
---

# Six copies of one answer in an Inbox topic

## What was seen

Tejas reported six copies of the lead agent's final answer in the topic “Agent-native coding
protocols, proven by experiment” on October 21. The six request IDs were 43444bda, 203af3e0,
42331c8d, 672e114f, 608ae7fa and 31a90eda. All six were answered by the same agent run,
had byte-identical 2,057-byte final bodies and attachments, and carried the same answer-group
identity. They were distinct requests for additions he had made; their outcomes must remain.

## Cause

The posting owner looked for an earlier answer in the same *message root*. Each request came
from a different root in the same Inbox topic, so that lookup missed the earlier post and wrote
six posts. The filing owner then made six reading items. This was a contract defect, not a
transport retry: the six replies had distinct event identities and the same accepted run.

## Fix

The owner now groups exact matching finals from the same run within the topic. It returns the
first post identity to every request's filing path, leaving each request's reply and completion
receipt intact and giving the topic one reading item. Explicit multi-request returns still use
their existing command identity. One time repair validates the six recorded posts and their
answered requests, then appends five collapse events and supersedes five redundant reading
items. Read projections omit collapsed posts; the originals remain available as ledger evidence.

## Acceptance scenario

- **Seed:** One Inbox topic has six placed agent additions and six requests addressed to the
  same agent run.
- **Action:** That run closes each request with the same final body and completion facts, without
  requiring one `--also` command.
- **Expected:** One post and one reading item appear in the topic; all six requests are answered.
  Different wording, attachments, agent runs or nested conversations produce distinct posts.

After installation, also verify the historical topic shows one copy and one open reading item,
all six original requests remain answered, and a marked agent test through `test-capture`
demonstrates the same behavior on the installed owner.
