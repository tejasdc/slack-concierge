---
failure: A no-reply Concierge upkeep turn could not finish quietly because the thread answer guard demanded a post.
date: 2026-11-06
fix_commits: []
cause_status: confirmed
---

# No-reply upkeep was forced to post

## What was seen

An Inbox recovery sweep admitted a service input that explicitly said no reply was needed. Its attempt to declare `done` with a quiet reason was refused until it posted into the request's thread. The refusal was reproduced on the installed owner with one exact upkeep input; no historical human request was replayed or closed by this investigation.

## Cause

The thread answer guard treated every nonhuman input linked to a thread as an answer owed to Tejas. The upkeep admission did not retain that it was reconciliation work with no thread reply due.

## Fix

The upkeep sweep marks its service input as requiring no thread reply. Owner admission retains that mark only for service inputs. The same thread obligation check that guards outcome declarations and relays now honors it; ordinary agent requests and service returns remain subject to the original rule.

## Acceptance scenario

- **Seed:** An open human request has a service upkeep input linked to its thread, plus an ordinary agent return linked to a thread.
- **Action:** After reconciliation, the upkeep turn declares `done` without posting. The ordinary return also tries to declare `done` without posting.
- **Expected:** The upkeep declaration is accepted without a new thread post or owner relay. The ordinary return is refused until it posts its answer. The human request remains governed by its own checked closure evidence.
- **Replayable offline:** no (agent-run ledger tests are disabled by Tejas; use the installed marked service entrance when the next upkeep input is admitted).
