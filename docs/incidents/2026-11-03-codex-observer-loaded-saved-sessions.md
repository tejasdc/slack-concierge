---
failure: The shared Codex App Server loaded hundreds of saved conversations after an account switch and its memory rose toward the host's limit.
date: 2026-11-03
fix_commits: []
cause_status: best-explanation
---

# Saved Codex conversations filled the shared App Server

## What was seen

At 02:58 ET, Concierge switched the in-use Codex account because the prior account was spent. The managed App Server restarted. Its resident memory rose from 5.0 GB at 213 seconds to about 12 GB within ten minutes; it then settled near 8.7–9 GB, while the host retained roughly 24–27 GB available. No OOM kill appeared in the kernel log. The observer logged 748 saved-conversation subscriptions after the restart, and a read-only App Server query found 744 conversations loaded. The history database held about 2.44 GB of saved item JSON.

## Cause

The account switch is the confirmed restart trigger. Concierge's native observer resumed every uniquely bound saved Codex conversation on connection, even though most had no running work. Codex keeps a subscribed conversation loaded. The subscription count, loaded count, and memory trajectory make this the best explanation for the growth; no per-allocation heap profile was captured. Repeated WebSocket 403 messages predated this restart, and the daemon had 2,590 open files against a 1,048,576-file limit, so file-descriptor exhaustion did not explain this incident.

## Fix

The native observer now has its own App Server connection. On connection it reads only conversations already loaded, subscribes to those with running work, and releases a subscription after the turn becomes idle. Codex broadcasts status changes to every connection, so an externally started turn can reattach observation without scanning all saved history. Read and unsubscribe errors do not hold other conversations' lifecycle notifications. Normal Concierge deployment closes the old observer connection; no manual App Server restart or interruption of running agents is needed.

## Acceptance scenario

- **Seed:** Keep hundreds of bound saved Codex conversations, most idle, with at least one active turn in the managed shared App Server.
- **Action:** Switch the in-use Codex account through Concierge's managed path, then let the ordinary Concierge release reconnect its observer.
- **Expected:** The active turn continues and its terminal result is observed; idle saved conversations are not resumed by Concierge, their loaded count falls after Codex's unload grace, and App Server memory remains flat well below host capacity for 30 minutes.
- **Replayable offline:** no (the acceptance includes the managed daemon, account switch, active turn, and host memory over time).
