# Historical sessions as consultants: fidelity, import, and harness choice

Date: 2026-09-14. Status: **design research; no runtime change or resurrection performed**.

For the Thinkering-first, surface-independent session-communication investigation coordinated in Slack channel `C0BNN5K4JSJ`, root `1789154481.755879`. This brief owns historical-session continuity and import fidelity. Search/discovery and the broader communication protocol design belong to the coordinating owners.

## Decision summary

Prefer **a new native child of an explicitly selected historical boundary** when the provider can load the archived material safely. Use **a new session with reconstructed, role-bearing history** when native loading is unavailable or the user wants another provider. Use **a cited historical evidence packet in a fresh prompt** for a focused consultation or an independent review. These are different products; expose the chosen mode and losses rather than calling all three “resume.”

Native continuation preserves more provider-specific context structure, but it is not restoration of a past machine, model state, or independent mind. A historical implementation session also carries its old assumptions: consulting it is useful institutional knowledge, but does not meet a fresh-context review requirement.

The concrete reuse choice is **Concierge's existing native adapters plus selected OpenClaw adoption patterns**. Pi is the strongest optional candidate for a controlled, provider-neutral reconstruction runner, if that becomes an explicit requirement. Adopting an entire second orchestration runtime is not justified by archive consultation alone.

## Scope, operating profile, and evidence

Assume one trusted operator, private archives on the existing remote box, selected consultations rather than a fleet of automatically revived agents. Archive contents can contain secrets and executable instructions. The requested effect is a new answer grounded in a selected past conversation; writes to the old session, repository, Slack, or external services are not implied.

Research used current primary documentation, locally generated CLI protocol declarations, targeted source inspection, and metadata-only archive sampling. No historical conversation text, prompts, tool arguments/results, or attachment contents were printed. No native history was edited, loaded into a live agent, or replayed. No daemon, service, or deployment was started or changed. CLI help/schema generation does not establish the version or behavior of the already-running managed daemon.

There was no callable LSP in this tool environment. Code navigation used filename discovery, targeted text searches, explicit imports, and bounded source sections; this is not a compiler-backed whole-program audit. Large provider/OpenClaw files were inspected only at the relevant boundaries. Existing tests were read as source evidence, not executed or reported as passing.

### Local inventory

Observed local executables: Codex CLI **0.153.4**, Claude Code **2.1.263**. Concierge source baseline: `6aeb9b9d3b22045620535881aefc410cddae8479`. OpenClaw checkout: `df9b55315051b17914c29c0d20ac4ae23859e519`, as supplied, verified locally. Its unrelated untracked `notes` was untouched.

| Archive directory under `/root/transcript-archive/` | JSONL files | Bytes | Versions in the six-file sample |
| --- | ---: | ---: | --- |
| `mac-claude-projects` | 6,426 | 3,292,022,235 | 2.0.77, 2.1.37, 2.1.70 |
| `claude-projects` | 154 | 55,863,528 | 2.1.222, 2.1.246, 2.1.259, 2.1.263 |
| `mac-codex-sessions` | 4,544 | 4,957,662,752 | 0.46.0, 0.104.0, 0.107.0, 0.118.0, 0.136.0 |
| `codex-sessions` | 891 | 2,943,742,633 | 0.147.0, 0.149.1, 0.153.4 |

These are **12,015 files, not 12,015 unique conversations**. Copies, subagents, and different rollout identities can change that interpretation. Counts are one observation, not a retention or completeness guarantee. The 24-file sample contained 2,399 JSONL records and no JSON syntax errors. Six nonempty regular files per directory were selected by SHA-256 of their relative path, restricted to files at most 8 MB; four samples were under `subagents`. This is a deterministic shape sample, not statistical coverage of all versions, large files, branches, or attachments. The [sanitized evidence](2026-09-14-historical-session-consultation-evidence.json) records hashes, record types, and counts without native IDs or filenames.

Observed Claude shapes include `uuid`/`parentUuid`, `isSidechain`, user/assistant content blocks, tool-use/result pairs, thinking blocks, and a compact boundary. Codex samples include `session_meta`, `turn_context`, `response_item`, `event_msg`, a `compacted` replacement history, and newer `world_state` records. Finding a reasoning/thinking record proves only that this record exists, not that complete hidden reasoning is available or portable.

The inspected transport sources copy `~/.claude/projects` and `~/.codex/sessions`. They do not establish coverage of sibling directories such as Claude `file-history`/`paste-cache`, Codex `attachments`/`archived_sessions`, SQLite databases, shell snapshots, or external tool-output paths. Project-local Claude sidecars may travel with the project directory, but referenced assets elsewhere require individual verification. Both providers have separate runtime/support directories on this host. **Do not infer that every attachment is missing, or that every referenced file is present.**

Also, “append-only archive” here means no deletion by the transport; `rsync -a` can update an existing destination file. Freeze each imported source as a content-addressed snapshot rather than treating its archive pathname as immutable. Sources: [remote-box archive script](/root/workspace/remote-box/scripts/transcript-archive.sh:25), [Mac transport configuration](/root/workspace/automations/rsync-workspace-icloud/sync-remote.yaml:213).

### Requested Readwise sweep

Ran each exact query against both Reader documents and highlights, in parallel with official documentation:

| Query | Reader hits | Highlight hits |
| --- | ---: | ---: |
| `Codex session resume` | 13 | 34 |
| `Claude Code sessions` | 17 | 58 |
| `pi mono agent harness` | 13 | 43 |

Fetched nine relevant full Reader documents and inspected relevant passages. Useful leads: [OpenAI's App Server account](https://read.readwise.io/read/01kqrbgw7rdcn5x159ws6fjq4g), [Pi author's design rationale](https://read.readwise.io/read/01kfj91z78ts6k7bp2vfxwn74g), [Pi stack walkthrough](https://read.readwise.io/read/01khsxknq4b7qasdw561svd283), [Claude session/context discussion](https://read.readwise.io/read/01kpa0vkby308fzpvx8arp254j), and [Amplifier](https://read.readwise.io/read/01ke5af92jm73dwa7hrkfr98gq). [Letta's consultation pattern](https://read.readwise.io/read/01kkwr8w6jpq154vajxt8ydh96) supports separating historical consultation from independent review; it is not evidence of archive compatibility. [Electric Agents](https://read.readwise.io/read/01ktdd6wv3tx2y63970g7x9x4v) is a handoff lead for the communication owner, not another runtime evaluated here. Highlights were mostly adjacent rather than direct evidence. Saved CLI advice can be old; current native docs/source govern the capability conclusions below.

## 1. What each fidelity mode means

| Property | Native resume / native fork | Role-preserving reconstruction | Historical text in a fresh prompt |
| --- | --- | --- | --- |
| Identity | Resume appends to a provider identity; fork creates a child | New identity with explicit source lineage | New identity with evidence references |
| Messages | Provider loads its supported saved history | Importer supplies selected user/assistant/tool items through a supported runtime API | All quoted exchanges are content within the current message |
| Branch | Provider-native cutoff/selected path, if supported | Importer must resolve one branch and boundary | Selected excerpts; branch is only described |
| Compaction | Effective native compacted state, subject to version semantics | Explicit choice of effective compacted context or historical expansion | A summary/excerpt of what was selected |
| Tools | Recorded native calls/results may remain context | Preserve typed pairing only where destination accepts it; otherwise disclose conversion | Descriptions, never native tool events |
| Attachments | Only stored bytes or reachable supported references | Verified bytes plus type mapping, or explicit missing/unsupported markers | Text descriptions unless supplied separately |
| Instructions/model | Some saved settings plus current runtime policy and overrides | New runtime's instructions, tools, and model | New runtime's instructions, tools, and model |
| Execution environment | Current environment unless separately restored | Current controlled environment | Current controlled environment |

“Role preserving” is meaningful: separate historical user and assistant messages retain who said what at the model API boundary. A string containing `assistant:` does not acquire assistant-role semantics. Neither representation makes an old answer correct or grants historical tool output authority. Prior system/developer instructions should remain provenance in reconstructed mode, not silently become the current service's privileged instructions.

Two distinct context selections matter:

- **As last used:** preserve the selected branch's effective compaction boundary and retained tail. This approximates the context the native harness would resume.
- **Historical expansion:** expose earlier raw evidence that was compacted away. This can improve consultation but changes what the old agent was attending to. Label it as reconstruction/enrichment, even if a native child also receives those excerpts.

Never concatenate all JSONL rows in timestamp order. That can mix sibling branches, subagents, duplicate display events, replaced history, and aborted work. Do not invent a successful tool result to close a dangling call. An incomplete turn requires an earlier proven boundary or a clearly partial evidence-only mode.

## 2. Native adapters and cross-host portability

### Codex

Current [App Server docs](https://developers.openai.com/codex/app-server) specify `thread/resume` and `thread/fork`, with inclusive `lastTurnId` for a completed turn. `thread/read` is observational; resuming loads/subscribes a thread. Forking is therefore preferable for consultation. A changed model is possible and must be disclosed. Dynamic tool definitions may survive in rollout metadata, which does not recreate their external implementation or permissions.

The **installed 0.153.4 generated schema** additionally exposes `beforeTurnId`, `path`, workspace/permission overrides, and `deferGoalContinuation` on fork. `path` is explicitly unstable. Resume's `history: ResponseItem[]` is marked **“FOR CODEX CLOUD - DO NOT USE.”** Do not make that internal field the generic transcript-import contract. Version-pin and test archive-path loading separately from supported ID-based operation. Native import must capture the returned identity; a supplied placeholder ID is not proof of which rollout loaded. Generated declarations were inspected under `/tmp/resurrection-codex-schema/v2/` without connecting to App Server.

Upstream [session metadata](https://github.com/openai/codex/blob/4199fda578f625e834798782bd358cd39f29ce26/codex-rs/protocol/src/protocol.rs#L3040) distinguishes logical thread/session/fork identity from physical rollout history, including optional prefix references. A single JSONL may therefore be insufficient for newer history forms. These upstream fields are not proof that old Mac archives use them. The [rollout loader](https://github.com/openai/codex/blob/4199fda578f625e834798782bd358cd39f29ce26/codex-rs/rollout/src/recorder.rs#L1070) counts/skips some invalid records; successful loading alone is weaker than lossless import. Require independent parse/coverage evidence and never publish raw parse-error lines from private archives.

Cross-host feasibility: staged native bytes plus all referenced history prefixes, a compatible provider build, and an explicit Linux workspace mapping. Do not merge Mac databases/configuration into the shared daemon's home, copy authentication, or rewrite `/Users/...` inside archived prose. Historical Git branch/commit metadata is evidence, not a checkout snapshot. Runtime paths can change while quoted paths remain historical.

Concierge already proves Codex native fork boundaries and prevents initial goal continuation in [provider sessions](../architecture/PROVIDER-SESSIONS.md#provider-session-forks). A consultation must also clear/disable any inherited goal in the **child** before its explicit turn; `deferGoalContinuation` alone only postpones the first automatic continuation. The source goal must remain untouched.

### Claude Code

[Current session documentation](https://code.claude.com/docs/en/agent-sdk/sessions) explicitly supports moving native transcript files between hosts. CLI 2.1.223+ can locate a UUID beyond the current project directory; older bundled CLIs search more narrowly. `CLAUDE_CONFIG_DIR` selects a separate store. A `SessionStore` is another supported mechanism, but its key includes the working directory. Current lookup support is not proof that every old transcript version is accepted unchanged.

Native `--resume <id> --fork-session` creates a child. More importantly, the [official session-browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser) documents offline `fork_session(..., up_to_message_id=...)`: it writes a distinct session with remapped message IDs without running the model. Current [SDK options](https://github.com/anthropics/claude-agent-sdk-python/blob/699256ce11c0454a75178b5e086a565a0f1debba/src/claude_agent_sdk/types.py#L2170) also expose inclusive `resume_session_at` and a discarded-turn guard. This revises a blanket claim that Claude cannot fork at a point. **Concierge's current adapter has not proven that capability**, so its existing point-in-time rejection remains correct until integrated acceptance establishes it. A message cutoff must include the terminal records of the kept turn, not merely its last visible assistant paragraph.

Compacted history is not automatically expanded. The SDK's [conversation-chain reader](https://github.com/anthropics/claude-agent-sdk-python/blob/699256ce11c0454a75178b5e086a565a0f1debba/src/claude_agent_sdk/_internal/sessions.py#L933) intentionally does not follow the logical pre-compaction parent when reconstructing its message view. A rendered export and native persisted history are separate representations.

[File checkpoints](https://code.claude.com/docs/en/agent-sdk/file-checkpointing) are separate from conversation state and cover particular file-edit tools, not every shell or subagent side effect. [Permission restoration](https://code.claude.com/docs/en/sessions) varies by entrypoint/version; neither saved permission mode nor “plan” text should serve as the consultation security boundary. No guarantee is made for historical model availability, prompt-cache state, private server state, old plugins, or expired assets.

### ChatGPT exports

No export was supplied or searched for in private account data. Treat its exact schema as an import unknown. OpenAI documents [data export](https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data), and its [transfer procedure](https://help.openai.com/en/articles/9106926-transferring-conversations-from-1-chatgpt-account-to-another-chatgpt-account) explicitly describes reference material in a new chat, not restoration of old chats, memories, custom instructions, GPTs, or account configuration.

An export can support role-preserving reconstruction if actual role fields are present. If it contains a node/parent mapping, select the intended leaf and walk that branch; do not assume one flat array or the newest timestamp identifies the visible conversation. Inspect regenerated alternatives, tool entries, timestamps, attachments, citations, and export splitting in a consented fixture. Files or URLs referenced by the export are not proof of portable content. There is no verified ChatGPT-export-to-Codex/Claude native-resume contract in this investigation.

## 3. OpenClaw adoption: concrete reuse, with fidelity separated

This assessment is of the supplied local commit, not an assertion that every OpenClaw installation behaves the same way. The important discovery is **two parallel representations: provider execution binding and an OpenClaw display/history mirror**.

| Provider path at `df9b553…` | Confirmed source behavior | Consequence for this design |
| --- | --- | --- |
| Claude | [Adoption](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/anthropic/session-catalog-continue.ts#L126) records the native ID with `forceReuse` and `forkNextResume`; [CLI backend](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/anthropic/cli-backend.ts#L210) maps to `--resume`/`--fork-session`. A separate bounded history import is performed. | Native child continuity, not just a prompt reconstructed from that mirror. Adoption does not itself prove the child has run. |
| Codex | [Adoption](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/codex/src/session-catalog-adoption.ts#L335) binds a source thread, terminal boundary, and pinned connection; [first-run materialization](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/codex/src/app-server/thread-supervision.ts#L90) invokes native `thread/fork`. | Strong reference for source identity, frozen boundary, new child identity, and ambiguous-fork handling. Do not copy its entire supervision subsystem. |
| Pi | [Adoption](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/acpx/src/pi-session-catalog-runtime.ts#L94) records an ACP agent/native session ID and imports a bounded mirror. Paired-node catalog continuation is disabled in this path; terminal access is separate. | Intended native continuity through an ACP runtime. No consultation-specific child fork is established by this adoption code. Actual Pi adapter load and source immutability remain acceptance requirements. |
| OpenCode | [Adoption](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/opencode/session-catalog-plugin.ts#L167) likewise stores an ACP binding to the native ID and imports display history. | Same distinction: a native binding is not evidence of cross-host archive portability or a read-only fork. |

The [ACP owner](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/src/acp/control-plane/manager.runtime-handle-ensure.ts#L90) passes persisted resume identity to its runtime. That is materially different from merely putting old text in a prompt. It still requires the adapter and native store to resolve that identity.

Conversely, the [generic catalog importer](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/src/plugins/session-catalog-history-import.ts#L9) retains a recent window bounded by 200 items/512 KiB, drops raw payloads, and renders non-user tool/reasoning items as assistant text. Claude's [mirror](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/anthropic/session-catalog-history.ts#L8) follows a similar presentation conversion. This is lossy history suitable for display; it is not a lossless portable model context. Native Codex also has [fresh/stale-binding prompt projection paths](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/extensions/codex/src/app-server/run-attempt-prompt.ts#L379), so report fidelity per executed consultation, not once when a catalog row is adopted.

**Reuse:** exact `(provider, host/store, native ID)` addressing, capability-gated continuation, a child identity, independent mirror provenance, and immutable source-boundary evidence. OpenClaw distinguishes model-context sessions from external conversation addresses; keep that separation without adopting its messaging machinery. Its [upstream awareness](https://github.com/openclaw/openclaw/blob/df9b55315051b17914c29c0d20ac4ae23859e519/docs/concepts/session-state.md#L50) polls watched native sessions. Archive consultation has no requirement for that monitoring, and importing its gateway would compete with Concierge's lifecycle ownership.

## 4. Pi and a small alternative-harness comparison

“monopie” is interpreted tentatively as Pi/pi-mono. The old `badlogic/pi-mono` URL currently redirects to `earendil-works/pi`; the reviewed source pin is `f9bcd351dc3cedf989bc5fc0f8aa012db5737df2`. This naming observation is not confirmation of the voice reference.

**Pi's concrete advantage:** a documented [session tree format](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/coding-agent/docs/session-format.md), [branch/clone operations](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/coding-agent/docs/sessions.md), an [embeddable SDK](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/coding-agent/docs/sdk.md), and direct control over model-facing messages/tools. Tree navigation can add a branch summary; [compaction](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/coding-agent/docs/compaction.md) uses a summary plus a retained tail. Those features make it a useful substrate for explicitly reconstructed consultations.

Its [cross-provider conversion](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/ai/README.md#cross-provider-handoffs) transforms provider-specific content for compatibility, including converting other-provider thinking blocks into tagged text. That is a transformation, not preservation of hidden model state. Do not promote that feature into a requirement to expose historical reasoning. Public replies should summarize conclusions and cite evidence; opaque/redacted reasoning should remain opaque.

Pi's [`importFromJsonl`](https://github.com/earendil-works/pi/blob/f9bcd351dc3cedf989bc5fc0f8aa012db5737df2/packages/coding-agent/src/core/agent-session-runtime.ts#L361) copies a file into Pi storage and opens it with `SessionManager`; it is not a demonstrated converter for arbitrary Claude/Codex/ChatGPT formats. Legacy Pi files may migrate on load. Preserve originals, create a distinct consultation identity, and test format conversion on a staging copy. SDK tool selection is useful, but runtime extensions and host permissions still need explicit isolation.

| Option | Concrete gain | What it does not establish | Decision for this scope |
| --- | --- | --- | --- |
| Existing native adapters | Highest supported same-provider continuity; existing Concierge admission and delivery ownership | Cross-host asset completeness or old-version compatibility | Default for proven native children |
| Pi SDK/runtime | Explicit message representation, tree operations, controlled tool set, multiple model providers | Native Claude/Codex identity, hidden state, foreign archive decoder | Optional reconstruction adapter if approved |
| OpenClaw adoption | Working source patterns for native bindings plus separate mirrors | Universal lossless import; read-only defaults; absence of fallback reconstruction | Reuse patterns/test ideas, not a second gateway |
| OpenCode | Documented [JSON export/import](https://opencode.ai/docs/cli/#import), headless server, [typed SDK](https://opencode.ai/docs/sdk/) and context-only `noReply` messaging | Its JSON import is not a promise to accept foreign native archives | Useful when importing OpenCode itself; no reason to replace current adapters |
| Amplifier | Modular providers/tools and its own persistent sessions | No demonstrated native archive adoption advantage in the reviewed [README](https://github.com/microsoft/amplifier/blob/28588b93886dd4b134f131294ca98e944d71cbfd/README.md) | Do not add it for this requirement |

**Protocol versus runtime:** Pi RPC, Codex App Server JSON-RPC, and ACP expose runtime operations. ACP's [session-load capability](https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions) is negotiated; replaying history to a client does not specify a universal disk format, migrate another provider's model state, or restore a machine. MCP/tool connectivity likewise does not establish session continuity. The wider communication-protocol comparison is intentionally left to the coordinator.

## 5. Minimal lineage and fidelity contract

Include this metadata in the session/request contract being designed by the coordinator. It is a logical contract, not authorization for a new database, daemon, catalog, or workflow engine. Search returns a candidate source reference; a consultation freezes that reference and its boundary before invoking Concierge.

| Group | Required evidence |
| --- | --- |
| Source snapshot | Provider/product, originating host/store namespace, opaque native identity, archive object locator, byte hash/length, capture time, originating schema/CLI version when known; distinguish unknown from empty |
| Selected history | Exact branch/leaf and inclusive/exclusive cutoff; provider turn/message ID plus snapshot-relative record locator; dependency hashes for prefixes/sidecars; completed/partial status |
| Lineage | New service consultation ID, source reference, native parent/child IDs when proven; relationship `native_fork`, `reconstructed_from`, or `context_from`; never fabricate native parentage |
| Transformation | Importer/version, selected roles/items, original-to-derived ID map or opaque source locators, omissions/conversions/redactions, effective-context versus historical-expansion choice, input digest |
| Fidelity facets | Message/role coverage; branch proof; compaction treatment; tool pairing/status; asset availability; model/instruction differences; environment provenance; each with evidence and `verified`, `partial`, `missing`, or `unknown` |
| Execution/result | Requested and provider-reported model/runtime, actual returned provider identity, effective permissions/tools, workspace snapshot mapping, exact current review question and reviewed artifact/diff hash, output artifact/source citations |

Do not compress this into a percentage or “full fidelity” badge. Native mode can have missing attachments; reconstruction can include evidence absent from the native compacted context. Display a short honest statement, for example: **“Native Claude child through message X; old tools are historical; current repository snapshot; two attachments unavailable.”** Use synthetic IDs in documentation and opaque references in cross-session messages.

Surface identity stays separate: Thinkering selection ID, Slack reply root, and provider thread UUID are not interchangeable. The archive source is never itself marked running because a consultation about it exists.

## 6. Consultation defaults and ownership

1. **New child, immutable source.** Direct resume of an original historical session is a separate explicit action. Native loading/migration happens only from an isolated staging copy; never point a writer at the transport archive. Do not reuse a child merely because the source matches: separate questions may require separate consultations.
2. **Read-only by enforcement.** Start with no tools for transcript-only consultation; optionally allow scoped read/search against an explicit repository snapshot. Disable write/shell execution, external-send tools, unneeded MCP servers, hooks, extensions, and background goals. Tool-name allowlists and a “review only” prompt alone do not constrain arbitrary shell, sockets, or loaded hooks. Use existing sandbox facilities and controlled working/state directories; authentication is supplied independently through the existing credential boundary.
3. **Historical instructions are evidence.** The current consultation question, allowed sources, and permissions govern the run. Explicitly identify any enriched evidence. Never execute recorded tool calls to “rebuild” the past. A tool receipt describes an old observation, not current filesystem truth.
4. **Choose review semantics.** “Ask the prior agent why it chose X” may use a native child. “Independently review today's diff” uses fresh context containing the requirement, exact diff, and selected historical facts; label any inherited implementation history as a loss of independence.
5. **Existing owners remain owners.** Thinkering selects sources and presents results. The shared service holds consultation lineage and intent independently of UI. Concierge owns provider admission, sessions, cancellation, and durable result delivery. Remote-box owns archive transport. This brief does not redefine the search owner's index or the coordinator's wire protocol.

No recurring application work is needed for a selected archive consultation. Trigger: explicit consultation request. Work: parse/copy the selected snapshot and its required dependencies, then one bounded provider task. Growth variable: selected bytes/items; preparation is linear in that material, independent of the rest of the archive. Idle cost: zero. Stop: result, cancellation, or configured task limit. Oversized history yields an explicit narrower selection or disclosed compaction, not silent tail truncation. A manifest/parser can stream preparation; active context remains subject to the destination model's actual capacity. Ordinary archive transport continues under its existing owner.

## 7. Acceptance evidence required before import can be offered

These are the acceptance criteria for one complete future delivery, not implementation phases. None of the live checks below were performed in this design task.

| Evidence | What must be established |
| --- | --- |
| Source immutability | Before/after hashes for the source and referenced files; native migrations and new turns write only to a distinct staging/child store |
| Exact selection | Synthetic branched fixture with distinguishable sibling facts; imported/native context includes the selected boundary and excludes later/sibling entries; subagent history stays explicitly separate |
| Compaction | A fixture containing old raw messages, a summary, and a retained tail proves the declared effective-context/expansion policy without duplicating both representations |
| Native identity | Provider receipts/readback prove distinct child ID, correct native parent/cutoff where available, and continuity across a subsequent child turn; a fluent answer or imported UI transcript is insufficient |
| Version and host | At least representative old Mac and current Linux format families, explicit `/Users/...` to Linux runtime mapping, absent cwd/assets, unknown event types, and dependent rollout prefixes; report supported versions, not universal compatibility |
| Tools and attachments | Completed and interrupted tool pairs, inline image, external asset, missing/truncated tool output, and redacted/opaque block fixtures; no historical tool execution or invented success |
| Read-only boundary | Deterministic denied-write/send probes, disabled hook/extension execution, no source-store write, no inherited goal auto-start; verify effective permissions, not requested flags alone |
| Reconstruction | Capture a sanitized model-request envelope from fixtures to prove actual roles, item ordering, tool pairing/conversion, and omissions; preserve raw source separately; reject unsupported native-history injection |
| Duplicate/ambiguous outcomes | Same import request binds one child/result; lost creation response cannot lead to blind refork/republication. Unknown native identity remains unresolved through the existing owner |
| ChatGPT | One explicitly supplied export fixture establishes real schema, branch selection, part/asset coverage, and account-state exclusions; unknown structures remain inspectable but not falsely resumable |
| Surface independence | The same consultation contract works from Thinkering and a non-UI caller without encoding Slack routing as provider identity; result references the exact selected source and reviewed artifact |

Fixture decoding and message-envelope checks should establish fidelity before any consented historical consultation. The eventual Concierge implementation must also exercise the nearest behavior through its claimed Slack sandbox; that does not authorize production reproduction traffic. Compare selected sample hashes again when materializing, since the transport may have advanced them.

## Concrete unknowns and next decision

- Installed CLI schemas were inspected, **not the active daemon's negotiated schema**. Compatibility and archive-path behavior need a future contained acceptance run.
- Whether old Mac Claude versions and pre-modern Codex rollouts restore without discarded records, migrations, or changed compacted context is unknown. JSON parsing is not semantic validation.
- Current Anthropic SDK supports offline/message-boundary forks, but Concierge still needs exact message/turn mapping and adapter tests before exposing it.
- The archive's attachment/checkpoint coverage is unproven. No complete asset inventory or full-corpus semantic validation was attempted.
- OpenClaw's native binding paths are confirmed in source; their behavior on these transported archives is untested. Pi/OpenCode adoption does not prove a safe consultation fork, and per-run fallback mode must be observable.
- The ChatGPT export shape and asset coverage remain unknown until a sample is explicitly supplied.
- Native loading may preserve old instructions while enforcing new permissions. How much of the original prompt/tool/model configuration can be attested is provider/version dependent; no bitwise prompt equivalence, cache preservation, or deterministic answer reproduction is promised.

**Recommended decision:** define the three fidelity modes and source-boundary manifest in the shared service contract; retain native adapters as the default; reuse OpenClaw's identity/binding distinction; consider Pi only for explicit foreign-history reconstruction. Require the complete acceptance evidence above before advertising any imported session as natively resumable.

### Primary-source access notes

Research pins: Codex `4199fda578f625e834798782bd358cd39f29ce26`; Pi `f9bcd351dc3cedf989bc5fc0f8aa012db5737df2`; Anthropic Python SDK `699256ce11c0454a75178b5e086a565a0f1debba`; Amplifier `28588b93886dd4b134f131294ca98e944d71cbfd`. Upstream source pins and local executable versions are distinct evidence.

Some direct Markdown/HTML fetches from Claude/OpenCode returned 403; browser retrieval of the cited session, checkpoint, cookbook, CLI and SDK pages succeeded. The large Claude TypeScript reference could not be opened by the browser tool, so exact point-in-time options are grounded in the official Python source and cookbook. Old Pi/Codex source paths returned 404; repository trees resolved their current paths. No forum complaint or search snippet was treated as the authority for a missing feature.
