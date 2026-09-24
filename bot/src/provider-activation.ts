import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { watchFile, unwatchFile } from "node:fs";
import { authHeldInputCount, db, releaseAuthHeldWork } from "./state";
import { log } from "./log";
import { releaseUsageHeldWork } from "./provider-usage";
import { credentialPath, type ProviderKey } from "./provider-accounts";

// Making a credential change take effect on the provider runtime that is
// already running.
//
// A credential write and its activation are one operation on purpose. Codex
// reads ~/.codex/auth.json once at App Server start and keeps that token in
// memory, so writing a new account without restarting leaves the daemon using
// the old one and every dispatch keeps failing against credentials that are no
// longer on disk. Splitting those two steps is what turned a login into a
// remembered ritual; keeping them together is what removes it.

export type ActivationReport = Readonly<{ status: "applied" | "deferred" | "failed"; detail: string }>;

export const MANAGED_CODEX = process.env.CONCIERGE_CODEX_EXECUTABLE?.trim()
  || (process.platform==='darwin'?join(homedir(),'.local','bin','codex'):'/root/.codex/packages/standalone/current/codex');

/**
 * Codex turns still executing. Restarting under them would cut work that is
 * already in flight, so activation waits for the operator instead of deciding
 * for him.
 */
function runningCodexTurns(): number {
  try {
    const row = db.query(`SELECT COUNT(*) AS count FROM turns
      JOIN sessions ON sessions.id = turns.session_id
      WHERE turns.status = 'running' AND sessions.provider_id = 'codex'`)
      .get() as { count: number } | null;
    return row?.count ?? 0;
  } catch {
    // An unreadable queue is not evidence that restarting is safe.
    return -1;
  }
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise(resolve => {
    // Spawned from the bot, so this inherits concierge-bot.service's
    // LimitNOFILE. A daemon started from an interactive shell instead inherits
    // that shell's 1024 and exhausts it re-opening observer subscriptions; that
    // is why this restart belongs here and not in an SSH session.
    const child = spawn(command, args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, output }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function activateCodex(): Promise<ActivationReport> {
  const running = runningCodexTurns();
  if (running !== 0) {
    return {
      status: "deferred",
      detail: running < 0
        ? "Signed in. This machine will start using the new account once Codex restarts here; it could not be checked for running work just now, so nothing was restarted."
        : `Signed in. ${running} Codex ${running === 1 ? "session is" : "sessions are"} still working on this machine, so it was left alone. It moves to the new account once that work finishes.`,
    };
  }
  const restart = await run(MANAGED_CODEX, ["app-server", "daemon", "restart"], 90_000);
  if (restart.code !== 0) {
    log("warn", "provider_activation_failed", { provider: "codex", exit_code: restart.code });
    return { status: "failed", detail: "Signed in, but this machine did not pick the new account up. It is still on the one it was using." };
  }
  const version = await run(MANAGED_CODEX, ["app-server", "daemon", "version"], 20_000);
  const healthy = version.code === 0 && version.output.includes("\"backend\":\"pid\"");
  log("info", "provider_activation_applied", { provider: "codex", healthy });
  return healthy
    ? { status: "applied", detail: "Done. This machine is using the new account now." }
    : { status: "failed", detail: "Signed in, and this machine restarted Codex, but Codex did not come back healthy here." };
}

/**
 * Make the credentials currently on disk the ones the provider actually uses.
 * Safe to call after either a fresh login or a profile switch.
 */
/**
 * One real request on the credentials now on disk, because "the file is in place" and "this
 * account can work" are different claims.
 *
 * A saved credential is a snapshot: its access token expires, and its refresh token may have
 * been rotated since the copy was taken, which no amount of copying can detect. The switch
 * on 2026-09-23 restored a snapshot whose token had expired eleven hours earlier, reported
 * success, and every dispatch after it failed to authenticate.
 */
async function claudeCredentialsAnswer(): Promise<boolean> {
  const started = Date.now();
  const probe = await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude",
    ["-p", "--model", "claude-haiku-4-5-20251001", "--no-session-persistence",
      "--output-format", "json", "Reply with the single word OK."], 90_000);
  let ok = probe.code === 0;
  if (ok) { try { ok = JSON.parse(probe.output).is_error !== true; } catch { ok = false; } }
  log("info", "provider_activation_probed", { provider: "claude-code", ok, duration_ms: Date.now() - started });
  return ok;
}

async function codexCredentialsAnswer():Promise<boolean>{
  const probe=await run(MANAGED_CODEX,['-s','read-only','-a','never','exec','--skip-git-repo-check',
    '-m','gpt-6-luna','Reply with the single word OK.'],90_000);
  const ok=probe.code===0 && /\bOK\b/.test(probe.output);
  log('info','provider_activation_probed',{provider:'codex',ok});
  return ok;
}

/**
 * Make the credentials currently on disk the ones the provider actually uses.
 * Safe to call after either a fresh login or a profile switch.
 *
 * **Work held for the old account's reset is released only once the new account has
 * answered.** It used to be released first, unconditionally, before anything checked whether
 * the new credentials worked. On 2026-09-23 that turned seven turns that were safely parked
 * until the allowance returned at 21:10 into seven terminal failures against a credential
 * that could not authenticate — switching was strictly worse than doing nothing. Work that
 * is waiting is in a good state; nothing may take it out of that state on the strength of a
 * file copy.
 */
export async function activateCredentials(provider: ProviderKey): Promise<ActivationReport> {
  if (provider === "claude-code") {
    // Every `claude` run reads the credential file at launch, so there is no loaded copy to
    // invalidate — but the file being readable says nothing about it being usable.
    if (!await claudeCredentialsAnswer()) {
      log("warn", "provider_activation_failed", { provider, reason: "credentials_did_not_answer" });
      return { status: "failed", detail: "That account is signed in on disk but did not answer, "
        + "so this machine is not using it. Work waiting for the other account's allowance is still waiting." };
    }
    releaseUsageHeldWork(provider);
    releaseAuthHeldWork(provider);
    return { status: "applied", detail: "Done. This machine is using the new account now." };
  }
  const report = await activateCodex();
  // Codex only actually changes account when its App Server comes back on the new token.
  if (report.status === "applied") {
    const held=authHeldInputCount(provider)>0;
    if(held && !await codexCredentialsAnswer())return {status:'failed',
      detail:'Codex restarted, but this account did not answer. Your waiting messages remain held.'};
    releaseUsageHeldWork(provider);
    if(held)releaseAuthHeldWork(provider);
  }
  return report;
}

/** A login done outside Concierge still releases held inputs once its credentials answer. */
export function watchAuthHeldCredentials(): () => void {
  const providers:ProviderKey[]=['claude-code','codex'];
  let stopped=false;
  const checking=new Set<ProviderKey>();
  const check=(provider:ProviderKey)=>{
    if(stopped || checking.has(provider) || !authHeldInputCount(provider))return;
    checking.add(provider);
    void activateCredentials(provider).catch(error=>log('error','provider_auth_hold_activation_failed',{
      provider,error:error instanceof Error?error.message:String(error)})).finally(()=>checking.delete(provider));
  };
  for(const provider of providers){
    const path=credentialPath(provider);
    watchFile(path,{interval:5_000},(current,previous)=>{
      if(current.mtimeMs!==previous.mtimeMs || current.size!==previous.size)check(provider);
    });
    // Covers a credential updated while the owner was stopped. A failed probe retains
    // the hold; it never retries the original provider turn on faith in file contents.
    check(provider);
  }
  // Also notices macOS Keychain sign-in, which has no credential file to watch, and
  // retries a deferred Codex activation after other running turns finish.
  const interval=setInterval(()=>{for(const provider of providers)check(provider);},180_000);
  interval.unref?.();
  return ()=>{stopped=true;clearInterval(interval);for(const provider of providers)unwatchFile(credentialPath(provider));};
}
