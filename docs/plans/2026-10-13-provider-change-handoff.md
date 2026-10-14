# Provider change is a handoff, not a withdrawal

Status: design agreed (lab retrospective concierge:6065, request a36decbf), implementation in progress.

## Problem

On 2026-10-13 at 12:52 PM ET Tejas asked that lab work run on Fable until Wednesday. The Inbox could
only do that as cancel-and-recreate, because Concierge had no way to change who does a session's
work: it withdrew a Thinkering build request whose draft sits uncommitted in a worktree, a ChatGPT Pro
deep-research run already in progress, and a Lab committee round with two sealed positions; the
replacement sessions redid the research dispatch. (agent-ecology
docs/retrospectives/2026-10-13-lab-committees-and-codiak.md item 9; ChatGPT Pro's reasoning in
agent-ecology docs/research/2026-10-13-lab-retrospective-patterns-chatgpt.md change 1.)

## Invariant

The logical work keeps its identity; only the executor changes. Every open obligation is owned by
exactly one live session at every instant, and authority moves only when the successor has
acknowledged the exact set it is taking. Nothing written in the past changes author.

A running session's own provider binding is still never switched in place (provider history and
transcripts are per provider); the handoff creates a successor session and moves the obligations.

## Parts

### 1. `sessions handoff <predecessor address> --provider <alias> [--model] [--effort] --reason "<why>" --action-id A`

Owner operation, one SQLite transaction:

- creates the successor session in the predecessor's project folder (same cwd), titled
  "<predecessor title> (continued)" unless `--session-name` is given, with metadata
  `handoff:{continues:"concierge:<P>",handoffId}`;
- records `session_handoffs` (id, predecessor, successor, state `proposed`, reason, requesting
  input/run, his originating input when the requester's provenance has one, inventory JSON and its
  sha256 digest, created_at);
- queues the successor's first input: the handoff brief (below).

Who may call it: the predecessor itself, any session that has an open request to it (its
requester, e.g. the Inbox), or Tejas's surfaces. One open (`proposed`) handoff per predecessor;
a second is refused with the first's id. The predecessor keeps every obligation and keeps
working until acceptance, so a successor that never starts loses nothing; `sessions handoff
withdraw <id>` (caller or predecessor) ends a proposed one.

### 2. Inventory (computed in that transaction, recomputed at acceptance)

Each item has a stable id `<kind>:<ref>`:

- `sent:<request id>` — open requests the predecessor sent (local communication requests and
  peer requests to the Mac). Each carries the target, its execution state, and
  `do-not-redispatch` when the target has acknowledged or started it, or when the target is a
  ChatGPT session (an external answer in flight). The successor is told never to re-ask these:
  their answers will arrive to it.
- `owed:<request id>` — open requests the predecessor owes a reply to.
- `queued:<input id>` — accepted inputs queued for the predecessor that never started.
- `watch:<watch id>` — the predecessor's active watches.
- `lab:<handle>` — open Lab threads where the predecessor is owner, member or decider (read from
  thnkr.ing `GET /api/lab`; unavailable board is a stated omission, not a silent gap).
- `worktree:<path>` — git worktree roots the predecessor worked in: its session cwd plus the cwd
  values and edited file paths recorded in its own provider transcript. Each with branch, head
  commit and count of uncommitted files. Referenced, never copied or changed.
- `decisions` — not copied: the brief tells the successor to read the predecessor's
  conversation through `sessions context <address>` before acting.

### 3. Successor acknowledgement: `sessions handoff accept <id> --digest <sha256>`

Only a live run of the successor session may accept. The owner recomputes the inventory; if its
digest differs from `--digest` (something was added or settled since), it refuses and prints the
current inventory and digest so the successor acknowledges what actually exists.

### 4. Atomic transfer and fencing (on accept, one transaction)

- `sent` items: the request's requester becomes the successor (`source_session_id`), so every
  later partial, final, stall or overdue notice returns to the successor. Request ids, targets and
  their runs are untouched: nothing is cancelled, nothing is re-sent. The original requester
  input stays as provenance.
- `owed` items: the recipient becomes the successor, so the successor's `sessions reply` is
  accepted and the stranded check follows the successor's run.
- `queued` items: moved with the same safety rule as the allowance-wall transfer (only inputs no
  provider ever received); anything else stays and is listed.
- `watch` items: re-pointed to the successor.
- every moved item is recorded in `session_handoff_items` (kind, ref, from, to) — the audit trail
  of who held what.
- the predecessor is marked superseded (`handoff.supersededBy`) and suspended once its live run
  ends; a live run receives one steered notice saying who continues and that its writes are now
  refused. It is never killed mid-effect.

Fencing: every owner write from a superseded session's run is refused with the successor's
address: ask, reply, cancel, post, thread, title, watch, board writes, a new handoff. Reads
(`get`, `context`, `search`, `obligations`) and its own closing `sessions outcome` stay allowed.
A new ask addressed to a superseded session is refused with the successor's address.
Limit: git commits a still-running predecessor makes directly in a worktree are not
owner-mediated; the notice tells it to stop, and the suspension ends its next turn.

### 5. Authorship never moves

Past replies, history and Lab entries keep the predecessor as author. In the Lab the successor
writes under its own name; Concierge's session view carries `handoff:{continues,supersededBy}`,
and thnkr.ing's writer proof uses it: a superseded writer is refused, and a successor holds the
roles (owner, member, decider) of the sessions it continues, so a sealed round the predecessor
belonged to completes when either has posted, and the successor can reveal or decide.

### 6. `sessions obligations [<address>]`

Lists, for either side of a handoff, every outstanding item above with its current holder, plus
the handoff lineage (continues / superseded by). Default address is the caller's own session.

### 7. The Inbox uses handoff

`sessions cancel` takes an optional `--reason`; `provider-change` is refused with the exact
`sessions handoff` command to run instead. The Inbox's own instructions are updated by the Inbox
session itself.

## Acceptance test

Build a predecessor holding a child ChatGPT request, an uncommitted worktree and a half-finished
committee (sealed round, one position posted); hand it off (GPT-6 Sol → Fable or Opus → Codex);
afterwards: no request cancelled, the same request ids now name the successor as requester, the
worktree untouched and listed, the committee's posted position keeps its author and the successor
can complete the round, `obligations` lists everything on both sides, and a write from the
predecessor is refused.
