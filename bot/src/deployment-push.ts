import {
  getLastKnownGoodRelease,
  observeDeploymentDesiredCommit,
} from "./deployment-state";
import type { GitHubDeploymentPush } from "./github-deployment-webhook";

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeploymentPushServices {
  git(arguments_: string[]): GitResult;
  getLastKnownGoodCommit(): string | null;
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
  const git = (arguments_: string[]): GitResult => {
    const result = Bun.spawnSync({
      cmd: ["git", ...arguments_],
      cwd: repositoryRoot,
      env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: Buffer.from(result.stdout).toString("utf8"),
      stderr: Buffer.from(result.stderr).toString("utf8"),
    };
  };
  const isAncestor = (ancestor: string, descendant: string) => (
    git(["merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0
  );
  return {
    git,
    getLastKnownGoodCommit: () => getLastKnownGoodRelease()?.git_commit || null,
    observe: (input) => observeDeploymentDesiredCommit({ ...input, isAncestor }),
  };
}

function successful(result: GitResult, operation: string) {
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${operation} exited ${result.exitCode}`);
  return result.stdout.trim().toLowerCase();
}

export async function acceptGitHubDeploymentPush(
  push: GitHubDeploymentPush,
  repositoryRoot = process.env.CONCIERGE_REPO || "/root/workspace/slack-concierge",
  services = defaultServices(repositoryRoot),
) {
  successful(services.git(["fetch", "--quiet", "origin", "main"]), "git fetch origin main");
  const desiredCommit = successful(services.git(["rev-parse", "origin/main"]), "git rev-parse origin/main");
  if (!/^[0-9a-f]{40}$/.test(desiredCommit)) throw new Error("origin/main did not resolve to a full Git commit");

  const eventCommit = successful(services.git(["rev-parse", `${push.after}^{commit}`]), "git rev-parse event commit");
  if (eventCommit !== push.after) throw new Error("GitHub event commit did not resolve exactly");
  if (services.git(["merge-base", "--is-ancestor", eventCommit, desiredCommit]).exitCode !== 0) {
    throw new Error("GitHub event commit is not an ancestor of current origin/main");
  }

  const lastKnownGood = services.getLastKnownGoodCommit();
  if (lastKnownGood
    && services.git(["merge-base", "--is-ancestor", lastKnownGood, desiredCommit]).exitCode !== 0) {
    throw new Error(`origin/main ${desiredCommit} is not descended from last-known-good ${lastKnownGood}`);
  }

  const observed = services.observe({
    desiredCommit,
    githubDeliveryId: push.deliveryId,
    isAncestor: (ancestor, descendant) => (
      services.git(["merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0
    ),
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
