# Preserve the Slack root request beneath its cumulative TL;DR

Status: implemented for new Agent-mode root projections; not a historical repair plan

This change corrects the root-replacement behavior with the smallest existing
mechanism. Concierge still updates the exact Slack root after a successful final
delivery, but the desired text is now:

```text
Concierge TL;DR: <validated cumulative summary>

<original root request>
```

## Contract

1. The cumulative TL;DR stays at the top of the root.
2. The original request stays below it when the combined message fits Slack's
   4,000-character `text` limit.
3. When it does not fit, Concierge preserves the full TL;DR and truncates only
   the tail of the original request, ending it with `… [truncated]`.
4. If there is no stored top-level root request, no valid provider TL;DR, or the
   TL;DR leaves no room for request text plus the truncation marker, Concierge
   leaves the existing root unchanged.
5. The existing durable root-summary projection remains the only writer and
   retry owner. Recovery renders the same summary-plus-request shape.
6. Linked Slack threads are reference material. They do not become part of the
   current visible thread or its cumulative TL;DR unless the user explicitly
   asks to continue or combine that work.
7. Agent-mode continuity receives only the latest already-cumulative summary,
   preventing superseded or contaminated older summaries from being replayed.

The immutable top-level first turn already stored by Concierge is the source of
the original root request. No new schema, block renderer, worker, scheduler, or
API call is required.

## Length behavior

| Input | Root projection |
| --- | --- |
| Summary plus request is at most 4,000 characters | Preserve both in full. |
| Combined text exceeds 4,000 characters | Preserve the summary and the longest request prefix that fits, then append the truncation marker. |
| No stored top-level root request | Leave the root unchanged. |
| Missing, oversized, or effectively full-length summary | Leave the root unchanged. |

The limit is enforced conservatively with JavaScript string length. This can
truncate Unicode text slightly earlier than Slack requires, but never risks
dropping the summary or submitting an oversized root update.

## Scope

This applies when new Agent turns complete, including recovery of an interrupted
new projection. It does not scan for or repair roots changed by older versions.
Those messages remain untouched. If Concierge's first accepted input in a Slack
thread is a reply rather than the root, it also leaves the unrelated root
unchanged because the original root request is not in durable turn state.

## Acceptance criteria

- A focused formatter test proves the original request appears beneath the
  summary.
- A focused formatter test proves the output is exactly 4,000 characters and
  only the request is truncated.
- Turn execution and recovery tests prove both paths render the same root.
- A linked-thread prompt test proves reference material is excluded from the
  current cumulative TL;DR by default.
- An Agent summary-continuity test proves only the latest cumulative summary is
  supplied to the next turn.
- The full Bun test gate passes.

## Non-goals

- No repair or mutation of historical roots.
- No Rich Text block preservation system.
- No extra root message, reply, Canvas, file, or external store.
- No new durable state, retry path, background work, or generalized Slack
  document editor.
- No change to progress task cards, streaming, provider execution, or final
  response delivery.
