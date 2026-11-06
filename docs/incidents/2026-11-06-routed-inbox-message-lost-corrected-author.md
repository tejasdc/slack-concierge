---
failure: A routed Inbox copy could show an agent's corrected words as Tejas's words.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Routed Inbox message lost corrected authorship

## What was seen

On November 6, 2026, an authorship audit found that routing an accepted Inbox message into
another session copied the source's stored origin into a two-value human/agent field. A later
authorship correction did not change that origin, so a corrected agent message could be shown
as Tejas's message at the destination. A service-origin message was reduced to an agent label.
Thread-route projections also used the stored origin and manufactured a generic agent-test
author instead of preserving the original agent identity. A forwarded thread reply's destination
also tested stored human origin without checking a later correction. A missing route author was
projected as human.

No live corrected-route instance was found in this audit; the incorrect projection was found in
the executable source. Tejas's broader report of agent words appearing as his did not identify
this route as its incident cause.

## Cause

Route admission and display used the retained input's original origin instead of the owner's
current author projection. One fallback treated every value other than agent as human.

## Fix

The route now reads the current author projection, including corrections, and carries human,
agent, service or unknown explicitly. The destination projects only those exact values. Thread
routes retain the original author rather than synthesizing one. The source input and correction
are not rewritten. Forwarded replies resolve the source message's current author when read.
Source review found the gap; a live route of a corrected historical message has not been
exercised, so installed route verification remains open.

## Acceptance scenario

- **Seed:** An accepted Inbox message whose retained origin is human and whose current author is a corrected agent; a separate accepted service message.
- **Action:** Route each message to another Inbox thread and to a session, then read both destinations.
- **Expected:** The corrected message names the agent in both copies; the service message says Service. Neither copy says You. The original inputs and correction remain unchanged.
- **Replayable offline:** yes (with retained inputs, correction and route projection).
