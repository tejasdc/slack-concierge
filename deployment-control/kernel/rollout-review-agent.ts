#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedKernelCommand, DeploymentKernelCommandError } from "../../bot/src/deployment-repair/kernel-client";
import { currentProcessIdentity } from "../../bot/src/runtime-identity";
import { providerSessionFromEvent } from "./repair-agent";

const RUNTIME_ROOT = "/usr/local/lib/concierge-deployment";
const WORKER_ROOT = "/var/lib/concierge-review/rollout-reviews";
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

async function runRolloutReview(requestId: string) {
  assertUuid(requestId, "Rollout review request");
  if (process.geteuid?.() === 0) throw new Error("Rollout review worker refuses to run as root.");
  const invocationId = process.env.INVOCATION_ID || "";
  if (!invocationId) throw new Error("Rollout review worker requires its systemd invocation ID.");
  const workerRoot = join(WORKER_ROOT, requestId);
  const metadataPath = process.env.CONCIERGE_REVIEW_METADATA_PATH || "";
  if (!metadataPath) throw new Error("Rollout review worker requires its protected metadata path.");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, any>;
  if (metadata.review_id !== requestId || metadata.incident_id !== requestId
    || metadata.worker_kind !== "rollout"
    || metadata.repository_path !== join(workerRoot, "repository")) {
    throw new Error("Rollout review worker control identity is invalid.");
  }
  const controlPath = join(workerRoot, "control");
  const packet = JSON.parse(readFileSync(join(controlPath, "metadata.json"), "utf8")) as Record<string, any>;
  if (packet.review_id !== requestId || packet.incident_id !== requestId) {
    throw new Error("Rollout review packet identity drifted.");
  }
  const processOwner = currentProcessIdentity();
  const owner = {
    invocation_id: invocationId,
    pid: processOwner.pid,
    boot_id: processOwner.bootId,
    start_ticks: processOwner.startTicks,
  };
  const claimed = await checkedKernelCommand(
    "review",
    "rollout.review.claim",
    { entity: "rollout_review", id: requestId, status: "prepared" },
    { request_id: requestId, owner },
    { idempotencyKey: `kernel:rollout.review.claim:${requestId}:${invocationId}` },
  );
  const request = claimed.review_request;
  if (request.id !== requestId || request.worker_unit !== `concierge-deployment-rollout-review@${requestId}.service`
    || request.repository_path !== metadata.repository_path) {
    throw new Error("Kernel rollout review authority does not match the worker instance.");
  }
  const capability = readFileSync(join(controlPath, "provider.cap"), "utf8").trim();
  await checkedKernelCommand(
    "review",
    "rollout.review.provider_admit",
    { entity: "rollout_review", id: requestId, status: "running" },
    { request_id: requestId, owner },
    { idempotencyKey: `kernel:rollout.review.provider_admit:${requestId}:${invocationId}` },
  );
  const prompt = readFileSync(join(controlPath, "prompt.md"), "utf8");
  const resultPath = join(workerRoot, "output", "result.json");
  const codex = join(RUNTIME_ROOT, "codex");
  const schema = join(RUNTIME_ROOT, "kernel", "current", "review-result.schema.json");
  if (!existsSync(codex) || !existsSync(schema)) throw new Error("Pinned rollout review runtime is incomplete.");
  const child = Bun.spawn({
    cmd: [codex, "exec", "--strict-config", "--json", "--output-schema", schema,
      "-o", resultPath, "-C", metadata.repository_path, "-"],
    cwd: metadata.repository_path,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      CODEX_HOME: join(workerRoot, "codex"),
      CONCIERGE_PROVIDER_CAPABILITY: capability,
      HOME: join(workerRoot, "home"),
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  child.stdin.write(prompt);
  child.stdin.end();
  const stderrPromise = new Response(child.stderr).text();
  let observedSession = "";
  let buffered = "";
  let observedBytes = 0;
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      observedBytes += value.byteLength;
      if (observedBytes > MAX_PROVIDER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw new Error("Rollout review provider output exceeded the bounded event limit.");
      }
      buffered += Buffer.from(value).toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          child.kill("SIGKILL");
          throw new Error("Rollout review provider emitted malformed JSONL.");
        }
        const session = providerSessionFromEvent(event);
        if (!session) continue;
        if (observedSession && observedSession !== session) {
          child.kill("SIGKILL");
          throw new Error("Rollout review provider session identity drifted.");
        }
        if (!observedSession) {
          observedSession = session;
          await checkedKernelCommand(
            "review",
            "rollout.review.bind_session",
            { entity: "rollout_review", id: requestId, status: "running" },
            { request_id: requestId, reviewer_session_uuid: session, owner },
            { idempotencyKey: `kernel:rollout.review.bind_session:${requestId}:${session}` },
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const exitCode = await child.exited;
  const providerError = (await stderrPromise).slice(0, 2_000);
  if (exitCode !== 0) throw new Error(`Rollout review provider exited ${exitCode}: ${providerError}`);
  if (!observedSession) throw new Error("Rollout review provider completed without a session identity.");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, any>;
  const verdict = result.verdict === "SHIP" ? "ship" : result.verdict === "NO_SHIP" ? "no_ship" : "";
  if (!verdict || result.review_id !== requestId
    || result.evidence_digest !== packet.evidence_digest
    || result.tree_digest !== packet.tree_digest) {
    throw new Error("Rollout review result does not match its immutable packet.");
  }
  await checkedKernelCommand(
    "review",
    "rollout.review.record",
    { entity: "rollout_review", id: requestId, status: "running" },
    { request_id: requestId, reviewer_session_uuid: observedSession, verdict: { ...result, verdict }, owner },
    { idempotencyKey: `kernel:rollout.review.record:${requestId}:${observedSession}` },
  );
  console.log(JSON.stringify({ event: "deployment_rollout_review_completed", request_id: requestId, verdict }));
}

async function reportRolloutReviewFailure(requestId: string, error: string) {
  const invocationId = process.env.INVOCATION_ID || "";
  if (!invocationId || !/^[0-9a-f-]{36}$/i.test(requestId)) return null;
  const processOwner = currentProcessIdentity();
  try {
    const result = await checkedKernelCommand(
      "review",
      "rollout.review.fail",
      { entity: "rollout_review", id: requestId, status: "running" },
      {
        request_id: requestId,
        error: error.slice(0, 4_000),
        owner: {
          invocation_id: invocationId,
          pid: processOwner.pid,
          boot_id: processOwner.bootId,
          start_ticks: processOwner.startTicks,
        },
      },
      { idempotencyKey: `kernel:rollout.review.fail:${requestId}:${invocationId}` },
    );
    return result.review_request;
  } catch (reportError) {
    console.error(JSON.stringify({
      event: "deployment_rollout_review_failure_report_failed",
      request_id: requestId,
      error: reportError instanceof Error ? reportError.message.slice(0, 2_000) : String(reportError).slice(0, 2_000),
    }));
    return null;
  }
}

if (import.meta.main) {
  const requestId = process.argv[2] || "";
  runRolloutReview(requestId).catch(async (error) => {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    console.error(JSON.stringify({
      event: "deployment_rollout_review_failed",
      error: message,
    }));
    const request = await reportRolloutReviewFailure(requestId, message);
    const terminal = Boolean(request && ["ambiguous", "parked"].includes(request.status))
      || (error instanceof DeploymentKernelCommandError && error.outcome === "ambiguous");
    process.exit(terminal ? 0 : 1);
  });
}
