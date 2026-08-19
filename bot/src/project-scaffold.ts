import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type InstructionClassification =
  | "missing"
  | "generated_placeholder"
  | "customized"
  | "structurally_invalid";

export type ScaffoldOutcome = "migrated" | "unchanged" | "skipped" | "ambiguous";

export interface ProjectScaffoldPaths {
  group: string | null;
  name: string;
  rel: string;
  code: string;
  vault: string;
}

export interface ProjectScaffoldReport {
  projectName: string;
  codePath: string;
  vaultPath: string;
  classification: InstructionClassification;
  outcome: ScaffoldOutcome;
  applied: boolean;
  expectedGitFingerprint: string | null;
  actions: string[];
  warnings: string[];
}

export interface ReconcileProjectScaffoldInput {
  projectName: string;
  workspaceRoot: string;
  codePath: string;
  vaultPath: string;
  apply?: boolean;
  initializeGit?: boolean;
  requireExistingCodeRoot?: boolean;
  expectedPlan?: {
    canonicalCodePath: string;
    canonicalVaultPath: string;
    actions: string[];
    expectedGitFingerprint: string;
  };
  beforeMutationValidation?: () => void;
}

type EntryKind = "missing" | "file" | "symlink" | "other";

interface InspectedEntry {
  path: string;
  kind: EntryKind;
  content: string | null;
  resolvedPath: string | null;
}

export type ProjectRootSafety =
  | { safe: true; canonicalWorkspaceRoot: string; canonicalCodePath: string; canonicalVaultPath: string }
  | { safe: false; warnings: string[] };

const NOTES_BACKUP_NAME = "notes.pre-concierge-scaffold";
const VAULT_AGENTS_ARCHIVE_NAME = "AGENTS.md.migrated-to-code-root";

export function projectNameParts(value: string): { group: string | null; name: string; rel: string } {
  const clean = value.trim().replace(/^#/, "").toLowerCase();
  if (clean.endsWith("-skill")) {
    return {
      group: "skills",
      name: clean,
      rel: join("skills", clean),
    };
  }
  const parts = clean.split("_").filter(Boolean);
  const rel = parts.join("/");
  return {
    group: parts.length > 1 ? parts[0] : null,
    name: parts.at(-1) || clean,
    rel: rel || clean,
  };
}

export function managedProjectPaths(workspaceRoot: string, projectName: string): ProjectScaffoldPaths {
  const parsed = projectNameParts(projectName);
  return {
    ...parsed,
    code: join(workspaceRoot, parsed.rel),
    vault: join(workspaceRoot, "vault", "projects", parsed.rel),
  };
}

export function canonicalAgentsTemplate(projectName: string, codePath: string) {
  return [
    `# ${projectName}`,
    "",
    `Working directory: \`${codePath}\``,
    "",
    "## Project map",
    "",
    "- [`docs/README.md`](docs/README.md) — durable project documentation.",
    "- `notes/` — synced capture notes.",
    "",
  ].join("\n");
}

export function canonicalDocsIndexTemplate(projectName: string) {
  return [
    `# ${projectName} documentation`,
    "",
    "This is the index for durable project documentation. Link current architecture and runbooks here as they are added; keep reviewed plans and dated incidents distinct from current behavior.",
    "",
  ].join("\n");
}

export function inspectProjectRoots(
  workspaceRoot: string,
  codePath: string,
  vaultPath: string,
): ProjectRootSafety {
  const warnings: string[] = [];
  for (const [label, path] of [
    ["Workspace", workspaceRoot],
    ["Code", codePath],
    ["Vault", vaultPath],
  ] as const) {
    if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
      warnings.push(`${label} path must be a non-empty absolute path: ${String(path)}`);
    }
  }
  if (warnings.length > 0) return { safe: false, warnings };
  if (entryExists(workspaceRoot) && !isDirectory(workspaceRoot)) {
    warnings.push(`Workspace root is not a real directory: ${workspaceRoot}`);
  }
  if (entryExists(codePath) && !isDirectory(codePath)) {
    warnings.push(`Code root is not a real directory: ${codePath}`);
  }
  if (entryExists(vaultPath) && !isDirectory(vaultPath)) {
    warnings.push(`Vault root is not a real directory: ${vaultPath}`);
  }
  if (warnings.length > 0) return { safe: false, warnings };

  try {
    const canonicalWorkspaceRoot = canonicalPotentialPath(workspaceRoot);
    const canonicalCodePath = canonicalPotentialPath(codePath);
    const canonicalVaultPath = canonicalPotentialPath(vaultPath);
    if (!isStrictDescendant(canonicalWorkspaceRoot, canonicalCodePath)) {
      warnings.push(`Code path is outside the workspace root: ${codePath}`);
    }
    if (!isStrictDescendant(canonicalWorkspaceRoot, canonicalVaultPath)) {
      warnings.push(`Vault path is outside the workspace root: ${vaultPath}`);
    }
    if (
      canonicalCodePath === canonicalVaultPath
      || isStrictDescendant(canonicalCodePath, canonicalVaultPath)
      || isStrictDescendant(canonicalVaultPath, canonicalCodePath)
    ) {
      warnings.push(`Code and vault paths overlap: ${codePath} and ${vaultPath}`);
    }
    if (warnings.length > 0) return { safe: false, warnings };
    return { safe: true, canonicalWorkspaceRoot, canonicalCodePath, canonicalVaultPath };
  } catch (error) {
    return { safe: false, warnings: [`Project roots cannot be canonicalized safely: ${String(error)}`] };
  }
}

export function reconcileProjectScaffold(input: ReconcileProjectScaffoldInput): ProjectScaffoldReport {
  const apply = input.apply ?? true;
  const initializeGit = input.initializeGit ?? true;
  const actions: string[] = [];
  const warnings: string[] = [];
  const codeAgentsPath = join(input.codePath, "AGENTS.md");
  const codeClaudePath = join(input.codePath, "CLAUDE.md");
  const vaultAgentsPath = join(input.vaultPath, "AGENTS.md");
  const vaultAgentsArchivePath = join(input.vaultPath, VAULT_AGENTS_ARCHIVE_NAME);
  const vaultNotesPath = join(input.vaultPath, "notes");
  const inboxPath = join(vaultNotesPath, "inbox.md");
  const codeNotesPath = join(input.codePath, "notes");
  const notesBackupPath = join(input.vaultPath, NOTES_BACKUP_NAME);
  const docsPath = join(input.codePath, "docs");
  const docsIndexPath = join(docsPath, "README.md");

  const rootSafety = inspectProjectRoots(input.workspaceRoot, input.codePath, input.vaultPath);
  if (!rootSafety.safe) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification: "structurally_invalid",
      outcome: "ambiguous",
      applied: false,
      expectedGitFingerprint: null,
      actions,
      warnings: rootSafety.warnings,
    };
  }
  if (
    input.expectedPlan
    && (
      rootSafety.canonicalCodePath !== input.expectedPlan.canonicalCodePath
      || rootSafety.canonicalVaultPath !== input.expectedPlan.canonicalVaultPath
    )
  ) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification: "structurally_invalid",
      outcome: "ambiguous",
      applied: false,
      expectedGitFingerprint: null,
      actions,
      warnings: ["Project root identity changed at the scaffold mutation boundary"],
    };
  }
  if (input.requireExistingCodeRoot && !isDirectory(input.codePath)) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification: "structurally_invalid",
      outcome: "skipped",
      applied: false,
      expectedGitFingerprint: null,
      actions,
      warnings: [`Code root does not exist: ${input.codePath}`],
    };
  }

  const rawCodeAgents = inspectEntry(codeAgentsPath);
  const rawCodeClaude = inspectEntry(codeClaudePath);
  const rawVaultAgents = inspectEntry(vaultAgentsPath);
  const structuralProblems: string[] = [];
  const vaultAgents = inspectInstructionEntry(rawVaultAgents, null, null, structuralProblems);
  const codeAgents = inspectInstructionEntry(
    rawCodeAgents,
    vaultAgentsPath,
    rawVaultAgents.kind === "file",
    structuralProblems,
  );
  const codeClaude = inspectInstructionEntry(
    rawCodeClaude,
    codeAgentsPath,
    codeAgents.content !== null,
    structuralProblems,
  );
  structuralProblems.push(...[codeAgents, codeClaude, vaultAgents]
    .filter((entry) => entry.kind === "other")
    .map((entry) => `Instruction path is not a file or permitted symlink: ${entry.path}`));

  const instructionCandidates = [codeAgents, codeClaude, vaultAgents]
    .filter((entry): entry is InspectedEntry & { content: string } => entry.content !== null);
  const customizedCandidates = instructionCandidates.filter((entry) => !isGeneratedPlaceholder(entry.content));
  const distinctCustomizedContent = [...new Set(customizedCandidates.map((entry) => entry.content))];

  if (distinctCustomizedContent.length > 1) {
    structuralProblems.push(
      `Customized instruction files disagree: ${customizedCandidates.map((entry) => entry.path).join(", ")}`,
    );
  }

  if (vaultAgents.kind !== "missing" && entryExists(vaultAgentsArchivePath)) {
    structuralProblems.push(
      `Cannot archive ${vaultAgentsPath}: destination already exists at ${vaultAgentsArchivePath}`,
    );
  }

  const codeNotes = inspectEntry(codeNotesPath);
  if (entryExists(docsPath) && !isDirectory(docsPath)) {
    structuralProblems.push(`Documentation path is not a directory: ${docsPath}`);
  }
  const docsIndex = inspectEntry(docsIndexPath);
  if (entryExists(docsIndexPath) && docsIndex.kind !== "file") {
    structuralProblems.push(`Documentation index is not a regular file: ${docsIndexPath}`);
  }
  if (entryExists(vaultNotesPath) && !isDirectory(vaultNotesPath)) {
    structuralProblems.push(`Vault notes path is not a directory: ${vaultNotesPath}`);
  }
  if (entryExists(inboxPath) && inspectEntry(inboxPath).kind !== "file") {
    structuralProblems.push(`Inbox path is not a regular file: ${inboxPath}`);
  }
  if (codeNotes.kind === "other" && !isDirectory(codeNotesPath)) {
    structuralProblems.push(`Notes path is not a directory or symlink: ${codeNotesPath}`);
  }
  if (codeNotes.kind === "symlink" && !isCanonicalSymlink(codeNotesPath, vaultNotesPath)) {
    structuralProblems.push(`Notes symlink has a noncanonical target: ${codeNotesPath}`);
  }
  if (
    codeNotes.kind !== "missing" &&
    !isCanonicalSymlink(codeNotesPath, vaultNotesPath) &&
    entryExists(notesBackupPath)
  ) {
    structuralProblems.push(`Cannot preserve ${codeNotesPath}: backup already exists at ${notesBackupPath}`);
  }

  if (structuralProblems.length > 0) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification: "structurally_invalid",
      outcome: "ambiguous",
      applied: false,
      expectedGitFingerprint: null,
      actions,
      warnings: structuralProblems,
    };
  }

  const canonicalContent = distinctCustomizedContent[0]
    ?? canonicalAgentsTemplate(input.projectName, input.codePath);
  const classification: InstructionClassification = distinctCustomizedContent.length === 1
    ? "customized"
    : instructionCandidates.length > 0
      ? "generated_placeholder"
      : "missing";
  const expectedGitFingerprint = createHash("sha256").update(JSON.stringify({
    agents: createHash("sha256").update(canonicalContent).digest("hex"),
    claude: resolve(codeAgentsPath),
    docs: createHash("sha256").update(
      docsIndex.content ?? canonicalDocsIndexTemplate(input.projectName),
    ).digest("hex"),
    notes: resolve(vaultNotesPath),
  })).digest("hex");

  if (!isDirectory(input.codePath)) actions.push(`create code root ${input.codePath}`);
  if (initializeGit && !entryExists(join(input.codePath, ".git"))) actions.push(`initialize git in ${input.codePath}`);
  if (codeAgents.kind !== "file" || codeAgents.content !== canonicalContent) {
    actions.push(`write canonical instructions ${codeAgentsPath}`);
  }
  if (!isCanonicalSymlink(codeClaudePath, codeAgentsPath)) {
    actions.push(`link ${codeClaudePath} -> AGENTS.md`);
  }
  if (!isDirectory(docsPath)) actions.push(`create documentation root ${docsPath}`);
  if (!entryExists(docsIndexPath)) actions.push(`create documentation index ${docsIndexPath}`);
  if (vaultAgents.kind !== "missing") {
    actions.push(`archive vault instructions at ${vaultAgentsArchivePath}`);
  }
  if (!isDirectory(vaultNotesPath)) actions.push(`create vault notes ${vaultNotesPath}`);
  if (!entryExists(inboxPath)) actions.push(`create inbox ${inboxPath}`);
  if (!isCanonicalSymlink(codeNotesPath, vaultNotesPath)) {
    if (codeNotes.kind !== "missing") actions.push(`preserve existing notes at ${notesBackupPath}`);
    actions.push(`link ${codeNotesPath} -> ${relative(dirname(codeNotesPath), vaultNotesPath)}`);
  }

  input.beforeMutationValidation?.();
  const mutationRootSafety = input.expectedPlan
    ? inspectProjectRoots(input.workspaceRoot, input.codePath, input.vaultPath)
    : rootSafety;
  if (input.expectedPlan && (
    !mutationRootSafety.safe
    || mutationRootSafety.canonicalCodePath !== input.expectedPlan.canonicalCodePath
    || mutationRootSafety.canonicalVaultPath !== input.expectedPlan.canonicalVaultPath
    || JSON.stringify(actions) !== JSON.stringify(input.expectedPlan.actions)
    || expectedGitFingerprint !== input.expectedPlan.expectedGitFingerprint
  )) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification: "structurally_invalid",
      outcome: "ambiguous",
      applied: false,
      expectedGitFingerprint,
      actions,
      warnings: ["Project scaffold decision changed at the mutation boundary; no project writes were performed"],
    };
  }

  if (actions.length === 0) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification,
      outcome: "unchanged",
      applied: apply,
      expectedGitFingerprint,
      actions,
      warnings,
    };
  }

  if (!apply) {
    return {
      projectName: input.projectName,
      codePath: input.codePath,
      vaultPath: input.vaultPath,
      classification,
      outcome: "migrated",
      applied: false,
      expectedGitFingerprint,
      actions,
      warnings,
    };
  }

  mkdirSync(input.codePath, { recursive: true });
  if (initializeGit && !entryExists(join(input.codePath, ".git"))) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: input.codePath, stdio: "ignore" });
  }
  mkdirSync(vaultNotesPath, { recursive: true });
  mkdirSync(docsPath, { recursive: true });

  if (codeAgents.kind !== "file" || codeAgents.content !== canonicalContent) {
    atomicWrite(codeAgentsPath, canonicalContent);
  }
  if (!isCanonicalSymlink(codeClaudePath, codeAgentsPath)) {
    removeEntry(codeClaudePath);
    symlinkSync("AGENTS.md", codeClaudePath);
  }
  if (!entryExists(docsIndexPath)) {
    writeFileSync(docsIndexPath, canonicalDocsIndexTemplate(input.projectName));
  }
  if (vaultAgents.kind !== "missing") {
    renameSync(vaultAgentsPath, vaultAgentsArchivePath);
  }
  if (!entryExists(inboxPath)) {
    writeFileSync(inboxPath, `# ${input.projectName} inbox\n`);
  }
  if (!isCanonicalSymlink(codeNotesPath, vaultNotesPath)) {
    if (codeNotes.kind !== "missing") {
      renameSync(codeNotesPath, notesBackupPath);
      copyMissingEntries(notesBackupPath, vaultNotesPath, warnings);
    }
    symlinkSync(relative(dirname(codeNotesPath), vaultNotesPath), codeNotesPath);
  }

  return {
    projectName: input.projectName,
    codePath: input.codePath,
    vaultPath: input.vaultPath,
    classification,
    outcome: "migrated",
    applied: true,
    expectedGitFingerprint,
    actions,
    warnings,
  };
}

export function actualProjectGitFingerprint(codePath: string, vaultPath: string) {
  const agentsPath = join(codePath, "AGENTS.md");
  const claudePath = join(codePath, "CLAUDE.md");
  const docsPath = join(codePath, "docs", "README.md");
  const notesPath = join(codePath, "notes");
  const agents = inspectEntry(agentsPath);
  const docs = inspectEntry(docsPath);
  if (
    agents.kind !== "file"
    || agents.content === null
    || docs.kind !== "file"
    || docs.content === null
    || !isCanonicalSymlink(claudePath, agentsPath)
    || !isCanonicalSymlink(notesPath, join(vaultPath, "notes"))
  ) return null;
  return createHash("sha256").update(JSON.stringify({
    agents: createHash("sha256").update(agents.content).digest("hex"),
    claude: resolve(agentsPath),
    docs: createHash("sha256").update(docs.content).digest("hex"),
    notes: resolve(vaultPath, "notes"),
  })).digest("hex");
}

function inspectEntry(path: string): InspectedEntry {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { path, kind: "missing", content: null, resolvedPath: null };
  }

  if (stat.isFile()) {
    return { path, kind: "file", content: readFileSync(path, "utf8"), resolvedPath: path };
  }
  if (stat.isSymbolicLink()) {
    return { path, kind: "symlink", content: null, resolvedPath: null };
  }
  return { path, kind: "other", content: null, resolvedPath: null };
}

function inspectInstructionEntry(
  entry: InspectedEntry,
  permittedSymlinkTarget: string | null,
  targetIsInspectable: boolean | null,
  structuralProblems: string[],
): InspectedEntry {
  if (entry.kind !== "symlink") return entry;
  if (!permittedSymlinkTarget || !isCanonicalSymlink(entry.path, permittedSymlinkTarget)) {
    structuralProblems.push(`Instruction symlink has a noncanonical target: ${entry.path}`);
    return entry;
  }
  if (!targetIsInspectable) {
    structuralProblems.push(`Instruction symlink target is missing, cyclic, or not a regular file: ${entry.path}`);
    return entry;
  }
  try {
    return {
      ...entry,
      content: readFileSync(entry.path, "utf8"),
      resolvedPath: realpathSync(entry.path),
    };
  } catch {
    structuralProblems.push(`Instruction symlink target cannot be read safely: ${entry.path}`);
    return entry;
  }
}

function isGeneratedPlaceholder(content: string) {
  if (
    /^# [^\n]+\n\nWorking directory: `[^`]+`\n\n## Project map\n\n- \[`docs\/README\.md`\]\(docs\/README\.md\) — durable project documentation\.\n- `notes\/` — synced capture notes\.\n$/.test(content)
  ) return true;
  if (/^# [^\n]+\n\nWorking directory: `[^`]+`\n$/.test(content)) return true;
  if (/^# [^\n]+\n\nAgent instructions for this project\.\n\nWorking directory: [^\n]+\n$/.test(content)) return true;
  return /^# [^\n]+\n\n_TODO: describe how the agent should approach this project\._\n$/.test(content);
}

function isCanonicalSymlink(linkPath: string, targetPath: string) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    return resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(targetPath);
  } catch {
    return false;
  }
}

function isDirectory(path: string) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function entryExists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function canonicalPotentialPath(path: string) {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!entryExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(existingAncestor.slice(parent.length + 1));
    existingAncestor = parent;
  }
  const canonicalAncestor = entryExists(existingAncestor)
    ? realpathSync(existingAncestor)
    : existingAncestor;
  return resolve(canonicalAncestor, ...missingSegments);
}

function isStrictDescendant(parent: string, child: string) {
  const childRelativePath = relative(parent, child);
  return childRelativePath.length > 0 && !childRelativePath.startsWith("..") && !isAbsolute(childRelativePath);
}

function atomicWrite(path: string, content: string) {
  const temporaryPath = join(dirname(path), `.AGENTS.md.concierge-${process.pid}-${randomUUID()}`);
  writeFileSync(temporaryPath, content, { flag: "wx" });
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function removeEntry(path: string) {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    if (entryExists(path)) throw error;
  }
}

function copyMissingEntries(sourceDirectory: string, destinationDirectory: string, warnings: string[]) {
  for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
    const source = join(sourceDirectory, entry.name);
    const destination = join(destinationDirectory, entry.name);
    if (entryExists(destination)) {
      warnings.push(`Preserved both note copies after collision at ${destination}`);
      continue;
    }
    cpSync(source, destination, { recursive: true, preserveTimestamps: true });
  }
}
