#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_SANDBOX_CONFIG_ROOT = "/etc/concierge/sandbox";
export const DEFAULT_SANDBOX_STATE_ROOT = "/var/lib/slack-concierge-sandbox";
export const DEFAULT_SANDBOX_BROWSER_ROOT = "/root/.local/state/concierge-sandbox/browser";
const SLACK_API_ROOT = "https://slack.com/api";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

type JsonRecord = Record<string, unknown>;
export type SlackRequester = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SandboxLaneDefinition = {
  id: string;
  app_display_name: string;
  bot_display_name: string;
  browser_namespace: string;
  channels: { core: string; project: string; capture: string };
};

export type SandboxTopology = {
  schema_version: 1;
  workspace_domain: string;
  source_manifest: string;
  lanes: SandboxLaneDefinition[];
};

export type WorkspaceConfigurationCredential = {
  schema_version: 1;
  team_id: string;
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
};

export type LaneSecrets = {
  schema_version: 1;
  app_id: string;
  team_id: string;
  app_token: string;
  bot_token: string;
  user_token: string;
  signing_secret: string;
  client_id: string;
  client_secret: string;
};

export type LaneFixtures = {
  schema_version: 1;
  lane_id: string;
  installer_user_id: string;
  dm_channel_id: string;
  channels: {
    core: { id: string; name: string };
    project: { id: string; name: string };
    capture: { id: string; name: string };
  };
  browser: {
    namespace: string;
    profile_path: string;
  };
};

export type LaneProvisionedIdentity = {
  schema_version: 1;
  lane_id: string;
  team_id: string;
  app_id: string;
  bot_user_id: string;
  bot_id: string;
  manifest_digest: string;
};

export type LaneFixtureIdentities = LaneFixtures & Omit<LaneProvisionedIdentity, "schema_version" | "lane_id">;

type LaneRegistryEntry = {
  lane_id: string;
  app_display_name: string;
  bot_display_name: string;
  app_id: string | null;
  source_manifest_digest: string;
  manifest_contract_digest: string;
  expected_manifest_digest: string;
  verified_manifest_digest: string | null;
  status: "unprovisioned" | "creating" | "ambiguous" | "authorization_required" | "installed";
  permissions_updated: boolean;
  oauth_authorize_url?: string;
  last_error_code?: string;
};

type LaneRegistry = {
  schema_version: 1;
  workspace_domain: string;
  team_id: string;
  source_manifest_digest: string;
  manifest_contract_digest: string;
  lanes: LaneRegistryEntry[];
};

export class SandboxProvisioningError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || (pattern && !pattern.test(value))) {
    throw new SandboxProvisioningError("invalid_configuration", `Invalid ${field}`);
  }
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SandboxProvisioningError("invalid_configuration", `Invalid ${field}`);
  }
  return value;
}

function requireExactKeys(value: JsonRecord, expectedKeys: string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SandboxProvisioningError("invalid_configuration", `Invalid ${field} keys`);
  }
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedJson(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedManifest(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new SandboxProvisioningError("invalid_manifest", "Manifest must be a JSON object");
  const normalized = structuredClone(value);
  delete normalized._metadata;
  if (isRecord(normalized.features)) {
    if (isRecord(normalized.features.agent_view)
        && Array.isArray(normalized.features.agent_view.suggested_prompts)
        && normalized.features.agent_view.suggested_prompts.length === 0) {
      delete normalized.features.agent_view.suggested_prompts;
    }
    if (Array.isArray(normalized.features.shortcuts)) {
      normalized.features.shortcuts.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    }
  }
  if (isRecord(normalized.oauth_config) && normalized.oauth_config.pkce_enabled === false) {
    delete normalized.oauth_config.pkce_enabled;
  }
  if (isRecord(normalized.settings) && normalized.settings.is_mcp_enabled === false) {
    delete normalized.settings.is_mcp_enabled;
  }
  return normalized;
}

export function manifestDigest(value: unknown): string {
  return sha256(canonicalJson(normalizedManifest(value)));
}

export function manifestContractDigest(value: unknown): string {
  const manifest = normalizedManifest(value);
  if (isRecord(manifest.display_information)) delete manifest.display_information.name;
  if (isRecord(manifest.features) && isRecord(manifest.features.bot_user)) {
    delete manifest.features.bot_user.display_name;
  }
  return sha256(canonicalJson(manifest));
}

export function manifestForLane(source: unknown, lane: SandboxLaneDefinition): JsonRecord {
  const manifest = normalizedManifest(source);
  if (!isRecord(manifest.display_information)) {
    throw new SandboxProvisioningError("invalid_manifest", "Manifest is missing display_information");
  }
  if (!isRecord(manifest.features) || !isRecord(manifest.features.bot_user)) {
    throw new SandboxProvisioningError("invalid_manifest", "Manifest is missing features.bot_user");
  }
  manifest.display_information.name = lane.app_display_name;
  manifest.features.bot_user.display_name = lane.bot_display_name;
  return manifest;
}

export function loadSandboxTopology(path: string): SandboxTopology {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.schema_version !== 1 || typeof parsed.workspace_domain !== "string"
      || typeof parsed.source_manifest !== "string" || !Array.isArray(parsed.lanes) || parsed.lanes.length !== 4) {
    throw new SandboxProvisioningError("invalid_topology", "Sandbox topology must define exactly four version-1 lanes");
  }
  const seen = new Set<string>();
  const lanes = parsed.lanes.map((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.channels)) {
      throw new SandboxProvisioningError("invalid_topology", `Lane ${index + 1} is malformed`);
    }
    const lane: SandboxLaneDefinition = {
      id: requireString(raw.id, `lanes[${index}].id`, /^lane-[1-4]$/),
      app_display_name: requireString(raw.app_display_name, `lanes[${index}].app_display_name`),
      bot_display_name: requireString(raw.bot_display_name, `lanes[${index}].bot_display_name`, /^[a-z0-9-]+$/),
      browser_namespace: requireString(raw.browser_namespace, `lanes[${index}].browser_namespace`, /^[a-z0-9-]+$/),
      channels: {
        core: requireString(raw.channels.core, `lanes[${index}].channels.core`, /^[a-z0-9-]+$/),
        project: requireString(raw.channels.project, `lanes[${index}].channels.project`, /^[a-z0-9-]+$/),
        capture: requireString(raw.channels.capture, `lanes[${index}].channels.capture`, /^[a-z0-9-]+$/),
      },
    };
    for (const unique of [lane.id, lane.app_display_name, lane.bot_display_name, lane.browser_namespace,
      lane.channels.core, lane.channels.project, lane.channels.capture]) {
      if (seen.has(unique)) throw new SandboxProvisioningError("invalid_topology", `Duplicate sandbox identity: ${unique}`);
      seen.add(unique);
    }
    return lane;
  });
  return {
    schema_version: 1,
    workspace_domain: parsed.workspace_domain,
    source_manifest: parsed.source_manifest,
    lanes,
  };
}

function ensurePrivateDirectory(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new SandboxProvisioningError("unsafe_secret_path", `${path} must be an owner-only real directory`);
  }
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new SandboxProvisioningError("unsafe_secret_path", `${path} must be an owner-only regular file`);
  }
}

export function atomicWritePrivate(path: string, content: string): void {
  ensurePrivateDirectory(dirname(path));
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  atomicWritePrivate(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readPrivateJson(path: string): unknown {
  assertPrivateFile(path);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseWorkspaceCredential(value: unknown): WorkspaceConfigurationCredential {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new SandboxProvisioningError("invalid_configuration_credential", "Invalid workspace configuration credential file");
  }
  return {
    schema_version: 1,
    team_id: requireString(value.team_id, "configuration team_id", /^T[A-Z0-9]+$/),
    user_id: requireString(value.user_id, "configuration user_id", /^U[A-Z0-9]+$/),
    access_token: requireString(value.access_token, "configuration access_token", /^xoxe\.xoxp-/),
    refresh_token: requireString(value.refresh_token, "configuration refresh_token", /^xoxe-/),
    expires_at_ms: requireInteger(value.expires_at_ms, "configuration expires_at_ms"),
  };
}

export function parseLaneSecrets(value: unknown): LaneSecrets {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new SandboxProvisioningError("invalid_lane_secrets", "Invalid lane secret bundle");
  }
  return {
    schema_version: 1,
    app_id: requireString(value.app_id, "lane app_id", /^A[A-Z0-9]+$/),
    team_id: requireString(value.team_id, "lane team_id", /^T[A-Z0-9]+$/),
    app_token: requireString(value.app_token, "lane app_token", /^xapp-/),
    bot_token: requireString(value.bot_token, "lane bot_token", /^xoxb-/),
    user_token: requireString(value.user_token, "lane user_token", /^xoxp-/),
    signing_secret: requireString(value.signing_secret, "lane signing_secret", /^[a-f0-9]{32,}$/i),
    client_id: requireString(value.client_id, "lane client_id", /^\d+\.\d+$/),
    client_secret: requireString(value.client_secret, "lane client_secret", /^[a-zA-Z0-9]{20,}$/),
  };
}

function slackToml(secrets: LaneSecrets): string {
  return [
    "schema_version = 1",
    `app_id = ${JSON.stringify(secrets.app_id)}`,
    `team_id = ${JSON.stringify(secrets.team_id)}`,
    `app_token = ${JSON.stringify(secrets.app_token)}`,
    `bot_token = ${JSON.stringify(secrets.bot_token)}`,
    `user_token = ${JSON.stringify(secrets.user_token)}`,
    `signing_secret = ${JSON.stringify(secrets.signing_secret)}`,
    `client_id = ${JSON.stringify(secrets.client_id)}`,
    `client_secret = ${JSON.stringify(secrets.client_secret)}`,
    "",
  ].join("\n");
}

export function sandboxProvisioningPaths(
  configRoot = DEFAULT_SANDBOX_CONFIG_ROOT,
  stateRoot = DEFAULT_SANDBOX_STATE_ROOT,
  browserRoot = DEFAULT_SANDBOX_BROWSER_ROOT,
) {
  return {
    configRoot,
    stateRoot,
    workspaceCredential: join(configRoot, "workspace-configuration.json"),
    registry: join(configRoot, "lane-registry.json"),
    laneDirectory: (laneId: string) => join(configRoot, "lanes", laneId),
    laneSlackConfig: (laneId: string) => join(configRoot, "lanes", laneId, "slack.toml"),
    laneIdentity: (laneId: string) => join(configRoot, "lanes", laneId, "identity.json"),
    laneFixtures: (laneId: string) => join(configRoot, "lanes", laneId, "fixtures.json"),
    laneCreateCredentials: (laneId: string) => join(configRoot, "lanes", laneId, "manifest-create-credentials.json"),
    laneBrowserProfile: (laneId: string) => join(browserRoot, laneId),
    laneRunRoot: (laneId: string, runId: string) => join(stateRoot, "lanes", laneId, "runs", runId),
  };
}

export function importWorkspaceCredential(sourcePath: string, destinationPath: string): WorkspaceConfigurationCredential {
  assertPrivateFile(sourcePath);
  const credential = parseWorkspaceCredential(JSON.parse(readFileSync(sourcePath, "utf8")));
  writePrivateJson(destinationPath, credential);
  return credential;
}

export function importLaneSecrets(
  lane: SandboxLaneDefinition,
  sourcePath: string,
  configRoot = DEFAULT_SANDBOX_CONFIG_ROOT,
): LaneSecrets {
  assertPrivateFile(sourcePath);
  const secrets = parseLaneSecrets(JSON.parse(readFileSync(sourcePath, "utf8")));
  const paths = sandboxProvisioningPaths(configRoot);
  const registry = existsSync(paths.registry) ? parseRegistry(readPrivateJson(paths.registry)) : null;
  const registered = registry?.lanes.find((entry) => entry.lane_id === lane.id);
  if (!registered?.app_id || registered.app_id !== secrets.app_id || (registry && registry.team_id !== secrets.team_id)) {
    throw new SandboxProvisioningError("lane_identity_mismatch", `Secret bundle does not match registered ${lane.id}`);
  }
  const created = parseStoredCreateCredentials(readPrivateJson(paths.laneCreateCredentials(lane.id)));
  if (created.app_id !== secrets.app_id || created.team_id !== secrets.team_id
      || created.client_id !== secrets.client_id || created.client_secret !== secrets.client_secret
      || created.signing_secret !== secrets.signing_secret) {
    throw new SandboxProvisioningError("lane_identity_mismatch", `Secret bundle does not match ${lane.id} create credentials`);
  }
  atomicWritePrivate(paths.laneSlackConfig(lane.id), slackToml(secrets));
  if (registry && registered) {
    registered.status = "installed";
    registered.permissions_updated = false;
    writePrivateJson(paths.registry, registry);
  }
  return secrets;
}

async function slackApi(
  method: string,
  bearerToken: string | null,
  body: JsonRecord,
  requester: SlackRequester,
  mutating: boolean,
): Promise<JsonRecord> {
  let response: Response;
  try {
    response = await requester(`${SLACK_API_ROOT}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SandboxProvisioningError(
      mutating ? `${method}_outcome_unknown` : `${method}_unavailable`,
      `${method} did not return a classifiable Slack response`,
    );
  }
  if (!response.ok) {
    try {
      const rejected = await response.json();
      if (isRecord(rejected) && rejected.ok === false && typeof rejected.error === "string") {
        throw new SandboxProvisioningError(`${method}_rejected`, `${method} rejected the request: ${rejected.error}`);
      }
    } catch (error) {
      if (error instanceof SandboxProvisioningError) throw error;
    }
    throw new SandboxProvisioningError(
      mutating ? `${method}_outcome_unknown` : `${method}_http_error`,
      `${method} returned HTTP ${response.status}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new SandboxProvisioningError(
      mutating ? `${method}_outcome_unknown` : `${method}_invalid_response`,
      `${method} returned invalid JSON`,
    );
  }
  if (!isRecord(payload) || payload.ok !== true) {
    const slackCode = isRecord(payload) && typeof payload.error === "string" ? payload.error : "unknown_error";
    throw new SandboxProvisioningError(`${method}_rejected`, `${method} rejected the request: ${slackCode}`);
  }
  return payload;
}

export async function rotateWorkspaceCredential(
  credentialPath: string,
  requester: SlackRequester = fetch,
  now = Date.now(),
): Promise<WorkspaceConfigurationCredential> {
  const current = parseWorkspaceCredential(readPrivateJson(credentialPath));
  const payload = await slackApi("tooling.tokens.rotate", null, { refresh_token: current.refresh_token }, requester, true);
  const rotated: WorkspaceConfigurationCredential = {
    schema_version: 1,
    team_id: requireString(payload.team_id, "rotated team_id", /^T[A-Z0-9]+$/),
    user_id: requireString(payload.user_id, "rotated user_id", /^U[A-Z0-9]+$/),
    access_token: requireString(payload.token, "rotated access token", /^xoxe\.xoxp-/),
    refresh_token: requireString(payload.refresh_token, "rotated refresh token", /^xoxe-/),
    expires_at_ms: requireInteger(payload.exp, "rotated expiry") * 1000,
  };
  if (rotated.team_id !== current.team_id || rotated.user_id !== current.user_id || rotated.expires_at_ms <= now) {
    throw new SandboxProvisioningError("configuration_identity_mismatch", "Rotated credential changed workspace/user identity or is already expired");
  }
  writePrivateJson(credentialPath, rotated);
  return rotated;
}

async function freshWorkspaceCredential(
  credentialPath: string,
  requester: SlackRequester,
  now: number,
): Promise<WorkspaceConfigurationCredential> {
  const current = parseWorkspaceCredential(readPrivateJson(credentialPath));
  if (current.expires_at_ms > now + ACCESS_TOKEN_REFRESH_WINDOW_MS) return current;
  return rotateWorkspaceCredential(credentialPath, requester, now);
}

function parseRegistry(value: unknown): LaneRegistry {
  if (!isRecord(value) || value.schema_version !== 1 || !Array.isArray(value.lanes)) {
    throw new SandboxProvisioningError("invalid_lane_registry", "Invalid lane registry");
  }
  return value as unknown as LaneRegistry;
}

function initialRegistry(topology: SandboxTopology, teamId: string, sourceManifest: unknown): LaneRegistry {
  const sourceDigest = manifestDigest(sourceManifest);
  const contractDigest = manifestContractDigest(sourceManifest);
  return {
    schema_version: 1,
    workspace_domain: topology.workspace_domain,
    team_id: teamId,
    source_manifest_digest: sourceDigest,
    manifest_contract_digest: contractDigest,
    lanes: topology.lanes.map((lane) => ({
      lane_id: lane.id,
      app_display_name: lane.app_display_name,
      bot_display_name: lane.bot_display_name,
      app_id: null,
      source_manifest_digest: sourceDigest,
      manifest_contract_digest: contractDigest,
      expected_manifest_digest: manifestDigest(manifestForLane(sourceManifest, lane)),
      verified_manifest_digest: null,
      status: "unprovisioned",
      permissions_updated: false,
    })),
  };
}

function reconcileRegistry(registry: LaneRegistry, topology: SandboxTopology, teamId: string, sourceManifest: unknown): LaneRegistry {
  if (registry.team_id !== teamId || registry.workspace_domain !== topology.workspace_domain) {
    throw new SandboxProvisioningError("workspace_identity_mismatch", "Lane registry belongs to a different sandbox workspace");
  }
  const sourceDigest = manifestDigest(sourceManifest);
  const contractDigest = manifestContractDigest(sourceManifest);
  const previous = new Map(registry.lanes.map((lane) => [lane.lane_id, lane]));
  return {
    ...registry,
    source_manifest_digest: sourceDigest,
    manifest_contract_digest: contractDigest,
    lanes: topology.lanes.map((lane) => {
      const old = previous.get(lane.id);
      if (!old) throw new SandboxProvisioningError("invalid_lane_registry", `Registry is missing ${lane.id}`);
      const expectedManifestDigest = manifestDigest(manifestForLane(sourceManifest, lane));
      return {
        ...old,
        app_display_name: lane.app_display_name,
        bot_display_name: lane.bot_display_name,
        source_manifest_digest: sourceDigest,
        manifest_contract_digest: contractDigest,
        expected_manifest_digest: expectedManifestDigest,
        verified_manifest_digest: old.expected_manifest_digest === expectedManifestDigest
          ? old.verified_manifest_digest
          : null,
      };
    }),
  };
}

function parseCreateCredentials(value: unknown): { client_id: string; client_secret: string; signing_secret: string } {
  if (!isRecord(value)) throw new SandboxProvisioningError("invalid_manifest_response", "Manifest create omitted credentials");
  return {
    client_id: requireString(value.client_id, "created client_id", /^\d+\.\d+$/),
    client_secret: requireString(value.client_secret, "created client_secret", /^[a-zA-Z0-9]{20,}$/),
    signing_secret: requireString(value.signing_secret, "created signing_secret", /^[a-f0-9]{32,}$/i),
  };
}

function parseStoredCreateCredentials(value: unknown): {
  schema_version: 1;
  app_id: string;
  team_id: string;
  client_id: string;
  client_secret: string;
  signing_secret: string;
} {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new SandboxProvisioningError("invalid_manifest_response", "Invalid stored manifest create credentials");
  }
  requireExactKeys(value, ["schema_version", "app_id", "team_id", "client_id", "client_secret", "signing_secret"],
    "stored manifest create credentials");
  return {
    schema_version: 1,
    app_id: requireString(value.app_id, "stored app_id", /^A[A-Z0-9]+$/),
    team_id: requireString(value.team_id, "stored team_id", /^T[A-Z0-9]+$/),
    ...parseCreateCredentials(value),
  };
}

export type ManifestApplyResult = {
  source_manifest_digest: string;
  manifest_contract_digest: string;
  lanes: Array<{
    lane_id: string;
    app_id: string;
    expected_manifest_digest: string;
    verified_manifest_digest: string;
    status: LaneRegistryEntry["status"];
    permissions_updated: boolean;
    oauth_authorize_url?: string;
    app_settings_url: string;
    attended_actions: string[];
  }>;
};

export async function applySandboxManifests(options: {
  topology: SandboxTopology;
  sourceManifest: unknown;
  configRoot?: string;
  requester?: SlackRequester;
  now?: number;
}): Promise<ManifestApplyResult> {
  const configRoot = options.configRoot || DEFAULT_SANDBOX_CONFIG_ROOT;
  const requester = options.requester || fetch;
  const now = options.now ?? Date.now();
  const paths = sandboxProvisioningPaths(configRoot);
  ensurePrivateDirectory(configRoot);
  const credential = await freshWorkspaceCredential(paths.workspaceCredential, requester, now);
  let registry = existsSync(paths.registry)
    ? reconcileRegistry(parseRegistry(readPrivateJson(paths.registry)), options.topology, credential.team_id, options.sourceManifest)
    : initialRegistry(options.topology, credential.team_id, options.sourceManifest);
  writePrivateJson(paths.registry, registry);

  for (const lane of options.topology.lanes) {
    const entry = registry.lanes.find((candidate) => candidate.lane_id === lane.id)!;
    if (entry.status === "creating" || entry.status === "ambiguous") {
      throw new SandboxProvisioningError("ambiguous_app_creation", `${lane.id} needs attended recovery before another create attempt`);
    }
    const expectedManifest = manifestForLane(options.sourceManifest, lane);
    await slackApi("apps.manifest.validate", credential.access_token, {
      manifest: JSON.stringify(expectedManifest),
      team_id: credential.team_id,
    }, requester, false);
    if (!entry.app_id) {
      entry.status = "creating";
      delete entry.last_error_code;
      writePrivateJson(paths.registry, registry);
      try {
        const created = await slackApi("apps.manifest.create", credential.access_token, {
          manifest: JSON.stringify(expectedManifest),
          team_id: credential.team_id,
        }, requester, true);
        const appId = requireString(created.app_id, "created app_id", /^A[A-Z0-9]+$/);
        entry.app_id = appId;
        writePrivateJson(paths.registry, registry);
        const createCredentials = parseCreateCredentials(created.credentials);
        writePrivateJson(paths.laneCreateCredentials(lane.id), {
          schema_version: 1,
          app_id: appId,
          team_id: credential.team_id,
          ...createCredentials,
        });
        entry.oauth_authorize_url = requireString(created.oauth_authorize_url, "OAuth authorize URL", /^https:\/\//);
        entry.status = "authorization_required";
      } catch (error) {
        if (error instanceof SandboxProvisioningError && error.code === "apps.manifest.create_rejected") {
          entry.status = "unprovisioned";
        } else {
          entry.status = "ambiguous";
        }
        entry.last_error_code = error instanceof SandboxProvisioningError ? error.code : "unknown_error";
        writePrivateJson(paths.registry, registry);
        throw error;
      }
      writePrivateJson(paths.registry, registry);
      const exportedCreated = await slackApi("apps.manifest.export", credential.access_token, { app_id: entry.app_id }, requester, false);
      if (manifestDigest(exportedCreated.manifest) !== entry.expected_manifest_digest
          || manifestContractDigest(exportedCreated.manifest) !== entry.manifest_contract_digest) {
        throw new SandboxProvisioningError("manifest_digest_mismatch", `${lane.id} created manifest does not match the tracked contract`);
      }
      entry.verified_manifest_digest = entry.expected_manifest_digest;
      writePrivateJson(paths.registry, registry);
      continue;
    }
    const exportedBefore = await slackApi("apps.manifest.export", credential.access_token, { app_id: entry.app_id }, requester, false);
    if (manifestDigest(exportedBefore.manifest) !== entry.expected_manifest_digest) {
      const updated = await slackApi("apps.manifest.update", credential.access_token, {
        app_id: entry.app_id,
        manifest: JSON.stringify(expectedManifest),
      }, requester, true);
      entry.permissions_updated = updated.permissions_updated === true;
      if (entry.permissions_updated) entry.status = "authorization_required";
    }
    const exportedAfter = await slackApi("apps.manifest.export", credential.access_token, { app_id: entry.app_id }, requester, false);
    if (manifestDigest(exportedAfter.manifest) !== entry.expected_manifest_digest
        || manifestContractDigest(exportedAfter.manifest) !== entry.manifest_contract_digest) {
      throw new SandboxProvisioningError("manifest_digest_mismatch", `${lane.id} export does not match the tracked manifest contract`);
    }
    entry.verified_manifest_digest = entry.expected_manifest_digest;
    writePrivateJson(paths.registry, registry);
  }

  return {
    source_manifest_digest: registry.source_manifest_digest,
    manifest_contract_digest: registry.manifest_contract_digest,
    lanes: registry.lanes.map((entry) => ({
      lane_id: entry.lane_id,
      app_id: requireString(entry.app_id, `${entry.lane_id} app_id`, /^A[A-Z0-9]+$/),
      expected_manifest_digest: entry.expected_manifest_digest,
      verified_manifest_digest: requireString(entry.verified_manifest_digest, `${entry.lane_id} verified manifest digest`, /^[a-f0-9]{64}$/),
      status: entry.status,
      permissions_updated: entry.permissions_updated,
      oauth_authorize_url: entry.oauth_authorize_url,
      app_settings_url: `https://api.slack.com/apps/${entry.app_id}/general`,
      attended_actions: entry.status === "authorization_required"
        ? ["authorize OAuth installation", "generate an app-level connections:write token", "import the complete lane secret bundle"]
        : [],
    })),
  };
}

async function listPublicChannels(token: string, requester: SlackRequester): Promise<Map<string, string>> {
  const channels = new Map<string, string>();
  let cursor = "";
  do {
    const response = await slackApi("conversations.list", token, {
      exclude_archived: true,
      limit: 200,
      types: "public_channel",
      ...(cursor ? { cursor } : {}),
    }, requester, false);
    if (!Array.isArray(response.channels)) throw new SandboxProvisioningError("invalid_fixture_response", "conversations.list omitted channels");
    for (const raw of response.channels) {
      if (isRecord(raw) && typeof raw.name === "string" && typeof raw.id === "string") channels.set(raw.name, raw.id);
    }
    cursor = isRecord(response.response_metadata) && typeof response.response_metadata.next_cursor === "string"
      ? response.response_metadata.next_cursor
      : "";
  } while (cursor);
  return channels;
}

export async function provisionLaneFixtures(options: {
  lane: SandboxLaneDefinition;
  configRoot?: string;
  stateRoot?: string;
  browserRoot?: string;
  requester?: SlackRequester;
}): Promise<LaneFixtureIdentities> {
  const configRoot = options.configRoot || DEFAULT_SANDBOX_CONFIG_ROOT;
  const stateRoot = options.stateRoot || DEFAULT_SANDBOX_STATE_ROOT;
  const requester = options.requester || fetch;
  const paths = sandboxProvisioningPaths(configRoot, stateRoot, options.browserRoot || DEFAULT_SANDBOX_BROWSER_ROOT);
  const secrets = parseLaneSecrets(Bun.TOML.parse(readFileSync(paths.laneSlackConfig(options.lane.id), "utf8")));
  const registry = parseRegistry(readPrivateJson(paths.registry));
  const registered = registry.lanes.find((entry) => entry.lane_id === options.lane.id);
  if (!registered || registered.app_id !== secrets.app_id || registry.team_id !== secrets.team_id
      || registered.verified_manifest_digest !== registered.expected_manifest_digest) {
    throw new SandboxProvisioningError("lane_identity_mismatch", `${options.lane.id} is not registered to a verified manifest and these Slack identities`);
  }
  const botIdentity = await slackApi("auth.test", secrets.bot_token, {}, requester, false);
  const userIdentity = await slackApi("auth.test", secrets.user_token, {}, requester, false);
  const teamId = requireString(botIdentity.team_id, "bot auth team_id", /^T[A-Z0-9]+$/);
  const installerUserId = requireString(userIdentity.user_id, "user auth user_id", /^U[A-Z0-9]+$/);
  const botUserId = requireString(botIdentity.user_id, "bot auth user_id", /^U[A-Z0-9]+$/);
  const botId = requireString(botIdentity.bot_id, "bot auth bot_id", /^B[A-Z0-9]+$/);
  if (teamId !== secrets.team_id || userIdentity.team_id !== secrets.team_id || installerUserId === botUserId) {
    throw new SandboxProvisioningError("lane_identity_mismatch", `${options.lane.id} tokens do not identify one sandbox installation`);
  }
  await slackApi("apps.connections.open", secrets.app_token, {}, requester, false);

  const knownChannels = await listPublicChannels(secrets.bot_token, requester);
  const channels = {} as LaneFixtureIdentities["channels"];
  for (const role of ["core", "project", "capture"] as const) {
    const name = options.lane.channels[role];
    let id = knownChannels.get(name);
    if (!id) {
      const created = await slackApi("conversations.create", secrets.bot_token, { name, is_private: false }, requester, true);
      id = isRecord(created.channel) ? requireString(created.channel.id, `${name} channel id`, /^C[A-Z0-9]+$/) : "";
    }
    channels[role] = { id: requireString(id, `${name} channel id`, /^C[A-Z0-9]+$/), name };
  }
  const opened = await slackApi("conversations.open", secrets.bot_token, { users: installerUserId }, requester, true);
  const dmId = isRecord(opened.channel) ? requireString(opened.channel.id, "lane DM id", /^D[A-Z0-9]+$/) : "";
  const profilePath = paths.laneBrowserProfile(options.lane.id);
  ensurePrivateDirectory(profilePath);
  const provisionedIdentity: LaneProvisionedIdentity = {
    schema_version: 1,
    lane_id: options.lane.id,
    team_id: secrets.team_id,
    app_id: secrets.app_id,
    bot_user_id: botUserId,
    bot_id: botId,
    manifest_digest: registered.verified_manifest_digest,
  };
  writePrivateJson(paths.laneIdentity(options.lane.id), provisionedIdentity);
  const fixtures: LaneFixtures = {
    schema_version: 1,
    lane_id: options.lane.id,
    installer_user_id: installerUserId,
    dm_channel_id: dmId,
    channels,
    browser: { namespace: options.lane.browser_namespace, profile_path: profilePath },
  };
  writePrivateJson(paths.laneFixtures(options.lane.id), fixtures);
  return { ...fixtures, ...provisionedIdentity, lane_id: options.lane.id };
}

export function loadLaneProvisionedIdentity(path: string): LaneProvisionedIdentity {
  const value = readPrivateJson(path);
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new SandboxProvisioningError("invalid_lane_identity", "Invalid lane identity file");
  }
  requireExactKeys(value, [
    "schema_version", "lane_id", "team_id", "app_id", "bot_user_id", "bot_id", "manifest_digest",
  ], "lane identity");
  return {
    schema_version: 1,
    lane_id: requireString(value.lane_id, "identity lane_id", /^lane-[1-4]$/),
    team_id: requireString(value.team_id, "identity team_id", /^T[A-Z0-9]+$/),
    app_id: requireString(value.app_id, "identity app_id", /^A[A-Z0-9]+$/),
    bot_user_id: requireString(value.bot_user_id, "identity bot_user_id", /^U[A-Z0-9]+$/),
    bot_id: requireString(value.bot_id, "identity bot_id", /^B[A-Z0-9]+$/),
    manifest_digest: requireString(value.manifest_digest, "identity manifest_digest", /^[a-f0-9]{64}$/),
  };
}

export function loadLaneFixtures(path: string): LaneFixtures {
  const value = readPrivateJson(path);
  if (!isRecord(value) || value.schema_version !== 1 || !isRecord(value.channels) || !isRecord(value.browser)) {
    throw new SandboxProvisioningError("invalid_lane_fixtures", "Invalid lane fixtures file");
  }
  requireExactKeys(value, [
    "schema_version", "lane_id", "installer_user_id", "dm_channel_id", "channels", "browser",
  ], "lane fixtures");
  requireExactKeys(value.channels, ["core", "project", "capture"], "lane fixture channels");
  requireExactKeys(value.browser, ["namespace", "profile_path"], "lane fixture browser");
  const parseChannel = (role: string) => {
    const channel = value.channels[role];
    if (!isRecord(channel)) throw new SandboxProvisioningError("invalid_fixture_identities", `Missing ${role} channel`);
    requireExactKeys(channel, ["id", "name"], `${role} channel`);
    return {
      id: requireString(channel.id, `${role} channel id`, /^C[A-Z0-9]+$/),
      name: requireString(channel.name, `${role} channel name`, /^[a-z0-9-]+$/),
    };
  };
  return {
    schema_version: 1,
    lane_id: requireString(value.lane_id, "fixture lane_id", /^lane-[1-4]$/),
    installer_user_id: requireString(value.installer_user_id, "fixture installer_user_id", /^U[A-Z0-9]+$/),
    dm_channel_id: requireString(value.dm_channel_id, "fixture dm_channel_id", /^D[A-Z0-9]+$/),
    channels: { core: parseChannel("core"), project: parseChannel("project"), capture: parseChannel("capture") },
    browser: {
      namespace: requireString(value.browser.namespace, "browser namespace", /^[a-z0-9-]+$/),
      profile_path: requireString(value.browser.profile_path, "browser profile path"),
    },
  };
}

export function loadLaneFixtureIdentities(identityPath: string, fixturesPath: string): LaneFixtureIdentities {
  const identity = loadLaneProvisionedIdentity(identityPath);
  const fixtures = loadLaneFixtures(fixturesPath);
  if (identity.lane_id !== fixtures.lane_id) {
    throw new SandboxProvisioningError("lane_identity_mismatch", "Lane identity and fixtures belong to different lanes");
  }
  return { ...fixtures, ...identity, lane_id: identity.lane_id };
}

export function provisioningPlan(
  topology: SandboxTopology,
  sourceManifest: unknown,
  configRoot = DEFAULT_SANDBOX_CONFIG_ROOT,
  stateRoot = DEFAULT_SANDBOX_STATE_ROOT,
  browserRoot = DEFAULT_SANDBOX_BROWSER_ROOT,
) {
  const paths = sandboxProvisioningPaths(configRoot, stateRoot, browserRoot);
  return {
    workspace_domain: topology.workspace_domain,
    lane_count: topology.lanes.length,
    source_manifest_digest: manifestDigest(sourceManifest),
    manifest_contract_digest: manifestContractDigest(sourceManifest),
    configuration_credential_path: paths.workspaceCredential,
    lanes: topology.lanes.map((lane) => ({
      lane_id: lane.id,
      app_display_name: lane.app_display_name,
      bot_display_name: lane.bot_display_name,
      expected_manifest_digest: manifestDigest(manifestForLane(sourceManifest, lane)),
      slack_config_path: paths.laneSlackConfig(lane.id),
      fixtures_path: paths.laneFixtures(lane.id),
      provisioned_identity_path: paths.laneIdentity(lane.id),
      browser_profile_path: paths.laneBrowserProfile(lane.id),
      channels: lane.channels,
    })),
    unverified_boundaries: [
      "workspace configuration credential authorization",
      "OAuth installation and user/bot token issuance",
      "app-level connections:write token generation",
      "Slack scope and feature behavior in the real sandbox",
      "persistent Slack web authentication",
    ],
  };
}

function argumentValue(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "../..");
  const topologyPath = argumentValue(process.argv, "--topology") || join(projectRoot, "config/sandbox-lanes.json");
  const topology = loadSandboxTopology(topologyPath);
  const manifestPath = resolve(projectRoot, topology.source_manifest);
  const sourceManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const configRoot = argumentValue(process.argv, "--config-root") || DEFAULT_SANDBOX_CONFIG_ROOT;
  const stateRoot = argumentValue(process.argv, "--state-root") || DEFAULT_SANDBOX_STATE_ROOT;
  const browserRoot = argumentValue(process.argv, "--browser-root") || DEFAULT_SANDBOX_BROWSER_ROOT;
  const command = process.argv[2] || "plan";

  if (command === "plan") {
    console.log(JSON.stringify(provisioningPlan(topology, sourceManifest, configRoot, stateRoot, browserRoot), null, 2));
    return;
  }
  if (command === "import-workspace-credential") {
    const source = argumentValue(process.argv, "--from");
    if (!source) throw new SandboxProvisioningError("usage", "import-workspace-credential requires --from <owner-only-json>");
    const imported = importWorkspaceCredential(source, sandboxProvisioningPaths(configRoot).workspaceCredential);
    console.log(JSON.stringify({ imported: true, team_id: imported.team_id, user_id: imported.user_id, expires_at_ms: imported.expires_at_ms }));
    return;
  }
  if (command === "rotate-workspace-credential") {
    if (!process.argv.includes("--apply")) throw new SandboxProvisioningError("apply_required", "Slack credential rotation requires --apply");
    const rotated = await rotateWorkspaceCredential(sandboxProvisioningPaths(configRoot).workspaceCredential);
    console.log(JSON.stringify({ rotated: true, team_id: rotated.team_id, user_id: rotated.user_id, expires_at_ms: rotated.expires_at_ms }));
    return;
  }
  if (command === "apply-manifests") {
    if (!process.argv.includes("--apply")) throw new SandboxProvisioningError("apply_required", "Slack manifest mutation requires --apply");
    console.log(JSON.stringify(await applySandboxManifests({ topology, sourceManifest, configRoot }), null, 2));
    return;
  }
  if (command === "import-lane-secrets") {
    const laneId = argumentValue(process.argv, "--lane");
    const source = argumentValue(process.argv, "--from");
    const lane = topology.lanes.find((candidate) => candidate.id === laneId);
    if (!lane || !source) throw new SandboxProvisioningError("usage", "import-lane-secrets requires --lane lane-N --from <owner-only-json>");
    const imported = importLaneSecrets(lane, source, configRoot);
    console.log(JSON.stringify({ imported: true, lane_id: lane.id, app_id: imported.app_id, team_id: imported.team_id }));
    return;
  }
  if (command === "provision-fixtures") {
    if (!process.argv.includes("--apply")) throw new SandboxProvisioningError("apply_required", "Slack fixture mutation requires --apply");
    const laneId = argumentValue(process.argv, "--lane");
    const lane = topology.lanes.find((candidate) => candidate.id === laneId);
    if (!lane) throw new SandboxProvisioningError("usage", "provision-fixtures requires --lane lane-N");
    const identities = await provisionLaneFixtures({ lane, configRoot, stateRoot, browserRoot });
    console.log(JSON.stringify({ provisioned: true, lane_id: lane.id, app_id: identities.app_id, team_id: identities.team_id,
      dm_channel_id: identities.dm_channel_id, channels: identities.channels }, null, 2));
    return;
  }
  throw new SandboxProvisioningError("usage", `Unknown sandbox provisioning command: ${command}`);
}

if (import.meta.main) {
  main().catch((error) => {
    const code = error instanceof SandboxProvisioningError ? error.code : "unexpected_error";
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ ok: false, code, message }));
    process.exit(1);
  });
}
