import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

// Interactive provider logins on this headless host print an authorization URL
// and then wait on stdin for the code the provider shows after approval. The
// manager keeps that process alive between the Slack command that starts the
// login and the follow-up command that supplies the code, so the whole OAuth
// round trip can be completed from Slack without an SSH session.

export type AuthLoginStartResult =
  | { status: "awaiting_code"; url: string }
  | { status: "awaiting_approval"; url: string; userCode: string | null }
  | { status: "completed"; output: string }
  | { status: "failed"; output: string };

/**
 * How a provider's CLI finishes a login.
 *
 * `paste-code` waits on stdin for the code shown after approval, so the process
 * must stay alive until a second call supplies it. `device` shows a code to type
 * into the browser instead and completes on its own once approved, so there is
 * nothing to send back and the only thing to observe is the process exiting.
 */
export type AuthLoginFlow = "paste-code" | "device";

export type AuthLoginCompleteResult =
  | { status: "completed"; output: string }
  | { status: "failed"; output: string }
  | { status: "no_pending_login" };

type PendingLoginState = "starting" | "awaiting_code" | "awaiting_approval";

interface PendingLogin {
  process: ChildProcessWithoutNullStreams;
  output: string;
  exited: Promise<number | null>;
  state: PendingLoginState;
  expiry: ReturnType<typeof setTimeout> | null;
}

function stripTerminalEscapes(text: string): string {
  return text
    .replace(/\x1b\]8;;.*?(?:\x1b\\|\x07)/gs, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

// A URL is only complete once the provider has terminated it. During streaming
// we require trailing whitespace so a URL split across chunk boundaries is never
// returned truncated; once the process exits we accept the final token.
export function extractLoginUrl(output: string, options: { requireTerminator?: boolean } = {}): string | null {
  const clean = stripTerminalEscapes(output);
  const pattern = options.requireTerminator === false
    ? /https?:\/\/\S+/
    : /https?:\/\/\S+(?=\s)/;
  const match = clean.match(pattern);
  if (!match) return null;
  // stripTerminalEscapes leaves an OSC-8 hyperlink as target+visible-text
  // concatenated; keep only the first complete URL.
  const nested = match[0].indexOf("http", 1);
  return nested === -1 ? match[0] : match[0].slice(0, nested);
}

// A device-auth CLI shows a short code to type into the browser. It is grouped
// for readability and is the only such token the CLI prints, so the grouping is
// what identifies it rather than its position in the output.
//
// The groups are not evenly sized and their length is not ours to assume: Codex
// 0.153.4 prints `S8AM-GKSLB`, four then five. Requiring four and four matched
// nothing there, and because a device code cannot be guessed or worked around,
// that left the sign-in panel with an empty box and no way forward (2026-09-22).
// Accept any plausible grouping instead; the code is still the only uppercase
// hyphenated token in the output, which is what makes it identifiable.
export function extractUserCode(output: string): string | null {
  const clean = stripTerminalEscapes(output);
  const match = clean.match(/\b([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\b/);
  return match ? match[1] : null;
}

export class ProviderLoginManager {
  private readonly pending = new Map<string, PendingLogin>();

  constructor(private readonly options: {
    urlWaitMs?: number;
    completionWaitMs?: number;
    pendingTtlMs?: number;
    shutdownGraceMs?: number;
    onUnattendedCompletion?: (provider: string) => void;
  } = {}) {}

  hasPendingLogin(provider: string): boolean {
    return this.pending.has(provider);
  }

  async start(provider: string, command: string, cwd: string, flow: AuthLoginFlow = "paste-code"): Promise<AuthLoginStartResult> {
    // Reserve the provider slot before any await so a second concurrent start
    // finds and tears down this login instead of orphaning it.
    await this.abandon(provider);
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    const login: PendingLogin = {
      process: child,
      output: "",
      state: "starting",
      expiry: null,
      exited: new Promise((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      }),
    };
    this.pending.set(provider, login);
    const collect = (chunk: Buffer) => {
      login.output += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => { /* surfaced through completion timeout */ });

    const urlWaitMs = this.options.urlWaitMs ?? 20_000;
    const waitDeadline = Date.now() + urlWaitMs;
    let exitCode: number | null | undefined;
    void login.exited.then((code) => {
      exitCode = code;
    });
    // A device login is only presentable once both halves are on screen: the URL
    // to open and the code to type there. Waiting for both avoids showing him a
    // page that immediately asks for a code this call has not read yet.
    const presentable = () => flow === "device"
      ? !!extractLoginUrl(login.output) && !!extractUserCode(login.output)
      : !!extractLoginUrl(login.output);
    while (Date.now() < waitDeadline) {
      if (presentable()) break;
      if (exitCode !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // The login may have been superseded by a concurrent start while awaiting.
    if (this.pending.get(provider) !== login) {
      return { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }

    const url = extractLoginUrl(login.output);
    if (exitCode !== undefined) {
      this.pending.delete(provider);
      return exitCode === 0
        ? { status: "completed", output: stripTerminalEscapes(login.output).trim() }
        : { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }
    if (!url) {
      await this.abandon(provider);
      return { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }
    login.state = flow === "device" ? "awaiting_approval" : "awaiting_code";
    login.expiry = setTimeout(() => { void this.abandon(provider); }, this.options.pendingTtlMs ?? 10 * 60_000);
    // A login that finishes on its own (a browser flow that never asks for a
    // pasted code) still counts as a completed refresh.
    void login.exited.then((code) => {
      if (this.pending.get(provider) !== login) return;
      this.pending.delete(provider);
      if (login.expiry) clearTimeout(login.expiry);
      if (code === 0) this.options.onUnattendedCompletion?.(provider);
    });
    return flow === "device"
      ? { status: "awaiting_approval", url, userCode: extractUserCode(login.output) }
      : { status: "awaiting_code", url };
  }

  async complete(provider: string, code: string): Promise<AuthLoginCompleteResult> {
    const login = this.pending.get(provider);
    if (!login || login.state !== "awaiting_code") return { status: "no_pending_login" };
    this.pending.delete(provider);
    if (login.expiry) clearTimeout(login.expiry);
    try {
      login.process.stdin.write(`${code}\n`);
    } catch {
      login.process.kill("SIGTERM");
      return { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }
    const completionWaitMs = this.options.completionWaitMs ?? 60_000;
    const exitCode = await Promise.race([
      login.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), completionWaitMs)),
    ]);
    if (exitCode === "timeout") {
      await this.killChild(login);
      return { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }
    return exitCode === 0
      ? { status: "completed", output: stripTerminalEscapes(login.output).trim() }
      : { status: "failed", output: stripTerminalEscapes(login.output).trim() };
  }

  private async abandon(provider: string): Promise<void> {
    const login = this.pending.get(provider);
    if (!login) return;
    this.pending.delete(provider);
    if (login.expiry) clearTimeout(login.expiry);
    await this.killChild(login);
  }

  private async killChild(login: PendingLogin): Promise<void> {
    if (login.process.exitCode !== null || login.process.signalCode !== null) return;
    login.process.kill("SIGTERM");
    const graceMs = this.options.shutdownGraceMs ?? 2_000;
    const settled = await Promise.race([
      login.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!settled) login.process.kill("SIGKILL");
  }

  async stop(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((provider) => this.abandon(provider)));
  }
}
