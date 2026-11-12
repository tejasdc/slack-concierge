---
failure: A disk alert that recovered and fired again never reached Concierge or the repair agent, because Grafana treated the new episode as the one it had already sent.
date: 2026-11-06
fix_commits: []
cause_status: best-explanation
---

# A re-fired disk alert stayed invisible for up to a day

## What was seen

Grafana's state history for `AX41DiskFillingEarly` (rule `obs-9823f09766e0`) shows
alerting from 2026-11-05T14:41:30Z, Normal at 18:22:30Z, and alerting again from 18:53:30Z.
Concierge received the 14:41:30Z firing at 16:22:49Z and nothing afterwards. The
18:22:30Z recovery fell inside the window when Concierge refused most Grafana deliveries.
By 05:30Z the next day Grafana's Alertmanager held the alert active since 18:53:30Z.
Concierge still showed the 14:41:30Z start, and the repair agent never learned that a new
episode had begun. Concierge accepted Grafana's later deliveries for other alerts with 202.

## Cause

Confirmed from Grafana's configuration: the rule's notification settings send to
`personal-observability-concierge` with a one-day repeat interval. Best explanation,
following Alertmanager's documented deduplication (its notification log records which
alert fingerprints were firing in the last successful notification): the refused recovery
left that log at "this fingerprint firing" from 16:22. The re-fire has the same
fingerprint, so Alertmanager saw nothing new and waited for the one-day repeat. Grafana
exposes no notification-log read, so that log entry itself was not observed.

## Fix

The outside reconciler now also compares Alertmanager's current episodes with Concierge's.
When Grafana holds a newer episode, it first settles the older one from state history,
then submits the current episode through the owner's firing route. That route applies it
as a delivered firing, so the repair agent is notified.

## Acceptance scenario

- **Seed:** retained `AX41DiskFillingEarly` firing from 14:41:30Z. Grafana's history shows
  Normal at 18:22:30Z and Alerting at 18:53:30Z, and Alertmanager holds it from 18:53:30Z.
- **Action:** the reconciler pass runs.
- **Expected:** the 14:41:30Z episode resolves at 18:22:30Z, then the 18:53:30Z episode
  becomes current with one firing repair notice. A second pass answers `already_firing`.
- **Replayable offline:** yes (owner routes against a seeded ledger with recorded Grafana
  responses).
