import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { log } from "./log";
import { processIdentity, isProcessIdentityAlive, type ProcessIdentity } from "./runtime-identity";

// Interactive provider logins on this headless host print an authorization URL
// and then wait on stdin for the code the provider shows after approval. The
// manager keeps that process alive between the Slack command that starts the
// login and the follow-up command that supplies the code, so the whole OAuth
// round trip can be completed from Slack without an SSH session.

/**
 * Why a sign-in ended the way it did, in a word that can be logged and shown.
 *
 * Never the URL, the code or the output: those carry a one-time credential. The reason is
 * a fixed token chosen from this list, so it is safe everywhere and identical everywhere.
 */
export type AuthLoginFailure =
  | "no_url_before_timeout"   // the CLI ran but never printed a link we could read
  | "cli_exited"              // the CLI gave up or refused before presenting anything
  | "superseded";             // another sign-in for the same provider replaced this one

/**
 * Which process a sign-in is, recorded so a later run of this program can recognise it. Process
 * identity is `runtime-identity`'s: a process id alone names whatever now holds it, so proof is
 * the id together with the machine's boot and the process's own start time.
 */
export function loginProcessIdentity(pid: number | undefined): ProcessIdentity | null {
  if (typeof pid !== "number" || pid <= 1) return null;
  try { return processIdentity(pid); } catch { return null; }
}

/**
 * Whether this process leads its own group. Signalling a group reaches everything in it, and for
 * a child that never became a leader that is the runner's own group — every agent session on the
 * machine. So the group form is used only on this proof, never on the assumption that the spawn
 * asked for one.
 */
function leadsOwnGroup(pid: number): boolean {
  try {
    if (process.platform === "darwin") {
      const group = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
      return group.status === 0 && group.stdout.trim() === String(pid);
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the parenthesised command name begin at the line's third, so the
    // process group is at index 2.
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[2] === String(pid);
  } catch { return false; }
}

/**
 * Everything in this sign-in's process group, each by its own identity, read while the leader is
 * still alive and therefore while the group is provably the sign-in's.
 *
 * This is what makes the second signal safe. A shell that exits on the first one takes the group
 * with it, so after that moment the group number may belong to something else entirely and the
 * negative form can no longer be used; a member recorded here is still addressable on its own
 * proof. It is also what makes "ended" checkable: the CLI, not the shell, is the thing being
 * owned, and on 2026-11-17 a review reproduced this cleanup reporting success while a CLI that
 * ignores SIGTERM was still running.
 */
export function loginGroupMembers(leaderPid: number): ProcessIdentity[] {
  const pids = new Set<number>([leaderPid]);
  try {
    if (process.platform === "darwin") {
      const listed = spawnSync("/bin/ps", ["-o", "pid=", "-g", String(leaderPid)], { encoding: "utf8" });
      if (listed.status === 0) for (const line of listed.stdout.trim().split("\n")) {
        const pid = Number(line.trim());
        if (Number.isInteger(pid) && pid > 1) pids.add(pid);
      }
    } else {
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          if (stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[2] === String(leaderPid)) pids.add(pid);
        } catch { /* exited while being read */ }
      }
    }
  } catch { /* the leader alone is still a usable answer */ }
  const members: ProcessIdentity[] = [];
  for (const pid of pids) {
    const identity = loginProcessIdentity(pid);
    if (identity) members.push(identity);
  }
  return members;
}

/**
 * End a sign-in's whole process group, because a shell runs the provider CLI and ending the
 * shell alone leaves the CLI holding the sign-in. A negative id addresses the group; the plain
 * id is the fallback for a process that never became a group leader.
 */
export function endLoginGroup(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): void {
  if (typeof pid !== "number" || pid <= 1) return;
  if (leadsOwnGroup(pid)) {
    try { process.kill(-pid, signal); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ESRCH") return;
    }
  }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

export type AuthLoginStartResult =
  | { status: "awaiting_code"; url: string }
  | { status: "awaiting_approval"; url: string; userCode: string | null }
  | { status: "completed"; output: string }
  | { status: "failed"; output: string; reason: AuthLoginFailure };

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
  /** The sign-in page this login is waiting on, so a page that reloads, or lost its answer, can offer it again. */
  url: string | null;
  /**
   * The provider CLI and anything else in this login's group, each by its own identity, taken
   * while the shell was alive. Teardown needs them: the shell can exit on the polite signal
   * while the CLI it started ignores it, and after the shell goes the group number is no longer
   * provably this login's.
   */
  members: ProcessIdentity[];
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
  return undouble(match[0]);
}

/**
 * An OSC-8 hyperlink can survive stripping as its target followed by the same text, so the
 * token is that URL written twice. Cut it only when that is literally what it is.
 *
 * Cutting at the second "http" instead — which is what this did — truncates any URL whose
 * query carries an encoded one. Claude's authorize URL carries
 * `redirect_uri=https%3A%2F%2F…`, so every Claude sign-in link this produced ended at
 * `redirect_uri=` and Anthropic rejected it with "Missing redirect_uri parameter". Tejas
 * hit it at 22:42 on 2026-09-22 while trying to move to an account that still had room,
 * during a two-hour outage that one sign-in would have ended. It had been cutting there
 * since the login was first driven from a chat surface on 2026-09-03, so no Claude sign-in
 * through this path had ever been completable.
 *
 * A URL may contain another URL; that is ordinary. Only exact doubling is evidence of the
 * hyperlink residue, and only exact doubling is treated as it.
 */
function undouble(url: string): string {
  const half = url.length / 2;
  return Number.isInteger(half) && url.slice(0, half) === url.slice(half) ? url.slice(0, half) : url;
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
    /**
     * A sign-in he has started is work in progress, and until 2026-09-24 it was invisible:
     * it lived only in this process's memory, so a Concierge update threw it away mid-flow
     * and the page that was holding his code forgot there had ever been one. Announcing it
     * lets the update wait for it and lets a reloaded page find it again. `expiresAtMs` is
     * null when the sign-in is over, however it ended.
     */
    onPendingChanged?: (provider: string, expiresAtMs: number | null) => void;
    /**
     * Which process the sign-in became, the moment it exists. A caller that records this durably
     * can end a sign-in a dead run of this program left behind. It fires before the wait for the
     * provider's link, because that wait is where a runner restart is most likely to catch one.
     */
    onProcessStarted?: (provider: string, identity: ProcessIdentity) => void;
  } = {}) {}

  /** One place that owns "is a sign-in waiting", so nothing can drop it silently. */
  private announce(provider: string, expiresAtMs: number | null): void {
    try { this.options.onPendingChanged?.(provider, expiresAtMs); }
    catch (error) { log("warn", "provider_signin_announce_failed", { provider, error_name: (error as Error)?.name ?? "Error" }); }
  }

  hasPendingLogin(provider: string): boolean {
    return this.pending.has(provider);
  }

  /** The page a pasted-code sign-in is waiting on, while it waits for its code. */
  pendingLoginUrl(provider: string): string | null {
    const login = this.pending.get(provider);
    return login?.state === "awaiting_code" ? login.url : null;
  }

  /**
   * Which process this provider's waiting sign-in is, for a caller that records it durably so a
   * later run of this program can recognise and end a sign-in this one left behind.
   */
  pendingLoginProcess(provider: string): ProcessIdentity | null {
    return loginProcessIdentity(this.pending.get(provider)?.process.pid);
  }

  async start(provider: string, command: string, cwd: string, flow: AuthLoginFlow = "paste-code",
    env: Record<string, string> = {}): Promise<AuthLoginStartResult> {
    // Reserve the provider slot before any await so a second concurrent start
    // finds and tears down this login instead of orphaning it.
    await this.abandon(provider);
    const child = spawn(command, {
      cwd,
      shell: true,
      // `env` points a provider CLI at the home this login is for. Codex signs in by first
      // deleting its home's credential, so which home it runs against decides whether an
      // account already there survives.
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      // A shell runs the provider CLI, so the process we hold is not the one doing the
      // sign-in. Its own process group makes the pair one thing to end: signalling the
      // shell alone left `claude auth login` running for eleven days across many runner
      // restarts (2026-11-06 to 11-17), because the runner unit is KillMode=process and
      // its cgroup deliberately does not reap children it means to keep.
      detached: true,
    }) as ChildProcessWithoutNullStreams;
    const login: PendingLogin = {
      process: child,
      output: "",
      state: "starting",
      expiry: null,
      url: null,
      members: [],
      exited: new Promise((resolve) => {
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code));
      }),
    };
    this.pending.set(provider, login);
    const identity = loginProcessIdentity(child.pid);
    if (identity) {
      try { this.options.onProcessStarted?.(provider, identity); }
      catch (error) { log("warn", "provider_signin_process_record_failed", { provider, error_name: (error as Error)?.name ?? "Error" }); }
    } else log("warn", "provider_signin_process_unidentified", { provider });
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
      return this.record(provider, flow, { status: "failed", output: stripTerminalEscapes(login.output).trim(), reason: "superseded" });
    }

    const url = extractLoginUrl(login.output);
    if (exitCode !== undefined) {
      this.pending.delete(provider);
      return this.record(provider, flow, exitCode === 0
        ? { status: "completed", output: stripTerminalEscapes(login.output).trim() }
        : { status: "failed", output: stripTerminalEscapes(login.output).trim(), reason: "cli_exited" }, exitCode);
    }
    if (!url) {
      await this.abandon(provider);
      return this.record(provider, flow, { status: "failed", output: stripTerminalEscapes(login.output).trim(), reason: "no_url_before_timeout" });
    }
    login.state = flow === "device" ? "awaiting_approval" : "awaiting_code";
    login.url = url;
    // The CLI has printed its link, so it exists and the shell still leads the group: the one
    // moment where everything this login is can be recorded by its own identity, which teardown
    // needs after the shell has gone.
    login.members = loginGroupMembers(login.process.pid!);
    const ttlMs = this.options.pendingTtlMs ?? 10 * 60_000;
    login.expiry = setTimeout(() => { void this.abandon(provider); }, ttlMs);
    // Announced before the result is returned, so the sign-in is already holding updates
    // back by the time he is looking at the link.
    this.announce(provider, Date.now() + ttlMs);
    // A login that finishes on its own (a browser flow that never asks for a
    // pasted code) still counts as a completed refresh.
    void login.exited.then((code) => {
      if (this.pending.get(provider) !== login) return;
      this.pending.delete(provider);
      if (login.expiry) clearTimeout(login.expiry);
      this.announce(provider, null);
      if (code === 0) this.options.onUnattendedCompletion?.(provider);
    });
    return this.record(provider, flow, flow === "device"
      ? { status: "awaiting_approval", url, userCode: extractUserCode(login.output) }
      : { status: "awaiting_code", url });
  }

  /**
   * Every sign-in leaves a record of how it ended.
   *
   * It left none until 2026-09-24, and that is why this has been fixed twice and stayed
   * broken: the only trace of an attempt was a request line the owner writes solely when a
   * request is slow, so a fast failure was invisible on both machines, and "none of my tries
   * have been successful" could not be answered from anything but guesses. What is recorded
   * is the shape of the outcome — never the link, the code or the CLI's output, each of
   * which carries a one-time credential.
   */
  private record(provider: string, flow: AuthLoginFlow, result: AuthLoginStartResult, exitCode?: number | null): AuthLoginStartResult {
    log(result.status === "failed" ? "warn" : "info", "provider_signin_attempt", {
      provider,
      flow,
      outcome: result.status,
      reason: result.status === "failed" ? result.reason : null,
      url_presented: result.status === "awaiting_code" || result.status === "awaiting_approval",
      user_code_presented: result.status === "awaiting_approval" ? !!result.userCode : null,
      exit_code: exitCode ?? null,
    });
    return result;
  }

  async complete(provider: string, code: string): Promise<AuthLoginCompleteResult> {
    const login = this.pending.get(provider);
    if (!login || login.state !== "awaiting_code") {
      // The commonest way this happens is a Concierge update between his opening the link
      // and his pasting the code: the waiting CLI lives in this process, so a restart takes
      // it with it. He is not told his code was wrong, because it was not.
      log("warn", "provider_signin_code_had_nowhere_to_go", { provider, had_login: !!login, state: login?.state ?? null });
      return { status: "no_pending_login" };
    }
    this.pending.delete(provider);
    if (login.expiry) clearTimeout(login.expiry);
    this.announce(provider, null);
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
      log("warn", "provider_signin_completed", { provider, outcome: "failed", reason: "cli_never_settled" });
      return { status: "failed", output: stripTerminalEscapes(login.output).trim() };
    }
    log(exitCode === 0 ? "info" : "warn", "provider_signin_completed", {
      provider,
      outcome: exitCode === 0 ? "completed" : "failed",
      reason: exitCode === 0 ? null : "cli_rejected_code",
      exit_code: exitCode,
    });
    return exitCode === 0
      ? { status: "completed", output: stripTerminalEscapes(login.output).trim() }
      : { status: "failed", output: stripTerminalEscapes(login.output).trim() };
  }

  private async abandon(provider: string): Promise<void> {
    const login = this.pending.get(provider);
    if (!login) return;
    this.pending.delete(provider);
    if (login.expiry) clearTimeout(login.expiry);
    this.announce(provider, null);
    await this.killChild(login);
  }

  /**
   * End the whole login, then say so only once it is true. The shell's exit is not the answer:
   * the provider CLI it started can ignore the polite signal and outlive it, and a review
   * reproduced exactly that on 2026-11-17 while this reported success. So each member recorded
   * while the shell was alive is forced on its own identity, and a survivor is logged rather
   * than passed over.
   */
  private async killChild(login: PendingLogin): Promise<void> {
    const shellRunning = login.process.exitCode === null && login.process.signalCode === null;
    const members = shellRunning && login.process.pid
      ? [...new Map([...login.members, ...loginGroupMembers(login.process.pid)].map(member => [member.pid, member])).values()]
      : login.members;
    if (shellRunning) endLoginGroup(login.process.pid, "SIGTERM");
    else for (const member of members) if (isProcessIdentityAlive(member)) endLoginGroup(member.pid, "SIGTERM");
    const graceMs = this.options.shutdownGraceMs ?? 2_000;
    await Promise.race([
      // Both the shell and every recorded member must be gone, so a shell that exits first
      // cannot end the wait on the CLI's behalf.
      login.exited.then(async () => { while (members.some(isProcessIdentityAlive)) await new Promise(resolve => setTimeout(resolve, 100).unref()); }),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref()),
    ]);
    for (const member of members) if (isProcessIdentityAlive(member)) endLoginGroup(member.pid, "SIGKILL");
    if (login.process.exitCode === null && login.process.signalCode === null) endLoginGroup(login.process.pid, "SIGKILL");
    await new Promise(resolve => setTimeout(resolve, 200).unref());
    const surviving = members.filter(isProcessIdentityAlive);
    if (surviving.length) log("error", "provider_signin_teardown_survived", { surviving: surviving.length, members: members.length });
  }

  async stop(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((provider) => this.abandon(provider)));
  }
}
