import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

if (process.env.RUNNER_ACCOUNT_CHECK_CHILD !== "1") {
  const isolatedHome = mkdtempSync(join(tmpdir(), "runner-account-check-"));
  try {
    const child = Bun.spawnSync([process.execPath, import.meta.path], {
      env: { ...process.env, HOME: isolatedHome, CONCIERGE_RUNNER_STATE: join(isolatedHome, "runner-state"), RUNNER_ACCOUNT_CHECK_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    process.exitCode = child.exitCode ?? 1;
  } finally { rmSync(isolatedHome, { recursive: true, force: true }); }
} else {

const root = homedir();
mkdirSync(root, { recursive: true });
const writeCodex = (home: string, email: string, id: string) => {
  mkdirSync(home, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ email })).toString("base64url");
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { account_id: id, id_token: `header.${payload}.signature` } }));
};
try {
  writeCodex(join(root, ".codex"), "active@example.com", "active-id");
  writeCodex(join(root, ".codex-accounts", "saved"), "saved@example.com", "saved-id");
  const oldSession = "12345678-abcd";
  const oldTranscript = join(root, ".codex-accounts", "saved", "sessions", "2025", `${oldSession}.jsonl`);
  mkdirSync(join(oldTranscript, ".."), { recursive: true });
  writeFileSync(oldTranscript, "{}");
  const claude = join(root, ".claude-accounts", "writer");
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "opaque-refresh", subscriptionType: "max" } }));
  writeFileSync(join(claude, ".account-email"), "writer@example.com");

  const accounts = await import("../src/runner-provider-accounts");
  assert.deepEqual(accounts.runnerAccountIdentity("codex"), { id: "active-id", label: "active@example.com" });
  assert.equal(accounts.runnerAccountHome("codex", "saved@example.com"), join(root, ".codex-accounts", "saved"));
  assert.equal(accounts.runnerAccountHome("claude-code", "writer@example.com"), claude);
  assert.equal(accounts.runnerAccountHome("claude-code", "unknown@example.com"), null);
  assert.equal(accounts.findRunnerProviderSessionHome("codex", null, oldSession)?.account, "saved@example.com");
  const ambiguous = join(root, ".codex", "sessions", "2025", `${oldSession}.jsonl`);
  mkdirSync(join(ambiguous, ".."), { recursive: true });
  writeFileSync(ambiguous, "{}");
  assert.equal(accounts.findRunnerProviderSessionHome("codex", null, oldSession), null);
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.transcript", { provider: "codex", account: null, nativeId: oldSession }),
    { account: null, resolution: "ambiguous" });
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.identity", { provider: "codex" }),
    { id: "active-id", label: "active@example.com" });
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.transcript", { provider: "codex", account: null, nativeId: "00000000-missing" }),
    { account: null, resolution: "missing" });
  process.env.CONCIERGE_CODEX_EXECUTABLE = join(root, "missing-codex");
  const signIn = await accounts.serveRunnerAccountCall("accounts.signin.start", { operationId: "runner-check:signin-1", provider: "codex" }) as any;
  assert.equal(signIn.status, "failed");
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.signin.start", { operationId: "runner-check:signin-1", provider: "codex" }), signIn,
    "duplicate start must return the same operation outcome");
  const journal = readFileSync(join(root, "runner-state", "provider-signin-state.json"), "utf8");
  assert.doesNotMatch(journal, /https?:\/\/|[A-Z0-9]{3,8}-[A-Z0-9]{3,8}/, "the durable sign-in record must not hold URLs or codes");
  await assert.rejects(accounts.serveRunnerAccountCall("accounts.resolveHome", { provider: "codex", accountLabel: "saved@example.com" }), /does not answer/);
  assert.match(readFileSync(join(root, ".codex", "auth.json"), "utf8"), /active-id/);
  process.stdout.write("runner-account-check: identities and homes are runner-local; unresolved labels fail closed\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
}
