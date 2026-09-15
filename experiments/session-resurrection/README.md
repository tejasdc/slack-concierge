# Historical consultation experiments

These are manually invoked research tools, separate from Concierge's runtime and deployment. [The result report](../../docs/plans/2026-09-15-session-resurrection-results.md) records the measured cases and failures. Installing this directory does not install a service, Pi coding-agent, or a second gateway.

## Prerequisites and privacy

- Linux with `bwrap`, Python 3.11+, Node 22.19.0+, and an explicitly selected provider model.
- Measured versions: Codex CLI **0.153.4**, Claude Code **2.1.263**, Pi AI **0.85.1**. A different CLI version is a new experiment, not a reproduction of this evidence.
- Install this directory's frozen dependency graph with `npm ci --ignore-scripts`. Nothing is installed globally; the bot's dependencies are separate.
- Store sources, manifests, questions, rubrics, prompts, answers, and logs in an owner-only directory outside Git. The measured cases remain at `/root/.local/share/session-resurrection-experiments/{C1,X1,G1}`. Do not upload these directories or place them in `.artifacts`.
- Authentication uses the existing account's current access token without rotating the shared credential. Pi reads the provided Codex auth file in memory. The native Codex subject receives a private auth copy with an empty refresh token; the runner deletes that copy after shutdown. Claude receives its access token in the child environment. No token appears in command arguments or report output. An expired token is a failed experiment, not permission to initiate login or refresh shared credentials.
- Native subjects see a separate mount/PID/IPC namespace: system executables are read-only; only private home and scratch directories are writable. Live homes, projects, archives, service state, managed sockets and Slack credentials are absent. Network remains available for the provider API. Claude exposes no tools/MCP; Codex disables tool-bearing features, uses read-only permissions, blocks client tool/approval requests, and disables persistent goals. The recorded calls executed zero tools.

## Prepare an explicitly selected source

Run commands from this directory. Set `CASE` to a new private case directory; `SOURCE` is a selected archive file. These shell variables contain paths, never credentials.

```bash
python3 prepare.py claude "$SOURCE" "$CASE" --leaf "$EXACT_MESSAGE_UUID"
python3 prepare.py codex "$SOURCE" "$CASE"
python3 prepare.py chatgpt "$SOURCE" "$CASE" --conversation-id "$EXACT_CONVERSATION_ID"
```

Use exactly one command for the source format. ChatGPT array exports require an exact conversation ID. An explicit `--leaf` overrides the export's `current_node`. The source bytes are copied unchanged, hashed, and never edited. The selected branch becomes `dialogue.json`; `manifest.json` retains exact identity and source location privately. Existing output files are not overwritten.

The decoder handles the observed schemas, not every historical version. It rejects malformed/broken branches, unresolved known Codex history dependencies and compacted Claude/Codex histories. It omits tools and hidden reasoning instead of creating replayable tool calls. ChatGPT text and embedded `audio_transcription.text` are retained; image/audio/video bytes, hidden context, user profile/instructions, and non-dialogue roles are omitted and counted. Attachment references are not treated as attachment contents. Other provider wrappers and export shapes need explicit inspection; there is no universal lossy fallback.

## Freeze a rubric before running subjects

Write `rubric.json` privately, with this shape:

```json
{
  "facts": [{"id":"F1","kind":"user_requirement","meaning":"Paraphrased constraint","source_ref":"M001","quote":"Exact source substring"}],
  "question":"A useful follow-up that does not supply the historical answers",
  "unknown_question":"A fact the supplied dialogue does not establish"
}
```

Use concrete user requirements and prior assistant decisions, including late corrections. Verify every quote against its exact message. Distinguish a user-role prompt from proven human authorship. Keep the rubric out of all subject inputs. The measured cases used six facts each and an Astra fixture author; all 18 source quotes were verified. This is exploratory grading, not a validated benchmark.

```bash
python3 make-inputs.py "$CASE" --model gpt-6-astra
node pi-call.mjs "$CASE/structured-input.json" "$CASE/structured-result.json" /root/.codex/auth.json
node pi-call.mjs "$CASE/baseline-input.json" "$CASE/baseline-result.json" /root/.codex/auth.json
node pi-call.mjs "$CASE/no-history-input.json" "$CASE/no-history-result.json" /root/.codex/auth.json
```

`structured` sends separate user/assistant messages. `baseline` sends the same labeled text in one user message. `no-history` receives only the question. All use Pi's documented direct provider API, no tools, one completion and an explicit timeout. This is **Pi AI context reconstruction**, not foreign JSONL import into Pi's SessionManager. An existing output path fails before another completion is requested.

Append a successful answer and a new question to demonstrate continued conversation:

```bash
python3 followup-input.py "$CASE/structured-input.json" "$CASE/structured-result.json" "$CASE/followup-question.txt" "$CASE/followup-input.json"
node pi-call.mjs "$CASE/followup-input.json" "$CASE/followup-result.json" /root/.codex/auth.json
```

## Native subjects

Each command creates a new private run directory and ends its private process when the turn settles or times out. It never connects to the managed daemon. Native-provider subjects may use their own provider/model; delegated fixture authors, scorers, implementers or reviewers must use Tejas's explicit **gpt-6-astra** constraint.

```bash
python3 native.py "$CLAUDE_CASE" native-attempt-1 --model claude-sonnet-5
python3 native.py "$CODEX_CASE" native-fork-attempt-1 --model gpt-6-astra
python3 native.py "$CODEX_CASE" native-copy-attempt-1 --model gpt-6-astra --operation resume-copy
```

Claude resumes the exact copied ID and forks at the selected message. Codex normally forks at a completed native turn. For the tested older rollout whose initial catalogue read was empty, the runner explicitly uses the frozen complete file ending in `task_complete`; it records this weaker boundary evidence. The separate `resume-copy` subject continues the same native ID **inside an isolated copied profile**. Only that disposable profile copy changes. It is not a safe recipe for registering two owners of that ID in the shared daemon.

Inspect `result.json` privately. Claude can return `subtype: success` alongside `is_error: true`; the runner treats it as a provider error. Codex terminal `failed` is not a completed consultation. Failed native imports remain failed native imports even if a separately labeled reconstruction succeeds.

## Grade and verify

```bash
python3 grade-input.py "$CASE"
node pi-call.mjs "$CASE/grade-input.json" "$CASE/grade-output.json" /root/.codex/auth.json
python3 -m unittest -v test_experiments.py
node --check pi-call.mjs
```

`--native-result <private-result.json>` adds a native answer to common-fact grading. Audit any extra native tool-derived claims against the full selected native source before judging them unsupported. A no-history subject's abstention is correct; it earns no historical-retention points. Model grading needs self-review and exact answer-quote validation. Do not publish graders' raw quotes or assume every automated judgment is correct.

`summarize.py` exports only explicit safe fields for the three measured cases. It validates source/rubric/answer hashes, model-derived enum/boolean fields, and exact fact identities; unknown omission keys become a generic count. It prints no dialogue, file contents, native IDs or private source paths. Both archive roots are rejected as output destinations. Its case list and source-input identity deliberately describe this run; change them explicitly for later experiments. The 21 tests cover source preservation, private output, canary rejection, immutable grading labels, failed-start credential cleanup, tree selection, context/media omissions, duplicate event avoidance, compaction rejection and the actual Linux filesystem boundary. They do not prove all native tools or all export versions safe.
