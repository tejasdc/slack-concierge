import { spawn } from "node:child_process";
import { db } from "./state";
import { log } from "./log";
import type { ProviderKey } from "./provider-accounts";

// Making a credential change take effect on the provider runtime that is
// already running.
//
// A credential write and its activation are one operation on purpose. Codex
// reads ~/.codex/auth.json once at App Server start and keeps that token in
// memory, so writing a new account without restarting leaves the daemon using
// the old one and every dispatch keeps failing against credentials that are no
// longer on disk. Splitting those two steps is what turned a login into a
// remembered ritual; keeping them together is what removes it.

export type ActivationReport = Readonly<{ status: "applied" | "deferred" | "failed"; detail: string }>;

export const MANAGED_CODEX = process.env.CONCIERGE_CODEX_EXECUTABLE?.trim() || "/root/.codex/packages/standalone/current/codex";

/**
 * Codex turns still executing. Restarting under them would cut work that is
 * already in flight, so activation waits for the operator instead of deciding
 * for him.
 */
function runningCodexTurns(): number {
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM turns
      JOIN sessions ON sessions.id = turns.session_id
      WHERE turns.status = 'running' AND sessions.provider_id = 'codex'`)
      .get() as { count: number } | null;
    return row?.count ?? 0;
  } catch {
    // An unreadable queue is not evidence that restarting is safe.
    return -1;
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    // Spawned from the bot, so this inherits concierge-bot.service's
    // LimitNOFILE. A daemon started from an interactive shell instead inherits
    // that shell's 1024 and exhausts it re-opening observer subscriptions; that
    // is why this restart belongs here and not in an SSH session.
    const child = spawn(command, args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, output }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function activateCodex(): Promise<ActivationReport> {
  const running = runningCodexTurns();
  if (running !== 0) {
    return {
      status: "deferred",
      detail: running < 0
        ? "Signed in. The new account starts being used once the Codex App Server restarts; its work queue could not be read, so nothing was restarted."
        : `Signed in. ${running} Codex ${running === 1 ? "turn is" : "turns are"} still running, so the App Server was left alone. The new account takes effect the next time it restarts.`,
    };
  }
  const restart = await run(MANAGED_CODEX, ["app-server", "daemon", "restart"], 90_000);
  if (restart.code !== 0) {
    log("warn", "provider_activation_failed", { provider: "codex", exit_code: restart.code });
    return { status: "failed", detail: "Signed in, but the Codex App Server did not restart, so it is still using the previous account." };
  }
  const version = await run(MANAGED_CODEX, ["app-server", "daemon", "version"], 20_000);
  const healthy = version.code === 0 && version.output.includes("\"backend\":\"pid\"");
  log("info", "provider_activation_applied", { provider: "codex", healthy });
  return healthy
    ? { status: "applied", detail: "Signed in and the Codex App Server restarted, so the new account is in use now." }
    : { status: "failed", detail: "Signed in and the Codex App Server restarted, but it did not report a healthy backend." };
}

/**
 * Make the credentials currently on disk the ones the provider actually uses.
 * Safe to call after either a fresh login or a profile switch.
 */
export async function activateCredentials(provider: ProviderKey): Promise<ActivationReport> {
  if (provider === "claude-code") {
    // Every `claude` run reads the credential file at launch, so there is no
    // loaded copy to invalidate.
    return { status: "applied", detail: "Signed in. Claude Code reads its credentials on each run, so the new account is already in use." };
  }
  return activateCodex();
}
