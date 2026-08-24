import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { log } from "./log";
import type { ProjectionWatchTarget } from "./projection-watcher";
import {
  getChannel,
  type ChannelRow,
  updateChannelCanvasProjectedCommit,
} from "./state";
import {
  syncAgentsCanvas,
  type CanvasSyncResult,
} from "./canvas";

const GIT_OUTPUT_LIMIT = 2 * 1_048_576;

interface GitResult {
  status: number | null;
  stdout: string;
}

export interface TrackedAgentsSource {
  commit: string;
  repositoryRoot: string;
  relativePath: string;
  headLogPath: string;
}

export type CommittedCanvasProjectionResult =
  | { ok: true; status: "ignored" }
  | { ok: true; status: "unchanged"; commit: string }
  | ({ ok: true; status: "projected"; commit: string } & Omit<Extract<CanvasSyncResult, { ok: true }>, "ok">)
  | { ok: false; status: "failed"; error: string };

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: GIT_OUTPUT_LIMIT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
  };
}

function successfulGitOutput(cwd: string, args: string[]): string | null {
  const result = runGit(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function resolveTrackedAgentsSource(
  channel: Pick<ChannelRow, "code_path">,
): TrackedAgentsSource | null {
  if (!channel.code_path) return null;

  const repositoryRoot = successfulGitOutput(channel.code_path, ["rev-parse", "--show-toplevel"]);
  if (!repositoryRoot) return null;

  const relativePath = relative(repositoryRoot, join(channel.code_path, "AGENTS.md"));
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return null;
  }

  const commit = successfulGitOutput(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!commit) return null;
  if (runGit(repositoryRoot, ["cat-file", "-e", `${commit}:${relativePath}`]).status !== 0) return null;

  const headLogPath = successfulGitOutput(repositoryRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "logs/HEAD",
  ]);
  if (!headLogPath || !existsSync(headLogPath)) return null;

  return { commit, repositoryRoot, relativePath, headLogPath };
}

export function committedAgentsWatchTarget(channel: Pick<ChannelRow, "code_path">): ProjectionWatchTarget | null {
  const source = resolveTrackedAgentsSource(channel);
  return source
    ? { directory: dirname(source.headLogPath), filename: basename(source.headLogPath) }
    : null;
}

export function readCommittedAgents(source: TrackedAgentsSource): string | null {
  const result = runGit(source.repositoryRoot, ["show", `${source.commit}:${source.relativePath}`]);
  return result.status === 0 ? result.stdout : null;
}

export function committedAgentsChangedSince(source: TrackedAgentsSource, priorCommit: string): boolean {
  if (priorCommit === source.commit) return false;
  const result = runGit(source.repositoryRoot, [
    "diff",
    "--quiet",
    priorCommit,
    source.commit,
    "--",
    source.relativePath,
  ]);
  if (result.status === 0) return false;
  if (result.status === 1) return true;

  log("warn", "canvas_commit_comparison_failed", {
    repository: source.repositoryRoot,
    path: source.relativePath,
    prior_commit: priorCommit,
    current_commit: source.commit,
  });
  return true;
}

export async function syncCommittedAgentsCanvas(input: {
  client: any;
  channel: ChannelRow;
  user?: string | null;
  reason: string;
  force?: boolean;
  syncCanvas?: typeof syncAgentsCanvas;
}): Promise<CommittedCanvasProjectionResult> {
  const channel = getChannel(input.channel.slack_channel_id) || input.channel;
  const source = resolveTrackedAgentsSource(channel);
  if (!source) return { ok: true, status: "ignored" };

  if (!input.force && channel.canvas_id && channel.canvas_projected_commit) {
    if (!committedAgentsChangedSince(source, channel.canvas_projected_commit)) {
      if (channel.canvas_projected_commit !== source.commit) {
        updateChannelCanvasProjectedCommit(channel.slack_channel_id, source.commit);
      }
      log("info", "canvas_commit_projection_unchanged", {
        channel: channel.slack_channel_id,
        prior_commit: channel.canvas_projected_commit,
        current_commit: source.commit,
        reason: input.reason,
      });
      return { ok: true, status: "unchanged", commit: source.commit };
    }
  }

  const agentsText = readCommittedAgents(source);
  if (agentsText == null) {
    return { ok: false, status: "failed", error: "committed_agents_read_failed" };
  }

  const result = await (input.syncCanvas || syncAgentsCanvas)({
    client: input.client,
    channel,
    user: input.user,
    reason: input.reason,
    source: {
      path: `${source.relativePath} @ ${source.commit.slice(0, 12)}`,
      text: agentsText,
    },
  });
  if (!result.ok) return { ...result, status: "failed" };

  updateChannelCanvasProjectedCommit(channel.slack_channel_id, source.commit);
  return { ...result, status: "projected", commit: source.commit };
}
