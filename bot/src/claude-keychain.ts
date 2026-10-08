import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * On a Mac, Claude Code keeps a login in the login Keychain, not in `.credentials.json`: one
 * generic password per config folder, its service named from a hash of that folder's path. So a
 * sign-in finished in a staging folder lives under the staging folder's name, and moving the
 * folder's files leaves it behind. The Mac's browser agent signed in his personal account on
 * 2026-10-08 and Accounts answered "Claude did not finish signing in" because filing looked only
 * for the file. The login is moved, never copied: written under the account home's name, read
 * back, and only then removed from the staging name.
 */
const SECURITY = "/usr/bin/security";

export function claudeKeychainService(home: string): string {
  return `Claude Code-credentials-${createHash("sha256").update(home.replace(/\/+$/, "")).digest("hex").slice(0, 8)}`;
}

export function claudeKeychainHasLogin(home: string): boolean {
  if (process.platform !== "darwin") return false;
  return spawnSync(SECURITY, ["find-generic-password", "-s", claudeKeychainService(home)], { stdio: "ignore", timeout: 5_000 }).status === 0;
}

function readSecret(service: string): string | null {
  const read = spawnSync(SECURITY, ["find-generic-password", "-s", service, "-w"], { encoding: "utf8", timeout: 5_000 });
  if (read.status !== 0) return null;
  const secret = read.stdout.replace(/\n$/, "");
  // Claude stores JSON; anything else (security prints binary data as hex) is not moved blindly.
  return secret.startsWith("{") ? secret : null;
}

function account(service: string): string | null {
  const found = spawnSync(SECURITY, ["find-generic-password", "-s", service], { encoding: "utf8", timeout: 5_000 });
  return found.status === 0 ? /"acct"<blob>="([^"]*)"/.exec(found.stdout)?.[1] ?? null : null;
}

/** Moves the login Claude wrote for `from` to `to`'s name. The secret goes over stdin, never argv. */
export function moveClaudeKeychainLogin(from: string, to: string): boolean {
  const source = claudeKeychainService(from), target = claudeKeychainService(to);
  const secret = readSecret(source), owner = account(source);
  if (!secret || !owner || /["\\\n]/.test(owner)) return false;
  const hex = Buffer.from(secret, "utf8").toString("hex");
  const write = spawnSync(SECURITY, ["-i"], { input: `add-generic-password -U -a "${owner}" -s "${target}" -X ${hex}\n`, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
  if (write.status !== 0 || readSecret(target) !== secret) return false;
  spawnSync(SECURITY, ["delete-generic-password", "-s", source], { stdio: "ignore", timeout: 5_000 });
  return true;
}
