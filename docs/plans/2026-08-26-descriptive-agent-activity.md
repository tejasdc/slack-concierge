# Descriptive native activity cards

Approved scope: finish richer activity labels and a native expandable activity
preview, preserving text-separated cards, same-message updates, payload-limit
continuations, planning updates, and turn-owned Stop. Additional approved requirements:
consumed steering starts a fresh reply below the user's guidance; the expandable
plan is always last in the active reply and contains every step. Do not change commentary or
final-answer streaming in this change; the user asked only for an explanation of
that behavior.

The existing provider adapters produce progress events; `AgentProgressController`
owns the current card and a bounded recent-activity preview. Codex's structured
`commandActions` distinguish reading, listing, and searching without parsing shell
commands or exposing command arguments, search queries, tool results, or reasoning.
Native task-card `details` supply the disclosure UI; no custom interaction handler,
service, database schema, or background work is needed. The plan
card includes its step snapshot in the same native details field.

Keep only the latest ten operation summaries per text interval, at most 400
characters each, as a preview rather than an execution log. Provider events update
the existing operation entry; visible commentary begins a new interval. Already
projected details remain in the existing durable message snapshot. Pending writes,
retry identity, continuation, and Stop ownership remain with their current owners.
No idle work is added.

Provider-confirmed steering emits one internal boundary in the existing progress
event path. Coalescing stops at that boundary; the page owner freezes the previous
message and creates a normal continuation carrying the plan. The internal marker
is persisted with the page snapshot for repeat protection and survives payload
repartitioning, but is not a Slack block. Existing turn/session and Stop ownership
do not change. Provider adapters and the controller deduplicate within the live
turn; memory grows only with actual steering and superseded in-flight operations,
and is discarded with the controller. There is no scan over retained turns.

Acceptance: provider fixtures classify read/search/list, web and other native
activities; unknown commands remain honestly generic. Controller tests prove
bounded, redacted, same-card details, commentary separation, terminal fencing, and
multi-turn isolation. Pagination tests prove plan/detail retention and bottom
placement, and durable projection tests prove a single new reply at each consumed
steering boundary, followed by updates only to that reply. Provider tests cover
acknowledgement/event ordering and repeated boundary events. Run existing Stop,
recovery, and provider tests plus the full suite after the complete change. A bounded
Slack API probe can prove native payload acceptance, but not a human client's
expander interaction or actual Stop click. One independent review covers the full
diff and test evidence before push.

Host timezone is a separate native setting owned operationally by `remote-box`:
`timedatectl set-timezone America/New_York` was applied with the user's explicit
approval. Local-calendar jobs intentionally follow New York; UTC schedules and
interval-based cadence remain unchanged. No global agent instructions or custom
timezone injection are added. Verify the native environment on a fresh turn.
