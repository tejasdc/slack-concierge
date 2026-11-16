# Mac account experiments — 2026-11-12

Status: preregistered before any new model request. Append observations below; do not rewrite this plan.

## Question and scope

On the Mac, do two separate saved first-party Claude homes still serve simultaneous harmless requests, and can one fresh saved conversation resume under the other saved account with its original context? This is a local CLI/account test only. The current Codex controller session remains on its current account. No credential is copied, rewritten, switched, or signed out. No app, Concierge service, or unrelated session is stopped.

## Baseline observed before model requests

- Machine and project: Mac, `/Users/tejasdc/workspace/slack-concierge`.
- Direct Mac owner read: `/sessions/v1/auth/providers?machine=mac`; read only, no `fresh=1` renewal.
- Claude owner profiles: `hey@tejas.nyc`, `tejas@chann.app`, and `tejastej.dc@gmail.com`, all signed in. Source readings: Hey weekly 80% at `2026-11-12T19:30:11.337Z`; Chann weekly 76% at `2026-11-12T19:32:50.268Z`; Gmail weekly 5% at `2026-11-12T19:30:15.312Z`.
- Codex owner view: current account Chann at 11% weekly, source time `2026-11-12T19:33:34Z`; saved Gmail at 100%, source time `2026-11-12T19:33:36Z`, reset `2026-11-13T16:14:44Z`. The running controller is Mac session `concierge:314` on Codex. No Codex account switch or second-account test will be attempted while that controller is running; Gmail tests that need allowance remain blocked.
- `claude auth status --json`, through the installed `claude` command with the explicit saved-home pin, confirmed `loggedIn: true`, `authMethod: claude.ai`, `apiProvider: firstParty`, and matching `configDirectory` for each of the three home/profile pairs: `hey-tejas-nyc` → `hey@tejas.nyc`; `tejas-chann-app` → `tejas@chann.app`; `tejastej-dc-gmail-com` → `tejastej.dc@gmail.com`.
- Each saved home’s `projects` entry is a symlink to `/Users/tejasdc/.claude/projects`; this is the history path needed for cross-home resume.
- Prior retained evidence: `mac-two-accounts.md` records the first attempt/refusal; `mac-shared-history.md` records the September 23 concurrency and cross-account continuation proof. Those historical runs are not counted as current results.

## prereg-v1

### Cell A — concurrent Claude requests, Hey and Chann

- Question: can two distinct confirmed Mac Claude homes each complete a no-tools turn while their calls overlap?
- Method: start one fresh, explicitly pinned saved-session request from each profile at the same time using the installed Concierge `claude` command, the Sonnet alias, and an empty tool set. Use separate new session IDs and synthetic single-word markers. Save only output text, process status/times, session IDs, and identity-only before/after auth status.
- Pass: both exit successfully; each returns only its own marker; both provider sessions are confirmed under their intended account before and after; request intervals overlap.
- Fail: an identity mismatch, account refusal, nonzero exit, wrong result, or non-overlapping provider intervals. A refusal is retained as the result; do not retry that cell.
- Safety: no interactive tools, no external actions, no account switch, and no credential operations. Do not retry a possibly accepted session ID.

### Cell B — saved-session continuation across Hey and Chann

- Question: can Chann resume the exact session first created under Hey and recover synthetic context from its prior turn?
- Method: create one fresh session UUID under Hey, store a synthetic marker in that conversation, then resume that same UUID once under Chann and request the marker. Use a separate temporary working directory with no repository files and an empty tool set. Record the provider session UUID and identity-only auth status before/after.
- Pass: both provider results succeed, the resume reports the identical UUID, and the exact marker is recalled; auth status continues to show Hey for the first request and Chann for the second.
- Fail: not found, UUID mismatch, wrong marker, identity mismatch, or refusal. Do not retry an ambiguous turn or reuse the UUID for a new test.
- Safety: only synthetic text; no tools, no login or credential change. The one intended persistent session is retained in existing Claude shared history.

### Cell C — interrupted-turn recovery boundary

- The current local CLI path cannot prove Concierge automatic owner recovery without interrupting an owner-managed turn or process. The independent server crash-recovery test is already being repaired in outside session 9467. Do not duplicate that crash test, kill a Concierge process, or label a standalone CLI resume as owner recovery. Record this cell as untested unless a non-disruptive, owner-supported isolated recovery path is established from existing documentation.

### Codex boundary

- Do not switch the shared Mac Codex App Server while `concierge:314` is running. Current Chann allowance is available; saved Gmail is at 100% until the reported reset. No Codex cross-account concurrency or interruption cell is safe under this baseline. Report those cells as blocked/unrun, not passed.

## Observations

### Preflight

- 2026-11-12: read-only profile and direct CLI identity checks completed for all three Claude homes; no secret value was read or emitted. `claude --help` confirms support for persistent session IDs, resume, and an empty tool set.
- 2026-11-12: current Mac session catalogue read showed the controlling Codex session `concierge:314` running; this session was left untouched.

### Cell A — concurrent Claude requests

- Passed on the Mac with saved homes Hey and Chann, using Sonnet and an empty tool set. The installed `claude` command received two separate session IDs: `0b941e6c-d506-480c-a228-13db58fd0405` (Hey) and `d8704043-c384-4cb2-bcec-214b62a75d73` (Chann).
- The retained provider transcript metadata records the Hey API request at `2026-11-12T19:39:08.390Z` and its assistant response at `19:39:10.509Z`; Chann's API request began at `19:39:08.392Z` and its response arrived at `19:39:09.295Z`. Those provider intervals overlap for about 903 ms. Each process exited 0 and returned only its own marker (`MAC-HEY-READY-1126` or `MAC-CHANN-READY-1126`).
- Exact Claude auth status before and after each request continued to report the intended first-party account and exact saved home. No account sign-in, sign-out, or credential operation was performed. The session UUID files are present in the shared Claude history path.
- File receipts: `cell-a/hey.*` and `cell-a/chann.*`; outputs contain only identity status, synthetic result text, exit status, process timestamps, and empty stderr. The API/response times above were read from the provider transcript metadata without reading message or credential contents.

### Cell B — saved-session continuation across accounts

- Passed on the Mac. Hey created saved conversation `939d0cc0-c8b3-452a-9699-e3b0bf85732e` and returned `STORED` after receiving synthetic marker `OAK-314-TEAL`. Chann resumed that exact UUID and returned `OAK-314-TEAL`.
- Provider transcript metadata records the Hey API request/response at `19:39:58.866Z` / `19:40:00.570Z` and the Chann resume at `19:40:03.473Z` / `19:40:04.754Z`. Auth status before and after each call remained the exact intended first-party identity. The shared history symlink was checked before the test.
- This proves a completed, idle saved Claude conversation can continue across these two saved homes. It does not exercise Concierge's Pause/Continue controls or automatic recovery of a killed owner-managed turn.
- File receipts: `cell-b/hey.*` and `cell-b/chann.*`. The session UUID file exists in the shared history path.

### Cell C first attempt — no interruption observed

- 2026-11-12: the test observed the generated marker and sent SIGINT to the exact CLI process, but the retained transcript already showed `stop_reason: end_turn` at `19:46:02.235Z`; the marker was observed and the signal sent at `19:46:02.253Z`. The CLI exited 0. This was a completed turn, not an interruption. No resume was attempted.
- The first monitor waited for a newline while reading a stream format. The response timestamp preceding the signal is evidence that this monitor delivered the signal too late; it is not evidence of recovery.

## prereg-v3 — one corrected monitor attempt

Written before any retry. Keep the same no-tools, safe-mode, synthetic 1000-line response and exact saved Hey home, but monitor raw stdout bytes instead of waiting for a newline. Send SIGINT only when the generated marker bytes first appear. One attempt only. Count the interruption as observed only if the exact CLI process exits via the interrupt path before an `end_turn` result is recorded. If the model finishes first, or the terminal state is ambiguous, do not resume and do not retry again. A confirmed interrupted text-only conversation may get one new Chann follow-up under the same UUID; never resubmit the original prompt. This remains manual CLI continuation only, not automatic Concierge recovery.

## prereg-v2 — manual CLI interruption boundary

Written before any interruption attempt. Cell C adds only a safe provider-CLI manual recovery observation: start one long, synthetic, no-tools response under Hey in a fresh saved session, wait until its first generated marker is actually observed, send SIGINT to that exact CLI process, and record the provider's terminal result. Resume the same session once under Chann with a new follow-up only if the CLI reports a confirmed interruption; never resend the original prompt. Stop without resume on an ambiguous terminal outcome. No Concierge process, other agent session, shared Codex account, or application is interrupted.

Pass for the manual cell: exact CLI process exits with a confirmed interruption, and one new Chann follow-up in the same saved session sees the marker. Failure/refusal is retained without retry. This is not a test of automatic Concierge recovery; that remains separately unproven while the server recovery repair is in progress.


### Cell C corrected interruption and Chann continuation

- The raw-byte monitor observed the Hey marker and signalled only the exact CLI process at `2026-11-12T19:48:49.749604Z`. Hey session `62c2f4cc-a3fe-48fa-9638-91d4a3deccfb` produced a partial assistant record with no terminal `end_turn`; the CLI exited 0. The signal followed marker observation by about 0.08 ms, so this is a local partial-turn interruption observation; a separate provider cancellation acknowledgement is not established.
- One allowed follow-up ran under Chann in that exact session at `2026-11-12T19:49:58.291680Z`–`19:50:00.051565Z`. It returned `RECOVERED`; before and after auth status both reported `tejas@chann.app` and the exact Chann home. This confirms manual continuation can read the synthetic beginning marker after the interrupted Hey response. The original prompt was not replayed.
- This does not prove automatic Concierge recovery or Pause/Continue UI behavior. The separate server-owned crash-recovery fix remains outside this experiment.
- Trace files: `cell-c/result-metadata-retry.json`, `cell-c/hey.auth.before-retry.json`, `cell-c/hey.auth.after-retry.json`, and `cell-c/chann.resume.*`.
