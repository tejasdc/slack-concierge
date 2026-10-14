import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

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

export type ResetCreditOutcome = Readonly<{
  /** `used` requires both a confirmed redemption and a fresh read permitting ordinary work. */
  status: "used" | "redeemed" | "none" | "failed" | "unknown";
  /** Said to him in his own words by the surface; never a protocol token. */
  detail: string;
  /** The grant's declared type. The installed App Server response names no reset windows. */
  resetType?: string | null;
}>;

/** Every Codex home on this machine, with the account each one holds. */
function homesByAccount(): Map<string, string> {
  const homes = new Map<string, string>();
  const add = (home: string) => {
    try {
      const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
      const payload = String(auth?.tokens?.id_token ?? "").split(".")[1] ?? "";
      const email = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.email;
      if (typeof email === "string" && email && !homes.has(email)) homes.set(email, home);
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

/** One request against a throwaway app-server for exactly this account's home. */
async function callAppServer(home: string, method: string, params: unknown): Promise<any> {
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
    return await call(method, params);
  } finally { clearTimeout(timer); child.kill(); }
}

export async function useCodexResetCredit(account: string, idempotencyKey = randomUUID()): Promise<ResetCreditOutcome> {
  const home = homesByAccount().get(account);
  if (!home) return { status: "failed", detail: `This machine is not signed in to ${account}.` };
  let limits: any;
  try {
    limits = await callAppServer(home, "account/rateLimits/read", {});
  } catch (error) {
    log("error", "codex_reset_credit_read_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", detail: "The account's reset credits could not be read. No reset was attempted." };
  }
  const credits = limits?.rateLimitResetCredits?.credits;
  if (!Array.isArray(credits))
    return { status: "failed", detail: "The account's reset-credit details are unavailable. No reset was attempted." };
  const credit = credits.find((entry: any) => String(entry?.status ?? "") === "available");
  if (!credit && Number(limits?.rateLimitResetCredits?.availableCount ?? 0) > 0)
    return { status: "failed", detail: "This account reports available resets without a credit identifier. No reset was attempted." };
  if (!credit?.id) return { status: "none", detail: "There is no reset waiting on this account." };
  const resetType = credit?.resetType ?? credit?.reset_type ?? null;
  let result: any;
  try {
    result = await callAppServer(home, "account/rateLimitResetCredit/consume", { creditId: credit.id, idempotencyKey });
  } catch (error) {
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
  try { after = await callAppServer(home, "account/rateLimits/read", {}); }
  catch (error) {
    log("error", "codex_reset_credit_postread_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "redeemed", detail: "The reset credit was redeemed, but current allowance could not be checked. Work remains held.", resetType };
  }
  const sameAccount = limits?.accountId === after?.accountId;
  const hasRoom = sameAccount && after?.ordinaryUsageAllowed === true;
  log("warn", "codex_reset_credit_used", {
    account_known: true, outcome,
    reset_type: resetType ? String(resetType) : null,
    room_confirmed: hasRoom,
  });
  return hasRoom
    ? { status: "used", detail: "The reset credit was redeemed and this account now permits ordinary included work.", resetType }
    : { status: "redeemed", detail: "The reset credit was redeemed, but this account has not confirmed room for ordinary work. Work remains held.", resetType };
}
