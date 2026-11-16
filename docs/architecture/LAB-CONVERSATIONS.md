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

## Context and answer custody

Initial prompts contain the common opening question and the participant's selected
source material, with provenance. They contain no other participant's first answer.
An existing session keeps its history, which is disclosed rather than called fresh.
Later explicit activations freeze the visible discussion through the exact triggering
entry. Newer posts cannot enter that invocation after acceptance. Passive posts wake
nobody, including the thread coordinator.
Each reader keeps its own sealed visibility; later activations never reuse another
participant's context. The Lab's canonical read projection withholds other initial
answers from a still-independent reader while the human can see answers as they arrive.
This is isolation at the supported Lab and prompt entrances, not a claim that a coding
agent's arbitrary shell or pre-existing private history is an adversarial sandbox.

Selected participant instructions are retained verbatim before the question. Retained
source references use the existing verified source/version/branch/event capability;
the exact bytes and their digest enter the frozen prompt. A source label alone cannot
admit execution. Existing expertise folders and private history are disclosed separately
from those loaded references. ChatGPT has no tools; the prompt requires an explicit
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
- `GET .../:thread/requests/:requestId` proves an exact retained invocation even before
  context loading. `GET .../:thread/responses/:requestId/:eventId` proves one original
  acknowledged terminal answer, its immutable provider admission and binding event.
- On the existing configured Thinkering capability transport,
  `/session-capabilities/lab/records/:thread` bootstraps the immutable opening;
  `POST .../binding` acknowledges the journal membership; `GET .../response-context`
  resolves the participant's exact entry interval; `POST .../responses` publishes by
  invocation/event identity. These calls never supply arbitrary author or answer bytes.

Original admitted answers remain publishable when the human later changes a session's
model. A new invocation refuses provider/model/effort/project/generation drift before
provider admission. Missing acknowledgement, empty output and unconfirmed terminal
identity are visible failure states and never trigger a replacement provider call.
The generic terminal-continuation path refuses an exact typed Lab invocation: a new
unbound turn cannot outlive the failed comparison. Ordinary in-turn retries and
existing-execution reconciliation keep their original accepted identity.
Publication disconnects retry only the same original event. Permanent refusals stay
visible, and an unavailable provider holds the exact accepted input without substitution.

The build runs `bot/scripts/lab-conversations-fixture.ts` against an isolated ledger.
It exercises the real queue, execution host and ChatGPT adapter with a deterministic
external-provider transport, plus restart/publication loss, source substitution,
per-reader contexts, selected routing, source markers, model policy and shutdown.
That fixture is source acceptance, not a live browser or real-provider claim.
