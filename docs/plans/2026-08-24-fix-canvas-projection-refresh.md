# Fix Canvas projection refresh

## Goal

Make every current channel `AGENTS.md` render successfully into its Slack Canvas, make future Slack parser rejections diagnosable, and ensure ordinary post-turn Canvas maintenance cannot delay the next agent turn.

The operating profile is one personal Slack workspace with 58 currently visible project channels. Canvas is rebuildable, best-effort projection state; canonical project instructions, provider responses, terminal Slack state, and artifact deliveries are durable. This change adds no service, credential, database, or public boundary.

## Observed failure

The live fleet refresh currently rejects 15 documents. Disposable Canvas canaries isolated three Slack parser incompatibilities:

- repository-relative Markdown links report `Unsupported target for link`;
- a blockquote nested inside a list item reports `Unsupported block type (BlockQuote) within list item`;
- a bulleted list nested inside a numbered list reports `Unsupported list type (bullet) within numbered list`.

The proposed projection forms were accepted for all 15 rejected documents and for one previously successful affected control. The source files and live channel Canvases were not changed by those canaries.

Ordinary startup and the six-hour refresh already run asynchronously in the main Bun process and use a dedicated Canvas rate-limit lane. Post-turn refresh is different: it releases the durable provider session, but then awaits Canvas I/O before process-local execution ownership settles, which can delay an already queued same-session turn.

## Acceptance criteria

- [ ] Canonical `AGENTS.md` bytes, resolution rules, and path-plus-raw-content fingerprints remain unchanged.
- [ ] The Canvas renderer converts only the three live-proven incompatible forms outside fenced and inline code, preserving visible labels, paths, and text: relative links, quote child blocks of list items, and bullet-list child blocks of numbered items.
- [ ] Relative-link conversion is narrow; explicit schemes, root-relative links, fragments, images, escapes, supported top-level lists/quotes, and fenced code remain unchanged.
- [ ] Projection normalization is idempotent, and the Slack payload cap is applied after normalization and footer construction.
- [ ] Both `canvases.edit` and `conversations.canvases.create` receive the normalized document.
- [ ] Canvas create/edit failures log Slack's bounded string `detail` when present without serializing the full response.
- [ ] Successful and failed provider turns schedule changed-Canvas maintenance without awaiting it; both the initial source fingerprint snapshot and the final comparison fail open, and synchronous setup failures and asynchronous rejections are contained and logged.
- [ ] Turn-owned artifact delivery remains awaited and durable.
- [ ] Process-local turn settlement and an already queued successor proceed while a scheduled Canvas Promise remains unresolved.
- [ ] Channel creation, same-channel Canvas serialization, startup and six-hour recovery, the dedicated rate-limit lane, and persisted `canvas_required` fail-closed startup retain their current behavior.
- [ ] Current-state documentation describes Canvas as a one-way Slack-compatible projection and no longer invites direct Canvas editing.
- [ ] After deployment, the ordinary startup sweep updates the live existing Canvases with no failures, including the 15 formerly rejected channels.

## Non-goals

- Bidirectional Canvas sync or preservation of direct Canvas edits.
- Rewriting or migrating canonical `AGENTS.md` files.
- A general CommonMark renderer or new Markdown dependency.
- A new process, worker, durable Canvas queue, retry database, or supervisor unit.
- Changes to refresh frequency, fleet parallelism, TODO/List projection behavior, or channel provisioning semantics.
- Detaching durable artifacts or terminal Slack projections from turn ownership.
- Weakening the strict `canvas_required` cutover.

## Implementation

### 1. Make rendering Slack-compatible

- [ ] Add a small line/state-based normalization function in the Canvas renderer.
- [ ] Track backtick and tilde fenced-code regions, including longer fences, and leave their contents unchanged.
- [ ] Outside fences and inline-code spans:
  - render only the repository-relative inline-link shapes present in verbatim fixtures from the 15 rejected documents as their label plus an inline-code path;
  - render a bullet-list child block of an active numbered-list item as an indented Unicode bullet;
  - render a quote child block of an active list item as an indented plain-text quote line.
- [ ] Preserve all other list and quote shapes byte-for-byte, including bullet-under-bullet, quote-under-quote, top-level forms, and indented lines that are not child blocks.
- [ ] Normalize before footer construction and payload capping.
- [ ] Replace stale renderer wording that implies the Canvas is editable authority with canonical-file-only guidance.

### 2. Preserve useful Slack diagnostics

- [ ] Add a tiny Canvas-specific diagnostic helper that reads `slackErrorData(err).detail`, accepts only strings, and truncates them to a named log-safe limit.
- [ ] At Canvas create/edit failure sites, log only that bounded detail in addition to the existing error fields; omit non-string detail and every unrelated response field.
- [ ] Preserve current stale/deleted Canvas classification and create/adopt behavior.

### 3. Detach only ordinary post-turn Canvas maintenance

- [ ] Rename the turn service seam to an explicit scheduling contract that returns `void`.
- [ ] Wrap the initial raw fingerprint snapshot in a fail-open helper so source-read failure cannot prevent provider admission; retain `null` as the comparison sentinel and log the failure.
- [ ] Compare raw before/after fingerprints at the index-owned scheduling boundary, launch the existing serialized `syncAgentsCanvas` path, and terminate every rejection with a structured log.
- [ ] Contain synchronous fingerprint/read/setup failures so Canvas maintenance cannot alter a completed success or the original provider failure.
- [ ] Use the scheduler on both turn-success and turn-error paths only after required turn-owned side effects.
- [ ] Leave channel provisioning, startup/interval fleet refresh, and strict cutover call paths unchanged.

### 4. Prove lifecycle and projection invariants

- [ ] Add verbatim regression fixtures representing every distinct relative-link destination shape in the 15 rejected documents; explicitly preserve unsupported/unproven CommonMark forms rather than guessing.
- [ ] Add table-driven renderer tests for the three conversions, combinations, idempotence, both fence styles and lengths, multiple-backtick inline-code spans, escapes, preserved URL/list/quote forms, and the bullet-under-bullet/quote-under-quote/indented-non-child near misses.
- [ ] Include indented and longer fences with shorter false closers, plus a multiple-backtick inline span adjacent to a real relative link on the same line.
- [ ] Assert the input and raw-source fingerprint are unchanged and the cap applies after an expanding conversion.
- [ ] Assert normalized payloads reach both Canvas edit and create APIs.
- [ ] Assert safe Slack `detail` appears in failure logs, is capped at the named limit, and non-string detail and unrelated response data do not appear.
- [ ] Force the initial fingerprint read to throw and prove a successful provider turn still succeeds, a failed provider turn retains its original error, and the projection setup failure is logged.
- [ ] Directly test the scheduling helper with a throwing final fingerprint comparison and a rejecting launched sync on both delivered and provider-error outcomes; require exactly one structured channel/reason failure log and no unhandled rejection.
- [ ] On successful and failed turns, hold Canvas work unresolved and prove turn execution settles.
- [ ] In a multi-turn test, prove an already queued successor is promoted while the preceding Canvas refresh remains unresolved.
- [ ] In an artifact-producing multi-turn test, hold artifact upload unresolved and prove the turn, queued successor, and Canvas scheduling remain blocked; then resolve the artifact, hold Canvas unresolved, and prove the turn settles and successor starts.
- [ ] Retain existing same-channel serialization, identity-race, normal-startup, and strict-startup tests.
- [ ] Update `docs/architecture/SLACK-INPUT.md` in the implementation commit.

## Validation and release

- [ ] During implementation, run only the focused Canvas and turn-lifecycle tests.
- [ ] Run `cd bot && bun test` once at the completed milestone.
- [ ] Obtain one fresh-context review of the actual diff with an explicit `SHIP` or `NO-SHIP` verdict. Review only the approved scope and require the smallest correction for concrete violations.
- [ ] Rebase on `origin/main`, commit, push, and integrate the reviewed branch.
- [ ] Deploy only through `bot/scripts/deploy.sh`.
- [ ] Re-prove the deployed commit and current service invocation.
- [ ] Wait for that invocation's normal asynchronous fleet-refresh completion and require `failures=[]` relative to the live channel inventory.
- [ ] Confirm all 15 formerly rejected channel IDs emitted successful existing-Canvas update events, with no Canvas failure, unhandled rejection, startup failure, or health regression in the invocation.

## Rollback and recovery

The code rollback is a normal Git revert and deploy. A detached refresh interrupted by restart needs no durable recovery record: the successor process's startup sweep re-renders every Canvas from canonical files, and the six-hour sweep retries while the process remains live. Strict cutover remains awaited and therefore cannot silently pass a failed projection refresh.
