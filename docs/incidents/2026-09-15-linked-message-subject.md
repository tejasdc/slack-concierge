# Linked message rendered as thread context

## Finding

The shared resolver hid the subject of a Slack permalink. It parsed the exact
message timestamp but presented every supported link as **Linked Slack thread**,
emitted only the parent timestamp in successful context, and instructed the
provider to use linked-thread context. Both provider families used this path.
Exposure was shared; the evidence does **not** establish that every agent made
the same mistake.

One specific wrong-subject answer is confirmed. No second instance of an agent
substituting a newer message for an explicitly linked older subject was confirmed
in the inspected records. This is a bounded retrospective, not a claim that no
other occurrence exists.

## Exact incident and original requirement

- [Original link input](https://tejazz.slack.com/archives/D0BMWUJ3RD5/p1789453205160159),
  turn 1112, Claude session `63cbc007-308c-4bfa-a8c8-55996cedb9b1`.
- [Selected message](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789452891936389?thread_ts=1789432448.682319):
  `cant_update_message` while projecting turn 1107's root summary.
- The canonical prepared input contains 35 numbered messages. The selected
  message is row 33. Row 34 asks about old laptop transcripts; row 35 is progress.
  The answer instead begins: “Your laptop transcripts aren't dropped — they're
  91% of the search index.” The exact symptom is substitution of a later substantive
  message; the literal last row was a progress placeholder.
- [Correction](https://tejazz.slack.com/archives/D0BMWUJ3RD5/p1789453693419489),
  turn 1116: Tejas supplied the error again and challenged the wrong answer.
  The router acknowledged that it had the selected message and anchored on a
  more recent message instead. Its separate admission of another wrong anchor
  concerned stale thread status, not another demonstrated permalink misreading.
- [Semantic requirement](https://tejazz.slack.com/archives/D0BMWUJ3RD5/p1789453915203369),
  turn 1121: “if I’m sharing a particular link to your message, you read that
  particular message.” Surrounding context remains welcome. The task handoff is
  [turn 1122](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789453992466849).

The four exact original `user_text` and prepared `replay_text` records were
recovered separately for review. Their input claims contain no attachments.
The reported consumer workaround `3256306` is context from the handoff; this
resolver fix does not depend on that consumer rule.

## Audit coverage and limits

Read-only inspection covered the production SQLite ledger plus both hosts'
preserved transcripts under `/root/transcript-archive/` and live Claude/Codex
session directories. The cutoff is the task's input timestamp,
`1789453992.466849`; this task and later derivative discussion are excluded.

The ledger contains 23 earlier turns with the old rendered label (16 Codex,
seven Claude, across six Slack conversations) and five steering inputs. A search
for the exact resolver instruction found 110 transcript files, including copied
archives, implementation/tool-output mentions and repeated provider attempts.
Filtering actual user-role prepared inputs and joining exact input identities
removed those duplicates. Two additional August 8 turns, 155 and 156, retain
their prepared context only in provider transcripts. Total inspected inputs:
**25 turns and five steering messages**, August 8–September 15, 2026.

| Input identity | Assessment relevant to this defect |
| --- | --- |
| Turn 155 | Provider error; no substantive answer to classify. |
| Turn 156 | Root link with “looks like we broke something”; answered the thread's runtime error. Thread-level intent is ambiguous, so this is not proof of ignoring a specifically requested older subject. |
| Turn 289 | Correctly investigated the linked older manifest upload despite newer messages. |
| Turn 319 | Addressed the linked TODO synchronization report; target was also the final supplied row. |
| Turn 320 | Explicit duplicate-message report answered; link to root supplied surrounding evidence. |
| Turn 369 | Explicit question about a thread's busy error answered; using that later error was requested. |
| Turn 466 | Addressed preservation of the original root request, as explicitly requested. |
| Turn 522 | Explicit DM cleanup handoff; no newer-message substitution demonstrated. |
| Turn 530 | Verified the selected helper-fix reply; target was the final supplied row. |
| Turn 535 | Explained the selected misplaced audit reply. Its wrong-channel posting was a different identity defect. |
| Turn 682 | Reported stale working status against the supplied completion; target was the final supplied row. |
| Turn 687 | Explicit status-projection bug handoff answered. |
| Turn 696 | Addressed the linked older progress card and explicit rollover complaint, despite newer implementation reports. |
| Turns 839, 842 | Explicit integration/host handoffs answered. |
| Turn 920 | Explicit completed-work continuity handoff acknowledged. |
| Turn 966 | Accurately distinguished the selected cancelled-audio defect from the newer architecture debate; also completed earlier interrupted work. |
| Turn 973 | Correctly used the older skill-update message for the requested experiment rather than the later performance-automation report. |
| Turns 1014, 1033, 1036, 1037 | Explicit contract/coordination inputs answered. |
| Turn 1077 | Answered the explicit provider-fallback failure report; linked progress text alone did not represent the native card. |
| Turn 1109 | The target was beyond the first 50 messages and absent from prepared context. The explicit text handoff was answered; this proves omitted target context, not wrong-subject causality. |
| Turn 1112 | Confirmed: older error ignored in favor of later transcript question. |
| Steering 14 → turn 358 | Explicit TODO source-of-truth correction reflected in final work. |
| Steering 95, 99 → turn 838 | Explicit capture-contract/host coordination reflected in final work. |
| Steering 133 → turn 880 | Explicit live capture acceptance handoff reflected in final work. |
| Steering 232 → turn 1088 | Explicit later fallback incident addressed in the final response. |

Comparing request, selected row, later rows and final response can establish a
concrete mismatch; it cannot prove what caused every internal choice. Broad
thread requests, absent target text, attachment/native-card details, unfinished
turns and explicit coordination prose limit behavioral inference. Correct cases
are counterexamples to “everyone does it,” not an estimate of a success rate.

## Message links versus thread links

[Slack's documented permalink contract](https://docs.slack.dev/reference/methods/chat.getPermalink/)
identifies a message through `/p<timestamp>`; a reply URL's `thread_ts` query
parameter points to its parent. The parameter does not convert a message link
into a request about the whole thread.

Before this fix, `parseSlackPermalink` already retained `messageTs` and `threadTs`
separately. The loss occurred during context rendering. There is no parsed
message/thread kind: all supported `/archives/.../p...` links, including root
permalinks made by `slackThreadPermalink`, went through one thread formatter.
Slack's native `/client/.../thread-...` routes are outside the existing parser.
The supported URL alone cannot distinguish “this root message” from a user's
intent to discuss its entire thread. Explicit user wording governs that choice;
the resolver must not infer it from `thread_ts`.

## Resolution and verification

The shared resolver now labels the reference **Linked Slack message**, emits
`linked_message_ts` beside `parent_thread_ts`, marks its exact row, and tells both
providers to read that subject first. Thread context remains. The target's text
is complete, while surrounding messages retain their existing bounds. If the
target falls outside those bounds, one timestamp-bounded Slack read retrieves it;
if unavailable, the context explicitly says so without substituting another row.

Focused tests cover older targets, full target text, root links with/without
`thread_ts`, reply parent resolution, targets beyond the context limit, missing
targets, access failures, multiple links in one thread, and queued input. The
`linked-message` sandbox case asks both real providers about an older error
message beyond the first 50-message context page, with a newer unrelated report
present in the thread and its cumulative summary, checking canonical replay,
durable ownership, Slack response text and browser evidence. The case is
documented in the [sandbox runbook](../runbooks/SANDBOX-TESTING.md).

Rollout follows `origin/main` through the detached deployment owner. Sandbox
acceptance is not production activation proof; this task does not monitor or
invoke deployment. Current behavior is owned by the
[Slack input architecture](../architecture/SLACK-INPUT.md#slack-links-attachments-and-audio).
