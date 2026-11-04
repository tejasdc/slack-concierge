---
failure: Filing notice claimed waiting messages had failed
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Filing notice claimed waiting messages had failed

## What was seen

Tejas's November 4 report `38a516a7d3fe96de439228380ce5eb1c00dd5f25056d869a52e1f04c0dc0528a` showed three Inbox messages labelled “Never filed”. They were retained in an active turn and later placed into their threads.

## Cause

An older web repair had made age over ten minutes trigger the failure label, without reading the owner turn state.

## Fix

The owner now prepares a filing state with each unfiled message and updates it when the Inbox turn changes. Queued and running turns remain waiting; an ended turn without placement is a filing failure; a placed root identifies its thread. The browser reads that state instead of applying an age cutoff.

## Acceptance scenario

**Seed:** A marked capture older than ten minutes in the Inbox queue.

**Action:** Read the prepared Threads and Incoming projections, admit the capture to a running turn, end that turn without placement, then place the capture in a topic.

**Expected:** Both projections report waiting while queued and running, failed only after the turn ends without placement, then name the topic without a failure notice after placement.
