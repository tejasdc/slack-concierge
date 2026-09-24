import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./log";

/**
 * The deployment-owned Git clone that updates are built from. Everything that reads it creates
 * it if it is missing, with the same no-checkout clone deploy.sh makes, because the reader that
 * runs first on a fresh box, or after a restart before any update, is the bot's own check for a
 * new version. On September 24, 2026 only deploy.sh created it, so that check failed every
 * minute and could never ask for the update that would have created it; an agent had to clone
 * it by hand.
 */
export function deploymentSourceRoot(): string {
  return process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source";
}

export function ensureDeploymentSource(root = deploymentSourceRoot()): void {
  if (existsSync(join(root, ".git"))) return;
  if (existsSync(root)) throw new Error(`Deployment source path exists without its own Git repository: ${root}`);
  const origin = process.env.CONCIERGE_DEPLOY_ORIGIN || "https://github.com/tejasdc/slack-concierge.git";
  mkdirSync(dirname(root), { recursive: true, mode: 0o755 });
  const result = Bun.spawnSync({
    cmd: ["git", "clone", "--quiet", "--no-checkout", origin, root],
    env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Deployment source clone failed: ${Buffer.from(result.stderr).toString("utf8").trim().slice(0, 500)}`);
  }
  log("info", "deployment_source_created", { root, origin });
}
