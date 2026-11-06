/** Configured runner that owns provider credentials, when a provider runs remotely. */
export function providerRunnerTarget(provider: 'codex' | 'claude-code'): string | null {
  if (provider === 'codex') return process.env.CONCIERGE_CODEX_RUNNER?.trim() || null;
  return process.env.CONCIERGE_TURN_RUNNER?.trim() || process.env.CONCIERGE_CODEX_RUNNER?.trim() || null;
}
