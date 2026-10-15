import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { log } from "./log";

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

/** `security` exits 44 (errSecItemNotFound) when the item does not exist; any other failure means it could not be asked. */
const ITEM_NOT_FOUND = 44;
const unansweredSaid = new Set<string>();

/**
 * Whether the Keychain holds this home's login: present, absent, or not answered (a timeout, a
 * busy or locked Keychain). Only "absent" is evidence that the account has no login. On
 * 2026-10-15 a lookup during a restart of the Mac's owner dropped his personal account, at 19%
 * of its week, from the accounts it could launch, and his work was held "until October 18" on
 * the other, spent account.
 */
export function claudeKeychainLogin(home: string): "present" | "absent" | "unanswered" {
  if (process.platform !== "darwin") return "absent";
  const found = spawnSync(SECURITY, ["find-generic-password", "-s", claudeKeychainService(home)], { stdio: "ignore", timeout: 5_000 });
  if (found.status === 0) { unansweredSaid.delete(home); return "present"; }
  if (found.status === ITEM_NOT_FOUND) return "absent";
  if (!unansweredSaid.has(home)) {
    unansweredSaid.add(home);
    log("warn", "claude_keychain_lookup_unanswered", { status: found.status, signal: found.signal, error: found.error ? String(found.error) : null });
  }
  return "unanswered";
}

/** A login known to be there: what filing a finished sign-in needs before it moves anything. */
export function claudeKeychainHasLogin(home: string): boolean {
  return claudeKeychainLogin(home) === "present";
}

/** Not known to be missing: what listing and launching an account need. Claude itself says if it is signed out. */
export function claudeKeychainMayHoldLogin(home: string): boolean {
  return claudeKeychainLogin(home) !== "absent";
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
