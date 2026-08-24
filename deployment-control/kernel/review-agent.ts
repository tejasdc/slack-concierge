#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";
import { providerSessionFromEvent } from "./repair-agent";

const RUNTIME_ROOT = "/usr/local/lib/concierge-deployment";
const WORKER_ROOT = "/var/lib/concierge-review/reviews";
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

function assertUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
}

async function runReview(reviewId: string) {
  assertUuid(reviewId, "Review identity");
  if (process.geteuid?.() === 0) throw new Error("Review worker refuses to run as root.");
  const workerRoot = join(WORKER_ROOT, reviewId);
  const metadataCandidates = process.env.CONCIERGE_REVIEW_METADATA_PATH;
  if (!metadataCandidates) throw new Error("Review worker requires its protected metadata path.");
  const metadata = JSON.parse(readFileSync(metadataCandidates, "utf8")) as Record<string, any>;
  const incidentId = String(metadata.incident_id || "");
  assertUuid(incidentId, "Review incident identity");
  if (metadata.review_id !== reviewId || metadata.repository_path !== join(workerRoot, "repository")) {
    throw new Error("Review worker control identity is invalid.");
  }
  const status = await checkedKernelCommand(
    "review",
    "review.status",
    { entity: "incident", id: incidentId, status: "reviewing" },
    { incident_id: incidentId, review_id: reviewId },
    { idempotencyKey: `kernel:review.status:${reviewId}:${crypto.randomUUID()}` },
  );
  if (status.review_run?.id !== reviewId || status.review_run.repository_path !== metadata.repository_path) {
    throw new Error("Review worker no longer owns the active review.");
  }
  const boundSession = status.review_run.provider_session_uuid as string | null;
  const controlPath = String(status.review_run.control_path);
  if (controlPath !== `/var/lib/concierge-deployment/reviews/${reviewId}`) {
    throw new Error("Review control identity drifted from its exact instance mapping.");
  }
  const localControlPath = join(workerRoot, "control");
  const capability = readFileSync(join(localControlPath, "provider.cap"), "utf8").trim();
  await checkedKernelCommand(
    "review",
    "review.provider_admit",
    { entity: "incident", id: incidentId, status: "reviewing" },
    { incident_id: incidentId, review_id: reviewId },
    { idempotencyKey: `kernel:review.provider_admit:${reviewId}:${crypto.randomUUID()}` },
  );
  const prompt = readFileSync(join(localControlPath, "prompt.md"), "utf8");
  const resultPath = join(workerRoot, "output", "result.json");
  const codex = join(RUNTIME_ROOT, "codex");
  const schema = join(RUNTIME_ROOT, "kernel", "current", "review-result.schema.json");
  if (!existsSync(codex) || !existsSync(schema)) throw new Error("Pinned review runtime is incomplete.");
  const common = ["--strict-config", "--json", "--output-schema", schema, "-o", resultPath];
  const command = boundSession
    ? [codex, "exec", "resume", boundSession, ...common, "-"]
    : [codex, "exec", ...common, "-C", metadata.repository_path, "-"];
  const launch = await checkedKernelCommand(
    "review",
    "review.provider_launch_begin",
    { entity: "incident", id: incidentId, status: "reviewing" },
    { incident_id: incidentId, review_id: reviewId },
    { idempotencyKey: `kernel:review.provider_launch_begin:${reviewId}:${crypto.randomUUID()}` },
  );
  if (launch.provider_launch?.outcome === "parked") {
    console.log(JSON.stringify({
      event: "deployment_review_provider_launch_parked",
      incident_id: incidentId,
      review_id: reviewId,
      error: launch.provider_launch.error,
    }));
    return;
  }
  if ((boundSession && launch.provider_launch?.providerSessionUuid !== boundSession)
    || (!boundSession && launch.provider_launch?.outcome !== "fresh")) {
    throw new Error("Review provider launch admission does not match its durable session state.");
  }
  const child = Bun.spawn({
    cmd: command,
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
  let observedSession = boundSession;
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
        throw new Error("Review provider output exceeded the bounded event limit.");
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
          throw new Error("Review provider emitted malformed JSONL.");
        }
        const session = providerSessionFromEvent(event);
        if (!session) continue;
        if (observedSession && observedSession !== session) {
          child.kill("SIGKILL");
          throw new Error("Review provider session identity drifted.");
        }
        if (!observedSession) {
          observedSession = session;
          await checkedKernelCommand(
            "review",
            "review.bind_session",
            { entity: "incident", id: incidentId, status: "reviewing" },
            { incident_id: incidentId, review_id: reviewId, provider_session_uuid: session },
            { idempotencyKey: `kernel:review.bind:${reviewId}:${session}` },
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const exitCode = await child.exited;
  const providerError = (await stderrPromise).slice(0, 2_000);
  if (exitCode !== 0) throw new Error(`Review provider exited ${exitCode}: ${providerError}`);
  if (!observedSession) throw new Error("Review provider completed without a session identity.");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  await checkedKernelCommand(
    "review",
    "review.complete",
    { entity: "incident", id: incidentId, status: "reviewing" },
    { incident_id: incidentId, review_id: reviewId, provider_session_uuid: observedSession, result },
    { idempotencyKey: `kernel:review.complete:${reviewId}:${observedSession}` },
  );
  console.log(JSON.stringify({ event: "deployment_review_completed", incident_id: incidentId, review_id: reviewId }));
}

if (import.meta.main) {
  runReview(process.argv[2] || "").catch((error) => {
    console.error(JSON.stringify({
      event: "deployment_review_failed",
      error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
    }));
    process.exit(1);
  });
}
