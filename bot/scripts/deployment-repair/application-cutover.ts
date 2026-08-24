#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildApplicationCutoverPlan,
  claudeProjectDirectory,
  providerProjectRegistry,
  renderContainedBotDropIn,
  renderContainedKernelDropIn,
  renderProviderBrokerDropIn,
  renderProviderWorkerDropIn,
  type ApplicationCutoverPlan,
} from "../../src/deployment-repair/application-cutover";
import { nextJournaledUnitFileAction } from "../../src/deployment-repair/unit-file-journal";

type CutoverPhase = "prepared" | "applied" | "verified" | "committed" | "rolling_back" | "rolled_back" | "parked";

interface FileEvidence {
  path: string;
  exists: boolean;
  inode: number | null;
  uid: number | null;
  gid: number | null;
  mode: number | null;
  byte_size: number | null;
  sha256: string | null;
}

interface CutoverJournal {
  schema_version: 2;
  id: string;
  phase: CutoverPhase;
  started_at: string;
  updated_at: string;
  source_state_dir: string;
  target_state_dir: string;
  source_database: FileEvidence;
  source_wal: FileEvidence;
  source_shm: FileEvidence;
  target_database: FileEvidence | null;
  drain_token: string;
  capture_token: string;
  plan: ApplicationCutoverPlan;
  plan_digest: string;
  acl_backup_path: string;
  unit_files: Array<{
    path: string;
    intended_sha256: string;
    original: FileEvidence;
    backup_path: string;
    state: "prepared" | "installed";
  }>;
  next_effect: string | null;
  completed_effects: string[];
  verification: Record<string, unknown> | null;
  history: Array<{ at: string; event: string; detail?: Record<string, unknown> }>;
  error: string | null;
}

const command = process.argv[2] || "status";
const options = parseOptions(process.argv.slice(3));
const cutoverId = requiredOption(options, "id", /^[a-z0-9][a-z0-9-]{0,99}$/);
const sourceStateDir = resolve(process.env.CONCIERGE_APPLICATION_SOURCE_STATE_DIR || "/root/.local/state/concierge");
const targetStateDir = resolve(process.env.CONCIERGE_APPLICATION_TARGET_STATE_DIR || "/var/lib/concierge-bot/state");
const cutoverRoot = resolve(process.env.CONCIERGE_APPLICATION_CUTOVER_ROOT || "/var/lib/concierge-deployment/application-cutovers");
const captureStateDir = resolve(process.env.CONCIERGE_CAPTURE_STATE_DIR || "/var/lib/concierge-capture");
const systemdRoot = resolve(process.env.CONCIERGE_SYSTEMD_DIR || "/etc/systemd/system");
const journalDirectory = join(cutoverRoot, cutoverId);
const journalPath = join(journalDirectory, "journal.json");

if (process.geteuid?.() !== 0 && process.env.CONCIERGE_APPLICATION_CUTOVER_ALLOW_NON_ROOT !== "1") {
  throw new Error("Application cutover requires root.");
}

if (command === "apply") {
  applyCutover();
} else if (command === "verify") {
  verifyCutover();
} else if (command === "commit") {
  commitCutover();
} else if (command === "rollback") {
  rollbackCutover();
} else if (command === "status") {
  console.log(JSON.stringify(readJournal(), null, 2));
} else {
  throw new Error("usage: application-cutover.ts <apply|verify|commit|rollback|status> --id ID [--drain-token TOKEN --capture-token TOKEN]");
}

function applyCutover() {
  const drainToken = requiredOption(options, "drain-token");
  const captureToken = requiredOption(options, "capture-token");
  assertServiceStopped();
  assertAdmissionHeld(sourceStateDir, drainToken, captureToken);
  let journal = existsSync(journalPath)
    ? readJournal()
    : createJournal(drainToken, captureToken);
  assertJournalIdentity(journal, drainToken, captureToken);
  if (["committed", "rolled_back"].includes(journal.phase)) {
    throw new Error(`Application cutover ${cutoverId} is already ${journal.phase}.`);
  }
  if (journal.phase === "parked") {
    stopProviderSockets(journal);
    journal = {
      ...journal,
      phase: "prepared",
      completed_effects: journal.completed_effects.filter((effect) => effect !== "provider_sockets_started"),
      next_effect: null,
      error: null,
      updated_at: new Date().toISOString(),
      history: [...journal.history, { at: new Date().toISOString(), event: "application_cutover_resuming" }],
    };
    writeJournal(journal);
  }
  try {
    journal = runEffect(journal, "raw_state_backed_up", () => backupRawState(journal));
    journal = runEffect(journal, "state_migrated", () => migrateState(journal));
    journal = runEffect(journal, "providers_prepared", () => prepareProviders(journal));
    journal = runEffect(journal, "workspace_acl_applied", () => applyWorkspaceAcl(journal));
    journal = runEffect(journal, "unit_dropins_installed", () => installUnitDropIns(journal));
    journal = runEffect(journal, "kernel_application_state_rebound", () => restartKernel());
    journal = runEffect(journal, "provider_sockets_started", () => startProviderSockets(journal));
    journal = transition(journal, "applied", "application_cutover_applied", {
      project_count: journal.plan.projects.length,
      session_count: journal.plan.projects.reduce((count, project) => count + project.sessions.length, 0),
    });
    console.log(JSON.stringify(journal));
  } catch (error) {
    park(journal, error);
    throw error;
  }
}

function verifyCutover() {
  let journal = readJournal();
  assertJournalReady(journal, new Set(["applied", "verified"]));
  assertAdmissionHeld(targetStateDir, journal.drain_token, journal.capture_token);
  verifyDatabase(join(targetStateDir, "state.db"));
  const registry = JSON.parse(readFileSync(join(dirname(targetStateDir), "provider-projects.json"), "utf8"));
  if (digestJson(registry) !== digestJson(providerProjectRegistry(journal.plan))) {
    throw new Error("Installed provider project registry drifted from the cutover plan.");
  }
  for (const project of journal.plan.projects) {
    systemctl("is-active", "--quiet", `concierge-provider-broker@${project.id}.socket`);
    systemctl("is-active", "--quiet", `concierge-provider-worker@${project.id}.socket`);
    assertAuthorityMatchesDatabase(project, join(targetStateDir, "state.db"));
    for (const session of project.sessions) {
      if (session.provider === "claude-code") assertClaudeSessionMaterial(project, session.uuid);
    }
  }
  const verification = {
    database_integrity: "ok",
    foreign_keys: "ok",
    registry_digest: digestJson(registry),
    project_count: journal.plan.projects.length,
    bound_session_count: journal.plan.projects.reduce((count, project) => count + project.sessions.length, 0),
    provider_sockets: "active",
  };
  journal = { ...journal, verification };
  writeJournal(journal);
  journal = transition(journal, "verified", "application_cutover_verified", verification);
  console.log(JSON.stringify(journal));
}

function commitCutover() {
  let journal = readJournal();
  assertJournalReady(journal, new Set(["verified", "committed"]));
  if (journal.phase !== "committed") {
    assertAdmissionHeld(targetStateDir, journal.drain_token, journal.capture_token);
    journal = transition(journal, "committed", "application_cutover_committed");
  }
  console.log(JSON.stringify(journal));
}

function rollbackCutover() {
  let journal = readJournal();
  if (journal.phase === "rolled_back") {
    console.log(JSON.stringify(journal));
    return;
  }
  if (journal.phase === "committed") throw new Error("A committed application cutover cannot use the pre-activation root fallback.");
  journal = transition(journal, "rolling_back", "application_cutover_rollback_started");
  systemctl("stop", "concierge-bot.service", { allowFailure: true });
  stopProviderSockets(journal);
  removeUnitDropIns(journal);
  restartKernel();
  restoreWorkspaceAcl(journal);
  restoreSourceState(journal);
  systemctl("daemon-reload");
  if (options.has("start-service")) systemctl("start", "concierge-bot.service");
  journal = transition(journal, "rolled_back", "application_cutover_rolled_back");
  console.log(JSON.stringify(journal));
}

function createJournal(drainToken: string, captureToken: string): CutoverJournal {
  mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  chmodSync(journalDirectory, 0o700);
  const sourceDatabasePath = join(sourceStateDir, "state.db");
  const database = new Database(sourceDatabasePath, { readonly: true, strict: true });
  let plan: ApplicationCutoverPlan;
  try {
    const channels = database.query(`
      SELECT slack_channel_id, slack_channel_name, code_path, vault_path, additional_paths
      FROM channels ORDER BY slack_channel_id
    `).all() as any[];
    const sessions = database.query(`
      SELECT id, slack_channel_id, provider_id, agent_session_uuid
      FROM sessions ORDER BY id
    `).all() as any[];
    plan = buildApplicationCutoverPlan({ channels, sessions });
  } finally {
    database.close();
  }
  const journal: CutoverJournal = {
    schema_version: 2,
    id: cutoverId,
    phase: "prepared",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    source_state_dir: sourceStateDir,
    target_state_dir: targetStateDir,
    source_database: fileEvidence(sourceDatabasePath),
    source_wal: fileEvidence(`${sourceDatabasePath}-wal`),
    source_shm: fileEvidence(`${sourceDatabasePath}-shm`),
    target_database: null,
    drain_token: drainToken,
    capture_token: captureToken,
    plan,
    plan_digest: digestJson(plan),
    acl_backup_path: join(journalDirectory, "workspace.acl"),
    unit_files: [],
    next_effect: null,
    completed_effects: [],
    verification: null,
    history: [{ at: new Date().toISOString(), event: "application_cutover_prepared" }],
    error: null,
  };
  writeJournal(journal);
  return journal;
}

function migrateState(journal: CutoverJournal) {
  assertAdmissionHeld(sourceStateDir, journal.drain_token, journal.capture_token);
  mkdirSync(targetStateDir, { recursive: true, mode: 0o700 });
  chownPath(targetStateDir, "concierge-bot", "concierge-bot");
  chmodSync(targetStateDir, 0o700);
  const stagedDatabase = join(journalDirectory, "target-state.db");
  if (!existsSync(stagedDatabase)) sqliteBackup(join(sourceStateDir, "state.db"), stagedDatabase);
  const database = new Database(stagedDatabase, { strict: true });
  try {
    const sessionColumns = database.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "provider_binding_token")) {
      database.exec("ALTER TABLE sessions ADD COLUMN provider_binding_token TEXT");
    }
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const rewrite = (table: string, column: string) => {
      database.query(`
        UPDATE ${table}
        SET ${column}=replace(${column}, ?, ?)
        WHERE ${column}=? OR ${column} LIKE ?
      `).run(
        journal.plan.source_workspace_root,
        journal.plan.stable_workspace_root,
        journal.plan.source_workspace_root,
        `${journal.plan.source_workspace_root}/%`,
      );
    };
    rewrite("channels", "vault_path");
    rewrite("channels", "code_path");
    rewrite("channels", "additional_paths");
    rewrite("fork_requests", "cwd");
    rewrite("fork_requests", "additional_dirs_json");
    rewrite("turn_artifact_batches", "directory_path");
    rewrite("turn_artifact_deliveries", "source_path");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  verifyDatabase(stagedDatabase);
  const destination = join(targetStateDir, "state.db");
  const temporary = `${destination}.${cutoverId}.next`;
  copyFileSync(stagedDatabase, temporary);
  chmodSync(temporary, 0o600);
  chownPath(temporary, "concierge-bot", "concierge-bot");
  syncFile(temporary);
  renameSync(temporary, destination);
  syncDirectory(targetStateDir);
  journal.target_database = fileEvidence(destination);
  writeJournal(journal);
}

function prepareProviders(journal: CutoverJournal) {
  assertAdmissionHeld(targetStateDir, journal.drain_token, journal.capture_token);
  prepareSharedProviderFiles();
  const databasePath = join(targetStateDir, "state.db");
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    for (const project of journal.plan.projects) prepareProviderProject(project, database, journal.plan);
    database.exec("COMMIT");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  chownPath(targetStateDir, "concierge-bot", "concierge-bot", true);
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${databasePath}${suffix}`;
    if (existsSync(path)) chmodSync(path, 0o600);
  }
  verifyDatabase(databasePath);
  const registryPath = join(dirname(targetStateDir), "provider-projects.json");
  writeAtomic(registryPath, `${JSON.stringify(providerProjectRegistry(journal.plan), null, 2)}\n`, 0o600);
  chownPath(registryPath, "concierge-bot", "concierge-bot");
  journal.target_database = fileEvidence(databasePath);
  writeJournal(journal);
}

function prepareSharedProviderFiles() {
  const sharedRoot = "/var/lib/concierge-provider/shared";
  const markerPath = join(sharedRoot, "snapshot.json");
  const sources = [
    ["/root/.codex/skills", join(sharedRoot, "codex/skills")],
    ["/root/.codex/plugins", join(sharedRoot, "codex/plugins")],
    ["/root/.codex/rules", join(sharedRoot, "codex/rules")],
    ["/root/.codex/prompts", join(sharedRoot, "codex/prompts")],
    ["/root/.codex/.tmp", join(sharedRoot, "codex/.tmp")],
    ["/root/.claude/skills", join(sharedRoot, "claude/skills")],
    ["/root/.claude/plugins", join(sharedRoot, "claude/plugins")],
    ["/root/.claude/agents", join(sharedRoot, "claude/agents")],
    ["/root/.claude/commands", join(sharedRoot, "claude/commands")],
  ] as const;
  if (!existsSync(markerPath)) {
    for (const [source, destination] of sources) {
      if (!existsSync(source)) continue;
      mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
      cpSync(source, destination, { recursive: true, dereference: true, force: true });
    }
    writeAtomic(markerPath, `${JSON.stringify({
      schema_version: 1,
      created_at: new Date().toISOString(),
      sources: sources.filter(([source]) => existsSync(source)).map(([source]) => ({
        path: source,
        evidence: fileEvidence(source, false),
      })),
    }, null, 2)}\n`, 0o444);
  }
  chownPath(sharedRoot, "root", "concierge-provider", true);
  run(["find", sharedRoot, "-type", "d", "-exec", "chmod", "0550", "{}", "+"]);
  run(["find", sharedRoot, "-type", "f", "-perm", "/111", "-exec", "chmod", "0550", "{}", "+"]);
  run(["find", sharedRoot, "-type", "f", "!", "-perm", "/111", "-exec", "chmod", "0440", "{}", "+"]);
}

function prepareProviderProject(
  project: ApplicationCutoverPlan["projects"][number],
  database: Database,
  plan: ApplicationCutoverPlan,
) {
  const providerProjectRoot = project.providerStateRoot;
  const providerHome = join(providerProjectRoot, "home");
  const codexHome = join(providerHome, ".codex");
  const claudeHome = join(providerHome, ".claude");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  mkdirSync(project.scratchPath, { recursive: true, mode: 0o770 });
  mkdirSync(project.authorityStateRoot, { recursive: true, mode: 0o700 });
  for (const stablePath of project.stableAllowedPaths) mkdirSync(stablePath, { recursive: true, mode: 0o755 });

  copyPrivateFile("/root/.codex/auth.json", join(codexHome, "auth.json"));
  const codexConfig = readFileSync("/root/.codex/config.toml", "utf8")
    .replaceAll(plan.source_workspace_root, plan.stable_workspace_root)
    .replaceAll("/root/.codex/.tmp", "/var/lib/concierge-provider/shared/codex/.tmp");
  writeAtomic(join(codexHome, "config.toml"), codexConfig, 0o600);
  copyPrivateFile("/root/.codex/AGENTS.md", join(codexHome, "AGENTS.md"));
  ensureSymlink("/var/lib/concierge-provider/shared/codex/skills", join(codexHome, "skills"));
  ensureSymlink("/var/lib/concierge-provider/shared/codex/plugins", join(codexHome, "plugins"));
  ensureSymlink("/var/lib/concierge-provider/shared/codex/rules", join(codexHome, "rules"));
  ensureSymlink("/var/lib/concierge-provider/shared/codex/prompts", join(codexHome, "prompts"));

  copyPrivateFile("/root/.claude/.credentials.json", join(claudeHome, ".credentials.json"));
  copyOptionalFile("/root/.claude/settings.json", join(claudeHome, "settings.json"), 0o600);
  copyOptionalFile("/root/.claude.json", join(providerHome, ".claude.json"), 0o600, (value) => (
    value.replaceAll(plan.source_workspace_root, plan.stable_workspace_root)
  ));
  copyPrivateFile("/root/.codex/AGENTS.md", join(claudeHome, "CLAUDE.md"));
  ensureSymlink("/var/lib/concierge-provider/shared/claude/skills", join(claudeHome, "skills"));
  ensureSymlink("/var/lib/concierge-provider/shared/claude/plugins", join(claudeHome, "plugins"));
  ensureSymlink("/var/lib/concierge-provider/shared/claude/agents", join(claudeHome, "agents"));
  ensureSymlink("/var/lib/concierge-provider/shared/claude/commands", join(claudeHome, "commands"));

  const secretPath = join(project.authorityStateRoot, "secret");
  if (!existsSync(secretPath)) writeAtomic(secretPath, `${randomBytes(32).toString("hex")}\n`, 0o600);
  const secret = Buffer.from(readFileSync(secretPath, "utf8").trim(), "hex");
  if (secret.length !== 32) throw new Error(`Provider authority secret is invalid for ${project.id}.`);
  const authoritySessions: Record<string, "codex" | "claude-code"> = {};
  for (const session of project.sessions) {
    authoritySessions[session.uuid] = session.provider;
    const token = createHmac("sha256", secret)
      .update(`${project.id}\0${session.provider}\0${session.uuid}`)
      .digest("hex");
    const changed = database.query(`
      UPDATE sessions SET provider_binding_token=?
      WHERE id=? AND provider_id=? AND agent_session_uuid=?
    `).run(token, session.databaseId, session.provider, session.uuid).changes;
    if (changed !== 1) throw new Error(`Provider session ${session.databaseId} changed during cutover.`);
    if (session.provider === "codex") copyCodexSession(session.uuid, codexHome);
    else copyClaudeSession(session.uuid, project.sourcePath, project.stablePath, claudeHome);
  }
  writeAtomic(join(project.authorityStateRoot, "sessions.json"), `${JSON.stringify({
    schema_version: 1,
    project_id: project.id,
    sessions: authoritySessions,
  }, null, 2)}\n`, 0o600);
  chownPath(project.authorityStateRoot, "root", "concierge-provider-broker", true);
  chownPath(providerProjectRoot, "root", "concierge-provider", true);
  chownPath(project.scratchPath, "concierge-bot", "concierge-provider", true);
  chmodSync(project.scratchPath, 0o770);
}

function copyCodexSession(uuid: string, codexHome: string) {
  const matches = findSessionFiles(["/root/.codex/sessions", "/root/.codex/archived_sessions"], uuid);
  if (matches.length !== 1) throw new Error(`Codex session ${uuid} has ${matches.length} source files.`);
  const source = matches[0];
  const sourceRoot = source.startsWith("/root/.codex/sessions/")
    ? "/root/.codex/sessions"
    : "/root/.codex/archived_sessions";
  const destination = join(codexHome, relative("/root/.codex", sourceRoot), relative(sourceRoot, source));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function copyClaudeSession(uuid: string, sourceProject: string, stableProject: string, claudeHome: string) {
  const matches = findSessionFiles(["/root/.claude/projects"], uuid);
  if (matches.length !== 1) throw new Error(`Claude session ${uuid} has ${matches.length} source files.`);
  const destinationDirectory = join(claudeHome, "projects", claudeProjectDirectory(stableProject));
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 });
  const destination = join(destinationDirectory, `${uuid}.jsonl`);
  copyFileSync(matches[0], destination);
  chmodSync(destination, 0o600);
  const sourceProjectDirectory = claudeProjectDirectory(sourceProject);
  if (!matches[0].includes(`/${sourceProjectDirectory}/`)) {
    throw new Error(`Claude session ${uuid} is not stored beneath its assigned project.`);
  }
}

function assertClaudeSessionMaterial(
  project: ApplicationCutoverPlan["projects"][number],
  uuid: string,
) {
  const path = join(
    join(project.providerStateRoot, "home"),
    ".claude/projects",
    claudeProjectDirectory(project.stablePath),
    `${uuid}.jsonl`,
  );
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Claude session ${uuid} material is missing.`);
}

function findSessionFiles(roots: string[], uuid: string) {
  const matches: string[] = [];
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (stat.isFile() && path.endsWith(`${uuid}.jsonl`)) {
      matches.push(path);
    }
  };
  for (const root of roots) visit(root);
  return matches;
}

function applyWorkspaceAcl(journal: CutoverJournal) {
  const roots = outermostPaths(journal.plan.projects.flatMap((project) => project.sourceAllowedPaths));
  if (!existsSync(journal.acl_backup_path)) {
    const backup = run(["getfacl", "-R", "-p", "--absolute-names", ...roots]).stdout;
    writeAtomic(journal.acl_backup_path, backup, 0o600);
  }
  run([
    "find", ...roots, "-xdev", "-type", "d", "-exec", "setfacl", "-m",
    "u:concierge-bot:rwx,g:concierge-provider:rwx,d:u:concierge-bot:rwx,d:g:concierge-provider:rwx", "{}", "+",
  ]);
  run([
    "find", ...roots, "-xdev", "-type", "f", "-perm", "/111", "-exec", "setfacl", "-m",
    "u:concierge-bot:rwx,g:concierge-provider:rwx", "{}", "+",
  ]);
  run([
    "find", ...roots, "-xdev", "-type", "f", "!", "-perm", "/111", "-exec", "setfacl", "-m",
    "u:concierge-bot:rw,g:concierge-provider:rw", "{}", "+",
  ]);
}

function restoreWorkspaceAcl(journal: CutoverJournal) {
  if (!existsSync(journal.acl_backup_path)) return;
  run(["setfacl", `--restore=${journal.acl_backup_path}`]);
}

function installUnitDropIns(journal: CutoverJournal) {
  const files = [{
    path: join(systemdRoot, "concierge-bot.service.d/50-application-cutover.conf"),
    contents: renderContainedBotDropIn(),
  }, {
    path: join(systemdRoot, "concierge-deployment-kernel.service.d/50-application-cutover.conf"),
    contents: renderContainedKernelDropIn(),
  }];
  for (const project of journal.plan.projects) {
    files.push({
      path: join(systemdRoot, `concierge-provider-broker@${project.id}.service.d/50-application-cutover.conf`),
      contents: renderProviderBrokerDropIn(project),
    }, {
      path: join(systemdRoot, `concierge-provider-worker@${project.id}.service.d/50-application-cutover.conf`),
      contents: renderProviderWorkerDropIn(project),
    });
  }
  for (const file of files) {
    const priorPath = join(journalDirectory, "unit-backups", relative(systemdRoot, file.path));
    const intendedDigest = sha256(Buffer.from(file.contents));
    let record = journal.unit_files.find((candidate) => candidate.path === file.path);
    if (!record) {
      record = {
        path: file.path,
        intended_sha256: intendedDigest,
        original: fileEvidence(file.path),
        backup_path: priorPath,
        state: "prepared",
      };
      journal.unit_files.push(record);
      writeJournal(journal);
    }
    if (record.intended_sha256 !== intendedDigest || record.backup_path !== priorPath) {
      throw new Error(`Unit drop-in authority changed for ${file.path}.`);
    }
    for (;;) {
      const action = nextJournaledUnitFileAction(record, fileEvidence(file.path), fileEvidence(priorPath));
      if (action === "complete") break;
      if (action === "backup_original") {
        mkdirSync(dirname(priorPath), { recursive: true, mode: 0o700 });
        copyFileSync(file.path, priorPath);
        chmodSync(priorPath, 0o600);
        syncFile(priorPath);
        continue;
      }
      if (action === "write_intended") {
        mkdirSync(dirname(file.path), { recursive: true, mode: 0o755 });
        writeAtomic(file.path, file.contents, 0o644);
        continue;
      }
      record.state = "installed";
      writeJournal(journal);
    }
  }
  systemctl("daemon-reload");
}

function restartKernel() {
  systemctl("restart", "concierge-deployment-kernel.service");
  systemctl("is-active", "--quiet", "concierge-deployment-kernel.service");
}

function removeUnitDropIns(journal: CutoverJournal) {
  for (const file of journal.unit_files) {
    const current = fileEvidence(file.path);
    if (file.original.exists) {
      const backup = fileEvidence(file.backup_path);
      if (!backup.exists || backup.sha256 !== file.original.sha256) {
        throw new Error(`Cannot restore ${file.path}: its original backup is missing or changed.`);
      }
      if (!sameOriginalFile(current, file.original) && current.sha256 !== file.intended_sha256) {
        throw new Error(`Cannot restore ${file.path}: the installed file drifted outside the journal.`);
      }
      const temporary = `${file.path}.${cutoverId}.restore`;
      copyFileSync(file.backup_path, temporary);
      chmodSync(temporary, file.original.mode || 0o644);
      chownSync(temporary, file.original.uid || 0, file.original.gid || 0);
      syncFile(temporary);
      renameSync(temporary, file.path);
      syncDirectory(dirname(file.path));
    } else if (current.exists) {
      if (current.sha256 !== file.intended_sha256) {
        throw new Error(`Cannot remove ${file.path}: the installed file drifted outside the journal.`);
      }
      unlinkSync(file.path);
      syncDirectory(dirname(file.path));
    }
  }
  systemctl("daemon-reload");
}

function startProviderSockets(journal: CutoverJournal) {
  for (const project of journal.plan.projects) {
    systemctl("enable", "--now", `concierge-provider-worker@${project.id}.socket`);
    systemctl("enable", "--now", `concierge-provider-broker@${project.id}.socket`);
  }
}

function stopProviderSockets(journal: CutoverJournal) {
  for (const project of journal.plan.projects) {
    systemctl("disable", "--now", `concierge-provider-broker@${project.id}.socket`, { allowFailure: true });
    systemctl("disable", "--now", `concierge-provider-worker@${project.id}.socket`, { allowFailure: true });
    systemctl("stop", `concierge-provider-broker@${project.id}.service`, { allowFailure: true });
    systemctl("stop", `concierge-provider-worker@${project.id}.service`, { allowFailure: true });
  }
}

function restoreSourceState(journal: CutoverJournal) {
  const targetDatabase = join(targetStateDir, "state.db");
  if (!existsSync(targetDatabase)) return;
  const restored = join(journalDirectory, "rollback-state.db");
  sqliteBackup(targetDatabase, restored);
  const database = new Database(restored, { strict: true });
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const rewrite = (table: string, column: string) => {
      database.query(`
        UPDATE ${table}
        SET ${column}=replace(${column}, ?, ?)
        WHERE ${column}=? OR ${column} LIKE ?
      `).run(
        journal.plan.stable_workspace_root,
        journal.plan.source_workspace_root,
        journal.plan.stable_workspace_root,
        `${journal.plan.stable_workspace_root}/%`,
      );
    };
    rewrite("channels", "vault_path");
    rewrite("channels", "code_path");
    rewrite("channels", "additional_paths");
    rewrite("fork_requests", "cwd");
    rewrite("fork_requests", "additional_dirs_json");
    rewrite("turn_artifact_batches", "directory_path");
    rewrite("turn_artifact_deliveries", "source_path");
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
  verifyDatabase(restored);
  const destination = join(sourceStateDir, "state.db");
  const temporary = `${destination}.${cutoverId}.restore`;
  copyFileSync(restored, temporary);
  chmodSync(temporary, journal.source_database.mode || 0o600);
  chownSync(temporary, journal.source_database.uid || 0, journal.source_database.gid || 0);
  syncFile(temporary);
  renameSync(temporary, destination);
  for (const suffix of ["-wal", "-shm"]) {
    const path = `${destination}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
  syncDirectory(sourceStateDir);
}

function assertAdmissionHeld(stateDir: string, drainToken: string, captureToken: string) {
  const database = new Database(join(stateDir, "state.db"), { readonly: true, strict: true });
  try {
    const row = database.query("SELECT token FROM deployment_drain WHERE singleton=1").get() as { token: string } | null;
    if (row?.token !== drainToken) throw new Error(`Application deployment drain is not held by ${drainToken}.`);
    const active = database.query(`
      SELECT COUNT(*) AS count FROM turns
      WHERE status IN ('running','delivering')
    `).get() as { count: number };
    if (Number(active.count) !== 0) throw new Error("Application cutover requires zero active provider turns.");
  } finally {
    database.close();
  }
  const captureDatabase = new Database(join(captureStateDir, "state.db"), { readonly: true, strict: true });
  try {
    const row = captureDatabase.query("SELECT token, mode FROM capture_delivery_gate WHERE singleton=1")
      .get() as { token: string; mode: string } | null;
    if (row?.token !== captureToken || row.mode !== "held") {
      throw new Error(`Capture delivery gate is not durably held by ${captureToken}.`);
    }
  } finally {
    captureDatabase.close();
  }
}

function assertAuthorityMatchesDatabase(
  project: ApplicationCutoverPlan["projects"][number],
  databasePath: string,
) {
  const authority = JSON.parse(readFileSync(join(project.authorityStateRoot, "sessions.json"), "utf8"));
  const secret = Buffer.from(readFileSync(join(project.authorityStateRoot, "secret"), "utf8").trim(), "hex");
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    for (const session of project.sessions) {
      if (authority.sessions?.[session.uuid] !== session.provider) {
        throw new Error(`Provider authority lost session ${session.uuid}.`);
      }
      const row = database.query("SELECT provider_binding_token FROM sessions WHERE id=?")
        .get(session.databaseId) as { provider_binding_token: string | null } | null;
      const expected = createHmac("sha256", secret)
        .update(`${project.id}\0${session.provider}\0${session.uuid}`)
        .digest("hex");
      if (row?.provider_binding_token !== expected) {
        throw new Error(`Database binding drifted for provider session ${session.databaseId}.`);
      }
    }
  } finally {
    database.close();
  }
}

function backupRawState(journal: CutoverJournal) {
  const rawRoot = join(journalDirectory, "source-raw");
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 });
  for (const evidence of [journal.source_database, journal.source_wal, journal.source_shm]) {
    if (!evidence.exists) continue;
    const destination = join(rawRoot, evidence.path.slice(sourceStateDir.length + 1));
    copyFileSync(evidence.path, destination);
    chmodSync(destination, 0o600);
    syncFile(destination);
    if (sha256(readFileSync(destination)) !== evidence.sha256) {
      throw new Error(`Raw application state backup changed while copying ${evidence.path}.`);
    }
  }
  syncDirectory(rawRoot);
}

function sqliteBackup(source: string, destination: string) {
  if (existsSync(destination)) unlinkSync(destination);
  const database = new Database(source, { readonly: true, strict: true });
  try {
    writeFileSync(destination, database.serialize(), { mode: 0o600 });
  } finally {
    database.close();
  }
  chmodSync(destination, 0o600);
  syncFile(destination);
}

function verifyDatabase(path: string) {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const integrity = database.query("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error(`Database integrity failed for ${path}.`);
    }
    const foreignKeys = database.query("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) throw new Error(`Database foreign-key validation failed for ${path}.`);
  } finally {
    database.close();
  }
}

function assertServiceStopped() {
  const result = Bun.spawnSync({ cmd: ["systemctl", "is-active", "--quiet", "concierge-bot.service"] });
  if (result.exitCode === 0) throw new Error("Application cutover requires concierge-bot.service to be stopped after drain.");
}

function runEffect(journal: CutoverJournal, effect: string, action: () => void) {
  if (journal.completed_effects.includes(effect)) return journal;
  journal = {
    ...journal,
    next_effect: effect,
    updated_at: new Date().toISOString(),
    history: [...journal.history, { at: new Date().toISOString(), event: "effect_prepared", detail: { effect } }],
  };
  writeJournal(journal);
  action();
  journal = {
    ...journal,
    next_effect: null,
    completed_effects: [...journal.completed_effects, effect],
    updated_at: new Date().toISOString(),
    history: [...journal.history, { at: new Date().toISOString(), event: "effect_completed", detail: { effect } }],
  };
  writeJournal(journal);
  return journal;
}

function transition(
  journal: CutoverJournal,
  phase: CutoverPhase,
  event: string,
  detail?: Record<string, unknown>,
) {
  const updated: CutoverJournal = {
    ...journal,
    phase,
    updated_at: new Date().toISOString(),
    history: [...journal.history, { at: new Date().toISOString(), event, ...(detail ? { detail } : {}) }],
    error: null,
  };
  writeJournal(updated);
  return updated;
}

function park(journal: CutoverJournal, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  writeJournal({
    ...journal,
    phase: "parked",
    updated_at: new Date().toISOString(),
    error: message,
    history: [...journal.history, { at: new Date().toISOString(), event: "application_cutover_parked", detail: { error: message } }],
  });
}

function assertJournalIdentity(journal: CutoverJournal, drainToken: string, captureToken: string) {
  if (journal.id !== cutoverId || journal.source_state_dir !== sourceStateDir
    || journal.target_state_dir !== targetStateDir || journal.drain_token !== drainToken
    || journal.capture_token !== captureToken || journal.plan_digest !== digestJson(journal.plan)) {
    throw new Error("Existing application cutover journal does not match this invocation.");
  }
}

function assertJournalReady(journal: CutoverJournal, phases: Set<CutoverPhase>) {
  if (!phases.has(journal.phase)) {
    throw new Error(`Application cutover ${journal.id} is ${journal.phase}; expected ${[...phases].join(" or ")}.`);
  }
  if (journal.plan_digest !== digestJson(journal.plan)) throw new Error("Application cutover plan digest drifted.");
}

function readJournal(): CutoverJournal {
  if (!existsSync(journalPath)) throw new Error(`Application cutover ${cutoverId} does not exist.`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as CutoverJournal;
  if (!journal || journal.schema_version !== 2 || journal.id !== cutoverId
    || !Array.isArray(journal.history) || !Array.isArray(journal.completed_effects)
    || !Array.isArray(journal.plan?.projects)) {
    throw new Error("Application cutover journal is malformed.");
  }
  return journal;
}

function sameOriginalFile(current: FileEvidence, original: FileEvidence) {
  if (current.exists !== original.exists) return false;
  if (!current.exists) return true;
  return current.sha256 === original.sha256
    && current.uid === original.uid
    && current.gid === original.gid
    && current.mode === original.mode;
}

function writeJournal(journal: CutoverJournal) {
  mkdirSync(journalDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${journalPath}.${process.pid}.next`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  syncFile(temporary);
  renameSync(temporary, journalPath);
  syncDirectory(journalDirectory);
}

function fileEvidence(path: string, includeDigest = true): FileEvidence {
  if (!existsSync(path)) {
    return { path, exists: false, inode: null, uid: null, gid: null, mode: null, byte_size: null, sha256: null };
  }
  const stat = lstatSync(path);
  return {
    path,
    exists: true,
    inode: stat.ino,
    uid: stat.uid,
    gid: stat.gid,
    mode: stat.mode & 0o7777,
    byte_size: stat.size,
    sha256: includeDigest && stat.isFile() ? sha256(readFileSync(path)) : null,
  };
}

function copyPrivateFile(source: string, destination: string) {
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Required provider file is missing: ${source}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}

function copyOptionalFile(
  source: string,
  destination: string,
  mode: number,
  transform?: (value: string) => string,
) {
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  if (transform) writeAtomic(destination, transform(readFileSync(source, "utf8")), mode);
  else {
    copyFileSync(source, destination);
    chmodSync(destination, mode);
  }
}

function ensureSymlink(target: string, path: string) {
  if (existsSync(path)) {
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) {
      throw new Error(`Provider shared path already exists with the wrong identity: ${path}`);
    }
    return;
  }
  symlinkSync(target, path);
}

function writeAtomic(path: string, contents: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.next`;
  writeFileSync(temporary, contents, { mode });
  chmodSync(temporary, mode);
  syncFile(temporary);
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncFile(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function syncDirectory(path: string) {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function digestJson(value: unknown) {
  return sha256(JSON.stringify(value));
}

function outermostPaths(paths: string[]) {
  const unique = [...new Set(paths.map((path) => resolve(path)))].sort((left, right) => left.length - right.length);
  return unique.filter((path, index) => !unique.some((candidate, candidateIndex) => {
    if (candidateIndex === index) return false;
    const suffix = relative(candidate, path);
    return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
  }));
}

function chownPath(path: string, user: string, group: string, recursive = false) {
  run(["chown", ...(recursive ? ["-R"] : []), `${user}:${group}`, path]);
}

function systemctl(...input: any[]) {
  let options: { allowFailure?: boolean } = {};
  if (input.length && typeof input[input.length - 1] === "object") options = input.pop();
  const result = run(["systemctl", ...input], { allowFailure: options.allowFailure });
  return result;
}

function run(args: string[], options: { allowFailure?: boolean } = {}) {
  const result = Bun.spawnSync({ cmd: args, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${args[0]} failed (${result.exitCode}): ${result.stderr.toString().trim().slice(0, 4000)}`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function parseOptions(args: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${token}.`);
    const name = token.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      parsed.set(name, "1");
    } else {
      parsed.set(name, next);
      index += 1;
    }
  }
  return parsed;
}

function requiredOption(optionsMap: Map<string, string>, name: string, pattern?: RegExp) {
  const value = optionsMap.get(name);
  if (!value || (pattern && !pattern.test(value))) throw new Error(`--${name} is required and invalid.`);
  return value;
}
