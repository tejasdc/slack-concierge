# Older MacBook session consultation: owner and integration handoff

**Status, 2026-09-15: research and bounded experiments complete; product follow-through owned here; this document is a proposal/handoff, not a feature-completion or deployment claim.**

The [historical consultation thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789430196464239) retains responsibility for Mac Claude Code/Codex source fidelity, consultation inputs, and acceptance evidence. The [Thinkering native session owner](https://tejazz.slack.com/archives/C0C03E75160/p1789436421717809) owns integration into its existing session service, provider runtime, and UI. The [parent thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789154481755879) retains coordination and assignment across those owners. This work has not been abandoned or folded into Concierge's completed communication delivery.

## Authoritative amendment

Tejas's exact [input 1789452013.770959](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789452013770959), supplied by the coordinator in [input 1789452150.291319](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789452150291319), asks:

> Is there a plan or an owner for handling these separate resurrection experiments? Are they including and building those things in here or is it just abandoned right now?

And amends the source scope:

> we're gonna interact with the browser directly so we might not be using the resurrection for [ChatGPT] transcripts only for older macbook transcripts.

**Apply this amendment to the product proposal: ChatGPT uses its separately owned browser integration. ChatGPT export reconstruction remains retained experimental evidence, not the default product path.** Preserve the export and its results; do not promote its importer into the default way to contact ChatGPT. This supersedes that default-path interpretation of the earlier import requirements. The browser integration's implementation and owner assignment remain with the coordinator; this document does not claim browser continuity is already proven.

This follow-through authorizes the concrete plan and handoff. It does not authorize implementation, another experiment matrix, product integration, service restart, or deployment in this thread. The independently authorized Thinkering work retains its own scope and delivery process.

## What the completed work establishes

The [design brief at 8904e11](https://github.com/tejasdc/slack-concierge/blob/8904e116c2a9431461a9653850b767090954ce6b/docs/plans/2026-09-14-historical-session-consultation.md), [results at cc14e12](https://github.com/tejasdc/slack-concierge/blob/cc14e1215936a61afc1d099245b621ca448deb38/docs/plans/2026-09-15-session-resurrection-results.md), and [runnable experiments](https://github.com/tejasdc/slack-concierge/tree/cc14e1215936a61afc1d099245b621ca448deb38/experiments/session-resurrection) are the handoff inputs. The experiment branch contains no product integration.

| Observed result | Product consequence |
| --- | --- |
| On one Mac Claude and one Mac Codex case, both structured role text and a single cited-context packet retained 5.5/6 frozen requirements/decisions; no-history controls retained 0/6. | Start with a cited user/assistant evidence packet in a new native conversation. A role-aware private representation remains useful for provenance; changing the runtime to Pi is unnecessary for this baseline. |
| Claude's native child answered; its common-fact score was 3/6 and it misattributed some historical material. | Native continuity is a distinct supported experimental mode, not a guarantee of better recall or authorship fidelity. |
| The tested old Codex archive's native fork created an ID but its first turn failed with `invalid_encrypted_content`. An isolated copied-profile resume answered under the original ID, scoring 4.5/6. | Fork metadata does not prove contactability. Do not put the successful same-ID experiment into a shared runtime as a second owner or silently call reconstruction a resume. |
| ChatGPT export text also supported useful reconstruction. | Retain the result as cross-format evidence. The browser amendment determines its product path. |

These are exploratory, model-assisted scores from one case per format, not reliability percentages, a model comparison, or a release threshold. Reconstruction calls explicitly requested `gpt-6-astra` through Pi AI 0.85.1; the SDK's model field was request metadata. Successful native subjects reported `claude-sonnet-5` and `gpt-6-astra`. More native tool history did not ensure better recall in these examples. Delegated implementation/review workers must explicitly use `gpt-6-astra`; experimental subjects' actual providers/models remain separately reported.

## Existing integration point, checked against source

Concierge's [communication contract at 50da5b4](https://github.com/tejasdc/slack-concierge/blob/50da5b45620fbd8c1077a319aa00f268e964393e/docs/plans/2026-09-14-session-communication.md) covers its existing managed sessions. Its [helper runbook](https://github.com/tejasdc/slack-concierge/blob/50da5b45620fbd8c1077a319aa00f268e964393e/docs/runbooks/ROUTER-ACTIONS.md#agent-session-communication) explicitly excludes native Thinkering sessions and archive reconstruction. Shipping that protocol did not make an arbitrary imported archive messageable. This proposal adds no obligation to that completed delivery.

Thinkering's [native-session plan](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/docs/plans/2026-09-14-native-agent-sessions.md) places execution in its existing native runtime. The inspected source at **955ea9c** already provides useful pieces:

- [Source storage](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/packages/adapters/src/session-sources.ts#L18): private hashed snapshots, versioned manifests, and exact-version reads.
- [Session service](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/packages/application/src/session-service.ts#L253): imported evidence produces a separate reconstructed child with a source version and boundary; `sessions_consult` then submits a correlated question through the same service.
- [Prompt construction](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/packages/application/src/session-service.ts#L181): the first reconstructed input labels selected material as historical evidence, rather than native restored roles. Later turns use the child runtime.
- [Focused fixtures](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/tests/native-sessions.test.mjs#L123) cover replica identity and pinned source versions. The separate [native provider probe](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/tests/session-provider-live.mjs) uses newly created synthetic sessions; it is not the Mac archive acceptance test.

These are source observations, not a new runtime or deployment audit. This turn did not execute Thinkering, import private histories there, or verify a live consultation. Reuse and complete this path; do not build a second importer/executor around the experiment scripts.

## Smallest useful product behavior

**Select one exact Mac conversation branch, ask a question about its prior requirements or decisions, receive a source-grounded answer in a new read-only consultation child, and continue asking that same child.** Implement and accept this as one complete behavior in Thinkering's existing session experience.

1. Discovery/read returns the source identity, exact branch/boundary, private evidence references, revision and omissions. Selecting a result does not start a provider. Source text remains inspectable even if execution is unavailable.
2. The user or an already-authorized requesting agent invokes the existing consultation action with that exact source and a new question. The visible description says it will start a **new consultation using historical text**. Do not label it “resume the original.”
3. Freeze the selected source revision and build a cited packet of visible user/assistant dialogue in its original order. Preserve corrections and distinguish user-role text from independently proven human authorship. Historical tool records may remain inspectable source evidence, but the default packet follows the tested dialogue-only baseline. No generated summary substitutes for the selected dialogue without declaring that transformation.
4. Thinkering records one consultation child and one question operation before provider work. The child receives a fresh provider identity under the existing Thinkering execution owner. Current consultation policy controls its capabilities; old instructions, tool calls, credentials, workspace paths and workflow permissions confer no authority.
5. The answer identifies its evidence references, distinguishes remembered decisions from new suggestions, and admits unknown facts. Full questions/answers remain in the private child conversation. A service-owned correlated result returns to an agent requester; the consultation model does not need outbound messaging tools to accomplish that return.
6. A follow-up uses the same child and its new conversation history. Reopening the UI observes it. Source reimport cannot replace the pinned evidence, and a retry of the same operation cannot create another child. An ambiguous creation/dispatch remains attached to that operation until the runtime owner resolves it.

No Pi coding-agent runtime, OpenClaw gateway, archive replay worker, new daemon, Slack bridge, or ownership migration is required. Pi AI was a useful experimental caller; OpenClaw supplied adoption patterns. Neither demonstrated a concrete advantage over this already existing product seam for the selected text baseline.

### Readability and contactability are separate facts

| Evidence available | Honest capability |
| --- | --- |
| Search hit and readable imported transcript | Search/read. This proves neither native resume nor permission to run. |
| Exact selected text can be reconstructed and the existing runtime can enforce the consultation policy | Offer creation of a **new** consultation. The source itself remains non-sendable. |
| Child creation acknowledged; answer still pending or failed | Show the child's actual operation state. Do not call an ID alone a successful consultation. |
| Source-grounded answer and a subsequent child turn complete under the enforced policy | Contactable reconstructed child, with its demonstrated format/version scope. |
| Native child continuation completes with unique binding and preserved source | Separately advertise that native mode for the tested adapter/source combination. |

Keep reconstruction availability, runtime health, and observed successful execution separate. A generic `consult: true` on every import is insufficient evidence for the latter two. Explicitly unavailable or unsupported native modes do not block an independently validated text consultation.

## Ownership and concrete handoff

| Owner | Next action / durable responsibility |
| --- | --- |
| **This historical consultation thread** — Mac archive/consultation follow-through | Supply C1/X1's private frozen fixtures, normalization rules, known exclusions and source-grounded rubric to the native owner; check the resulting packet and acceptance evidence. Retain responsibility for compatibility/fidelity questions and follow-up failures. Changes to experimental tools remain separate from product runtime ownership. |
| **Thinkering native session owner**, root `1789436421.717809` | Incorporate the Mac packet and enforced consultation policy into its existing source/child/service path, or demonstrate that its completed work already meets the contract. Own product code, UI/capability labels, native execution, per-session ordering, controls and correlated returns. Apply the ChatGPT browser amendment to default consultation affordances. |
| **Remote-box archive owner** | Preserve and transport original Mac archives. Supply read-only source access/snapshots through its established transport. This proposal adds no archive writer or sync job. |
| **Existing discovery/search owner** | Supply ranked candidates with exact source locators and honest coverage. A search result must not create a provider binding or contactability claim. |
| **Concierge owner** | Continue executing and delivering for sessions it already owns. Its shipped communication protocol does not acquire Thinkering sessions or archived native IDs. No Concierge change is required for the Thinkering-first behavior proposed here. |
| **Parent coordinator**, root `1789154481.755879` | Carry this handoff to the active native owner, reconcile any overlap with that owner's current delivery, and decide when the remaining product work is assigned. Retain the separately owned ChatGPT browser work. |

The concrete handoff request is to finish and prove the existing Thinkering consultation path for **one selected Mac Claude source and one selected Mac Codex source**, using the fixtures already obtained. It is not a request to rerun the full provider/harness comparison. No additional implementer or competing provider owner was launched in this turn. Work requiring new implementation authority stays visible under this proposal rather than being implied by the experiment's completion.

### Payload and identity responsibilities

Reuse the existing `SessionSource`, evidence, lineage and operation records. The archive/consultation owner supplies source format/version, provider/profile namespace, original native ID, selected branch/leaf, immutable byte hash, retained role/event locators and text hashes, transformation version, authorship uncertainty, and explicit omissions. The native owner binds those to the child logical ID, runtime owner/provider ID, model request and reported-model evidence, effective permissions/tools, question/return operation IDs and observed results. Fields not yet representable belong in the existing source/fidelity metadata boundary, not a second session database.

Original native identity and new child identity must remain distinguishable, including host/profile namespace. The successful Codex same-ID copied-profile experiment stays an experimental mode; it must not become another writer for a native ID already owned by a managed runtime. Native compatibility failures remain explicit. An automatic fallback must never relabel a fresh text reconstruction as native continuity.

## Remaining proof: bounded acceptance, with owners

The complete product acceptance uses the two frozen Mac cases and a small set of deterministic boundary checks. It does not depend on ChatGPT export tests, browser integration, broad archive coverage, or fixing native Codex fork compatibility.

| Proof needed | Concrete evidence and owner |
| --- | --- |
| **The product imports the intended branch** | Consultation owner compares the actual product projection to C1/X1 event references, order, role and frozen hashes. Reject incomplete parent/dependency chains, unsupported rollback/compaction semantics, or invalid boundaries before offering that source mode. Native owner keeps read/search available with honest incompleteness where possible. The current [parser](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/packages/adapters/src/session-source-parser.ts#L22) is not the experimental decoder: its Codex record-order projection and historical expansion need explicit comparison, not assumed parity. |
| **The product adapter can enforce consultation authority** | Native owner proves the effective provider policy on initial and follow-up turns: no project writes, historical execution, arbitrary outbound session messages, live project/workflow permission inheritance, or source modifications. The current [controller attaches session tools to ordinary chat](https://github.com/tejasdc/thinkering/blob/955ea9c2f0690a3ebc7c27ae5520e4a5f4def79a/packages/application/src/agent-controller.ts#L130); a read-only filesystem or prompt disclaimer alone does not disable those effects. Route the answer through the service's return obligation. Use fixture paths and forbidden-action probes, not production side effects. |
| **Useful historical follow-up through the real product path** | Native owner runs import → inspect → consult → answer → second question on the same child for C1 and X1 through a task-owned test instance. Consultation owner checks the frozen requirement/decision rubric, correction handling, role attribution, unsupported-fact abstention, source references and practical usefulness. Record omissions and unsupported claims individually; do not substitute a fluency judgment or reuse the exploratory score as an automatic pass. |
| **Durable identity and truthful controls** | Native owner proves exact source-version pinning after reimport, same-operation retry without another child, refresh without another send, first-input failure without losing the historical packet on retry, and Stop/ambiguous-result behavior through existing service tests. Show an imported source separately from its reconstructed child. Existing creation metadata and synthetic native probes do not alone satisfy this evidence. |
| **Private evidence and accurate default scope** | Both owners keep raw prompts, answers, quotations and logs outside committed/public artifacts; publish only redacted outcomes and source hashes. Verify original and frozen source hashes unchanged. Native owner verifies that ChatGPT contact defaults to its browser path; a retained export entry does not silently create a Codex consultation by default. |

**Acceptance claim:** the tested older Mac text formats can support a useful, source-grounded, read-only conversation in a distinct Thinkering consultation child, with its original source preserved and limitations visible. Call the feature available only after that whole path passes the native owner's normal product gates. Extra native-resume modes require their own exact-source proof before being advertised; their absence is not a failure of the selected reconstruction behavior.

For unsupported longer/compacted histories, unresolved attachments or missing ancestor records, state the missing evidence and permit an explicitly selected, labeled partial context only if the user chooses it. Do not silently truncate to fit, merge sibling branches, or promise restored operating-system state, model internal state, complete tools, attachments or current project correctness. Historical facts remain historical.

## Evidence location and review of this handoff

The private experiment store remains `/root/.local/share/session-resurrection-experiments/`; raw source contents are deliberately absent here. [Sanitized evidence](https://github.com/tejasdc/slack-concierge/blob/cc14e1215936a61afc1d099245b621ca448deb38/docs/plans/2026-09-15-session-resurrection-evidence.json) links the completed measurements. Provider semantics and their limits were researched against [Claude's session documentation](https://code.claude.com/docs/en/agent-sdk/sessions), [Codex's App Server contract](https://developers.openai.com/codex/app-server), and pinned primary source in the earlier brief; this handoff makes no new general portability claim.

This document was checked against the completed report, Concierge source at `50da5b4`, and Thinkering source at `955ea9c`. Source navigation used bounded text searches/reads because no LSP tool was available. This is not an exhaustive Thinkering code or security audit. No provider calls, archive reads, product mutations, daemon operations or deployment occurred for this handoff. Documentation checks cover links, the exact source amendment, scope/ownership consistency and the complete diff; runtime acceptance remains the explicitly assigned work above.
