---
failure: An accepted Codex report-back completed with no acknowledged input, output, or tool work, while its request remained open.
date: 2026-11-13
fix_commits: []
cause_status: best-explanation
---

# An accepted Codex report-back ended as an empty completion

## What was seen

The existing Astra conversation `concierge:3012` retained an open work request. The owner accepted a nonempty service report-back, but the owner run completed with no error and an empty result. Its exact native Codex turn was completed with `items: []`. A second empty completed turn belongs to a different expired watch input and remains separate; it is not replayed and does not invalidate proof for the selected report-back. The owner retained `xhigh` in its prompt identity while the native transcript showed Medium. The original work request had already been acknowledged and produced substantive work; it is not the recovery target.

Evidence and the exact identity map are in [the recovery evidence artifact](../runbooks/CODEX-EMPTY-REPORT-BACK-RECOVERY-EVIDENCE.md). It distinguishes the confirmed adapter and owner-contract defects from the inferred UserPromptSubmit hook cause. No production recovery, deployment, or live provider execution was performed in this change.

## Cause

Confirmed in source and the installed App Server schema: the adapter sent reasoning effort in `thread/start` and `thread/resume`, whose installed parameter schemas have no effort field, and omitted `effort` from `turn/start`, which accepts it. Confirmed in the owner path: existing direct-human and per-input escalation checks did not recognize a service continuation linked to the same open work and retained session model choice. Confirmed in the adapter path: an empty completed turn with no input acknowledgement could return as successful empty completion.

The historical UserPromptSubmit guard is a plausible reason the provider never admitted the input, but its exact decision record was not retained. The repair does not claim that cause as observed fact.

## Fix

Codex effort now travels on each native `turn/start`. A service continuation retains the current exact model only when its accepted service input links to its preceding run in the same conversation and to the same still-open work request, while the session retains the verified human model choice. Agent-authored claims and unrelated requests do not gain that authority.

An empty completed turn without input acknowledgement, assistant output, or tool activity is parked with a precise reason and the accepted input remains intact. The exact `codex-recover` entrance selects `report-back:<request-id>`, never the original acknowledged request. For this legacy completed turn, the owner proves its one attempt from the exact retained attention and empty result records, the admission stored with the accepted input, the same-attempt `xhigh` prompt identity, and the exact native turn's complete item pages. The historical admission omits the effort field; omission is accepted only when the matching prompt identity proves `xhigh`, while an explicit conflicting value refuses. An unrelated earlier empty native turn is mapped to its own accepted watch input. Current binding, send controls, open request, execution host, side effects, later admission and work authority are checked before the durable target reservation. A retry after a lost response, including a different action ID, returns that reservation before inspecting the now-queued turn. The reservation clears the prior turn's delivery envelope so restart reconciliation cannot mistake the old empty result for the new attempt; the immutable historical result event remains. Each later native attempt receives a distinct result identity and can reach existing readers.

## Acceptance scenario

- **Seed:** scratch ledger with a nonempty accepted service report-back, its retained admission and binding generation, historical attempt 1 with the exact provider turn ID, immutable empty result and original native delivery envelope, exact xhigh prompt identity, and the original acknowledged work request preserved.
- **Action:** run the deterministic adapter and state fixtures; for recovery, prove the exact native transcript and reserve the original report-back.
- **Expected:** requested effort appears only on `turn/start`; an unacknowledged empty completion is parked with the precise recovery reason; exact selected attempts must be mapped and empty; a separate watch turn does not get attributed to the report-back; an acknowledgement, nonterminal attempt, incomplete item page, changed binding, later admission or unsupported authority refuses. Recovery preserves the historical result and records a later result under a distinct identity. Repeated actions return the same reservation.
- **Replayable offline:** yes, through the focused fixtures named in the evidence artifact.
