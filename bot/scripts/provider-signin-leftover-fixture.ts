/**
 * A sign-in command must not outlive the operation it belongs to.
 *
 * The runner unit is `KillMode=process`, so systemd ends only the runner and deliberately leaves
 * the children it means to keep. A sign-in that was waiting when the runner died used to be
 * marked interrupted while its provider CLI kept running: on 2026-11-06 one ran for eleven days
 * and many restarts before an unrelated inventory noticed it.
 *
 * What this proves, against real processes on this machine:
 *  1. A recorded sign-in process that is still alive is ended, together with the CLI its shell
 *     started, and the operation says so.
 *  2. A recorded process that is already gone is left alone and claims nothing.
 *  3. A recorded process whose identity cannot be proven is never signalled; the operation says
 *     the leftover could not be established.
 *  4. A process that does not lead its own group is signalled alone. Without this the negative
 *     form would reach the runner's own group — every agent session on the machine.
 *
 * The runner's own state folder is replaced with a temporary one before the module loads, so this
 * reads and reconciles no real sign-in journal.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONCIERGE_RUNNER_STATE = mkdtempSync(join(tmpdir(), "signin-leftover-fixture-"));

const { endLoginGroup } = await import("../src/auth-login");
const { endLeftoverSignIn } = await import("../src/runner-provider-accounts");
const { processIdentity, isProcessIdentityAlive } = await import("../src/runtime-identity");
type Identity = ReturnType<typeof processIdentity>;

const fail = (what: string): never => { console.error(`provider-signin-leftover-fixture: ${what}`); process.exit(1); };
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupOf = (pid: number): number | null => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[2]);
  } catch { return null; }
};

/** A stand-in for a waiting sign-in: a shell holding a long-lived child, in its own group. */
function startStandInSignIn(): { pid: number; identity: Identity; childPid: Promise<number> } {
  const child = spawn("sleep 600 & echo $!; wait", { shell: true, detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const pid = child.pid!;
  const childPid = new Promise<number>((resolve, reject) => {
    let seen = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      seen += chunk.toString();
      const line = seen.split("\n")[0];
      if (line?.trim()) resolve(Number(line.trim()));
    });
    setTimeout(() => reject(new Error("the stand-in never reported its child")), 5_000);
  });
  return { pid, identity: processIdentity(pid), childPid };
}

// 1. A live recorded sign-in is ended, and so is the CLI its shell started.
{
  const standIn = startStandInSignIn();
  const grandchild = await standIn.childPid;
  if (groupOf(standIn.pid) !== standIn.pid) fail("the stand-in sign-in did not lead its own group");
  if (!alive(grandchild)) fail("the stand-in sign-in did not start its own long-lived child");
  const detail = endLeftoverSignIn({ id: "signin:fixture-live", provider: "claude-code", process: standIn.identity });
  if (!detail?.includes("has been ended")) fail(`a live leftover should report that it was ended, got ${JSON.stringify(detail)}`);
  await settle(700);
  if (alive(standIn.pid)) fail("the leftover sign-in shell is still running");
  if (alive(grandchild)) fail("the sign-in command the shell started is still running; ending the shell alone is what leaked for eleven days");
}

// 2. A recorded process that is already gone claims nothing and signals nothing.
{
  const standIn = startStandInSignIn();
  await standIn.childPid;
  endLoginGroup(standIn.pid, "SIGKILL");
  await settle(500);
  if (alive(standIn.pid)) fail("the stand-in did not exit before the already-gone case");
  const detail = endLeftoverSignIn({ id: "signin:fixture-gone", provider: "claude-code", process: standIn.identity });
  if (detail !== null) fail(`a process that is already gone must claim nothing, got ${JSON.stringify(detail)}`);
}

// 3. An identity that cannot be proven is never signalled, and the operation says which case it is.
{
  for (const recorded of [undefined, { pid: 999_999 }, { pid: process.pid, startTicks: "1" }]) {
    const detail = endLeftoverSignIn({ id: "signin:fixture-unrecorded", provider: "claude-code", process: recorded });
    if (!detail?.includes("could not be established"))
      fail(`an incomplete record must say the leftover could not be established, got ${JSON.stringify(detail)}`);
  }
  // A complete identity from another boot is provably not any process running now.
  const otherBoot = { ...processIdentity(process.pid), bootId: "00000000-0000-0000-0000-000000000000" };
  if (isProcessIdentityAlive(otherBoot)) fail("an identity from another boot must never read as alive");
  if (endLeftoverSignIn({ id: "signin:fixture-other-boot", provider: "claude-code", process: otherBoot }) !== null)
    fail("an identity from another boot must claim nothing");
  if (!alive(process.pid)) fail("the unprovable cases signalled something");
}

// 4. A process that does not lead its own group is signalled alone, never its group.
{
  const follower = spawn("sleep 600", { shell: true, stdio: "ignore" });
  const pid = follower.pid!;
  await settle(200);
  if (groupOf(pid) === pid) fail("the follower unexpectedly leads its own group; this case would prove nothing");
  endLoginGroup(pid, "SIGKILL");
  await settle(400);
  if (alive(pid)) fail("a non-leader process was not ended");
  if (!alive(process.pid)) fail("ending a non-leader reached this fixture's own process group");
}

console.log("provider-signin-leftover-fixture: a sign-in command and its CLI are ended with their operation; unproven identities are never signalled, and a non-leader is signalled alone");
