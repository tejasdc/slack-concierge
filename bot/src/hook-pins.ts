/**
 * Which helper folder the machine-wide hooks run for a shared-daemon Codex conversation.
 *
 * A run Concierge starts in an execution host carries its own helper folder in its environment, so
 * the managed hook wrappers (scripts/install-codex-stop-hook.sh) run the hooks of the version that
 * started it. A turn in the shared Codex daemon has the daemon's environment, which is the same for
 * every turn, so it cannot carry that. Instead, when such a turn starts, the coordinator files the
 * helper folder of the installed release under the Codex conversation id, and the wrappers, which
 * receive that id as `session_id` on stdin, look it up there. Release folders are immutable and
 * kept, so the hooks under a running turn never change when an update installs.
 *
 * One file per conversation: `<state>/hook-pins/codex/<thread-id>`, first line the helper folder,
 * second line the execution that filed it (so only that execution removes it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The marker the wrappers carry when they look up these pins; older wrappers ignore them. */
export const HOOK_DISPATCH_MARKER = "# dispatch: per-run v2";

const THREAD_ID = /^[A-Za-z0-9-]{1,128}$/;
const pinDirectory = (stateDir: string) => join(stateDir, "hook-pins", "codex");

export function pinCodexThreadHooks(stateDir: string, threadId: string, executionId: string, botDir: string) {
  if (!THREAD_ID.test(threadId)) return;
  const directory = pinDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, threadId), temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${botDir}\n${executionId}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

export function unpinCodexThreadHooks(stateDir: string, threadId: string, executionId: string) {
  if (!THREAD_ID.test(threadId)) return;
  const target = join(pinDirectory(stateDir), threadId);
  try { if (readFileSync(target, "utf8").split("\n")[1] === executionId) rmSync(target, { force: true }); } catch {}
}

/**
 * Whether this machine's installed hook wrappers follow each run's own helpers, including shared
 * Codex turns. Read from the installed wrappers themselves, so a machine whose wrappers are older
 * (the Mac until its password step) keeps waiting for those turns.
 */
export function managedHooksFollowRuns(codexSystemDir = process.env.CODEX_SYSTEM_DIR || "/etc/codex"): boolean {
  for (const hook of ["concierge-owed-reply", "concierge-history-guard"]) {
    const path = join(codexSystemDir, "hooks", hook);
    try { if (!existsSync(path) || !readFileSync(path, "utf8").includes(HOOK_DISPATCH_MARKER)) return false; } catch { return false; }
  }
  return true;
}
