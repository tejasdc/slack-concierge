# Deployment repair correction entered an unbounded restart loop

Incident snapshot: September 10, 2026. The faulty repair instance has been stopped and runtime-masked. Implementation was authorized by Tejas on September 10. Deployment completion requires the detached recovery's recorded health proof; see [repair agent lifecycle](../plans/2026-09-10-repair-agent-lifecycle.md).

## Exact identity

During implementation acceptance, the pre-existing failed-candidate-identity
shell test used the default systemd installation directory. It copied the new
repair template there while mocking `systemctl`, so no unit was started or
reloaded. The old incident remained stopped and instance-masked. The fixture
now supplies its temporary installation directory. Recovery recognizes only
the exact LKG or reviewed recovery artifact's unit bytes, recording which
artifact supplied the installed template before containment.

- Deployment run: `4d2904d3-fb95-4e2e-923b-94e693181849`.
- Repair incident: `c8cb5bb7-da17-49f9-bf35-da4f438f3019`.
- [Originating Slack thread](https://tejazz.slack.com/archives/C0BNN5K4JSJ/p1789035941981009?thread_ts=1789035941.981009&cid=C0BNN5K4JSJ): the Fable 5.1 default-model change, turn 773, desired commit `aa7f47e2543dd1d7fb5d0f02a8ac65fdf142d40a`.
- Last healthy application/control commit: `724732bcf91468416cb5b037affc8f39cfb8a870`.
- Repair session: `01a08b3f-52ca-7ec0-a415-e5b5ce272533`; first review session: `01a08b50-7556-7d13-a50d-527f7163b0ba`.

The triggering feature is attribution context, not evidence that changing a model default caused the failure.

## What failed

The rollout failed during admission drain with SQLite `database is locked`, before candidate activation. The first repair committed `0beea2e808eca9e4bb46a5896c452b35efe46214`, adding a busy timeout. Its independent review rejected the correction because the retry executes the old immutable control bundle's drain command. The repaired source succeeded under controlled writer contention while the actual installed executable still failed.

The correction resume then exposed a separate supervisor bug. `runPersistedAgent` bound the known session UUID before spawning a child, changing the attempt to `session_bound`. `recordDeploymentRepairChild` accepted only `launch_intended`, so the PID callback threw: `Repair agent child identity could not be persisted.` Output and exit handlers had not yet been installed. Systemd's ten-second restart repeated the same transition. Existing limits counted candidate failures and review verdicts, so supervisor failures never exhausted them.

At containment, systemd reported 2,939 restarts. The incident remained `repairing`; thousands of attempt records had a session UUID but no child PID or outcome. Only two actual process JSONL files exist: the initial repair and review. Both contain fresh `thread.started` events; they provide no evidence about native resume acknowledgement.

There is also a notification gap: this webhook-driven run has zero `deployment_requests` rows and one `deployment_turn_reactions` target. The current failure-notice path reads only request rows, so parking this run would update its reaction without producing the intended failure explanation.

## Containment and remaining work

The authorized containment command was:

```bash
systemctl mask --runtime --now concierge-deployment-repair@c8cb5bb7-da17-49f9-bf35-da4f438f3019.service
```

The instance stopped with MainPID 0. Concierge, capture, and the shared Codex App Server were not stopped. Application and control pointers remained on the healthy artifact. Incident records, the repair worktree, commits, and transcripts were preserved.

This runtime mask is temporary and does not survive a host restart. Do not describe containment as a deployed fix or unmask the instance into the same broken executable. The [reviewed-design work](../plans/2026-09-10-repair-agent-lifecycle.md) covers finite process attempts, exact executable verification, automatic-run failure notices, and an explicit controller recovery with durable containment. Implementation and exact-source acceptance remain required.

Evidence was read from the production SQLite ledger in read-only mode, the exact unit's systemd state and journal, its immutable installed control bundle, and the incident's recorded review and process logs. No production reproduction traffic was sent to Slack.
