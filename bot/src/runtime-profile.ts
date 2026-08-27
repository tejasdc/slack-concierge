import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export type ConciergeRuntimeProfile = "production" | "sandbox";

export interface RuntimeOwnership {
  captureDelivery: boolean;
  deployment: boolean;
  codexRemote: boolean;
  projectCutover: boolean;
}

export interface ResolvedRuntimeProfile {
  profile: ConciergeRuntimeProfile;
  slackConfigPath: string;
  stateDir: string;
  expectedSlackTeamId: string | null;
  expectedSlackAppId: string | null;
  expectedSlackBotUserId: string | null;
  expectedSlackBotId: string | null;
  sandboxRunId: string | null;
  sandboxLane: number | null;
  sandboxReadyFile: string | null;
  sandboxWorkspaceRoot: string | null;
  captureQueueUrl: string | null;
  captureQueueTokenPath: string | null;
  ownership: RuntimeOwnership;
}

const PRODUCTION_OWNERSHIP: RuntimeOwnership = {
  captureDelivery: true,
  deployment: true,
  codexRemote: true,
  projectCutover: true,
};

const SANDBOX_OWNERSHIP: RuntimeOwnership = {
  captureDelivery: false,
  deployment: false,
  codexRemote: false,
  projectCutover: false,
};

function sandboxCaptureConfiguration(environment: NodeJS.ProcessEnv, stateDir: string) {
  const queueUrlValue = environment.CONCIERGE_CAPTURE_QUEUE_URL?.trim() || "";
  const tokenPathValue = environment.CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE?.trim() || "";
  if (!queueUrlValue && !tokenPathValue) return { queueUrl: null, tokenPath: null };
  if (!queueUrlValue || !tokenPathValue) {
    throw new Error(
      "Sandbox capture requires both CONCIERGE_CAPTURE_QUEUE_URL and CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE.",
    );
  }

  let queueUrl: URL;
  try {
    queueUrl = new URL(queueUrlValue);
  } catch {
    throw new Error("Sandbox capture queue URL is invalid.");
  }
  if (queueUrl.protocol !== "http:"
    || !["127.0.0.1", "[::1]"].includes(queueUrl.hostname)
    || !queueUrl.port
    || queueUrl.username
    || queueUrl.password
    || (queueUrl.pathname !== "/" && queueUrl.pathname !== "")
    || queueUrl.search
    || queueUrl.hash) {
    throw new Error("Sandbox capture queue must be an explicit loopback HTTP origin with a port.");
  }
  const normalizedQueueUrl = queueUrl.origin;
  if (normalizedQueueUrl === "http://127.0.0.1:8081") {
    throw new Error("Sandbox capture refuses the production capture queue URL.");
  }

  const tokenPath = requiredAbsolutePath(tokenPathValue, "CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE");
  if (!pathIsWithin(stateDir, tokenPath)) {
    throw new Error("Sandbox capture queue token must live inside the active sandbox run state directory.");
  }
  return { queueUrl: normalizedQueueUrl, tokenPath };
}

function requiredAbsolutePath(value: string | undefined, name: string) {
  const path = value?.trim() || "";
  if (!path) throw new Error(`Sandbox runtime requires ${name}.`);
  if (!isAbsolute(path)) throw new Error(`Sandbox runtime requires ${name} to be an absolute path.`);
  return resolve(path);
}

function requiredIdentity(value: string | undefined, name: string) {
  const identity = value?.trim() || "";
  if (!/^[A-Z][A-Z0-9]{4,}$/.test(identity)) {
    throw new Error(`Sandbox runtime requires a valid ${name}.`);
  }
  return identity;
}

function requiredRunId(value: string | undefined) {
  const runId = value?.trim() || "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error("Sandbox runtime requires a valid CONCIERGE_SANDBOX_RUN_ID.");
  }
  return runId;
}

function requiredLane(value: string | undefined) {
  const lane = Number(value);
  if (!Number.isInteger(lane) || lane < 1 || lane > 4) {
    throw new Error("Sandbox runtime requires CONCIERGE_SANDBOX_LANE to be an integer from 1 through 4.");
  }
  return lane;
}

function pathIsWithin(parent: string, candidate: string) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function resolveRuntimeProfile(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): ResolvedRuntimeProfile {
  const profile = environment.CONCIERGE_RUNTIME_PROFILE?.trim() || "production";
  const stateDir = environment.CONCIERGE_STATE_DIR?.trim() || "";
  if (profile === "production") {
    return {
      profile,
      slackConfigPath: resolve(homeDirectory, ".config/concierge/slack.toml"),
      stateDir,
      expectedSlackTeamId: null,
      expectedSlackAppId: null,
      expectedSlackBotUserId: null,
      expectedSlackBotId: null,
      sandboxRunId: null,
      sandboxLane: null,
      sandboxReadyFile: null,
      sandboxWorkspaceRoot: null,
      captureQueueUrl: null,
      captureQueueTokenPath: null,
      ownership: PRODUCTION_OWNERSHIP,
    };
  }
  if (profile !== "sandbox") {
    throw new Error(`Unsupported Concierge runtime profile: ${profile}`);
  }
  if (environment.CONCIERGE_TEST_MODE !== "1") {
    throw new Error("Sandbox runtime requires CONCIERGE_TEST_MODE=1 so state cannot resolve inside the production home.");
  }

  const slackConfigPath = requiredAbsolutePath(environment.CONCIERGE_CONFIG_PATH, "CONCIERGE_CONFIG_PATH");
  const sandboxStateDir = requiredAbsolutePath(environment.CONCIERGE_STATE_DIR, "CONCIERGE_STATE_DIR");
  const productionConfigPath = resolve(homeDirectory, ".config/concierge/slack.toml");
  if (slackConfigPath === productionConfigPath) {
    throw new Error("Sandbox runtime refuses the production Slack configuration path.");
  }
  if (pathIsWithin(homeDirectory, sandboxStateDir)) {
    throw new Error("Sandbox runtime state must be outside the production home directory.");
  }

  const readyFile = requiredAbsolutePath(
    environment.CONCIERGE_SANDBOX_READY_FILE,
    "CONCIERGE_SANDBOX_READY_FILE",
  );
  if (readyFile === sandboxStateDir || !pathIsWithin(sandboxStateDir, readyFile)) {
    throw new Error("Sandbox readiness file must live inside the active sandbox run state directory.");
  }

  const sandboxWorkspaceRoot = requiredAbsolutePath(
    environment.CONCIERGE_WORKSPACE_ROOT,
    "CONCIERGE_WORKSPACE_ROOT",
  );
  const sandboxRunRoot = dirname(sandboxStateDir);
  if (sandboxWorkspaceRoot === sandboxRunRoot
    || !pathIsWithin(sandboxRunRoot, sandboxWorkspaceRoot)
    || pathIsWithin(sandboxStateDir, sandboxWorkspaceRoot)) {
    throw new Error("Sandbox workspace root must be a sibling-owned path inside the active run root.");
  }

  const capture = sandboxCaptureConfiguration(environment, sandboxStateDir);
  return {
    profile,
    slackConfigPath,
    stateDir: sandboxStateDir,
    expectedSlackTeamId: requiredIdentity(
      environment.CONCIERGE_SANDBOX_EXPECTED_TEAM_ID,
      "CONCIERGE_SANDBOX_EXPECTED_TEAM_ID",
    ),
    expectedSlackAppId: requiredIdentity(
      environment.CONCIERGE_SANDBOX_EXPECTED_APP_ID,
      "CONCIERGE_SANDBOX_EXPECTED_APP_ID",
    ),
    expectedSlackBotUserId: requiredIdentity(
      environment.CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID,
      "CONCIERGE_SANDBOX_EXPECTED_BOT_USER_ID",
    ),
    expectedSlackBotId: requiredIdentity(
      environment.CONCIERGE_SANDBOX_EXPECTED_BOT_ID,
      "CONCIERGE_SANDBOX_EXPECTED_BOT_ID",
    ),
    sandboxRunId: requiredRunId(environment.CONCIERGE_SANDBOX_RUN_ID),
    sandboxLane: requiredLane(environment.CONCIERGE_SANDBOX_LANE),
    sandboxReadyFile: readyFile,
    sandboxWorkspaceRoot,
    captureQueueUrl: capture.queueUrl,
    captureQueueTokenPath: capture.tokenPath,
    ownership: {
      ...SANDBOX_OWNERSHIP,
      captureDelivery: capture.queueUrl !== null,
    },
  };
}

export function assertConfiguredSlackIdentity(
  runtime: ResolvedRuntimeProfile,
  config: { team_id?: unknown; app_id?: unknown },
) {
  if (runtime.profile !== "sandbox") return;
  if (String(config.team_id || "") !== runtime.expectedSlackTeamId) {
    throw new Error("Sandbox Slack configuration team_id does not match CONCIERGE_SANDBOX_EXPECTED_TEAM_ID.");
  }
  if (String(config.app_id || "") !== runtime.expectedSlackAppId) {
    throw new Error("Sandbox Slack configuration app_id does not match CONCIERGE_SANDBOX_EXPECTED_APP_ID.");
  }
}

export function assertAuthenticatedSlackIdentity(
  runtime: ResolvedRuntimeProfile,
  authentication: {
    team_id?: unknown;
    app_id?: unknown;
    user_id?: unknown;
    bot_id?: unknown;
  },
) {
  if (runtime.profile !== "sandbox") return;
  if (String(authentication.team_id || "") !== runtime.expectedSlackTeamId) {
    throw new Error("Authenticated Slack workspace does not match the expected sandbox team.");
  }
  if (String(authentication.app_id || "") !== runtime.expectedSlackAppId) {
    throw new Error("Authenticated Slack app does not match the expected sandbox lane app.");
  }
  if (String(authentication.user_id || "") !== runtime.expectedSlackBotUserId) {
    throw new Error("Authenticated Slack bot user does not match the expected sandbox lane bot user.");
  }
  if (String(authentication.bot_id || "") !== runtime.expectedSlackBotId) {
    throw new Error("Authenticated Slack bot does not match the expected sandbox lane bot.");
  }
}

export async function resolveAuthenticatedSlackAppId(
  runtime: ResolvedRuntimeProfile,
  authentication: { app_id?: unknown; bot_id?: unknown },
  lookupBotAppId: (botId: string) => Promise<unknown>,
) {
  const authTestAppId = String(authentication.app_id || "");
  if (runtime.profile !== "sandbox" || authTestAppId) return authTestAppId;
  const botId = String(authentication.bot_id || "");
  if (!botId) {
    throw new Error("Slack auth.test did not return the bot id required to verify the sandbox app.");
  }
  return String(await lookupBotAppId(botId) || "");
}

export interface SandboxReadyReceipt {
  schema_version: 1;
  pid: number;
  run_id: string;
  lane: number;
  team_id: string;
  bot_user_id: string;
  bot_id: string;
  app_id: string;
  ready_at: string;
}

function canonicalContainedParent(stateDir: string, filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const canonicalStateDir = realpathSync(stateDir);
  const canonicalParent = realpathSync(dirname(filePath));
  if (!pathIsWithin(canonicalStateDir, canonicalParent)) {
    throw new Error("Sandbox readiness file parent escapes the active run state directory.");
  }
}

export function writeSandboxReadyReceipt(
  runtime: ResolvedRuntimeProfile,
  identity: { teamId: string; botUserId: string; botId: string; appId: string },
  now = new Date(),
) {
  if (runtime.profile !== "sandbox") return;
  const readyFile = runtime.sandboxReadyFile!;
  canonicalContainedParent(runtime.stateDir, readyFile);
  const receipt: SandboxReadyReceipt = {
    schema_version: 1,
    pid: process.pid,
    run_id: runtime.sandboxRunId!,
    lane: runtime.sandboxLane!,
    team_id: identity.teamId,
    bot_user_id: identity.botUserId,
    bot_id: identity.botId,
    app_id: identity.appId,
    ready_at: now.toISOString(),
  };
  const temporaryPath = `${readyFile}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporaryPath, readyFile);
}

export function clearSandboxReadyReceipt(runtime: ResolvedRuntimeProfile) {
  if (runtime.profile !== "sandbox") return;
  try {
    unlinkSync(runtime.sandboxReadyFile!);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}
