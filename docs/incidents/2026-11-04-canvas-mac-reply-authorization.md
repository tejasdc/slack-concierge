---
failure: Canvas Mac inspection was refused after Tejas replied that his Mac was unlocked.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Canvas Mac inspection lost its authorization after the unlock reply

## What was seen

On November 4, the Canvas worker received Tejas's direct `done` reply to the physical Mac unlock request. The next read-only Mac Computer Use request for the already-open thnkr.ing web app was refused before `getApp` ran. The target bundle was `com.apple.Safari.WebApp.B2D24369-268D-4CD1-9961-C6BFB0388792`; the recorded page was `faf63877-6536-4ac6-86e9-5d63e03d3369`. No page action occurred.

The retained chain is:

- Original human Canvas capture: `capture:7bad480ccf4350922acb3ac750cc0ba0b7a990f596acd92b5fe98403f6f0e7a0`.
- That capture's work dispatch to Canvas worker `concierge:8085`: request `73d303d3-1a30-45e1-8651-bc9998568bb0`, settled `decision_needed` for the physical prerequisite.
- Human reply `5c94886e-f512-4ae2-8c5f-faee824ef0a2`, addressed to that capture, forwarded as work request `556d0ec7-a169-4c93-b32e-14446907508f` to the same worker.
- Worker Mac request `02d5dde7-5750-421e-8427-21afedf71ca6` from that forwarded input, refused by the existing exact-capture guard.

## Cause

The forwarding request has a trusted human source input and no source run: the human reply did not own a provider turn. The provenance reader understood that first hop but stopped at the same edge after another agent request. The Mac peer handoff could only carry the immediate reply ID; the guard recognized the original capture ID.
After that repair was installed on both machines, the Canvas worker resumed from a release-watch
input. A fresh Mac request `8f1f1bce-f960-4635-8fef-06620d775b8f` still carried the unlock
reply ID and the hook refused the exact same-program read. The sync worker independently resumed
from a Mac-result input and its request `b5105dcf-1ac3-4863-8349-bf3284c2491b` carried a later
human Inbox reply instead of the original Computer Use authorization. The previous handoff
recognized only an immediate forwarded input, not its owner-recorded service continuations.

## Fix

The repair uses the owner-retained forward request to preserve the initiating human identity through later agent hops. For this Canvas task, the peer handoff carries the original capture as the scoped authorization only when the reply addresses the exact capture in its Inbox topic and the capture's work dispatch to that worker settled as needing the physical prerequisite. It now follows only owner-recorded release-watch and work-result inputs to that forwarded work request, verifying the source run and the record that delivered each continuation. The same traversal serves a later reply in the original sync task. The Canvas grant admits only exact-bundle selection and same-program passive accessibility or screenshot reads; it refuses other apps, generic Safari, clicks, reloads and Inspector. The original sync grant retains its separately named exact-app Inspector-opening shortcut. The page ID is a recorded need, not a Computer Use selector; the Mac agent must verify the returned page UI.

## Acceptance scenario

- **Seed:** Retain the human Canvas capture, its work dispatch to the Canvas worker settled as `decision_needed`, a human reply addressed to that capture, and the owner's forwarded work request to the same worker. Record an exact-bundle and page `mac-app` need.
- **Action:** The worker sends one fresh Mac request and its Codex agent performs direct exact-bundle `getApp`, followed only by same-program accessibility or screenshot reads.
- **Expected:** The peer request carries the original capture as the scoped authorization; the Mac hook permits those exact passive calls and refuses another app, generic Safari, click, reload, or Inspector. A reply to another capture or topic does not acquire the grant.
- **Replayable offline:** no (the final Computer Use selection requires the existing live Mac window; the source policy boundary has a focused offline check).

Evidence boundary: the live refusal proves the authorization failure. Source checks and installed policy checks can prove the repaired admission boundary; only a fresh Mac Computer Use call can prove that the running app and page are inspectable. Preserve the page during verification.
