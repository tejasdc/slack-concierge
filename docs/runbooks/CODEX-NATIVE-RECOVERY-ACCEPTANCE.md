# Native Codex recovery acceptance

This is the finite live procedure for the source-bound native Codex controls. It is not a local
fixture and must wait for a reviewed release installed on the machine being checked. Do not run it
from this candidate worktree.

## Controller and authority

Use a live Claude Code session or finite Claude host job as the controller. It remains the live
non-Codex source for Concierge commands and runs one standalone Codex CLI process as its tracked
native helper, following the `codex-cli` skill. The helper is the experiment agent; the Claude
session is the accountable host and returns its evidence. Record both provider/model identities,
machine, project folder, source input/run, and returned thread. The helper must use an already
signed-in Codex home whose authentication is not changed by the tested shared native account
switch. Verify that before starting the target. Do not copy credentials or alter the home.
Start a fresh helper instead of resuming a Codex session [decision: do-not-resume-codex-sessions-for-now].

An ordinary outside Concierge Codex session is not an independent controller: its native run is
counted by the guarded account switch. Use the existing cross-provider helper route; do not add an
exclusion or broaden switch authority. The switch stays idle-only and uses its existing restart.
If it refuses, keep the work and report the refusal.

## Before either trial

1. Confirm the reviewed release is installed, the actual runner/socket and Codex account are known,
   the room is correct, and the controller has its own independent connection.
2. Confirm no other accepted work will be interrupted. Record a finite deadline before creating a
   target. The deadline is an observation boundary, not permission to settle or delete work.
3. Preserve the account-switch baseline separately: continue the original native thread through
   the unchanged shared-client path, and verify its same UUID continues under the daemon account
   selected by the guarded switch. Do not substitute a newly created conversation for this
   baseline observation.
4. For fault trials, have the controller create a separate disposable native Codex session through
   normal admission using `sessions ask --provider <Codex alias> --project <registered-project>
   --codex-native-test-until <finite future ISO-8601 time>`. Keep its exact `concierge:<id>`,
   creation request ID, accepted run ID, source input/run pair, provider thread ID and provider turn
   ID. Ordinary agent-created Codex sessions are not opted in and remain on the shared client.
5. Use `router-actions.sh sessions codex-test connection-loss concierge:<id> --create
   request:<uuid> --run <native-run-id> --source-input <controller-input> --source-run
   <controller-run> --action-id <stable-id>` for exactly one loss on the positive target. The
   action is source-bound and one-time. Do not retry with a new action ID.

## Positive recovery

After the loss receipt reports `observed`, let ordinary recovery follow the same accepted input,
native run, provider thread, provider turn and checkpoint. Verify from owner receipts and provider
history that no replacement `turn/start` was issued and the same work reached one terminal result.
The observed bridge disconnect by itself is not recovery proof.

## Stop after loss

Create a separate matched disposable target under normal admission. Capture the same identities,
then issue one `connection-loss` action and one exact-run Stop through
`router-actions.sh sessions codex-test stop concierge:<id> --create request:<uuid> --run
<native-run-id> --source-input <controller-input> --source-run <controller-run> --action-id
<stable-id>`. Verify actual ordering, the exact provider interrupt, and terminal history. If the
provider outcome is absent or unconfirmed at the declared deadline, retain the accepted work as
uncertain and owned by its original thread/run/attempt. Never resend it or describe callback
completion as provider terminal proof [decision: wait-means-hold-not-cancel].

Run one positive and one stopped target for each still-missing machine path. Preserve the existing
Mac seed 387 and controller 388 under session 9468; do not duplicate, cancel or rearm them. Close
only resources created by this controller. Restore an account only through the unchanged guarded
switch and only when it accepts without displacing unrelated work.
