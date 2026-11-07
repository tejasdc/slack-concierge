import { readFile } from "node:fs/promises";

export type ReleaseMatch = "included" | "excluded" | "unconfirmed";

/** The link may point at a candidate before activation succeeds. Only its success receipt proves installation. */
export async function releaseIncludesCommit(input: {
  requiredCommit: string;
  manifestPath: string;
  repositoryRoot: string;
  succeeded: (installedCommit: string, artifactDigest: string) => boolean;
}): Promise<ReleaseMatch> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8"));
  const installed = manifest.git_commit;
  const artifact = manifest.artifact_digest;
  if (typeof installed !== "string" || !/^[0-9a-f]{40}$/.test(installed)
    || typeof artifact !== "string" || !/^[0-9a-f]{64}$/.test(artifact)) return "unconfirmed";
  const git = Bun.spawn(["git", "-C", input.repositoryRoot,
    "merge-base", "--is-ancestor", input.requiredCommit, installed], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(git.stderr).text();
  const exit = await git.exited;
  if (exit === 1) return "excluded";
  if (exit !== 0) throw new Error(`Git could not classify release ancestry (exit ${exit}): ${stderr.slice(0, 500)}`);
  return input.succeeded(installed, artifact) ? "included" : "unconfirmed";
}
