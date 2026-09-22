import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

// Which account a provider's credentials currently belong to, and the named
// credential snapshots the operator can switch between.
//
// This module exists because a usage limit belongs to an account, not to a
// provider. Before it, a Codex limit was cached under the literal scope
// "account" with no account identity, so signing into a different account
// inherited the previous account's exhaustion and every dispatch was refused
// locally until someone remembered `provider-usage.ts clear codex`. Keying the
// cache by the identity below makes a stale limit inapplicable by construction
// rather than by an operator remembering a command.

export type ProviderKey = "codex" | "claude-code";

export type ProviderAccount = Readonly<{ id: string; label: string; detail: string | null }>;
export type ProviderProfile = Readonly<{ id: string; label: string; detail: string | null; current: boolean }>;

const CODEX_HOME = join(homedir(), ".codex");
const CLAUDE_HOME = join(homedir(), ".claude");

export function credentialPath(provider: ProviderKey): string {
  return provider === "codex" ? join(CODEX_HOME, "auth.json") : join(CLAUDE_HOME, ".credentials.json");
}

function profileDirectory(provider: ProviderKey): string {
  return join(provider === "codex" ? CODEX_HOME : CLAUDE_HOME, "auth-profiles");
}

function readJson(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

/** JWT payload claims. The token itself never leaves this function. */
function tokenClaims(token: unknown): any | null {
  if (typeof token !== "string") return null;
  const payload = token.split(".")[1];
  if (!payload) return null;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
}

function codexAccount(credentials: any): ProviderAccount | null {
  const id = credentials?.tokens?.account_id;
  if (typeof id !== "string" || !id) return null;
  const claims = tokenClaims(credentials?.tokens?.id_token);
  const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return {
    id,
    label: typeof claims?.email === "string" ? claims.email : id,
    detail: typeof plan === "string" && plan ? `ChatGPT ${plan}` : null,
  };
}

// Claude Code's credential file carries no account identifier, so the cache key
// is a fingerprint of the refresh token. It changes whenever the account
// changes, and may also change when a token rotates — which merely forgets a
// limit early. That bias is deliberate: forgetting a real limit costs one
// rejected request that records it again, while inheriting another account's
// limit refuses every request without ever reaching the provider.
function claudeAccount(credentials: any): ProviderAccount | null {
  const oauth = credentials?.claudeAiOauth;
  const refresh = oauth?.refreshToken;
  if (typeof refresh !== "string" || !refresh) return null;
  const subscription = typeof oauth?.subscriptionType === "string" ? oauth.subscriptionType : null;
  const plan = subscription ? `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : null;
  // The email lives in Claude Code's global config, written at sign-in; it labels
  // the account only and never keys a usage limit.
  const email = readJson(join(homedir(), ".claude.json"))?.oauthAccount?.emailAddress;
  const known = typeof email === "string" && email ? email : null;
  return {
    id: createHash("sha256").update(refresh).digest("hex").slice(0, 16),
    label: known ?? plan ?? "Claude subscription",
    detail: known ? plan : null,
  };
}

const CLAUDE_EXECUTABLE = process.env.CONCIERGE_CLAUDE_CODE_EXECUTABLE || "claude";

/**
 * Who Claude Code itself says is signed in.
 *
 * `~/.claude/.credentials.json` is the credential store on this box, but it is not the
 * one Claude Code uses everywhere: on macOS the credentials live in the login Keychain
 * under the service `Claude Code-credentials`, so the file is simply absent and the Mac
 * read "no account signed in" while Claude Code there was perfectly configured
 * (verified on macOS 26.7, 2026-09-22). Asking the CLI removes the guess about where any
 * given host keeps its secrets: `claude auth status --json` answers the same way on both,
 * names the account and never exposes a token.
 *
 * It must be asked from the same place the agent runs. The login Keychain is readable only
 * inside the user's GUI session, so the identical binary reports `loggedIn: false` over SSH
 * and the real account under the Mac's launchd agent, at the same moment. This process is
 * that agent, so its answer is the true one — but never diagnose a Mac's sign-in over SSH.
 *
 * It costs a process start, so it is read on a timer and after a credential change rather
 * than on the dispatch path, and the file remains the synchronous fast path where it
 * exists so a usage scope is never worse than it was.
 */
type ClaudeSignIn = { loggedIn: boolean; email?: string; orgId?: string; subscriptionType?: string };
let claudeSignIn: ProviderAccount | null = null;

function claudeAccountFromStatus(status: ClaudeSignIn): ProviderAccount | null {
  if (!status.loggedIn) return null;
  const email = typeof status.email === "string" && status.email ? status.email : null;
  // The account's own identity, so a limit one account earned can never be inherited by
  // the next. Neither field is a secret.
  const id = email ?? (typeof status.orgId === "string" ? status.orgId : null);
  if (!id) return null;
  const tier = typeof status.subscriptionType === "string" && status.subscriptionType
    ? `Claude ${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)}` : null;
  return { id, label: email ?? tier ?? "Claude subscription", detail: email ? tier : null };
}

export async function refreshClaudeAccount(): Promise<void> {
  try {
    const child = Bun.spawn([CLAUDE_EXECUTABLE, "auth", "status", "--json"],
      { env: { ...process.env }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 15_000);
    const [output] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    clearTimeout(timer);
    claudeSignIn = claudeAccountFromStatus(JSON.parse(output) as ClaudeSignIn);
  } catch {
    // An unreadable status leaves the previous answer standing rather than claiming
    // nobody is signed in; the credential file still decides where it exists.
  }
}

type Memo = { key: string; account: ProviderAccount | null };
const memo = new Map<ProviderKey, Memo>();

/**
 * The account whose credentials this host holds right now, or null when none can be
 * read. A null identity never matches a recorded limit, so unreadable credentials
 * cannot inherit one.
 */
export function currentAccount(provider: ProviderKey): ProviderAccount | null {
  const path = credentialPath(provider);
  let key: string;
  try { const stat = statSync(path); key = `${stat.mtimeMs}:${stat.size}`; }
  catch { memo.delete(provider); return provider === "claude-code" ? claudeSignIn : null; }
  const cached = memo.get(provider);
  if (cached?.key === key) return cached.account;
  const credentials = readJson(path);
  const account = credentials === null ? null
    : provider === "codex" ? codexAccount(credentials) : claudeAccount(credentials);
  memo.set(provider, { key, account });
  return account ?? (provider === "claude-code" ? claudeSignIn : null);
}

/** Identity component of a usage-cache scope. Never a secret. */
export function accountScope(provider: ProviderKey): string {
  return currentAccount(provider)?.id ?? "unattributed";
}

function profileId(label: string): string {
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error("A profile name needs at least one letter or digit.");
  return slug.slice(0, 64);
}

// Profiles Tejas created by hand before this existed, as `auth.json.<name>`
// beside the live credential file. They are listed and switchable so the
// existing copies keep working instead of being orphaned by the new directory.
function legacyProfiles(provider: ProviderKey): { id: string; path: string }[] {
  if (provider !== "codex") return [];
  try {
    return readdirSync(CODEX_HOME)
      .filter(name => name.startsWith("auth.json.") && name !== "auth.json")
      .map(name => ({ id: name.slice("auth.json.".length), path: join(CODEX_HOME, name) }))
      .filter(entry => entry.id.length > 0);
  } catch { return []; }
}

function managedProfiles(provider: ProviderKey): { id: string; path: string }[] {
  const directory = profileDirectory(provider);
  try {
    return readdirSync(directory)
      .filter(name => name.endsWith(".json"))
      .map(name => ({ id: name.slice(0, -".json".length), path: join(directory, name) }));
  } catch { return []; }
}

function profileSources(provider: ProviderKey): Map<string, string> {
  const sources = new Map<string, string>();
  for (const entry of legacyProfiles(provider)) sources.set(entry.id, entry.path);
  // A managed profile wins a name collision; it is the one this code wrote.
  for (const entry of managedProfiles(provider)) sources.set(entry.id, entry.path);
  return sources;
}

export function listProfiles(provider: ProviderKey): ProviderProfile[] {
  const active = currentAccount(provider);
  return [...profileSources(provider).entries()]
    .map(([id, path]) => {
      const credentials = readJson(path);
      const account = credentials === null ? null
        : provider === "codex" ? codexAccount(credentials) : claudeAccount(credentials);
      return {
        id,
        label: account?.label ?? id,
        detail: account?.detail ?? null,
        current: !!account && !!active && account.id === active.id,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/** Snapshot the credentials currently on disk under a name he chose. */
export function saveProfile(provider: ProviderKey, label: string): ProviderProfile[] {
  const source = credentialPath(provider);
  if (!existsSync(source)) throw new Error("There are no credentials on this host to save yet.");
  const id = profileId(label);
  const directory = profileDirectory(provider);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${id}.json`);
  copyFileSync(source, target);
  log("info", "provider_profile_saved", { provider, profile_id: id });
  return listProfiles(provider);
}

/**
 * Put a saved profile's credentials in place. Writing through a temporary file
 * in the same directory keeps the live credential file whole: a reader either
 * sees the previous account or the next one, never a half-written file.
 *
 * This only changes what is on disk. Making a running provider use it is the
 * caller's activation step, which is why the two are one owner operation.
 */
export function activateProfile(provider: ProviderKey, id: string): ProviderAccount | null {
  const source = profileSources(provider).get(id);
  if (!source) throw new Error("That saved account no longer exists on this host.");
  const target = credentialPath(provider);
  const staged = `${target}.switching`;
  copyFileSync(source, staged);
  try { renameSync(staged, target); }
  catch (error) { try { unlinkSync(staged); } catch { /* the staged copy is disposable */ } throw error; }
  memo.delete(provider);
  const account = currentAccount(provider);
  log("info", "provider_profile_activated", { provider, profile_id: id, account_known: !!account });
  return account;
}
