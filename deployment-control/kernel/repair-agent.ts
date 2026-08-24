#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkedKernelCommand } from "../../bot/src/deployment-repair/kernel-client";

const RUNTIME_ROOT = "/usr/local/lib/concierge-deployment";
const WORKER_ROOT = "/var/lib/concierge-repair/incidents";
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024;

function assertIncidentId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Repair worker incident identity must be a UUID.");
  }
}

export function providerSessionFromEvent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.type !== "thread.started" && event.type !== "thread_started") return null;
  const candidate = event.thread_id ?? event.threadId ?? event.session_id ?? event.sessionId ?? event.id;
  return typeof candidate === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ? candidate
    : null;
}

async function runIncident(incidentId: string) {
  assertIncidentId(incidentId);
  if (process.geteuid?.() === 0) throw new Error("Repair worker refuses to run as root.");
  const workerRoot = join(WORKER_ROOT, incidentId);
  const controlRoot = join(workerRoot, "control");
  const repositoryPath = join(workerRoot, "repository");
  const codexHome = join(workerRoot, "codex");
  const resultPath = join(workerRoot, "result.json");
  const metadata = JSON.parse(readFileSync(join(controlRoot, "metadata.json"), "utf8")) as Record<string, unknown>;
  if (metadata.incident_id !== incidentId || metadata.repository_path !== repositoryPath) {
    throw new Error("Repair worker control identity is invalid.");
  }
  const status = await checkedKernelCommand(
    "repair",
    "repair.status",
    { entity: "incident", id: incidentId, status: "repairing" },
    { incident_id: incidentId },
    { idempotencyKey: `kernel:repair.status:${incidentId}:${crypto.randomUUID()}` },
  );
  if (status.incident?.id !== incidentId || status.incident.status !== "repairing"
    || status.repair_run?.repository_path !== repositoryPath) {
    throw new Error("Repair worker no longer owns the active incident.");
  }
  const boundSession = status.incident.repair_session_uuid as string | null;
  const prompt = boundSession
    ? `Continue this exact deployment-repair incident. Correct every current blocker, rerun focused tests, commit the correction, and return the required structured result.\n\n## Fresh incident evidence\n\n${JSON.stringify(status.resume_evidence, null, 2)}\n\n## Latest independent review feedback\n\n${JSON.stringify(status.repair_feedback, null, 2)}`
    : readFileSync(join(controlRoot, "prompt.md"), "utf8");
  const capability = readFileSync(join(controlRoot, "provider.cap"), "utf8").trim();
  await checkedKernelCommand(
    "repair",
    "repair.provider_admit",
    { entity: "incident", id: incidentId, status: "repairing" },
    { incident_id: incidentId },
    { idempotencyKey: `kernel:repair.provider_admit:${incidentId}:${crypto.randomUUID()}` },
  );
  const schemaPath = join(RUNTIME_ROOT, "kernel", "current", "repair-result.schema.json");
  const codex = join(RUNTIME_ROOT, "codex");
  if (!existsSync(codex) || !existsSync(schemaPath)) throw new Error("Pinned repair runtime is incomplete.");
  const common = [
    "--strict-config",
    "--json",
    "--output-schema", schemaPath,
    "-o", resultPath,
  ];
  const command = boundSession
    ? [codex, "exec", "resume", boundSession, ...common, "-"]
    : [codex, "exec", ...common, "-C", repositoryPath, "-"];
  const launch = await checkedKernelCommand(
    "repair",
    "repair.provider_launch_begin",
    { entity: "incident", id: incidentId, status: "repairing" },
    { incident_id: incidentId },
    { idempotencyKey: `kernel:repair.provider_launch_begin:${incidentId}:${crypto.randomUUID()}` },
  );
  if (launch.provider_launch?.outcome === "parked") {
    console.log(JSON.stringify({
      event: "deployment_repair_provider_launch_parked",
      incident_id: incidentId,
      error: launch.provider_launch.error,
    }));
    return;
  }
  if ((boundSession && launch.provider_launch?.providerSessionUuid !== boundSession)
    || (!boundSession && launch.provider_launch?.outcome !== "fresh")) {
    throw new Error("Repair provider launch admission does not match its durable session state.");
  }
  const child = Bun.spawn({
    cmd: command,
    cwd: repositoryPath,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      CODEX_HOME: codexHome,
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
        throw new Error("Repair provider output exceeded the bounded event limit.");
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
          throw new Error("Repair provider emitted malformed JSONL.");
        }
        const session = providerSessionFromEvent(event);
        if (!session) continue;
        if (observedSession && observedSession !== session) {
          child.kill("SIGKILL");
          throw new Error("Repair provider session identity drifted.");
        }
        if (!observedSession) {
          observedSession = session;
          await checkedKernelCommand(
            "repair",
            "incident.bind_repair_session",
            { entity: "incident", id: incidentId, status: "repairing" },
            { incident_id: incidentId, provider_id: "codex", provider_session_uuid: session },
            { idempotencyKey: `kernel:repair.bind:${incidentId}:${session}` },
          );
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const exitCode = await child.exited;
  const providerError = (await stderrPromise).slice(0, 2_000);
  if (exitCode !== 0) throw new Error(`Repair provider exited ${exitCode}: ${providerError}`);
  if (!observedSession) throw new Error("Repair provider completed without a session identity.");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  await checkedKernelCommand(
    "repair",
    "repair.complete",
    { entity: "incident", id: incidentId, status: "repairing" },
    { incident_id: incidentId, provider_session_uuid: observedSession, result },
    { idempotencyKey: `kernel:repair.complete:${incidentId}:${observedSession}` },
  );
  console.log(JSON.stringify({ event: "deployment_repair_completed", incident_id: incidentId }));
}

if (import.meta.main) {
  runIncident(process.argv[2] || "").catch((error) => {
    console.error(JSON.stringify({
      event: "deployment_repair_failed",
      error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
    }));
    process.exit(1);
  });
}
