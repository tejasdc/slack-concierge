# Selective Lab conversations

The Lab journal in thnkr.ing owns the visible conversation. Concierge owns the exact
participant bindings and provider executions. This is one person's system on the server
and Mac; comparison does not assert equal private histories or equal source material.

## State card

- **Writer and entity:** Concierge is the sole writer of each retained Lab conversation
  action and explicit activation. thnkr.ing alone writes the journal. Existing sessions
  retain their provider, model, effort, project and private history; fresh sessions use
  the explicitly selected binding. The thread author coordinates, independently of Inbox.
- **Identity:** the client action retains a binding once. Each selected participant has
  a deterministic invocation ID and an ordinary accepted service input. A published
  answer is keyed by that invocation and its retained terminal event. Retries compare
  identities and payloads, never text similarity.
  Roster updates append immutable membership revisions and compare the expected
  current revision before advancing a retained head pointer. Each activation pins an
  immutable membership record; old outputs never look up today's roster conditions.
- **Acceptance:** conversation recorded → exact context frozen → ordinary provider input
  admitted → original provider output retained → journal publication acknowledged.
  Each fact has a separate status. No admission receipt claims publication.
  Before context dispatch, the private Lab capability acknowledges an idempotent journal
  binding that admits the exact participant sessions without fabricating a source run.
- **Provisional state:** the exact conversation status exposes selected bindings,
  pending context, execution, uncertain execution, failures and publication. Provider
  text is read only for the exact retained terminal output being published.
- **Lifetime:** the existing communication reconciliation pass advances pending Lab
  actions. Providers remain owned by the ordinary execution queue. A restart rereads
  the retained invocation and never submits another input for ambiguous execution.
  Lab does not create a second passive message queue or standing service.
  Its bounded task runs independently of ordinary request delivery; a slow participant
  cannot hold a ready sibling. Stop aborts observation without claiming a failed provider
  run, and does not dispatch new work after the observation ends.
- **Old readers:** existing Lab posts and session inputs keep their formats. New Lab
  activation controls are explicit. An empty selection is passive and admits no turn.
- **Lost response:** retain invocation, admit input, retain output, publish journal entry,
  lose HTTP response. Restart republishes the same invocation/event identity; thnkr.ing
  returns the original journal entry. Provider execution is never repeated.
- **Falsifying check:** disposable fixture restarts between admission and output, loses
  a publication response after its effect, repeats create/respond, supplies a wrong
  output identity, and verifies independent initial prompts and selected-only activation.
  It also removes a voice during an accepted run, adds a new voice without starting it,
  targets the newcomer after intervening discussion, and retries stale or duplicate
  roster changes without changing already-accepted conditions.

## Context and answer custody

Initial prompts contain the common opening question and the participant's selected
source material, with provenance. They contain no other participant's first answer.
An existing session keeps its history, which is disclosed rather than called fresh.
Later explicit activations freeze the visible discussion through the exact triggering
entry. Newer posts cannot enter that invocation after acceptance. Passive posts wake
nobody, including the thread coordinator.
Adding or removing a voice changes only future selections. A removed voice's accepted
or running invocation remains attributable to its original roster revision. Re-adding
the same session creates another revision and never rewrites its old instructions.
Added sessions start no provider turn until explicitly selected, then receive the
shared discussion through their triggering entry rather than an independent opening.
All participants are told this is a group conversation: concise, direct responses are
the default, with depth when the human asks. The retained provider answer is never trimmed.
Each reader keeps its own sealed visibility; later activations never reuse another
participant's context. The Lab's canonical read projection withholds other initial
answers from a still-independent reader while the human can see answers as they arrive.
This is isolation at the supported Lab and prompt entrances, not a claim that a coding
agent's arbitrary shell or pre-existing private history is an adversarial sandbox.

The same rule covers every ordinary owner read, not only the Lab view. Each agent read
carries its reader (a run token, or a declared `X-Concierge-Agent-Source` pair that the
owner checks against an admitted live run) through HTTP, native read workers, routed
commands, direct communication calls, event streams and peer calls. While a reader's
own invocation is an independent opening, any accepted input, receipt, run, history
message, event, search hit or context whose retained provenance belongs to that thread
is withheld: exact entities (operation, run, message detail, publication verifier) are
refused with 403, collections drop only the protected items. The reader's own invocation
and its earlier unrelated history stay readable. An agent read without a provable source
is never promoted to a trusted read; it is refused Lab content. Human and private service
reads are unchanged. A reader lives only as long as its request: work the request starts
(the request-delivery, peer and turn-queue loops, timers, provider runs) never runs as
that reader, and an invocation that has not yet proven its admitted binding carries no
comparison fact instead of failing the whole read. The provenance walk runs inside
interactive read budgets, so each of its fan-out queries (a request's replies, a session's
invocations, a message's events) is LIMITed to `DISCLOSURE_FANOUT_LIMIT`; a set larger than
the bound cannot be proven free of Lab provenance and is treated as protected. Each linked
input is read as its provenance facts only (ids, kind, scope and text thread fields), never
its whole payload. An unLIMITed reply query, then whole linked payloads, made agent receipt
reads answer 503 on 2026-11-17.
`scripts/lab-content-disclosure-fixture.ts` exercises all seven read paths against a real
held-open ChatGPT participant through the agent gateway, the reader's lifetime, the walk
under a read budget and reply overflow.

Selected participant instructions are retained verbatim before the question. Retained
source references use the existing verified source/version/branch/event capability;
the exact bytes and their digest enter the frozen prompt. A source label alone cannot
admit execution. Existing expertise folders and private history are disclosed separately
from those loaded references.

A participant may also carry `materials`: up to 32 `{path, sha256}` files (at most 1 MiB in
total). They exist because an agent-ecology expertise offer is an immutable snapshot of plain
files, and Thinkering's source import refuses plain files, so they cannot be retained source
references. When the participant is prepared for create or a roster add, the owner checks that
each file's real path lies inside a project registered on that owner or inside agent-ecology's
immutable offer snapshots (`/root/.local/state/agent-ecology/offer-material/snapshots`, where its
offer ledger keeps selected material outside any project; not its unselected `candidates`), so an
agent cannot push arbitrary private files into a prompt sent to an outside provider. It must be a
regular file, hash to
the supplied digest and is valid UTF-8; it then keeps `{path, sha256, text}` in the participant's
retained binding. Refusals are `LAB_MATERIAL_UNAVAILABLE` or `LAB_MATERIAL_MISMATCH` and retain
nothing. Every invocation prompt inlines the frozen text after the instructions, re-verifying its
digest and never reading the file again, so a changed or deleted expertise repository cannot alter
a comparison. The caller supplies only path and digest, which are part of the retried request, so an
identical retry is a duplicate and a different digest under one action conflicts. The public view
shows paths and digests, never the bytes, and each voice's prompt carries only its own materials.
The `sessions board participants` command already takes a JSON file, so it accepts `materials`
unchanged. ChatGPT has no tools; the prompt requires an explicit
inability when a freeform instruction needs an inaccessible resource. Freeform text is
not presented as a deterministic tool-capability classifier. Unsupported provider IDs
are refused rather than simulated. Native peer-owned sessions are currently refused
explicitly; a bound runner location remains the existing provider's execution path.

Original provider output is retained by Concierge and fetched by thnkr.ing from an exact,
conversation-bound verifier. Callers cannot supply replacement answer bytes or an author.
ChatGPT needs no tools: its ordinary retained terminal answer follows the same path.
NotebookLM is not represented as an executable provider until its native invocation
and retained-answer contract exists. A tool-capable participant can instead use an
existing NotebookLM skill when its explicit instructions request that approach.

## Owner and private-capability routes

- `POST /sessions/v1/lab/conversations` retains one thread, opening entry, coordinator
  and selected existing/fresh participants. Signed human choices retain human origin;
  marked agent choices require their exact live source pair and model-selection policy.
  The protocol allows one or more selected voices; the comparison UI may require two.
- `GET /sessions/v1/lab/conversations/:thread` returns exact bindings and at most twenty
  activation states; `before` pages older activations through a scope/rowid index.
- `POST /sessions/v1/lab/conversations/:thread/respond` freezes the triggering entry and
  exact canonical session IDs in `targets`; `[]` admits no provider work.
- `POST /sessions/v1/lab/conversations/:thread/participants` accepts `clientActionId`,
  `expectedRevision`, `add` choices and canonical session IDs in `remove`. Duplicate
  accepted actions return their original change identity and revision before checking
  the stale precondition. The current view exposes `membershipRevision` and its roster;
  `GET .../:thread/memberships/:revision` resolves an exact immutable past revision.
  The coordinator is stable, and membership updates do not cancel accepted work.
- `GET .../:thread/requests/:requestId` proves an exact retained invocation even before
  context loading. `GET .../:thread/responses/:requestId/:eventId` proves one original
  acknowledged terminal answer, its immutable provider admission and binding event.
- On the existing configured Thinkering capability transport,
  `/session-capabilities/lab/records/:thread` bootstraps the immutable opening;
  `POST .../binding {membershipRevision}` acknowledges that exact journal membership;
  both its acknowledgement and `GET .../response-context` echo the verified revision.
  Historical revisions remain provable when an older invocation continues.
  `GET .../response-context`
  resolves the participant's exact entry interval; `POST .../responses` publishes by
  invocation/event identity. These calls never supply arbitrary author or answer bytes.

The authenticated gateway's run or runner principal always requires an exact live
source pair for create, respond and roster mutations. A run principal must also match
the pair's session and turn; omitting provenance cannot become a human action. Original
answer verification is reserved for the trusted publication service entrance and is
refused to authenticated agent or marked browser callers, including through the native
read worker. Public journal reads retain their separate participant-aware projection.
The owner model catalogue publishes `chatgptThinkingLevels` from its existing validator
and a separate `chatgptProvider` descriptor from the canonical model/naming helpers.
Its existing `selectors` remain valid project-default aliases. Clients do not import
the browser adapter or maintain a second option list.

Original admitted answers remain publishable when the human later changes a session's
model. A new invocation refuses provider/model/effort/project/generation drift before
provider admission. Missing acknowledgement, empty output and unconfirmed terminal
identity are visible failure states and never trigger a replacement provider call.
The generic terminal-continuation path refuses an exact typed Lab invocation: a new
unbound turn cannot outlive the failed comparison. Ordinary in-turn retries and
existing-execution reconciliation keep their original accepted identity.
If a queued invocation's binding drifts before admission, the existing guarded service
withdrawal revokes that provably unstarted input before reporting refusal. Restoring
metadata later cannot leave the refused input hidden in the queue.
Publication disconnects retry only the same original event. Permanent refusals stay
visible, and an unavailable provider holds the exact accepted input without substitution.

The build runs `bot/scripts/lab-conversations-fixture.ts` against an isolated ledger.
It exercises the real queue, execution host and ChatGPT adapter with a deterministic
external-provider transport, plus restart/publication loss, source substitution,
per-reader contexts, selected routing, source markers, model policy and shutdown.
The actual authenticated foreground gateway and canonical read workers exercise the
principal/source mismatch and original-output isolation refusals. Roster checks cover
compare-and-set, duplicate updates, removal during execution, passive provisioning and
newcomer context with unchanged source material and instructions.
That fixture is source acceptance, not a live browser or real-provider claim.

## Disposable owner for end-to-end group tests

`bun bot/scripts/lab-disposable-owner.ts --run --capability-socket /tmp/thnkr-agent-capabilities-<port>/session.sock --deadline-seconds <60-7200> [--max-turns <1-60>] [--keep]`
starts a throwaway owner for thnkr.ing's isolated agent workspace (its
`THINKERING_AGENT_WORKSPACE_LAB_OWNER_SOCKET`). It creates a new root-only
`/tmp/concierge-lab-owner-*` directory with a fresh, empty ledger (nothing of Tejas's is copied),
prints `{ready, ownerSocket, stateDir, providers}` only once its own runner is connected and a current
Claude allowance reading has arrived, and runs participants the way production does: Claude turns go
through its own instance of the real runner daemon (`CONCIERGE_TURN_RUNNERS=all`, relay over a private
`requests.sock` and the authenticated loopback entrance), never launched by the owner itself, because
account rooms and launches exist only on a runner; Codex uses its own App Server. Lab bootstrap, context and publication go to the given
isolated workspace socket only. It serves Lab commands, its own participants' hooks and reads of its
own ledger; everything else is refused. The turn budget (default 24) bounds provider spend. At the
deadline or SIGTERM it stops only its own turns and App Server and removes the directory unless
`--keep`. ChatGPT voices are refused because the isolated workspace has no ChatGPT run capability;
Codex voices need Codex allowance. Coding participants still run with their native tools in the
chosen project folder, so the isolation covers Concierge's ledger, not the participant's shell.
