/** Provider-account facts and actions that belong to this runner's machine. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readRunnerProviderAccountReadings } from "./runner-provider-account-readings";
import { ProviderLoginManager, type AuthLoginStartResult } from "./auth-login";
import { codexUpdaterDisabled } from "./codex-updater-settings";
import { MANAGED_CODEX, controlSocketListeners, holdCodexDaemonAutoStart, startCodexDaemonInOwnScope } from "./codex-daemon-file-limit";
import { CodexAppServerClient, codexAppServerSocketPath } from "./codex-app-server-client";
import { useCodexResetCredit } from "./codex-reset-credit";
import { readRunnerGoogleUsage } from "./runner-google-usage";
import {createConnection} from 'node:net';

type AccountProvider = "codex" | "claude-code";
const providers = new Set<AccountProvider>(["codex", "claude-code"]);
type SignInStatus = "starting" | "awaiting_code" | "awaiting_approval" | "completing" | "completed" | "failed" | "interrupted";
type SignInOperation = { id: string; provider: AccountProvider; status: SignInStatus; stageHome: string; url?: string; userCode?: string|null; account?: string; detail?: string };
const signinJournal = join(process.env.CONCIERGE_RUNNER_STATE?.trim() || join(homedir(), ".local", "state", "concierge-runner"), "provider-signin-state.json");
const activationJournal = join(process.env.CONCIERGE_RUNNER_STATE?.trim() || join(homedir(), ".local", "state", "concierge-runner"), "codex-activation-state.json");
const signinOperations = new Map<string, SignInOperation>();
const pendingSignins = new Map<AccountProvider, string>();
type ActivationOperation = { id: string; account: string; status: "starting" | "applied" | "failed" | "uncertain"; detail?: string };
const activationOperations = new Map<string, ActivationOperation>();
let unmanagedRepair:Promise<{status:string;detail?:string}>|null=null;
let codexRepairActive=false;
export function runnerCodexRepairActive():boolean{return codexRepairActive;}

function writeSignInState(operation: SignInOperation) {
  const rows = [...signinOperations.values()].map(({id,provider,status,account,detail}) => ({id,provider,status,account,detail,updatedAt:Date.now()}));
  mkdirSync(join(signinJournal, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(`${signinJournal}.tmp`, JSON.stringify(rows), { mode: 0o600 });
  renameSync(`${signinJournal}.tmp`, signinJournal);
}
try {
  const prior = JSON.parse(readFileSync(signinJournal, "utf8"));
  if (Array.isArray(prior)) for (const row of prior) {
    if (row && typeof row.id === "string" && providers.has(row.provider) && typeof row.status === "string") {
      const active = ["starting","awaiting_code","awaiting_approval","completing"].includes(row.status);
      const status: SignInStatus = active ? "interrupted" : row.status;
      if (["interrupted","completed","failed"].includes(status)) signinOperations.set(row.id, {
        id: row.id, provider: row.provider, status, stageHome: "",
        ...(typeof row.account === "string" ? { account: row.account } : {}),
        ...(active ? { detail: "The runner restarted during sign-in. Start a new sign-in operation." }
          : typeof row.detail === "string" ? { detail: row.detail } : {}),
      });
    }
  }
} catch { /* first start */ }

try {
  const prior = JSON.parse(readFileSync(activationJournal, "utf8"));
  if (Array.isArray(prior)) for (const row of prior) {
    if (row && typeof row.id === "string" && typeof row.account === "string") {
      const active = row.status === "starting";
      if (active || ["applied","failed","uncertain"].includes(row.status)) activationOperations.set(row.id, {
        id: row.id, account: row.account, status: active ? "uncertain" : row.status,
        detail: active ? "The runner restarted during the account switch. State needs inspection." : row.detail,
      });
    }
  }
} catch { /* first activation */ }

function writeActivationState() {
  mkdirSync(join(activationJournal, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(`${activationJournal}.tmp`, JSON.stringify([...activationOperations.values()]), { mode: 0o600 });
  renameSync(`${activationJournal}.tmp`, activationJournal);
}
const signinManager = new ProviderLoginManager({
  onUnattendedCompletion: provider => {
    const id = pendingSignins.get(provider as AccountProvider);
    const operation = id ? signinOperations.get(id) : null;
    if (operation) void settleSignIn(operation);
  },
});

function provider(value: unknown): AccountProvider {
  if (typeof value !== "string" || !providers.has(value as AccountProvider)) throw new Error("unsupported provider");
  return value as AccountProvider;
}

const accountRoot = (key: AccountProvider) => join(homedir(), key === "codex" ? ".codex-accounts" : ".claude-accounts");
const liveRoot = (key: AccountProvider) => join(homedir(), key === "codex" ? ".codex" : ".claude");

function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function codexAccount(home: string): { id: string; label: string } | null {
  const credentials = readJson(join(home, "auth.json"));
  const id = credentials?.tokens?.account_id;
  const token = credentials?.tokens?.id_token;
  if (typeof id !== "string" || !id || typeof token !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return { id, label: typeof claims?.email === "string" ? claims.email : id };
  } catch { return { id, label: id }; }
}

function claudeAccount(home: string): { id: string; label: string } | null {
  const credentials = readJson(join(home, ".credentials.json"));
  const refresh = credentials?.claudeAiOauth?.refreshToken;
  if (typeof refresh !== "string" || !refresh) return null;
  const recorded = readText(join(home, ".account-email"));
  const live = readJson(join(homedir(), ".claude.json"))?.oauthAccount?.emailAddress;
  const subscription = credentials?.claudeAiOauth?.subscriptionType;
  const plan = typeof subscription === "string" && subscription
    ? `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : "Claude subscription";
  return { id: createHash("sha256").update(refresh).digest("hex").slice(0, 16),
    label: recorded ?? (home === liveRoot("claude-code") && typeof live === "string" && live ? live : plan) };
}

function readText(path: string): string | null {
  try { const value = readFileSync(path, "utf8").trim(); return value || null; } catch { return null; }
}

function safeAccountFolder(label: string, id: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "account";
  return `${slug}-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function codexCredentialId(home: string): string | null {
  const value = readJson(join(home, "auth.json"))?.tokens?.account_id;
  return typeof value === "string" && value ? value : null;
}

function fileCodexSignIn(operation: SignInOperation): string {
  const credentials = readJson(join(operation.stageHome, "auth.json"));
  const identity = codexAccount(operation.stageHome);
  if (!identity || !credentials) throw new Error("Codex did not produce a usable sign-in.");
  const existing = runnerAccountHomes("codex").find(candidate => codexCredentialId(candidate.home) === identity.id);
  const home = existing?.home ?? join(accountRoot("codex"), safeAccountFolder(identity.label, identity.id));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const source = join(operation.stageHome, "auth.json"), target = join(home, "auth.json");
  if (existsSync(target)) renameSync(target, `${target}.superseded-${Date.now()}`);
  renameSync(source, target);
  writeSignInState({ ...operation, status: "completed", account: identity.label, stageHome: "" });
  return identity.label;
}

async function claudeEmail(home: string): Promise<string | null> {
  const executable = process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  const child = Bun.spawn([executable, "auth", "status", "--json"], { env: { ...process.env, CLAUDE_CONFIG_DIR: home },
    stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) return null;
    const answer = JSON.parse(stdout);
    return answer?.loggedIn === true && typeof answer.email === "string" ? answer.email : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function fileClaudeSignIn(operation: SignInOperation): Promise<string> {
  const email = await claudeEmail(operation.stageHome);
  if (!email || !existsSync(join(operation.stageHome, ".credentials.json"))) throw new Error("Claude did not produce a usable sign-in.");
  const matches = runnerAccountHomes("claude-code").filter(candidate => candidate.account === email);
  if (matches.length > 1) throw new Error("Claude has multiple saved homes for this account; no sign-in files were moved.");
  const home = matches[0]?.home ?? join(accountRoot("claude-code"), safeAccountFolder(email, email));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  for (const name of [".credentials.json", ".claude.json"] as const) {
    const source = join(operation.stageHome, name), target = join(home, name);
    if (!existsSync(source)) continue;
    if (existsSync(target)) renameSync(target, `${target}.superseded-${Date.now()}`);
    renameSync(source, target);
  }
  writeFileSync(join(home, ".account-email"), email, { mode: 0o600 });
  writeSignInState({ ...operation, status: "completed", account: email, stageHome: "" });
  return email;
}

async function settleSignIn(operation: SignInOperation): Promise<void> {
  if (operation.status === "completed" || operation.status === "failed" || operation.status === "interrupted") return;
  try {
    operation.account = operation.provider === "codex" ? fileCodexSignIn(operation) : await fileClaudeSignIn(operation);
    operation.status = "completed";
    operation.stageHome = "";
  } catch (error) {
    operation.status = "failed";
    operation.detail = error instanceof Error ? error.message : "Sign-in could not be filed.";
    if (operation.stageHome) try { rmSync(operation.stageHome, { recursive: true, force: true }); } catch { /* only this operation's staging home */ }
    operation.stageHome = "";
  }
  pendingSignins.delete(operation.provider);
  writeSignInState(operation);
}

function publicSignIn(operation: SignInOperation | undefined) {
  if (!operation) return { status: "not_found" };
  return { operationId: operation.id, provider: operation.provider, status: operation.status,
    ...(operation.url ? { url: operation.url } : {}),
    ...(operation.userCode ? { userCode: operation.userCode } : {}),
    ...(operation.account ? { account: operation.account } : {}),
    ...(operation.detail ? { detail: operation.detail } : {}) };
}

async function startSignIn(params: Record<string, unknown>) {
  const key = provider(params.provider), id = params.operationId;
  if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(id)) throw new Error("A stable sign-in operation id is required.");
  const prior = signinOperations.get(id);
  if (prior) {
    if (prior.provider !== key) throw new Error("A sign-in operation id cannot change providers.");
    return publicSignIn(prior);
  }
  if (pendingSignins.has(key)) throw new Error("A sign-in operation for this provider is already active on this runner.");
  const stageHome = join(accountRoot(key), `.signing-in-${randomUUID()}`);
  mkdirSync(stageHome, { recursive: true, mode: 0o700 });
  const operation: SignInOperation = { id, provider: key, status: "starting", stageHome };
  signinOperations.set(id, operation);
  pendingSignins.set(key, id);
  writeSignInState(operation);
  try {
    const executable = key === "codex" ? process.env.CONCIERGE_CODEX_EXECUTABLE?.trim() || "/root/.codex/packages/standalone/current/codex"
      : process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
    const flow = key === "codex" ? "device" : "paste-code";
    const args = key === "codex" ? "login --device-auth" : "auth login";
    const started: AuthLoginStartResult = await signinManager.start(key, `${executable} ${args}`, homedir(), flow,
      key === "codex" ? { CODEX_HOME: stageHome } : { CLAUDE_CONFIG_DIR: stageHome });
    if (started.status === "awaiting_code" || started.status === "awaiting_approval") {
      operation.status = started.status;
      operation.url = started.url;
      operation.userCode = started.status === "awaiting_approval" ? started.userCode : null;
    } else if (started.status === "completed") await settleSignIn(operation);
    else {
      operation.status = "failed"; operation.detail = "The provider sign-in could not be started.";
      try { rmSync(stageHome, { recursive: true, force: true }); } catch { /* only this operation's staging home */ }
      operation.stageHome = ""; pendingSignins.delete(key);
    }
    writeSignInState(operation);
    return publicSignIn(operation);
  } catch (error) {
    operation.status = "failed";
    operation.detail = "The provider sign-in could not be started.";
    try { rmSync(stageHome, { recursive: true, force: true }); } catch { /* only this operation's staging home */ }
    operation.stageHome = "";
    pendingSignins.delete(key);
    writeSignInState(operation);
    return publicSignIn(operation);
  }
}

async function completeSignIn(params: Record<string, unknown>) {
  const id = params.operationId, code = params.code;
  if (typeof id !== "string" || typeof code !== "string" || !code.trim() || code.length > 512 || /[\r\n]/.test(code))
    throw new Error("A sign-in operation id and one-line provider code are required.");
  const operation = signinOperations.get(id);
  if (!operation) return { status: "interrupted", detail: "The runner no longer owns this sign-in. Start a new operation." };
  if (["completing","completed","failed","interrupted"].includes(operation.status)) return publicSignIn(operation);
  if (operation.provider !== "claude-code" || operation.status !== "awaiting_code")
    throw new Error("This sign-in is not waiting for a pasted code.");
  operation.status = "completing";
  writeSignInState(operation);
  const result = await signinManager.complete(operation.provider, code.trim());
  if (result.status === "completed") await settleSignIn(operation);
  else {
    operation.status = "failed";
    operation.detail = result.status === "no_pending_login" ? "The runner lost the waiting sign-in. Start a new operation."
      : "The provider did not accept the sign-in code.";
    if (operation.stageHome) try { rmSync(operation.stageHome, { recursive: true, force: true }); } catch { /* only this operation's staging home */ }
    operation.stageHome = "";
    pendingSignins.delete(operation.provider);
    writeSignInState(operation);
  }
  return publicSignIn(operation);
}

let codexActivationFlight: Promise<unknown> | null = null;
async function runCommand(command: string, args: string[], timeoutMs: number): Promise<{ code: number|null; output: string }> {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: `${stdout}${stderr}` };
  } finally { clearTimeout(timer); }
}

async function restartCodexForAccount(accountLabel: string) {
  const current = codexAccount(liveRoot("codex"));
  const targetHome = runnerAccountHome("codex", accountLabel);
  if (!targetHome) throw new Error("The requested Codex account is not uniquely available on this runner.");
  if (!existsSync(join(targetHome, "auth.json"))) throw new Error("The requested Codex account has no saved sign-in on this runner.");
  if (!codexUpdaterDisabled()) throw new Error("Codex automatic updating is not disabled on this runner; no account switch was made.");
  if (targetHome === liveRoot("codex")) {
    const probe = new CodexAppServerClient();
    try {
      const answer = await probe.request("account/read", { refreshToken: true }, { requestTimeoutMs: 20_000 });
      if (answer?.account?.email !== accountLabel) throw new Error("The running Codex App Server does not confirm the requested account.");
      return { status: "applied", account: accountLabel };
    } finally { await probe.close(); }
  }

  const codex = process.env.CONCIERGE_CODEX_EXECUTABLE?.trim() || "/root/.codex/packages/standalone/current/codex";
  const activeAuth = join(liveRoot("codex"), "auth.json"), targetAuth = join(targetHome, "auth.json");
  const activeBackup = `${activeAuth}.switch-${randomUUID()}`, targetBackup = `${targetAuth}.switch-${randomUUID()}`;
  const outgoingHome = current ? join(accountRoot("codex"), safeAccountFolder(current.label, current.id)) : null;
  if (outgoingHome && targetHome === outgoingHome) throw new Error("The requested account is already the runner's active account.");
  if (outgoingHome) mkdirSync(outgoingHome, { recursive: true, mode: 0o700 });
  holdCodexDaemonAutoStart(true);
  let movedActive = false, movedTarget = false, restartAttempted = false;
  try {
    if (existsSync(activeAuth)) { renameSync(activeAuth, activeBackup); movedActive = true; }
    if (outgoingHome && movedActive) {
      const outgoingAuth = join(outgoingHome, "auth.json");
      if (existsSync(outgoingAuth)) renameSync(outgoingAuth, `${outgoingAuth}.superseded-${Date.now()}`);
      renameSync(activeBackup, outgoingAuth); movedActive = false;
    }
    renameSync(targetAuth, targetBackup); movedTarget = true;
    renameSync(targetBackup, activeAuth); movedTarget = false;
    restartAttempted = true;
    const restart = await runCommand(codex, ["app-server", "daemon", "restart"], 90_000);
    if (restart.code !== 0) throw new Error("The Codex App Server did not confirm its restart.");
    const probe = new CodexAppServerClient();
    let answer: any;
    try { answer = await probe.request("account/read", { refreshToken: true }, { requestTimeoutMs: 20_000 }); }
    finally { await probe.close(); }
    if (answer?.account?.email !== accountLabel) throw new Error("The restarted Codex App Server did not confirm the requested account.");
    return { status: "applied", account: accountLabel };
  } catch (error) {
    let rollbackCertain = true;
    try {
      if (existsSync(activeAuth)) {
        const failedTarget = join(targetHome, "auth.json");
        if (existsSync(failedTarget)) renameSync(failedTarget, `${failedTarget}.superseded-${Date.now()}`);
        renameSync(activeAuth, failedTarget);
      }
      if (movedTarget && existsSync(targetBackup)) renameSync(targetBackup, targetAuth);
      if (outgoingHome) {
        const outgoingAuth = join(outgoingHome, "auth.json");
        if (existsSync(outgoingAuth)) renameSync(outgoingAuth, activeAuth);
      } else if (movedActive && existsSync(activeBackup)) renameSync(activeBackup, activeAuth);
      if (restartAttempted) {
        const recovery = await runCommand(codex, ["app-server", "daemon", "restart"], 90_000);
        if (recovery.code !== 0) rollbackCertain = false;
      }
    } catch { rollbackCertain = false; }
    if (!rollbackCertain) return { status: "uncertain", detail: "The account switch failed and the previous Codex state could not be confirmed. Do not retry until runner state is inspected." };
    throw new Error(error instanceof Error ? error.message : "The account switch failed; the previous account was restored.");
  } finally { holdCodexDaemonAutoStart(false); }
}

function activateCodex(params: Record<string, unknown>) {
  const account = params.account, id = params.operationId;
  if (typeof account !== "string" || !account.trim() || typeof id !== "string" || !/^[A-Za-z0-9._:-]{8,160}$/.test(id))
    throw new Error("A Codex account and stable activation operation id are required.");
  const prior = activationOperations.get(id);
  if (prior) {
    if (prior.account !== account) throw new Error("An activation operation id cannot change accounts.");
    return prior;
  }
  const uncertain = [...activationOperations.values()].find(operation => operation.status === "uncertain");
  if (uncertain) return { status: "uncertain", detail: "A prior Codex account switch is uncertain and must be reconciled first." };
  if (codexActivationFlight) throw new Error("Another Codex account switch is already active on this runner.");
  const operation: ActivationOperation = { id, account, status: "starting" };
  activationOperations.set(id, operation);
  writeActivationState();
  codexActivationFlight = restartCodexForAccount(account).then(result => {
    const answer = result as { status: string; detail?: string };
    operation.status = answer.status === "applied" ? "applied" : answer.status === "uncertain" ? "uncertain" : "failed";
    operation.detail = answer.detail;
    writeActivationState();
    return operation;
  }, error => {
    operation.status = "failed";
    operation.detail = error instanceof Error ? error.message : "The Codex account switch failed and the previous account was restored.";
    writeActivationState();
    return operation;
  }).finally(() => { codexActivationFlight = null; });
  return codexActivationFlight;
}

function socketAnswers(path:string):Promise<boolean>{return new Promise(resolve=>{
  const socket=createConnection(path);const finish=(answer:boolean)=>{socket.destroy();resolve(answer);};
  socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  setTimeout(()=>finish(false),1_000).unref?.();
});}
function processTree(roots:number[]):number[]{
  const parentOf=new Map<number,number>();
  try{
    for(const entry of readdirSync('/proc')){
      if(!/^\d+$/.test(entry))continue;
      const pid=Number(entry);
      try{const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
        parentOf.set(pid,Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]));}catch{}
    }
  }catch{return roots;}
  const result=new Set(roots),queue=[...roots];
  while(queue.length){const parent=queue.shift()!;for(const [pid,ppid] of parentOf)if(ppid===parent&&!result.has(pid)){result.add(pid);queue.push(pid);}}
  return [...result];
}
const processAlive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function runnerSocketRepair(activeTurns:number):Promise<{status:string;detail?:string}>{
  if(unmanagedRepair)return unmanagedRepair;
  unmanagedRepair=(async()=>{
    if(activeTurns!==0)return {status:'busy',detail:'The runner still owns an active turn.'};
    if(process.platform!=='linux'||process.env.CONCIERGE_CODEX_APP_SERVER_SOCKET?.trim())
      return {status:'unsupported',detail:'Unmanaged App Server repair is supported only for the runner-owned Linux socket.'};
    codexRepairActive=true;
    try{
      const check=await runCommand(MANAGED_CODEX,['app-server','daemon','version'],20_000);
      if(check.code!==0||!check.output.includes('"running"')||check.output.includes('"backend"'))
        return {status:'managed_or_absent'};
      if(!codexUpdaterDisabled())return {status:'refused',detail:'Codex automatic updates are not disabled on this runner.'};
      const socket=codexAppServerSocketPath(),servers=controlSocketListeners(socket);
      if(!servers.length)return {status:'uncertain',detail:'Codex reported an unmanaged server, but no exact listener owns its control socket.'};
      const tree=processTree(servers);
      holdCodexDaemonAutoStart(true);
      try{
      for(const pid of servers)try{process.kill(pid,'SIGTERM');}catch{}
      const deadline=Date.now()+70_000;
      while(servers.some(processAlive)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,500));
      if(servers.some(processAlive))for(const pid of [...tree].reverse())try{process.kill(pid,'SIGKILL');}catch{}
      const stopped=Date.now()+5_000;
      while(servers.some(processAlive)&&Date.now()<stopped)await new Promise(resolve=>setTimeout(resolve,100));
      if(servers.some(processAlive))return {status:'uncertain',detail:'The unmanaged Codex listener did not stop.'};
      if(await socketAnswers(socket))return {status:'managed_or_absent',detail:'A replacement App Server answered during repair.'};
      let present=false;try{lstatSync(socket);present=true;}catch{}
      if(present)renameSync(socket,`${socket}.stale-${new Date().toISOString().replace(/[:.]/g,'-')}`);
      const started=await startCodexDaemonInOwnScope();
      const after=await runCommand(MANAGED_CODEX,['app-server','daemon','version'],20_000);
      if(started.code===0&&after.code===0&&after.output.includes('"backend":"pid"'))
        return {status:'repaired'};
      return {status:'uncertain',detail:'The replacement App Server did not confirm a managed backend.'};
      }finally{holdCodexDaemonAutoStart(false);}
    }finally{codexRepairActive=false;}
  })().finally(()=>{unmanagedRepair=null;});
  return unmanagedRepair;
}

/** Resolve a label to this runner's home after validating the account stored there. */
export function runnerAccountHome(key: AccountProvider, accountLabel: string): string | null {
  if (!accountLabel.trim()) return null;
  const root = liveRoot(key);
  const active = key === "codex" ? codexAccount(root) : claudeAccount(root);
  const matches: string[] = [];
  if (active?.label === accountLabel) matches.push(root);
  let names: string[] = [];
  try { names = readdirSync(accountRoot(key)).filter(name => !name.startsWith(".")); } catch { return null; }
  for (const name of names) {
    const home = join(accountRoot(key), name);
    const account = key === "codex" ? codexAccount(home) : claudeAccount(home);
    if (account?.label === accountLabel) matches.push(home);
  }
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0]! : null;
}

/** Enumerate credential-verified homes, for exact transcript discovery on this runner. */
export function runnerAccountHomes(key: AccountProvider): { account: string; home: string }[] {
  const found = new Map<string, string>();
  const active = key === "codex" ? codexAccount(liveRoot(key)) : claudeAccount(liveRoot(key));
  if (active) found.set(liveRoot(key), active.label);
  let names: string[] = [];
  try { names = readdirSync(accountRoot(key)).filter(name => !name.startsWith(".")); } catch { return [...found].map(([home, account]) => ({ account, home })); }
  for (const name of names) {
    const home = join(accountRoot(key), name);
    const account = key === "codex" ? codexAccount(home) : claudeAccount(home);
    if (account && !found.has(home)) found.set(home, account.label);
  }
  return [...found].map(([home, account]) => ({ account, home }));
}

/**
 * Find a provider transcript by exact native UUID within credential-verified local homes.
 * A missing account label is supported only for historical lookup: all candidate homes are
 * searched and the result is usable only when exactly one transcript matches.
 */
export function findRunnerProviderSessionHome(key: AccountProvider, accountLabel: string | null, nativeId: string):
  { account: string; home: string; transcript: string } | null {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(nativeId)) return null;
  const candidates = accountLabel === null
    ? runnerAccountHomes(key)
    : (() => { const home = runnerAccountHome(key, accountLabel); return home ? [{ account: accountLabel, home }] : []; })();
  const matches: { account: string; home: string; transcript: string }[] = [];
  for (const candidate of candidates) {
    for (const transcript of exactProviderTranscripts(key, candidate.home, nativeId))
      matches.push({ account: candidate.account, home: candidate.home, transcript });
  }
  const unique = new Map(matches.map(match => [match.transcript, match]));
  return unique.size === 1 ? [...unique.values()][0]! : null;
}

function exactProviderTranscripts(key: AccountProvider, home: string, nativeId: string): string[] {
  const matches: string[] = [];
  const roots = key === "codex" ? [join(home, "sessions")] : [join(home, "projects")];
  for (const root of roots) {
    const visit = (directory: string, depth: number) => {
      if (depth > 12) return;
      let names: string[];
      try { names = readdirSync(directory); } catch { return; }
      for (const name of names) {
        const path = join(directory, name);
        if (name === `-${nativeId}.jsonl` || name === `${nativeId}.jsonl`) {
          if (existsSync(path)) matches.push(path);
        } else if (!name.startsWith(".") && !name.endsWith(".jsonl")) visit(path, depth + 1);
      }
    };
    visit(root, 0);
  }
  return matches;
}

/** Current account identity as read from this runner's own credentials. */
export function runnerAccountIdentity(key: AccountProvider): { id: string; label: string } | null {
  return key === "codex" ? codexAccount(liveRoot(key)) : claudeAccount(liveRoot(key));
}

/** The account snapshots are observed here; the owner keeps their allowance and request ledger. */
export async function runnerAccountReadings() {
  return readRunnerProviderAccountReadings();
}

/** Closed vocabulary for the account operations exposed on the runner-machine relay. */
export async function serveRunnerAccountCall(method: string, params: Record<string, unknown>,context:{activeTurns:number}={activeTurns:0}): Promise<unknown> {
  if (method === "accounts.identity") {
    if(params.provider==='antigravity'){
      const usage=await readRunnerGoogleUsage();
      const current=usage.accounts.filter(account=>account.current);
      return current.length===1?{id:current[0]!.label,label:current[0]!.label}:null;
    }
    const key = provider(params.provider);
    return runnerAccountIdentity(key);
  }
  if (method === "accounts.validate") {
    const key = provider(params.provider);
    if (typeof params.account !== "string" || !params.account.trim()) throw new Error("A provider account label is required.");
    const matches = runnerAccountHomes(key).filter(home => home.account === params.account);
    return { available: matches.length === 1, resolution: matches.length === 1 ? "unique" : matches.length ? "ambiguous" : "missing" };
  }
  if (method === "accounts.transcript") {
    const key = provider(params.provider);
    const account = params.account === null ? null : typeof params.account === "string" ? params.account : null;
    if (params.account !== null && account === null) throw new Error("account must be a provider label or null.");
    if (typeof params.nativeId !== "string") throw new Error("an exact native session id is required.");
    if (!/^[A-Za-z0-9-]{8,128}$/.test(params.nativeId)) return { account: null, resolution: "missing" };
    const homes = runnerAccountHomes(key);
    const candidates = account === null ? homes : homes.filter(home => home.account === account);
    if (account !== null && candidates.length !== 1)
      return { account: null, resolution: candidates.length > 1 ? "ambiguous" : "missing" };
    const matches = candidates.flatMap(candidate => exactProviderTranscripts(key, candidate.home, params.nativeId as string)
      .map(transcript => ({ account: candidate.account, transcript })));
    if (matches.length === 1) return { account: matches[0]!.account, resolution: "unique" };
    return { account: null, resolution: matches.length ? "ambiguous" : "missing" };
  }
  if (method === "accounts.readings") return runnerAccountReadings();
  if (method === "accounts.google.readings") return readRunnerGoogleUsage();
  if (method === "accounts.signin.start") return startSignIn(params);
  if (method === "accounts.signin.complete") return completeSignIn(params);
  if (method === "accounts.signin.status") {
    const id = params.operationId;
    if (typeof id !== "string") throw new Error("A sign-in operation id is required.");
    return publicSignIn(signinOperations.get(id));
  }
  if (method === "accounts.codex.activate") return activateCodex(params);
  if (method === "accounts.codex.repairUnmanaged") return runnerSocketRepair(context.activeTurns);
  if (method === "accounts.codex.resetCredit") {
    const account = params.account, operationId = params.operationId;
    if (typeof account !== "string" || !account.trim() || typeof operationId !== "string"
      || !/^[A-Za-z0-9._:-]{8,160}$/.test(operationId))
      throw new Error("A Codex account label and stable reset operation id are required.");
    if (runnerAccountHomes("codex").filter(home => home.account === account).length !== 1)
      throw new Error("The requested Codex account is not uniquely available on this runner.");
    return useCodexResetCredit(account, operationId);
  }
  throw new Error(`this runner does not answer ${method}`);
}
