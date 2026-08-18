#!/root/.bun/bin/bun
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const secretFiles = [
  "/etc/agent-inbox.token",
  "/etc/concierge/pebble-index.token",
];

for (const directory of ["/etc/concierge", "/var/agent-inbox"]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

for (const path of secretFiles) {
  if (!existsSync(path)) {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    console.log(`created ${path}`);
  }
  chmodSync(path, 0o600);
  const file = statSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0) throw new Error(`Capture secret permissions are unsafe: ${path}`);
  console.log(`verified ${path}`);
}

const captureSlackToken = process.env.CONCIERGE_CAPTURE_SLACK_TOKEN_FILE || "/etc/concierge/capture-slack.token";
if (!existsSync(captureSlackToken)) {
  throw new Error(
    `${captureSlackToken} is required. Install the separate Concierge Capture app from capture-slack-app-manifest.json; never copy Concierge's general token.`,
  );
}
chmodSync(captureSlackToken, 0o600);
const captureSlackTokenFile = statSync(captureSlackToken);
if (!captureSlackTokenFile.isFile() || (captureSlackTokenFile.mode & 0o077) !== 0) {
  throw new Error(`Capture Slack credential permissions are unsafe: ${captureSlackToken}`);
}
const token = readFileSync(captureSlackToken, "utf8").trim();
if (!token.startsWith("xoxp-") || token.length < 24) {
  throw new Error(`${captureSlackToken} must contain the dedicated capture app's user OAuth token.`);
}
const authResponse = await fetch("https://slack.com/api/auth.test", {
  headers: { authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const authResult: any = await authResponse.json().catch(() => null);
if (!authResponse.ok || !authResult?.ok) {
  throw new Error(`Capture Slack credential failed auth.test: ${String(authResult?.error || authResponse.status)}`);
}
const scopes = (authResponse.headers.get("x-oauth-scopes") || "")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean)
  .sort();
if (scopes.length !== 1 || scopes[0] !== "chat:write") {
  throw new Error(`Capture Slack credential must have exactly the chat:write scope; received: ${scopes.join(", ") || "none"}`);
}
console.log(`verified dedicated capture Slack credential for ${String(authResult.user || authResult.user_id || "user")}`);
