import { readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  DeploymentControlStore,
  type ContinuationSnapshot,
  type DeploymentNotificationRow,
  type NotificationKind,
  type NotifierTargetRow,
} from "./state";
import {
  assertKernelCommand,
  authorizeKernelCommand,
  commandDigest,
  type KernelCallerRole,
  type KernelCommandEnvelope,
} from "./protocol";
import { digestProtectedKernel, evaluateRepairDiff, loadRepairPolicy } from "./policy";
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
import {
  defaultRepairWorkspaceEnvironment,
  registerProviderCapability,
  RepairWorkspaceManager,
  repairTreeDigest,
} from "./repair-workspace";
import {
  defaultReviewWorkspaceEnvironment,
  ReviewWorkspaceManager,
} from "./review-workspace";
import {
  defaultRepairIntegrationEnvironment,
  RepairIntegrationAmbiguousError,
  RepairIntegrationManager,
} from "./integration";
import { installedIdentityManifest, type InstalledIdentityManifest } from "./identity";
import type { KernelPeerCredentials } from "./peer-credentials";
import { isProcessIdentityAlive, type ProcessIdentity } from "../../bot/src/runtime-identity";
import { CoordinatorRuntimeManager } from "./coordinator-runtime";

export interface KernelEnvironment {
  repositoryRoot: string;
  policyPath: string;
  kernelRoot: string;
  runtimeVersion?: string;
  originRemote: string;
  originBranch: string;
  deployScript: string;
  systemdRunBin: string;
  systemctlBin: string;
  home: string;
  drainIntervalSeconds: string;
  releaseManager?: ImmutableReleaseManager;
  notifier?: DeterministicSlackNotifier;
  repairManager?: RepairWorkspaceManager;
  reviewManager?: ReviewWorkspaceManager;
  integrationManager?: RepairIntegrationManager;
  applicationStatePath: string;
  slackConfigPath: string;
  identityManifest?: () => { manifest: InstalledIdentityManifest; digest: string };
  isProcessAlive?: (identity: ProcessIdentity) => boolean;
  rolloutUnitIdentity?: (unit: string) => { invocationId: string; mainPid: number; active: boolean };
  coordinatorRuntime?: CoordinatorRuntimeManager;
}

class AmbiguousEffectError extends Error {}

async function deliverPreparedNotification(
  store: DeploymentControlStore,
  notifier: DeterministicSlackNotifier,
  target: NotifierTargetRow,
  prepared: DeploymentNotificationRow,
) {
  const sending = store.claimNotification(prepared.id);
  const root = sending.root_alert_id ? store.getNotification(sending.root_alert_id) : null;
  try {
    const result = await notifier.send(target, sending, root?.slack_ts || null);
    return store.settleNotification(sending.id, "delivered", { slackTs: result.slack_ts });
  } catch (error) {
    if (error instanceof SlackNotificationRejectedError) {
      return store.settleNotification(sending.id, "parked", { error: error.message });
    }
    if (error instanceof SlackNotificationAmbiguousError) {
      store.settleNotification(sending.id, "ambiguous", { error: error.message });
      const reconciled = await notifier.reconcile(
        target,
        store.getNotification(sending.id)!,
        root?.slack_ts || null,
      );
      if (reconciled.outcome === "delivered") {
        return store.settleNotification(sending.id, "delivered", { slackTs: reconciled.slack_ts });
      }
      if (reconciled.outcome === "parked") {
        return store.settleNotification(sending.id, "parked", { error: reconciled.error });
      }
      throw new AmbiguousEffectError(error.message);
    }
    throw error;
  }
}

function redactedEvidence(value: string | null) {
  if (!value) return null;
  return value
    .replace(/xox[baprs]-[A-Za-z0-9-]+/gi, "[REDACTED_SLACK_TOKEN]")
    .replace(/(?:bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._~+\/-]+/gi, "[REDACTED_AUTHORITY]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 4_000);
}

function repairIncidentPacket(store: DeploymentControlStore, incidentId: string) {
  const incident = store.getIncident(incidentId);
  if (!incident?.last_attempt_id) throw new Error(`Incident ${incidentId} has no failed attempt evidence.`);
  const attempt = store.getAttempt(incident.last_attempt_id);
  if (!attempt) throw new Error(`Incident ${incidentId} references an unavailable attempt.`);
  const generation = store.getGeneration(attempt.generation_id);
  if (!generation) throw new Error(`Attempt ${attempt.id} references an unavailable generation.`);
  const priorLearning = store.recentResolvedLearning(incident.target)
    .sort((left, right) => {
      const leftMatch = left.failure_fingerprint === incident.failure_fingerprint ? 1 : 0;
      const rightMatch = right.failure_fingerprint === incident.failure_fingerprint ? 1 : 0;
      return rightMatch - leftMatch;
    })
    .slice(0, 5)
    .map((entry) => ({
      id: entry.id,
      incident_id: entry.incident_id,
      failure_fingerprint: entry.failure_fingerprint,
      classification: entry.classification,
      summary: entry.summary,
    }));
  return {
    target: incident.target,
    incident: {
      id: incident.id,
      status: incident.status,
      failure_fingerprint: incident.failure_fingerprint,
      repeated_fingerprint_count: incident.repeated_fingerprint_count,
      error: redactedEvidence(incident.error),
    },
    attempt: {
      id: attempt.id,
      status: attempt.status,
      error: redactedEvidence(attempt.error),
      created_at: attempt.created_at,
      completed_at: attempt.completed_at,
    },
    generation: {
      id: generation.id,
      desired_commit: generation.desired_commit,
      origin_observed_at: generation.origin_observed_at,
    },
    requested_commits: store.listIntents(incident.target, ["pending"])
      .map((intent) => intent.expected_commit),
    retrieval: {
      index_version: 1,
      selected_entries: priorLearning,
      selection: "exact failure fingerprint first, then most recent verified incidents; maximum five",
    },
  };
}

function repairGitResult(repairManager: RepairWorkspaceManager, incidentId: string, args: string[]) {
  const result = repairManager.runIsolatedGit(incidentId, args);
  if (result.exitCode !== 0) {
    throw new Error(`Repair repository Git ${args[0]} failed: ${result.stderr.toString().trim().slice(0, 1000)}`);
  }
  return result;
}

function repairGit(repairManager: RepairWorkspaceManager, incidentId: string, args: string[]) {
  return repairGitResult(repairManager, incidentId, args).stdout.toString().trim();
}

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

function rolloutIdentity(environment: KernelEnvironment) {
  return environment.identityManifest?.() || installedIdentityManifest({
    kernelRoot: environment.kernelRoot,
    systemctlBin: environment.systemctlBin,
  });
}

function rolloutId(payload: Record<string, unknown>) {
  const id = requiredString(payload, "rollout_id", 100);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("rollout_id must be a UUID.");
  }
  return id;
}

function rolloutOwner(payload: Record<string, unknown>) {
  const owner = objectValue(payload, "owner");
  return {
    invocationId: requiredString(owner, "invocation_id", 200),
    pid: requiredInteger(owner, "pid", 2),
    bootId: requiredString(owner, "boot_id", 100),
    startTicks: requiredString(owner, "start_ticks", 100),
  };
}

function coordinatorOwner(payload: Record<string, unknown>) {
  const owner = objectValue(payload, "coordinator_owner");
  const slot = requiredString(owner, "slot", 1);
  if (slot !== "a" && slot !== "b") throw new Error("coordinator slot is invalid.");
  const version = requiredString(owner, "version", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(version)) throw new Error("coordinator version is invalid.");
  return {
    ...rolloutOwner({ owner }),
    slot,
    version,
  };
}

function observedRolloutUnit(environment: KernelEnvironment, unit: string) {
  if (environment.rolloutUnitIdentity) return environment.rolloutUnitIdentity(unit);
  const result = Bun.spawnSync({
    cmd: [environment.systemctlBin, "show", unit, "--property=InvocationID,MainPID,ActiveState"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Cannot verify rollout unit ${unit}: ${result.stderr.toString().trim().slice(0, 500)}`);
  }
  const properties = Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  return {
    invocationId: properties.InvocationID || "",
    mainPid: Number(properties.MainPID || "0"),
    active: properties.ActiveState === "active",
  };
}

function assertSystemdPeer(
  environment: KernelEnvironment,
  unit: string,
  owner: ReturnType<typeof rolloutOwner>,
  peer: KernelPeerCredentials,
) {
  if (peer.pid !== owner.pid) throw new Error(`Unix peer PID ${peer.pid} does not match claimed owner PID ${owner.pid}.`);
  const observed = observedRolloutUnit(environment, unit);
  if (!observed.active || observed.invocationId !== owner.invocationId || observed.mainPid !== peer.pid) {
    throw new Error(`Systemd unit ${unit} does not match the authenticated Unix peer and invocation.`);
  }
  if (!(environment.isProcessAlive || isProcessIdentityAlive)({
    pid: peer.pid,
    bootId: owner.bootId,
    startTicks: owner.startTicks,
  })) {
    throw new Error(`Unix peer PID ${peer.pid} does not match its claimed boot and process-start identity.`);
  }
}

function rolloutLeasePayload(payload: Record<string, unknown>, environment: KernelEnvironment) {
  const owner = rolloutOwner(payload);
  return {
    ...owner,
    identityDigest: rolloutIdentity(environment).digest,
  };
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
              : entity === "notification" ? store.getNotification(id)
                : entity === "rollout" ? store.getRollout(id)
                  : entity === "rollout_review" ? store.getRolloutReviewRequest(id)
                    : store.getActivationGeneration(id);
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
    "repair.prepare": "incident",
    "repair.launch": "incident",
    "repair.complete": "incident",
    "repair.status": "incident",
    "repair.provider_admit": "incident",
    "repair.provider_launch_begin": "incident",
    "review.prepare": "incident",
    "review.launch": "incident",
    "review.bind_session": "incident",
    "review.complete": "incident",
    "review.status": "incident",
    "review.provider_admit": "incident",
    "review.provider_launch_begin": "incident",
    "repair.integrate": "incident",
    "learning.record": "incident",
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
    "rollout.create": "target",
    "rollout.claim": "rollout",
    "rollout.heartbeat": "rollout",
    "rollout.transition": "rollout",
    "rollout.check.record": "rollout",
    "rollout.evidence.freeze": "rollout",
    "rollout.review.prepare": "rollout",
    "rollout.review.claim": "rollout_review",
    "rollout.review.provider_admit": "rollout_review",
    "rollout.review.bind_session": "rollout_review",
    "rollout.review.record": "rollout_review",
    "activation.prepare": "rollout",
    "coordinator.candidate.start": "activation",
    "activation.ack": "activation",
    "coordinator.heartbeat": "activation",
    "activation.expose": "activation",
    "coordinator.promote": "activation",
    "activation.revoke": "activation",
    "rollout.verify": "rollout",
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
    "repair.prepare": "incident_id",
    "repair.launch": "incident_id",
    "repair.complete": "incident_id",
    "repair.status": "incident_id",
    "repair.provider_admit": "incident_id",
    "repair.provider_launch_begin": "incident_id",
    "review.prepare": "incident_id",
    "review.launch": "incident_id",
    "review.bind_session": "incident_id",
    "review.complete": "incident_id",
    "review.status": "incident_id",
    "review.provider_admit": "incident_id",
    "review.provider_launch_begin": "incident_id",
    "repair.integrate": "incident_id",
    "learning.record": "incident_id",
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
    "rollout.claim": "rollout_id",
    "rollout.heartbeat": "rollout_id",
    "rollout.transition": "rollout_id",
    "rollout.check.record": "rollout_id",
    "rollout.evidence.freeze": "rollout_id",
    "rollout.review.prepare": "rollout_id",
    "rollout.review.claim": "request_id",
    "rollout.review.provider_admit": "request_id",
    "rollout.review.bind_session": "request_id",
    "rollout.review.record": "request_id",
    "activation.prepare": "rollout_id",
    "coordinator.candidate.start": "generation_id",
    "activation.ack": "generation_id",
    "coordinator.heartbeat": "activation_generation_id",
    "activation.expose": "generation_id",
    "coordinator.promote": "generation_id",
    "activation.revoke": "generation_id",
    "rollout.verify": "rollout_id",
  };
  const payloadIdentityKey = payloadIdentityKeys[command.command];
  if (payloadIdentityKey && command.payload[payloadIdentityKey] !== command.expected.id) {
    throw new Error(`${command.command} payload identity does not match its expected-state fence.`);
  }
}

function assertRuntimeActivation(
  store: DeploymentControlStore,
  role: KernelCallerRole,
  command: KernelCommandEnvelope,
  environment: KernelEnvironment,
) {
  const requiresProduction = (role === "bot" && command.command === "intent.request")
    || (role === "coordinator" && !["snapshot.read", "activation.ack", "coordinator.heartbeat"].includes(command.command));
  if (!requiresProduction) return;
  const generationId = requiredString(command.payload, "activation_generation_id", 100);
  const generation = store.getActivationGeneration(generationId);
  if (!generation || generation.target !== command.target || generation.status !== "exposed"
    || generation.kind !== "production") {
    throw new Error("A current exposed production activation generation is required.");
  }
  const capabilities = JSON.parse(generation.capabilities_json);
  if (!Array.isArray(capabilities)
    || !["intent_routing", "attempt_reconciliation", "autonomous_repair"]
      .every((capability) => capabilities.includes(capability))) {
    throw new Error(`Activation generation ${generation.id} is incomplete.`);
  }
  const currentIdentity = rolloutIdentity(environment).digest;
  if (generation.identity_digest !== currentIdentity) {
    throw new Error(`Activation generation ${generation.id} no longer matches the installed identity.`);
  }
}

function snapshot(store: DeploymentControlStore, environment: KernelEnvironment, role: KernelCallerRole) {
  const policy = loadRepairPolicy(environment.policyPath);
  const activeIncident = store.getActiveIncident("concierge");
  const incidentAttempt = activeIncident ? store.getAttempt(activeIncident.last_attempt_id) : null;
  const activeRollout = store.getActiveRollout("concierge") || store.getLatestRollout("concierge");
  const exposedActivation = store.getExposedActivation("concierge");
  const coordinatorHandoff = exposedActivation
    ? store.getCoordinatorHandoff(exposedActivation.id)
    : (store.getCurrentActivation("concierge")
      ? store.getCoordinatorHandoff(store.getCurrentActivation("concierge")!.id)
      : null);
  const visibleRollout = activeRollout && role !== "operator"
    ? {
        id: activeRollout.id,
        target: activeRollout.target,
        status: activeRollout.status,
        next_step: activeRollout.next_step,
        owner_unit: activeRollout.owner_unit,
        identity_digest: activeRollout.identity_digest,
        evidence_digest: activeRollout.evidence_digest,
        error: activeRollout.error,
        created_at: activeRollout.created_at,
        updated_at: activeRollout.updated_at,
        completed_at: activeRollout.completed_at,
      }
    : activeRollout;
  return {
    target: "concierge",
    active_generation: store.getActiveGeneration("concierge"),
    active_attempt: store.getActiveAttempt("concierge"),
    active_incident: activeIncident,
    incident_attempt: incidentAttempt,
    incident_generation: incidentAttempt ? store.getGeneration(incidentAttempt.generation_id) : null,
    active_repair_run: activeIncident ? store.getRepairRun(activeIncident.id) : null,
    latest_review_run: activeIncident ? store.latestReviewRun(activeIncident.id) : null,
    pending_intents: store.listIntents("concierge", ["pending"]),
    pending_handoffs: store.listPendingHandoffs("concierge"),
    unsettled_handoffs: store.listUnsettledHandoffs("concierge"),
    unsettled_notifications: store.listUnsettledNotifications("concierge"),
    incident_notifications: activeIncident ? store.listIncidentNotifications(activeIncident.id) : [],
    learning: activeIncident ? store.getLearning(activeIncident.id) : null,
    notifier_target: store.getNotifierTarget("concierge"),
    last_known_good: store.lastKnownGood("concierge"),
    active_rollout: visibleRollout,
    rollout_checks: activeRollout ? store.listRolloutChecks(activeRollout.id) : [],
    implementation_review: activeRollout ? store.getRolloutReview(activeRollout.id, "implementation") : null,
    live_evidence_review: activeRollout ? store.getRolloutReview(activeRollout.id, "live_evidence") : null,
    active_activation: exposedActivation,
    activation_generation: store.getCurrentActivation("concierge"),
    coordinator_handoff: coordinatorHandoff,
    runtime_mode: exposedActivation?.kind || "disabled",
    monitoring_owner: store.getExposedActivation("concierge", "production")
      ? coordinatorHandoff?.candidate_unit || "unproven"
      : "bot/scripts/deploy.sh",
    policy_version: policy.policy.version,
    policy_digest: policy.digest,
    enforcement_digest: digestProtectedKernel(environment.kernelRoot),
    kernel_runtime_version: environment.runtimeVersion || "source",
  };
}

function assertAuthenticatedPeer(
  store: DeploymentControlStore,
  callerRole: KernelCallerRole,
  command: KernelCommandEnvelope,
  environment: KernelEnvironment,
  peer: KernelPeerCredentials,
) {
  const payload = command.payload;
  if (callerRole === "rollout" && command.command !== "rollout.create" && command.command !== "snapshot.read") {
    const id = rolloutId(payload);
    const rollout = store.getRollout(id);
    if (!rollout) throw new Error(`Unknown rollout ${id}.`);
    assertSystemdPeer(environment, rollout.owner_unit, rolloutOwner(payload), peer);
  }
  if (callerRole === "review" && command.command.startsWith("rollout.review.")) {
    const requestId = requiredString(payload, "request_id", 100);
    const request = store.getRolloutReviewRequest(requestId);
    if (!request) throw new Error(`Unknown rollout review request ${requestId}.`);
    if (request.identity_digest !== rolloutIdentity(environment).digest) {
      throw new Error(`Rollout review request ${request.id} installed identity drifted.`);
    }
    assertSystemdPeer(environment, request.worker_unit, rolloutOwner(payload), peer);
  }
  if (callerRole === "coordinator" && command.command !== "snapshot.read") {
    const generationId = command.command === "activation.ack"
      ? requiredString(payload, "generation_id", 100)
      : requiredString(payload, "activation_generation_id", 100);
    const handoff = store.getCoordinatorHandoff(generationId);
    if (!handoff) throw new Error(`Activation generation ${generationId} has no coordinator handoff authority.`);
    const owner = coordinatorOwner(payload);
    if (owner.slot !== handoff.candidate_slot || owner.version !== handoff.candidate_version) {
      throw new Error(`Coordinator generation ${generationId} slot or version does not match the candidate.`);
    }
    assertSystemdPeer(environment, handoff.candidate_unit, owner, peer);
    if (command.command !== "activation.ack"
      && (handoff.candidate_invocation_id !== owner.invocationId
        || handoff.candidate_pid !== owner.pid
        || handoff.candidate_boot_id !== owner.bootId
        || handoff.candidate_start_ticks !== owner.startTicks)) {
      throw new Error(`Coordinator generation ${generationId} does not belong to this authenticated process.`);
    }
  }
}

async function dispatch(
  store: DeploymentControlStore,
  callerRole: KernelCallerRole,
  command: KernelCommandEnvelope,
  environment: KernelEnvironment,
) {
  assertCommandIdentity(command);
  assertRuntimeActivation(store, callerRole, command, environment);
  assertExpectedState(store, command);
  const payload = command.payload;
  const releaseManager = environment.releaseManager
    || new ImmutableReleaseManager(defaultReleaseManagerEnvironment(environment.repositoryRoot));
  const notifier = environment.notifier || new DeterministicSlackNotifier(environment.slackConfigPath);
  const repairManager = environment.repairManager
    || new RepairWorkspaceManager(defaultRepairWorkspaceEnvironment(environment.repositoryRoot));
  const reviewManager = environment.reviewManager
    || new ReviewWorkspaceManager(defaultReviewWorkspaceEnvironment());
  const integrationManager = environment.integrationManager
    || new RepairIntegrationManager(defaultRepairIntegrationEnvironment(environment.repositoryRoot));
  const coordinatorRuntime = environment.coordinatorRuntime || new CoordinatorRuntimeManager();
  switch (command.command) {
    case "rollout.create": {
      const id = rolloutId(payload);
      const ownerUnit = requiredString(payload, "owner_unit", 240);
      const expectedUnit = `concierge-deployment-rollout@${id}.service`;
      if (ownerUnit !== expectedUnit) throw new Error(`Rollout ${id} must be owned by ${expectedUnit}.`);
      const identity = rolloutIdentity(environment);
      return {
        rollout: store.createRollout({
          id,
          ownerUnit,
          identityDigest: identity.digest,
          nextStep: "claim_rollout_lease",
        }),
        identity_manifest: identity.manifest,
      };
    }
    case "rollout.claim": {
      const id = rolloutId(payload);
      const rollout = store.getRollout(id);
      if (!rollout) throw new Error(`Unknown rollout ${id}.`);
      const owner = rolloutOwner(payload);
      const sameOwner = rollout.owner_invocation_id === owner.invocationId
        && rollout.owner_pid === owner.pid
        && rollout.owner_boot_id === owner.bootId
        && rollout.owner_start_ticks === owner.startTicks;
      const priorOwnerProvenDead = Boolean(rollout.owner_invocation_id) && !sameOwner
        && !(environment.isProcessAlive || isProcessIdentityAlive)({
          pid: rollout.owner_pid || 0,
          bootId: rollout.owner_boot_id || "",
          startTicks: rollout.owner_start_ticks || "",
        });
      return {
        rollout: store.claimRolloutLease({
          rolloutId: id,
          ownerUnit: rollout.owner_unit,
          ...owner,
          priorOwnerProvenDead,
        }),
      };
    }
    case "rollout.heartbeat": {
      const id = rolloutId(payload);
      return { rollout: store.heartbeatRollout({ rolloutId: id, ...rolloutLeasePayload(payload, environment) }) };
    }
    case "rollout.transition": {
      const id = rolloutId(payload);
      const status = requiredString(payload, "status", 80) as any;
      const nextStep = requiredString(payload, "next_step", 200);
      return {
        rollout: store.transitionRollout({
          rolloutId: id,
          expectedStatus: command.expected.status as any,
          status,
          nextStep,
          ...rolloutLeasePayload(payload, environment),
          error: optionalString(payload, "error", 4_000),
        }),
      };
    }
    case "rollout.check.record": {
      const id = rolloutId(payload);
      const evidenceValue = payload.evidence;
      if (evidenceValue != null && (!evidenceValue || typeof evidenceValue !== "object" || Array.isArray(evidenceValue))) {
        throw new Error("evidence must be an object.");
      }
      return {
        check: store.recordRolloutCheck({
          rolloutId: id,
          name: requiredString(payload, "name", 160),
          phase: requiredString(payload, "phase", 100),
          status: requiredString(payload, "status", 40) as any,
          evidenceDigest: optionalString(payload, "evidence_digest", 64),
          evidence: evidenceValue as Record<string, unknown> | null,
          error: optionalString(payload, "error", 4_000),
          ...rolloutLeasePayload(payload, environment),
        }),
      };
    }
    case "rollout.evidence.freeze": {
      const id = rolloutId(payload);
      return { rollout: store.freezeRolloutEvidence({ rolloutId: id, ...rolloutLeasePayload(payload, environment) }) };
    }
    case "rollout.review.prepare": {
      const id = rolloutId(payload);
      const reviewKind = requiredString(payload, "review_kind", 40);
      if (reviewKind !== "implementation" && reviewKind !== "live_evidence") {
        throw new Error("review_kind is invalid.");
      }
      return {
        review_request: store.prepareRolloutReviewRequest({
          rolloutId: id,
          reviewKind,
          ...rolloutLeasePayload(payload, environment),
        }),
      };
    }
    case "rollout.review.claim": {
      const reviewOwner = rolloutOwner(payload);
      return {
        review_request: store.claimRolloutReviewRequest({
          requestId: requiredString(payload, "request_id", 100),
          ...reviewOwner,
        }),
      };
    }
    case "rollout.review.provider_admit": {
      const reviewOwner = rolloutOwner(payload);
      return {
        review_request: store.admitRolloutReviewProvider({
          requestId: requiredString(payload, "request_id", 100),
          ...reviewOwner,
        }),
      };
    }
    case "rollout.review.bind_session": {
      const reviewOwner = rolloutOwner(payload);
      return {
        review_request: store.bindRolloutReviewSession({
          requestId: requiredString(payload, "request_id", 100),
          providerSessionUuid: requiredString(payload, "reviewer_session_uuid", 200),
          ...reviewOwner,
        }),
      };
    }
    case "rollout.review.record": {
      const verdictPayload = objectValue(payload, "verdict");
      const verdict = requiredString(verdictPayload, "verdict", 40);
      if (verdict !== "ship" && verdict !== "no_ship") throw new Error("rollout review verdict is invalid.");
      const reviewOwner = rolloutOwner(payload);
      return {
        review: store.recordRolloutReview({
          requestId: requiredString(payload, "request_id", 100),
          verdict,
          reviewerSessionUuid: requiredString(payload, "reviewer_session_uuid", 200),
          verdictPayload,
          ...reviewOwner,
        }),
      };
    }
    case "activation.prepare": {
      const id = rolloutId(payload);
      const kind = requiredString(payload, "kind", 40);
      if (kind !== "canary" && kind !== "production") throw new Error("activation kind is invalid.");
      const candidateSlot = requiredString(payload, "candidate_slot", 1);
      if (candidateSlot !== "a" && candidateSlot !== "b") throw new Error("candidate_slot is invalid.");
      const candidateVersion = requiredString(payload, "candidate_version", 64).toLowerCase();
      const candidate = coordinatorRuntime.validateCandidate(candidateSlot, candidateVersion);
      const incumbent = coordinatorRuntime.incumbent();
      if (incumbent?.unit === candidate.unit) {
        throw new Error("Coordinator candidate must use the inactive A/B slot.");
      }
      return {
        activation: store.prepareActivationGeneration({
          rolloutId: id,
          kind,
          coordinator: {
            candidateSlot,
            candidateVersion,
            candidateUnit: candidate.unit,
            incumbentSlot: incumbent?.slot || null,
            incumbentVersion: incumbent?.version || null,
            incumbentUnit: incumbent?.unit || null,
            incumbentWasActive: incumbent?.active || false,
          },
          ...rolloutLeasePayload(payload, environment),
        }),
      };
    }
    case "coordinator.candidate.start": {
      const generationId = requiredString(payload, "generation_id", 100);
      const requested = store.requestCoordinatorCandidateStart({
        generationId,
        rolloutId: rolloutId(payload),
        ...rolloutLeasePayload(payload, environment),
      });
      const candidate = coordinatorRuntime.startCandidate(requested.candidate_slot, requested.candidate_version);
      return {
        handoff: store.recordCoordinatorCandidateStarted({
          generationId,
          invocationId: candidate.invocationId,
        }),
        candidate,
      };
    }
    case "activation.ack": {
      const generationId = requiredString(payload, "generation_id", 100);
      if (callerRole !== "bot" && callerRole !== "coordinator") {
        throw new Error("Only the bot or coordinator may acknowledge activation.");
      }
      const identity = rolloutIdentity(environment);
      const claimedIdentity = requiredString(payload, "identity_digest", 64).toLowerCase();
      if (claimedIdentity !== identity.digest) throw new Error("Activation acknowledgment identity is stale.");
      const owner = callerRole === "coordinator" ? coordinatorOwner(payload) : undefined;
      const handoff = store.getCoordinatorHandoff(generationId);
      const priorCoordinatorProvenDead = Boolean(owner && handoff?.candidate_invocation_id)
        && !(environment.isProcessAlive || isProcessIdentityAlive)({
          pid: handoff?.candidate_pid || 0,
          bootId: handoff?.candidate_boot_id || "",
          startTicks: handoff?.candidate_start_ticks || "",
        });
      return {
        activation: store.acknowledgeActivation({
          generationId,
          role: callerRole,
          identityDigest: identity.digest,
          coordinatorOwner: owner,
          priorCoordinatorProvenDead,
        }),
      };
    }
    case "coordinator.heartbeat": {
      const generationId = requiredString(payload, "activation_generation_id", 100);
      const owner = coordinatorOwner(payload);
      return {
        handoff: store.heartbeatCoordinator({
          generationId,
          ...owner,
          reconciliationDigest: requiredString(payload, "reconciliation_digest", 64).toLowerCase(),
          handshake: payload.handshake === true,
        }),
      };
    }
    case "activation.expose": {
      const generationId = requiredString(payload, "generation_id", 100);
      const activation = store.exposeActivationGeneration({
          generationId,
          rolloutId: rolloutId(payload),
          ...rolloutLeasePayload(payload, environment),
          probationSeconds: Number(process.env.CONCIERGE_COORDINATOR_PROBATION_SECONDS || "30"),
        });
      const handoff = store.getCoordinatorHandoff(generationId)!;
      try {
        if (handoff.incumbent_was_active && handoff.incumbent_unit
          && handoff.incumbent_unit !== handoff.candidate_unit) {
          coordinatorRuntime.stop(handoff.incumbent_unit);
        }
        store.recordCoordinatorIncumbentStopped({ generationId });
        return { activation, handoff: store.getCoordinatorHandoff(generationId) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.revokeActivationByWatchdog({
          generationId,
          reason: `Coordinator handoff could not stop the incumbent: ${message}`,
        });
        try {
          const recovered = coordinatorRuntime.recoverIncumbent({
            candidateUnit: handoff.candidate_unit,
            incumbentSlot: handoff.incumbent_slot,
            incumbentVersion: handoff.incumbent_version,
            incumbentUnit: handoff.incumbent_unit,
            incumbentWasActive: Boolean(handoff.incumbent_was_active),
          });
          store.recordCoordinatorRecovery({
            generationId,
            recoveryInvocationId: recovered?.invocationId || null,
          });
        } catch (recoveryError) {
          store.markCoordinatorHandoffAmbiguous({
            generationId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
          throw new AmbiguousEffectError(`Coordinator exposure and incumbent recovery are ambiguous: ${message}`);
        }
        throw new Error(`Coordinator exposure was revoked and the incumbent recovered: ${message}`);
      }
    }
    case "coordinator.promote": {
      const generationId = requiredString(payload, "generation_id", 100);
      const handoff = store.requestCoordinatorPromotion({
        generationId,
        rolloutId: rolloutId(payload),
        ...rolloutLeasePayload(payload, environment),
      });
      try {
        const active = coordinatorRuntime.promote({
          generationId,
          slot: handoff.candidate_slot,
          version: handoff.candidate_version,
          unit: handoff.candidate_unit,
          incumbentUnit: handoff.incumbent_unit,
        });
        return { handoff: store.completeCoordinatorPromotion({ generationId }), active };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.revokeActivationByWatchdog({ generationId, reason: `Coordinator promotion failed: ${message}` });
        try {
          const recovered = coordinatorRuntime.recoverIncumbent({
            candidateUnit: handoff.candidate_unit,
            incumbentSlot: handoff.incumbent_slot,
            incumbentVersion: handoff.incumbent_version,
            incumbentUnit: handoff.incumbent_unit,
            incumbentWasActive: Boolean(handoff.incumbent_was_active),
          });
          store.recordCoordinatorRecovery({ generationId, recoveryInvocationId: recovered?.invocationId || null });
        } catch (recoveryError) {
          store.markCoordinatorHandoffAmbiguous({
            generationId,
            error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          });
          throw new AmbiguousEffectError(`Coordinator promotion and recovery are ambiguous: ${message}`);
        }
        throw new Error(`Coordinator promotion was revoked and the incumbent recovered: ${message}`);
      }
    }
    case "activation.revoke": {
      const generationId = requiredString(payload, "generation_id", 100);
      const activation = store.revokeActivationGeneration({
          generationId,
          rolloutId: rolloutId(payload),
          reason: requiredString(payload, "reason", 4_000),
          ...rolloutLeasePayload(payload, environment),
        });
      const handoff = store.getCoordinatorHandoff(generationId)!;
      try {
        const recovered = coordinatorRuntime.recoverIncumbent({
          candidateUnit: handoff.candidate_unit,
          incumbentSlot: handoff.incumbent_slot,
          incumbentVersion: handoff.incumbent_version,
          incumbentUnit: handoff.incumbent_unit,
          incumbentWasActive: Boolean(handoff.incumbent_was_active),
        });
        return {
          activation,
          handoff: store.recordCoordinatorRecovery({
            generationId,
            recoveryInvocationId: recovered?.invocationId || null,
          }),
        };
      } catch (error) {
        store.markCoordinatorHandoffAmbiguous({
          generationId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AmbiguousEffectError("Coordinator activation was revoked but incumbent recovery is ambiguous.");
      }
    }
    case "rollout.verify": {
      const id = rolloutId(payload);
      return {
        rollout: store.verifyProductionRollout({
          rolloutId: id,
          generationId: requiredString(payload, "generation_id", 100),
          ...rolloutLeasePayload(payload, environment),
        }),
      };
    }
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
    case "repair.prepare": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const packet = repairIncidentPacket(store, incidentId);
      const policy = loadRepairPolicy(environment.policyPath);
      const existingRepair = store.getRepairRun(incidentId);
      const refreshOrigin = existingRepair ? observeOrigin(environment) : null;
      const priorResult = existingRepair?.result_json
        ? JSON.parse(existingRepair.result_json) as Record<string, unknown>
        : null;
      const priorPatch = existingRepair && priorResult
        ? repairGit(repairManager, incidentId, [
            "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames",
            `${existingRepair.baseline_local_commit}..${requiredString(priorResult, "head_commit", 40)}`,
          ])
        : null;
      const evidence = {
        ...packet,
        policy: { version: policy.policy.version, digest: policy.digest },
        enforcement_digest: digestProtectedKernel(environment.kernelRoot),
        ...(existingRepair ? {
          refresh: {
            reason: existingRepair.error || "The reviewed repair base no longer matches current origin.",
            previous_base_commit: existingRepair.base_commit,
            current_origin_commit: refreshOrigin!.desiredCommit,
            previous_repair_result: priorResult,
            previous_patch: priorPatch,
          },
        } : {}),
      };
      const prepared = repairManager.prepare({
        incidentId,
        baseCommit: refreshOrigin?.desiredCommit || packet.generation.desired_commit,
        evidence,
        charter: readFileSync(join(environment.kernelRoot, "repair-charter.md"), "utf8"),
        model: "gpt-5.6-terra",
        reasoningEffort: "high",
        refresh: Boolean(existingRepair),
      });
      return {
        repair_run: store.prepareRepairRun({
          incidentId,
          baseCommit: prepared.baseCommit,
          baselineLocalCommit: prepared.baselineLocalCommit,
          repositoryPath: prepared.repositoryPath,
          evidenceDigest: prepared.evidenceDigest,
          providerCapabilityDigest: prepared.capabilityDigest,
          capabilityExpiresAtMs: prepared.capabilityExpiresAtMs,
          workerUnit: prepared.workerUnit,
        }),
      };
    }
    case "repair.status": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const incident = store.getIncident(incidentId);
      const repairRun = store.getRepairRun(incidentId);
      if (!incident || !repairRun) throw new Error(`Unknown repair run ${incidentId}.`);
      const latestReview = store.latestReviewRun(incidentId);
      return {
        incident: {
          id: incident.id,
          status: incident.status,
          repair_provider_id: incident.repair_provider_id,
          repair_session_uuid: incident.repair_session_uuid,
        },
        repair_run: repairRun,
        repair_feedback: latestReview?.status === "no_ship" && latestReview.verdict_json
          ? JSON.parse(latestReview.verdict_json)
          : null,
        resume_evidence: repairRun.provider_session_uuid ? repairIncidentPacket(store, incidentId) : null,
      };
    }
    case "repair.provider_admit": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const run = store.getRepairRun(incidentId);
      if (!run || !["launched", "running"].includes(run.status)) {
        throw new Error(`Repair ${incidentId} is not admitted for provider transport.`);
      }
      const prepared = repairManager.load(incidentId);
      if (prepared.capabilityDigest !== run.provider_capability_digest
        || prepared.capabilityExpiresAtMs !== run.capability_expires_at_ms
        || prepared.capabilityExpiresAtMs <= Date.now()) {
        throw new Error("Repair provider capability is stale or does not match durable state.");
      }
      return {
        provider: await registerProviderCapability({
          socketPath: repairManager.environment.providerAdapterSocket,
          incidentId,
          workerKind: "repair",
          capability: prepared.capability,
          expiresAtMs: prepared.capabilityExpiresAtMs,
          replace: true,
        }),
      };
    }
    case "repair.provider_launch_begin": {
      const incidentId = requiredString(payload, "incident_id", 100);
      return { provider_launch: store.beginRepairProviderLaunch(incidentId) };
    }
    case "repair.launch": {
      const incidentId = requiredString(payload, "incident_id", 100);
      let run = store.getRepairRun(incidentId);
      if (!run || !["prepared", "launched"].includes(run.status)) {
        throw new Error(`Repair ${incidentId} is not prepared for launch.`);
      }
      let prepared;
      if (run.status === "prepared" && run.provider_session_uuid) {
        if (!run.pending_provider_capability_digest) {
          const current = repairManager.load(incidentId);
          if (current.evidenceDigest !== run.evidence_digest
            || current.capabilityDigest !== run.provider_capability_digest
            || current.capabilityExpiresAtMs !== run.capability_expires_at_ms
            || current.workerUnit !== run.worker_unit) {
            throw new Error("Prepared repair authority no longer matches durable state.");
          }
          const pending = repairManager.prepareCapabilityRotation(incidentId);
          run = store.beginRepairCapabilityRotation(
            incidentId,
            pending.capabilityDigest,
            pending.capabilityExpiresAtMs,
          );
        }
        prepared = repairManager.activateCapabilityRotation(
          incidentId,
          run.pending_provider_capability_digest!,
        );
        if (prepared.evidenceDigest !== run.evidence_digest
          || prepared.capabilityExpiresAtMs !== run.pending_capability_expires_at_ms
          || prepared.workerUnit !== run.worker_unit) {
          throw new Error("Pending repair authority no longer matches durable state.");
        }
        run = store.completeRepairCapabilityRotation(
          incidentId,
          prepared.capabilityDigest,
          prepared.capabilityExpiresAtMs,
        );
        repairManager.finishCapabilityRotation(incidentId, run.provider_capability_digest);
      } else {
        prepared = repairManager.load(incidentId);
        if (prepared.evidenceDigest !== run.evidence_digest
          || prepared.capabilityDigest !== run.provider_capability_digest
          || prepared.capabilityExpiresAtMs !== run.capability_expires_at_ms
          || prepared.workerUnit !== run.worker_unit) {
          throw new Error("Prepared repair authority no longer matches durable state.");
        }
      }
      const launched = store.markRepairRunLaunched(incidentId);
      await registerProviderCapability({
        socketPath: repairManager.environment.providerAdapterSocket,
        incidentId,
        workerKind: "repair",
        capability: prepared.capability,
        expiresAtMs: prepared.capabilityExpiresAtMs,
        replace: true,
      });
      repairManager.launch(run.worker_unit);
      return { repair_run: launched };
    }
    case "repair.complete": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const providerSessionUuid = requiredString(payload, "provider_session_uuid", 200);
      const result = objectValue(payload, "result");
      const run = store.getRepairRun(incidentId);
      if (!run) throw new Error(`Unknown repair run ${incidentId}.`);
      const outcome = requiredString(result, "outcome", 20);
      const nextAction = requiredString(result, "next_action", 40);
      if (outcome === "blocked") {
        const uncertainties = result.open_uncertainties;
        if (nextAction !== "park" || !Array.isArray(uncertainties) || uncertainties.length < 1) {
          throw new Error("Blocked repair completion requires a parked next action and concrete uncertainty.");
        }
        const currentHead = repairGit(repairManager, incidentId, ["rev-parse", "HEAD"]).toLowerCase();
        if (requiredString(result, "head_commit", 40).toLowerCase() !== currentHead) {
          throw new Error("Blocked repair result head does not match the isolated repository.");
        }
        const blocker = requiredString(result, "root_cause", 4_000);
        return store.blockRepairRun({ incidentId, providerSessionUuid, result, error: blocker });
      }
      if (outcome !== "proposed" || nextAction !== "submit_for_review") {
        throw new Error("Repair completion outcome is invalid.");
      }
      const status = repairGit(repairManager, incidentId, ["status", "--porcelain", "--untracked-files=all"]);
      if (status) throw new Error("Repair completion requires a clean committed repository.");
      if (repairGit(repairManager, incidentId, ["remote"])) throw new Error("Repair repository gained a remote.");
      const hooksPath = repairGit(repairManager, incidentId, ["config", "--get", "core.hooksPath"]);
      if (hooksPath !== "/dev/null") throw new Error("Repair repository hooks are not disabled.");
      const headCommit = repairGit(repairManager, incidentId, ["rev-parse", "HEAD"]).toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(headCommit) || headCommit === run.baseline_local_commit) {
        throw new Error("Repair completion requires a new committed repair head.");
      }
      repairGit(repairManager, incidentId, ["merge-base", "--is-ancestor", run.baseline_local_commit, headCommit]);
      const changedPaths = repairGit(repairManager, incidentId, [
        "diff", "--name-only", "--no-renames", `${run.baseline_local_commit}..${headCommit}`,
      ]).split("\n").filter(Boolean);
      const patch = repairGit(repairManager, incidentId, [
        "diff", "--binary", "--no-ext-diff", "--no-renames", `${run.baseline_local_commit}..${headCommit}`,
      ]);
      const policy = loadRepairPolicy(environment.policyPath);
      const evaluation = evaluateRepairDiff(policy.policy, changedPaths, Buffer.byteLength(patch));
      if (!evaluation.accepted) {
        throw new Error(`Repair diff violates installed policy: ${JSON.stringify(evaluation.rejected)}`);
      }
      const claimedHead = requiredString(result, "head_commit", 40).toLowerCase();
      if (claimedHead !== headCommit) throw new Error("Repair result head does not match the repository.");
      const tests = result.focused_tests;
      if (!Array.isArray(tests) || tests.length < 1 || tests.length > 20
        || tests.some((test) => !test || typeof test !== "object"
          || (test as Record<string, unknown>).status !== "passed")) {
        throw new Error("Repair result requires bounded passing focused-test evidence.");
      }
      const treeDigest = repairTreeDigest(run.repository_path);
      return {
        repair_run: store.completeRepairRun({
          incidentId,
          providerSessionUuid,
          result: {
            ...result,
            origin_base_commit: run.base_commit,
            baseline_local_commit: run.baseline_local_commit,
            head_commit: headCommit,
            tree_digest: treeDigest,
            policy_digest: policy.digest,
            enforcement_digest: digestProtectedKernel(environment.kernelRoot),
            evidence_digest: run.evidence_digest,
            changed_paths: evaluation.normalizedPaths,
            patch_bytes: Buffer.byteLength(patch),
          },
        }),
        policy_evaluation: evaluation,
        head_commit: headCommit,
        tree_digest: treeDigest,
      };
    }
    case "review.prepare": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const repairRun = store.getRepairRun(incidentId);
      if (!repairRun || repairRun.status !== "completed" || !repairRun.result_json) {
        throw new Error(`Incident ${incidentId} has no completed repair to review.`);
      }
      const repairResult = JSON.parse(repairRun.result_json) as Record<string, unknown>;
      const headCommit = requiredString(repairResult, "head_commit", 40).toLowerCase();
      const treeDigest = requiredString(repairResult, "tree_digest", 64).toLowerCase();
      if (repairGit(repairManager, incidentId, ["rev-parse", "HEAD"]).toLowerCase() !== headCommit
        || repairTreeDigest(repairRun.repository_path) !== treeDigest) {
        throw new Error("Repair repository drifted after completion.");
      }
      const currentPolicy = loadRepairPolicy(environment.policyPath);
      const currentEnforcement = digestProtectedKernel(environment.kernelRoot);
      if (repairResult.policy_digest !== currentPolicy.digest
        || repairResult.enforcement_digest !== currentEnforcement
        || repairResult.evidence_digest !== repairRun.evidence_digest) {
        throw new Error("Repair result authority digests no longer match the installed kernel.");
      }
      const latest = store.latestReviewRun(incidentId);
      if (latest && latest.head_commit === headCommit && latest.tree_digest === treeDigest) {
        return { review_run: latest };
      }
      const reviewId = randomUUID();
      const headArchive = repairGitResult(repairManager, incidentId, [
        "archive", "--format=tar", headCommit,
      ]).stdout;
      const exactPatch = repairGitResult(repairManager, incidentId, [
        "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames",
        `${repairRun.baseline_local_commit}..${headCommit}`,
      ]).stdout;
      const prepared = reviewManager.prepare({
        reviewId,
        incidentId,
        baseCommit: repairRun.base_commit,
        baselineLocalCommit: repairRun.baseline_local_commit,
        headCommit,
        treeDigest,
        policyDigest: currentPolicy.digest,
        enforcementDigest: currentEnforcement,
        evidenceDigest: repairRun.evidence_digest,
        repairResult,
        headArchive,
        exactPatch,
        charter: readFileSync(join(environment.kernelRoot, "review-charter.md"), "utf8"),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });
      return {
        review_run: store.prepareReviewRun({
          reviewId,
          incidentId,
          baseCommit: repairRun.base_commit,
          headCommit,
          treeDigest,
          policyDigest: currentPolicy.digest,
          enforcementDigest: currentEnforcement,
          evidenceDigest: repairRun.evidence_digest,
          repositoryPath: prepared.repositoryPath,
          controlPath: prepared.controlPath,
          providerCapabilityDigest: prepared.capabilityDigest,
          capabilityExpiresAtMs: prepared.capabilityExpiresAtMs,
          workerUnit: prepared.workerUnit,
        }),
      };
    }
    case "review.launch": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const reviewId = requiredString(payload, "review_id", 100);
      const review = store.getReviewRun(reviewId);
      const repair = store.getRepairRun(incidentId);
      if (!review || review.incident_id !== incidentId
        || !["prepared", "launched"].includes(review.status) || !repair?.result_json) {
        throw new Error(`Review ${reviewId} is not prepared for launch.`);
      }
      const prepared = reviewManager.prepare({
        reviewId,
        incidentId,
        baseCommit: review.base_commit,
        baselineLocalCommit: repair.baseline_local_commit,
        headCommit: review.head_commit,
        treeDigest: review.tree_digest,
        policyDigest: review.policy_digest,
        enforcementDigest: review.enforcement_digest,
        evidenceDigest: review.evidence_digest,
        repairResult: JSON.parse(repair.result_json),
        charter: readFileSync(join(environment.kernelRoot, "review-charter.md"), "utf8"),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });
      if (prepared.capabilityDigest !== review.provider_capability_digest
        || prepared.capabilityExpiresAtMs !== review.capability_expires_at_ms
        || prepared.workerUnit !== review.worker_unit) {
        throw new Error("Prepared review authority no longer matches durable state.");
      }
      const launched = store.markReviewRunLaunched(review.id);
      await registerProviderCapability({
        socketPath: reviewManager.environment.providerAdapterSocket,
        incidentId,
        workerKind: "review",
        capability: prepared.capability,
        expiresAtMs: prepared.capabilityExpiresAtMs,
        replace: true,
      });
      reviewManager.launch(review.worker_unit);
      return { review_run: launched };
    }
    case "review.status": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const reviewId = requiredString(payload, "review_id", 100);
      const review = store.getReviewRun(reviewId);
      if (!review || review.incident_id !== incidentId) throw new Error(`Unknown review ${reviewId}.`);
      return { review_run: review };
    }
    case "review.provider_admit": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const reviewId = requiredString(payload, "review_id", 100);
      const review = store.getReviewRun(reviewId);
      if (!review || review.incident_id !== incidentId || !["launched", "running"].includes(review.status)) {
        throw new Error(`Review ${reviewId} is not admitted for provider transport.`);
      }
      const repair = store.getRepairRun(incidentId);
      if (!repair?.result_json) throw new Error("Review repair evidence is unavailable.");
      const prepared = reviewManager.prepare({
        reviewId,
        incidentId,
        baseCommit: review.base_commit,
        baselineLocalCommit: repair.baseline_local_commit,
        headCommit: review.head_commit,
        treeDigest: review.tree_digest,
        policyDigest: review.policy_digest,
        enforcementDigest: review.enforcement_digest,
        evidenceDigest: review.evidence_digest,
        repairResult: JSON.parse(repair.result_json),
        charter: readFileSync(join(environment.kernelRoot, "review-charter.md"), "utf8"),
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      });
      if (prepared.capabilityDigest !== review.provider_capability_digest
        || prepared.capabilityExpiresAtMs !== review.capability_expires_at_ms
        || prepared.capabilityExpiresAtMs <= Date.now()) {
        throw new Error("Review provider capability is stale or does not match durable state.");
      }
      return {
        provider: await registerProviderCapability({
          socketPath: reviewManager.environment.providerAdapterSocket,
          incidentId,
          workerKind: "review",
          capability: prepared.capability,
          expiresAtMs: prepared.capabilityExpiresAtMs,
          replace: true,
        }),
      };
    }
    case "review.provider_launch_begin": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const reviewId = requiredString(payload, "review_id", 100);
      return { provider_launch: store.beginReviewProviderLaunch(incidentId, reviewId) };
    }
    case "review.bind_session": {
      return {
        review_run: store.bindReviewSession(
          requiredString(payload, "incident_id", 100),
          requiredString(payload, "review_id", 100),
          requiredString(payload, "provider_session_uuid", 200),
        ),
      };
    }
    case "review.complete": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const reviewId = requiredString(payload, "review_id", 100);
      const providerSessionUuid = requiredString(payload, "provider_session_uuid", 200);
      const result = objectValue(payload, "result");
      const review = store.getReviewRun(reviewId);
      if (!review || review.incident_id !== incidentId) throw new Error(`Unknown review ${reviewId}.`);
      const verdict = requiredString(result, "verdict", 20);
      if (verdict !== "SHIP" && verdict !== "NO_SHIP") throw new Error("Review verdict is invalid.");
      for (const [field, expected] of [
        ["review_id", review.id],
        ["base_commit", review.base_commit],
        ["head_commit", review.head_commit],
        ["tree_digest", review.tree_digest],
        ["policy_digest", review.policy_digest],
        ["enforcement_digest", review.enforcement_digest],
        ["evidence_digest", review.evidence_digest],
      ] as Array<[string, string]>) {
        if (result[field] !== expected) throw new Error(`Review result ${field} does not match its immutable packet.`);
      }
      const blockers = result.blockers;
      const checks = result.checks;
      if (!Array.isArray(blockers) || !Array.isArray(checks) || checks.length < 1
        || (verdict === "SHIP" && blockers.length !== 0)
        || (verdict === "NO_SHIP" && blockers.length < 1)) {
        throw new Error("Review result blockers and checks do not match its verdict.");
      }
      const repair = store.getRepairRun(incidentId)!;
      if (repairGit(repairManager, incidentId, ["rev-parse", "HEAD"]).toLowerCase() !== review.head_commit
        || repairTreeDigest(repair.repository_path) !== review.tree_digest) {
        throw new Error("Repair tree drifted while independent review was running.");
      }
      return {
        review_run: store.completeReviewRun({
          incidentId,
          reviewId,
          providerSessionUuid,
          verdict: verdict === "SHIP" ? "ship" : "no_ship",
          result,
        }),
      };
    }
    case "repair.integrate": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const repair = store.getRepairRun(incidentId);
      const review = store.latestReviewRun(incidentId);
      if (!repair?.result_json || !review || review.status !== "ship") {
        throw new Error(`Incident ${incidentId} has no independent SHIP to integrate.`);
      }
      const result = JSON.parse(repair.result_json) as Record<string, unknown>;
      if (review.base_commit !== repair.base_commit
        || review.head_commit !== result.head_commit
        || review.tree_digest !== result.tree_digest
        || review.policy_digest !== result.policy_digest
        || review.enforcement_digest !== result.enforcement_digest
        || review.evidence_digest !== repair.evidence_digest) {
        throw new Error("Independent SHIP no longer matches the completed repair identity.");
      }
      const currentOrigin = observeOrigin(environment);
      if (currentOrigin.desiredCommit !== repair.base_commit) {
        const reason = `origin/main moved from reviewed base ${repair.base_commit} to ${currentOrigin.desiredCommit}; exact-session refresh and re-review are required.`;
        return {
          refresh_required: true,
          observed_origin_commit: currentOrigin.desiredCommit,
          incident: store.requireRepairRefresh(incidentId, reason),
        };
      }
      const changedPaths = repairGit(repairManager, incidentId, [
        "diff", "--name-only", "--no-renames", `${repair.baseline_local_commit}..${review.head_commit}`,
      ]).split("\n").filter(Boolean);
      const patch = repairGitResult(repairManager, incidentId, [
        "diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames",
        `${repair.baseline_local_commit}..${review.head_commit}`,
      ]).stdout;
      const policy = loadRepairPolicy(environment.policyPath);
      const evaluation = evaluateRepairDiff(policy.policy, changedPaths, patch.byteLength);
      if (!evaluation.accepted || policy.digest !== review.policy_digest
        || digestProtectedKernel(environment.kernelRoot) !== review.enforcement_digest) {
        throw new Error("Installed repair authority or path-policy evaluation changed after review.");
      }
      const integration = integrationManager.integrate({
        incidentId,
        originBaseCommit: repair.base_commit,
        reviewedTreeDigest: review.tree_digest,
        reviewedPatch: patch,
        summary: requiredString(result, "summary", 4_000),
      });
      return {
        repair_run: store.markRepairIntegrated(incidentId, integration.integrated_commit),
        integration,
      };
    }
    case "learning.record": {
      const incidentId = requiredString(payload, "incident_id", 100);
      const incident = store.getIncident(incidentId)!;
      const repair = store.getRepairRun(incidentId);
      const latestReview = store.latestReviewRun(incidentId);
      const attempt = store.getAttempt(incident.last_attempt_id);
      if (!repair?.result_json || !latestReview || latestReview.status !== "ship" || !attempt?.evidence_json) {
        throw new Error("Incident has no verified repair evidence for learning closure.");
      }
      const repairResult = JSON.parse(repair.result_json) as Record<string, unknown>;
      const classification = incident.repeated_fingerprint_count > 1
        ? "execution_miss"
        : Array.isArray((repairResult.retrieval_trace as Record<string, unknown> | undefined)?.selected_entries)
          && ((repairResult.retrieval_trace as Record<string, unknown>).selected_entries as unknown[]).length > 0
          ? "execution_miss"
          : "novel_failure";
      const learningId = store.recordLearning({
        incidentId,
        classification,
        summary: `${incident.failure_fingerprint}: ${String(repairResult.root_cause || repairResult.summary || "deployment repair")}`.slice(0, 4_000),
        retrievalTrace: (repairResult.retrieval_trace && typeof repairResult.retrieval_trace === "object")
          ? repairResult.retrieval_trace as Record<string, unknown>
          : { selected_entries: [], influenced_action: "" },
        productionEvidence: JSON.parse(attempt.evidence_json),
      });
      return {
        learning_id: learningId,
        incident: store.transitionIncident(incidentId, "learning"),
        classification,
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
        repair_parked: ["awaiting_owner_fix", "parked"],
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
      return { notification: await deliverPreparedNotification(store, notifier, target, prepared) };
    }
    case "notification.reconcile": {
      const notification = store.getNotification(requiredString(payload, "notification_id", 100));
      if (!notification || !new Set(["prepared", "sending", "ambiguous"]).has(notification.status)) {
        throw new Error("Only an unsettled notification may reconcile.");
      }
      const target = store.getNotifierTarget(command.target);
      if (!target) throw new Error("Notifier target is not bootstrapped.");
      if (notification.status === "prepared") {
        return { notification: await deliverPreparedNotification(store, notifier, target, notification) };
      }
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
      return snapshot(store, environment, callerRole);
    default:
      throw new Error(`Unsupported kernel command ${command.command}.`);
  }
}

export async function handleKernelCommand(
  store: DeploymentControlStore,
  role: KernelCallerRole,
  value: unknown,
  environment: KernelEnvironment,
  peer: KernelPeerCredentials,
) {
  assertKernelCommand(value);
  authorizeKernelCommand(role, value.command);
  assertAuthenticatedPeer(store, role, value, environment, peer);
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
    const result = { ok: true, result: await dispatch(store, role, value, environment) };
    store.finishCommand(value.idempotency_key, result);
    return result;
  } catch (error) {
    if (error instanceof AmbiguousEffectError
      || error instanceof ReleaseEffectAmbiguousError
      || error instanceof RepairIntegrationAmbiguousError
      || error instanceof SlackNotificationAmbiguousError) {
      return store.markCommandAmbiguous(value.idempotency_key, error.message);
    }
    if (role === "coordinator"
      && !["snapshot.read", "activation.ack", "coordinator.heartbeat"].includes(value.command)) {
      const generationId = typeof value.payload.activation_generation_id === "string"
        ? value.payload.activation_generation_id
        : null;
      const generation = generationId ? store.getActivationGeneration(generationId) : null;
      const handoff = generationId ? store.getCoordinatorHandoff(generationId) : null;
      if (generation?.status === "exposed" && handoff
        && ["probation", "promoted"].includes(handoff.status)) {
        try {
          store.revokeActivationByWatchdog({
            generationId: generation.id,
            reason: `Coordinator attempted a rejected protected effect (${value.command}): ${error instanceof Error ? error.message : String(error)}`,
          });
        } catch {
          // The original rejection remains authoritative; the watchdog reconciles any concurrent revocation.
        }
      }
    }
    const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    store.finishCommand(value.idempotency_key, result, "rejected");
    return result;
  }
}

export function defaultKernelEnvironment(repositoryRoot = resolve(import.meta.dir, "../..")): KernelEnvironment {
  const kernelRoot = process.env.CONCIERGE_DEPLOYMENT_KERNEL_ROOT
    ? resolve(process.env.CONCIERGE_DEPLOYMENT_KERNEL_ROOT)
    : resolve(repositoryRoot, "deployment-control/kernel");
  return {
    repositoryRoot,
    policyPath: process.env.CONCIERGE_DEPLOYMENT_POLICY_PATH
      ? resolve(process.env.CONCIERGE_DEPLOYMENT_POLICY_PATH)
      : resolve(repositoryRoot, "config/deployment-repair-policy.toml"),
    kernelRoot,
    runtimeVersion: basename(realpathSync(kernelRoot)),
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
