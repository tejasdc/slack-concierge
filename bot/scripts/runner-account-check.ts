import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import {assertRunnerGoogleCreditPolicy} from '../src/runner-google-policy';

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
const googleSettings=join(root,'google-settings.json');
assertRunnerGoogleCreditPolicy(googleSettings); // No setting preserves subscription-only behavior.
writeFileSync(googleSettings,JSON.stringify({useG1Credits:true}));
assert.throws(()=>assertRunnerGoogleCreditPolicy(googleSettings),/overages are enabled/);
writeFileSync(googleSettings,'{');
assert.throws(()=>assertRunnerGoogleCreditPolicy(googleSettings),/could not be verified/);
rmSync(googleSettings);
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
  const claudeOther = join(root, ".claude-accounts", "other");
  mkdirSync(claudeOther, { recursive: true });
  writeFileSync(join(claudeOther, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "other-refresh", subscriptionType: "max" } }));
  writeFileSync(join(claudeOther, ".account-email"), "other@example.com");
  const claudeProjectRoot = join(root, ".claude", "projects");
  const claudeTranscriptId = "87654321-abcd-4321-abcd-123456789abc";
  const claudeTranscript = join(claudeProjectRoot, "-project", `${claudeTranscriptId}.jsonl`);
  mkdirSync(join(claudeTranscript, ".."), { recursive: true });
  writeFileSync(claudeTranscript, "{}");
  const { symlinkSync } = await import("node:fs");
  symlinkSync(claudeProjectRoot, join(claude, "projects"));
  symlinkSync(claudeProjectRoot, join(claudeOther, "projects"));
  writeFileSync(join(root, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshToken: "main-refresh" } }));
  writeFileSync(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "wrong-default@example.com" } }));
  const freshClaudeHome=join(root,".claude-accounts","fresh");
  mkdirSync(freshClaudeHome,{recursive:true});
  writeFileSync(join(freshClaudeHome,".credentials.json"),JSON.stringify({claudeAiOauth:{refreshToken:"fresh-refresh"}}));
  writeFileSync(join(freshClaudeHome,".account-email"),"fresh@example.com");
  writeFileSync(join(root,".claude","settings.json"),JSON.stringify({permissions:{allow:["Read"]}}));

  const accounts = await import("../src/runner-provider-accounts");
  assert.equal(accounts.runnerCodexServerNeedsRehome('{"running":true,"backend":"pid"}',false),true);
  assert.equal(accounts.runnerCodexServerNeedsRehome('{"running":true,"backend":"pid"}',null),false,
    "an unreadable listener environment must never be treated as a safe re-home target");
  assert.equal(accounts.runnerCodexRehomeIsProven("active@example.com","active@example.com",'{"running":true,"backend":"pid"}',true),true);
  assert.equal(accounts.runnerCodexRehomeIsProven("active@example.com","other@example.com",'{"running":true,"backend":"pid"}',true),false,
    "a re-home is not proven if the App Server changes accounts");
  accounts.prepareRunnerClaudeAccountHome(freshClaudeHome);
  assert.equal(readFileSync(join(freshClaudeHome,"settings.json"),"utf8"),readFileSync(join(root,".claude","settings.json"),"utf8"));
  assert.equal(await (await import("node:fs/promises")).realpath(join(freshClaudeHome,"settings.json")),await (await import("node:fs/promises")).realpath(join(root,".claude","settings.json")));
  assert.equal(readFileSync(join(freshClaudeHome,".credentials.json"),"utf8").includes("fresh-refresh"),true,
    "runner account setup must keep its own login and must not link the default login");
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.codex.repairUnmanaged", {}, { activeTurns: 1 }),
    { status: "busy", detail: "The runner still owns an active turn." },
    "unmanaged-server repair must refuse while the runner owns a turn");
  assert.equal(accounts.runnerCodexRepairActive(), false, "a refused repair must not fence runner turn claims");
  assert.deepEqual(accounts.runnerAccountIdentity("codex"), { id: "active-id", label: "active@example.com" });
  assert.equal(accounts.runnerAccountHome("codex", "saved@example.com"), join(root, ".codex-accounts", "saved"));
  assert.equal(accounts.runnerAccountHome("claude-code", "writer@example.com"), claude);
  assert.equal(accounts.runnerAccountHome("claude-code", "unknown@example.com"), null);
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.identity", { provider: "claude-code" }), null,
    "Claude identity must not read the blank/default home or invent its account label");
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.identity", { provider: "claude-code", account: "writer@example.com" }),
    { id: createHash("sha256").update("opaque-refresh").digest("hex").slice(0, 16), label: "writer@example.com" });
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.transcript", { provider: "claude-code", account: null, nativeId: claudeTranscriptId }),
    { account: null, resolution: "ambiguous" }, "shared symlinks prove one file, not which Claude account owns it");
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.transcript", { provider: "claude-code", account: "writer@example.com", nativeId: claudeTranscriptId }),
    { account: "writer@example.com", resolution: "unique" }, "saved Claude account identity resolves its shared transcript without relabeling it");
  const sharedTranscript = accounts.findRunnerProviderSessionHome("claude-code", null, claudeTranscriptId);
  assert.equal(sharedTranscript?.account, null, "content-only lookup must not choose an arbitrary linked account");
  assert.equal(sharedTranscript?.home, null);
  assert.equal(sharedTranscript?.transcript, claudeTranscript);
  assert.equal(accounts.findRunnerProviderSessionHome("claude-code", "writer@example.com", claudeTranscriptId)?.account, "writer@example.com");
  assert.equal(accounts.findRunnerProviderSessionHome("codex", null, oldSession)?.account, "saved@example.com");
  writeCodex(join(root, ".codex-accounts", "duplicate"), "saved@example.com", "duplicate-id");
  assert.deepEqual(await accounts.serveRunnerAccountCall("accounts.transcript", { provider: "codex", account: "saved@example.com", nativeId: oldSession }),
    { account: null, resolution: "ambiguous" }, "a duplicated account label cannot select a home by whichever transcript happens to exist");
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
