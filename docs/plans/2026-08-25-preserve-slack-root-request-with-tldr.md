# Preserve the Slack root request beneath its cumulative TL;DR

Status: proposed implementation plan after the 2026-08-25 user correction

This plan supersedes the root-replacement decision in
[`2026-08-24-slack-agent-attention-and-progress.md`](../brainstorms/2026-08-24-slack-agent-attention-and-progress.md).
It does not describe current behavior: Concierge currently replaces the entire
human-authored root after a successful final delivery.

## Operating profile and evidence

Slack Concierge is a personal, single-operator service. The required visible
root is one message with two independently owned regions:

1. a Concierge-owned cumulative summary at the top; and
2. the original user-authored request below it.

The current implementation does not preserve that boundary. It extracts the
provider's cumulative first-line `TL;DR`, stores only
`Concierge TL;DR: <summary>` as root projection intent, and calls `chat.update`
with `text`. Slack consequently removes the root's prior Rich Text blocks and
renders only the summary.

Production evidence on 2026-08-25:

- the reported root now contains 219 characters and one `rich_text` block;
- Concierge still has the exact 733-character original request in its durable
  turn row, and Slack retained the root's attached file;
- only three root-summary projections have been delivered since the feature was
  enabled; all three have recoverable original turn text of 20, 1,021, and 733
  characters, with no Slack mrkdwn control tokens; and
- an existing untouched 4,797-character user root is represented by Slack as
  one `rich_text` block whose structured JSON is 4,967 characters.

Slack's current contract supports the required shape:

- [`chat.update`](https://docs.slack.dev/reference/methods/chat.update/) limits
  `text` to 4,000 characters, limits mutually exclusive `markdown_text` to
  12,000 characters, renders supplied `blocks`, and retains omitted
  attachments;
- [end-user messages use `rich_text` blocks](https://docs.slack.dev/reference/block-kit/blocks/rich-text-block/);
  and
- Slack allows [up to 50 blocks in a message](https://docs.slack.dev/reference/block-kit/blocks/).

The 4,000-character failure is therefore caused by the chosen update primitive,
not by the root request itself. Re-sending a combined summary and request through
`text`, conditionally switching to `markdown_text`, or truncating the request
would keep the design coupled to transport thresholds and is rejected.

## Contract

1. A successful root projection keeps the complete claimed root request visible
   beneath the latest cumulative `Concierge TL;DR`.
2. A later turn replaces only the prior cumulative summary. It never duplicates
   the summary or rewrites the original request from a previously projected
   root.
3. Concierge never truncates, summarizes, or omits the original request to make
   a root update fit.
4. The provider final remains the durable work product and the source of the
   cumulative summary. Root projection still begins only after final delivery is
   confirmed.
5. Any missing original representation, invalid block shape, Slack rejection,
   or ambiguous update parks only the root projection. It cannot demote the
   delivered final response, and it leaves the existing Slack root untouched.
6. Root projection retries use one persisted desired revision and exact rendered
   block payload. A restart cannot append a second summary or derive the original
   request from an already-mutated root.

The claimed top-level Slack input is the immutable request source. Editing the
old root after Concierge has accepted it is not a supported way to steer a turn
today; a follow-up reply remains the explicit steering surface.

## Design

### Preserve the original Slack representation at ingress

Extend the existing durable Slack input envelope to retain the top-level
message's original `blocks` JSON alongside `user_text`. Store it only for a
top-level input that is classified as a provider turn. It has the same lifetime
and ownership as that claimed input; it is not a second conversation history.

Validate that the captured payload contains a `rich_text` block, as Slack
documents for end-user messages. Do not reconstruct future roots from the
current Slack message after Concierge may already have edited it. If a new input
lacks a usable original block representation, persist a parked root projection
after final delivery rather than risking destructive replacement.

### Render one Rich Text document, not a longer `text` string

Build the exact desired `blocks` payload before the Slack side effect and persist
that payload with the root projection revision.

- Keep every original block and every original Rich Text element in order.
- In the first original `rich_text` block, prepend one Rich Text section whose
  visible content is `Concierge TL;DR: <cumulative summary>`, with only the label
  styled for distinction.
- Preserve the original block count by inserting an element into the first Rich
  Text block rather than adding a fifty-first top-level block.
- Remove or regenerate non-visible `block_id` values for every update because
  Slack requires block IDs to be unique per message revision.
- Keep files and attachments out of the update payload so Slack retains the
  existing root-owned artifacts.

Call `chat.update` with `blocks` and no `text` or `markdown_text`. This avoids the
4,000- and 12,000-character text fields entirely and retains the end-user Rich
Text message type, avoiding Slack's documented `block_mismatch` path.

The renderer is pure: `(original blocks, cumulative summary, revision) -> exact
blocks payload`. Every later turn renders from the same immutable original blocks
and a newer summary, so summary updates are replacement-by-construction rather
than parse-and-strip mutations.

### Keep the existing durable projection owner

The root-summary projection remains the only Slack root writer. Extend its row
to retain the exact desired block payload and keep its existing monotonic
revision, `pending`/`sending`/`delivered`/`parked` lifecycle, retry ownership,
and keyed serialization.

The worker sends only the persisted payload. Recovery resets an interrupted
`sending` claim to `pending` and retries the same revision. A newer cumulative
summary supersedes the older desired revision before another side effect, as it
does today.

### Repair the bounded set of roots already replaced

Include one bounded, dry-run-first repair command in the same implementation.
It may target only projection rows proven to have been delivered by the
replacement feature and must print the channel/thread, original length, and
summary revision before any write. Three such rows exist at plan time. Because
the old code can finish more turns before the corrected implementation is
activated, the repair uses an explicit cutover manifest rather than a hard-coded
count.

For each target, derive the request from the earliest root turn's durable
`user_text`, use the existing projected cumulative summary, and construct the
same Rich Text shape used by the new renderer. The current preflight established
that all three affected originals are plain text with no mrkdwn control tokens,
so this repair does not need a general Slack-mrkdwn-to-Rich-Text converter. Omit
file and attachment fields so the reported root's retained screenshot remains
attached.

The final dry run occurs after the old writer is quiescent. It records every
eligible row and an immutable fingerprint of its current root, durable original,
summary revision, and file count. Apply refuses any row or target-set drift from
that manifest. It also refuses a root that no longer consists solely of the
expected old `Concierge TL;DR` or whose durable original is missing. A rejected
target remains unchanged and is reported for manual resolution. After each
accepted update, read the root back and verify the visible summary and original
request are both present before marking the repair complete.

## Length and failure behavior

| Input shape | Root behavior |
| --- | --- |
| Original request at or below 4,000 characters | Rich Text block update; no `text` limit involved. |
| Original request above 4,000 characters, including the observed 4,797-character root | Same Rich Text block update; the original block is carried intact. |
| Combined Rich Text payload accepted by Slack | Show the latest summary above the complete original request. |
| Root already at a Slack-enforced aggregate payload ceiling | Slack rejects the atomic update; park the summary projection and leave the root unchanged. |
| Missing/invalid original Rich Text snapshot | Do not fall back to replacement or truncation; park the root projection. |
| Summary absent or invalid | Leave the root unchanged; the full terminal reply remains visible in the thread. |

Slack does not document an unlimited aggregate Rich Text payload. The correct
behavior at that hard platform boundary is explicit failure, not sacrificing the
request. The provider contract already requires a concise one-line summary, so
normal roots add only a small amount of content.

## Work budget

- Healthy idle: zero new timers, polls, or API calls.
- Top-level accepted input: one bounded copy of the original Slack blocks in the
  existing input record.
- Successful final delivery: one pure render, one existing durable projection,
  and one `chat.update` call.
- Persistent growth: at most one original-block snapshot per accepted top-level
  turn, bounded by Slack's accepted message payload and retained for the same
  lifetime as the input claim. Replies do not duplicate the root snapshot.
- Retirement: if Slack adds a native summary field that preserves the original
  message, remove the block snapshot and renderer after migrated projections are
  drained.

## Acceptance criteria

1. A focused renderer test proves that a summary is above the original Rich Text
   elements, the original elements are unchanged, and later revisions replace
   rather than duplicate the summary.
2. A fixture using the observed 4,797-character root succeeds without sending
   `text` or `markdown_text` and preserves all 4,797 original characters.
3. A root with files, links, mentions, lists, quotes, and code keeps the same
   structured request blocks and artifacts after projection.
4. The update payload preserves a 50-block root without creating a fifty-first
   block and uses revision-unique block IDs.
5. Missing or malformed original blocks, `block_mismatch`, `msg_too_long`, and
   ambiguous transport outcomes never trigger a replacement fallback and never
   change response-delivery state.
6. A multi-turn lifecycle test proves that the first and later cumulative
   summaries render above one unchanged original request and that a later
   heartbeat cannot overwrite the terminal root.
7. A recovery test proves that an interrupted projection retries the same exact
   rendered payload and cannot duplicate the summary.
8. The repair dry run identifies the three roots known at plan time plus only
   any later rows with the same old-feature provenance. Apply accepts exactly the
   frozen cutover manifest, and read-back proves every accepted root contains its
   expected summary, full original text, and unchanged file count.
9. The full Bun gate passes once after all focused tests and documentation
   updates are complete.

## Non-goals

- No second root message, summary reply in the channel timeline, Canvas, file,
  snippet, or external store as a substitute for the visible request.
- No truncation, conditional request summarization, or different UX at 4,000 or
  12,000 characters.
- No new scheduler, poller, reconciliation loop, workflow engine, or generalized
  Slack document editor.
- No bulk repair outside the explicit cutover manifest of roots proven to have
  been changed by this feature.
- No change to provider summary generation, final-response chunking, progress
  streaming, agent session status, or thread notification behavior.

## Verification limits before implementation

Verified:

- the current code and tests replace the root through `chat.update.text`;
- the linked root lost its request while its file and durable turn input remain;
- the exact number and recoverability of already-delivered root projections;
- the shape of a real 4,797-character Slack user root; and
- Slack's documented `text`, `markdown_text`, Rich Text, block-count,
  attachment-retention, and `block_mismatch` contracts.

Not yet verified:

- Slack's live acceptance of the exact summary-plus-original Rich Text update
  payload; and
- desktop/mobile rendering and accessibility of the inserted Rich Text section.

Implementation must therefore begin with one reversible test-message probe using
the exact production payload shape, followed by browser/client inspection, before
the code is allowed to repair existing roots or project new summaries.
