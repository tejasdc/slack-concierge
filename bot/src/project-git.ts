import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { actualProjectGitFingerprint, type ProjectScaffoldReport } from "./project-scaffold";
import type { ProjectPropagationIntent } from "./project-cutover-state";

export interface ProjectGitEvidence {
  projectName: string;
  codePath: string;
  ready: boolean;
  branch: string | null;
  upstream: string | null;
  headBefore: string | null;
  headAfter: string | null;
  commit: string | null;
  pushed: boolean;
  error: string | null;
}

export interface ProjectGitReport {
  ok: boolean;
  phase: "audit" | "prepare" | "propagate";
  projects: ProjectGitEvidence[];
}

const ALLOWED_SCAFFOLD_PATHS = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "docs/README.md",
  "notes",
]);

export function auditProjectRepositories(
  projects: Pick<ProjectScaffoldReport, "projectName" | "codePath" | "vaultPath">[],
  prepare: boolean,
): ProjectGitReport {
  const evidence = projects.map((project) => auditProjectRepository(project, prepare));
  return {
    ok: evidence.every((project) => project.ready),
    phase: prepare ? "prepare" : "audit",
    projects: evidence,
  };
}

export function propagateProjectRepositories(
  projects: Array<Pick<ProjectScaffoldReport, "projectName" | "codePath" | "vaultPath"> & Partial<ProjectPropagationIntent>>,
  onPropagated?: (project: ProjectGitEvidence) => void,
): ProjectGitReport {
  const evidence: ProjectGitEvidence[] = [];
  let failed = false;
  for (const project of projects) {
    if (failed) {
      evidence.push({ ...emptyEvidence(project), error: "not attempted after an earlier repository propagation failure" });
      continue;
    }
    const result = propagateProjectRepository(project);
    if (result.ready && result.error === null && onPropagated) {
      try {
        onPropagated(result);
      } catch (error) {
        result.ready = false;
        result.error = safeError(error);
      }
    }
    evidence.push(result);
    if (!result.ready || result.error) failed = true;
  }
  return {
    ok: evidence.every((project) => project.ready && project.error === null),
    phase: "propagate",
    projects: evidence,
  };
}

export function auditProjectRepositoriesAgainstIntent(
  projects: ProjectPropagationIntent[],
  requirePropagated: boolean,
): ProjectGitReport {
  const evidence = projects.map((project) => {
    const result = emptyEvidence(project);
    try {
      assertRepositoryRoot(project.codePath);
      assertIntentRepositoryState(project, requirePropagated);
      result.branch = project.branch;
      result.upstream = project.upstream;
      result.headBefore = git(project.codePath, ["rev-parse", "HEAD"]);
      result.headAfter = result.headBefore;
      result.commit = result.headBefore === project.preparedHead ? null : result.headBefore;
      result.pushed = git(project.codePath, ["rev-parse", project.upstream]) === result.headBefore;
      result.ready = true;
    } catch (error) {
      result.error = safeError(error);
    }
    return result;
  });
  return {
    ok: evidence.every((project) => project.ready),
    phase: requirePropagated ? "propagate" : "prepare",
    projects: evidence,
  };
}

function auditProjectRepository(
  project: Pick<ProjectScaffoldReport, "projectName" | "codePath" | "vaultPath">,
  prepare: boolean,
): ProjectGitEvidence {
  const evidence = emptyEvidence(project);
  try {
    assertRepositoryRoot(project.codePath);
    assertPreMigrationState(project);
    evidence.branch = git(project.codePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    git(project.codePath, ["remote", "get-url", "origin"]);
    evidence.upstream = git(project.codePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (evidence.upstream !== `origin/${evidence.branch}`) {
      throw new Error(`upstream must be origin/${evidence.branch}, found ${evidence.upstream}`);
    }
    evidence.headBefore = git(project.codePath, ["rev-parse", "HEAD"]);
    if (prepare) {
      git(project.codePath, ["fetch", "origin"]);
      let counts = aheadBehind(project.codePath, evidence.upstream);
      if (counts.ahead > 0) {
        throw new Error(`local branch has ${counts.ahead} unpushed commit(s)`);
      }
      if (counts.behind > 0) {
        git(project.codePath, ["rebase", evidence.upstream]);
      }
      counts = aheadBehind(project.codePath, evidence.upstream);
      if (counts.ahead !== 0 || counts.behind !== 0) {
        throw new Error(`branch is not synchronized after fetch/rebase (ahead=${counts.ahead}, behind=${counts.behind})`);
      }
      assertPreMigrationState(project);
    } else {
      const counts = aheadBehind(project.codePath, evidence.upstream);
      if (counts.ahead !== 0 || counts.behind !== 0) {
        throw new Error(`branch differs from cached upstream (ahead=${counts.ahead}, behind=${counts.behind})`);
      }
    }
    evidence.headAfter = git(project.codePath, ["rev-parse", "HEAD"]);
    evidence.ready = true;
  } catch (error) {
    evidence.error = safeError(error);
  }
  return evidence;
}

function propagateProjectRepository(
  project: Pick<ProjectScaffoldReport, "projectName" | "codePath" | "vaultPath"> & Partial<ProjectPropagationIntent>,
): ProjectGitEvidence {
  const evidence = emptyEvidence(project);
  try {
    assertRepositoryRoot(project.codePath);
    const branch = git(project.codePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    evidence.branch = branch;
    evidence.upstream = git(project.codePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    evidence.headBefore = git(project.codePath, ["rev-parse", "HEAD"]);
    if (project.preparedHead) {
      assertIntentRepositoryState(project as ProjectPropagationIntent, false);
      if (actualProjectGitFingerprint(project.codePath, project.vaultPath) !== project.expectedGitFingerprint) {
        throw new Error("post-migration scaffold state does not match the persisted propagation intent");
      }
    }
    const changedPaths = statusPaths(project.codePath);
    const unexpectedPaths = changedPaths.filter((path) => !ALLOWED_SCAFFOLD_PATHS.has(path));
    if (unexpectedPaths.length > 0) {
      throw new Error(`unexpected post-migration paths: ${unexpectedPaths.join(", ")}`);
    }
    if (changedPaths.length > 0) {
      git(project.codePath, ["add", "-f", "--", "AGENTS.md", "CLAUDE.md", "docs/README.md", "notes"]);
      const stagedPaths = lines(git(project.codePath, ["diff", "--cached", "--name-only"]));
      const unexpectedStagedPaths = stagedPaths.filter((path) => !ALLOWED_SCAFFOLD_PATHS.has(path));
      if (unexpectedStagedPaths.length > 0) {
        throw new Error(`unexpected staged paths: ${unexpectedStagedPaths.join(", ")}`);
      }
      if (stagedPaths.length > 0) {
        git(project.codePath, [
          "-c", "user.name=Slack Concierge",
          "-c", "user.email=slack-concierge@localhost",
          "commit", "-m", "chore: adopt canonical Concierge scaffold",
        ]);
        evidence.commit = git(project.codePath, ["rev-parse", "HEAD"]);
      }
    }
    git(project.codePath, ["push", "origin", branch]);
    evidence.pushed = true;
    assertClean(project.codePath);
    const counts = aheadBehind(project.codePath, `origin/${branch}`);
    if (counts.ahead !== 0 || counts.behind !== 0) {
      throw new Error(`branch differs from origin after push (ahead=${counts.ahead}, behind=${counts.behind})`);
    }
    evidence.headAfter = git(project.codePath, ["rev-parse", "HEAD"]);
    evidence.ready = true;
  } catch (error) {
    evidence.error = safeError(error);
  }
  return evidence;
}

function assertIntentRepositoryState(project: ProjectPropagationIntent, requirePropagated: boolean) {
  const branch = git(project.codePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const upstream = git(project.codePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (branch !== project.branch || upstream !== project.upstream) {
    throw new Error(`repository branch identity changed after preparation: ${branch} / ${upstream}`);
  }
  const head = git(project.codePath, ["rev-parse", "HEAD"]);
  const upstreamHead = git(project.codePath, ["rev-parse", project.upstream]);
  const changedPaths = statusPaths(project.codePath);
  const unexpectedPaths = changedPaths.filter((path) => !ALLOWED_SCAFFOLD_PATHS.has(path));
  if (unexpectedPaths.length > 0) {
    throw new Error(`unexpected cutover recovery paths: ${unexpectedPaths.join(", ")}`);
  }

  if (project.propagatedHead !== null || requirePropagated) {
    if (!project.propagatedHead) throw new Error("project propagation is not durably complete");
    if (
      head !== project.propagatedHead
      || upstreamHead !== head
      || changedPaths.length > 0
      || actualProjectGitFingerprint(project.codePath, project.vaultPath) !== project.expectedGitFingerprint
    ) {
      throw new Error("propagated repository is not clean and synchronized at its recorded head");
    }
    return;
  }

  if (head === project.preparedHead) {
    if (upstreamHead !== project.preparedHead) {
      throw new Error("origin moved away from the prepared head before propagation");
    }
    return;
  }
  const parent = git(project.codePath, ["rev-parse", "HEAD^"]);
  const subject = git(project.codePath, ["show", "-s", "--format=%s", "HEAD"]);
  const commitPaths = lines(git(project.codePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]));
  if (
    parent !== project.preparedHead
    || subject !== "chore: adopt canonical Concierge scaffold"
    || commitPaths.some((path) => !ALLOWED_SCAFFOLD_PATHS.has(path))
    || ![project.preparedHead, head].includes(upstreamHead)
  ) {
    throw new Error("repository HEAD is not the prepared head or its exact scaffold commit");
  }
}

function assertRepositoryRoot(codePath: string) {
  const topLevel = git(codePath, ["rev-parse", "--show-toplevel"]);
  if (realpathSync(topLevel) !== realpathSync(codePath)) {
    throw new Error(`code path is not the repository root: ${codePath}`);
  }
}

function assertClean(codePath: string) {
  const changedPaths = statusPaths(codePath);
  if (changedPaths.length > 0) {
    throw new Error(`working tree is not clean: ${changedPaths.join(", ")}`);
  }
}

function assertPreMigrationState(
  project: Pick<ProjectScaffoldReport, "codePath" | "vaultPath">,
) {
  const disallowed = statusEntries(project.codePath).filter((entry) => (
    entry.status !== "??" || !isVerifiedUntrackedScaffoldPath(project, entry.path)
  ));
  if (disallowed.length > 0) {
    throw new Error(`working tree contains unreviewed changes: ${disallowed.map((entry) => `${entry.status} ${entry.path}`).join(", ")}`);
  }
}

function statusPaths(codePath: string) {
  return statusEntries(codePath).map((entry) => entry.path);
}

function statusEntries(codePath: string) {
  return lines(gitRaw(codePath, ["status", "--porcelain=v1", "--untracked-files=all"]).trimEnd())
    .map((line) => ({
      status: line.slice(0, 2),
      path: line.slice(3).includes(" -> ") ? line.slice(3).split(" -> ").at(-1)! : line.slice(3),
    }));
}

function isVerifiedUntrackedScaffoldPath(
  project: Pick<ProjectScaffoldReport, "codePath" | "vaultPath">,
  path: string,
) {
  if (!ALLOWED_SCAFFOLD_PATHS.has(path)) return false;
  const absolutePath = resolve(project.codePath, path);
  try {
    const stat = lstatSync(absolutePath);
    if (path === "AGENTS.md" || path === "docs/README.md") return stat.isFile() && !stat.isSymbolicLink();
    if (!stat.isSymbolicLink()) return false;
    const target = resolve(dirname(absolutePath), readlinkSync(absolutePath));
    if (path === "CLAUDE.md") return target === resolve(project.codePath, "AGENTS.md");
    if (path === "notes") return target === resolve(project.vaultPath, "notes");
  } catch {
    return false;
  }
  return false;
}

function aheadBehind(codePath: string, upstream: string) {
  const [aheadText, behindText] = git(codePath, ["rev-list", "--count", "--left-right", `HEAD...${upstream}`]).split(/\s+/);
  return { ahead: Number(aheadText), behind: Number(behindText) };
}

function git(codePath: string, args: string[]) {
  return gitRaw(codePath, args).trim();
}

function gitRaw(codePath: string, args: string[]) {
  try {
    return execFileSync("git", args, {
      cwd: codePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`git ${args[0]} failed in ${codePath}`);
  }
}

function lines(value: string) {
  return value.length === 0 ? [] : value.split("\n").filter(Boolean);
}

function emptyEvidence(project: Pick<ProjectScaffoldReport, "projectName" | "codePath">): ProjectGitEvidence {
  return {
    projectName: project.projectName,
    codePath: project.codePath,
    ready: false,
    branch: null,
    upstream: null,
    headBefore: null,
    headAfter: null,
    commit: null,
    pushed: false,
    error: null,
  };
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
