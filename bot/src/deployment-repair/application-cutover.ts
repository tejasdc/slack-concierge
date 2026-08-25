import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

export const APPLICATION_CUTOVER_SCHEMA_VERSION = 1 as const;
export const PROVIDER_ALLOWED_MODELS = [
  "claude-fable-5",
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
] as const;
export const PROVIDER_ALLOWED_ENVIRONMENT = [
  "CONCIERGE_DEPLOYMENT_RUN_ID",
  "CONCIERGE_DEPLOYMENT_WAKE_ID",
  "CONCIERGE_OWNER_INSTANCE_ID",
  "CONCIERGE_SESSION_ID",
  "CONCIERGE_SLACK_CHANNEL_ID",
  "CONCIERGE_SLACK_THREAD_TS",
  "CONCIERGE_TURN_ID",
  "CONCIERGE_TURN_KIND",
] as const;

export interface ApplicationCutoverChannelRow {
  slack_channel_id: string;
  slack_channel_name: string;
  code_path: string | null;
  vault_path: string;
  additional_paths: string;
}

export interface ApplicationCutoverSessionRow {
  id: number;
  slack_channel_id: string;
  provider_id: "codex" | "claude-code";
  agent_session_uuid: string | null;
}

export interface ApplicationCutoverProject {
  id: string;
  slackChannelIds: string[];
  sourcePath: string;
  stablePath: string;
  sourceAllowedPaths: string[];
  stableAllowedPaths: string[];
  socketPath: string;
  workerSocketPath: string;
  scratchPath: string;
  providerHome: string;
  providerStateRoot: string;
  authorityRoot: string;
  authorityStateRoot: string;
  sessions: Array<{
    databaseId: number;
    provider: "codex" | "claude-code";
    uuid: string;
  }>;
}

export interface ApplicationCutoverPlan {
  schema_version: typeof APPLICATION_CUTOVER_SCHEMA_VERSION;
  source_workspace_root: string;
  stable_workspace_root: string;
  projects: ApplicationCutoverProject[];
}

export interface ProviderProjectRegistryFile {
  schema_version: 1;
  projects: Array<{
    id: string;
    stable_path: string;
    socket_path: string;
    scratch_path: string;
    allowed_paths: string[];
  }>;
}

function managedPath(path: string, sourceRoot: string, stableRoot: string) {
  if (!isAbsolute(path)) throw new Error(`Managed project path must be absolute: ${path}`);
  if (path.includes(":") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Managed project path cannot be represented by the provider boundary: ${path}`);
  }
  const canonicalSource = resolve(sourceRoot);
  const canonicalPath = resolve(path);
  const suffix = relative(canonicalSource, canonicalPath);
  if (!suffix || suffix.startsWith("..") || isAbsolute(suffix)) {
    throw new Error(`Managed project path must be a child of ${canonicalSource}: ${canonicalPath}`);
  }
  return {
    source: canonicalPath,
    stable: join(resolve(stableRoot), suffix),
  };
}

function parsedPaths(value: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error(`${label} contains malformed JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some((path) => typeof path !== "string")) {
    throw new Error(`${label} must be a JSON string array.`);
  }
  return parsed as string[];
}

function projectId(sourcePath: string) {
  return `project-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 20)}`;
}

export function buildApplicationCutoverPlan(input: {
  channels: ApplicationCutoverChannelRow[];
  sessions: ApplicationCutoverSessionRow[];
  sourceWorkspaceRoot?: string;
  stableWorkspaceRoot?: string;
  providerRoot?: string;
  providerPrivateRoot?: string;
  providerAuthorityRoot?: string;
  providerAuthorityPrivateRoot?: string;
  providerScratchRoot?: string;
  providerRuntimeRoot?: string;
}) {
  const sourceWorkspaceRoot = resolve(input.sourceWorkspaceRoot || "/root/workspace");
  const stableWorkspaceRoot = resolve(input.stableWorkspaceRoot || "/var/lib/concierge-workspace");
  const providerRoot = resolve(input.providerRoot || "/var/lib/concierge-provider/projects");
  const providerPrivateRoot = resolve(input.providerPrivateRoot || "/var/lib/private/concierge-provider/projects");
  const authorityRoot = resolve(input.providerAuthorityRoot || "/var/lib/concierge-provider-authority");
  const authorityPrivateRoot = resolve(
    input.providerAuthorityPrivateRoot || "/var/lib/private/concierge-provider-authority",
  );
  const scratchRoot = resolve(input.providerScratchRoot || "/var/lib/concierge-provider-scratch");
  const runtimeRoot = resolve(input.providerRuntimeRoot || "/run/concierge-provider");
  const sessionsByChannel = new Map<string, ApplicationCutoverSessionRow[]>();
  for (const session of input.sessions) {
    const current = sessionsByChannel.get(session.slack_channel_id) || [];
    current.push(session);
    sessionsByChannel.set(session.slack_channel_id, current);
  }
  const projectsBySource = new Map<string, ApplicationCutoverProject>();
  for (const channel of input.channels) {
    const primary = managedPath(channel.code_path || channel.vault_path, sourceWorkspaceRoot, stableWorkspaceRoot);
    const requestedPaths = [
      channel.code_path,
      channel.vault_path,
      ...parsedPaths(channel.additional_paths, `Channel ${channel.slack_channel_id} additional_paths`),
    ].filter((value): value is string => Boolean(value));
    const mapped = requestedPaths.map((path) => managedPath(path, sourceWorkspaceRoot, stableWorkspaceRoot));
    let project = projectsBySource.get(primary.source);
    if (!project) {
      const id = projectId(primary.source);
      project = {
        id,
        slackChannelIds: [],
        sourcePath: primary.source,
        stablePath: primary.stable,
        sourceAllowedPaths: [],
        stableAllowedPaths: [],
        socketPath: join(runtimeRoot, id, "broker.sock"),
        workerSocketPath: join(runtimeRoot, id, "worker.sock"),
        scratchPath: join(scratchRoot, id),
        providerHome: join(providerRoot, id, "home"),
        providerStateRoot: join(providerPrivateRoot, id),
        authorityRoot: join(authorityRoot, id),
        authorityStateRoot: join(authorityPrivateRoot, id),
        sessions: [],
      };
      projectsBySource.set(primary.source, project);
    }
    project.slackChannelIds.push(channel.slack_channel_id);
    project.sourceAllowedPaths.push(...mapped.map((path) => path.source));
    project.stableAllowedPaths.push(...mapped.map((path) => path.stable));
    for (const session of sessionsByChannel.get(channel.slack_channel_id) || []) {
      if (!session.agent_session_uuid) continue;
      if (session.provider_id !== "codex" && session.provider_id !== "claude-code") {
        throw new Error(`Session ${session.id} uses unsupported provider ${session.provider_id}.`);
      }
      project.sessions.push({
        databaseId: session.id,
        provider: session.provider_id,
        uuid: session.agent_session_uuid,
      });
    }
  }
  const projects = [...projectsBySource.values()].map((project) => ({
    ...project,
    slackChannelIds: [...new Set(project.slackChannelIds)].sort(),
    sourceAllowedPaths: [...new Set(project.sourceAllowedPaths)].sort(),
    stableAllowedPaths: [...new Set(project.stableAllowedPaths)].sort(),
    sessions: [...new Map(project.sessions.map((session) => [
      `${session.provider}:${session.uuid}`,
      session,
    ])).values()].sort((left, right) => left.databaseId - right.databaseId),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (projects.length === 0) throw new Error("Application cutover requires at least one managed project.");
  for (const project of projects) {
    const overlapping = projects.filter((candidate) => {
      if (candidate.id === project.id) return false;
      const fromProject = relative(project.stablePath, candidate.stablePath);
      return fromProject === "" || (!fromProject.startsWith("..") && !isAbsolute(fromProject));
    });
    if (overlapping.length > 0) {
      throw new Error(`Managed provider roots overlap: ${project.stablePath} and ${overlapping[0].stablePath}.`);
    }
  }
  return {
    schema_version: APPLICATION_CUTOVER_SCHEMA_VERSION,
    source_workspace_root: sourceWorkspaceRoot,
    stable_workspace_root: stableWorkspaceRoot,
    projects,
  } satisfies ApplicationCutoverPlan;
}

export function providerProjectRegistry(plan: ApplicationCutoverPlan): ProviderProjectRegistryFile {
  return {
    schema_version: 1,
    projects: plan.projects.map((project) => ({
      id: project.id,
      stable_path: project.stablePath,
      socket_path: project.socketPath,
      scratch_path: project.scratchPath,
      allowed_paths: project.stableAllowedPaths,
    })),
  };
}

export function rewriteWorkspacePath(path: string, sourceRoot: string, stableRoot: string) {
  const canonicalSource = resolve(sourceRoot);
  const canonicalPath = resolve(path);
  const suffix = relative(canonicalSource, canonicalPath);
  if (suffix.startsWith("..") || isAbsolute(suffix)) return path;
  return suffix ? join(resolve(stableRoot), suffix) : resolve(stableRoot);
}

function systemdValue(value: string) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Systemd value contains a control character.");
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

function environment(name: string, value: string) {
  if (!/^[A-Z0-9_]+$/.test(name)) throw new Error(`Invalid environment name ${name}.`);
  return `Environment="${name}=${systemdValue(value)}"`;
}

function bindPath(source: string, destination = source, readOnly = false) {
  return `${readOnly ? "BindReadOnlyPaths" : "BindPaths"}="${systemdValue(source)}:${systemdValue(destination)}"`;
}

export function renderProviderBrokerDropIn(project: ApplicationCutoverProject) {
  return [
    "[Service]",
    environment("CONCIERGE_PROVIDER_PROJECT_ID", project.id),
    environment("CONCIERGE_PROVIDER_PROJECT_ROOT", project.stablePath),
    environment("CONCIERGE_PROVIDER_ALLOWED_ROOTS", project.stableAllowedPaths.join(":")),
    environment("CONCIERGE_PROVIDER_ALLOWED_MODELS", PROVIDER_ALLOWED_MODELS.join(",")),
    environment("CONCIERGE_PROVIDER_ALLOWED_ENVIRONMENT", PROVIDER_ALLOWED_ENVIRONMENT.join(",")),
    environment("CONCIERGE_PROVIDER_AUTHORITY_ROOT", project.authorityRoot),
    environment("CONCIERGE_PROVIDER_WORKER_SOCKET", project.workerSocketPath),
    "",
  ].join("\n");
}

export function renderProviderWorkerDropIn(project: ApplicationCutoverProject) {
  const binds = project.sourceAllowedPaths.flatMap((sourcePath, index) => [
    bindPath(sourcePath, project.stableAllowedPaths[index]),
    bindPath(sourcePath),
  ]);
  return [
    "[Service]",
    environment("HOME", project.providerHome),
    environment("CONCIERGE_PROVIDER_PROJECT_ROOT", project.stablePath),
    environment("CONCIERGE_PROVIDER_ALLOWED_ROOTS", project.stableAllowedPaths.join(":")),
    environment("CONCIERGE_PROVIDER_ALLOWED_MODELS", PROVIDER_ALLOWED_MODELS.join(",")),
    environment("CONCIERGE_PROVIDER_ALLOWED_ENVIRONMENT", PROVIDER_ALLOWED_ENVIRONMENT.join(",")),
    environment("CONCIERGE_PROVIDER_CODEX_BIN", "/usr/local/lib/concierge-deployment/codex"),
    environment("CONCIERGE_PROVIDER_CLAUDE_BIN", "/usr/local/lib/concierge-deployment/claude"),
    environment("CONCIERGE_PROVIDER_WORKER_SOCKET", project.workerSocketPath),
    bindPath(project.scratchPath),
    ...binds,
    "ReadOnlyPaths=/var/lib/concierge-provider/shared",
    "",
  ].join("\n");
}

export function renderContainedBotDropIn() {
  return [
    "[Service]",
    "User=concierge-bot",
    "Group=concierge-bot",
    "WorkingDirectory=/var/lib/concierge-workspace/slack-concierge/bot",
    "ExecStartPre=",
    "ExecStartPre=/usr/bin/test -x /usr/bin/node",
    "ExecStartPre=/usr/bin/test -x /usr/bin/python3",
    "Environment=HOME=/var/lib/concierge-bot",
    "Environment=CONCIERGE_STATE_DIR=/var/lib/concierge-bot/state",
    "Environment=CONCIERGE_CONFIG_PATH=/run/credentials/concierge-bot.service/slack_config",
    "Environment=CONCIERGE_REPOSITORY_ROOT=/var/lib/concierge-workspace/slack-concierge",
    "Environment=CONCIERGE_PROVIDER_BROKER_ENABLED=1",
    "Environment=CONCIERGE_PROVIDER_PROJECTS_PATH=/var/lib/concierge-bot/provider-projects.json",
    "LoadCredential=",
    "LoadCredential=slack_config:/root/.config/concierge/slack.toml",
    "LoadCredential=capture_queue:/etc/concierge/capture-queue.token",
    "NoNewPrivileges=yes",
    "PrivateTmp=yes",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=tmpfs",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelLogs=yes",
    "ProtectControlGroups=yes",
    "ProtectClock=yes",
    "ProtectHostname=yes",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "CapabilityBoundingSet=",
    "AmbientCapabilities=",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "TemporaryFileSystem=/var/lib/concierge-workspace:ro",
    bindPath("/root/workspace", "/var/lib/concierge-workspace"),
    bindPath("/root/workspace"),
    "ReadWritePaths=/var/lib/concierge-bot /var/lib/concierge-provider-scratch /var/lib/concierge-workspace",
    "InaccessiblePaths=/root/.codex /root/.claude /root/.config/concierge /var/lib/concierge-provider /var/lib/concierge-provider-authority /root/.local/state/concierge-deployment",
    "",
  ].join("\n");
}

export function claudeProjectDirectory(projectPath: string) {
  if (!isAbsolute(projectPath)) throw new Error("Claude project path must be absolute.");
  return projectPath.replaceAll(/[^A-Za-z0-9_-]/g, "-");
}
