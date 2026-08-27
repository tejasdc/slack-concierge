export function scopeSlackIdempotencyKey(
  key: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (environment.CONCIERGE_RUNTIME_PROFILE !== "sandbox") return key;
  const runId = environment.CONCIERGE_SANDBOX_RUN_ID;
  if (!runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Sandbox Slack idempotency requires the exact safe run ID.");
  }
  return `sandbox:${runId}:${key}`;
}
