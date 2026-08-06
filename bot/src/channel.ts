import { mkdirSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { upsertChannel } from "./state";

export function pathFromChannelName(name: string): { group: string | null, name: string } {
  const parts = name.split("_");
  if (parts.length === 1) return { group: null, name: parts[0] };
  return { group: parts[0], name: parts.slice(1).join("_") };
}

export function newProject(slackChannelId: string, slackChannelName: string) {
  const { group, name } = pathFromChannelName(slackChannelName);
  const rel = group ? `${group}/${name}` : name;
  const vault = `/root/workspace/vault/${rel}`;
  const code  = `/root/workspace/${rel}`;

  mkdirSync(`${vault}/notes`, { recursive: true });
  const AGENTS = `${vault}/AGENTS.md`;
  if (!existsSync(AGENTS)) {
    writeFileSync(AGENTS, `# ${slackChannelName}\n\nAgent instructions for this project.\n\nWorking directory: ${code}\n`);
  }
  const inbox = `${vault}/notes/inbox.md`;
  if (!existsSync(inbox)) writeFileSync(inbox, `# ${slackChannelName} — inbox\n`);

  mkdirSync(code, { recursive: true });
  try { execSync("git init -q", { cwd: code, stdio: "ignore" }); } catch {}
  const symlinks: Array<[string, string]> = [
    [`${vault}/AGENTS.md`, `${code}/AGENTS.md`],
    [`AGENTS.md`, `${code}/CLAUDE.md`],
    [`${vault}/notes`, `${code}/notes`],
  ];
  for (const [target, link] of symlinks) {
    if (!existsSync(link)) {
      try { symlinkSync(target, link); } catch {}
    }
  }

  upsertChannel({
    slack_channel_id: slackChannelId,
    slack_channel_name: slackChannelName,
    vault_path: vault,
    code_path: code,
  });

  return { vault, code, rel };
}
