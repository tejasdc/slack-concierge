import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import {
  claimNextQueuedTurn,
  clearAbandonedDrain,
  db,
  getSession,
  registerProcessInstance,
  upsertChannel,
  upsertSession,
} from "../src/state";
import { isProcessIdentityAlive, processIdentity } from "../src/runtime-identity";

let releaseDatabaseTestLock: (() => void) | null = null;
const admissionChannelId = "C-DRAIN-ADMISSION-TEST";
const admissionInstanceId = "drain-admission-owner";
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
});
afterEach(() => {
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM turns WHERE session_id IN (SELECT id FROM sessions WHERE slack_channel_id=?)")
    .run(admissionChannelId);
  db.query("DELETE FROM sessions WHERE slack_channel_id=?").run(admissionChannelId);
  db.query("DELETE FROM channels WHERE slack_channel_id=?").run(admissionChannelId);
  db.query("DELETE FROM process_instances WHERE instance_id=?").run(admissionInstanceId);
  releaseDatabaseTestLock?.();
  releaseDatabaseTestLock = null;
});

test("explicit outer-shell ownership survives claim command substitution", async () => {
  const shell = Bun.spawn([
    "bash", "-c",
    'owner_pid=$BASHPID; output=$(bun scripts/drain-status.ts claim --owner-pid "$owner_pid"); sleep 0.5',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH || ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });

  let gate: any = null;
  for (let attempt = 0; attempt < 20 && !gate; attempt += 1) {
    await Bun.sleep(25);
    gate = db.query("SELECT * FROM deployment_drain WHERE singleton=1").get();
  }
  expect(gate?.owner_pid).toBe(shell.pid);

  clearAbandonedDrain(isProcessIdentityAlive);
  expect(db.query("SELECT token FROM deployment_drain WHERE singleton=1").get()).not.toBeNull();

  expect(await shell.exited).toBe(0);
  clearAbandonedDrain(isProcessIdentityAlive);
  expect(db.query("SELECT token FROM deployment_drain WHERE singleton=1").get()).toBeNull();
});

test("closes admission before waiting for an already-running turn", () => {
  const owner = processIdentity(process.pid);
  registerProcessInstance(admissionInstanceId, owner.pid, owner.bootId, owner.startTicks);
  upsertChannel({
    slack_channel_id: admissionChannelId,
    slack_channel_name: "drain-admission-test",
    group_name: null,
    name: "Drain admission test",
    vault_path: "/tmp",
    code_path: "/tmp",
  });
  upsertSession(admissionChannelId, "100.000001", "codex", null);
  const session = getSession(admissionChannelId, "100.000001", "codex")!;
  const active = db.query(`INSERT INTO turns (
    session_id, slack_user_msg_ts, user_text, status, owner_instance_id
  ) VALUES (?, '100.000010', 'active', 'running', ?) RETURNING id`)
    .get(session.id, admissionInstanceId) as { id: number };
  const queued = db.query(`INSERT INTO turns (
    session_id, slack_user_msg_ts, user_text, status
  ) VALUES (?, '100.000020', 'queued', 'queued') RETURNING id`)
    .get(session.id) as { id: number };

  const claim = Bun.spawnSync([
    "bash",
    "-c",
    'owner_pid=$BASHPID; bun scripts/drain-status.ts claim --owner-pid "$owner_pid"',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH || ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(claim.exitCode, claim.stderr.toString()).toBe(0);
  const claimed = JSON.parse(claim.stdout.toString());
  expect(claimed).toMatchObject({
    status: "claimed_draining",
    claimed: true,
    active: [{ turn_id: active.id }],
  });
  expect(db.query("SELECT token FROM deployment_drain WHERE singleton=1").get())
    .toEqual({ token: claimed.token });
  expect(claimNextQueuedTurn("new-owner")).toBeNull();

  db.query("UPDATE turns SET status='done', owner_instance_id=NULL, ended_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(active.id);
  const drained = Bun.spawnSync([
    "bun",
    "scripts/drain-status.ts",
    "check",
    claimed.token,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH || ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(drained.exitCode, drained.stderr.toString()).toBe(0);
  expect(JSON.parse(drained.stdout.toString())).toMatchObject({ status: "drained", active: [] });

  db.query("DELETE FROM deployment_drain WHERE singleton=1 AND token=?").run(claimed.token);
  expect(claimNextQueuedTurn("new-owner")?.turn_id).toBe(queued.id);
});
