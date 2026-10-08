import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { log } from "./log";
import { codexUpdaterDisabled } from "./codex-updater-settings";

const run = promisify(execFile);

export const MANAGED_CODEX = process.env.CONCIERGE_CODEX_EXECUTABLE?.trim()
  || (process.platform==='darwin'?join(homedir(),'.local','bin','codex'):'/root/.codex/packages/standalone/current/codex');

let daemonStart: Promise<void> | null = null;
let lastDaemonStartAt = 0;

/**
 * When nothing answers on the control socket, start the daemon through its manager, the same
 * command concierge-bot.service runs before it starts. On 2026-10-08 at 3:53 PM Codex updated
 * itself; its replacement server quit because the old one still held the socket, nothing managed
 * came back, and the next SSH connection from the Mac's Codex app started an unmanaged server of
 * its own, which account switching and the updater cannot manage. The host now tells that app not
 * to start one (install-codex-stop-hook.sh), so this is the one path that brings the server back.
 * `daemon start` answers alreadyRunning when one is up. It inherits this service's open-file limit
 * (a scope takes no LimitNOFILE), and raiseCodexDaemonFileLimit lifts the soft limit on connect.
 * At most one start runs, and not more often than every 30 seconds while the socket refuses.
 */
export function startCodexDaemonWhenAbsent(reason: string) {
  if (process.platform !== "linux" || daemonStart || Date.now() - lastDaemonStartAt < 30_000) return;
  lastDaemonStartAt = Date.now();
  if (!codexUpdaterDisabled()) {
    log("error", "codex_daemon_start_failed", { reason, error: "Codex automatic App Server updates are not disabled." });
    return;
  }
  daemonStart = run("systemd-run", ["--scope", "--collect", "--quiet", "--description=Shared Codex App Server",
    MANAGED_CODEX, "app-server", "daemon", "start"], { timeout: 60_000 })
    .then(({ stdout }) => log("warn", "codex_daemon_started_when_absent", { reason, answer: stdout.trim().slice(0, 300) }))
    .catch((error: unknown) => log("error", "codex_daemon_start_failed", { reason, error: error instanceof Error ? error.message : String(error) }))
    .finally(() => { daemonStart = null; });
}

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

const OWN_SCOPE = /^\/system\.slice\/codex-app-server(-\d+)?\.scope$/;

/**
 * systemd ends every process in a unit's cgroup when the unit stops, and a detached daemon stays in
 * the cgroup of whoever started it. On 2026-10-08 the daemon lived in an SSH login and died at
 * 6:47 AM when that login closed; the next one was started inside an agent's execution host, and
 * the one after by Concierge's own account switch, inside the service an update restarts. Who
 * starts it cannot be controlled, so every time Concierge connects it moves the daemon, its
 * updater and their children into a scope of their own, which nothing else stops. Each move makes
 * a new scope named after its first process, because systemd moves processes only into a scope it
 * is creating (an existing scope refuses them unless delegated); an emptied scope is collected.
 */
export async function moveCodexDaemonToOwnScope() {
  if (process.platform !== "linux") return;
  const roots = codexDaemonPids({ includeProxies: false }).filter(pid => !OWN_SCOPE.test(cgroupOf(pid)));
  if (roots.length === 0) return;
  const pids = withDescendants(roots);
  const from = [...new Set(roots.map(cgroupOf))];
  const scope = `codex-app-server-${Math.min(...roots)}.scope`;
  try {
    await run("busctl", ["call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
      "StartTransientUnit", "ssa(sv)a(sa(sv))", scope, "fail", "3", "PIDs", "au", String(pids.length), ...pids.map(String),
      "Description", "s", "Shared Codex App Server", "CollectMode", "s", "inactive-or-failed", "0"], { timeout: 5_000 });
  } catch (error) {
    // Connections open several at a time; another one may have just made this same move.
    if (roots.every(pid => OWN_SCOPE.test(cgroupOf(pid)))) return;
    log("error", "codex_daemon_scope_move_failed", { pids, from, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  log("warn", "codex_daemon_moved_to_own_scope", { scope, pids, from });
}

/** The long-lived daemon and its proxy; per-turn `app-server --stdio` children belong to their own parents. */
function codexDaemonPids({ includeProxies = true } = {}): number[] {
  const pids: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let argv: string[];
    try { argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean); } catch { continue; }
    if (!/(^|\/)codex$/.test(argv[0] ?? "") || !argv.includes("app-server") || argv.includes("--stdio")) continue;
    // A proxy belongs to the client connection that opened it, not to the daemon.
    if (!includeProxies && argv.includes("proxy")) continue;
    pids.push(Number(entry));
  }
  return pids;
}

function cgroupOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().replace(/^0::/, ""); } catch { return ""; }
}

function withDescendants(roots: number[]): number[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    children.set(ppid, [...children.get(ppid) ?? [], Number(entry)]);
  }
  const all = new Set<number>();
  const pending = [...roots];
  while (pending.length) {
    const pid = pending.pop()!;
    if (all.has(pid)) continue;
    all.add(pid);
    pending.push(...children.get(pid) ?? []);
  }
  return [...all];
}

function openFileLimit(pid: number): { soft: number; hard: number } | null {
  try {
    const line = readFileSync(`/proc/${pid}/limits`, "utf8").split("\n").find(value => value.startsWith("Max open files"));
    const [soft, hard] = (line?.match(/(\d+|unlimited)\s+(\d+|unlimited)/)?.slice(1) ?? []).map(value => value === "unlimited" ? Infinity : Number(value));
    return soft !== undefined && hard !== undefined && Number.isFinite(hard) ? { soft, hard } : null;
  } catch { return null; }
}
