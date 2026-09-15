# Cancelled audio input missing from native continuation

Investigated September 15, 2026, against the production ledger, service journal,
native Codex transcript, and source through `86593e0`. **Mechanism confirmed;
runtime correction remains open.** This report feeds the existing
[interrupted-input/fallback thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789424799857019).
It does not redesign provider fallback or treat the inbox-retry fix as resolving
this incident.

## What happened

Concierge successfully transcribed and saved the audio. A Stop requested during
preparation waited until the Codex cancellation callback became available.
Concierge then started a native turn and immediately interrupted it, before its
user message appeared in native conversation history. The next ordinary input,
`resume`, continued that same native conversation with only the new input and
the previous delivered summary. It did not restore the saved cancelled input.

The transcript was preserved in Concierge but absent from the conversation the
model resumed. This is the brief's second candidate mechanism. It was not a
partial transcription, missing audio, wrong session, or queued inbox message.

## Correct incident identity

The original [audio message](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789419900122039?thread_ts=1788453953.487149)
is **turn 941**, followed by [resume](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789419925081599?thread_ts=1788453953.487149),
**turn 942**. Both belong to Concierge session **1447**, visible root
`C0BNN5K4JSJ / 1788453953.487149`, native Codex session
`01a06829-a548-7830-9f93-31c05af8af2e`.

The later [DM at 22:20 UTC](https://tejazz.slack.com/archives/D0BMWUJ3RD5/p1789424424827159)
is **turn 966**, a permalink and screenshot of the
[earlier diagnosis](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789421697386719?thread_ts=1788453953.487149).
Its accepted envelope contains one PNG, `F0C1MJXSRK5`, and no audio attachment.
It has no recorded Stop. Its first provider attempt failed on Claude usage
credits at 22:20:31–32. The later `@cc-medium resume` is turn 967.

The router's clarification on a Slack message timestamped 22:20:25 is **not
contemporaneous model evidence** from 22:20. Turn 966's final response was
delivered September 15 at 01:02:50 into an existing progress message. Slack
message creation timestamps cannot establish when replacement text was written.
Neither bare DM input proves that an audio component was dropped from that DM.

## Original sequence, September 14 UTC

| Time | Direct evidence |
| --- | --- |
| 21:05:00.122039 | Slack audio message posted; `session_turn_queued` follows at .756. Turn 941 has empty original Slack text and file `F0C1TAC8SBC`, an `audio/mp4` clip of 1,187,982 bytes. |
| 21:05:02.652 | `slack_file_download_started`. |
| 21:05:03.275 | `slack_file_downloaded`. |
| 21:05:03, second precision | `turns.stop_requested_at`; ordering relative to the download's fractional second is not recorded by this field. |
| 21:05:15.077 | `agent_turn_attachments_ready`, `audio_transcript_count: 1`. Preparation persists replay text before emitting this log. |
| 21:05:15.354 | Codex `task_started`, native turn `01a0a1bd-0823-7513-bfcf-2073d47c1408`. |
| 21:05:15.471–.475 | Native interruption marker and `turn_aborted`, reason `interrupted`, duration 121 ms. No user-message record exists for this turn. |
| 21:05:16.052 | Concierge `agent_turn_cancelled`; turn 941 becomes `cancelled`. |
| 21:05:25.081599 | User sends `resume`; Concierge creates turn 942 in the same session. |
| 21:05:26.907–.908 | Native user-message records contain the routing envelope plus `resume`, client ID `slack-concierge:turn:942:attempt:1`. They contain no recovered transcript. |
| 21:05:47.634 | Agent answers from the older router-search task, contrary to the missing voice instruction to research existing tools and avoid custom implementation. |

The Stop did arrive during transcription. That does **not** explain away the
failure: transcription subsequently completed and its full text was saved
before the cancellation reached Codex. The defect is the gap between saved
input, native input acceptance, and later continuation—not a requirement that
the user wait longer before pressing Stop.

## Evidence and source mechanism

- Read-only SQLite source: `/root/.local/state/concierge/state.db`, tables
  `turns`, `sessions`, `slack_user_input_claims`, `router_search_documents`.
  Turn 941 retains 4,733 characters of canonical `replay_text`, including the
  complete locally generated `whisper.cpp` transcript. SHA-256 of its UTF-8
  replay text: `110b6a5c53db7979a2045537844c3ad2474712e05c345ee3a4c83d89162851f2`.
- Native source:
  `/root/.codex/sessions/2026/09/03/rollout-2026-09-03T18-45-54-01a06829-a548-7830-9f93-31c05af8af2e.jsonl`.
  Lines **3278–3282** are all five records for the original turn: task start,
  turn context, interruption marker, abort event, and application context.
  There is no user message. Lines **3283–3294** contain the subsequent resume.
  The original Slack timestamp first reappears at line **3482**, 21:16:19,
  in a diagnostic tool result, not an original user input. A full-file search
  found eleven occurrences, all at or after that later recovery.
- Service source: `journalctl -u concierge-bot.service` for
  `2026-09-14 21:04:55 UTC` through `21:06:00 UTC`, and
  `22:15:00 UTC` through `22:28:00 UTC`. These independently establish
  preparation, cancellation, the exact Slack identities, and later quota errors.
- [Input preparation](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/provider-input.ts#L40)
  awaits transcription and constructs the complete prompt.
  [Replay persistence](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/turn-execution.ts#L1128)
  precedes provider dispatch and the attachments-ready log.
- [Cancellation controller](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/turn-dispatch-seams.ts#L32)
  remembers the pending Stop and invokes it as soon as the provider callback
  registers. [Execution](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/turn-execution.ts#L470)
  connects that controller and also checks durable Stop intent.
- [Codex shared adapter](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/codex.ts#L1229)
  accepts the `turn/start` ID and then exposes `turn/interrupt`; it does not
  require acknowledgement of the initial `userMessage` before exposing Stop.
  Its initial input and steering receipt handling are different boundaries.
  The [official App Server contract](https://learn.chatgpt.com/docs/app-server)
  distinguishes turn lifecycle and item events; its `turn/start` example returns
  an initially empty items array. The incident record, not the documentation,
  establishes the observed loss here.
- [Native resume and new input](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/codex.ts#L1218)
  reuse the bound provider UUID. They do not load the prior cancelled turn's
  replay text. [Thread summaries](https://github.com/tejasdc/slack-concierge/blob/86593e0/bot/src/thread-summary.ts#L17)
  supply the latest delivered outcome; cancelled work has no delivered outcome.

The relevant Codex adapter, preparation, cancellation-controller, and summary
files are byte-identical between historical release source `59c26ed` and audited
source `86593e0`. The release manifest `0e4bd812…/manifest.json` identifies
`59c26ed`. Source inspection used targeted text searches and bounded reads;
this session had no callable LSP tool. The native transcript was parsed across
the whole file, rather than inferred from a summary or search ranking.

## Corrections to earlier explanations

`user_text` is the original Slack text; audio-only input starts empty regardless
of outcome. Successfully completed audio turns 943 and 946 are also empty.
Cancellation does not clear that column. Turn 941's replay text survived.

The router index has zero fragments for turn 941 because its corpus excludes
audio transcripts and requires nonempty original text for an input fragment.
That is a separate, documented retrieval limitation. Ordinary native resume
does not consult that index. Replacing empty `user_text` in a summary or index
would not by itself restore this absent native user message.

The original incident predates both the fallback work and inbox-retry commit
`0c936676`. That commit concerns retry progress ownership and completed-response
delivery; it does not change this Codex cancellation/continuation boundary.

## Handoff: preserve input across every terminal path

The existing interrupted-input owner must cover user Stop, quota termination,
crash, and restart. Ending execution must not silently remove the accepted
request from future continuity. Saved input, native input acceptance, execution,
and completed response delivery need distinct evidence. Resume must recover
missing input or visibly identify the gap, without automatically executing a
request merely because the user stopped it, or replaying already executed work.

A `user_text` fallback is insufficient. Delaying Stop until an input receipt
would address this ordering but changes Stop responsiveness and does not prove
crash/restart behavior. Blind replay risks duplicate effects. This diagnosis
does not select one of those partial changes as a complete fix; correction
belongs to the already requested interruption contract.

The concrete regression is now available: audio-only input, Stop during
preparation, transcript saved, native interruption before initial user-message
receipt, then ordinary `resume`. Acceptance must join the saved transcript,
native input/history, cancelled execution, and the next Slack outcome. Add the
matching already-acknowledged case to reject duplicate replay. Use the claimed
Slack sandbox, not production reproduction traffic.

This investigation changed documentation only. It sent no production test
input, repaired no incident rows, and restarted no provider or service.
