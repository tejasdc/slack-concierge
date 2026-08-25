import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  DeploymentControlStore,
  type ContinuationSnapshot,
  type NotificationKind,
} from "./state";
import {
  assertKernelCommand,
  authorizeKernelCommand,
  commandDigest,
  type KernelCallerRole,
  type KernelCommandEnvelope,
} from "./protocol";
import { digestProtectedKernel, loadRepairPolicy } from "./policy";
import {
  defaultReleaseManagerEnvironment,
  ImmutableReleaseManager,
  ReleaseEffectAmbiguousError,
} from "./releases";
import {
  DeterministicSlackNotifier,
  notificationClientMessageId,
  notificationDigest,
  SlackNotificationAmbiguousError,
  SlackNotificationRejectedError,
  validateNotificationProjection,
} from "./notifier";

export interface KernelEnvironment {
  repositoryRoot: string;
  policyPath: string;
  kernelRoot: string;
  originRemote: string;
  originBranch: string;
  deployScript: string;
  systemdRunBin: string;
  systemctlBin: string;
  home: string;
  drainIntervalSeconds: string;
  releaseManager?: ImmutableReleaseManager;
  notifier?: DeterministicSlackNotifier;
  applicationStatePath: string;
  slackConfigPath: string;
}

class AmbiguousEffectError extends Error {}

function requiredString(payload: Record<string, unknown>, key: string, maximum = 4096) {
  const value = payload[key];
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${key} is invalid.`);
  }
  return value;
}

function requiredInteger(payload: Record<string, unknown>, key: string, minimum = 1) {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${key} is invalid.`);
  return Number(value);
}

function optionalString(payload: Record<string, unknown>, key: string, maximum = 4096) {
  const value = payload[key];
  if (value == null) return null;
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(`${key} is invalid.`);
  return value;
}

function objectValue(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${key} must be an object.`);
  return value as Record<string, unknown>;
}

function git(repositoryRoot: string, args: string[], output: "text" | "ignore" = "text") {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repositoryRoot, ...args],
    stdout: output === "text" ? "pipe" : "ignore",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim().slice(0, 1000);
    throw new Error(`Git ${args[0]} failed${detail ? `: ${detail}` : "."}`);
  }
  return output === "text" ? result.stdout.toString().trim() : "";
}

function observeOrigin(environment: KernelEnvironment) {
  git(environment.repositoryRoot, ["fetch", "--quiet", environment.originRemote, environment.originBranch], "ignore");
  const desiredCommit = git(environment.repositoryRoot, [
    "rev-parse",
    `refs/remotes/${environment.originRemote}/${environment.originBranch}`,
  ]).toLowerCase();
  const originUrl = git(environment.repositoryRoot, ["remote", "get-url", environment.originRemote]);
  return { desiredCommit, originUrl, observedAt: new Date().toISOString() };
}

function commitExists(repositoryRoot: string, commit: string) {
  return Bun.spawnSync({
    cmd: ["git", "-C", repositoryRoot, "cat-file", "-e", `${commit}^{commit}`],
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function isAncestor(repositoryRoot: string, ancestor: string, descendant: string) {
  return Bun.spawnSync({
    cmd: ["git", "-C", repositoryRoot, "merge-base", "--is-ancestor", ancestor, descendant],
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;
}

function continuation(payload: Record<string, unknown>): ContinuationSnapshot {
  const value = objectValue(payload, "continuation");
  const providerId = requiredString(value, "provider_id", 40);
  if (providerId !== "codex" && providerId !== "claude-code") throw new Error("provider_id is invalid.");
  return {
    sourceTurnId: requiredInteger(value, "source_turn_id"),
    sourceSessionId: requiredInteger(value, "source_session_id"),
    slackChannelId: requiredString(value, "slack_channel_id", 100),
    slackThreadTs: requiredString(value, "slack_thread_ts", 100),
    requestedByUserId: optionalString(value, "requested_by_user_id", 100),
    providerId,
    providerModel: optionalString(value, "provider_model", 200),
    reasoningEffort: optionalString(value, "reasoning_effort", 100),
    providerSessionUuid: requiredString(value, "provider_session_uuid", 200),
  };
}

function entityStatus(store: DeploymentControlStore, command: KernelCommandEnvelope) {
  const { entity, id } = command.expected;
  if (entity === "target") {
    if (id !== command.target) throw new Error("Expected target identity does not match command target.");
    if (command.expected.status === "ready") return "ready";
    if (command.expected.status === "idle") return store.getActiveGeneration(command.target) ? "active" : "idle";
    throw new Error(`Unsupported target expectation ${command.expected.status}.`);
  }
  const row = entity === "intent" ? store.getIntent(id)
    : entity === "generation" ? store.getGeneration(id)
      : entity === "attempt" ? store.getAttempt(id)
        : entity === "incident" ? store.getIncident(id)
          : entity === "handoff" ? store.getHandoff(id)
            : entity === "release" ? store.getRelease(id)
              : store.getNotification(id);
  return row?.status || "missing";
}

function assertExpectedState(store: DeploymentControlStore, command: KernelCommandEnvelope) {
  const actual = entityStatus(store, command);
  if (actual !== command.expected.status) {
    throw new Error(`Expected ${command.expected.entity} ${command.expected.id} in ${command.expected.status}, found ${actual}.`);
  }
}

function assertCommandIdentity(command: KernelCommandEnvelope) {
  const expectedEntities: Record<string, KernelCommandEnvelope["expected"]["entity"]> = {
    "intent.request": "target",
    "generation.prepare": "target",
    "attempt.create": "generation",
    "attempt.launch": "attempt",
    "attempt.claim": "attempt",
    "attempt.phase": "attempt",
    "attempt.fail": "attempt",
    "attempt.succeed": "attempt",
    "incident.transition": "incident",
    "incident.bind_repair_session": "incident",
    "handoff.list": "target",
    "handoff.claim": "handoff",
    "handoff.settle": "handoff",
    "release.prepare": "attempt",
    "release.activate": "attempt",
    "release.healthy": "attempt",
    "release.promote": "attempt",
    "release.restore": "incident",
    "release.restore_proven": "incident",
    "release.bootstrap_prepare": "target",
    "release.bootstrap_activate": "release",
    "release.bootstrap_promote": "release",
    "release.bootstrap_restore": "target",
    "release.bootstrap_abort": "target",
    "notifier.target.bootstrap": "target",
    "notifier.preflight": "target",
    "notification.send": "incident",
    "notification.reconcile": "notification",
    "snapshot.read": "target",
  };
  const expectedEntity = expectedEntities[command.command];
  if (expectedEntity && command.expected.entity !== expectedEntity) {
    throw new Error(`${command.command} requires an expected ${expectedEntity} identity.`);
  }
  const payloadIdentityKeys: Record<string, string> = {
    "attempt.create": "generation_id",
    "attempt.launch": "attempt_id",
    "attempt.claim": "attempt_id",
    "attempt.phase": "attempt_id",
    "attempt.fail": "attempt_id",
    "attempt.succeed": "attempt_id",
    "incident.transition": "incident_id",
    "incident.bind_repair_session": "incident_id",
    "handoff.claim": "handoff_id",
    "handoff.settle": "handoff_id",
    "release.prepare": "attempt_id",
    "release.activate": "attempt_id",
    "release.healthy": "attempt_id",
    "release.promote": "attempt_id",
    "release.restore": "incident_id",
    "release.restore_proven": "incident_id",
    "release.bootstrap_activate": "release_id",
    "release.bootstrap_promote": "release_id",
    "notification.send": "incident_id",
    "notification.reconcile": "notification_id",
  };
  const payloadIdentityKey = payloadIdentityKeys[command.command];
  if (payloadIdentityKey && command.payload[payloadIdentityKey] !== command.expected.id) {
    throw new Error(`${command.command} payload identity does not match its expected-state fence.`);
  }
}

function snapshot(store: DeploymentControlStore, environment: KernelEnvironment) {
  const policy = loadRepairPolicy(environment.policyPath);
  return {
    target: "concierge",
    active_generation: store.getActiveGeneration("concierge"),
    active_attempt: store.getActiveAttempt("concierge"),
    active_incident: store.getActiveIncident("concierge"),
    pending_intents: store.listIntents("concierge", ["pending"]),
    pending_handoffs: store.listPendingHandoffs("concierge"),
    unsettled_notifications: store.listUnsettledNotifications("concierge"),
    notifier_target: store.getNotifierTarget("concierge"),
    last_known_good: store.lastKnownGood("concierge"),
    policy_version: policy.policy.version,
    policy_digest: policy.digest,
    enforcement_digest: digestProtectedKernel(environment.kernelRoot),
  };
}

async function dispatch(
  store: DeploymentControlStore,
  command: KernelCommandEnvelope,
  environment: KernelEnvironment,
) {
  assertCommandIdentity(command);
  assertExpectedState(store, command);
  const payload = command.payload;
  const releaseManager = environment.releaseManager
    || new ImmutableReleaseManager(defaultReleaseManagerEnvironment(environment.repositoryRoot));
  const notifier = environment.notifier || new DeterministicSlackNotifier(environment.slackConfigPath);
  switch (command.command) {
    case "intent.request": {
      const expectedCommit = requiredString(payload, "expected_commit", 40).toLowerCase();
      const origin = observeOrigin(environment);
      if (!commitExists(environment.repositoryRoot, expectedCommit)
        || !isAncestor(environment.repositoryRoot, expectedCommit, origin.desiredCommit)) {
        throw new Error(`Commit ${expectedCommit} is not reachable from current origin/${environment.originBranch}.`);
      }
      return { intent: store.requestIntent({ expectedCommit, continuation: continuation(payload) }), origin };
    }
    case "generation.prepare": {
      const origin = observeOrigin(environment);
      const included = [];
      for (const intent of store.listIntents(command.target, ["pending"])) {
        if (commitExists(environment.repositoryRoot, intent.expected_commit)
          && isAncestor(environment.repositoryRoot, intent.expected_commit, origin.desiredCommit)) {
          included.push(intent.id);
        } else {
          store.parkIntent(
            intent.id,
            `Commit ${intent.expected_commit} is no longer reachable from current origin/${environment.originBranch}.`,
          );
        }
      }
      if (included.length === 0) throw new Error("No representable pending deployment intents exist.");
      const generation = store.prepareGeneration({
        desiredCommit: origin.desiredCommit,
        originUrl: origin.originUrl,
        originObservedAt: origin.observedAt,
        includedIntentIds: included,
      });
      return { generation, included_intent_ids: included };
    }
    case "attempt.create":
      return { attempt: store.createAttempt(requiredString(payload, "generation_id", 100)) };
    case "attempt.launch": {
      const attemptId = requiredString(payload, "attempt_id", 100);
      const unit = `concierge-deploy-${attemptId.slice(0, 12)}`;
      const launched = Bun.spawnSync({
        cmd: [
          environment.systemdRunBin,
          "--unit", unit,
          "--collect",
          "--no-block",
          "--property=Type=exec",
          `--setenv=HOME=${environment.home}`,
          `--setenv=CONCIERGE_DRAIN_INTERVAL_SECONDS=${environment.drainIntervalSeconds}`,
          "--setenv=CONCIERGE_DEPLOY_DETACHED=1",
          `--setenv=CONCIERGE_DEPLOY_ATTEMPT_ID=${attemptId}`,
          environment.deployScript,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (launched.exitCode !== 0) {
        const state = Bun.spawnSync({
          cmd: [environment.systemctlBin, "show", `${unit}.service`, "--property=LoadState", "--value"],
          stdout: "pipe",
          stderr: "ignore",
        }).stdout.toString().trim();
        if (state === "not-found" || !state) {
          throw new AmbiguousEffectError(
            `systemd-run did not prove launch of ${unit}: ${launched.stderr.toString().trim().slice(0, 1000)}`,
          );
        }
      }
      return { attempt_id: attemptId, unit_name: unit, launch_state: "submitted" };
    }
    case "attempt.claim":
      return {
        attempt: store.claimAttempt({
          attemptId: requiredString(payload, "attempt_id", 100),
          pid: requiredInteger(payload, "runner_pid", 2),
          bootId: requiredString(payload, "runner_boot_id", 200),
          startTicks: requiredString(payload, "runner_start_ticks", 200),
        }),
      };
    case "attempt.phase": {
      const phase = requiredString(payload, "phase", 40);
      if (!new Set(["updating", "activating", "verifying", "releasing"]).has(phase)) {
        throw new Error(`Unsupported attempt phase ${phase}.`);
      }
      return {
        attempt: store.transitionAttempt(
          requiredString(payload, "attempt_id", 100),
          phase as "updating" | "activating" | "verifying" | "releasing",
          (payload.detail && typeof payload.detail === "object" && !Array.isArray(payload.detail))
            ? payload.detail as Record<string, unknown>
            : {},
        ),
      };
    }
    case "attempt.fail": {
      const outcome = requiredString(payload, "outcome", 20);
      if (outcome !== "failed" && outcome !== "ambiguous") throw new Error("Attempt failure outcome is invalid.");
      return store.failAttempt({
        attemptId: requiredString(payload, "attempt_id", 100),
        outcome,
        error: requiredString(payload, "error", 4000),
        failureFingerprint: requiredString(payload, "failure_fingerprint", 300),
      });
    }
    case "attempt.succeed": {
      const attemptId = requiredString(payload, "attempt_id", 100);
      const deployedCommit = requiredString(payload, "deployed_commit", 40).toLowerCase();
      if (!commitExists(environment.repositoryRoot, deployedCommit)) {
        throw new Error(`Deployed commit ${deployedCommit} is unavailable in canonical Git.`);
      }
      const satisfiedIntentIds = store.listIntents(command.target, ["pending"])
        .filter((intent) => isAncestor(environment.repositoryRoot, intent.expected_commit, deployedCommit))
        .map((intent) => intent.id);
      return {
        attempt: store.succeedAttempt({
          attemptId,
          deployedCommit,
          serviceInvocationId: requiredString(payload, "service_invocation_id", 200),
          evidence: objectValue(payload, "evidence"),
          satisfiedIntentIds,
        }),
        satisfied_intent_ids: satisfiedIntentIds,
      };
    }
    case "incident.transition":
      {
        const status = requiredString(payload, "status", 40);
        if (!new Set([
          "open", "stabilizing", "diagnosing", "awaiting_owner_fix", "repairing",
          "reviewing", "deploying", "verifying", "learning", "resolved", "parked",
        ]).has(status)) throw new Error("Incident status is invalid.");
      return {
        incident: store.transitionIncident(
          requiredString(payload, "incident_id", 100),
          status as Parameters<DeploymentControlStore["transitionIncident"]>[1],
          optionalString(payload, "error", 4000),
        ),
      };
      }
    case "incident.bind_repair_session":
      {
        const providerId = requiredString(payload, "provider_id", 40);
        if (providerId !== "codex" && providerId !== "claude-code") throw new Error("Repair provider ID is invalid.");
      return {
        incident: store.bindRepairSession(
          requiredString(payload, "incident_id", 100),
          providerId,
          requiredString(payload, "provider_session_uuid", 200),
        ),
      };
      }
    case "handoff.list":
      return { handoffs: store.listPendingHandoffs(command.target) };
    case "handoff.claim":
      return {
        handoff: store.claimHandoff(
          requiredString(payload, "handoff_id", 100),
          requiredString(payload, "owner_instance_id", 200),
        ),
      };
    case "handoff.settle": {
      const outcome = requiredString(payload, "outcome", 20);
      if (outcome !== "delivered" && outcome !== "parked") throw new Error("Handoff outcome is invalid.");
      return {
        handoff: store.settleHandoff(
          requiredString(payload, "handoff_id", 100),
          requiredString(payload, "owner_instance_id", 200),
          outcome,
          optionalString(payload, "error", 4000),
        ),
      };
    }
    case "release.bootstrap_prepare": {
      const origin = observeOrigin(environment);
      const head = git(environment.repositoryRoot, ["rev-parse", "HEAD"]).toLowerCase();
      const dirty = git(environment.repositoryRoot, ["status", "--porcelain", "--untracked-files=normal"]);
      if (head !== origin.desiredCommit || dirty) {
        throw new Error("Release bootstrap requires a clean canonical checkout at the exact observed origin/main commit.");
      }
      const prepared = releaseManager.prepare(randomUUID(), origin.desiredCommit);
      const lastKnownGood = store.lastKnownGood(command.target);
      const rollbackSafe = !lastKnownGood
        || lastKnownGood.compatibility_digest === prepared.compatibilityDigest;
      return {
        release: store.recordRelease({
          gitCommit: prepared.gitCommit,
          artifactPath: prepared.artifactPath,
          artifactDigest: prepared.artifactDigest,
          runtimeDigest: prepared.runtimeDigest,
          compatibilityDigest: prepared.compatibilityDigest,
          rollbackSafe,
          evidence: {
            bootstrap: true,
            origin_commit: origin.desiredCommit,
            origin_url: origin.originUrl,
            origin_observed_at: origin.observedAt,
            source_tree_digest: prepared.sourceTreeDigest,
            builder_unit: prepared.builderUnit,
            rollback_classification: rollbackSafe ? "compatible" : "incompatible",
          },
        }),
        prior_last_known_good: lastKnownGood,
      };
    }
    case "release.bootstrap_activate": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      if (!release || !new Set(["candidate", "healthy", "last_known_good"]).has(release.status)) {
        throw new Error("Bootstrap activation requires a recorded usable release.");
      }
      return { release, activation: releaseManager.activate(release.artifact_path) };
    }
    case "release.bootstrap_promote": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      if (!release) throw new Error("Unknown bootstrap release.");
      if (release.status === "last_known_good") return { release };
      const evidence = objectValue(payload, "evidence");
      const invocation = requiredString(payload, "service_invocation_id", 200);
      if (evidence.runtime_sha !== release.git_commit || evidence.service_invocation_id !== invocation
        || evidence.capture_probe !== "functional health passed"
        || evidence.service_probe !== "functional health passed"
        || evidence.admission_gates !== "released") {
        throw new Error("Bootstrap release evidence is incomplete or does not match the candidate.");
      }
      store.markReleaseHealthy(release.id, evidence);
      return { release: store.promoteRelease(release.id, evidence) };
    }
    case "release.bootstrap_restore": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      const lastKnownGood = store.lastKnownGood(command.target);
      if (!release || !lastKnownGood || release.id !== lastKnownGood.id || release.rollback_safe !== 1) {
        throw new Error("Bootstrap restoration requires the exact rollback-safe last-known-good release.");
      }
      return { release, activation: releaseManager.activate(release.artifact_path) };
    }
    case "release.bootstrap_abort": {
      if (store.lastKnownGood(command.target)) {
        throw new Error("Legacy fallback is forbidden after a last-known-good release exists.");
      }
      return { activation: releaseManager.activateLegacyFallback() };
    }
    case "release.prepare": {
      const attemptId = requiredString(payload, "attempt_id", 100);
      const attempt = store.getAttempt(attemptId)!;
      const generation = store.getGeneration(attempt.generation_id)!;
      const prepared = releaseManager.prepare(attempt.id, generation.desired_commit);
      const lastKnownGood = store.lastKnownGood(command.target);
      const rollbackSafe = !lastKnownGood
        || lastKnownGood.compatibility_digest === prepared.compatibilityDigest;
      return {
        release: store.recordRelease({
          gitCommit: prepared.gitCommit,
          artifactPath: prepared.artifactPath,
          artifactDigest: prepared.artifactDigest,
          runtimeDigest: prepared.runtimeDigest,
          compatibilityDigest: prepared.compatibilityDigest,
          rollbackSafe,
          evidence: {
            origin_commit: generation.desired_commit,
            origin_url: generation.origin_url,
            origin_observed_at: generation.origin_observed_at,
            source_tree_digest: prepared.sourceTreeDigest,
            builder_unit: prepared.builderUnit,
            rollback_classification: rollbackSafe ? "compatible" : "incompatible",
          },
        }),
      };
    }
    case "release.activate": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      if (!release || release.status !== "candidate") throw new Error("Only a recorded candidate release may activate.");
      const attempt = store.getAttempt(requiredString(payload, "attempt_id", 100))!;
      const generation = store.getGeneration(attempt.generation_id)!;
      if (release.git_commit !== generation.desired_commit) {
        throw new Error("Candidate release does not match the attempt's immutable desired commit.");
      }
      return { release, activation: releaseManager.activate(release.artifact_path) };
    }
    case "release.healthy": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      if (!release) throw new Error("Unknown release.");
      const attempt = store.getAttempt(requiredString(payload, "attempt_id", 100))!;
      const generation = store.getGeneration(attempt.generation_id)!;
      if (release.git_commit !== generation.desired_commit) {
        throw new Error("Healthy release does not match the attempt's immutable desired commit.");
      }
      const evidence = objectValue(payload, "evidence");
      const invocation = requiredString(payload, "service_invocation_id", 200);
      if (evidence.runtime_sha !== release.git_commit || evidence.service_invocation_id !== invocation
        || evidence.capture_probe !== "functional health passed"
        || evidence.service_probe !== "functional health passed") {
        throw new Error("Release health evidence is incomplete or does not match the candidate.");
      }
      return { release: store.markReleaseHealthy(release.id, evidence) };
    }
    case "release.promote": {
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      const attempt = store.getAttempt(requiredString(payload, "attempt_id", 100))!;
      const generation = store.getGeneration(attempt.generation_id)!;
      if (!release || release.git_commit !== generation.desired_commit) {
        throw new Error("Promoted release does not match the attempt's immutable desired commit.");
      }
      return { release: store.promoteRelease(release.id, objectValue(payload, "evidence")) };
    }
    case "release.restore": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      const lastKnownGood = store.lastKnownGood(command.target);
      if (!release || !lastKnownGood || release.id !== lastKnownGood.id || release.rollback_safe !== 1) {
        throw new Error("Restoration requires the exact rollback-safe last-known-good release.");
      }
      return {
        incident_id: incidentId,
        release,
        activation: releaseManager.activate(release.artifact_path),
      };
    }
    case "release.restore_proven": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const incident = store.getIncident(incidentId)!;
      const release = store.getRelease(requiredString(payload, "release_id", 100));
      const attemptId = requiredString(payload, "attempt_id", 100);
      if (!release || release.id !== store.lastKnownGood(command.target)?.id
        || incident.last_attempt_id !== attemptId) {
        throw new Error("Restoration proof does not match the incident attempt and last-known-good release.");
      }
      const evidence = objectValue(payload, "evidence");
      const invocation = requiredString(payload, "service_invocation_id", 200);
      if (evidence.runtime_sha !== release.git_commit || evidence.service_invocation_id !== invocation
        || evidence.capture_probe !== "functional health passed"
        || evidence.service_probe !== "functional health passed") {
        throw new Error("Restoration health evidence is incomplete or mismatched.");
      }
      return {
        attempt: store.markAttemptRestored({
          attemptId,
          releaseId: release.id,
          deployedCommit: release.git_commit,
          serviceInvocationId: invocation,
          evidence,
        }),
        release,
      };
    }
    case "notifier.target.bootstrap": {
      const registryCodePath = requiredString(payload, "registry_code_path", 1000);
      const registry = new Database(environment.applicationStatePath, { readonly: true, strict: true });
      try {
        const rows = registry.query(`SELECT slack_channel_id, slack_channel_name, code_path
          FROM channels WHERE code_path=?`).all(registryCodePath) as Array<{
          slack_channel_id: string | null;
          slack_channel_name: string;
          code_path: string;
        }>;
        if (rows.length !== 1 || !rows[0].slack_channel_id) {
          throw new Error("Notifier target bootstrap requires one exact Slack project registry mapping.");
        }
        return {
          target: store.bootstrapNotifierTarget({
            slackChannelId: rows[0].slack_channel_id,
            slackChannelName: rows[0].slack_channel_name,
            registryCodePath: rows[0].code_path,
          }),
        };
      } finally {
        registry.close();
      }
    }
    case "notifier.preflight": {
      const target = store.getNotifierTarget(command.target);
      if (!target) throw new Error("Notifier target is not bootstrapped.");
      const evidence = await notifier.preflight(target);
      return {
        target: store.recordNotifierPreflight(command.target, evidence.bot_user_id, evidence),
        evidence,
      };
    }
    case "notification.send": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const kind = requiredString(payload, "kind", 40) as NotificationKind;
      if (!new Set(["runtime_restored", "repair_parked", "forward_repair_succeeded"]).has(kind)) {
        throw new Error("Notification kind is invalid.");
      }
      const permittedIncidentStates: Record<NotificationKind, string[]> = {
        runtime_restored: ["stabilizing", "diagnosing"],
        repair_parked: ["parked"],
        forward_repair_succeeded: ["learning", "resolved"],
      };
      if (!permittedIncidentStates[kind].includes(command.expected.status)) {
        throw new Error(`${kind} cannot send from incident state ${command.expected.status}.`);
      }
      const projection = validateNotificationProjection(kind, objectValue(payload, "projection"));
      if (projection.incident_id !== incidentId) {
        throw new Error("Notification projection incident identity does not match its fence.");
      }
      const target = store.getNotifierTarget(command.target);
      if (!target) throw new Error("Notifier target is not bootstrapped.");
      const prepared = store.prepareNotification({
        incidentId,
        kind,
        payload: projection,
        payloadDigest: notificationDigest(kind, projection),
        clientMessageId: notificationClientMessageId(incidentId, kind),
      });
      if (prepared.status === "delivered" || prepared.status === "parked") return { notification: prepared };
      if (prepared.status === "ambiguous") {
        throw new AmbiguousEffectError("Notification send is already ambiguous; reconcile without reposting.");
      }
      const sending = store.claimNotification(prepared.id);
      const root = sending.root_alert_id ? store.getNotification(sending.root_alert_id) : null;
      try {
        const result = await notifier.send(target, sending, root?.slack_ts || null);
        return {
          notification: store.settleNotification(sending.id, "delivered", { slackTs: result.slack_ts }),
        };
      } catch (error) {
        if (error instanceof SlackNotificationRejectedError) {
          return {
            notification: store.settleNotification(sending.id, "parked", { error: error.message }),
          };
        }
        if (error instanceof SlackNotificationAmbiguousError) {
          store.settleNotification(sending.id, "ambiguous", { error: error.message });
          const reconciled = await notifier.reconcile(
            target,
            store.getNotification(sending.id)!,
            root?.slack_ts || null,
          );
          if (reconciled.outcome === "delivered") {
            return {
              notification: store.settleNotification(sending.id, "delivered", { slackTs: reconciled.slack_ts }),
            };
          }
          if (reconciled.outcome === "parked") {
            return {
              notification: store.settleNotification(sending.id, "parked", { error: reconciled.error }),
            };
          }
          throw new AmbiguousEffectError(error.message);
        }
        throw error;
      }
    }
    case "notification.reconcile": {
      const notification = store.getNotification(requiredString(payload, "notification_id", 100));
      if (!notification || !new Set(["sending", "ambiguous"]).has(notification.status)) {
        throw new Error("Only an unsettled notification may reconcile.");
      }
      const target = store.getNotifierTarget(command.target);
      if (!target) throw new Error("Notifier target is not bootstrapped.");
      const root = notification.root_alert_id ? store.getNotification(notification.root_alert_id) : null;
      const result = await notifier.reconcile(target, notification, root?.slack_ts || null);
      if (result.outcome === "delivered") {
        return {
          notification: store.settleNotification(notification.id, "delivered", { slackTs: result.slack_ts }),
        };
      }
      if (result.outcome === "parked") {
        return {
          notification: store.settleNotification(notification.id, "parked", { error: result.error }),
        };
      }
      const startedAt = Date.parse(`${notification.send_started_at!.replace(" ", "T")}Z`);
      if (Date.now() - startedAt > 10 * 60_000) {
        return {
          notification: store.settleNotification(notification.id, "parked", {
            error: "Slack notification remained unproven after the bounded reconciliation window; it was not reposted.",
          }),
        };
      }
      return { notification, outcome: "unproven" };
    }
    case "snapshot.read":
      return snapshot(store, environment);
    default:
      throw new Error(`Unsupported kernel command ${command.command}.`);
  }
}

export async function handleKernelCommand(
  store: DeploymentControlStore,
  role: KernelCallerRole,
  value: unknown,
  environment: KernelEnvironment,
) {
  assertKernelCommand(value);
  authorizeKernelCommand(role, value.command);
  const digest = commandDigest(value);
  const admission = store.beginCommand({
    idempotencyKey: value.idempotency_key,
    callerRole: role,
    commandKind: value.command,
    requestDigest: digest,
  });
  if (admission.disposition === "replay") return admission.response;
  if (admission.disposition === "ambiguous") {
    return { ok: false, ambiguous: true, error: "The prior command outcome is ambiguous; it was not replayed." };
  }
  try {
    const result = { ok: true, result: await dispatch(store, value, environment) };
    store.finishCommand(value.idempotency_key, result);
    return result;
  } catch (error) {
    if (error instanceof AmbiguousEffectError
      || error instanceof ReleaseEffectAmbiguousError
      || error instanceof SlackNotificationAmbiguousError) {
      return store.markCommandAmbiguous(value.idempotency_key, error.message);
    }
    const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    store.finishCommand(value.idempotency_key, result, "rejected");
    return result;
  }
}

export function defaultKernelEnvironment(repositoryRoot = resolve(import.meta.dir, "../..")): KernelEnvironment {
  return {
    repositoryRoot,
    policyPath: process.env.CONCIERGE_DEPLOYMENT_POLICY_PATH
      ? resolve(process.env.CONCIERGE_DEPLOYMENT_POLICY_PATH)
      : resolve(repositoryRoot, "config/deployment-repair-policy.toml"),
    kernelRoot: process.env.CONCIERGE_DEPLOYMENT_KERNEL_ROOT
      ? resolve(process.env.CONCIERGE_DEPLOYMENT_KERNEL_ROOT)
      : resolve(repositoryRoot, "deployment-control/kernel"),
    originRemote: "origin",
    originBranch: "main",
    deployScript: resolve(repositoryRoot, "bot/scripts/deploy.sh"),
    systemdRunBin: "/usr/bin/systemd-run",
    systemctlBin: "/usr/bin/systemctl",
    home: "/root",
    drainIntervalSeconds: process.env.CONCIERGE_DRAIN_INTERVAL_SECONDS || "1200",
    applicationStatePath: process.env.CONCIERGE_APPLICATION_STATE_PATH
      ? resolve(process.env.CONCIERGE_APPLICATION_STATE_PATH)
      : "/root/.local/state/concierge/state.db",
    slackConfigPath: process.env.CONCIERGE_SLACK_CONFIG_PATH
      ? resolve(process.env.CONCIERGE_SLACK_CONFIG_PATH)
      : "/root/.config/concierge/slack.toml",
  };
}
