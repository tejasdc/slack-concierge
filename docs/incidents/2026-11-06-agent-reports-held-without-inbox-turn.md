---
failure: Accepted agent reports stayed held without starting an Inbox router turn.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# Agent reports stayed held without an Inbox turn

## What was seen

On November 6, three agent reports were accepted for Inbox session 8954. Their retained
captures were `c8865a29…`, `7f90da97…`, and `5ecfb2f0…`. The first two had open
requests without a router turn by 23:05 UTC and were manually routed at 23:08.
The third still had `INPUT_HELD` at 23:09:48 UTC. These are distinct reports;
none is replayed or closed by this repair.

## Cause

At intake, a local agent report records its exact source input and run. The
common capture recovery predicate accepted a Reader capture with that source
relationship but required every other capture to have no source relationship.
It therefore rejected locally authored agent reports before dispatch. The
periodic recovery sweep selected those rows but called the same rejecting
predicate, so waking the owner again did not repair the hold. The installed
release carried that predicate.

## Fix

The repair makes the source check accept a local agent report only when its
retained source input and run match the capture's verified agent source. Mac
reports keep the peer verification performed at intake and their null local
source relationship. Existing turn and steering checks still prevent replay;
Focus review holds still require their explicit release path.

## Acceptance scenario

- **Seed:** A server agent has an accepted source input and run; Inbox is bound and available.
- **Action:** The agent sends a new issue report with a stable action ID and retries that same report after acceptance.
- **Expected:** One retained capture and open request carry the reporter's source identity. One Inbox router turn starts automatically and links work or explicitly resolves the report. The retry returns the same capture without another turn. The three earlier captures keep their separate identities and status.
- **Replayable offline:** no (the acceptance boundary includes the installed owner and a real Inbox router turn).
