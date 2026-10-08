import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { log } from "./log";

const run = promisify(execFile);

/**
 * The shared Codex daemon keeps files open for every conversation Concierge follows, and it
 * takes its open-file limit from whoever started it. Started by Concierge it inherits the
 * service's limit; started by any `codex` command in an SSH login (the first one after the daemon
 * stops starts it) it gets that login's 1,024. On 2026-10-07 a daemon started from an SSH login at
 * 6:39 PM ran out at 7:24 PM, and Concierge's update restart failed because the daemon could not
 * open its own settings file. Who starts it cannot be controlled, so every time Concierge connects
 * it raises the daemon's soft limit to its hard limit, which a root process may do for another.
 */
export async function raiseCodexDaemonFileLimit() {
  if (process.platform !== "linux") return;
  for (const pid of codexDaemonPids()) {
    const limit = openFileLimit(pid);
    if (!limit || limit.soft >= limit.hard) continue;
    try {
      await run("prlimit", ["--pid", String(pid), `--nofile=${limit.hard}:${limit.hard}`], { timeout: 5_000 });
      log("warn", "codex_daemon_file_limit_raised", { pid, from: limit.soft, to: limit.hard });
    } catch (error) {
      log("error", "codex_daemon_file_limit_unraised", { pid, soft: limit.soft, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** The long-lived daemon and its proxy; per-turn `app-server --stdio` children belong to their own parents. */
function codexDaemonPids(): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try { argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!/(^|\/)codex$/.test(argv[0] ?? "") || !argv.includes("app-server") || argv.includes("--stdio")) continue;
    pids.push(Number(entry));
  }
  return pids;
}

function openFileLimit(pid: number): { soft: number; hard: number } | null {
  try {
    const line = readFileSync(`/proc/${pid}/limits`, "utf8").split("\n").find(value => value.startsWith("Max open files"));
    const [soft, hard] = (line?.match(/(\d+|unlimited)\s+(\d+|unlimited)/)?.slice(1) ?? []).map(value => value === "unlimited" ? Infinity : Number(value));
    return soft !== undefined && hard !== undefined && Number.isFinite(hard) ? { soft, hard } : null;
  } catch { return null; }
}
