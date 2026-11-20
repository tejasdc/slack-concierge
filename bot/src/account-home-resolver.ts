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
  | { kind: "ambiguous"; count: number }
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
  const { resolved, liveRootOrphans: orphans, ambiguousCounts } = resolveAll(provider);
  const records = resolved.filter(entry => entry.label === label);
  if (records.length === 1) return { kind: "resolved", record: records[0]! };
  const ambiguousCount = ambiguousCounts.get(label);
  if (ambiguousCount && ambiguousCount > 1) return { kind: "ambiguous", count: ambiguousCount };
  const orphan = orphans.find(entry => entry.label === label);
  if (orphan) return { kind: "new-account-in-live-root", record: orphan };
  return { kind: "none" };
}

type Enumerated = { resolved: HomeRecord[]; liveRootOrphans: LiveRootNewAccount[]; ambiguousCounts: Map<string, number> };

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
  // Every per-account folder remains its own candidate so `accounts.validate` can
  // still refuse two folders claiming the same label as ambiguous. Downstream callers
  // detect that ambiguity by `.filter(c => c.label === label).length > 1` and treat it
  // as "no safe launch home". The dedup is only about suppressing the LIVE ROOT as a
  // second candidate when a per-account folder already carries the same label — the
  // F3 live-root-mirror case, where the two point at the same account.
  const labelsInPerAccount = new Set(perAccount.map(entry => entry.label));
  const labelCounts = new Map<string, number>();
  for (const entry of perAccount) labelCounts.set(entry.label, (labelCounts.get(entry.label) ?? 0) + 1);
  const resolved: HomeRecord[] = perAccount.map(entry => ({
    provider,
    label: entry.label,
    canonicalHome: entry.home,
    liveRootMirror: liveRootResolved?.label === entry.label,
    liveRoot,
    accountId: entry.accountId,
  }));
  const liveRootOrphans: LiveRootNewAccount[] = [];
  if (liveRootResolved && !labelsInPerAccount.has(liveRootResolved.label)) {
    liveRootOrphans.push({
      provider,
      label: liveRootResolved.label,
      liveRoot,
      accountId: liveRootResolved.accountId,
    });
  }
  return { resolved, liveRootOrphans, ambiguousCounts: labelCounts };
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
