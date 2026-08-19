import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readManagedProjects, type ManagedProjectRow } from "./project-registry";
import {
  inspectProjectRoots,
  type ProjectRootSafety,
  type ProjectScaffoldReport,
  reconcileProjectScaffold,
} from "./project-scaffold";

export interface ManagedProjectMigrationReport {
  stateDbPath: string;
  workspaceRoot: string;
  applied: boolean;
  partial: boolean;
  exceptionsAccepted: boolean;
  exceptionFingerprints: Array<{ projectName: string; codePath: string; fingerprint: string }>;
  projects: ProjectScaffoldReport[];
  counts: Record<ProjectScaffoldReport["outcome"], number>;
}

interface PreflightedProject {
  row: ManagedProjectRow;
  codePath: string;
  vaultPath: string;
  canonicalCodePath: string;
  canonicalVaultPath: string;
  report: ProjectScaffoldReport;
  reportIndex: number;
}

export interface PreparedMigrationProject {
  codePath: string;
  vaultPath: string;
  plannedActions: string[];
  expectedGitFingerprint: string;
}

export function migrateManagedProjectScaffolds(input: {
  stateDbPath: string;
  workspaceRoot: string;
  apply?: boolean;
  initializeGit?: boolean;
  reviewedExceptionFingerprints?: string[];
  preparedProjects?: PreparedMigrationProject[];
  allowPreparedActionSubsets?: boolean;
  beforeApplyProject?: (project: ProjectScaffoldReport, index: number) => void;
}): ManagedProjectMigrationReport {
  const apply = input.apply ?? false;
  const initializeGit = input.initializeGit ?? true;
  const reports: ProjectScaffoldReport[] = [];
  const preflighted: PreflightedProject[] = [];
  const seenCodePaths = new Map<string, string>();
  const seenVaultPaths = new Map<string, string>();

  for (const row of readManagedProjects(input.stateDbPath)) {
    const pathProblem = registryPathProblem(row);
    if (pathProblem) {
      reports.push(skippedReport(row.slack_channel_name, String(row.code_path ?? ""), String(row.vault_path ?? ""), pathProblem));
      continue;
    }
    const codePath = row.code_path;
    const vaultPath = row.vault_path;
    const safety = inspectProjectRoots(input.workspaceRoot, codePath, vaultPath);
    if (!safety.safe) {
      reports.push(skippedReport(row.slack_channel_name, codePath, vaultPath, safety.warnings.join("; ")));
      continue;
    }
    const duplicateProblem = duplicateIdentityProblem(
      safety,
      seenCodePaths,
      seenVaultPaths,
    );
    if (duplicateProblem) {
      reports.push(skippedReport(row.slack_channel_name, codePath, vaultPath, duplicateProblem));
      continue;
    }
    seenCodePaths.set(safety.canonicalCodePath, row.slack_channel_name);
    seenVaultPaths.set(safety.canonicalVaultPath, row.slack_channel_name);

    const report = safelyReconcile({
      row,
      workspaceRoot: input.workspaceRoot,
      codePath,
      vaultPath,
      apply: false,
      initializeGit,
    });
    reports.push(report);
    if (report.outcome !== "skipped" && report.outcome !== "ambiguous") {
      preflighted.push({
        row,
        codePath,
        vaultPath,
        canonicalCodePath: safety.canonicalCodePath,
        canonicalVaultPath: safety.canonicalVaultPath,
        report,
        reportIndex: reports.length - 1,
      });
    }
  }

  const preflightExceptions = exceptionState(reports, input.reviewedExceptionFingerprints ?? []);
  if (!apply || !preflightExceptions.accepted) {
    return buildReport(input, false, false, reports, input.reviewedExceptionFingerprints ?? []);
  }

  const bindingProblems = preparedInventoryProblems(
    reports,
    input.preparedProjects,
    input.allowPreparedActionSubsets ?? false,
  );
  if (bindingProblems.size > 0) {
    return buildReport(input, false, false, reports.map((report) => {
      const warning = bindingProblems.get(report.codePath);
      return warning
        ? ambiguousReport(report.projectName, report.codePath, report.vaultPath, warning, report.actions)
        : report;
    }), input.reviewedExceptionFingerprints ?? []);
  }

  const revalidationProblems = new Map<string, ProjectScaffoldReport>();
  for (const project of preflighted) {
    const safety = inspectProjectRoots(input.workspaceRoot, project.codePath, project.vaultPath);
    if (
      !safety.safe
      || safety.canonicalCodePath !== project.canonicalCodePath
      || safety.canonicalVaultPath !== project.canonicalVaultPath
    ) {
      revalidationProblems.set(project.codePath, ambiguousReport(
        project.row.slack_channel_name,
        project.codePath,
        project.vaultPath,
        safety.safe
          ? "Project root identity changed after migration preflight"
          : `Project roots became unsafe after migration preflight: ${safety.warnings.join("; ")}`,
        project.report.actions,
      ));
    }
  }
  if (revalidationProblems.size > 0) {
    return buildReport(input, false, false, reports.map((report) => (
      revalidationProblems.get(report.codePath) ?? report
    )), input.reviewedExceptionFingerprints ?? []);
  }
  if (!exceptionState(reports, input.reviewedExceptionFingerprints ?? []).accepted) {
    return buildReport(input, false, false, reports, input.reviewedExceptionFingerprints ?? []);
  }

  const appliedReports = [...reports];
  let failed = false;
  let partial = false;
  for (const [applyIndex, project] of preflighted.entries()) {
    if (failed) {
      continue;
    }
    input.beforeApplyProject?.(project.report, applyIndex);
    const result = safelyReconcile({
      row: project.row,
      workspaceRoot: input.workspaceRoot,
      codePath: project.codePath,
      vaultPath: project.vaultPath,
      apply: true,
      initializeGit,
      plannedActions: project.report.actions,
      expectedPlan: {
        canonicalCodePath: project.canonicalCodePath,
        canonicalVaultPath: project.canonicalVaultPath,
        actions: project.report.actions,
        expectedGitFingerprint: project.report.expectedGitFingerprint!,
      },
    });
    appliedReports[project.reportIndex] = result;
    if (result.outcome === "ambiguous" || result.outcome === "skipped") {
      failed = true;
      partial = true;
    }
  }

  return buildReport(input, !failed, partial, appliedReports, input.reviewedExceptionFingerprints ?? []);
}

function preparedInventoryProblems(
  reports: ProjectScaffoldReport[],
  preparedProjects: PreparedMigrationProject[] | undefined,
  allowActionSubsets: boolean,
) {
  const problems = new Map<string, string>();
  if (!preparedProjects) return problems;
  const preparedByCodePath = new Map(preparedProjects.map((project) => [project.codePath, project]));
  const reportsByCodePath = new Map(reports.map((report) => [report.codePath, report]));

  for (const report of reports) {
    if (report.outcome !== "migrated") continue;
    const prepared = preparedByCodePath.get(report.codePath);
    if (!prepared) {
      problems.set(report.codePath, "Migration candidate was not present in the prepared Git inventory");
      continue;
    }
    if (report.vaultPath !== prepared.vaultPath || report.expectedGitFingerprint !== prepared.expectedGitFingerprint) {
      problems.set(report.codePath, "Migration identity or expected Git state changed after preparation");
      continue;
    }
    const actionsMatch = allowActionSubsets
      ? report.actions.every((action) => prepared.plannedActions.includes(action))
      : JSON.stringify(report.actions) === JSON.stringify(prepared.plannedActions);
    if (!actionsMatch) {
      problems.set(report.codePath, "Migration actions changed after Git preparation");
    }
  }

  for (const prepared of preparedProjects) {
    const report = reportsByCodePath.get(prepared.codePath);
    if (!report || !["migrated", "unchanged"].includes(report.outcome)) {
      problems.set(prepared.codePath, "Prepared migration project disappeared or became blocked");
      continue;
    }
    if (report.vaultPath !== prepared.vaultPath || report.expectedGitFingerprint !== prepared.expectedGitFingerprint) {
      problems.set(prepared.codePath, "Prepared migration project no longer has its reviewed identity or Git state");
    }
    if (!allowActionSubsets && report.outcome !== "migrated") {
      problems.set(prepared.codePath, "Prepared migration project converged before the applying preflight");
    }
  }
  return problems;
}

function registryPathProblem(row: ManagedProjectRow) {
  for (const [label, value] of [["code_path", row.code_path], ["vault_path", row.vault_path]] as const) {
    if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
      return `Registry ${label} must be a non-empty absolute path: ${String(value)}`;
    }
  }
  return null;
}

function duplicateIdentityProblem(
  safety: Extract<ProjectRootSafety, { safe: true }>,
  seenCodePaths: Map<string, string>,
  seenVaultPaths: Map<string, string>,
) {
  const codeOwner = seenCodePaths.get(safety.canonicalCodePath);
  if (codeOwner) {
    return `Canonical code path duplicates ${codeOwner}: ${safety.canonicalCodePath}`;
  }
  const vaultOwner = seenVaultPaths.get(safety.canonicalVaultPath);
  if (vaultOwner) {
    return `Canonical vault path duplicates ${vaultOwner}: ${safety.canonicalVaultPath}`;
  }
  return null;
}

function safelyReconcile(input: {
  row: ManagedProjectRow;
  workspaceRoot: string;
  codePath: string;
  vaultPath: string;
  apply: boolean;
  initializeGit: boolean;
  plannedActions?: string[];
  expectedPlan?: NonNullable<Parameters<typeof reconcileProjectScaffold>[0]["expectedPlan"]>;
}) {
  try {
    return reconcileProjectScaffold({
      projectName: input.row.slack_channel_name,
      workspaceRoot: input.workspaceRoot,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      apply: input.apply,
      initializeGit: input.initializeGit,
      requireExistingCodeRoot: true,
      expectedPlan: input.expectedPlan,
    });
  } catch (error) {
    return ambiguousReport(
      input.row.slack_channel_name,
      input.codePath,
      input.vaultPath,
      `Scaffold migration failed${input.apply ? " after apply began; inspect every planned action" : ""}: ${String(error)}`,
      input.plannedActions ?? [],
    );
  }
}

function buildReport(
  input: { stateDbPath: string; workspaceRoot: string },
  applied: boolean,
  partial: boolean,
  projects: ProjectScaffoldReport[],
  reviewedExceptionFingerprints: string[],
): ManagedProjectMigrationReport {
  const exceptions = exceptionState(projects, reviewedExceptionFingerprints);
  return {
    stateDbPath: input.stateDbPath,
    workspaceRoot: input.workspaceRoot,
    applied,
    partial,
    exceptionsAccepted: exceptions.accepted,
    exceptionFingerprints: exceptions.entries,
    projects,
    counts: {
      migrated: projects.filter((project) => project.outcome === "migrated").length,
      unchanged: projects.filter((project) => project.outcome === "unchanged").length,
      skipped: projects.filter((project) => project.outcome === "skipped").length,
      ambiguous: projects.filter((project) => project.outcome === "ambiguous").length,
    },
  };
}

function exceptionState(projects: ProjectScaffoldReport[], reviewedFingerprints: string[]) {
  const entries = projects
    .filter((project) => project.outcome === "skipped" || project.outcome === "ambiguous")
    .map((project) => ({
      projectName: project.projectName,
      codePath: project.codePath,
      fingerprint: projectExceptionFingerprint(project),
    }));
  const current = entries.map((entry) => entry.fingerprint).sort();
  const reviewed = [...reviewedFingerprints].sort();
  return {
    entries,
    accepted: current.length === reviewed.length && current.every((fingerprint, index) => fingerprint === reviewed[index]),
  };
}

function projectExceptionFingerprint(project: ProjectScaffoldReport) {
  const filesystem = project.outcome === "ambiguous"
    ? scaffoldDecisionSnapshot(project.codePath, project.vaultPath)
    : null;
  return createHash("sha256").update(JSON.stringify({
    projectName: project.projectName,
    codePath: project.codePath,
    vaultPath: project.vaultPath,
    classification: project.classification,
    outcome: project.outcome,
    actions: project.actions,
    warnings: project.warnings,
    filesystem,
  })).digest("hex");
}

function scaffoldDecisionSnapshot(codePath: string, vaultPath: string) {
  const paths = [
    codePath,
    `${codePath}/AGENTS.md`,
    `${codePath}/CLAUDE.md`,
    `${codePath}/docs`,
    `${codePath}/docs/README.md`,
    `${codePath}/notes`,
    vaultPath,
    `${vaultPath}/AGENTS.md`,
    `${vaultPath}/AGENTS.md.migrated-to-code-root`,
    `${vaultPath}/notes`,
    `${vaultPath}/notes/inbox.md`,
    `${vaultPath}/notes.pre-concierge-scaffold`,
  ];
  return paths.map((path) => inspectSnapshotPath(path));
}

function inspectSnapshotPath(path: string): unknown {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { path, kind: "symlink", target: readlinkSync(path) };
    if (stat.isFile()) {
      return { path, kind: "file", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
    }
    if (stat.isDirectory()) {
      return {
        path,
        kind: "directory",
        entries: readdirSync(path, { withFileTypes: true })
          .map((entry) => `${entry.name}:${entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"}`)
          .sort(),
      };
    }
    return { path, kind: "other" };
  } catch {
    return { path, kind: "missing" };
  }
}

function skippedReport(
  projectName: string,
  codePath: string,
  vaultPath: string,
  warning: string,
): ProjectScaffoldReport {
  return {
    projectName,
    codePath,
    vaultPath,
    classification: "structurally_invalid",
    outcome: "skipped",
    applied: false,
    expectedGitFingerprint: null,
    actions: [],
    warnings: [warning],
  };
}

function ambiguousReport(
  projectName: string,
  codePath: string,
  vaultPath: string,
  warning: string,
  actions: string[],
): ProjectScaffoldReport {
  return {
    projectName,
    codePath,
    vaultPath,
    classification: "structurally_invalid",
    outcome: "ambiguous",
    applied: false,
    expectedGitFingerprint: null,
    actions,
    warnings: [warning],
  };
}
