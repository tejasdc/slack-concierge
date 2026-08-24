import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  committedAgentsWatchTarget,
  readCommittedAgents,
  resolveTrackedAgentsSource,
  syncCommittedAgentsCanvas,
} from "../src/canvas-git-projection";
import {
  db,
  getChannel,
  updateChannelCanvasId,
  upsertChannel,
} from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

const temporaryDirectories: string[] = [];
let releaseDatabaseTestLock: (() => void) | null = null;

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM channels").run();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

function git(repository: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout || "").trim();
}

function repository(name: string, agentsText = "# Initial instructions\n") {
  const directory = mkdtempSync(join(tmpdir(), `concierge-${name}-`));
  temporaryDirectories.push(directory);
  git(directory, "init", "--quiet");
  git(directory, "config", "user.name", "Concierge Test");
  git(directory, "config", "user.email", "concierge@example.test");
  writeFileSync(join(directory, "AGENTS.md"), agentsText);
  git(directory, "add", "AGENTS.md");
  git(directory, "commit", "--quiet", "-m", "initial instructions");
  return directory;
}

function commit(repositoryPath: string, path: string, content: string, message: string) {
  writeFileSync(join(repositoryPath, path), content);
  git(repositoryPath, "add", path);
  git(repositoryPath, "commit", "--quiet", "-m", message);
  return git(repositoryPath, "rev-parse", "HEAD");
}

function channel(repositoryPath: string, channelId = "C_GIT") {
  upsertChannel({
    slack_channel_id: channelId,
    slack_channel_name: "git-canvas",
    group_name: null,
    name: "Git Canvas",
    vault_path: repositoryPath,
    code_path: repositoryPath,
  });
  updateChannelCanvasId(channelId, "F_CANVAS");
  return getChannel(channelId)!;
}

describe("committed AGENTS.md Canvas projection", () => {
  test("resolves a tracked source and the current worktree HEAD event path", () => {
    const root = repository("git-worktree");
    const worktree = join(root, "secondary");
    git(root, "worktree", "add", "--quiet", "-b", "secondary", worktree);

    const source = resolveTrackedAgentsSource({ code_path: worktree });
    expect(source).not.toBeNull();
    expect(source!.relativePath).toBe("AGENTS.md");
    expect(readCommittedAgents(source!)).toBe("# Initial instructions\n");
    expect(source!.headLogPath).toContain("/.git/worktrees/");
    expect(committedAgentsWatchTarget({ code_path: worktree })).toEqual({
      directory: source!.headLogPath.slice(0, source!.headLogPath.lastIndexOf("/")),
      filename: "HEAD",
    });
  });

  test("ignores vault-only and untracked AGENTS.md sources", () => {
    const untracked = mkdtempSync(join(tmpdir(), "concierge-untracked-agents-"));
    temporaryDirectories.push(untracked);
    git(untracked, "init", "--quiet");
    writeFileSync(join(untracked, "AGENTS.md"), "# Untracked\n");

    expect(resolveTrackedAgentsSource({ code_path: null })).toBeNull();
    expect(resolveTrackedAgentsSource({ code_path: untracked })).toBeNull();
  });

  test("projects exact committed content and excludes a dirty working-tree edit", async () => {
    const root = repository("git-committed");
    const initialCommit = git(root, "rev-parse", "HEAD");
    const registered = channel(root);
    writeFileSync(join(root, "AGENTS.md"), "# Dirty working tree\n");
    let projectedText = "";

    const result = await syncCommittedAgentsCanvas({
      client: {},
      channel: registered,
      reason: "startup",
      syncCanvas: async (input: any) => {
        projectedText = input.source.text;
        return { ok: true, canvasId: "F_CANVAS", operation: "update" };
      },
    });

    expect(result).toMatchObject({ ok: true, status: "projected", commit: initialCommit });
    expect(projectedText).toBe("# Initial instructions\n");
    expect(getChannel("C_GIT")!.canvas_projected_commit).toBe(initialCommit);
  });

  test("advances across unrelated and change-then-revert commits without a Slack call", async () => {
    const root = repository("git-noop");
    const registered = channel(root);
    let slackCalls = 0;
    const syncCanvas = async () => {
      slackCalls += 1;
      return { ok: true as const, canvasId: "F_CANVAS", operation: "update" as const };
    };
    await syncCommittedAgentsCanvas({ client: {}, channel: registered, reason: "startup", syncCanvas });

    const unrelatedCommit = commit(root, "README.md", "unrelated\n", "unrelated change");
    const unrelated = await syncCommittedAgentsCanvas({
      client: {},
      channel: getChannel("C_GIT")!,
      reason: "git-head",
      syncCanvas,
    });
    expect(unrelated).toEqual({ ok: true, status: "unchanged", commit: unrelatedCommit });
    expect(slackCalls).toBe(1);

    commit(root, "AGENTS.md", "# Temporary instructions\n", "temporary instructions");
    const revertedCommit = commit(root, "AGENTS.md", "# Initial instructions\n", "revert instructions");
    const reverted = await syncCommittedAgentsCanvas({
      client: {},
      channel: getChannel("C_GIT")!,
      reason: "git-head",
      syncCanvas,
    });
    expect(reverted).toEqual({ ok: true, status: "unchanged", commit: revertedCommit });
    expect(slackCalls).toBe(1);
    expect(getChannel("C_GIT")!.canvas_projected_commit).toBe(revertedCommit);
  });

  test("retains the prior cursor on failure and advances it after the changed commit succeeds", async () => {
    const root = repository("git-failure");
    const registered = channel(root);
    const initial = await syncCommittedAgentsCanvas({
      client: {},
      channel: registered,
      reason: "startup",
      syncCanvas: async () => ({ ok: true, canvasId: "F_CANVAS", operation: "update" }),
    });
    if (!initial.ok || initial.status !== "projected") throw new Error("initial projection failed");

    const changedCommit = commit(root, "AGENTS.md", "# Changed instructions\n", "change instructions");
    const failed = await syncCommittedAgentsCanvas({
      client: {},
      channel: getChannel("C_GIT")!,
      reason: "git-head",
      syncCanvas: async () => ({ ok: false, error: "canvas_failed" }),
    });
    expect(failed).toEqual({ ok: false, status: "failed", error: "canvas_failed" });
    expect(getChannel("C_GIT")!.canvas_projected_commit).toBe(initial.commit);

    let projectedText = "";
    const succeeded = await syncCommittedAgentsCanvas({
      client: {},
      channel: getChannel("C_GIT")!,
      reason: "git-head",
      syncCanvas: async (input: any) => {
        projectedText = input.source.text;
        return { ok: true, canvasId: "F_CANVAS", operation: "update" };
      },
    });
    expect(succeeded).toMatchObject({ ok: true, status: "projected", commit: changedCommit });
    expect(projectedText).toBe("# Changed instructions\n");
    expect(getChannel("C_GIT")!.canvas_projected_commit).toBe(changedCommit);
  });
});
