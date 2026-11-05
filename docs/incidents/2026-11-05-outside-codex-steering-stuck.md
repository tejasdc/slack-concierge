---
failure: A message to a working independent Codex agent was accepted as steering without a receiver and stayed stuck after the run ended.
date: 2026-11-05
fix_commits: []
cause_status: confirmed
---

# Outside Codex follow-up was labeled Queued but had no receiver

## What was seen

Tejas's Mac bug report at 2026-11-05 10:26 UTC attached a screenshot of session
`concierge:8691`, an outside Codex repair session. His 10:23 UTC message appeared
as `Queued` while its run was active. He had not chosen the Queue checkbox.

The accepting owner retained that human input under
`949619f6-0126-4d0f-bd20-30901b4382ce` with `delivery:steer`, bound it to
running turn `22350`, and created steering attempt `10011`. That attempt had
no `provider_sent_at`; after the 10:26 UTC Concierge deployment restart it was
marked failed with the explicit observation that it was never delivered. At
investigation time the accepted input still pointed to that failed steering
attempt and had no queued successor. An earlier service return on the same run
was separately recovered to a queued turn; that did not recover the human input.

## Cause

An outside repair run uses `codex exec --json` in an independent systemd unit.
The command reads its initial prompt once. Its adapter offers no live steering
sender; the separate unit survives a Concierge restart and still supports Stop.
The session view nevertheless
advertised `steer:true`, so the owner attached new messages to a controller
with no sender. A restart could prove they were unsent, but the outside run
never registered a sender to trigger the ordinary waiting-input recovery.

## Fix

The session view now refuses live steering for outside Codex runs. New messages
enter that session's FIFO behind the active turn and carry a reason explaining
the next-turn wait. At startup, on adoption and at run start, the owner recovers
any prior provably unsent human steering attempt under its original accepted-input
identity. Startup scans for his messages even when the command already ended,
as the reported run did before this repair shipped.
Outside runs skip the live waiting-input release, so recovery cannot withdraw
those messages for another impossible steering attempt. A sent or ambiguous
attempt remains untouched. Older service notices and agent requests are retained
for their own obligation audit: 46 service and 18 agent attempts existed at the
time of this repair, many already obsolete or settled, so startup does not replay
them. The run closes only its steering controller at admission, preserving Stop,
and the dispatch guard also rejects an outside target for old clients or service
notices. Both the live receipt and the prepared presentation receipt check the
actual older active turn for the next-turn explanation.

The session ledger is the single writer for input order. The accepted input ID
survives a failed live attempt and its transfer to FIFO; that transfer is atomic.
The execution host owns the active outside command, and the claim gate excludes
another running or delivering turn in that session. Codex's recorded native
conversation ID, not a title or directory, selects the later `exec resume`.
The visible receipt distinguishes an input retained for a later turn from one
received by the current provider turn. A restart alone never proves a message
unsent; recovery requires the failed steering row with no provider-send evidence.

## Acceptance scenario

- **Seed:** An outside Codex run is active, with one ordinary human follow-up; also retain a failed, provably unsent human steering attempt from an already finished outside run.
- **Action:** Admit the new follow-up, then restart Concierge and let the active run finish.
- **Expected:** The first input enters that session's FIFO without a steering attempt and says why it waits. The old input enters FIFO under its original ID. Stop still reaches the active outside run. Each later turn uses the recorded Codex conversation ID without overlap; managed Codex and Claude Code still steer live.
- **Replayable offline:** no (the independent systemd unit, real owner restart and visible receipt must be observed on the installed system).
