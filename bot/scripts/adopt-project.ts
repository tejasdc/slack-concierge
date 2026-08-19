import { existsSync } from "node:fs";
import { registerAdoptedProject } from "../src/project-registry";
import {
  managedProjectPaths,
  reconcileProjectScaffold,
} from "../src/project-scaffold";
import { withPausedObsidianSync } from "../src/sync-service";

export function adoptManagedProject(input: {
  projectName: string;
  workspaceRoot: string;
  stateDbPath: string;
  apply?: boolean;
  initializeGit?: boolean;
}) {
  const paths = managedProjectPaths(input.workspaceRoot, input.projectName);
  const report = reconcileProjectScaffold({
    projectName: input.projectName,
    workspaceRoot: input.workspaceRoot,
    codePath: paths.code,
    vaultPath: paths.vault,
    apply: input.apply ?? true,
    initializeGit: input.initializeGit ?? true,
    requireExistingCodeRoot: true,
  });
  if ((input.apply ?? true) && !["ambiguous", "skipped"].includes(report.outcome)) {
    registerAdoptedProject({
      stateDbPath: input.stateDbPath,
      projectName: input.projectName,
      vaultPath: paths.vault,
      codePath: paths.code,
      group: paths.group,
      name: paths.name,
    });
  }
  return { paths, report, registryUpdated: (input.apply ?? true) && !["ambiguous", "skipped"].includes(report.outcome) };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  if (!existsSync(managedProjectPaths(options.workspaceRoot, options.projectName).code)) {
    throw new Error(`Code project does not exist for ${options.projectName}`);
  }

  const result = withPausedObsidianSync({
    enabled: options.pauseSync,
    apply: options.apply,
    operation: () => adoptManagedProject(options),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.report.outcome === "ambiguous" || result.report.outcome === "skipped") process.exitCode = 2;
}

function parseArguments(args: string[]) {
  const projectName = args.shift() || "";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
    throw new Error("Usage: adopt-project.sh <lowercase-slug> [--dry-run] [--pause-sync] [--workspace-root PATH] [--state-db PATH]");
  }
  const options = {
    projectName,
    workspaceRoot: process.env.CONCIERGE_WORKSPACE_ROOT || "/root/workspace",
    stateDbPath: process.env.CONCIERGE_STATE_DB || "/root/.local/state/concierge/state.db",
    apply: true,
    initializeGit: true,
    pauseSync: false,
  };
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--dry-run") options.apply = false;
    else if (argument === "--pause-sync") options.pauseSync = true;
    else if (argument === "--no-git") options.initializeGit = false;
    else if (argument === "--workspace-root") options.workspaceRoot = requiredValue(argument, args.shift());
    else if (argument === "--state-db") options.stateDbPath = requiredValue(argument, args.shift());
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function requiredValue(flag: string, value: string | undefined) {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
