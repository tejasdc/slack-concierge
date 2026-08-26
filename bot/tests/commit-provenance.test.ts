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
let releaseDatabaseTestLock: (() => void) | null = null;
let scratch = "";

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
        env: { ...process.env, CONCIERGE_COMMIT_PROVENANCE: token },
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
      env: { ...process.env, CONCIERGE_COMMIT_PROVENANCE: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(manualResult.exitCode, manualResult.stderr.toString()).toBe(0);
    expect(readFileSync(manual, "utf8")).toBe("docs: manual change\n");
  });
});
