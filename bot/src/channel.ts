import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ChannelRow,
  getChannel,
  parseAdditionalPaths,
  setAdditionalPaths,
  updateChannelCodePath,
  upsertChannel,
} from "./state";
import { log } from "./log";

const WORKSPACE_ROOT = process.env.CONCIERGE_WORKSPACE_ROOT || "/root/workspace";
const VAULT_ROOT = `${WORKSPACE_ROOT}/vault`;

export function slugifySlackChannelName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return slug || "new-project";
}

export function pathFromChannelName(name: string): { group: string | null; name: string; rel: string } {
  const clean = name.trim().replace(/^#/, "").toLowerCase();
  const parts = clean.split("_").filter(Boolean);
  const rel = parts.join("/");
  return {
    group: parts.length > 1 ? parts[0] : null,
    name: parts.at(-1) || clean,
    rel: rel || clean,
  };
}

function ensureSymlink(target: string, link: string) {
  let stat;
  try {
    stat = lstatSync(link);
  } catch {}
  if (stat) {
    if (stat.isSymbolicLink()) {
      const current = readlinkSync(link);
      const currentResolved = resolve(dirname(link), current);
      const targetResolved = resolve(dirname(link), target);
      if (current === target || currentResolved === targetResolved) return;
      rmSync(link);
      log("warn", "symlink_self_healed", { link, previous_target: current, target });
    } else {
      const backup = `${link}.bak-${Date.now()}`;
      renameSync(link, backup);
      log("warn", "symlink_self_healed", { link, previous_path: backup, target });
    }
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link);
}

function ensureVaultFiles(vault: string, channelName: string, code: string) {
  mkdirSync(join(vault, "notes"), { recursive: true });
  const agents = join(vault, "AGENTS.md");
  if (!existsSync(agents)) {
    writeFileSync(
      agents,
      `# ${channelName}\n\nAgent instructions for this project.\n\nWorking directory: ${code}\n`,
    );
  }
  const inbox = join(vault, "notes", "inbox.md");
  if (!existsSync(inbox)) writeFileSync(inbox, `# ${channelName} inbox\n`);
}

export function projectPaths(slackChannelName: string) {
  const parsed = pathFromChannelName(slackChannelName);
  return {
    ...parsed,
    vault: join(VAULT_ROOT, parsed.rel),
    code: join(WORKSPACE_ROOT, parsed.rel),
  };
}

export function newProject(slackChannelId: string, slackChannelName: string) {
  const paths = projectPaths(slackChannelName);
  ensureVaultFiles(paths.vault, slackChannelName, paths.code);
  promoteProjectPaths(paths.vault, paths.code);

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

export function ensureChannelProject(slackChannelId: string, slackChannelName: string): ChannelRow {
  const existing = getChannel(slackChannelId);
  if (existing) return existing;
  newProject(slackChannelId, slackChannelName);
  return getChannel(slackChannelId)!;
}

function promoteProjectPaths(vault: string, code: string) {
  mkdirSync(code, { recursive: true });
  try {
    execSync("git init -q", { cwd: code, stdio: "ignore" });
  } catch {
    // git init is best-effort; agents can still operate in the directory.
  }
  ensureSymlink(join(vault, "AGENTS.md"), join(code, "AGENTS.md"));
  ensureSymlink("AGENTS.md", join(code, "CLAUDE.md"));
  ensureSymlink(join(vault, "notes"), join(code, "notes"));
  mkdirSync(join(code, ".codex"), { recursive: true });
  mkdirSync(join(code, ".claude"), { recursive: true });
}

export function promoteChannel(channel: ChannelRow) {
  const paths = projectPaths(channel.slack_channel_name);
  ensureVaultFiles(paths.vault, channel.slack_channel_name, paths.code);
  promoteProjectPaths(paths.vault, paths.code);
  updateChannelCodePath(channel.slack_channel_id, paths.code);
  return paths;
}

export function appendInbox(channel: ChannelRow, text: string, source = "slack") {
  const inbox = join(channel.vault_path, "notes", "inbox.md");
  mkdirSync(dirname(inbox), { recursive: true });
  appendFileSync(inbox, `\n- ${new Date().toISOString()} [${source}] ${text.trim()}\n`);
  return inbox;
}

export function appendTodo(channel: ChannelRow, text: string, source = "slack") {
  const todo = join(channel.vault_path, "TODOS.md");
  mkdirSync(dirname(todo), { recursive: true });
  if (!existsSync(todo)) writeFileSync(todo, `# ${channel.slack_channel_name} todos\n`);
  appendFileSync(todo, `\n- [ ] ${text.trim()} (${source}, ${new Date().toISOString()})\n`);
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
