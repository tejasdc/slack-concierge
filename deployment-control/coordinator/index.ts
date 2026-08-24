#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";

export interface CoordinatorServices {
  snapshot(): Promise<any>;
  acknowledgeActivation(generationId: string, identityDigest: string): Promise<any>;
  prepareGeneration(): Promise<any>;
  createAttempt(generationId: string, expectedStatus: string): Promise<any>;
  launchAttempt(attemptId: string): Promise<any>;
  transitionIncident(incidentId: string, from: string, to: string, error?: string): Promise<any>;
  prepareRepair(incidentId: string): Promise<any>;
  launchRepair(incidentId: string): Promise<any>;
  prepareReview(incidentId: string): Promise<any>;
  launchReview(incidentId: string, reviewId: string): Promise<any>;
  integrateRepair(incidentId: string, reviewId: string): Promise<any>;
  recordLearning(incidentId: string): Promise<any>;
  notifyParked(incidentId: string, projection: Record<string, unknown>): Promise<any>;
  notifyForward(incidentId: string, projection: Record<string, unknown>): Promise<any>;
  reconcileNotification(notificationId: string, expectedStatus: string): Promise<any>;
}

export function coordinatorServices(): CoordinatorServices {
  let activationGenerationId: string | null = null;
  const activated = (payload: Record<string, unknown>) => {
    if (!activationGenerationId) throw new Error("The coordinator has no exposed production activation generation.");
    return { ...payload, activation_generation_id: activationGenerationId };
  };
  return {
    snapshot: async () => {
      const result = await checkedKernelCommand(
        "coordinator",
        "snapshot.read",
        { entity: "target", id: "concierge", status: "ready" },
        {},
        { idempotencyKey: `kernel:snapshot.read:coordinator:${randomUUID()}` },
      );
      activationGenerationId = result.active_activation?.kind === "production"
        ? result.active_activation.id
        : null;
      return result;
    },
    acknowledgeActivation: (generationId, identityDigest) => checkedKernelCommand(
      "coordinator",
      "activation.ack",
      { entity: "activation", id: generationId, status: "pending" },
      { generation_id: generationId, identity_digest: identityDigest },
      { idempotencyKey: `kernel:activation.ack:coordinator:${generationId}:${identityDigest}` },
    ),
    prepareGeneration: () => checkedKernelCommand(
      "coordinator",
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      activated({}),
      { idempotencyKey: `kernel:generation.prepare:${randomUUID()}` },
    ),
    createAttempt: (generationId, expectedStatus) => checkedKernelCommand(
      "coordinator",
      "attempt.create",
      { entity: "generation", id: generationId, status: expectedStatus },
      activated({ generation_id: generationId }),
      { idempotencyKey: `kernel:attempt.create:${generationId}` },
    ),
    launchAttempt: (attemptId) => checkedKernelCommand(
      "coordinator",
      "attempt.launch",
      { entity: "attempt", id: attemptId, status: "prepared" },
      activated({ attempt_id: attemptId }),
      { idempotencyKey: `kernel:attempt.launch:${attemptId}` },
    ),
    transitionIncident: (incidentId, from, to, error) => checkedKernelCommand(
      "coordinator",
      "incident.transition",
      { entity: "incident", id: incidentId, status: from },
      activated({ incident_id: incidentId, status: to, ...(error ? { error } : {}) }),
      { idempotencyKey: `kernel:incident.transition:${incidentId}:${from}:${to}` },
    ),
    prepareRepair: (incidentId) => checkedKernelCommand(
      "coordinator",
      "repair.prepare",
      { entity: "incident", id: incidentId, status: "diagnosing" },
      activated({ incident_id: incidentId }),
      { idempotencyKey: `kernel:repair.prepare:${incidentId}` },
    ),
    launchRepair: (incidentId) => checkedKernelCommand(
      "coordinator",
      "repair.launch",
      { entity: "incident", id: incidentId, status: "repairing" },
      activated({ incident_id: incidentId }),
      { idempotencyKey: `kernel:repair.launch:${incidentId}:${randomUUID()}` },
    ),
    prepareReview: (incidentId) => checkedKernelCommand(
      "coordinator",
      "review.prepare",
      { entity: "incident", id: incidentId, status: "reviewing" },
      activated({ incident_id: incidentId }),
      { idempotencyKey: `kernel:review.prepare:${incidentId}:${randomUUID()}` },
    ),
    launchReview: (incidentId, reviewId) => checkedKernelCommand(
      "coordinator",
      "review.launch",
      { entity: "incident", id: incidentId, status: "reviewing" },
      activated({ incident_id: incidentId, review_id: reviewId }),
      { idempotencyKey: `kernel:review.launch:${reviewId}:${randomUUID()}` },
    ),
    integrateRepair: (incidentId, reviewId) => checkedKernelCommand(
      "coordinator",
      "repair.integrate",
      { entity: "incident", id: incidentId, status: "reviewing" },
      activated({ incident_id: incidentId }),
      { idempotencyKey: `kernel:repair.integrate:${incidentId}:${reviewId}` },
    ),
    recordLearning: (incidentId) => checkedKernelCommand(
      "coordinator",
      "learning.record",
      { entity: "incident", id: incidentId, status: "verifying" },
      activated({ incident_id: incidentId }),
      { idempotencyKey: `kernel:learning.record:${incidentId}` },
    ),
    notifyParked: (incidentId, projection) => checkedKernelCommand(
      "coordinator",
      "notification.send",
      { entity: "incident", id: incidentId, status: "awaiting_owner_fix" },
      activated({ incident_id: incidentId, kind: "repair_parked", projection }),
      { idempotencyKey: `kernel:notification.parked:${incidentId}` },
    ),
    notifyForward: (incidentId, projection) => checkedKernelCommand(
      "coordinator",
      "notification.send",
      { entity: "incident", id: incidentId, status: "learning" },
      activated({ incident_id: incidentId, kind: "forward_repair_succeeded", projection }),
      { idempotencyKey: `kernel:notification.forward:${incidentId}` },
    ),
    reconcileNotification: (notificationId, expectedStatus) => checkedKernelCommand(
      "coordinator",
      "notification.reconcile",
      { entity: "notification", id: notificationId, status: expectedStatus },
      activated({ notification_id: notificationId }),
      { idempotencyKey: `kernel:notification.reconcile:${notificationId}:${randomUUID()}` },
    ),
  };
}

async function reconcileIncident(services: CoordinatorServices, current: any, autonomous = true) {
  const incident = current.active_incident;
  if (!autonomous) return { action: "waiting_for_repair_prerequisites", incident_id: incident.id };
  if (incident.status === "open" || incident.status === "stabilizing") {
    await services.transitionIncident(incident.id, incident.status, "diagnosing");
    return { action: "incident_diagnosing", incident_id: incident.id };
  }
  if (incident.status === "diagnosing") {
    if (["prepared", "launched"].includes(current.active_repair_run?.status)) {
      await services.launchRepair(incident.id);
      return { action: "repair_launched", incident_id: incident.id };
    }
    await services.prepareRepair(incident.id);
    return { action: "repair_prepared", incident_id: incident.id };
  }
  if (incident.status === "repairing") {
    if (["prepared", "launched"].includes(current.active_repair_run?.status)) {
      await services.launchRepair(incident.id);
      return { action: "repair_launched", incident_id: incident.id };
    }
    return { action: "repair_active", incident_id: incident.id, status: current.active_repair_run?.status };
  }
  if (incident.status === "awaiting_owner_fix") {
    const parked = current.incident_notifications?.find((notice: any) => notice.kind === "repair_parked");
    if (!parked) {
      await services.notifyParked(incident.id, {
        incident_id: incident.id,
        candidate_commit: current.incident_generation.desired_commit,
        admission_state: current.incident_attempt?.status === "restored" ? "released" : "held",
        reason_code: "human_authority_required",
      });
      return { action: "repair_parked_notified", incident_id: incident.id };
    }
    if (parked.status !== "delivered" && parked.status !== "parked") {
      return { action: "waiting_for_park_notification", incident_id: incident.id };
    }
    await services.transitionIncident(incident.id, "awaiting_owner_fix", "parked", incident.error);
    return { action: "incident_parked", incident_id: incident.id };
  }
  if (incident.status === "reviewing") {
    const review = current.latest_review_run;
    const repairResult = current.active_repair_run?.result_json
      ? JSON.parse(current.active_repair_run.result_json)
      : null;
    if (!review || review.head_commit !== repairResult?.head_commit || review.tree_digest !== repairResult?.tree_digest) {
      await services.prepareReview(incident.id);
      return { action: "review_prepared", incident_id: incident.id };
    }
    if (["prepared", "launched"].includes(review.status)) {
      await services.launchReview(incident.id, review.id);
      return { action: "review_launched", incident_id: incident.id, review_id: review.id };
    }
    if (review.status === "ship") {
      const integrated = await services.integrateRepair(incident.id, review.id);
      if (integrated.refresh_required) {
        return {
          action: "repair_refresh_required",
          incident_id: incident.id,
          observed_origin_commit: integrated.observed_origin_commit,
        };
      }
      return { action: "repair_integrated", incident_id: incident.id, integrated_commit: integrated.integration.integrated_commit };
    }
    return { action: "review_active", incident_id: incident.id, status: review.status };
  }
  if (incident.status === "verifying") {
    if (current.unsettled_handoffs?.length) {
      return { action: "waiting_for_feature_verification", incident_id: incident.id };
    }
    await services.recordLearning(incident.id);
    return { action: "learning_recorded", incident_id: incident.id };
  }
  if (incident.status === "learning") {
    const root = current.incident_notifications?.find((notice: any) => notice.root_alert_id == null
      && notice.status === "delivered");
    const terminal = current.incident_notifications?.find((notice: any) => notice.kind === "forward_repair_succeeded");
    if (root && !terminal) {
      const attempt = current.incident_attempt;
      const evidence = JSON.parse(attempt.evidence_json);
      await services.notifyForward(incident.id, {
        incident_id: incident.id,
        deployed_commit: attempt.deployed_commit,
        service_invocation_id: attempt.service_invocation_id,
        capture_probe: evidence.capture_probe,
        service_probe: evidence.service_probe,
        admission_state: "released",
      });
      return { action: "forward_repair_notified", incident_id: incident.id };
    }
    if (terminal && terminal.status !== "delivered") {
      return { action: "waiting_for_terminal_notification", incident_id: incident.id };
    }
    await services.transitionIncident(incident.id, "learning", "resolved");
    return { action: "incident_resolved", incident_id: incident.id };
  }
  if (incident.status !== "deploying") {
    return { action: "incident_active", incident_id: incident.id, status: incident.status };
  }
  return null;
}

export async function reconcileDeploymentTarget(
  services: CoordinatorServices,
  options: { enabled?: boolean } = {},
) {
  if (options.enabled === false) {
    return { action: "disabled" };
  }
  let current = await services.snapshot();
  const pendingActivation = current.activation_generation;
  if (pendingActivation?.status === "pending" && !pendingActivation.coordinator_acknowledged_at) {
    await services.acknowledgeActivation(pendingActivation.id, pendingActivation.identity_digest);
    return { action: "activation_acknowledged", generation_id: pendingActivation.id };
  }
  if (options.enabled === undefined && current.active_activation?.kind !== "production") {
    return {
      action: current.active_activation?.kind === "canary" ? "canary_probation_waiting" : "disabled",
      ...(current.active_activation ? { generation_id: current.active_activation.id } : {}),
    };
  }
  const unsettledNotification = current.unsettled_notifications?.[0];
  if (unsettledNotification) {
    await services.reconcileNotification(unsettledNotification.id, unsettledNotification.status);
    return {
      action: "notification_reconciled",
      notification_id: unsettledNotification.id,
    };
  }
  if (current.active_incident) {
    const autonomous = options.enabled === true
      ? process.env.CONCIERGE_AUTONOMOUS_REPAIR_ENABLED === "1"
      : true;
    const incidentOutcome = await reconcileIncident(services, current, autonomous);
    if (incidentOutcome) return incidentOutcome;
  }

  if (!current.active_generation) {
    if (!current.pending_intents?.length) return { action: "idle" };
    await services.prepareGeneration();
    current = await services.snapshot();
  }

  if (!current.active_generation) throw new Error("Generation preparation completed without an active generation.");
  let attempt = current.active_attempt;
  if (!attempt) {
    const created = await services.createAttempt(current.active_generation.id, current.active_generation.status);
    attempt = created.attempt;
  }
  if (attempt.status === "prepared") {
    const launched = await services.launchAttempt(attempt.id);
    return { action: "attempt_launched", attempt_id: attempt.id, unit_name: launched.unit_name };
  }
  return { action: "attempt_active", attempt_id: attempt.id, status: attempt.status };
}

if (import.meta.main) {
  const runtimeVersion = basename(realpathSync(dirname(process.argv[1])));
  if (!/^[0-9a-f]{64}$/.test(runtimeVersion)) {
    throw new Error("Deployment coordinator is not running from an immutable version directory.");
  }
  const versionPath = process.env.CONCIERGE_COORDINATOR_VERSION_PATH
    || "/var/lib/concierge-deploy/runtime-version";
  const temporaryVersionPath = `${versionPath}.${process.pid}`;
  writeFileSync(temporaryVersionPath, `${runtimeVersion}\n`, { mode: 0o600 });
  renameSync(temporaryVersionPath, versionPath);
  const services = coordinatorServices();
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  while (!stopping) {
    try {
      const outcome = await reconcileDeploymentTarget(services);
      if (outcome.action !== "idle" && outcome.action !== "disabled") {
        console.log(JSON.stringify({ event: "deployment_coordinator_reconciled", ...outcome }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "deployment_coordinator_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    await Bun.sleep(5_000);
  }
}
