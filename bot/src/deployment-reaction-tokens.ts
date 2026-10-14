import { execFile } from "node:child_process";
import { promisify } from "node:util";

function assertCommit(commit: string) {
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error("Deployment reaction provenance requires full Git SHAs.");
}

async function git(repositoryRoot: string, arguments_: string[]) {
  try {
    const result = await promisify(execFile)("git", arguments_, { cwd: repositoryRoot,
      env: { ...process.env, HOME: process.env.HOME || "/root", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout;
  } catch (error: any) {
    throw new Error(String(error?.stderr || error).trim() || `git ${arguments_.join(" ")} failed`);
  }
}

/** Git work stays outside the accepting owner; the owner resolves these exact provenance IDs. */
export async function deploymentReactionTokensForCommitRange(
  repositoryRoot: string,
  baseCommit: string,
  candidateCommit: string,
): Promise<string[]> {
  assertCommit(baseCommit);
  assertCommit(candidateCommit);
  const commits = (await git(repositoryRoot, ["rev-list", "--reverse", `${baseCommit}..${candidateCommit}`]))
    .split("\n").map((commit) => commit.trim()).filter(Boolean);
  const tokens = new Set<string>();
  for (const commit of commits) {
    const trailers = await git(repositoryRoot, [
      "show", "-s", "--format=%(trailers:key=Concierge-Provenance,valueonly)", commit,
    ]);
    for (const token of trailers.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [])
      tokens.add(token.toLowerCase());
  }
  return [...tokens];
}
