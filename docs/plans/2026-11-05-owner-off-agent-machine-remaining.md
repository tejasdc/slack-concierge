# What still ties the owner to the agents' machine (2026-11-05)

Status: **inventory and plan, not built.** Evidence for the remaining items of
[Runners](../architecture/RUNNERS.md) "Not on runners yet" after the runner took over the Codex App
Server, Codex thread folders and durable watches (branch `worktree-runners-no-same-machine`).
Line numbers are from that branch; verify before building on them.

The pattern for every item: the owner keeps the decision and the ledger; the reading or action
happens on the runner, as a [runner machine call](../architecture/RUNNERS.md#runner-machine-calls)
(`{method, params}` answered by the same local function, `watch-machine.ts` is the model) or, for a
long or interactive process, as a runner job. E = stateless read (one call), M = state on both sides
or several calls, H = long, interactive, or tied to restarting the App Server.

## 1. Provider account readings and account folders (item 4)

- `provider-account-usage.ts:587` `refreshProviderAccountUsage` (timer at `index.ts:3995`,
  `session-runtime.ts:167`, ~10 other callers) runs CodexBar per `~/.codex*` home (:222), `cswap list`
  (:333), `agy models` / `agy -p /usage` (:404-434), and `claudeAccountFacts`
  (`claude-account-facts.ts:194-262`: reads `.credentials.json`, calls api.anthropic.com). **E/M**:
  a `accounts.readings` call returning the `ProviderUsage` JSON; the owner keeps holds and the
  allowance decision.
- `provider-accounts.ts:56-57,198-211` `currentAccount` / `credentialPath` (34 call sites via
  `currentAccount`/`accountScope`), `:150-162` `refreshClaudeAccount` (`claude auth status`, every
  3 min, `index.ts:4006`), `:227-305,391-417` profile listing and legacy adoption. **M**: the runner
  reports account identity with its readings; the owner caches.
- `provider-account-dispatch.ts:66-116,314` `sharedClaudeHome` / `chooseClaudeDispatch`: the chosen
  Claude home becomes `CLAUDE_CONFIG_DIR` (`turn-execution.ts:659`) and travels to the runner as an
  owner path. **M**: the job should name the account; the runner resolves its own home.
- `codex-reset-credit.ts:26-136` reads account `auth.json`, runs `codex app-server --stdio`. **M**.

## 2. Sign-in commands (item 4)

- `auth-login.ts:145-160` starts provider CLIs on the owner; `claude-account-login.ts:71-127`,
  `codex-account-login.ts:46-115` write `~/.claude-accounts` / `~/.codex-accounts`. **H**
  (interactive, a code pasted back): a runner job with commands for the pasted code.
- `codex-device-login.ts` already uses the relayed App Server. `signin-renewal.ts` is ledger only.
- `session-execution-host.ts:436-510` `checkHeldUsage` starts a **local** `claude` (not hosted). **M**.

## 3. Account switching (item 2)

- `provider-activation.ts:111-156` `activateCodexNow` restarts the **owner's** App Server
  (`daemon restart`, `/proc` reads, socket moved aside), while `codexCredentialsAnswer` (:341) asks
  the **relayed** one. With a runner on another machine these disagree. **H**: becomes a runner call
  (`codex.restartForAccount`), since the runner supervises the App Server; the runner's start must
  also honour the switch hold (`holdCodexDaemonAutoStart` only holds the owner's own process).
- `:213-255` `repairUnmanagedCodexServer` at startup (`index.ts:3999`) repairs the owner's local
  server even when relayed. **H**, same call.
- `:285-335` `claudeAccountWorks` runs `claude -p` on the owner with the owner's workspace and hook
  settings (background `provider-account-dispatch.ts:143`, every switch
  `session-execution-host.ts:633`). **M/H**: a probe turn on the runner.
- `:419-471` `watchAuthHeldCredentials` watches the owner's credential folders. **M**: runner events.

## 4. Provider history and transcripts (item 4)

- Claude history: `provider-history.ts:438-563` (`sourceVersion`, import and verify child processes,
  `prepareClaudeHistory`), `provider-history-warmer.ts`, `claude-queued-messages.ts:68-88` read
  `~/.claude/projects`; `forkClaudeHistory` (:906) writes there. **M**: the runner returns transcript
  rows or bytes; the owner keeps the cache.
- Codex timestamps: `provider-transcript-metadata.ts:79-118` stats `~/.codex/sessions`. **E**.
- Writes into provider homes: `session-owner.ts:3554-3609` (native resurrection),
  `session-peers.ts:446-500` (peer resurrection). **M**.
- Reads: `session-handoff.ts:87-130` (rollouts and `git worktree list`), `commit-work.ts:42-70`,
  `usage-breakdown.ts:59-75` (+ `scripts/usage-breakdown-reader.ts`). **E/M**.
- Side questions: `session-asides.ts:91-163` start a local `claude`/`codex` and fork a transcript. **M**.

## 5. Google and outside Codex (item 2)

- `antigravity.ts:16-34` `antigravityExecutable` reads `~/.gemini/antigravity-cli/settings.json`
  (paid-credit guard); used at `providers.ts:135`, `session-execution-host.ts:1236`,
  `provider-account-usage.ts:401`. **E** for the guard; launching on a runner also needs
  `onRunner` (`session-execution-host.ts:1185`, Claude only today) widened.
- `outside-codex.ts:64-82`: prompt file at `<owner state>/outside-prompts/<id>`
  (`session-execution-host.ts:1383`). **M**: send the prompt as job file bytes, as attachments are.

## 6. Post-turn Codex audit (item 2)

- `codex-leftover-processes.ts:7-45` reads the owner's `/proc` (`CODEX_THREAD_ID`, the App Server
  scope); callers `session-execution-host.ts:1014,1080`. With the relay on it **silently finds
  nothing**. **E**: `codex.leftoverProcesses` / `codex.processAlive` calls on the runner.
- The Codex Remote observer reads no `/proc` and is built only in the Slack composition
  (`index.ts:4310`): retired with Slack, nothing to move.

## 7. Projects and hook settings (item 5)

- A turn's folder comes from session metadata or `defaultCwd` (`session-execution-host.ts:710,1182`,
  `index.ts:376`); the runner only checks it exists (`runner.ts`, turn start). Owner-side reads of
  project folders: `session-projects.ts:19-83`, `session-owner.ts:1494-1560` (listing, AGENTS.md and
  to-do files), `workspace-files.ts`, `routed-request-api.ts:57` (links judged by reading files),
  `project-setup.ts:124-424` (`git`, `gh`). Plan: jobs name a project; the runner resolves its folder;
  project reads become runner calls.
- Claude hook settings (`claude-code.ts:461-470`, passed as `--settings` at :443) embed the owner's
  Bun path (`process.execPath`), the owner's helper suffix and `/etc/codex/hooks/…`; the runner
  forwards the arguments unchanged. **E**: build them on the runner, or reference `$CONCIERGE_BUN_BIN`.
- `session-input-context.ts:9-10` puts the owner's `~/.local/bin/router-actions.sh` path into prompts.
- Possible bug, unverified: a native turn's empty attachment folder (`turn-execution.ts:460`) is
  passed as `--add-dir` but not created on the runner.

## 8. The acceptance run

"Moving the owner" has no prerequisite left only when a run with the owner's state, home folders and
workspace hidden from every runner-started process (turn hosts, watch hosts, the App Server and its
shells) completes a Claude turn, a Codex turn, a file and a command watch, an account reading and a
sign-in. On the AX41 the runner shares `/root` with the owner, so that run needs the runner to have
its own home and checkouts (or a second machine).
