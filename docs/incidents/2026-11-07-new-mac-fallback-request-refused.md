---
failure: A newly created Mac browser fallback session was refused despite its recorded server failure.
date: 2026-11-07
fix_commits: []
cause_status: confirmed
---

# New Mac fallback request was refused before the browser opened

## What was seen

The accepted request to measure storage on an isolated Mac browser received HTTP 403
`MAC_BROWSER_FALLBACK_REFUSED`. No browser profile opened. An earlier request sent to an
existing Mac session did open the fallback, so the two accepted request shapes behaved
differently.

## Cause

Creation of a new Mac session retains its browser need in the first input. A request to
an existing Mac session retains the need directly in the accepted input. The fallback
owner gate looked only at the direct position, so it rejected a valid new session.

## Fix

The gate reads the need from the accepted input's position according to its kind,
then keeps the existing active-run and failed-server-attempt checks.

## Acceptance scenario

- **Seed:** Admit a Mac browser fallback with a recorded failed server origin as a new
  Mac session and as a request to an existing Mac session.
- **Action:** Launch the fallback in each accepted running turn.
- **Expected:** Both requests open only their recorded origin in separate headless
  profiles. A creation with a need only at the direct position remains refused.
- **Replayable offline:** partially (the accepted-shape selector is checked locally;
  the real Mac owner admission needs the installed peer).
