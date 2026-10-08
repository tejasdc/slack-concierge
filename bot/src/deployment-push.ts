import {
  getLastKnownGoodRelease,
  getDeploymentDesiredState,
  observeDeploymentDesiredCommit,
} from "./deployment-state";
import type { GitHubDeploymentPush } from "./github-deployment-webhook";
import { ensureDeploymentSource } from "./deployment-source";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentPushServices {
  git(arguments_: string[]): GitResult | Promise<GitResult>;
  ensureSource?(): void | Promise<void>;
  getLastKnownGoodCommit(): string | null;
  getCurrentDesiredCommit(): string | null;
  observe(input: {
    desiredCommit: string;
    githubDeliveryId: string;
    isAncestor(ancestor: string, descendant: string): boolean;
  }): {
    state: { desired_commit: string };
    reason: "recorded" | "advanced" | "duplicate" | "stale" | "divergent";
  };
}

function defaultServices(repositoryRoot: string): DeploymentPushServices {
  const git = async (arguments_: string[]): Promise<GitResult> => {
    try {
      const result = await promisify(execFile)("git", arguments_, {
        cwd: repositoryRoot, env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return { exitCode: typeof error?.code === "number" ? error.code : -1, stdout: String(error?.stdout || ""), stderr: String(error?.stderr || error) };
    }
  };
  return {
    git,
    ensureSource: () => ensureDeploymentSource(repositoryRoot),
    getLastKnownGoodCommit: () => getLastKnownGoodRelease()?.git_commit || null,
    getCurrentDesiredCommit: () => getDeploymentDesiredState()?.desired_commit || null,
    observe: (input) => observeDeploymentDesiredCommit(input),
  };
}

const pushOperations = new Map<string, Promise<unknown>>();
function serializePush<T>(repositoryRoot: string, action: () => Promise<T>): Promise<T> {
  const prior = pushOperations.get(repositoryRoot);
  const current = prior ? prior.catch(() => {}).then(action) : action();
  pushOperations.set(repositoryRoot, current);
  void current.finally(() => { if (pushOperations.get(repositoryRoot) === current) pushOperations.delete(repositoryRoot); }).catch(() => {});
  return current;
}

function successful(result: GitResult, operation: string) {
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${operation} exited ${result.exitCode}`);
  return result.stdout.trim().toLowerCase();
}

export async function acceptGitHubDeploymentPush(
  push: GitHubDeploymentPush,
  repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source",
  services = defaultServices(repositoryRoot),
) {
  return serializePush(repositoryRoot, () => acceptPush(push, services));
}

async function acceptPush(push: GitHubDeploymentPush, services: DeploymentPushServices) {
  if (services.ensureSource) await services.ensureSource();
  successful(await services.git(["fetch", "--quiet", "origin", "main"]), "git fetch origin main");
  // Sentences written for him after a commit was pushed live in notes; the update line reads them here.
  await services.git(["fetch", "--quiet", "origin", "+refs/notes/update:refs/notes/update"]);
  const desiredCommit = successful(await services.git(["rev-parse", "origin/main"]), "git rev-parse origin/main");
  if (!/^[0-9a-f]{40}$/.test(desiredCommit)) throw new Error("origin/main did not resolve to a full Git commit");

  const eventCommit = successful(await services.git(["rev-parse", `${push.after}^{commit}`]), "git rev-parse event commit");
  if (eventCommit !== push.after) throw new Error("GitHub event commit did not resolve exactly");
  if ((await services.git(["merge-base", "--is-ancestor", eventCommit, desiredCommit])).exitCode !== 0) {
    throw new Error("GitHub event commit is not an ancestor of current origin/main");
  }

  const lastKnownGood = services.getLastKnownGoodCommit();
  if (lastKnownGood
    && (await services.git(["merge-base", "--is-ancestor", lastKnownGood, desiredCommit])).exitCode !== 0) {
    throw new Error(`origin/main ${desiredCommit} is not descended from last-known-good ${lastKnownGood}`);
  }

  // The state transaction cannot await Git. Read the current head under this repository's
  // acceptance sequence and bring both ancestry answers into its synchronous callback.
  let current: string | null, advances: boolean, stale: boolean;
  do {
    current = services.getCurrentDesiredCommit();
    advances = current ? (await services.git(["merge-base", "--is-ancestor", current, desiredCommit])).exitCode === 0 : false;
    stale = current ? (await services.git(["merge-base", "--is-ancestor", desiredCommit, current])).exitCode === 0 : false;
  } while (services.getCurrentDesiredCommit() !== current);
  const observed = services.observe({
    desiredCommit,
    githubDeliveryId: push.deliveryId,
    isAncestor: (ancestor, descendant) => ancestor === current && descendant === desiredCommit ? advances
      : ancestor === desiredCommit && descendant === current ? stale : false,
  });
  if (observed.reason === "divergent") {
    throw new Error("GitHub push diverges from the latest accepted desired main commit");
  }
  return {
    desired_commit: observed.state.desired_commit,
    event_commit: eventCommit,
    observation: observed.reason,
  };
}

/**
 * A push GitHub announced while Concierge was down is never announced again: the webhook got a 502
 * and nothing retries it. On 2026-10-08 two commits, one of them the fix for the restart limit that
 * had just stopped Concierge, sat on main with no update coming. At startup the deployment source's
 * main is read once and treated as one more push; a main already accepted changes nothing.
 */
export async function catchUpMissedPush(
  repositoryRoot = process.env.CONCIERGE_REPO || "/var/lib/slack-concierge-deployment/source",
  services = defaultServices(repositoryRoot),
) {
  return serializePush(repositoryRoot, async () => {
    if (services.ensureSource) await services.ensureSource();
    successful(await services.git(["fetch", "--quiet", "origin", "main"]), "git fetch origin main");
    const head = successful(await services.git(["rev-parse", "origin/main"]), "git rev-parse origin/main");
    return acceptPush({ deliveryId: `startup-catch-up:${head}`, repository: "", ref: "refs/heads/main", after: head }, services);
  });
}
