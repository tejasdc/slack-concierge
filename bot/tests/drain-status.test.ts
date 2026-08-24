import { afterEach, beforeEach, expect, test } from "bun:test";
import { acquireDatabaseTestLock } from "./db-lock";
import { db, clearAbandonedDrain } from "../src/state";
import { isProcessIdentityAlive, processIdentity } from "../src/runtime-identity";

let releaseDatabaseTestLock: (() => void) | null = null;
beforeEach(async () => {
  releaseDatabaseTestLock = await acquireDatabaseTestLock();
  db.query("DELETE FROM deployment_drain").run();
  db.query("DELETE FROM turn_delivery_chunks").run();
  db.query("DELETE FROM slack_user_input_claims").run();
  db.query("DELETE FROM turn_steering_messages").run();
  db.query("DELETE FROM turns").run();
  db.query("DELETE FROM sessions").run();
});
afterEach(() => { releaseDatabaseTestLock?.(); releaseDatabaseTestLock = null; });

function drainCommand(command: string, token: string) {
  return Bun.spawnSync({
    cmd: ["bun", "scripts/drain-status.ts", command, token],
    cwd: process.cwd(),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function resumeDrainCommand(token: string) {
  return Bun.spawnSync({
    cmd: [
      "bash", "-c",
      'owner_pid=$BASHPID; exec bun scripts/drain-status.ts resume-held "$1" --owner-pid "$owner_pid"',
      "test",
      token,
    ],
    cwd: process.cwd(),
    env: { ...process.env, PATH: `/root/.bun/bin:${process.env.PATH || ""}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

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

test("a rollout can verify only its exact durable hold", () => {
  const owner = processIdentity(process.pid);
  db.query(`INSERT INTO deployment_drain
    (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
    VALUES (1, ?, ?, ?, ?, 'held')`).run(
    "rollout-token",
    owner.pid,
    owner.bootId,
    owner.startTicks,
  );

  const verified = drainCommand("verify-held", "rollout-token");
  expect(verified.exitCode, verified.stderr.toString()).toBe(0);
  expect(JSON.parse(verified.stdout.toString())).toEqual({ status: "held", token: "rollout-token" });
  expect(drainCommand("verify-held", "other-token").exitCode).toBe(1);
});

test("a parked cutover reacquires the exact held token only after its prior owner is dead", () => {
  const owner = processIdentity(process.pid);
  db.query(`INSERT INTO deployment_drain
    (singleton, token, owner_pid, owner_boot_id, owner_start_ticks, mode)
    VALUES (1, ?, ?, ?, ?, 'held')`).run(
    "parked-token",
    owner.pid,
    owner.bootId,
    owner.startTicks,
  );
  expect(resumeDrainCommand("parked-token").exitCode).toBe(10);

  db.query(`UPDATE deployment_drain SET owner_pid=?, owner_start_ticks=? WHERE singleton=1`)
    .run(99_999_999, "dead-owner");
  const resumed = resumeDrainCommand("parked-token");
  expect(resumed.exitCode, resumed.stderr.toString()).toBe(0);
  expect(JSON.parse(resumed.stdout.toString())).toMatchObject({ status: "resumed_held", token: "parked-token" });
  expect(db.query("SELECT token, mode FROM deployment_drain WHERE singleton=1").get())
    .toEqual({ token: "parked-token", mode: "held" });
  expect(resumeDrainCommand("wrong-token").exitCode).toBe(1);
});
