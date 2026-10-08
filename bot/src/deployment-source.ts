import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const sourceCreation = new Map<string, Promise<void>>();
export function ensureDeploymentSource(root = deploymentSourceRoot()): Promise<void> {
  const active = sourceCreation.get(root);
  if (active) return active;
  const creation = createDeploymentSource(root);
  sourceCreation.set(root, creation);
  void creation.finally(() => { if (sourceCreation.get(root) === creation) sourceCreation.delete(root); }).catch(() => {});
  return creation;
}

async function createDeploymentSource(root: string): Promise<void> {
  if (existsSync(join(root, ".git"))) return;
  if (existsSync(root)) throw new Error(`Deployment source path exists without its own Git repository: ${root}`);
  const origin = process.env.CONCIERGE_DEPLOY_ORIGIN || "https://github.com/tejasdc/slack-concierge.git";
  mkdirSync(dirname(root), { recursive: true, mode: 0o755 });
  try { await promisify(execFile)("git", ["clone", "--quiet", "--no-checkout", origin, root],
    { env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 1024 * 1024 }); }
  catch (error: any) { throw new Error(`Deployment source clone failed: ${String(error?.stderr || error).trim().slice(0, 500)}`); }
  log("info", "deployment_source_created", { root, origin });
}
