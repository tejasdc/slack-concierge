/**
 * Home resolution — one path per account, per machine, deterministically.
 *
 * On 2026-11-19 a hand `claude /login` into the live root while the same account
 * already had a per-account folder caused `accounts.validate` to return
 * `resolution:"ambiguous"` for every Claude turn. The cause was that
 * `runnerAccountHomes` enumerated the live root and each per-account folder as
 * INDEPENDENT candidates, so two candidates could share one account label.
 *
 * The invariant this module enforces: for any `(provider, account_label)`,
 * at most ONE home is returned as the launch home. If the live root happens to
 * hold a login resolving to the same account as a per-account folder, the
 * per-account folder wins; the live root is recorded as a benign mirror. If the
 * live root holds a login for a label that has no per-account folder yet, the
 * resolver reports `new-account-in-live-root` so the operator can migrate; this
 * is never a dispatch refusal.
 *
 * See:
 * - `docs/incidents/2026-11-19-opus-only-refusal-blocked-every-claude-turn.md` (fault F3)
 * - `docs/plans/2026-11-19-provider-account-rebuild-architecture.md` §4
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type ResolverProvider = "claude-code" | "codex";

export type HomeRecord = Readonly<{
  provider: ResolverProvider;
  label: string;
  canonicalHome: string;
  liveRootMirror: boolean;  // live root also holds this same login
  liveRoot: string;         // the live root path on this machine
  accountId: string | null;
}>;

export type LiveRootNewAccount = Readonly<{
  provider: ResolverProvider;
  label: string;            // label the live root resolves to
  liveRoot: string;
  accountId: string | null;
}>;

export type ResolveHomeResult =
  | { kind: "none" }
  | { kind: "resolved"; record: HomeRecord }
  | { kind: "new-account-in-live-root"; record: LiveRootNewAccount };

/**
 * Base path for home discovery. Default: `homedir()`. Tests override via
 * `setHomeRootForTesting` so a scratch dir can replace $HOME; `homedir()` does
 * not consult the `HOME` env var once a process has started on macOS.
 */
let homeRootOverride: string | null = null;

/** @internal — tests only */
export function setHomeRootForTesting(path: string | null): void {
  homeRootOverride = path;
}

export function homeRoot(): string {
  return homeRootOverride ?? homedir();
}

/** Live-root path for a provider on this machine. */
export function liveRootFor(provider: ResolverProvider): string {
  return join(homeRoot(), provider === "codex" ? ".codex" : ".claude");
}

/** Per-account folder root (`~/.claude-accounts` or `~/.codex-accounts`). */
export function accountFolderRoot(provider: ResolverProvider): string {
  return join(homeRoot(), provider === "codex" ? ".codex-accounts" : ".claude-accounts");
}

/**
 * Enumerate accounts known to this machine, deduped by label. Per-account folder wins
 * over live root. A live-root-only account (no folder yet) is NOT included; it is
 * surfaced through `liveRootOrphans` separately.
 */
export function listAccounts(provider: ResolverProvider): HomeRecord[] {
  return resolveAll(provider).resolved;
}

/**
 * The accounts whose only sign-in is the live root (no per-account folder).
 * The operator's `accounts adopt-live-root` CLI uses this list to decide what to migrate.
 */
export function liveRootOrphans(provider: ResolverProvider): LiveRootNewAccount[] {
  return resolveAll(provider).liveRootOrphans;
}

/**
 * Return the canonical home for a `(provider, label)`, deduping by label so a live-root
 * mirror can never create a second candidate. The three result kinds:
 *   - `resolved`: a per-account folder exists for this label; it is the launch home.
 *     `liveRootMirror` is true iff the live root is signed into the same label.
 *   - `new-account-in-live-root`: the live root is signed into this label but no
 *     per-account folder exists yet. Not a launch home; the operator can migrate.
 *   - `none`: no signed-in home holds this label on this machine.
 */
export function resolveAccountHome(provider: ResolverProvider, label: string): ResolveHomeResult {
  const { resolved, liveRootOrphans: orphans } = resolveAll(provider);
  const record = resolved.find(entry => entry.label === label);
  if (record) return { kind: "resolved", record };
  const orphan = orphans.find(entry => entry.label === label);
  if (orphan) return { kind: "new-account-in-live-root", record: orphan };
  return { kind: "none" };
}

type Enumerated = { resolved: HomeRecord[]; liveRootOrphans: LiveRootNewAccount[] };

function resolveAll(provider: ResolverProvider): Enumerated {
  const liveRoot = liveRootFor(provider);
  const liveRootResolved = readHome(provider, liveRoot);
  const perAccount: Array<{ home: string; label: string; accountId: string | null }> = [];
  let names: string[] = [];
  try {
    names = readdirSync(accountFolderRoot(provider)).filter(name => !name.startsWith("."));
  } catch {
    names = [];
  }
  for (const name of names) {
    const home = join(accountFolderRoot(provider), name);
    const info = readHome(provider, home);
    if (!info) continue;
    perAccount.push({ home, label: info.label, accountId: info.accountId });
  }
  const byLabel = new Map<string, { home: string; accountId: string | null }>();
  // Per-account folders are added first so they win on duplicates.
  for (const entry of perAccount) {
    if (!byLabel.has(entry.label)) byLabel.set(entry.label, { home: entry.home, accountId: entry.accountId });
  }
  const resolved: HomeRecord[] = [];
  const liveRootOrphans: LiveRootNewAccount[] = [];
  for (const [label, entry] of byLabel) {
    const liveRootMirror = liveRootResolved?.label === label;
    resolved.push({ provider, label, canonicalHome: entry.home, liveRootMirror, liveRoot, accountId: entry.accountId });
  }
  if (liveRootResolved && !byLabel.has(liveRootResolved.label)) {
    liveRootOrphans.push({
      provider,
      label: liveRootResolved.label,
      liveRoot,
      accountId: liveRootResolved.accountId,
    });
  }
  return { resolved, liveRootOrphans };
}

type RawHomeInfo = { label: string; accountId: string | null };

function readHome(provider: ResolverProvider, home: string): RawHomeInfo | null {
  return provider === "codex" ? readCodexHome(home) : readClaudeHome(home);
}

function readCodexHome(home: string): RawHomeInfo | null {
  const credentials = readJsonFile(join(home, "auth.json"));
  const id = credentials?.tokens?.account_id;
  const token = credentials?.tokens?.id_token;
  if (typeof id !== "string" || !id || typeof token !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return { label: typeof claims?.email === "string" ? claims.email : id, accountId: id };
  } catch {
    return { label: id, accountId: id };
  }
}

function readClaudeHome(home: string): RawHomeInfo | null {
  const credentials = readJsonFile(join(home, ".credentials.json"));
  const refresh = credentials?.claudeAiOauth?.refreshToken;
  if (typeof refresh !== "string" || !refresh) return null;
  const recorded = readTextFile(join(home, ".account-email"));
  const live = readJsonFile(join(homeRoot(), ".claude.json"))?.oauthAccount?.emailAddress;
  const subscription = credentials?.claudeAiOauth?.subscriptionType;
  const plan = typeof subscription === "string" && subscription
    ? `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : "Claude subscription";
  const liveRoot = liveRootFor("claude-code");
  const label = recorded ?? (home === liveRoot && typeof live === "string" && live ? live : plan);
  const accountId = createHash("sha256").update(refresh).digest("hex").slice(0, 16);
  return { label, accountId };
}

function readJsonFile(path: string): any | null {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function readTextFile(path: string): string | null {
  try { const value = readFileSync(path, "utf8").trim(); return value || null; } catch { return null; }
}
