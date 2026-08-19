import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  auditProjectRepositories,
  auditProjectRepositoriesAgainstIntent,
  propagateProjectRepositories,
  type ProjectGitReport,
} from "../src/project-git";
import { migrateManagedProjectScaffolds, type ManagedProjectMigrationReport } from "../src/project-migration";
import { readManagedProjects } from "../src/project-registry";
import { inspectProjectRoots } from "../src/project-scaffold";
import {
  markProjectPropagated,
  persistPropagationIntent,
  readProjectCutoverState,
  type ProjectPropagationIntent,
} from "../src/project-cutover-state";
import { withPausedObsidianSync } from "../src/sync-service";

interface MigrationCommandReport {
  migration: ManagedProjectMigrationReport;
  git: ProjectGitReport;
  registryUnchanged: boolean;
  authorizedApply: boolean;
}

export function runManagedProjectMigration(options: {
  stateDbPath: string;
  workspaceRoot: string;
  apply: boolean;
  pauseSync: boolean;
  propagateGit: boolean;
  cutoverAuthorized: boolean;
  reviewedExceptionFingerprints: string[];
  propagateRepositories?: typeof propagateProjectRepositories;
}): MigrationCommandReport {
  const cutoverStateDir = dirname(options.stateDbPath);
  const registryBefore = readManagedProjects(options.stateDbPath);
  const preflight = migrateManagedProjectScaffolds({
    stateDbPath: options.stateDbPath,
    workspaceRoot: options.workspaceRoot,
    apply: false,
    initializeGit: false,
    reviewedExceptionFingerprints: options.reviewedExceptionFingerprints,
  });
  const migrationProjects = preflight.projects.filter((project) => project.outcome === "migrated");
  const existingCutover = readProjectCutoverState(cutoverStateDir);
  const existingIntent = existingCutover?.projects ?? [];
  const readonlyGitAudit = existingIntent.length > 0
    ? auditProjectRepositoriesAgainstIntent(existingIntent, false)
    : auditProjectRepositories(migrationProjects, false);
  if (!options.apply) {
    return {
      migration: preflight,
      git: readonlyGitAudit,
      registryUnchanged: sameRegistry(registryBefore, readManagedProjects(options.stateDbPath)),
      authorizedApply: false,
    };
  }

  const authorizedApply = options.cutoverAuthorized
    && options.propagateGit
    && existingCutover !== null
    && existingCutover.phase !== "canvas_required"
    && existingCutover.workspaceRoot === options.workspaceRoot
    && existingCutover.stateDbPath === options.stateDbPath;
  if (!authorizedApply || !preflight.exceptionsAccepted || !readonlyGitAudit.ok) {
    return {
      migration: preflight,
      git: readonlyGitAudit,
      registryUnchanged: sameRegistry(registryBefore, readManagedProjects(options.stateDbPath)),
      authorizedApply,
    };
  }

  const recovering = existingIntent.length > 0;
  const preparedGit = recovering
    ? auditProjectRepositoriesAgainstIntent(existingIntent, false)
    : auditProjectRepositories(migrationProjects, true);
  if (!preparedGit.ok) {
    return {
      migration: preflight,
      git: preparedGit,
      registryUnchanged: sameRegistry(registryBefore, readManagedProjects(options.stateDbPath)),
      authorizedApply,
    };
  }
  const intent = recovering
    ? existingIntent
    : buildPropagationIntent(options.workspaceRoot, migrationProjects, preparedGit);
  const persistedCutover = persistPropagationIntent(cutoverStateDir, intent);

  return withPausedObsidianSync({
    enabled: options.pauseSync,
    apply: true,
    operation: () => {
      const currentCutover = readProjectCutoverState(cutoverStateDir);
      if (!currentCutover || JSON.stringify(currentCutover) !== JSON.stringify(persistedCutover)) {
        throw new Error("Project scaffold cutover state changed after Git preparation");
      }
      assertIntentRoots(options.workspaceRoot, currentCutover.projects);
      const revalidatedGit = auditProjectRepositoriesAgainstIntent(currentCutover.projects, false);
      if (!revalidatedGit.ok) {
        return {
          migration: preflight,
          git: revalidatedGit,
          registryUnchanged: sameRegistry(registryBefore, readManagedProjects(options.stateDbPath)),
          authorizedApply,
        };
      }
      const migration = migrateManagedProjectScaffolds({
        stateDbPath: options.stateDbPath,
        workspaceRoot: options.workspaceRoot,
        apply: true,
        initializeGit: false,
        reviewedExceptionFingerprints: options.reviewedExceptionFingerprints,
        preparedProjects: currentCutover.projects,
        allowPreparedActionSubsets: recovering,
      });
      let git = revalidatedGit;
      if (migration.applied && !migration.partial) {
        const latestCutover = readProjectCutoverState(cutoverStateDir);
        if (!latestCutover) throw new Error("Project scaffold cutover state disappeared before propagation");
        const incompleteProjects = latestCutover.projects.filter((project) => project.propagatedHead === null);
        git = (options.propagateRepositories ?? propagateProjectRepositories)(incompleteProjects, (project) => {
          if (!project.headAfter) throw new Error(`Propagation evidence omitted HEAD for ${project.codePath}`);
          markProjectPropagated(cutoverStateDir, project.codePath, project.headAfter);
        });
        if (git.ok) {
          const completedCutover = readProjectCutoverState(cutoverStateDir);
          if (!completedCutover) throw new Error("Project scaffold cutover state disappeared after propagation");
          git = auditProjectRepositoriesAgainstIntent(completedCutover.projects, true);
        }
      }
      return {
        migration,
        git,
        registryUnchanged: sameRegistry(registryBefore, readManagedProjects(options.stateDbPath)),
        authorizedApply,
      };
    },
  });
}

function assertIntentRoots(workspaceRoot: string, projects: ProjectPropagationIntent[]) {
  for (const project of projects) {
    const safety = inspectProjectRoots(workspaceRoot, project.codePath, project.vaultPath);
    if (
      !safety.safe
      || safety.canonicalCodePath !== project.canonicalCodePath
      || safety.canonicalVaultPath !== project.canonicalVaultPath
    ) {
      throw new Error(`Prepared project root identity changed before apply: ${project.codePath}`);
    }
  }
}

function buildPropagationIntent(
  workspaceRoot: string,
  projects: ManagedProjectMigrationReport["projects"],
  preparedGit: ProjectGitReport,
): ProjectPropagationIntent[] {
  const evidenceByCodePath = new Map(preparedGit.projects.map((project) => [project.codePath, project]));
  return projects.map((project) => {
    const safety = inspectProjectRoots(workspaceRoot, project.codePath, project.vaultPath);
    const evidence = evidenceByCodePath.get(project.codePath);
    if (!safety.safe || !evidence?.ready || !evidence.branch || !evidence.upstream || !evidence.headAfter || !project.expectedGitFingerprint) {
      throw new Error(`Prepared migration evidence is incomplete for ${project.codePath}`);
    }
    return {
      projectName: project.projectName,
      codePath: project.codePath,
      vaultPath: project.vaultPath,
      canonicalCodePath: safety.canonicalCodePath,
      canonicalVaultPath: safety.canonicalVaultPath,
      branch: evidence.branch,
      upstream: evidence.upstream,
      preparedHead: evidence.headAfter,
      plannedActions: project.actions,
      expectedGitFingerprint: project.expectedGitFingerprint,
      propagatedHead: null,
    };
  });
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const report = runManagedProjectMigration({
    ...options,
    cutoverAuthorized: process.env.CONCIERGE_PROJECT_SCAFFOLD_CUTOVER === "1",
  });
  console.log(JSON.stringify(report, null, 2));
  if (!successful(report, options.apply)) process.exitCode = 2;
}

function successful(report: MigrationCommandReport, apply: boolean) {
  return report.registryUnchanged
    && report.git.ok
    && report.migration.exceptionsAccepted
    && (!apply || (report.authorizedApply && report.migration.applied && !report.migration.partial));
}

function sameRegistry(before: ReturnType<typeof readManagedProjects>, after: ReturnType<typeof readManagedProjects>) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function parseArguments(args: string[]) {
  const options = {
    stateDbPath: process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db",
    workspaceRoot: process.env.CONCIERGE_WORKSPACE_ROOT || "/root/workspace",
    apply: false,
    pauseSync: false,
    propagateGit: false,
    reviewedExceptionsPath: null as string | null,
  };
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (argument === "--pause-sync") options.pauseSync = true;
    else if (argument === "--propagate-git") options.propagateGit = true;
    else if (argument === "--reviewed-exceptions") options.reviewedExceptionsPath = requiredValue(argument, args.shift());
    else if (argument === "--workspace-root") options.workspaceRoot = requiredValue(argument, args.shift());
    else if (argument === "--state-db") options.stateDbPath = requiredValue(argument, args.shift());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return {
    ...options,
    reviewedExceptionFingerprints: options.reviewedExceptionsPath
      ? readReviewedExceptions(options.reviewedExceptionsPath)
      : [],
  };
}

function readReviewedExceptions(path: string) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.fingerprints)) {
    throw new Error("Reviewed exception manifest must have version=1 and a fingerprints array");
  }
  if (parsed.fingerprints.some((fingerprint: unknown) => typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))) {
    throw new Error("Reviewed exception manifest contains an invalid fingerprint");
  }
  if (new Set(parsed.fingerprints).size !== parsed.fingerprints.length) {
    throw new Error("Reviewed exception manifest contains duplicate fingerprints");
  }
  return parsed.fingerprints as string[];
}

function requiredValue(flag: string, value: string | undefined) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
