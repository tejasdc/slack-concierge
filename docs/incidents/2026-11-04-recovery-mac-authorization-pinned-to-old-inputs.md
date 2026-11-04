---
failure: The live-writing recovery agent was refused exact-app Computer Use because the policy recognized only older human inputs.
date: 2026-11-04
fix_commits: []
cause_status: confirmed
---

# Exact-app recovery lost current human authorization

## What was seen

Tejas asked to preserve unsaved writing on his actual Mac in capture
`capture:5b6622afea9fe89950abaf423874a4b1e48a0c92420527f40a9570643d5ece8b`.
Mac session `mac:274` attempted a direct selection of the already-open
thnkr.ing Safari web app under work requests `be2f82e2-aee6-4c3e-8d07-1cd95c398fb3`
and `aa8bd39a-8ba7-47f8-8a36-3761b464a001`. Both attempts were blocked by
the PreToolUse policy before Computer Use ran. The peer requests retained the
current human capture as their origin, but the hook recognized only two
previous human input IDs. The first request named the full old page ID;
the second abbreviated it and therefore also needs a corrected exact-page
request before admission.

## Cause

The policy pinned two old human input IDs even though the Mac owner retained
the current capture's human provenance and work effect.

## Fix

The repair makes the Mac owner return the retained human input and work effect
with the recorded Mac-app need. The hook permits the exact app selection only
when both IDs occur in that need and the owner proves human work provenance.
Subsequent passive reads select the app again in the same program. Generic
Safari, Chrome, another app, whole-screen calls, Inspector, clicks and reload
remain refused for the recovery request. The earlier Inspector grant remains
limited to its original human input.

## Acceptance scenario

- **Seed:** Retain the current human recovery capture and a work request to
  the Mac with the exact bundle and full old page ID.
- **Action:** The Mac agent selects that bundle directly and reads its state
  in a fresh same-program selection.
- **Expected:** Those passive calls pass. An informational request, missing
  page, different app and state-changing call fail.

The offline policy check covers this boundary. Installed Mac policy admission
and live page inspection are separate checks; the recovery agent owns the
latter and any draft custody.
