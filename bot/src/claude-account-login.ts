import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderLoginManager, type AuthLoginStartResult, type AuthLoginCompleteResult } from "./auth-login";
import { CLAUDE_ACCOUNTS, accountHome, profileId } from "./provider-accounts";
import { forgetClaudeHomeCheck, sharedClaudeHome } from "./provider-account-dispatch";
import { log, errorFields } from "./log";

/**
 * Signing a Claude account in without touching any login already on this machine.
 *
 * The Accounts screen signed Claude in by running `claude auth login` against the default
 * home, `~/.claude`, which is the login every Claude session here is running on. Whatever he
 * signed in as replaced it. And a saved account whose login had lapsed had no way back at all:
 * its row offered only Switch, which was refused, and the refusal told him to "sign in to that
 * account again" with no control that could (tejas@chann.app, 2026-09-29, the fourth report).
 *
 * So, as Codex already does, a sign-in happens in a fresh folder of its own. Only once Claude
 * has written the login and said whose it is does it move into that account's home, and only
 * the login files move — the home's shared history link and anything else there stay. A login
 * that was already in that home is set aside, never deleted. Nothing is copied, so the account
 * ends up with exactly one login on this machine, independent of any other copy of the same
 * account elsewhere (the usage tool keeps its own; a copy of that one is what died).
 */

const CLAUDE_EXECUTABLE = process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude";
const LOGIN_FILES = [".credentials.json", ".claude.json"] as const;

export type ClaudeSignInFiled =
  | { status: "filed"; email: string; home: string; expected: string | null }
  | { status: "failed"; detail: string };

/** Who a Claude home is signed in as, asked of Claude itself. */
export async function claudeHomeEmail(home: string): Promise<string | null> {
  try {
    const child = Bun.spawn([CLAUDE_EXECUTABLE, "auth", "status", "--json"],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: home }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 15_000);
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    const status = JSON.parse(output) as { loggedIn?: boolean; email?: string };
    return status.loggedIn === true && typeof status.email === "string" && status.email ? status.email : null;
  } catch { return null; }
}

// An address is passed to a shell, so only an address-shaped value is ever passed.
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export class ClaudeAccountLogin {
  private staging: { home: string; expected: string | null } | null = null;

  constructor(private readonly manager: ProviderLoginManager) {}

  hasPending(): boolean { return this.manager.hasPendingLogin("claude-code"); }

  /** The account a waiting sign-in is for, when it was started from that account's row. */
  pendingFor(): string | null { return this.hasPending() ? this.staging?.expected ?? null : null; }

  private discard(home: string | null) {
    // A staging folder only ever holds what this sign-in wrote; nothing else lives there.
    if (home) try { rmSync(home, { recursive: true, force: true }); } catch { /* disposable */ }
  }

  /**
   * `expected` is the account he pressed sign-in on; Claude's page opens with that address
   * filled in. Null means a new account, named by whoever he signs in as.
   */
  async start(expected: string | null): Promise<AuthLoginStartResult> {
    this.discard(this.staging?.home ?? null);
    const home = join(CLAUDE_ACCOUNTS, `.signing-in-${randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const address = expected && ADDRESS.test(expected) ? expected : null;
    this.staging = { home, expected: address };
    const command = `${CLAUDE_EXECUTABLE} auth login${address ? ` --email '${address}'` : ""}`;
    const started = await this.manager.start("claude-code", command, homedir(), "paste-code", { CLAUDE_CONFIG_DIR: home });
    if (started.status === "failed") { this.discard(home); this.staging = null; }
    return started;
  }

  async complete(code: string): Promise<AuthLoginCompleteResult> {
    return this.manager.complete("claude-code", code);
  }

  /**
   * Give the finished sign-in its account's home. Called once Claude accepted the code (or
   * finished on its own); the staging folder is gone afterwards either way.
   */
  async file(): Promise<ClaudeSignInFiled> {
    const staging = this.staging;
    this.staging = null;
    if (!staging) return { status: "failed", detail: "This sign-in is no longer waiting. Start it again." };
    try {
      const email = await claudeHomeEmail(staging.home);
      if (!email || !existsSync(join(staging.home, ".credentials.json"))) {
        log("warn", "claude_account_signin_unfiled", { reason: "no_login_written" });
        return { status: "failed", detail: "Claude did not finish signing in. Nothing changed." };
      }
      const home = accountHome("claude-code", profileId(email));
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const stamp = Date.now();
      for (const name of LOGIN_FILES) {
        const from = join(staging.home, name), to = join(home, name);
        if (!existsSync(from)) continue;
        if (existsSync(to)) renameSync(to, `${to}.superseded-${stamp}`);
        renameSync(from, to);
      }
      writeFileSync(join(home, ".account-email"), email, { mode: 0o600 });
      // Every Claude home reads the one shared conversation history, or a switch refuses it.
      sharedClaudeHome(email, home, true);
      // A new login is unproven until the switch that follows it checks it.
      forgetClaudeHomeCheck(home);
      log("info", "claude_account_signed_in", { matched_expected: staging.expected ? staging.expected === email : null });
      return { status: "filed", email, home, expected: staging.expected };
    } catch (error) {
      log("warn", "claude_account_signin_unfiled", { reason: "file_failed", ...errorFields(error) });
      return { status: "failed", detail: "Signed in, but the login could not be kept on this machine. Nothing changed." };
    } finally {
      this.discard(staging.home);
    }
  }

  async stop(): Promise<void> { this.discard(this.staging?.home ?? null); this.staging = null; }
}
