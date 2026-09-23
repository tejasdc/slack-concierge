import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

/**
 * Spending one banked rate limit reset, on the account he named, because he pressed it.
 *
 * OpenAI grants these occasionally and they lapse thirty days later with no refund, so the
 * whole value is in choosing the moment — which is exactly why nothing here is automatic.
 * There is no undo: the protocol's own outcomes include `alreadyRedeemed`, and a spent
 * grant is gone. The only caller is the owner's `useResetCredit`, behind his press.
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
  status: "used" | "none" | "failed";
  /** Said to him in his own words by the surface; never a protocol token. */
  detail: string;
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
  let id = 0;
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
  const call = (name: string, body: unknown) => new Promise<any>((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    send({ jsonrpc: "2.0", id: requestId, method: name, params: body ?? {} });
  });
  createInterface({ input: child.stdout }).on("line", line => {
    let message: any; try { message = JSON.parse(line); } catch { return; }
    const waiting = message?.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    message.error ? waiting.reject(new Error(message.error?.message ?? "rejected")) : waiting.resolve(message.result);
  });
  const timer = setTimeout(() => child.kill(), CALL_TIMEOUT_MS);
  try {
    await call("initialize", { clientInfo: { name: "concierge", title: "Concierge", version: "1.0.0" } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return await call(method, params);
  } finally { clearTimeout(timer); child.kill(); }
}

export async function useCodexResetCredit(account: string): Promise<ResetCreditOutcome> {
  const home = homesByAccount().get(account);
  if (!home) return { status: "failed", detail: `This machine is not signed in to ${account}.` };
  try {
    const limits = await callAppServer(home, "account/rateLimits/read", {});
    const credit = (limits?.rateLimitResetCredits?.credits ?? [])
      .find((entry: any) => String(entry?.status ?? "") === "available");
    if (!credit?.id) return { status: "none", detail: "There is no reset waiting on this account." };
    const result = await callAppServer(home, "account/rateLimitResetCredit/consume", { creditId: credit.id });
    const outcome = String(result?.outcome ?? "");
    // The protocol's own words for "there was nothing to spend", which is not a failure:
    // the grant is already gone, and his screen should simply stop offering it.
    if (outcome === "alreadyRedeemed" || outcome === "nothingToReset")
      return { status: "none", detail: "That reset had already been used." };
    log("warn", "codex_reset_credit_used", { account_known: true, outcome: outcome || "ok" });
    return { status: "used", detail: "This account's limits have been reset." };
  } catch (error) {
    log("error", "codex_reset_credit_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: "failed", detail: "OpenAI would not apply the reset just now. Nothing was spent." };
  }
}
