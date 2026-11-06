# Finish runner independence (2026-11-06)

Tejas's request: remove Concierge's remaining same-machine assumptions for agent runs. The
control owner keeps the session ledger, choices and return position; the runner owns provider
processes, account homes, transcripts and project files. One person operates the AX41 runner and
one future app server. A runner can be unavailable; that is an unknown result, not an empty
account, history, process list or project.

## Existing mechanisms and boundary

- The authenticated runner entrance, lease engine and sequenced turn events already carry agent
  turns. The relay already carries Codex App Server traffic and short runner machine calls. The
  watcher already executes registered watches on the registering agent's runner. Use these
  channels rather than a second runner service or an owner-side copy of its filesystem.
- The owner stores a stable runner and provider account identity when a session binds. Each
  runner operation resolves its own paths from those identities and refuses a missing or
  ambiguous binding. No account home, owner state path or owner checkout path is sent as a
  runnable path. A job that cannot resolve its local prerequisite fails before starting.
- The owner chooses allowance, session routing, request disposition and Codex account activation.
  The runner performs account reads, sign-in, activation and provider-home reads/writes through
  closed operations. An unanswered call leaves the owner's obligation open for retry.
- Interactive sign-in and multi-chunk transcript writes have one operation identity and a
  terminal receipt. A disconnect cannot turn an unknown effect into a repeated effect.
- Owner startup never waits for runner readiness. A Codex turn waits at its existing readiness
  gate; Claude and the owner API continue to work while the runner reconnects.

## State card

The session is the ordered entity and the Concierge owner is its one writer. Its immutable
provider account and runner binding is recorded before provider work starts. A turn's existing
execution identity survives owner restart and runner reacquisition. The runner owns its local
process and files; its receipts and sequenced events return to the owner, which alone settles a
request. On lost contact, the owner records uncertainty and the runner's existing fence stops
unowned work. The owner does not infer a negative result from a timeout. A later read uses exact
session, turn, account and runner identities to reconcile.

## Acceptance

Build checks cover each closed operation, path refusal, old-session compatibility and runner
disconnect. The installed check runs a Claude turn, Codex turn, file watch, command watch,
account reading and sign-in status against a runner while the owner's homes and workspace are hidden
from runner processes. The interactive sign-in completion is checked with a controlled provider
fixture; a real renewal needs a provider code if no self-service credential is available. A source
or build check alone does not establish the rest of this result. The release
report names separately what was committed, installed and observed on the real runner.
