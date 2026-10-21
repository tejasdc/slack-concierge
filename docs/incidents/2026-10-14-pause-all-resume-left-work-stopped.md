---
failure: After the first Pause all, Resume failed, so the paused agents stayed stopped until a corrected release was installed.
date: 2026-10-14
fix_commits: [e7ff2a0a]
cause_status: confirmed
---

# Resume failed after the first Pause all, leaving agents stopped

## What was seen

Pause all shipped at about 03:16 ET on 2026-10-14 (2829628e) and was first pressed at 12:27 PM ET,
when the agent that built it ran its acceptance check on production (action
`pause-acceptance-6337-20261014`, generation 1). The pause stopped seven running turns, its own
included; `docs/architecture/PAUSE-ALL.md` (445ff552) records that mass stop. The check's Resume then
failed and the global gate stayed on. At 12:29 an outside repair agent confirmed from the live
response that every control after the first failed when Concierge recorded it. Agents stayed stopped
until the corrected release was installed and Resume succeeded at about 12:35.

## Cause

`applyGlobalPause` in `bot/src/session-owner.ts` recorded each control with
`INSERT INTO global_pause_actions(action_id,paused,generation,session_ids_json) VALUES(?,?,?,?)` but
passed the values in a different order: `(paused?1:0, nextGeneration, clientActionId, chosen)`. The
first pause stored action ID `'1'`, `paused=1` (its generation) and the action-ID text as the
generation. That row passed `CHECK(paused IN (0,1))` only because the generation happened to be 1.
Resume wrote `paused=2` (generation 2), the check failed, and the whole transaction rolled back, so
the gate never cleared. Every later control, pause or resume, failed the same way.

## Fix

e7ff2a0a switches that insert to named bindings (`$actionId`, `$paused`, `$generation`,
`$sessionIds`), so the control's identity, pause flag and generation each land in their own column.
The same commit makes a new Pause all clear exceptions left by a selected resume, and refreshes the
Mac's paused-work snapshot after it acknowledges the pause, so the sheet shows settled stops.
`docs/architecture/PAUSE-ALL.md` was updated.

Not included: 5875c78d (continuing runs whose Stop settles after Resume) was found by the building
agent before its live test, not seen on the live system. 792e2f41 fixed a separate failure (tool
completion interrupting turns with no Stop requested). The 12:27 PM mass stop had no code fix; the
rule is to test this control on a separate instance.

## Acceptance scenario

- **Seed:** A separate Concierge instance, never the live owner, with `global_pause` at generation 0
  and one running turn in an ordinary session.
- **Action:** Pause all with one action ID, then Resume all with another, then Pause all a second time.
- **Expected:** All three controls succeed. `global_pause_actions` holds the client action IDs with
  `paused` 1, 0, 1 and generations 1, 2, 3. After Resume the gate is clear and the stopped turn has one
  checked continuation queued.
- **Replayable offline:** yes (scratch instance and ledger; a stub provider turn is enough)
