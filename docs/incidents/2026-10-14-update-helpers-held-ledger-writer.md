---
failure: During Concierge updates, short-lived update helpers took the ledger's single write lock while Concierge was still serving, freezing it for seconds and failing its writes with "database is locked".
date: 2026-10-14
fix_commits: [54bad955, d0331ed0, 102984e1, 08b20116, 81abada2, e8fbf2b1]
cause_status: confirmed
---

# Update helpers held the ledger writer and froze the serving Concierge

## What was seen

Every Concierge update on 2026-10-13/14 froze the serving owner. Oct 13: 102 s of loop lag around one update, one
dispatch write hitting SQLite's 5 s busy timeout; a later activation lost 17 s to writer waits. Oct 14 03:16 UTC: a
5,016 ms write failed `database is locked`, loop lag 5,603 ms. 03:32 UTC: 1.95 s lag. 06:40 UTC: 11 lag events,
5,224 ms total. 06:54 UTC: 12,036 ms lag and two `database is locked` failures. 16:20 UTC: further holds after
restart. Sessions and requests on the owner stalled for those intervals. (The 22:42 UTC Oct 13 eight-second stall was
a different failure, a slow event-table scan: see [update status scan](2026-10-13-update-status-event-scan-stall.md).)

## Cause

The release controller and its helpers opened the live ledger in their own processes while the owner served, and
each took the WAL writer/checkpoint locks. Kernel lock traces (docs/architecture/LEDGER-DURABILITY.md) named each
holder: `release-manager prepare` 4.2 s (03:16); the run claim 2.55 s (03:32); after claims moved to the owner, the
same helpers' read-only connections still took the locks (claim 589 ms, `show`/`desired` 591/134 ms, last-known-good
restore 1,139 ms, a file-only `install-runtime` 658 ms via a static import, later 82 ms via reaction provenance
importing the state module) (06:40); the native continuation timer 11.57 s covering both busy timeouts, and the drain
claim 1.46 s while it scanned active work inside its transaction (06:54); `deploy-state succeed` 1,117 and 627 ms,
with synchronous Git ancestry checks inside its transaction (16:20). Host disk pressure lengthened each hold. The
holder of the first Oct 13 episode was never observed (cbb5b8cc corrected an early over-attribution).

## Fix

- 54bad955: every short-lived Linux ledger writer sets `wal_autocheckpoint=0`, leaving checkpoints to the owner's
  worker (removes a disk-heavy path; not proven to be the Oct 13 cause).
- d0331ed0: release preparation, activation intent, reaction targets and activation go through the owner's
  root-only `request-owner.sock`; the controller's connection is read-only (41351abd made the prepared row and its
  event one transaction on that path).
- 102984e1: the run claim and phase transitions use the same owner request.
- 08b20116: run/last-known-good reads and promotion also go through the owner; the ledger is lazy-loaded only for
  offline or stopped-owner commands, so serving commands open no SQLite connection.
- 81abada2: the continuation timer's enrollment and tick go to the owner socket; Git trailer scanning moved to a
  storage-neutral module; the ledger entrance refuses a serving controller command that loads it; the drain claim
  commits its admission gate before scanning active work.
- e8fbf2b1: completion, failure and preserved-checkout records go through the owner, with Git ancestry checks run
  asynchronously before the transaction.
9cc3e1d8 added slow-transaction phase timing (diagnostic only). A full real update under disk load with no
controller lock holder is still to be verified, as the doc states.

## Acceptance scenario

- **Seed:** A serving owner on a scratch ledger with a lock recorder (`/proc/locks` sampling) and a stub host disk
  slowed with an I/O throttle; a prepared candidate release.
- **Action:** Run an ordinary update end to end: run claim, prepare, activate, drain claim, continuation tick,
  restart, `deploy-state succeed`.
- **Expected:** No controller, helper or continuation process holds the WAL writer/checkpoint lock while an owner
  is serving; serving controller commands that try to open the ledger are refused; no owner write fails with
  `database is locked`; owner loop lag during the update stays under one second.
- **Replayable offline:** yes for the lock-holder and refusal checks (scratch ledger and local owner socket); the
  loop-lag bound under real disk pressure needs a real update on the server
