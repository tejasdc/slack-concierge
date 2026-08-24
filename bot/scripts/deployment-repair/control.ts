#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { processIdentity, isAncestorProcess } from "../../src/runtime-identity";
import { deploymentContinuationForTurn } from "../../src/deployment-state";
import { checkedKernelCommand } from "../../src/deployment-repair/kernel-client";
import type { KernelClientRole } from "../../src/deployment-repair/kernel-client";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function jsonOption(name: string) {
  const raw = option(name);
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
  return parsed as Record<string, unknown>;
}

function finish(code: number, payload: unknown): never {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

async function main() {
  const command = process.argv[2];
  if (command === "request") {
    const sourceTurnId = Number(process.env.CONCIERGE_TURN_ID || "");
    const ownerInstanceId = process.env.CONCIERGE_OWNER_INSTANCE_ID || "";
    if (!Number.isSafeInteger(sourceTurnId) || sourceTurnId <= 0 || !ownerInstanceId) {
      throw new Error("An agent deploy request requires CONCIERGE_TURN_ID and CONCIERGE_OWNER_INSTANCE_ID.");
    }
    const continuation = deploymentContinuationForTurn(sourceTurnId, ownerInstanceId);
    const expectedCommit = requiredOption("--expected-commit").toLowerCase();
    const result = await checkedKernelCommand(
      "bot",
      "intent.request",
      { entity: "target", id: "concierge", status: "ready" },
      {
        expected_commit: expectedCommit,
        continuation: {
          source_turn_id: continuation.sourceTurnId,
          source_session_id: continuation.sourceSessionId,
          slack_channel_id: continuation.slackChannelId,
          slack_thread_ts: continuation.slackThreadTs,
          requested_by_user_id: continuation.requestedByUserId,
          provider_id: continuation.providerId,
          provider_model: continuation.providerModel,
          reasoning_effort: continuation.reasoningEffort,
          provider_session_uuid: continuation.providerSessionUuid,
        },
      },
      { idempotencyKey: `kernel:intent.request:${sourceTurnId}:${expectedCommit}` },
    );
    finish(0, { status: "requested", intent: result.intent, origin: result.origin });
  }

  if (command === "prepare-generation") {
    const result = await checkedKernelCommand(
      "coordinator",
      "generation.prepare",
      { entity: "target", id: "concierge", status: "idle" },
      {},
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "create-attempt") {
    const generationId = requiredOption("--generation-id");
    const result = await checkedKernelCommand(
      "coordinator",
      "attempt.create",
      { entity: "generation", id: generationId, status: requiredOption("--expected-status") },
      { generation_id: generationId },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "claim-attempt") {
    const attemptId = requiredOption("--attempt-id");
    const ownerPid = Number(requiredOption("--owner-pid"));
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !isAncestorProcess(ownerPid)) {
      throw new Error("--owner-pid must identify a live ancestor deployment runner.");
    }
    const identity = processIdentity(ownerPid);
    const result = await checkedKernelCommand(
      "runner",
      "attempt.claim",
      { entity: "attempt", id: attemptId, status: "prepared" },
      {
        attempt_id: attemptId,
        runner_pid: identity.pid,
        runner_boot_id: identity.bootId,
        runner_start_ticks: identity.startTicks,
      },
      { idempotencyKey: `kernel:attempt.claim:${attemptId}` },
    );
    finish(0, result);
  }

  if (command === "phase") {
    const attemptId = requiredOption("--attempt-id");
    const phase = requiredOption("--phase");
    const expectedStatus = requiredOption("--expected-status");
    const result = await checkedKernelCommand(
      "runner",
      "attempt.phase",
      { entity: "attempt", id: attemptId, status: expectedStatus },
      { attempt_id: attemptId, phase, detail: jsonOption("--detail") },
      { idempotencyKey: `kernel:attempt.phase:${attemptId}:${phase}` },
    );
    finish(0, result);
  }

  if (command === "fail") {
    const attemptId = requiredOption("--attempt-id");
    const result = await checkedKernelCommand(
      "runner",
      "attempt.fail",
      { entity: "attempt", id: attemptId, status: requiredOption("--expected-status") },
      {
        attempt_id: attemptId,
        outcome: option("--outcome") === "ambiguous" ? "ambiguous" : "failed",
        error: requiredOption("--error"),
        failure_fingerprint: requiredOption("--failure-fingerprint"),
      },
      { idempotencyKey: `kernel:attempt.fail:${attemptId}` },
    );
    finish(0, result);
  }

  if (command === "succeed") {
    const attemptId = requiredOption("--attempt-id");
    const result = await checkedKernelCommand(
      "runner",
      "attempt.succeed",
      { entity: "attempt", id: attemptId, status: "releasing" },
      {
        attempt_id: attemptId,
        deployed_commit: requiredOption("--deployed-commit"),
        service_invocation_id: requiredOption("--service-invocation-id"),
        evidence: jsonOption("--evidence"),
      },
      { idempotencyKey: `kernel:attempt.succeed:${attemptId}` },
    );
    finish(0, result);
  }

  if (command === "prepare-release") {
    const attemptId = requiredOption("--attempt-id");
    const result = await checkedKernelCommand(
      "runner",
      "release.prepare",
      { entity: "attempt", id: attemptId, status: "updating" },
      { attempt_id: attemptId },
      { idempotencyKey: `kernel:release.prepare:${attemptId}` },
    );
    finish(0, result);
  }

  if (command === "activate-release") {
    const attemptId = requiredOption("--attempt-id");
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "runner",
      "release.activate",
      { entity: "attempt", id: attemptId, status: "activating" },
      { attempt_id: attemptId, release_id: releaseId },
      { idempotencyKey: `kernel:release.activate:${attemptId}:${releaseId}` },
    );
    finish(0, result);
  }

  if (command === "healthy-release") {
    const attemptId = requiredOption("--attempt-id");
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "runner",
      "release.healthy",
      { entity: "attempt", id: attemptId, status: "verifying" },
      {
        attempt_id: attemptId,
        release_id: releaseId,
        service_invocation_id: requiredOption("--service-invocation-id"),
        evidence: jsonOption("--evidence"),
      },
      { idempotencyKey: `kernel:release.healthy:${attemptId}:${releaseId}` },
    );
    finish(0, result);
  }

  if (command === "promote-release") {
    const attemptId = requiredOption("--attempt-id");
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "runner",
      "release.promote",
      { entity: "attempt", id: attemptId, status: "releasing" },
      { attempt_id: attemptId, release_id: releaseId, evidence: jsonOption("--evidence") },
      { idempotencyKey: `kernel:release.promote:${attemptId}:${releaseId}` },
    );
    finish(0, result);
  }

  if (command === "restore-release") {
    const incidentId = requiredOption("--incident-id");
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "operator",
      "release.restore",
      { entity: "incident", id: incidentId, status: "stabilizing" },
      { incident_id: incidentId, release_id: releaseId },
      { idempotencyKey: `kernel:release.restore:${incidentId}:${releaseId}` },
    );
    finish(0, result);
  }

  if (command === "restore-proven") {
    const incidentId = requiredOption("--incident-id");
    const result = await checkedKernelCommand(
      "coordinator",
      "release.restore_proven",
      { entity: "incident", id: incidentId, status: "stabilizing" },
      {
        incident_id: incidentId,
        attempt_id: requiredOption("--attempt-id"),
        release_id: requiredOption("--release-id"),
        service_invocation_id: requiredOption("--service-invocation-id"),
        evidence: jsonOption("--evidence"),
      },
      { idempotencyKey: `kernel:release.restore_proven:${incidentId}` },
    );
    finish(0, result);
  }

  if (command === "incident-transition") {
    const incidentId = requiredOption("--incident-id");
    const result = await checkedKernelCommand(
      "coordinator",
      "incident.transition",
      { entity: "incident", id: incidentId, status: requiredOption("--expected-status") },
      {
        incident_id: incidentId,
        status: requiredOption("--status"),
        error: option("--error"),
      },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "bootstrap-release") {
    const result = await checkedKernelCommand(
      "operator",
      "release.bootstrap_prepare",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "bootstrap-activate-release") {
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "operator",
      "release.bootstrap_activate",
      { entity: "release", id: releaseId, status: requiredOption("--expected-status") },
      { release_id: releaseId },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "bootstrap-promote-release") {
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "operator",
      "release.bootstrap_promote",
      { entity: "release", id: releaseId, status: requiredOption("--expected-status") },
      {
        release_id: releaseId,
        service_invocation_id: requiredOption("--service-invocation-id"),
        evidence: jsonOption("--evidence"),
      },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "bootstrap-restore-release") {
    const releaseId = requiredOption("--release-id");
    const result = await checkedKernelCommand(
      "operator",
      "release.bootstrap_restore",
      { entity: "target", id: "concierge", status: "ready" },
      { release_id: releaseId },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "bootstrap-abort-release") {
    const result = await checkedKernelCommand(
      "operator",
      "release.bootstrap_abort",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "notifier-bootstrap") {
    const result = await checkedKernelCommand(
      "operator",
      "notifier.target.bootstrap",
      { entity: "target", id: "concierge", status: "ready" },
      { registry_code_path: requiredOption("--registry-code-path") },
      { idempotencyKey: "kernel:notifier.target.bootstrap:concierge:v1" },
    );
    finish(0, result);
  }

  if (command === "notifier-preflight") {
    const result = await checkedKernelCommand(
      "operator",
      "notifier.preflight",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "notification-send") {
    const incidentId = requiredOption("--incident-id");
    const result = await checkedKernelCommand(
      "operator",
      "notification.send",
      { entity: "incident", id: incidentId, status: requiredOption("--expected-status") },
      {
        incident_id: incidentId,
        kind: requiredOption("--kind"),
        projection: jsonOption("--projection"),
      },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "notification-reconcile") {
    const notificationId = requiredOption("--notification-id");
    const result = await checkedKernelCommand(
      "operator",
      "notification.reconcile",
      { entity: "notification", id: notificationId, status: requiredOption("--expected-status") },
      { notification_id: notificationId },
      { idempotencyKey: requiredOption("--idempotency-key") },
    );
    finish(0, result);
  }

  if (command === "snapshot") {
    const role = option("--role") || "operator";
    if (!new Set(["bot", "coordinator", "runner", "repair", "review", "operator"]).has(role)) {
      throw new Error("--role is invalid.");
    }
    const result = await checkedKernelCommand(
      role as KernelClientRole,
      "snapshot.read",
      { entity: "target", id: "concierge", status: "ready" },
      {},
      { idempotencyKey: `kernel:snapshot.read:${randomUUID()}` },
    );
    finish(0, result);
  }

  throw new Error("usage: control.ts <request|prepare-generation|create-attempt|claim-attempt|phase|fail|succeed|prepare-release|activate-release|healthy-release|promote-release|restore-release|restore-proven|incident-transition|bootstrap-release|bootstrap-activate-release|bootstrap-promote-release|bootstrap-restore-release|bootstrap-abort-release|notifier-bootstrap|notifier-preflight|notification-send|notification-reconcile|snapshot> [options]");
}

main().catch((error) => finish(1, { status: "error", error: error instanceof Error ? error.message : String(error) }));
