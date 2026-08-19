import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  attachSlackChannelToCodePath,
  ChannelRow,
  getChannel,
  getChannelByCodePath,
  parseAdditionalPaths,
  setAdditionalPaths,
  updateChannelCodePath,
  upsertChannel,
} from "./state";
import { log } from "./log";
import {
  managedProjectPaths,
  projectNameParts,
  reconcileProjectScaffold,
} from "./project-scaffold";

const WORKSPACE_ROOT = process.env.CONCIERGE_WORKSPACE_ROOT || "/root/workspace";

export function slugifySlackChannelName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug || "new-project";
}

export const pathFromChannelName = projectNameParts;

// Bot-managed channels always land under vault/projects/, never at vault root.
// Vault root is reserved for the user's own hand-organized notes. Ordinary
// coding projects mirror their channel hierarchy under ~/workspace; skill
// channels use the canonical ~/workspace/skills/<channel> namespace.
export function projectPaths(slackChannelName: string) {
  return managedProjectPaths(WORKSPACE_ROOT, slackChannelName);
}

export function newProject(slackChannelId: string, slackChannelName: string) {
  const paths = projectPaths(slackChannelName);
  applyCanonicalProjectScaffold(paths, slackChannelName);

  upsertChannel({
    slack_channel_id: slackChannelId,
    slack_channel_name: slackChannelName,
    group_name: paths.group,
    name: paths.name,
    vault_path: paths.vault,
    code_path: paths.code,
  });

  return paths;
}

export function attachMigratedProjectChannel(slackChannelId: string, slackChannelName: string) {
  const paths = projectPaths(slugifySlackChannelName(slackChannelName));
  const existing = getChannelByCodePath(paths.code);
  if (!existing) return { status: "missing" as const, paths };

  if ((existing as any).slack_channel_id !== null) {
    return { status: "claimed" as const, channel: existing, paths };
  }

  const attached = attachSlackChannelToCodePath(paths.code, slackChannelId, slackChannelName);
  return {
    status: attached ? "attached" as const : "claimed" as const,
    channel: attached ? getChannel(slackChannelId) : getChannelByCodePath(paths.code),
    paths,
  };
}

export function ensureChannelProject(slackChannelId: string, slackChannelName: string): ChannelRow {
  const existing = getChannel(slackChannelId);
  if (existing) return existing;
  newProject(slackChannelId, slackChannelName);
  return getChannel(slackChannelId)!;
}

export function promoteChannel(channel: ChannelRow) {
  const paths = {
    ...projectPaths(channel.slack_channel_name),
    vault: channel.vault_path,
  };
  applyCanonicalProjectScaffold(paths, channel.slack_channel_name);
  updateChannelCodePath(channel.slack_channel_id, paths.code);
  return paths;
}

function applyCanonicalProjectScaffold(
  paths: ReturnType<typeof projectPaths>,
  projectName: string,
) {
  const report = reconcileProjectScaffold({
    projectName,
    workspaceRoot: WORKSPACE_ROOT,
    codePath: paths.code,
    vaultPath: paths.vault,
    apply: true,
    initializeGit: true,
  });
  if (report.outcome === "ambiguous" || report.outcome === "skipped") {
    throw new Error(`Project scaffold ${report.outcome}: ${report.warnings.join("; ")}`);
  }
  log("info", "project_scaffold_reconciled", {
    project: projectName,
    code_path: paths.code,
    vault_path: paths.vault,
    outcome: report.outcome,
    classification: report.classification,
    action_count: report.actions.length,
  });
}

function captureMarker(idempotencyKey?: string, idempotencySecret?: string) {
  if (!idempotencyKey) return "";
  if (!idempotencySecret) throw new Error("Inline capture idempotency requires an authentication secret.");
  const signature = createHmac("sha256", idempotencySecret)
    .update(`slack-concierge:capture:v1:${idempotencyKey}`)
    .digest("hex");
  return `<!-- concierge-capture-v1:${signature} -->`;
}

export function appendInbox(
  channel: ChannelRow,
  text: string,
  source = "slack",
  idempotencyKey?: string,
  idempotencySecret?: string,
) {
  const inbox = join(channel.vault_path, "notes", "inbox.md");
  mkdirSync(dirname(inbox), { recursive: true });
  const marker = captureMarker(idempotencyKey, idempotencySecret);
  if (marker && existsSync(inbox) && readFileSync(inbox, "utf-8").includes(marker)) return inbox;
  appendFileSync(inbox, `\n- ${new Date().toISOString()} [${source}] ${text.trim()}${marker ? ` ${marker}` : ""}\n`);
  return inbox;
}

export function appendTodo(
  channel: ChannelRow,
  text: string,
  source = "slack",
  idempotencyKey?: string,
  idempotencySecret?: string,
) {
  const todo = join(channel.vault_path, "notes", "TODOS.md");
  mkdirSync(dirname(todo), { recursive: true });
  if (!existsSync(todo)) writeFileSync(todo, `# #${channel.slack_channel_name} todos\n`);
  const marker = captureMarker(idempotencyKey, idempotencySecret);
  if (marker && readFileSync(todo, "utf-8").includes(marker)) return todo;
  appendFileSync(todo, `\n- [ ] ${text.trim()}${marker ? ` ${marker}` : ""}\n`);
  return todo;
}

export function addDir(channel: ChannelRow, path: string) {
  const paths = parseAdditionalPaths(channel);
  const next = [...new Set([...paths, path])];
  setAdditionalPaths(channel.slack_channel_id, next);
  return next;
}

export function removeDir(channel: ChannelRow, path: string) {
  const next = parseAdditionalPaths(channel).filter((item) => item !== path);
  setAdditionalPaths(channel.slack_channel_id, next);
  return next;
}
