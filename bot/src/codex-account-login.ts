import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderLoginManager, type AuthLoginStartResult } from "./auth-login";
import { CODEX_ACCOUNTS, profileId } from "./provider-accounts";
import { MANAGED_CODEX } from "./provider-activation";
import { log, errorFields } from "./log";

/**
 * Signing a Codex account in without destroying the one already here.
 *
 * Codex's device login deletes its home's `auth.json` before it starts, so signing in
 * inside `~/.codex` throws away the only live token this machine has for whoever was
 * there — and OpenAI can revoke that account outright because another account signed into
 * the same home (openai/codex#31162). On 2026-09-22 the Accounts screen did precisely
 * that and cost Tejas a working account. The rule against it was already written in
 * docs/architecture/PROVIDER-USAGE.md before that screen was built.
 *
 * So the new account is signed into a home of its own and only then made the active one.
 * `~/.codex` is never a place a login happens, which is what makes the loss impossible
 * rather than unlikely. Going through the CLI rather than the App Server's login API is
 * the price: that API always acts on the daemon's own home, and no code display is worth
 * an account he pays for.
 */

export type CodexSignInStart = AuthLoginStartResult;

export class CodexAccountLogin {
  private staging: string | null = null;

  constructor(
    private readonly manager: ProviderLoginManager,
    /** Put the freshly signed-in account into use, once it exists on its own. */
    private readonly activate: (home: string) => Promise<void>,
    private readonly command = `${MANAGED_CODEX} login --device-auth`,
  ) {}

  /**
   * A home the account lands in before it has a name. It cannot be named until Codex has
   * written the credential that says whose it is, and a dotted name keeps a half-finished
   * sign-in out of the list he chooses from.
   */
  private freshHome(): string {
    const home = join(CODEX_ACCOUNTS, `.signing-in-${randomUUID().slice(0, 8)}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return home;
  }

  private discard(home: string | null) {
    if (!home) return;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* a staging home is disposable */ }
  }

  /** The account a finished sign-in produced, read from what Codex wrote. */
  private signedInEmail(home: string): string | null {
    try {
      const token = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))?.tokens?.id_token;
      if (typeof token !== "string") return null;
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      return typeof claims?.email === "string" && claims.email ? claims.email : null;
    } catch { return null; }
  }

  /**
   * Give the finished sign-in its account's name and put it in use. Naming it by the
   * account means signing the same account in twice replaces its home rather than
   * collecting duplicates of one account under different names.
   */
  private async settle(home: string) {
    if (!existsSync(join(home, "auth.json"))) { this.discard(home); return; }
    const email = this.signedInEmail(home);
    let settled = home;
    if (email) {
      const named = join(CODEX_ACCOUNTS, profileId(email));
      if (named !== home) {
        try { rmSync(named, { recursive: true, force: true }); renameSync(home, named); settled = named; }
        catch (error) { log("warn", "codex_account_home_not_named", errorFields(error)); }
      }
    }
    this.staging = null;
    log("info", "codex_account_signed_in", { named: !!email });
    await this.activate(settled);
  }

  hasPending(): boolean { return this.manager.hasPendingLogin("codex"); }

  async start(): Promise<CodexSignInStart> {
    this.discard(this.staging);
    const home = this.freshHome();
    this.staging = home;
    const started = await this.manager.start("codex", this.command, homedir(), "device", { CODEX_HOME: home });
    if (started.status === "completed") { await this.settle(home); return started; }
    if (started.status === "failed") { this.discard(home); this.staging = null; }
    return started;
  }

  /** Codex finished on its own once he approved; the home it wrote is now an account. */
  async completed(): Promise<void> {
    const home = this.staging;
    if (!home) return;
    await this.settle(home);
  }

  async stop(): Promise<void> { this.discard(this.staging); this.staging = null; }
}
