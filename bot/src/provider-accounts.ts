import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";
// Type-only in the other direction, so this is a one-way dependency at runtime.
import { providerAccountUsage } from "./provider-account-usage";

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
// Extra Codex accounts, one folder per account. Shared with the usage reader, which has
// always listed these; both now mean the same thing by "an account this machine has".
export const CODEX_ACCOUNTS = join(homedir(), ".codex-accounts");
/**
 * And the same for Claude, which needs them for a second reason: a turn is launched against
 * an account by pointing the process at that account's home, so the home is where the
 * credential has to be anyway. Keeping a second copy under `auth-profiles` would put one
 * refresh token in two places, and whichever refreshed first would invalidate the other.
 * One account, one credential, one place — read by the Accounts surface and by dispatch.
 */
export const CLAUDE_ACCOUNTS = join(homedir(), ".claude-accounts");

/** Where an account's own credential lives, when it is not the one in use. */
export function accountHome(provider: ProviderKey, id: string): string {
  return join(provider === "codex" ? CODEX_ACCOUNTS : CLAUDE_ACCOUNTS, id);
}

function homeCredential(provider: ProviderKey, home: string): string {
  return join(home, provider === "codex" ? "auth.json" : ".credentials.json");
}

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

/**
 * The account Codex is actually running on, as Codex reports it.
 *
 * The App Server reads `auth.json` once at start and keeps that token, so the file and the
 * running daemon can disagree: with the file deleted mid-login this host's screen said "no
 * Codex account" while the daemon was still working happily on the previous one. The file
 * remains the identity where it exists, because that is what the next start will load; this
 * answers for the daemon when the file cannot.
 */
let codexSignIn: ProviderAccount | null = null;
export function setCodexAccountInUse(account: { email: string | null; planType: string | null } | null): void {
  codexSignIn = account?.email
    ? { id: account.email, label: account.email, detail: account.planType ? `ChatGPT ${account.planType}` : null }
    : null;
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
  catch { memo.delete(provider); return provider === "claude-code" ? claudeSignIn : codexSignIn; }
  const cached = memo.get(provider);
  if (cached?.key === key) return cached.account;
  const credentials = readJson(path);
  const account = credentials === null ? null
    : provider === "codex" ? codexAccount(credentials) : claudeAccount(credentials);
  memo.set(provider, { key, account });
  return account ?? (provider === "claude-code" ? claudeSignIn : codexSignIn);
}

/** Identity component of a usage-cache scope. Never a secret. */
export function accountScope(provider: ProviderKey): string {
  return currentAccount(provider)?.id ?? "unattributed";
}

export function profileId(label: string): string {
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

/**
 * The extra Codex accounts already installed on this host, one folder per account under
 * `~/.codex-accounts`. `provider-account-usage.ts` has always read these to show their
 * limits, so the surface could tell him an account existed and how much of it was left
 * while offering no way to put the machine on it — the one thing he wanted. They are
 * complete credential files in the same shape as the live one, so they are switchable
 * like any other saved account, and now they are.
 */
function installedAccounts(provider: ProviderKey): { id: string; path: string }[] {
  const root = provider === "codex" ? CODEX_ACCOUNTS : CLAUDE_ACCOUNTS;
  try {
    return readdirSync(root)
      // A dotted name is a sign-in still in progress, not an account he has.
      .filter(name => !name.startsWith("."))
      .map(name => ({ id: name, path: homeCredential(provider, join(root, name)) }))
      .filter(entry => entry.id.length > 0 && existsSync(entry.path))
      // A Claude credential names no account, so a home we cannot put an address to is not
      // offered: switching to an unnamed credential is how he was nearly moved onto the wrong
      // account on 2026-09-22. This box holds exactly such a leftover — `.claude-accounts/second`,
      // a week-old copy of the Gmail account from an experiment, whose name matches no address.
      // Codex credentials say who they are, so they need no such filter.
      .filter(entry => provider !== "claude-code" || !!profileAccountEmail(provider, entry.id));
  } catch { return []; }
}

/**
 * Claude accounts kept before homes existed were snapshotted into `auth-profiles`. That is
 * now the wrong place — dispatch launches against a home, so a credential left behind would
 * have to be copied there, and one refresh token in two places means whichever refreshes
 * first invalidates the other.
 *
 * So each one moves into its own home, once, by rename rather than copy: at no instant do
 * two live copies exist. This runs inside the code that reads homes, so it can never happen
 * before the code that understands it — a move done by hand could land while the old runtime
 * was still reading the old path, and the account would vanish from his Accounts screen until
 * the next release. To undo it, move `<home>/.credentials.json` back to
 * `auth-profiles/<id>.json`; nothing stopped reading that path.
 */
let legacyClaudeProfilesAdopted = false;
function adoptLegacyClaudeProfiles(): void {
  if (legacyClaudeProfilesAdopted) return;
  legacyClaudeProfilesAdopted = true;
  for (const entry of managedProfiles("claude-code")) {
    const home = accountHome("claude-code", entry.id);
    const target = homeCredential("claude-code", home);
    if (existsSync(target)) continue;
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      renameSync(entry.path, target);
      const name = join(profileDirectory("claude-code"), `${entry.id}.email`);
      if (existsSync(name)) renameSync(name, join(home, ".account-email"));
      log("info", "provider_profile_moved_into_home", { provider: "claude-code", profile_id: entry.id });
    } catch (error) {
      log("info", "provider_profile_home_move_failed", { profile_id: entry.id, error_name: (error as Error)?.name ?? "Error" });
    }
  }
}

function profileSources(provider: ProviderKey): Map<string, string> {
  if (provider === "claude-code") adoptLegacyClaudeProfiles();
  const sources = new Map<string, string>();
  for (const entry of installedAccounts(provider)) sources.set(entry.id, entry.path);
  for (const entry of legacyProfiles(provider)) sources.set(entry.id, entry.path);
  // A managed profile wins a name collision; it is the one this code wrote.
  for (const entry of managedProfiles(provider)) sources.set(entry.id, entry.path);
  return sources;
}

/**
 * Which account a kept credential belongs to.
 *
 * A Codex credential says so itself. A Claude one does not — it carries no email at all,
 * and the code that labelled it borrowed the email from `~/.claude.json`, which is the
 * global record of whoever is signed in *now*. So every kept Claude account was labelled
 * with the current one's address: his personal account sat in the list wearing his work
 * account's email, which read as the same account listed twice and would have switched him
 * to the wrong one had he pressed it (2026-09-22). An account's name is recorded beside it
 * when it is kept, and never inferred from whoever happens to be signed in.
 */
function profileAccountEmail(provider: ProviderKey, id: string): string | null {
  if (provider !== "claude-code") return null;
  // Beside its credential first, which is where an account's own home keeps it; then the
  // place accounts kept before homes existed were named, so nothing loses its address.
  for (const path of [join(accountHome(provider, id), ".account-email"), join(profileDirectory(provider), `${id}.email`)]) {
    try { const name = readFileSync(path, "utf8").trim(); if (name) return name; } catch { /* try the next */ }
  }
  return recoverProfileAccountEmail(provider, id);
}

/**
 * The address of an account kept before its name was recorded.
 *
 * The file was named by `profileId(address)`, so the address is recovered by applying that
 * same function forward to the addresses this machine already knows — the usage reader lists
 * every Claude account by address — and taking the one whose name matches. That is an
 * equality check on a function we own, not a guess at what a slug used to be.
 *
 * Leaving it unrecovered was a choice and it was wrong. The row then read
 * `tejastej-dc-gmail-com`, and because a usage reading is keyed by address it matched
 * nothing, so the same row also said its usage had never been read while that account was
 * sitting at its weekly limit. He read the screen as broken, and it was: "what is happening
 * with my email address here? Why is it being dispelled like that?" (2026-09-23). The answer
 * was one lookup away the whole time.
 */
function recoverProfileAccountEmail(provider: ProviderKey, id: string): string | null {
  if (provider !== "claude-code") return null;
  const known = new Set<string>();
  for (const account of providerAccountUsage(provider)?.accounts ?? []) if (account.label) known.add(account.label);
  const live = claudeSignIn?.label ?? readJson(join(homedir(), ".claude.json"))?.oauthAccount?.emailAddress;
  if (typeof live === "string" && live) known.add(live);
  for (const address of known) {
    if (!address.includes("@")) continue;
    let named: string;
    try { named = profileId(address); } catch { continue; }
    if (named !== id) continue;
    // Recovered once, recorded for good — beside the credential when the account has its own
    // home, which is where the next read looks first.
    const home = accountHome(provider, id);
    const where = existsSync(home) ? join(home, ".account-email") : join(profileDirectory(provider), `${id}.email`);
    try { writeFileSync(where, address, { mode: 0o600 }); } catch { /* the name is still right this read */ }
    return address;
  }
  return null;
}

export function listProfiles(provider: ProviderKey): ProviderProfile[] {
  const active = currentAccount(provider);
  return [...profileSources(provider).entries()]
    .map(([id, path]) => {
      const credentials = readJson(path);
      const account = credentials === null ? null
        : provider === "codex" ? codexAccount(credentials) : claudeAccount(credentials);
      const recorded = profileAccountEmail(provider, id);
      // Claude's identity on disk is a refresh-token fingerprint, and a token rotates, so
      // comparing fingerprints eventually calls the account in use "not current" and lists
      // it a second time. An address does not rotate.
      const current = recorded && active?.label
        ? recorded === active.label
        : !!account && !!active && account.id === active.id;
      return {
        id,
        // Without a recorded name, say the name it was kept under rather than borrowing
        // someone else's. It is less pretty and it is true.
        label: recorded ?? account?.label ?? id,
        detail: account?.detail ?? null,
        current,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Keep every account this machine has been signed into, without him having to ask.
 *
 * There was a "Remember this account" button, and it was nonsense: signing in IS how an
 * account becomes his machine's. He said so (2026-09-22). Nobody signs in to an account
 * they want forgotten, so the choice never existed and the button only made him carry a
 * concept the system should own. The account in use is snapshotted whenever it is not
 * already kept, which is idempotent and needs no moment to be caught.
 */
export function rememberCurrentAccount(provider: ProviderKey): void {
  // Claude's default credential already has a home. A snapshot would make a second
  // refresh-token copy, so a read or a switch must never create one.
  if(provider==='claude-code')return;
  const account = currentAccount(provider);
  if (!account) return;
  const kept = listProfiles(provider).find(profile => profile.current);
  if (kept) {
    // An account kept before its name was recorded shows the name it was filed under. We
    // know this one's address, so give it back rather than leaving him reading a slug.
    if (provider === "claude-code" && kept.label !== account.label && account.label.includes("@")) {
      try { writeFileSync(join(profileDirectory(provider), `${kept.id}.email`), account.label, { mode: 0o600 }); }
      catch { /* a name it can rewrite next time is not worth failing a read for */ }
    }
    return;
  }
  try { saveProfile(provider, account.label); }
  catch (error) { log("info", "provider_account_not_kept", { provider, error_name: (error as Error)?.name ?? "Error" }); }
}

/** Snapshot the credentials currently on disk under a given name. */
export function saveProfile(provider: ProviderKey, label: string): ProviderProfile[] {
  if(provider==='claude-code')throw new Error('Claude accounts are kept by signing in to their own homes.');
  const source = credentialPath(provider);
  if (!existsSync(source)) throw new Error("There are no credentials on this host to save yet.");
  const id = profileId(label);
  // A kept Codex account goes where the usage reader already looks: its own home under
  // ~/.codex-accounts, which is how two accounts' limits have been readable side by side
  // since 2026-09-18. Keeping it anywhere else makes an account switchable but silent,
  // which is the split that cost him his second usage bar in the first place.
  const home = accountHome(provider, id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  copyFileSync(source, homeCredential(provider, home));
  // Claude's credential names no account, so the account's own name is recorded beside it.
  if (provider === "claude-code" && label.includes("@")) writeFileSync(join(home, ".account-email"), label, { mode: 0o600 });
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
/**
 * Put a specific account home's credentials in use. The home is already the account's own,
 * so nothing is lost by this beyond whatever was active, which is kept first.
 */
export function activateProfileHome(home: string): ProviderAccount | null {
  const source = join(home, "auth.json");
  if (!existsSync(source)) throw new Error("That account home holds no credentials.");
  rememberCurrentAccount("codex");
  const target = credentialPath("codex"), staged = `${target}.switching`;
  copyFileSync(source, staged);
  try { renameSync(staged, target); }
  catch (error) { try { unlinkSync(staged); } catch { /* the staged copy is disposable */ } throw error; }
  memo.delete("codex");
  return currentAccount("codex");
}

export function activateProfile(provider: ProviderKey, id: string): ProviderAccount | null {
  if(provider==='claude-code')throw new Error('Claude account selection does not activate a credential.');
  const source = profileSources(provider).get(id);
  if (!source) throw new Error("That saved account no longer exists on this host.");
  // Whatever is in place now is about to be overwritten. If this machine holds no other
  // copy of it, that copy is the only live token it has for that account, and overwriting
  // it loses the account outright — which is exactly what happened on 2026-09-22.
  rememberCurrentAccount(provider);
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
