import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";
// Type-only in the other direction, so this is a one-way dependency at runtime.
import { storedProviderAccountLabels } from "./provider-account-usage";

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
// `signedIn` is false when the kept login can no longer renew, so the surface offers a sign-in
// for that account instead of a switch that is certain to be refused.
export type ProviderProfile = Readonly<{ id: string; label: string; detail: string | null; current: boolean; signedIn: boolean }>;

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
      .filter(name => name.startsWith("auth.json.") && name !== "auth.json" && !name.includes("superseded")
        && !name.endsWith(".switching"))
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
  // The stored readings, not providerAccountUsage(): that view marks the agents' account by asking
  // whether accounts have homes, which lists profiles, which lands back here for any account with no
  // recorded name. The cycle ran until the stack overflowed (a catch hid it), re-reading every
  // account file ~3,000 times per Accounts read and freezing the owner for up to 144 s (2026-10-08).
  for (const label of storedProviderAccountLabels(provider)) known.add(label);
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

/** How many accounts this machine keeps, without reading who they are. */
export function keptProfileCount(provider: ProviderKey): number {
  return profileSources(provider).size;
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
        signedIn: holdsLogin(provider, credentials),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Whether a kept login still holds what it needs to renew itself.
 *
 * Presence, not proof: a renewal key can be present and already spent elsewhere, which only
 * the provider can say, so a switch still proves the account answers before it is recorded.
 * What this does prove is the opposite case. Claude empties a login it could not renew, and
 * that emptied login sat in his list behind a Switch button that could never work
 * (tejas@chann.app, 2026-09-23 to 2026-09-29), when the one thing it needed was a sign-in.
 */
function holdsLogin(provider: ProviderKey, credentials: any): boolean {
  const key = provider === "codex" ? credentials?.tokens?.refresh_token : credentials?.claudeAiOauth?.refreshToken;
  return typeof key === "string" && key.length > 0;
}

/** Whether the kept account `id` still holds a login on this machine. */
export function profileSignedIn(provider: ProviderKey, id: string): boolean {
  const source = profileSources(provider).get(id);
  return !!source && holdsLogin(provider, readJson(source));
}

/**
 * Accounts are kept by signing in, never by copying a login.
 *
 * A login is a renewal key that the provider replaces every time it is used, and the old key
 * stops working the moment it is replaced. Two files holding one login therefore cannot both
 * stay alive: whichever renews first kills the other. Every lost account on this server
 * traces to such a copy — the Claude account kept beside the usage tool's own copy of it, the
 * Codex accounts copied into and out of the agents' home on every switch (2026-09-22 and
 * 2026-09-29, when a switch put a spent chann.app copy in place and overwrote the working
 * gmail login without keeping it). So there is no snapshot operation any more; an older
 * surface that still asks for one is told how accounts are kept instead.
 */
export function saveProfile(_provider: ProviderKey, _label: string): ProviderProfile[] {
  throw new Error("Accounts are kept by signing in to them. A copied login stops working as soon as the original renews.");
}

// The agents' own login is set aside into the archive rather than beside itself: a file named
// `auth.json.<anything>` next to it is listed as a switchable account by `legacyProfiles`.
function setAside(path: string): string | null {
  if (!existsSync(path)) return null;
  const aside = path === credentialPath("codex")
    ? join(CODEX_HOME, "retired-auth", `auth.json.superseded-${Date.now()}`)
    : `${path}.superseded-${Date.now()}`;
  mkdirSync(join(aside, ".."), { recursive: true, mode: 0o700 });
  renameSync(path, aside);
  return aside;
}

/** The home an account already has on this machine, found by who its login says it is. */
function codexHomeFor(account: ProviderAccount): string {
  for (const entry of installedAccounts("codex")) {
    if (codexAccount(readJson(entry.path))?.id === account.id) return join(CODEX_ACCOUNTS, entry.id);
  }
  return accountHome("codex", profileId(account.label));
}

/** The kept home of the account whose login is at `credential`, when this machine already has one. */
export function existingCodexHome(credential: string): string | null {
  const account = codexAccount(readJson(credential));
  if (!account) return null;
  for (const entry of installedAccounts("codex")) {
    if (codexAccount(readJson(entry.path))?.id === account.id) return join(CODEX_ACCOUNTS, entry.id);
  }
  return null;
}

export type CodexAccountMove = Readonly<{ incoming: ProviderAccount; outgoing: ProviderAccount | null; undo(): void }>;

/**
 * Put a kept Codex account in use by moving its login into the agents' home, and the login it
 * replaces back into that account's own home. At no instant does one login exist twice, and
 * nothing is overwritten: a file already at a destination is set aside, never deleted.
 *
 * The daemon only reads `~/.codex` at start, so the caller restarts it and must then prove the
 * running daemon renews as `incoming`. When it cannot, `undo` puts both logins back where they
 * were, so a failed switch leaves exactly the machine he had.
 */
export function moveCodexAccountIntoUse(source: string): CodexAccountMove {
  const live = credentialPath("codex");
  const incoming = codexAccount(readJson(source));
  if (!incoming) throw new Error("That saved account holds no Codex login.");
  const outgoing = existsSync(live) ? codexAccount(readJson(live)) : null;
  let outgoingTarget: string | null = null, outgoingAside: string | null = null, liveAside: string | null = null;
  if (outgoing && outgoing.id !== incoming.id) {
    const home = codexHomeFor(outgoing);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    outgoingTarget = join(home, "auth.json");
    outgoingAside = setAside(outgoingTarget);
    renameSync(live, outgoingTarget);
  } else {
    // The same account signed in afresh, or nothing in use: the incoming login is the newer one.
    liveAside = setAside(live);
  }
  renameSync(source, live);
  memo.delete("codex");
  log("info", "provider_profile_moved_into_use", { provider: "codex", replaced_kept: !!outgoingTarget });
  return {
    incoming, outgoing,
    // Each step is attempted even when an earlier one fails, so the login he had is put back
    // whatever became of the one that was refused.
    undo: () => {
      const failed: string[] = [];
      const step = (name: string, from: string | null, to: string) => {
        if (!from || !existsSync(from)) return;
        try { renameSync(from, to); } catch { failed.push(name); }
      };
      step("incoming", live, source);
      if (outgoingTarget) {
        step("outgoing", outgoingTarget, live);
        step("kept", outgoingAside, outgoingTarget);
      } else step("previous", liveAside, live);
      memo.delete("codex");
      log(failed.length ? "error" : "info", "provider_profile_move_undone", { provider: "codex", failed_steps: failed });
    },
  };
}

/** Where a kept Codex account's login is, by the id the Accounts surface lists it under. */
export function codexProfileSource(id: string): string | null {
  return profileSources("codex").get(id) ?? null;
}
