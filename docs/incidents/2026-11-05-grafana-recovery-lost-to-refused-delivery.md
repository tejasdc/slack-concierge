---
failure: A Grafana alert Grafana had already recovered stayed firing in Concierge because its recovery notification was refused and never resent.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Journal typing alert stayed firing after Grafana recovered it

## What was seen

Grafana's state history for `ThinkeringJournalTypingSlow` (rule `obs-d19c428c1958`) shows
the episode alerting at 2026-11-05T18:24:30Z and Normal at 18:31:30Z. Concierge accepted one
delivery for it (fingerprint `1ff5f8a826656f2d`, firing, revision 1, 18:31:33Z) and nothing
after, so the episode stayed firing. The receiver answered 503 to 385 of 457 Grafana
deliveries between 15:00 and 21:00 UTC that day while the owner restarted repeatedly; the
recovery was among them. Grafana retries a failed notification briefly and never resends a
recovery, so nothing would ever correct the episode.

## Cause

Confirmed: Concierge had no path besides Grafana's own notification by which a recovery
could arrive. Why each delivery was refused is a separate question (PR #582 logs the reason).

## Fix

The owner exposes its retained firing episodes and accepts a Grafana-evidenced recovery
through its local socket. Remote-box's reconciler, every 15 minutes, settles each episode
Grafana's Alertmanager no longer holds, using the Normal transition time from Grafana's
state history; ambiguous or missing history leaves the episode untouched and logged.

## Acceptance scenario

- **Seed:** a retained `ThinkeringJournalTypingSlow` episode firing since 18:24:30Z,
  revision 1; Grafana holds no alert with its fingerprint and its state history records
  Alerting at 18:24:30Z and Normal at 18:31:30Z for one instance.
- **Action:** the reconciler pass runs.
- **Expected:** the episode is resolved with end 18:31:30Z, the same fingerprint and start,
  revision 2; its repair notice is resolved once; a second pass answers `already_resolved`
  and changes nothing.
- **Replayable offline:** yes (owner routes against a seeded ledger with Grafana's
  responses recorded).
