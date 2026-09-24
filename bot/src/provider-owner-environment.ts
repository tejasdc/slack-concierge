import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRuntimeProfile } from "./runtime-profile";

function routerBotDirectory(environment: NodeJS.ProcessEnv, moduleDirectory: string, installedProduction: boolean): string {
  const sourceBot = resolve(moduleDirectory, "..");
  if (existsSync(join(sourceBot, "scripts/router-sessions.ts"))) return realpathSync(sourceBot);

  // A release carries its own router and hook bundles. Never execute helpers from
  // the writable developer checkout while serving an installed release.
  const configuredBot = environment.CONCIERGE_ROUTER_BOT_DIR
    || (installedProduction && environment.CONCIERGE_RELEASE_MANIFEST
      ? join(environment.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || "/var/lib/slack-concierge-deployment", "current", "bot")
      : null);
  if (!configuredBot || !(existsSync(join(configuredBot, "scripts/router-sessions.js"))
    || existsSync(join(configuredBot, "scripts/router-sessions.ts")))) {
    throw new Error("Concierge provider execution requires its owning router helper directory.");
  }
  return realpathSync(configuredBot);
}

/** Runtime paths come from the service, never the model's cwd or a prior turn. */
export function providerOwnerEnvironment(
  turnEnvironment: Record<string, string> = {},
  environment: NodeJS.ProcessEnv = process.env,
  moduleDirectory = import.meta.dir,
): Record<string, string> {
  if (!environment.CONCIERGE_STATE_DIR?.trim()) {
    throw new Error("Concierge provider execution requires CONCIERGE_STATE_DIR; refusing a production fallback.");
  }
  const runtime = resolveRuntimeProfile(environment);
  const stateDirectory = realpathSync(runtime.stateDir);
  return {
    ...turnEnvironment,
    CONCIERGE_STATE_DIR: stateDirectory,
    CONCIERGE_STATE_DB: join(stateDirectory, "state.db"),
    CONCIERGE_ROUTER_BOT_DIR: routerBotDirectory(environment, moduleDirectory,
      runtime.profile === "production"),
    CONCIERGE_RUNTIME_PROFILE: runtime.profile,
    CONCIERGE_SLACK_ENABLED: runtime.slackConfigPath === null ? "0" : "1",
    CONCIERGE_SLACK_CONFIG: runtime.slackConfigPath ?? "/dev/null",
  };
}
