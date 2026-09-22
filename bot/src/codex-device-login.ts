import { sharedCodexAppServerClient, type CodexAppServerClientLike } from "./codex-app-server-client";
import { log, errorFields } from "./log";

/**
 * Signing Codex into an account, asked of Codex rather than read off its screen.
 *
 * The App Server has a login API: `account/login/start` answers with the page to open and
 * the code to type there as fields, `account/login/completed` says when the human approved,
 * and `account/login/cancel` withdraws an attempt. The daemon performs the login itself, so
 * it holds the resulting token in memory and persists it — there is no file for this code to
 * write and no restart to make it take effect.
 *
 * What it replaces was a terminal transcript, parsed. That had one job and lost it: Codex
 * 0.153.4 groups its code as four characters then five, the reader expected four and four,
 * and Tejas was shown an empty box where the only thing that could have finished the sign-in
 * should have been (2026-09-22). A field cannot be the wrong shape.
 */

export type CodexLoginStart =
  | { status: "awaiting_approval"; url: string; userCode: string }
  | { status: "failed" };

type Pending = { loginId: string; startedAt: number };

/** Long enough for him to open the page on his phone and approve; the code expires first. */
const PENDING_TTL_MS = 15 * 60_000;

export class CodexDeviceLogin {
  private pending: Pending | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly client: CodexAppServerClientLike = sharedCodexAppServerClient(),
    private readonly onCompleted: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** A login is only pending while it could still be approved. */
  hasPending(): boolean {
    if (this.pending && this.now() - this.pending.startedAt > PENDING_TTL_MS) this.pending = null;
    return this.pending !== null;
  }

  /**
   * Codex reports the approval on its own connection, so the completion is observed rather
   * than waited for. The listener outlives one attempt because a reconnect would otherwise
   * lose the only signal that the account changed.
   */
  private listen() {
    if (this.unsubscribe) return;
    this.unsubscribe = this.client.onNotification((event: any) => {
      const method = event?.method ?? event?.type;
      if (method !== "account/login/completed" && method !== "account/updated") return;
      const loginId = event?.params?.loginId;
      if (method === "account/login/completed" && this.pending && loginId && loginId !== this.pending.loginId) return;
      this.pending = null;
      log("info", "codex_login_completed", { via: method });
      try { this.onCompleted(); } catch (error) { log("warn", "codex_login_completion_failed", errorFields(error)); }
    });
  }

  async start(): Promise<CodexLoginStart> {
    // A second start supersedes the first, exactly as a person pressing the button again means.
    await this.cancel();
    this.listen();
    try {
      const started = await this.client.request("account/login/start", { type: "chatgptDeviceCode" }, { requestTimeoutMs: 30_000 });
      const url = typeof started?.verificationUrl === "string" ? started.verificationUrl : null;
      const userCode = typeof started?.userCode === "string" ? started.userCode : null;
      const loginId = typeof started?.loginId === "string" ? started.loginId : null;
      if (!url || !userCode || !loginId) {
        // Every one of these is required to finish; a partial answer is a failure to say so,
        // not something to show him half of.
        log("warn", "codex_login_start_incomplete", { has_url: !!url, has_code: !!userCode, has_login_id: !!loginId });
        return { status: "failed" };
      }
      this.pending = { loginId, startedAt: this.now() };
      return { status: "awaiting_approval", url, userCode };
    } catch (error) {
      log("warn", "codex_login_start_failed", errorFields(error));
      return { status: "failed" };
    }
  }

  /** Withdraw an attempt he has abandoned, so Codex is not left waiting on it. */
  async cancel(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    try { await this.client.request("account/login/cancel", { loginId: pending.loginId }, { requestTimeoutMs: 15_000 }); }
    catch (error) { log("info", "codex_login_cancel_failed", errorFields(error)); }
  }

  async stop(): Promise<void> {
    await this.cancel();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** The account Codex is actually using, which is the one that runs his work. */
export async function codexAccountInUse(
  client: CodexAppServerClientLike = sharedCodexAppServerClient(),
): Promise<{ email: string | null; planType: string | null } | null> {
  try {
    const answer = await client.request("account/read", {}, { requestTimeoutMs: 15_000 });
    const account = answer?.account;
    if (!account) return null;
    return {
      email: typeof account.email === "string" && account.email ? account.email : null,
      planType: typeof account.planType === "string" && account.planType ? account.planType : null,
    };
  } catch { return null; }
}
