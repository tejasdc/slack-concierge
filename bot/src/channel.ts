import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  // AGENTS.md lives in the CODE repo as a git-tracked real file (per the
  // 2026-08-07 convention change — see the "Where to write what" section of
  // ~/.codex/AGENTS.md). Vault only carries notes/ so Obsidian can sync
  // ephemeral captures across devices. Do NOT create vault AGENTS.md here.
  const inbox = join(vault, "notes", "inbox.md");
  if (!existsSync(inbox)) writeFileSync(inbox, `# ${channelName} inbox\n`);
}

// Bot-managed channels always land under vault/projects/, never at vault root.
// Vault root is reserved for the user's own hand-organized notes.
// Coding side still mirrors the flat ~/workspace/<name>/ layout (R-VAULT-9).
export function projectPaths(slackChannelName: string) {
  const parsed = pathFromChannelName(slackChannelName);
  return {
    ...parsed,
    vault: join(VAULT_ROOT, "projects", parsed.rel),
    code: join(WORKSPACE_ROOT, parsed.rel),
  };
}

export function newProject(slackChannelId: string, slackChannelName: string) {
  const paths = projectPaths(slackChannelName);
  ensureVaultFiles(paths.vault, slackChannelName, paths.code);
  promoteProjectPaths(paths.vault, paths.code, slackChannelName);

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

function promoteProjectPaths(vault: string, code: string, channelName: string) {
  mkdirSync(code, { recursive: true });
  try {
    execSync("git init -q -b main", { cwd: code, stdio: "ignore" });
  } catch {
    // git init is best-effort; agents can still operate in the directory.
  }
  ensureRealAgentsFile(join(code, "AGENTS.md"), channelName, code);
  ensureSymlink("AGENTS.md", join(code, "CLAUDE.md"));
  ensureSymlink(join(vault, "notes"), join(code, "notes"));
  mkdirSync(join(code, ".codex"), { recursive: true });
  mkdirSync(join(code, ".claude"), { recursive: true });
}

// AGENTS.md must be a real git-tracked file in the code repo — the vault
// symlink pattern was retired 2026-08-07 so agents that maintain their own
// instructions can commit edits atomically. If we find an old vault-symlink
// left over from before the migration, replace it in-place with a real file
// carrying whatever content the symlink was pointing at (so we never lose
// content), and back up the symlink itself.
function ensureRealAgentsFile(agentsPath: string, channelName: string, code: string) {
  let stat;
  try {
    stat = lstatSync(agentsPath);
  } catch {}
  if (stat?.isFile() && !stat.isSymbolicLink()) return;
  const carriedContent = stat?.isSymbolicLink() && existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf8")
    : null;
  if (stat) {
    const backup = `${agentsPath}.bak-${Date.now()}`;
    renameSync(agentsPath, backup);
    log("warn", "agents_promoted_to_real_file", { agentsPath, previous_path: backup });
  }
  writeFileSync(
    agentsPath,
    carriedContent ?? `# ${channelName}\n\nAgent instructions for this project.\n\nWorking directory: ${code}\n`,
  );
}

export function promoteChannel(channel: ChannelRow) {
  const paths = projectPaths(channel.slack_channel_name);
  ensureVaultFiles(paths.vault, channel.slack_channel_name, paths.code);
  promoteProjectPaths(paths.vault, paths.code, channel.slack_channel_name);
  updateChannelCodePath(channel.slack_channel_id, paths.code);
  return paths;
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
  const todo = join(channel.vault_path, "TODOS.md");
  mkdirSync(dirname(todo), { recursive: true });
  if (!existsSync(todo)) writeFileSync(todo, `# ${channel.slack_channel_name} todos\n`);
  const marker = captureMarker(idempotencyKey, idempotencySecret);
  if (marker && readFileSync(todo, "utf-8").includes(marker)) return todo;
  appendFileSync(todo, `\n- [ ] ${text.trim()} (${source}, ${new Date().toISOString()})${marker ? ` ${marker}` : ""}\n`);
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
