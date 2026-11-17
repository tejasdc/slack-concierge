---
failure: An interrupted grouped final left later request dispositions owed and a requested notification unproven.
date: 2026-11-17
fix_commits: []
cause_status: best-explanation
---

# Native grouped final custody and notification

## What was seen

The live original main request `1661ce36-caea-486e-a3dc-45395f80c902` settled with final event
`4b073572-8c20-46da-9693-98ed28cdd8a1`; nine requests remained owed. The sending owner
`concierge:9680` confirmed no retry or send since refusal. Exact raw owner roots are still awaited.
The observed state does not alone prove the precise failure
path or whether a phone notification appeared.

## Cause

The command-line client expanded `--also` into sequential replies. An interruption could therefore
leave only a prefix accepted, with no retained full group. Separately, grouped answer-post reuse is
topic-wide while the notification guard requires the exact thread root. A later child's notification
could be denied when its reused canonical post belonged to a different root. The source defect is
confirmed; applying it to the observed live interruption remains the best explanation pending the
raw owner evidence.

## Fix

The native local owner retains the complete ordered command, source, original file bytes and
attachment custody before any child reply. It requires the same requester and exact recipient for
every child, preserves legacy group and child action identities, and accepts only an exact command
retry. Each missing child follows normal route and reply validation; newly accepted children retain
their own trusted requirement snapshot. The group operation receipt records ordered members,
accepted child IDs, and an exact failed child and error; child events remain authoritative.

Notification reconciliation preserves the exact-root guard: resolve the canonical post root through
the exact reply's answer closure, with the same topic and matching posted-by session and source. An
explicit identical accepted-command retry may reconcile a missing requested notification even when
answer upkeep already exists. Ordinary startup does not upgrade old readings. This adds no timer,
worker, automatic group retry, or manual clearing of obligations.
Stop, pause, archive and handoff prevent a missing notification from being resumed; an existing
notification receipt is still returned without another effect.

## Acceptance scenario

**Seed:** One native grouped final with a shared answer in a topic, distinct request roots, and a
requested notification; retain an accepted first child and leave later children owed. Preserve the
original command and file custody.

**Action:** After the receiver fix is installed, retry that exact original command once through its
normal owner entrance; inspect the group and each request's event, post, closure and notification
receipt. Change one command field in a separate disposable attempt to check conflict handling.

**Expected:** The accepted child is reused, missing children settle once, the canonical shared post
is reused with exact closure/root authority, and a missing requested notification is reconciled once.
The changed command conflicts. A matching source/build alone does not prove any of these live effects.

**Replayable offline:** no (agent suites are disabled; use the real original retry after the receiver
fix). Physical phone display requires separate device evidence.

## State card

- **Entity and owner:** the native local owner retains one group operation and each request's own
  reply event; notification and post custody remain separate effects.
- **Identity:** the source input and action identify the ordered group. Legacy derived action IDs
  identify children; each accepted event and its exact answer closure identify its canonical post.
- **Acceptance ladder:** retained group → individually accepted child events → post/closure →
  notification receipt → physical phone display. Each step requires its own evidence.
- **Restart and lifetime:** retained commands and receipts survive restart. There is no group recovery
  timer. An interrupted explicit retry is resumed only by another exact explicit retry.
- **Old readers and records:** readers continue to see individual request receipts and the shared
  post. Replies accepted before requirement snapshots use a fresh requirement read. A pre-fix child
  cannot prove unrecorded original group membership.
- **Loss and retry:** a lost response or interruption may leave a retained prefix; retry consults
  accepted events and resumes missing children. A crash can leave the cached group child list behind
  its events until retry refreshes it; events own acceptance.
- **Falsifying scenario:** if a different-source post, another topic's closure, or a changed command
  can trigger reconciliation, or a retry creates a second child/post/notification, this repair fails.
