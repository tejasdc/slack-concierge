/** Restricted consultations retain login routing, never the turn's action authority. */
export function claudeConsultationEnvironment(selected?: Record<string,string>): Record<string, string> {
  const environment: Record<string, string> = { CLAUDE_CODE_SAFE_MODE: "1" };
  for (const name of ["HOME", "PATH", "LANG", "USER", "LOGNAME", "SHELL", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  // Runner launches carry an account identity instead of an owner-local home. The runner
  // resolves it before starting Claude, even when environment inheritance is disabled.
  for (const name of ["CLAUDE_CONFIG_DIR", "CONCIERGE_PROVIDER_ID", "CONCIERGE_PROVIDER_ACCOUNT"]) {
    if (selected?.[name]) environment[name] = selected[name];
  }
  return environment;
}
