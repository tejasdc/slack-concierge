# Unlaunched execution hid a Claude conversation's runner

On 2026-11-06 at 18:56 UTC, a queued turn for session 8945 failed before provider admission with
"exact runner lease is unavailable." The latest execution record was a withdrawn runner job with
no lease or launched host. The previous execution had launched on `ax41` and finished there.
The machine-recovery query selected the newest *intent*, then treated its absent lease as proof
that the native conversation's home was unknown. The same query shaped handoff worktree reads.

## State card

- **Entity and writer:** the session owner writes execution intents and launch evidence for one
  native conversation; the runner writes its lease claim through the owner ledger.
- **Identity:** each execution has its own ID; a runner attempt is tied to that execution's job.
- **Evidence ladder:** an intent is recorded; a runner claims it; a host launches and its unit is
  recorded; provider output is retained and delivered. Only host launch can change the remembered
  machine. A missing lease for a launched runner remains an error, not a fallback.
- **Lifetime and old readers:** execution evidence survives service releases in the owner ledger.
  The query reads old rows without a schema change; older binaries retain their old behavior until
  updated.
- **Failure trace:** conversation runs on `ax41` → later runner job is recorded → job is withdrawn
  before claim → next turn selects that empty record → user sees an error without provider admission.
- **Falsifying check:** the release runner-lease check puts a launched runner execution before an
  unclaimed intent, then verifies recovery still names `ax41`. It also verifies a later launched
  local host wins and a launched runner with missing lease remains unknown.

The correction shares one launched-host query between continuation and handoff. It changes no
stored row and does not replay a failed turn. A new accepted turn must exercise the installed path
to prove recovery in production.
