# Compact progress in one message

## Corrected implementation contract

The initial implementation below misread the request: archived activity snapshots
were not supposed to be in Earlier progress, and a separate "Turn started … ago"
line was not the requested elapsed time. The current contract supersedes those
parts of the initial design and verification record:

- Latest provider commentary stays visible. Earlier progress contains only older
  provider commentary, in order and without summarizing; omit it when empty.
  Task/status snapshots and compaction markers remain in durable chunks, not in
  that commentary container.
- Preserve the existing active Thinking/activity card and its details. Its title
  includes whole-turn elapsed time, e.g. `Thinking · 3m 12s elapsed`. The anchor is
  still the first progress post, across steps, steering, and provider retries.
  Text-only continuation pages render Thinking from the known running-turn state
  so a long commentary cannot make the indicator or elapsed time disappear.
- Refresh on normal writes and after 30 seconds of silence through the controller's
  existing single writer. One timeout per active controller; at most two extra
  edits/minute/quiet turn, zero idle work after settlement, no new replies or state
  owner. A silent provider cannot trigger event-driven elapsed updates, and Slack
  has no documented ticking clock in task-card titles. Refreshes may collapse
  expanders, as other message edits do; no client-state guarantee is introduced.
- Terminal and old continuation pages have no running suffix; completion duration,
  native Stop, plan, separate final reply, and root summary are unchanged.

Regression acceptance: reproduce the screenshot's false history entry and separate
date block before fixing them; assert exact card/history payloads, first-post time
across steps/continuations, same-message clock updates, no concurrent writers, and
no refresh after finish/retry. Source ownership is unchanged: controller schedules,
page renderer formats, durable message projection writes. No live Slack client UI
claim follows from these tests alone.

Correction verification: the three screenshot regressions failed against the old
renderer, and a controller-to-paginator regression reproduced the missing indicator
on text-only continuations before its correction. All 76 progress tests then passed.
The final full Bun gate passed 763 tests / 3,091 assertions across 70 files (exit 0);
the 446-module production bundle built
successfully. Slack's non-posting `blocks.validate` accepted the actual corrected
four-block payload (`markdown`, `container`, activity `task_card`, plan `task_card`),
with activity title `Thinking · 3m 12s elapsed`: HTTP 200, `ok: true`. This validates
the payload, not live-client rendering or deployment.
Independent actual-diff review returned SHIP with no blockers, including the final
text-only-continuation correction. All 37 local documentation links and the
`CLAUDE.md -> AGENTS.md` symlink passed validation. Normal origin reconciliation
owns deployment after push; this implementation turn does not wait for rollout.

### Raw correction and implementation request

> Okay what is this nonsense here? What is this non-sense did you create? This is utter ridiculousness. Can you see what’s wrong with this? What’s native relative display here? I was asking this to be shown as part of the thingy why would you show this in text why does it say “thinking”? The earlier progress was only for text updates. Why is it showing “thinking” ? Tell me either

> Wait go on fucking make the changes what the fuck is wrong with you I didn’t ask for a fucking explanation here

## Initial design and verification record (superseded where corrected above)

Approved behavior: keep the latest complete provider commentary visible as multiline
Markdown. Put older commentary and completed activity snapshots into one native,
initially collapsed “Earlier progress” container. Preserve the active
Thinking/activity card and its current operation details. Show turn-wide elapsed
time after commentary/history, then current activity, with the existing plan card
last. No new reply is created just because the layout changes. Preserve existing capacity and
provider-confirmed steering continuations, native Stop, completion duration,
separate final delivery, and cumulative root summary. Suggested actions and fixing
Slack's client-side collapse-on-update behavior are out of scope.

## Contract and ownership

The existing controller orders/redacts provider events. A commentary identity
preserves the difference between fragments of one update and separate updates,
including consecutive commentary without a tool call. The existing page JSON
remains the durable history; the renderer derives the compact view without deleting
or summarizing it. No database migration, worker, polling, or new state owner.
Legacy streaming payloads strip internal commentary identity. Historical chunks
without identity keep their existing adjacent-text semantics.
Compaction markers are identified separately and remain in history, so a system
notice cannot displace the latest provider-authored commentary from view. That
internal flag is also stripped from legacy Slack streaming payloads.

Rendering is linear in the current bounded page, not the entire session. The
existing page text budget includes hidden commentary and archived activity text;
current activity/plan snapshots remain separate, non-accumulating fields. The
existing logical block-count bound remains in force even though historical blocks
are visually grouped. Idle work is unchanged (none); updates still use the existing
single-writer/coalescing path. Earlier pages remain frozen at continuation.

History uses one rich-text child of a collapsible container, preserving the original
redacted multiline text and Markdown source rather than inventing a summary.
Latest commentary remains native Markdown. Container titles are short labels, not
commentary previews. No promise is made about preserving the client's expansion
state during edits.

The follow-up elapsed-time requirement uses Slack's native date element with
`format: "Turn started {ago}"`. The existing first progress-message timestamp is
the durable anchor across steps, commentary, steering continuations, provider
retries, and restart. It excludes queue time and starts at progress publication;
the initial unacknowledged post uses its send time. No new clock state or timer.
The existing terminal-intent flag and last-page identity suppress the relative
date on terminal and closed continuation pages. Work complete keeps its existing
provider-reported duration instead. Slack owns relative formatting and refresh;
client ticking cadence is not documented or verified here, and this is not a
seconds-resolution stopwatch.

The user corrected the routed request to remove the active indicator before any
commit or deployment. The final contract retains it alongside elapsed time; the
raw removal request below is historical and superseded by the last correction.

## Verification

Focused checks cover consecutive commentary, fragmented long commentary, history
ordering/content, activity/plan-only updates, no-text completion, duration, redaction,
steering, pagination including hidden text, terminal retry and separate turns.
Validate synthetic payloads against Slack without creating notifications. Full Bun
tests and an independent actual-diff review gate commit/push. Slack-client visual
verification is unavailable in this environment and must not be claimed from the
validator. Deployment follows the normal origin reconciler, without waiting here.

Final verification: all 99 focused tests / 501 assertions passed across
`agent-progress`, `agent-progress-messages`, `turn-execution`, and `turn-recovery`.
The actual five-block running renderer (`markdown`, history `container`, relative
date `rich_text`, activity `task_card`, plan `task_card`) passed Slack
`blocks.validate` with HTTP 200 and `ok: true`, without posting a message. A
45-section history payload passed separately. The production Bun bundle and all
37 local documentation links passed; `CLAUDE.md` remains the canonical symlink.

The full suite ran twice during implementation. Its second run passed 707 tests;
two recovery UI expectations were outdated during the temporary indicator-removal
iteration. Both were corrected and passed in the final focused run. No third full
run was performed. Independent review caught a compaction marker displacing the
latest commentary; a source distinction and controller-to-renderer regression
test corrected it. Re-review returned SHIP, followed by a final SHIP for the
user's correction retaining the active indicator. No live UI/refresh-cadence or
deployment claim is made from these checks.

## Raw final design direction

> No i mean let’s keep the text outside of the commentary then if there is a limitation on the title because we just established every update is going to collapse the drop-down menu i cannot rely on the drop down menu to being open to read the commentary so let’s give the text commentary out So I have the earlier progress inside one of the drop down menu

> ok implement are you waiting for something?

> Follow-up on the progress indicator, from my Pebble capture 2026-08-26.
>
> Elapsed time is missing while a turn is running. Right now the duration only appears at the end, once the turn completes. While it is working I have no idea how long it has been going.
>
> Two things:
>
> • Show elapsed time for the *entire turn*, not for the current thinking step. The number I care about is how long this turn has been running, not how long the current step has been.
> • The active thinking indicator should go away.
>
> Same surface you are already rewriting here, so folding it in rather than opening anything separate.

> Wait sorry the agent gave you wrong instructions the active thinking in a career should not go away the active thinker is really important please do not remove that

Sources: https://docs.slack.dev/reference/block-kit/blocks/container-block.md,
https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/,
https://docs.slack.dev/reference/block-kit/block-elements/date-element/,
https://docs.slack.dev/reference/methods/blocks.validate/.
