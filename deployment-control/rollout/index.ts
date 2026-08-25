#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { currentProcessIdentity } from "../../bot/src/runtime-identity";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";

type ExpectedState = {
  entity: "target" | "generation" | "attempt" | "incident" | "notification" | "rollout" | "activation";
  id: string;
  status: string;
};

interface RolloutOwner {
  invocation_id: string;
  pid: number;
  boot_id: string;
  start_ticks: string;
}

export interface RolloutSupervisorServices {
  create(rolloutId: string, ownerUnit: string): Promise<any>;
  claim(rolloutId: string, expectedStatus: string, owner: RolloutOwner): Promise<any>;
  snapshot(): Promise<any>;
  heartbeat(rolloutId: string, expectedStatus: string, owner: RolloutOwner): Promise<any>;
  command(
    command: string,
    expected: ExpectedState,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    timeoutMs?: number,
  ): Promise<any>;
}

export interface RolloutStepOutcome {
  action: string;
  [key: string]: unknown;
}

const PREACTIVATION_PROBES = [
  "application_containment",
  "control_plane_health",
  "provider_session_continuity",
  "security_negative_matrix",
] as const;

const RECOVERY_PROBES = [
  "canary_recovery",
  "last_known_good_health",
  "contained_rollback",
] as const;

function time(value: string | null | undefined) {
  return value ? Date.parse(`${value.replace(" ", "T")}Z`) : 0;
}

function check(snapshot: any, name: string) {
  return snapshot.rollout_checks?.find((candidate: any) => candidate.name === name) || null;
}

function terminalFailure(snapshot: any) {
  const failedCheck = snapshot.rollout_checks?.find((candidate: any) =>
    candidate.status === "failed" || candidate.status === "ambiguous");
  if (failedCheck) return `Rollout probe ${failedCheck.name} ended ${failedCheck.status}: ${failedCheck.error || "no error detail"}`;
  const gateRecovery = snapshot.active_rollout?.status === "revoking";
  if (["ambiguous", "parked"].includes(snapshot.rollout_gates?.status) && !gateRecovery) {
    return `Rollout admission gates ended ${snapshot.rollout_gates.status}: ${snapshot.rollout_gates.error || "no error detail"}`;
  }
  for (const request of [snapshot.implementation_review_request, snapshot.live_evidence_review_request]) {
    if (["ambiguous", "parked"].includes(request?.status)) {
      return `Independent rollout review ${request.id} ended ${request.status}: ${request.error || "no error detail"}`;
    }
  }
  if (snapshot.implementation_review?.status === "no_ship") {
    return "Independent implementation review returned NO_SHIP for the installed identity.";
  }
  if (snapshot.live_evidence_review?.status === "no_ship") {
    return "Independent live-evidence review returned NO_SHIP for the frozen evidence.";
  }
  const repair = snapshot.rollout_repair_run;
  if (["ambiguous", "parked"].includes(repair?.status)) {
    return `Synthetic repair ended ${repair.status}: ${repair.error || "no error detail"}`;
  }
  const review = snapshot.rollout_review_run;
  if (["ambiguous", "parked"].includes(review?.status)) {
    return `Synthetic repair review ended ${review.status}: ${review.error || "no error detail"}`;
  }
  if (snapshot.rollout_incident?.status === "awaiting_owner_fix" || snapshot.rollout_incident?.status === "parked") {
    return `Synthetic incident requires human authority: ${snapshot.rollout_incident.error || "no error detail"}`;
  }
  return null;
}

function commandFor(
  services: RolloutSupervisorServices,
  rolloutId: string,
  owner: RolloutOwner,
) {
  return (
    command: string,
    expected: ExpectedState,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    timeoutMs = 120_000,
  ) => services.command(
    command,
    expected,
    { ...payload, rollout_id: rolloutId, owner },
    idempotencyKey,
    timeoutMs,
  );
}

async function runProbe(
  services: RolloutSupervisorServices,
  snapshot: any,
  rolloutId: string,
  owner: RolloutOwner,
  name: string,
) {
  const existing = check(snapshot, name);
  if (existing?.status === "passed") return null;
  await commandFor(services, rolloutId, owner)(
    "rollout.probe.run",
    { entity: "rollout", id: rolloutId, status: snapshot.active_rollout.status },
    { name },
    `kernel:rollout.probe:${rolloutId}:${name}:v1`,
    name === "security_negative_matrix" || name === "contained_rollback" ? 300_000 : 120_000,
  );
  return { action: "rollout_probe_run", probe: name } satisfies RolloutStepOutcome;
}

async function transition(
  services: RolloutSupervisorServices,
  snapshot: any,
  rolloutId: string,
  owner: RolloutOwner,
  status: string,
  nextStep: string,
  error?: string,
) {
  const from = snapshot.active_rollout.status;
  await commandFor(services, rolloutId, owner)(
    "rollout.transition",
    { entity: "rollout", id: rolloutId, status: from },
    { status, next_step: nextStep, ...(error ? { error } : {}) },
    `kernel:rollout.transition:${rolloutId}:${from}:${status}`,
  );
  return { action: `rollout_${status}`, prior_status: from, next_step: nextStep } satisfies RolloutStepOutcome;
}

async function reconcileActivation(
  services: RolloutSupervisorServices,
  snapshot: any,
  rolloutId: string,
  owner: RolloutOwner,
  kind: "canary" | "production",
) {
  const execute = commandFor(services, rolloutId, owner);
  const rollout = snapshot.active_rollout;
  const activation = kind === "canary" ? snapshot.canary_activation : snapshot.production_activation;
  const handoff = kind === "canary" ? snapshot.canary_handoff : snapshot.production_handoff;
  if (!activation || activation.rollout_id !== rolloutId) {
    const candidate = snapshot.coordinator_candidate;
    if (!candidate || !["a", "b"].includes(candidate.slot) || !candidate.version) {
      throw new Error("The installed root-owned coordinator catalog has no staged A/B candidate.");
    }
    await execute(
      "activation.prepare",
      { entity: "rollout", id: rolloutId, status: rollout.status },
      { kind, candidate_slot: candidate.slot, candidate_version: candidate.version },
      `kernel:activation.prepare:${rolloutId}:${kind}:${candidate.slot}:${candidate.version}`,
    );
    return { action: "activation_prepared", kind };
  }
  if (activation.status !== "pending") {
    throw new Error(`${kind} activation ${activation.id} is ${activation.status} before exposure reconciliation.`);
  }
  if (handoff?.status === "prepared") {
    await execute(
      "coordinator.candidate.start",
      { entity: "activation", id: activation.id, status: "pending" },
      { generation_id: activation.id },
      `kernel:coordinator.candidate.start:${activation.id}`,
    );
    return { action: "coordinator_candidate_started", kind, generation_id: activation.id };
  }
  if (!activation.bot_acknowledged_at || !activation.coordinator_acknowledged_at || handoff?.status !== "acknowledged") {
    return {
      action: "waiting_for_activation_acknowledgements",
      kind,
      bot_acknowledged: Boolean(activation.bot_acknowledged_at),
      coordinator_acknowledged: Boolean(activation.coordinator_acknowledged_at),
      coordinator_status: handoff?.status || "missing",
    };
  }
  await execute(
    "activation.expose",
    { entity: "activation", id: activation.id, status: "pending" },
    { generation_id: activation.id },
    `kernel:activation.expose:${activation.id}`,
  );
  return { action: "activation_exposed", kind, generation_id: activation.id };
}

async function reconcileSyntheticIncident(
  services: RolloutSupervisorServices,
  snapshot: any,
  rolloutId: string,
  owner: RolloutOwner,
) {
  const execute = commandFor(services, rolloutId, owner);
  const incident = snapshot.rollout_incident;
  if (!incident) {
    await execute(
      "rollout.synthetic.prepare",
      { entity: "rollout", id: rolloutId, status: "canary_probation" },
      {},
      `kernel:rollout.synthetic.prepare:${rolloutId}`,
    );
    return { action: "synthetic_incident_prepared" };
  }
  const repair = snapshot.rollout_repair_run;
  const review = snapshot.rollout_review_run;
  if (incident.status === "open" || incident.status === "stabilizing") {
    await execute(
      "incident.transition",
      { entity: "incident", id: incident.id, status: incident.status },
      { incident_id: incident.id, status: "diagnosing" },
      `kernel:incident.transition:${incident.id}:${incident.status}:diagnosing`,
    );
    return { action: "synthetic_incident_diagnosing", incident_id: incident.id };
  }
  if (incident.status === "diagnosing") {
    await execute(
      "repair.prepare",
      { entity: "incident", id: incident.id, status: "diagnosing" },
      { incident_id: incident.id },
      `kernel:repair.prepare:${incident.id}:${incident.repeated_fingerprint_count}`,
      300_000,
    );
    return { action: "synthetic_repair_prepared", incident_id: incident.id };
  }
  if (incident.status === "repairing") {
    if (repair?.status === "prepared") {
      await execute(
        "repair.launch",
        { entity: "incident", id: incident.id, status: "repairing" },
        { incident_id: incident.id },
        `kernel:repair.launch:${incident.id}:${repair.evidence_digest}`,
      );
      return { action: "synthetic_repair_launched", incident_id: incident.id };
    }
    return { action: "waiting_for_synthetic_repair", incident_id: incident.id, repair_status: repair?.status || "missing" };
  }
  if (incident.status === "reviewing") {
    const repairResult = repair?.result_json ? JSON.parse(repair.result_json) : null;
    const reviewMatches = review
      && review.head_commit === repairResult?.head_commit
      && review.tree_digest === repairResult?.tree_digest;
    if (!reviewMatches) {
      await execute(
        "review.prepare",
        { entity: "incident", id: incident.id, status: "reviewing" },
        { incident_id: incident.id },
        `kernel:review.prepare:${incident.id}:${repairResult?.head_commit || "pending"}`,
        300_000,
      );
      return { action: "synthetic_review_prepared", incident_id: incident.id };
    }
    if (review.status === "prepared") {
      await execute(
        "review.launch",
        { entity: "incident", id: incident.id, status: "reviewing" },
        { incident_id: incident.id, review_id: review.id },
        `kernel:review.launch:${review.id}`,
      );
      return { action: "synthetic_review_launched", incident_id: incident.id, review_id: review.id };
    }
    if (review.status === "ship" && !repair.integrated_commit) {
      const integrated = await execute(
        "repair.integrate",
        { entity: "incident", id: incident.id, status: "reviewing" },
        { incident_id: incident.id },
        `kernel:repair.integrate:${incident.id}:${review.id}`,
        300_000,
      );
      if (integrated.refresh_required) {
        return { action: "synthetic_repair_refresh_required", incident_id: incident.id };
      }
      return { action: "synthetic_repair_integrated", incident_id: incident.id };
    }
    return { action: "waiting_for_synthetic_review", incident_id: incident.id, review_status: review.status };
  }
  if (incident.status === "deploying") {
    let attempt = snapshot.active_attempt;
    if (!attempt) {
      const generation = snapshot.active_generation;
      if (!generation || generation.desired_commit !== repair?.integrated_commit) {
        throw new Error("The reviewed synthetic repair has no exact prepared deployment generation.");
      }
      const created = await execute(
        "attempt.create",
        { entity: "generation", id: generation.id, status: generation.status },
        { incident_id: incident.id, generation_id: generation.id },
        `kernel:attempt.create:${generation.id}`,
      );
      attempt = created.attempt;
      return { action: "synthetic_attempt_prepared", incident_id: incident.id, attempt_id: attempt.id };
    }
    if (attempt.status === "prepared") {
      await execute(
        "attempt.launch",
        { entity: "attempt", id: attempt.id, status: "prepared" },
        { incident_id: incident.id, attempt_id: attempt.id },
        `kernel:attempt.launch:${attempt.id}`,
      );
      return { action: "synthetic_attempt_launched", incident_id: incident.id, attempt_id: attempt.id };
    }
    if (attempt.status === "failed" || attempt.status === "ambiguous") {
      return { action: "synthetic_attempt_returned_to_diagnosis", incident_id: incident.id, attempt_status: attempt.status };
    }
    return { action: "waiting_for_synthetic_attempt", incident_id: incident.id, attempt_status: attempt.status };
  }
  if (incident.status === "verifying") {
    await execute(
      "learning.record",
      { entity: "incident", id: incident.id, status: "verifying" },
      { incident_id: incident.id },
      `kernel:learning.record:${incident.id}`,
    );
    return { action: "synthetic_learning_recorded", incident_id: incident.id };
  }
  if (incident.status === "learning") return { action: "synthetic_incident_ready_for_proof", incident_id: incident.id };
  return { action: "waiting_for_synthetic_incident", incident_id: incident.id, incident_status: incident.status };
}

function rollbackEvidence(snapshot: any) {
  const row = check(snapshot, "contained_rollback");
  return row?.evidence_json ? JSON.parse(row.evidence_json) : null;
}

async function reconcileRecovery(
  services: RolloutSupervisorServices,
  snapshot: any,
  rolloutId: string,
  owner: RolloutOwner,
) {
  const execute = commandFor(services, rolloutId, owner);
  for (const name of RECOVERY_PROBES) {
    const outcome = await runProbe(services, snapshot, rolloutId, owner, name);
    if (outcome) return outcome;
  }
  const incident = snapshot.rollout_incident;
  if (!incident || !["learning", "resolved"].includes(incident.status)) {
    throw new Error("Recovery proof lost the synthetic incident's durable learning state.");
  }
  const rollback = rollbackEvidence(snapshot);
  if (!rollback) throw new Error("Contained rollback passed without bounded evidence.");
  const notification = snapshot.rollout_incident_notifications?.find((candidate: any) =>
    candidate.kind === "runtime_restored");
  if (!notification && incident.status === "learning") {
    const lastKnownGood = snapshot.last_known_good;
    await execute(
      "notification.send",
      { entity: "incident", id: incident.id, status: "learning" },
      {
        incident_id: incident.id,
        kind: "runtime_restored",
        projection: {
          incident_id: incident.id,
          candidate_commit: lastKnownGood.git_commit,
          restored_commit: lastKnownGood.git_commit,
          service_invocation_id: rollback.restored_service_invocation_id,
          capture_probe: rollback.capture_probe,
          service_probe: rollback.service_probe,
          admission_state: "held",
          reason_code: "candidate_health_failed",
        },
      },
      `kernel:notification.runtime_restored:${incident.id}`,
    );
    return { action: "rollback_restoration_notification_sent", incident_id: incident.id };
  }
  if (!notification) throw new Error("The resolved synthetic incident has no restoration notification.");
  if (["prepared", "sending", "ambiguous"].includes(notification.status)) {
    await execute(
      "notification.reconcile",
      { entity: "notification", id: notification.id, status: notification.status },
      { notification_id: notification.id },
      `kernel:notification.reconcile:${notification.id}:${notification.status}:${randomUUID()}`,
    );
    return { action: "rollback_restoration_notification_reconciled", notification_id: notification.id };
  }
  if (notification.status !== "delivered") {
    throw new Error(`The rollback restoration notification ended ${notification.status}.`);
  }
  const alert = await runProbe(services, snapshot, rolloutId, owner, "contained_rollback_alert");
  if (alert) return alert;
  if (incident.status === "learning") {
    await execute(
      "incident.transition",
      { entity: "incident", id: incident.id, status: "learning" },
      { incident_id: incident.id, status: "resolved" },
      `kernel:incident.transition:${incident.id}:learning:resolved`,
    );
    return { action: "synthetic_incident_resolved", incident_id: incident.id };
  }
  await execute(
    "rollout.evidence.freeze",
    { entity: "rollout", id: rolloutId, status: "recovery_proving" },
    {},
    `kernel:rollout.evidence.freeze:${rolloutId}`,
  );
  return { action: "rollout_evidence_frozen" };
}

export async function reconcileRolloutStep(input: {
  services: RolloutSupervisorServices;
  snapshot: any;
  rolloutId: string;
  owner: RolloutOwner;
}): Promise<RolloutStepOutcome> {
  const { services, snapshot, rolloutId, owner } = input;
  const rollout = snapshot.active_rollout;
  if (!rollout || rollout.id !== rolloutId) {
    throw new Error(`Rollout ${rolloutId} is no longer the kernel's current rollout.`);
  }
  const failure = terminalFailure(snapshot);
  if (failure) throw new Error(failure);
  if (rollout.status === "staged") {
    return transition(services, snapshot, rolloutId, owner, "containing_application", "hold_admission_and_verify_containment");
  }
  if (rollout.status === "containing_application") {
    if (snapshot.rollout_gates?.status !== "held") {
      const result = await commandFor(services, rolloutId, owner)(
        "rollout.gates.hold",
        { entity: "rollout", id: rolloutId, status: "containing_application" },
        {},
        `kernel:rollout.gates.hold:${rolloutId}:${snapshot.rollout_gates?.status || "new"}:${randomUUID()}`,
      );
      return { action: result.gates?.status === "held" ? "rollout_admission_held" : "waiting_for_admission_drain" };
    }
    return transition(services, snapshot, rolloutId, owner, "staging_coordinator", "verify_staged_coordinator_candidate");
  }
  if (rollout.status === "staging_coordinator") {
    if (!snapshot.coordinator_candidate) throw new Error("No protected A/B coordinator candidate is installed.");
    return transition(services, snapshot, rolloutId, owner, "proving", "run_preactivation_proofs");
  }
  if (rollout.status === "proving") {
    for (const name of PREACTIVATION_PROBES) {
      const outcome = await runProbe(services, snapshot, rolloutId, owner, name);
      if (outcome) return outcome;
    }
    return transition(services, snapshot, rolloutId, owner, "review_pending", "launch_implementation_review");
  }
  if (rollout.status === "review_pending") {
    if (!snapshot.implementation_review_request) {
      await commandFor(services, rolloutId, owner)(
        "rollout.review.prepare",
        { entity: "rollout", id: rolloutId, status: "review_pending" },
        { review_kind: "implementation" },
        `kernel:rollout.review.prepare:${rolloutId}:implementation:${rollout.identity_digest}`,
        300_000,
      );
      return { action: "implementation_review_launched" };
    }
    return { action: "waiting_for_implementation_review", review_status: snapshot.implementation_review_request.status };
  }
  if (rollout.status === "authorized" || rollout.status === "canary_activating") {
    return reconcileActivation(services, snapshot, rolloutId, owner, "canary");
  }
  if (rollout.status === "canary_probation") {
    if (!snapshot.canary_handoff?.handshake_at || !snapshot.canary_handoff?.heartbeat_at) {
      return { action: "waiting_for_canary_handshake" };
    }
    const incidentOutcome = await reconcileSyntheticIncident(services, snapshot, rolloutId, owner);
    if (incidentOutcome.action !== "synthetic_incident_ready_for_proof") return incidentOutcome;
    const probe = await runProbe(services, snapshot, rolloutId, owner, "synthetic_incident");
    if (probe) return probe;
    await commandFor(services, rolloutId, owner)(
      "activation.revoke",
      { entity: "activation", id: snapshot.canary_activation.id, status: "exposed" },
      { generation_id: snapshot.canary_activation.id, reason: "Expected canary revocation after bounded synthetic proof." },
      `kernel:activation.revoke:${snapshot.canary_activation.id}:proof-complete`,
    );
    return { action: "canary_revoked_for_recovery_proof", generation_id: snapshot.canary_activation.id };
  }
  if (rollout.status === "recovery_proving") {
    return reconcileRecovery(services, snapshot, rolloutId, owner);
  }
  if (rollout.status === "evidence_review_pending") {
    if (!snapshot.live_evidence_review_request) {
      await commandFor(services, rolloutId, owner)(
        "rollout.review.prepare",
        { entity: "rollout", id: rolloutId, status: "evidence_review_pending" },
        { review_kind: "live_evidence" },
        `kernel:rollout.review.prepare:${rolloutId}:live_evidence:${rollout.evidence_digest}`,
        300_000,
      );
      return { action: "live_evidence_review_launched" };
    }
    return { action: "waiting_for_live_evidence_review", review_status: snapshot.live_evidence_review_request.status };
  }
  if (rollout.status === "production_authorized" || rollout.status === "production_activating") {
    return reconcileActivation(services, snapshot, rolloutId, owner, "production");
  }
  if (rollout.status === "production_probation") {
    const handoff = snapshot.production_handoff;
    if (!handoff?.handshake_at || !handoff?.heartbeat_at) return { action: "waiting_for_production_handshake" };
    if (handoff.status !== "promoted") {
      if (Date.now() < time(handoff.probation_deadline_at)) {
        return { action: "waiting_for_production_probation", probation_deadline_at: handoff.probation_deadline_at };
      }
      await commandFor(services, rolloutId, owner)(
        "coordinator.promote",
        { entity: "activation", id: snapshot.production_activation.id, status: "exposed" },
        { generation_id: snapshot.production_activation.id },
        `kernel:coordinator.promote:${snapshot.production_activation.id}`,
      );
      return { action: "production_coordinator_promoted", generation_id: snapshot.production_activation.id };
    }
    const probe = await runProbe(services, snapshot, rolloutId, owner, "production_health");
    if (probe) return probe;
    if (snapshot.rollout_gates?.status !== "released") {
      await commandFor(services, rolloutId, owner)(
        "rollout.gates.release",
        { entity: "rollout", id: rolloutId, status: "production_probation" },
        {},
        `kernel:rollout.gates.release:${rolloutId}:${randomUUID()}`,
      );
      return { action: "rollout_admission_released" };
    }
    await commandFor(services, rolloutId, owner)(
      "rollout.verify",
      { entity: "rollout", id: rolloutId, status: "production_probation" },
      { generation_id: snapshot.production_activation.id },
      `kernel:rollout.verify:${rolloutId}:${snapshot.production_activation.id}`,
    );
    return { action: "rollout_verified", generation_id: snapshot.production_activation.id };
  }
  if (rollout.status === "verified") {
    if (snapshot.rollout_gates?.status !== "released") {
      throw new Error(`Verified rollout ${rolloutId} still has ${snapshot.rollout_gates?.status || "missing"} admission gates.`);
    }
    return { action: "rollout_complete" };
  }
  if (rollout.status === "revoking") {
    if (snapshot.rollout_gates?.status !== "released") {
      await commandFor(services, rolloutId, owner)(
        "rollout.gates.recover",
        { entity: "rollout", id: rolloutId, status: "revoking" },
        {},
        `kernel:rollout.gates.recover:${rolloutId}:${randomUUID()}`,
      );
      return { action: "rollout_admission_recovered" };
    }
    return transition(services, snapshot, rolloutId, owner, "parked", "operator_inspection_required", rollout.error || undefined);
  }
  if (rollout.status === "parked") return { action: "rollout_parked", error: rollout.error };
  throw new Error(`Rollout ${rolloutId} has unsupported state ${rollout.status}.`);
}

async function parkFailedRollout(input: {
  services: RolloutSupervisorServices;
  rolloutId: string;
  owner: RolloutOwner;
  error: string;
}) {
  let snapshot = await input.services.snapshot();
  let rollout = snapshot.active_rollout;
  if (!rollout || rollout.id !== input.rolloutId || rollout.status === "parked") return rollout;
  if (rollout.status === "verified") {
    if (snapshot.rollout_gates?.status === "released") return rollout;
    throw new Error(
      `Verified rollout ${input.rolloutId} still has ${snapshot.rollout_gates?.status || "missing"} admission gates.`,
    );
  }
  const exposed = snapshot.active_activation;
  if (exposed?.rollout_id === input.rolloutId && exposed.status === "exposed") {
    await commandFor(input.services, input.rolloutId, input.owner)(
      "activation.revoke",
      { entity: "activation", id: exposed.id, status: "exposed" },
      { generation_id: exposed.id, reason: input.error.slice(0, 4_000) },
      `kernel:activation.revoke:${exposed.id}:failure`,
    );
    snapshot = await input.services.snapshot();
    rollout = snapshot.active_rollout;
  }
  if (!rollout || rollout.status === "parked") return rollout;
  if (rollout.status === "verified") {
    throw new Error(`Verified rollout ${input.rolloutId} cannot be parked after activation revocation.`);
  }
  if (rollout.status !== "revoking") {
    await transition(
      input.services,
      snapshot,
      input.rolloutId,
      input.owner,
      "revoking",
      "restore_last_known_good_and_park_or_stage",
      input.error.slice(0, 4_000),
    );
    snapshot = await input.services.snapshot();
  }
  if (snapshot.active_rollout?.status === "revoking") {
    if (snapshot.rollout_gates?.status !== "released") {
      await commandFor(input.services, input.rolloutId, input.owner)(
        "rollout.gates.recover",
        { entity: "rollout", id: input.rolloutId, status: "revoking" },
        {},
        `kernel:rollout.gates.recover:${input.rolloutId}:${randomUUID()}`,
      );
      snapshot = await input.services.snapshot();
    }
    if (snapshot.rollout_gates?.status !== "released") {
      throw new Error(`Rollout ${input.rolloutId} cannot park before its admission gates are released.`);
    }
    await transition(
      input.services,
      snapshot,
      input.rolloutId,
      input.owner,
      "parked",
      "operator_inspection_required",
      input.error.slice(0, 4_000),
    );
  }
  return (await input.services.snapshot()).active_rollout;
}

export function rolloutSupervisorServices(): RolloutSupervisorServices {
  return {
    create: (rolloutId, ownerUnit) => checkedKernelCommand(
      "rollout",
      "rollout.create",
      { entity: "target", id: "concierge", status: "ready" },
      { rollout_id: rolloutId, owner_unit: ownerUnit },
      { idempotencyKey: `kernel:rollout.create:${rolloutId}` },
    ),
    claim: (rolloutId, expectedStatus, owner) => checkedKernelCommand(
      "rollout",
      "rollout.claim",
      { entity: "rollout", id: rolloutId, status: expectedStatus },
      { rollout_id: rolloutId, owner },
      { idempotencyKey: `kernel:rollout.claim:${rolloutId}:${owner.invocation_id}` },
    ),
    snapshot: () => checkedKernelCommand(
      "rollout",
      "snapshot.read",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: `kernel:snapshot.read:rollout:${randomUUID()}` },
    ),
    heartbeat: (rolloutId, expectedStatus, owner) => checkedKernelCommand(
      "rollout",
      "rollout.heartbeat",
      { entity: "rollout", id: rolloutId, status: expectedStatus },
      { rollout_id: rolloutId, owner },
      { idempotencyKey: `kernel:rollout.heartbeat:${rolloutId}:${randomUUID()}` },
    ),
    command: (command, expected, payload, idempotencyKey, timeoutMs) => checkedKernelCommand(
      "rollout",
      command,
      expected,
      payload,
      { idempotencyKey, timeoutMs },
    ),
  };
}

export async function startRolloutSupervisor(input: {
  rolloutId: string;
  ownerUnit: string;
  invocationId: string;
  heartbeatIntervalMs?: number;
  services?: RolloutSupervisorServices;
  shouldStop?: () => boolean;
}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.rolloutId)) {
    throw new Error("The rollout supervisor requires a UUID instance ID.");
  }
  const expectedUnit = `concierge-deployment-rollout@${input.rolloutId}.service`;
  if (input.ownerUnit !== expectedUnit) throw new Error(`The rollout supervisor must run as ${expectedUnit}.`);
  if (!input.invocationId) throw new Error("The rollout supervisor requires its systemd invocation ID.");
  const identity = currentProcessIdentity();
  const owner: RolloutOwner = {
    invocation_id: input.invocationId,
    pid: identity.pid,
    boot_id: identity.bootId,
    start_ticks: identity.startTicks,
  };
  const services = input.services || rolloutSupervisorServices();
  const created = await services.create(input.rolloutId, input.ownerUnit);
  if (created.rollout.status === "parked") return created.rollout;
  if (created.rollout.status === "verified") {
    const terminal = await services.snapshot();
    if (terminal.rollout_gates?.status === "released") return created.rollout;
    throw new Error(`Verified rollout ${input.rolloutId} still has ${terminal.rollout_gates?.status || "missing"} admission gates.`);
  }
  let rollout = (await services.claim(input.rolloutId, created.rollout.status, owner)).rollout;
  console.log(JSON.stringify({
    event: "deployment_rollout_claimed",
    rollout_id: rollout.id,
    state: rollout.status,
    next_step: rollout.next_step,
    owner_invocation_id: rollout.owner_invocation_id,
  }));
  const interval = input.heartbeatIntervalMs ?? 5_000;
  while (!input.shouldStop?.()) {
    try {
      let snapshot = await services.snapshot();
      const observed = snapshot.active_rollout;
      if (!observed || observed.id !== input.rolloutId) {
        throw new Error(`Rollout ${input.rolloutId} is no longer the kernel's current rollout.`);
      }
      rollout = observed;
      rollout = (await services.heartbeat(input.rolloutId, rollout.status, owner)).rollout;
      snapshot = await services.snapshot();
      const outcome = await reconcileRolloutStep({ services, snapshot, rolloutId: input.rolloutId, owner });
      console.log(JSON.stringify({
        event: "deployment_rollout_reconciled",
        rollout_id: input.rolloutId,
        state: snapshot.active_rollout.status,
        next_step: snapshot.active_rollout.next_step,
        ...outcome,
      }));
      if (outcome.action === "rollout_complete" || outcome.action === "rollout_parked") {
        rollout = (await services.snapshot()).active_rollout;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: "deployment_rollout_step_failed", rollout_id: input.rolloutId, error: message }));
      try {
        rollout = await parkFailedRollout({ services, rolloutId: input.rolloutId, owner, error: message });
        console.error(JSON.stringify({
          event: "deployment_rollout_parked",
          rollout_id: input.rolloutId,
          state: rollout?.status || "unknown",
          error: message,
        }));
        break;
      } catch (parkError) {
        throw new Error(`Rollout step failed (${message}); fail-closed revocation is unresolved: ${parkError instanceof Error ? parkError.message : String(parkError)}`);
      }
    }
    if (input.shouldStop?.()) break;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return rollout;
}

if (import.meta.main) {
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  const rolloutId = process.argv[2] || "";
  const ownerUnit = process.env.CONCIERGE_ROLLOUT_UNIT || "";
  const invocationId = process.env.INVOCATION_ID || "";
  startRolloutSupervisor({
    rolloutId,
    ownerUnit,
    invocationId,
    shouldStop: () => stopping,
  }).catch((error) => {
    console.error(JSON.stringify({
      event: "deployment_rollout_failed",
      rollout_id: rolloutId,
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  });
}
