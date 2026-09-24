import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { authHeldInputCount, db, observeExecutionChanges, releaseAuthHeldWork } from "./state";
import { log } from "./log";
import { recordSessionEvent } from "./session-inputs";
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
type ReleaseSource = "owner_signin" | "file_event" | "keychain_event" | "turn_finished" | "startup" | "interval";
let pendingCodexActivation = false;
const activationFlights = new Map<ProviderKey, Promise<ActivationReport>>();

function releaseAuthHold(provider: ProviderKey, releasedBy: ReleaseSource): number {
  const head = db.query(`SELECT min(turns.id) AS id FROM turns JOIN sessions ON sessions.id=turns.session_id
    WHERE turns.status='queued' AND turns.dispatch_failure_class='auth_wait' AND sessions.provider_id=?`)
    .get(provider) as { id: number | null };
  const episode = head.id === null ? null : `provider-auth-hold:${provider}:${head.id}`;
  const notice = episode ? db.query(`SELECT session_id,input_id,turn_id FROM session_owner_events WHERE event_id=?`)
    .get(episode) as {session_id:number;input_id:string|null;turn_id:number|null}|null : null;
  const released = releaseAuthHeldWork(provider);
  if (!released) return 0;
  log("info", "provider_auth_hold_released", { provider, released_inputs: released, released_by: releasedBy });
  if (notice && episode) {
    try {
      recordSessionEvent({ eventId: `${episode}:resolved`,
        sessionId: notice.session_id, inputId: notice.input_id, turnId: notice.turn_id,
        kind: "provider_outage_resolved", payload: { provider, auth: { released_by: releasedBy, released_inputs: released } } });
    } catch(error) { log("error", "provider_auth_hold_resolution_failed", { provider, released_by: releasedBy,
      error: error instanceof Error ? error.message : String(error) }); }
  }
  return released;
}

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
async function performActivation(provider: ProviderKey, releasedBy: ReleaseSource): Promise<ActivationReport> {
  if (provider === "claude-code") {
    // Every `claude` run reads the credential file at launch, so there is no loaded copy to
    // invalidate — but the file being readable says nothing about it being usable.
    if (!await claudeCredentialsAnswer()) {
      log("warn", "provider_activation_failed", { provider, reason: "credentials_did_not_answer" });
      return { status: "failed", detail: "That account is signed in on disk but did not answer, "
        + "so this machine is not using it. Work waiting for the other account's allowance is still waiting." };
    }
    releaseUsageHeldWork(provider);
    releaseAuthHold(provider, releasedBy);
    return { status: "applied", detail: "Done. This machine is using the new account now." };
  }
  const report = await activateCodex();
  pendingCodexActivation = report.status === "deferred";
  // Codex only actually changes account when its App Server comes back on the new token.
  if (report.status === "applied") {
    const held=authHeldInputCount(provider)>0;
    if(held && !await codexCredentialsAnswer())return {status:'failed',
      detail:'Codex restarted, but this account did not answer. Your waiting messages remain held.'};
    releaseUsageHeldWork(provider);
    if(held)releaseAuthHold(provider, releasedBy);
  }
  return report;
}

export function activateCredentials(provider: ProviderKey, releasedBy: ReleaseSource = "owner_signin"): Promise<ActivationReport> {
  const existing = activationFlights.get(provider);
  if (existing) return existing;
  const flight = performActivation(provider, releasedBy).finally(() => activationFlights.delete(provider));
  activationFlights.set(provider, flight);
  return flight;
}

/** A login done outside Concierge still releases held inputs once its credentials answer. */
export function watchAuthHeldCredentials(): () => void {
  const providers:ProviderKey[]=['claude-code','codex'];
  let stopped=false;
  const checking=new Set<ProviderKey>();
  const watchers:FSWatcher[]=[];
  const debounce=new Map<ProviderKey,ReturnType<typeof setTimeout>>();
  let interval:ReturnType<typeof setInterval>|null=null;
  const held=()=>providers.some(provider=>authHeldInputCount(provider)>0);
  const updateInterval=()=>{
    if(stopped || !held()) { if(interval)clearInterval(interval);interval=null;return; }
    if(!interval){interval=setInterval(()=>{for(const provider of providers)check(provider,"interval");},180_000);interval.unref?.();}
  };
  const check=(provider:ProviderKey,source:ReleaseSource)=>{
    if(stopped || checking.has(provider) || (!authHeldInputCount(provider) && !(provider==='codex'&&pendingCodexActivation)))return;
    checking.add(provider);
    void activateCredentials(provider,source).catch(error=>log('error','provider_auth_hold_activation_failed',{
      provider,source,error:error instanceof Error?error.message:String(error)})).finally(()=>{checking.delete(provider);updateInterval();});
  };
  const watchCredential=(path:string,provider:ProviderKey,source:ReleaseSource)=>{
    try {
      const filename=basename(path);
      const watcher=watch(dirname(path),(event,changed)=>{
        if(changed && String(changed)!==filename)return;
        const prior=debounce.get(provider);if(prior)clearTimeout(prior);
        debounce.set(provider,setTimeout(()=>{debounce.delete(provider);check(provider,source);},350));
      });
      watcher.on('error',error=>log('error','provider_auth_hold_watch_failed',{provider,source,error:String(error)}));
      watchers.push(watcher);
    } catch(error){log('error','provider_auth_hold_watch_failed',{provider,source,error:String(error)});}
  };
  for(const provider of providers)watchCredential(credentialPath(provider),provider,'file_event');
  if(process.platform==='darwin'){
    try {
      const keychain=execFileSync('/usr/bin/security',['login-keychain','-d','user'],{encoding:'utf8'}).trim().replace(/^"|"$/g,'');
      if(keychain)watchCredential(keychain,'claude-code','keychain_event');
    } catch(error){log('error','provider_auth_hold_watch_failed',{provider:'claude-code',source:'keychain_event',error:String(error)});}
  }
  const detach=observeExecutionChanges(()=>{
    updateInterval();
    if(pendingCodexActivation && runningCodexTurns()===0)check('codex','turn_finished');
  });
  for(const provider of providers)check(provider,'startup');
  updateInterval();
  return ()=>{stopped=true;detach();if(interval)clearInterval(interval);
    for(const timer of debounce.values())clearTimeout(timer);for(const watcher of watchers)watcher.close();};
}
