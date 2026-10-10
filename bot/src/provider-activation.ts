import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { forgetAccountFiles } from "./account-files-memo";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { authHeldInputCount, db, holdCodexAdmission, observeExecutionChanges, releaseAuthHeldWork } from "./state";
import { log } from "./log";
import { recordSessionEvent } from "./session-inputs";
import { releaseUsageHeldWork } from "./provider-usage";
import { credentialPath, currentAccount, type ProviderKey } from "./provider-accounts";
import { sharedCodexAppServerClient } from "./codex-app-server-client";
import { MANAGED_CODEX, controlSocketListeners, holdCodexDaemonAutoStart, startCodexDaemonInOwnScope } from "./codex-daemon-file-limit";
import { createConnection } from "node:net";
import { codexUpdaterDisabled } from "./codex-updater-settings";
import { RETRY_POLICIES } from "./retry-policies";
import { withRetry } from "./retry-core";
import { CLAUDE_AGENT_HOOK_SETTINGS } from "./claude-code";
import { claudeRunsFromOwnHomes, selectedClaudeHome } from "./provider-account-dispatch";
import { providerOwnerEnvironment } from "./provider-owner-environment";
import { isClaudeUsageExhaustion } from "./provider-failures";

// Making a credential change take effect on the provider runtime that is
// already running.
//
// A credential write and its activation are one operation on purpose. Codex
// reads ~/.codex/auth.json once at App Server start and keeps that token in
// memory, so writing a new account without restarting leaves the daemon using
// the old one and every dispatch keeps failing against credentials that are no
// longer on disk. Splitting those two steps is what turned a login into a
// remembered ritual; keeping them together is what removes it.

export type ActivationReport = Readonly<{ status: "applied" | "deferred" | "failed"; detail: string; restartFailed?: boolean }>;
type ReleaseSource = "owner_signin" | "file_event" | "keychain_event" | "turn_finished" | "startup" | "interval" | "home_proven";
let pendingCodexActivation = false;
const activationFlights = new Map<ProviderKey, Promise<ActivationReport>>();

export function releaseAuthHold(provider: ProviderKey, releasedBy: ReleaseSource): number {
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

export { MANAGED_CODEX };

/**
 * Codex turns still executing. Restarting under them would cut work that is
 * already in flight, so activation waits for the operator instead of deciding
 * for him.
 */
export function runningCodexTurns(): number {
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

function run(command: string, args: string[], timeoutMs: number, environment:NodeJS.ProcessEnv={...process.env}, cwd?:string): Promise<{ code: number | null; output: string; timedOut?: boolean }> {
  return new Promise(resolve => {
    // Spawned from the bot, so this inherits concierge-bot.service's
    // LimitNOFILE. A daemon started from an interactive shell instead inherits
    // that shell's 1024 and exhausts it re-opening observer subscriptions; that
    // is why this restart belongs here and not in an SSH session.
    const child = spawn(command, args, { env: environment, stdio: ["ignore", "pipe", "pipe"], ...(cwd ? { cwd } : {}) });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString(); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, output, timedOut }); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}

// One Codex restart at a time: a switch that arrives during a replacement waits for it and then
// restarts onto its own account, rather than sharing a result that loaded the old one.
let codexRestarts: Promise<unknown> = Promise.resolve();
function oneCodexRestartAtATime<T>(work: () => Promise<T>): Promise<T> {
  const next = codexRestarts.then(work, work);
  codexRestarts = next.catch(() => undefined);
  return next;
}

function activateCodex(): Promise<ActivationReport> { return oneCodexRestartAtATime(activateCodexNow); }
async function activateCodexNow(): Promise<ActivationReport> {
  // New Codex work is held for the few seconds of the restart, and only then is running work
  // counted: counting first left a window in which a turn could be claimed onto a server about to
  // stop (outage review, 2026-10-08). Running work is never waited on here; the restart is
  // deferred and retried when it finishes, so nothing queued is held while an agent works.
  holdCodexAdmission(true);
  try {
    const running = runningCodexTurns();
    if (running !== 0) {
      return {
        status: "deferred",
        detail: running < 0
          ? "Signed in. This machine will start using the new account once Codex restarts here; it could not be checked for running work just now, so nothing was restarted."
          : `Signed in. ${running} Codex ${running === 1 ? "session is" : "sessions are"} still working on this machine, so it was left alone. It moves to the new account once that work finishes.`,
      };
    }
    if (!codexUpdaterDisabled()) {
      log("error", "provider_activation_failed", { provider: "codex", reason: "automatic_updater_not_disabled" });
      return { status: "failed", restartFailed: true,
        detail: "Codex's automatic background update setting could not be confirmed, so its service was left running. Your sign-in is kept; nothing was switched." };
    }
    const before = await run(MANAGED_CODEX, ["app-server", "daemon", "version"], 20_000);
    const unmanaged = before.code === 0 && before.output.includes("\"running\"") && !before.output.includes("\"backend\"");
    // The replacement finds servers through /proc, so it runs only on the server; a Mac keeps the
    // old answer below and its own installer's managed start.
    if (unmanaged && process.platform !== "linux") {
      log("error", "provider_activation_failed", { provider: "codex", unmanaged });
      return { status: "failed", restartFailed: true,
        detail: "Codex's background service on this machine was started outside its manager, so it could not be restarted onto the new account. Your sign-in is kept; nothing was switched." };
    }
    const restart = unmanaged ? await replaceUnmanagedServer() : await run(MANAGED_CODEX, ["app-server", "daemon", "restart"], 90_000);
    if (restart.code !== 0) {
      log("error", "provider_activation_failed", { provider: "codex", exit_code: restart.code, unmanaged, output: restart.output.slice(0, 500) });
      return { status: "failed", restartFailed: true,
        detail: "Codex on this machine could not be restarted onto the new account. Your sign-in is kept; nothing was switched." };
    }
    const version = await run(MANAGED_CODEX, ["app-server", "daemon", "version"], 20_000);
    const healthy = version.code === 0 && version.output.includes("\"backend\":\"pid\"");
    log("info", "provider_activation_applied", { provider: "codex", healthy, replaced_unmanaged: unmanaged });
    return healthy
      ? { status: "applied", detail: "Done. This machine is using the new account now." }
      : { status: "failed", detail: "Signed in, and this machine restarted Codex, but Codex did not come back healthy here." };
  } finally {
    holdCodexAdmission(false);
  }
}

function childrenOf(pids: number[]): number[] {
  const wanted = new Set(pids), found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      if (wanted.has(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]))) found.push(Number(entry));
    } catch { /* gone */ }
  }
  return found;
}
const alive = (pid: number) => existsSync(`/proc/${pid}`);
const CONTROL_SOCKET = join(homedir(), ".codex", "app-server-control", "app-server-control.sock");
function socketAnswers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection(path);
    const done = (answer: boolean) => { socket.destroy(); resolve(answer); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 1_000).unref?.();
  });
}

/**
 * A server started outside the daemon manager refuses `daemon restart` (from Oct 4 to Oct 7, 2026 that
 * made every Codex switch fail), and on 2026-10-08 one was left running after Codex's own updater
 * failed to bring its replacement up. Replacing it is the runbook's unmanaged-listener repair: stop
 * exactly the processes holding the control socket, keep that socket under a dated name, and start the
 * managed server in its own scope. Concierge's own start-when-absent is held meanwhile so it cannot
 * bind a socket this then moves aside; if anything else brought a server up first, it is kept.
 */
async function replaceUnmanagedServer(): Promise<{ code: number | null; output: string }> {
  const servers = controlSocketListeners(CONTROL_SOCKET);
  if (!servers.length) return { code: 1, output: "No process holds the Codex control socket." };
  const helpers = childrenOf(servers);
  log("warn", "codex_unmanaged_server_replacing", { servers, helpers });
  holdCodexDaemonAutoStart(true);
  try {
    for (const pid of servers) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    const deadline = Date.now() + 70_000;
    while (servers.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
    for (const pid of [...servers, ...helpers]) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    // A killed listener can still accept for a moment; probe only once it is gone.
    const gone = Date.now() + 5_000;
    while (servers.some(alive) && Date.now() < gone) await new Promise(resolve => setTimeout(resolve, 100));
    if (await socketAnswers(CONTROL_SOCKET)) return { code: 0, output: "Another start already brought a server up." };
    // lstat, not exists: the control path is a link, and its target may already be gone.
    let present = false; try { lstatSync(CONTROL_SOCKET); present = true; } catch { /* absent */ }
    if (present) renameSync(CONTROL_SOCKET, `${CONTROL_SOCKET}.stale-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    return await startCodexDaemonInOwnScope();
  } finally {
    holdCodexDaemonAutoStart(false);
  }
}

async function codexServerUnmanaged(): Promise<boolean> {
  const version = await run(MANAGED_CODEX, ["app-server", "daemon", "version"], 20_000);
  return version.code === 0 && version.output.includes("\"running\"") && !version.output.includes("\"backend\"");
}

/** Codex turns another client (the Mac Codex app) is running on the shared server, as last observed. */
function externallyRunningCodexTurns(): number {
  try {
    return (db.query(`SELECT COUNT(*) AS count FROM sessions WHERE provider_id='codex'
      AND json_extract(native_metadata_json,'$.codexLifecycle.state') IN ('running','uncertain')`).get() as { count: number }).count;
  } catch { return -1; }
}

let pendingCodexRepair = false;
/**
 * Puts a server started outside its manager back under it, at a moment nothing would be cut: no
 * Concierge Codex turn running, none observed running from another client, and new Codex work held
 * for the seconds it takes. Unlike an account switch it changes no account, so it releases no held
 * work. Server only. Retried on execution changes while it is waiting for running work; a finished
 * attempt, successful or not, is not repeated until the next start or account switch.
 */
function repairUnmanagedCodexServer(): Promise<void> {
  return oneCodexRestartAtATime(async () => {
    if (process.platform !== "linux" || !(await codexServerUnmanaged())) { pendingCodexRepair = false; return; }
    pendingCodexRepair = true;
    if (!codexUpdaterDisabled()) { log("error", "codex_unmanaged_server_repair_refused", { reason: "automatic_updater_not_disabled" }); return; }
    holdCodexAdmission(true);
    try {
      const running = runningCodexTurns(), external = externallyRunningCodexTurns();
      if (running !== 0 || external !== 0) { log("info", "codex_unmanaged_server_repair_waiting", { running, external }); return; }
      const result = await replaceUnmanagedServer();
      const healthy = !(await codexServerUnmanaged()) && result.code === 0;
      log(healthy ? "warn" : "error", healthy ? "codex_unmanaged_server_replaced" : "codex_unmanaged_server_repair_failed",
        { code: result.code, output: result.output.slice(0, 300) });
      // A failed replacement is not retried by itself: each attempt stops a server. The next start of
      // Concierge, or an account switch (which replaces it too), tries again.
      pendingCodexRepair = false;
    } finally {
      holdCodexAdmission(false);
    }
  });
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
 * success, and every dispatch after it failed to authenticate. The saved-home switch on
 * 2026-09-25 repeated the mistake by bypassing this probe entirely; run it from the proposed
 * home before selecting that account.
 */
export type ClaudeAccountCheck=Readonly<{ok:boolean;reason:'works'|'signed_out'|'out_of_room'|'settings_not_in_effect'|'wrong_account'|'timeout'|'failed'}>;

/**
 * Whether Claude work can actually be done from this home: started the way agents are started
 * (their environment, their hook settings, a workspace folder as working directory), it must write
 * one file outside its folder with the Write tool AND change one with a Bash command, and both
 * effects are read back here while Claude's own event record must show each tool ran. Write and
 * Bash have separate permission rules, and read-only commands or writes inside the agent's folder
 * pass even with no settings, so nothing less tells a usable home from a crippled one. A reply-only
 * check passed on 2026-10-07 for a home without settings and agents were refused for ten minutes;
 * GPT-6 Astra's review asked for exactly this test. Each failure is named for what it is, because
 * calling every failure "needs signing in" sent him to sign in by hand.
 */
export async function claudeAccountWorks(home:string|null=null,expectedAccount:string|null=null):Promise<ClaudeAccountCheck>{
  const started=Date.now();
  const environment=providerOwnerEnvironment({...process.env});
  if(home)environment.CLAUDE_CONFIG_DIR=home;
  else delete environment.CLAUDE_CONFIG_DIR;
  const secret=randomUUID(),folder=join(homedir(),'.local','state','concierge-probe');
  const written=join(folder,`${secret}.write`),commanded=join(folder,`${secret}.bash`);
  mkdirSync(folder,{recursive:true,mode:0o700});
  const cwd=process.env.CONCIERGE_WORKSPACE_ROOT||join(homedir(),'workspace');
  const probe=await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE||'claude',
    ['-p','--verbose','--output-format','stream-json','--model','claude-haiku-4-5-20251001','--no-session-persistence',
      '--settings',CLAUDE_AGENT_HOOK_SETTINGS,
      ...(process.env.CONCIERGE_CLAUDE_CODE_SKIP_PERMISSIONS==='1'?['--dangerously-skip-permissions']:[]),
      `Do exactly two things with your tools, then reply DONE.\n1. Use the Write tool to create ${written} containing exactly: ${secret}\n2. Use the Bash tool to run: printf %s ${secret} > ${commanded}`],
    120_000,environment,cwd);
  const readBack=(path:string)=>{try {return readFileSync(path,'utf8')===secret;} catch {return false;}};
  const wrote=readBack(written),ran=readBack(commanded);
  for(const path of [written,commanded])try {rmSync(path,{force:true});} catch {/* temporary */}
  const used=new Map<string,string>(),succeeded=new Set<string>();
  let result:any=null;
  for(const line of probe.output.split('\n')){
    let event:any;try {event=JSON.parse(line);} catch {continue;}
    for(const block of event?.message?.content??[]){
      if(block?.type==='tool_use')used.set(block.id,block.name);
      if(block?.type==='tool_result'&&!block.is_error&&used.has(block.tool_use_id))succeeded.add(used.get(block.tool_use_id)!);
    }
    if(event?.type==='result')result=event;
  }
  // Only Claude's own answer is read for a sign-in failure: the start-up record lists skills whose
  // names contain words like "credential", which once made a crash look like a sign-out.
  const text=String(result?.result??'').slice(0,2000);
  const denied=Array.isArray(result?.permission_denials)&&result.permission_denials.length>0;
  let reason:ClaudeAccountCheck['reason'];
  if(probe.timedOut)reason='timeout';
  else if(!result)reason='failed';
  else if(result.is_error===true&&/authenticat|oauth|401|log ?in|expired/i.test(text))reason='signed_out';
  // Signed in, answering, and simply at its limit: a fact about room, not about the login.
  else if(result.is_error===true&&isClaudeUsageExhaustion(text))reason='out_of_room';
  else if(wrote&&ran&&succeeded.has('Write')&&succeeded.has('Bash'))reason='works';
  else if(denied||result.is_error!==true)reason='settings_not_in_effect';
  else reason='failed';
  if(reason==='works'&&expectedAccount){
    const status=await run(process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE||'claude',['auth','status','--json'],15_000,environment);
    try {const value=JSON.parse(status.output) as {loggedIn?:boolean;email?:string};
      if(!(status.code===0&&value.loggedIn===true&&value.email===expectedAccount))reason='wrong_account';
    } catch {reason='wrong_account';}
  }
  log('info','provider_activation_probed',{provider:'claude-code',ok:reason==='works',reason,wrote,ran,
    tools:[...succeeded],duration_ms:Date.now()-started});
  return {ok:reason==='works',reason};
}

export async function claudeCredentialsAnswer(home:string|null=null,expectedAccount:string|null=null):Promise<boolean>{
  return (await claudeAccountWorks(home,expectedAccount)).ok;
}

async function codexCredentialsAnswer(expectedAccount:string|null):Promise<boolean>{
  // Asked of the running daemon, the process that does his work, and with a renewal forced.
  // A separate `codex exec` answered here before: it ran on its own copy of the token, so it
  // said OK on 2026-09-29 while the daemon had already been refused ("refresh token reused")
  // and every one of his Codex sessions was signed out — and panel said "Switched". Renewing
  // is the part that fails for a spent login; an unexpired access token hides it for days.
  const started=Date.now();
  let account:string|null=null,refused=false;
  // The daemon was just restarted, so its socket may take a moment to answer.
  try {
    const answer=await withRetry({operation:'codex-credential-probe',key:'running-daemon',
      policy:RETRY_POLICIES.providerCredentialProbe,
      run:()=>sharedCodexAppServerClient().request('account/read',{refreshToken:true},{requestTimeoutMs:20_000}),
      classifyError:()=> 'transient'});
    account=typeof answer?.account?.email==='string'?answer.account.email:null;
    refused=!account;
  } catch {}
  const ok=!!account&&(!expectedAccount||account===expectedAccount);
  log('info','provider_activation_probed',{provider:'codex',ok,signed_out:refused,other_account:!!account&&!ok,duration_ms:Date.now()-started});
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
    // Where accounts have homes of their own, agents run on the selected one, so that is the
    // login whose answer can release held work; the main folder's is a terminal's.
    const ownHomes = claudeRunsFromOwnHomes(), selected = ownHomes ? selectedClaudeHome() : null;
    if (ownHomes && !selected) return { status: "failed", detail: "No Claude account is selected for agents on this machine. Choose one in Accounts." };
    if (!await claudeCredentialsAnswer(selected?.home ?? null, selected?.label ?? null)) {
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
  // Codex only actually changes account when its App Server comes back on the new token, and
  // a restart that came back healthy says nothing about whether that token renews.
  if (report.status === "applied") {
    if(!await codexCredentialsAnswer(currentAccount('codex')?.label??null))return {status:'failed',
      detail:'Codex restarted, but that account could not sign in from this machine.'};
    releaseUsageHeldWork(provider);
    if(authHeldInputCount(provider)>0)releaseAuthHold(provider, releasedBy);
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
        forgetAccountFiles();
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
  // A server running outside its manager is put back under it at the first moment nothing runs.
  let repairing=false;
  const repair=()=>{if(stopped||repairing)return;repairing=true;
    void repairUnmanagedCodexServer().catch(error=>log('error','codex_unmanaged_server_repair_failed',{error:String(error)})).finally(()=>{repairing=false;});};
  repair();
  const detach=observeExecutionChanges(()=>{
    updateInterval();
    if(pendingCodexActivation && runningCodexTurns()===0)check('codex','turn_finished');
    if(pendingCodexRepair && runningCodexTurns()===0)repair();
  });
  for(const provider of providers)check(provider,'startup');
  updateInterval();
  return ()=>{stopped=true;detach();if(interval)clearInterval(interval);
    for(const timer of debounce.values())clearTimeout(timer);for(const watcher of watchers)watcher.close();};
}
