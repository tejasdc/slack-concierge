import { getDeliveredTurnMessageTarget, getTurnCommitProvenance } from "./state";
import type { DeploymentTurnReactionTarget } from "./deployment-state";

function assertCommit(commit: string) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Deployment reaction provenance requires full Git SHAs.");
}

function git(repositoryRoot: string, arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    cwd: repositoryRoot,
    env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = Buffer.from(result.stdout).toString("utf8");
  if (result.exitCode !== 0) {
    const stderr = Buffer.from(result.stderr).toString("utf8").trim();
    throw new Error(stderr || `git ${arguments_.join(" ")} exited ${result.exitCode}`);
  }
  return stdout;
}

export function deploymentReactionTargetsForCommitRange(
  repositoryRoot: string,
  baseCommit: string,
  candidateCommit: string,
): DeploymentTurnReactionTarget[] {
  assertCommit(baseCommit);
  assertCommit(candidateCommit);
  const commits = git(repositoryRoot, ["rev-list", "--reverse", `${baseCommit}..${candidateCommit}`])
    .split("\n")
    .map((commit) => commit.trim())
    .filter(Boolean);
  const targets = new Map<number, DeploymentTurnReactionTarget>();
  for (const commit of commits) {
    const trailers = git(repositoryRoot, [
      "show",
      "-s",
      "--format=%(trailers:key=Concierge-Provenance,valueonly)",
      commit,
    ]);
    const tokens = trailers.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    for (const token of new Set(tokens.map((value) => value.toLowerCase()))) {
      const provenance = getTurnCommitProvenance(token);
      if (!provenance || targets.has(provenance.turn_id)) continue;
      const delivered = getDeliveredTurnMessageTarget(provenance.turn_id);
      if (!delivered || delivered.slack_channel_id !== provenance.slack_channel_id) continue;
      targets.set(provenance.turn_id, {
        turnId: provenance.turn_id,
        slackChannelId: delivered.slack_channel_id,
        slackUserMessageTs: provenance.slack_user_msg_ts,
        slackMessageTs: delivered.slack_message_ts,
      });
    }
  }
  return [...targets.values()];
}
