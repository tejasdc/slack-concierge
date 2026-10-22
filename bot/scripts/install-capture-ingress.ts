#!/root/.bun/bin/bun
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";

// The intake also accepts a device key kept as `sha256:<hex>`; this installer only creates missing
// keys and checks permissions, and never converts one.
const secretFiles = [
  "/etc/agent-inbox.token",
  "/etc/concierge/pebble-index.token",
  "/etc/concierge/thinkering.token",
  "/etc/concierge/capture-queue.token",
];
const retiredSecretFiles = ["/etc/concierge/home-assistant.token"];
for (const directory of ["/etc/concierge", "/var/agent-inbox"]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

for (const path of retiredSecretFiles) {
  if (!existsSync(path)) continue;
  unlinkSync(path);
  console.log(`removed retired ${path}`);
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
