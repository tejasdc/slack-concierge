import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";
import { WEEKLY_ALMOST_EXHAUSTED_PERCENT } from "./provider-reset-policy";

/**
 * Spending one banked rate limit reset on the named account.
 *
 * OpenAI grants these occasionally and they lapse thirty days later with no refund, so the
 * whole value is in choosing the moment. The Accounts button and a stopped-work policy
 * can each request one redemption.
 * There is no undo: the protocol's own outcomes include `alreadyRedeemed`, and a spent
 * grant is gone. A failed transport after the request was sent has an unknown outcome.
 *
 * The call is Codex's own `account/rateLimitResetCredit/consume`, reached by starting a
 * short-lived `codex app-server --stdio` with that account's `CODEX_HOME`. It has to be per
 * home rather than over the shared daemon socket, because the daemon holds one account's
 * token and the reset must land on the account he was looking at. Starting a child costs
 * under a second and touches neither the daemon nor any credential.
 */

const CODEX_ACCOUNTS = join(homedir(), ".codex-accounts");
const AGENT_CODEX_HOME = join(homedir(), ".codex");
const CODEX_CLI = process.env.CONCIERGE_CODEX_CLI ?? join(homedir(), ".local", "bin", "codex");
const CALL_TIMEOUT_MS = 25_000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const AUTOMATIC_EVIDENCE_MAX_AGE_MS = 60_000;

export type ResetCreditOutcome = Readonly<{
  /** `used` requires both a confirmed redemption and a fresh read permitting ordinary work. */
  status: "used" | "redeemed" | "none" | "failed" | "unknown";
  /** Said to him in his own words by the surface; never a protocol token. */
  detail: string;
  /** The grant's declared type. The installed App Server response names no reset windows. */
  resetType?: string | null;
  /** Provider identity verified on both limits reads after a usable redemption. */
  accountId?: string;
  /** Local completion time of the confirming limits read, for refusal ordering. */
  verifiedAtMs?: number;
  /** Fresh post-redemption credit count; never inferred from the older Accounts snapshot. */
  remainingCredits?: number | null;
  nextExpiresAt?: string | null;
}>;

/** Every Codex home on this machine, with the account each one holds. */
function homesByAccount(): Map<string, { home: string; accountId: string | null }> {
  const homes = new Map<string, { home: string; accountId: string | null }>();
  const add = (home: string) => {
    try {
      const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
      const payload = String(auth?.tokens?.id_token ?? "").split(".")[1] ?? "";
      const email = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.email;
      const accountId = auth?.tokens?.account_id;
      if (typeof email === "string" && email && !homes.has(email))
        homes.set(email, { home, accountId: typeof accountId === "string" && accountId ? accountId : null });
    } catch { /* a home without a readable identity cannot be addressed by account */ }
  };
  add(AGENT_CODEX_HOME);
  if (existsSync(CODEX_ACCOUNTS))
    for (const name of readdirSync(CODEX_ACCOUNTS).sort()) {
      const home = join(CODEX_ACCOUNTS, name);
      if (existsSync(join(home, "auth.json"))) add(home);
    }
  return homes;
}

/** Every credential home is relevant before spending a finite grant automatically. */
function savedCodexHomes(): string[] {
  const homes = [AGENT_CODEX_HOME];
  if (existsSync(CODEX_ACCOUNTS))
    for (const name of readdirSync(CODEX_ACCOUNTS).sort()) {
      const home = join(CODEX_ACCOUNTS, name);
      if (existsSync(join(home, "auth.json"))) homes.push(home);
    }
  return homes.filter(home => existsSync(join(home, "auth.json")));
}

function exactWindow(limits: any, minutes: number): { usedPercent: number; resetsAt: number } | null {
  const bucket = limits?.rateLimitsByLimitId?.codex ?? (limits?.rateLimits?.limitId === "codex" ? limits.rateLimits : null);
  const matches = [bucket?.primary, bucket?.secondary]
    .filter(window => window?.windowDurationMins === minutes);
  if (matches.length !== 1) return null;
  const window = matches[0];
  return typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
    && typeof window.resetsAt === "number" && window.resetsAt * 1000 > Date.now()
      ? { usedPercent: window.usedPercent, resetsAt: window.resetsAt } : null;
}

/** Read alternate accounts first; the target is reread last, immediately before spending. */
async function automaticResetPreflight(targetAccountId: string): Promise<{
  reason: string | null; validUntilMs: number;
}> {
  let validUntilMs = Infinity;
  for (const home of savedCodexHomes()) {
    let accountId: unknown;
    try { accountId = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))?.tokens?.account_id; }
    catch { return { reason: "saved_account_identity_unknown", validUntilMs }; }
    if (typeof accountId !== "string" || !accountId) return { reason: "saved_account_identity_unknown", validUntilMs };
    if (accountId === targetAccountId) continue;
    let other: any;
    try { other = await callAppServer(home, "account/rateLimits/read", {}); }
    catch { return { reason: "other_account_allowance_unknown", validUntilMs }; }
    if (other?.accountId !== accountId || other?.ordinaryUsageAllowed !== false)
      return { reason: "other_account_not_confirmed_blocked", validUntilMs };
    const weekly = exactWindow(other, WEEKLY_WINDOW_MINUTES);
    const fiveHour = exactWindow(other, FIVE_HOUR_WINDOW_MINUTES);
    const spent = [weekly, fiveHour].filter(window => window && window.usedPercent >= 100);
    if (!spent.length) return { reason: "other_account_spent_window_unknown", validUntilMs };
    validUntilMs = Math.min(validUntilMs, Date.now() + AUTOMATIC_EVIDENCE_MAX_AGE_MS,
      ...spent.map(window => window!.resetsAt * 1000));
  }
  return { reason: null, validUntilMs };
}

function automaticTargetValidUntil(limits: any, accountId: string, alternateValidUntilMs: number): number | null {
  if (limits?.accountId !== accountId || limits?.ordinaryUsageAllowed !== false) return null;
  const weekly = exactWindow(limits, WEEKLY_WINDOW_MINUTES);
  const fiveHour = exactWindow(limits, FIVE_HOUR_WINDOW_MINUTES);
  if (!weekly || !(weekly.usedPercent >= 100 || (fiveHour && fiveHour.usedPercent >= 100
    && weekly.usedPercent >= WEEKLY_ALMOST_EXHAUSTED_PERCENT))) return null;
  const validUntilMs = Math.min(alternateValidUntilMs, Date.now() + AUTOMATIC_EVIDENCE_MAX_AGE_MS,
    weekly.resetsAt * 1000,
    weekly.usedPercent < 100 && fiveHour ? fiveHour.resetsAt * 1000 : Infinity);
  return Date.now() < validUntilMs ? validUntilMs : null;
}

/** A short-lived app-server session for exactly one account home. */
async function withAppServer<T>(home: string, action: (call: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const child = spawn(CODEX_CLI, ["app-server", "--stdio"], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const failPending = (error: Error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  child.on("error", error => failPending(error));
  child.on("close", code => failPending(new Error(`Codex App Server closed before replying (${code ?? "unknown"}).`)));
  let id = 0;
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const call = (name: string, body: unknown) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: name, params: body ?? {} }) + "\n",
      error => { if (error) { pending.delete(requestId); reject(error); } });
  });
  createInterface({ input: child.stdout }).on("line", line => {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    const waiting = message?.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error?.message ?? "rejected")) : waiting.resolve(message.result);
  });
  const timer = setTimeout(() => {
    failPending(new Error("Codex App Server request timed out."));
    child.kill();
  }, CALL_TIMEOUT_MS);
  try {
    await call("initialize", {
      clientInfo: { name: "concierge", title: "Concierge", version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return await action(call);
  } finally { clearTimeout(timer); child.kill(); }
}

async function callAppServer(home: string, method: string, params: unknown): Promise<any> {
  return withAppServer(home, call => call(method, params));
}

export async function useCodexResetCredit(account: string, idempotencyKey = randomUUID(), automatic = false,
  beforeConsume?: () => void): Promise<ResetCreditOutcome> {
  const binding = homesByAccount().get(account);
  if (!binding) return { status: "failed", detail: `This machine is not signed in to ${account}.` };
  const { home, accountId } = binding;
  if (!accountId) return { status: "failed", detail: "This sign-in has no verified account identity. No reset was attempted." };
  let automaticEvidenceValidUntilMs = Infinity;
  if (automatic) {
    const preflight = await automaticResetPreflight(accountId);
    if (preflight.reason) {
      log("info", "codex_reset_auto_declined", { reason: preflight.reason });
      return { status: "failed", detail: "Fresh allowance evidence did not justify an automatic reset. No credit was spent." };
    }
    automaticEvidenceValidUntilMs = preflight.validUntilMs;
  }
  let limits: any;
  try {
    limits = await callAppServer(home, "account/rateLimits/read", {});
  } catch (error) {
    log("error", "codex_reset_credit_read_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", detail: "The account's reset credits could not be read. No reset was attempted." };
  }
  if (limits?.accountId !== accountId)
    return { status: "failed", detail: "The account reading does not match this sign-in. No reset was attempted." };
  if (automatic) {
    const validUntilMs = automaticTargetValidUntil(limits, accountId, automaticEvidenceValidUntilMs);
    if (validUntilMs === null) {
      log("info", "codex_reset_auto_declined", { reason: "target_allowance_unconfirmed" });
      return { status: "failed", detail: "Fresh allowance evidence did not justify an automatic reset. No credit was spent." };
    }
    automaticEvidenceValidUntilMs = validUntilMs;
  }
  const credits = limits?.rateLimitResetCredits?.credits;
  if (!Array.isArray(credits))
    return { status: "failed", detail: "The account's reset-credit details are unavailable. No reset was attempted." };
  const credit = credits.find((entry: any) => String(entry?.status ?? "") === "available");
  if (!credit && Number(limits?.rateLimitResetCredits?.availableCount ?? 0) > 0)
    return { status: "failed", detail: "This account reports available resets without a credit identifier. No reset was attempted." };
  if (!credit?.id) return { status: "none", detail: "There is no reset waiting on this account." };
  const resetType = credit?.resetType ?? credit?.reset_type ?? null;
  if (automatic && resetType !== "codexRateLimits")
    return { status: "failed", detail: "The available reset does not identify the Codex allowance. No credit was spent." };
  let result: any;
  let requestSent = false;
  try {
    if (automatic) {
      // The final read, deadline check, durable reservation and consume RPC share one
      // initialized child. There is no second process startup after the last check.
      const attempt = await withAppServer(home, async call => {
        const fresh = await call("account/rateLimits/read", {});
        const validUntilMs = automaticTargetValidUntil(fresh, accountId, automaticEvidenceValidUntilMs);
        const sameGrant = fresh?.rateLimitResetCredits?.credits?.some((entry: any) =>
          entry?.id === credit.id && entry?.status === "available" && entry?.resetType === "codexRateLimits");
        if (validUntilMs === null || !sameGrant || Date.now() >= validUntilMs)
          return { declined: true as const, result: null };
        beforeConsume?.();
        // A synchronous ledger reservation can cross the deadline. Check it again at
        // the last point before writing the RPC to the already initialized child.
        if (Date.now() >= validUntilMs) return { declined: true as const, result: null };
        requestSent = true;
        return { declined: false as const,
          result: await call("account/rateLimitResetCredit/consume", { creditId: credit.id, idempotencyKey }) };
      });
      if (attempt.declined)
        return { status: "failed", detail: "Fresh allowance evidence did not justify an automatic reset. No credit was spent." };
      result = attempt.result;
    } else {
      beforeConsume?.();
      requestSent = true;
      result = await callAppServer(home, "account/rateLimitResetCredit/consume", { creditId: credit.id, idempotencyKey });
    }
  } catch (error) {
    if (!requestSent) {
      log("error", "codex_reset_credit_attempt_record_failed", { error: error instanceof Error ? error.message : String(error) });
      return { status: "failed", detail: "The reset was declined before sending. No credit was spent." };
    }
    log("error", "codex_reset_credit_outcome_unknown", { error: error instanceof Error ? error.message : String(error) });
    return { status: "unknown", detail: "The reset request did not return an outcome. It may have spent a credit; check this account before trying again.", resetType };
  }
  const outcome = String(result?.outcome ?? "");
  if (outcome === "nothingToReset" || outcome === "noCredit")
    return { status: "none", detail: outcome === "nothingToReset"
      ? "No current allowance window was eligible for a reset." : "This account has no reset credit available.", resetType };
  if (outcome !== "reset" && outcome !== "alreadyRedeemed") {
    log("error", "codex_reset_credit_unrecognized_outcome", { outcome });
    return { status: "unknown", detail: "The reset returned an unrecognized outcome. Check this account before trying again.", resetType };
  }
  // The installed App Server response names no reset windows. A fresh source read must
  // prove that this same account now permits ordinary included work before releasing holds.
  let after: any;
  let verifiedAtMs: number;
  try { after = await callAppServer(home, "account/rateLimits/read", {}); verifiedAtMs = Date.now(); }
  catch (error) {
    log("error", "codex_reset_credit_postread_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "redeemed", detail: "The reset credit was redeemed, but current allowance could not be checked. Work remains held.", resetType };
  }
  const sameAccount = after?.accountId === accountId;
  const hasRoom = sameAccount && after?.ordinaryUsageAllowed === true;
  const count = Number(after?.rateLimitResetCredits?.availableCount);
  const remainingCredits = Number.isSafeInteger(count) && count >= 0 ? count : null;
  const expiries = (after?.rateLimitResetCredits?.credits ?? [])
    .filter((entry: any) => entry?.status === "available" && Number.isFinite(entry?.expiresAt))
    .map((entry: any) => entry.expiresAt as number).sort((a: number, b: number) => a - b);
  const nextExpiresAt = expiries.length ? new Date(expiries[0]! * 1000).toISOString() : null;
  log("warn", "codex_reset_credit_used", {
    account_known: true, outcome,
    reset_type: resetType ? String(resetType) : null,
    room_confirmed: hasRoom,
  });
  return hasRoom
    ? { status: "used", detail: "The reset credit was redeemed and this account now permits ordinary included work.",
        resetType, accountId, verifiedAtMs, remainingCredits, nextExpiresAt }
    : { status: "redeemed", detail: "The reset credit was redeemed, but this account has not confirmed room for ordinary work. Work remains held.", resetType };
}
