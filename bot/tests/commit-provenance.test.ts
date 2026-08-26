import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  db,
  getOrCreateTurnCommitProvenance,
  getSession,
  getTurnCommitProvenance,
  upsertChannel,
  upsertSession,
} from "../src/state";
import { acquireDatabaseTestLock } from "./db-lock";

const repositoryRoot = resolve(import.meta.dir, "../..");
const hook = join(repositoryRoot, ".githooks/prepare-commit-msg");
const hookDirectory = join(repositoryRoot, ".githooks");
let releaseDatabaseTestLock: (() => void) | null = null;
let scratch = "";

function git(cwd: string, ...arguments_: string[]) {
  const result = Bun.spawnSync({
    cmd: ["git", ...arguments_],
    cwd,
    env: { ...process.env, CONCIERGE_COMMIT_PROVENANCE: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
  scratch = mkdtempSync(join(tmpdir(), "concierge-commit-provenance-"));
});

afterEach(() => {
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
  db.query("DELETE FROM channels").run();
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
  rmSync(scratch, { recursive: true, force: true });
});

describe("commit provenance", () => {
  test("maps one opaque token back to the exact originating turn", () => {
    upsertChannel({
      slack_channel_id: "C-PROVENANCE",
      slack_channel_name: "provenance",
      group_name: null,
      name: "Provenance",
      vault_path: scratch,
      code_path: scratch,
    });
    upsertSession("C-PROVENANCE", "100.000001", "codex", "provider-session", { status: "running" });
    const session = getSession("C-PROVENANCE", "100.000001", "codex")!;
    const turn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status
    ) VALUES (?, '100.000002', '100.000001', 'make a change', 'running') RETURNING id`)
      .get(session.id) as { id: number };

    const token = getOrCreateTurnCommitProvenance(turn.id);
    expect(getOrCreateTurnCommitProvenance(turn.id)).toBe(token);
    expect(getTurnCommitProvenance(token)).toEqual({
      token,
      turn_id: turn.id,
      session_id: session.id,
      slack_channel_id: "C-PROVENANCE",
      slack_thread_ts: "100.000001",
      slack_user_msg_ts: "100.000002",
      provider_id: "codex",
      provider_session_uuid: "provider-session",
    });
  });

  test("the tracked hook appends the opaque trailer once and leaves manual commits alone", () => {
    const message = join(scratch, "message.txt");
    const token = "12345678-1234-1234-1234-123456789abc";
    writeFileSync(message, "fix: repair deployment\n");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = Bun.spawnSync({
        cmd: [hook, message],
        cwd: repositoryRoot,
        env: { ...process.env, CONCIERGE_COMMIT_PROVENANCE: token, CODEX_THREAD_ID: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    const contents = readFileSync(message, "utf8");
    expect(contents.match(/Concierge-Provenance:/g)).toHaveLength(1);
    expect(contents).toContain(`Concierge-Provenance: ${token}`);

    const manual = join(scratch, "manual.txt");
    writeFileSync(manual, "docs: manual change\n");
    const manualResult = Bun.spawnSync({
      cmd: [hook, manual],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONCIERGE_COMMIT_PROVENANCE: "",
        CODEX_THREAD_ID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(manualResult.exitCode, manualResult.stderr.toString()).toBe(0);
    expect(readFileSync(manual, "utf8")).toBe("docs: manual change\n");
  });

  test("a real code-mode Git commit resolves its exact running turn without an explicit token", () => {
    upsertChannel({
      slack_channel_id: "C-CODE-MODE",
      slack_channel_name: "code-mode",
      group_name: null,
      name: "Code mode",
      vault_path: scratch,
      code_path: scratch,
    });
    upsertSession("C-CODE-MODE", "200.000001", "codex", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
      status: "running",
    });
    const session = getSession("C-CODE-MODE", "200.000001", "codex")!;
    const turn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status
    ) VALUES (?, '200.000002', '200.000001', 'commit through code mode', 'running') RETURNING id`)
      .get(session.id) as { id: number };
    const token = getOrCreateTurnCommitProvenance(turn.id);

    git(scratch, "init", "-b", "main");
    git(scratch, "config", "user.name", "Concierge Test");
    git(scratch, "config", "user.email", "concierge@example.invalid");
    git(scratch, "config", "core.hooksPath", hookDirectory);
    writeFileSync(join(scratch, "change.txt"), "change\n");
    git(scratch, "add", "change.txt");
    const commit = Bun.spawnSync({
      cmd: ["git", "commit", "-m", "fix: code-mode provenance"],
      cwd: scratch,
      env: {
        ...process.env,
        CONCIERGE_COMMIT_PROVENANCE: "",
        CODEX_THREAD_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(commit.exitCode, commit.stderr.toString()).toBe(0);
    expect(git(scratch, "log", "-1", "--format=%B")).toContain(`Concierge-Provenance: ${token}`);
  });

  test("code mode ignores a stale explicit token and resolves the currently running turn", () => {
    upsertChannel({
      slack_channel_id: "C-STALE-CODE-MODE",
      slack_channel_name: "stale-code-mode",
      group_name: null,
      name: "Stale code mode",
      vault_path: scratch,
      code_path: scratch,
    });
    upsertSession(
      "C-STALE-CODE-MODE",
      "250.000001",
      "codex",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      { status: "running" },
    );
    const session = getSession("C-STALE-CODE-MODE", "250.000001", "codex")!;
    const staleTurn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status
    ) VALUES (?, '250.000002', '250.000001', 'old turn', 'done') RETURNING id`)
      .get(session.id) as { id: number };
    const currentTurn = db.query(`INSERT INTO turns (
      session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status
    ) VALUES (?, '250.000003', '250.000001', 'current turn', 'running') RETURNING id`)
      .get(session.id) as { id: number };
    const staleToken = getOrCreateTurnCommitProvenance(staleTurn.id);
    const currentToken = getOrCreateTurnCommitProvenance(currentTurn.id);

    const message = join(scratch, "stale-code-mode.txt");
    writeFileSync(message, "fix: use current turn\n");
    const result = Bun.spawnSync({
      cmd: [hook, message],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONCIERGE_COMMIT_PROVENANCE: staleToken,
        CODEX_THREAD_ID: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(message, "utf8")).toContain(`Concierge-Provenance: ${currentToken}`);
    expect(readFileSync(message, "utf8")).not.toContain(staleToken);
  });

  test("code-mode attribution refuses two running turns for one provider thread", () => {
    for (const [channelId, messageTs] of [["C-AMBIGUOUS-ONE", "300.000001"], ["C-AMBIGUOUS-TWO", "400.000001"]]) {
      upsertChannel({
        slack_channel_id: channelId,
        slack_channel_name: channelId.toLowerCase(),
        group_name: null,
        name: channelId,
        vault_path: scratch,
        code_path: scratch,
      });
      upsertSession(channelId, messageTs, "codex", "cccccccc-cccc-cccc-cccc-cccccccccccc", { status: "running" });
      const session = getSession(channelId, messageTs, "codex")!;
      const turn = db.query(`INSERT INTO turns (
        session_id, slack_user_msg_ts, slack_reply_thread_ts, user_text, status
      ) VALUES (?, ?, ?, 'ambiguous commit', 'running') RETURNING id`)
        .get(session.id, `${messageTs}1`, messageTs) as { id: number };
      getOrCreateTurnCommitProvenance(turn.id);
    }

    const message = join(scratch, "ambiguous.txt");
    writeFileSync(message, "fix: ambiguous attribution\n");
    const result = Bun.spawnSync({
      cmd: [hook, message],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CONCIERGE_COMMIT_PROVENANCE: "",
        CODEX_THREAD_ID: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Refusing ambiguous Concierge commit provenance");
    expect(readFileSync(message, "utf8")).toBe("fix: ambiguous attribution\n");
  });
});
