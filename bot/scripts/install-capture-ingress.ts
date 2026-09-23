#!/root/.bun/bin/bun
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

// Keys only a device outside this machine presents. They are kept here as `sha256:<hex>`, so no
// process on this machine can read one back and post as Tejas (September 23, 2026).
const deviceKeyFiles = [
  "/etc/agent-inbox.token",
  "/etc/concierge/pebble-index.token",
];
const secretFiles = [
  ...deviceKeyFiles,
  "/etc/concierge/capture-queue.token",
];
// Thinkering's public capture key: Thinkering now delivers through the local session owner, and
// anything that could read this key could post into his Inbox as him.
const retiredFiles = ["/etc/concierge/thinkering.token"];

for (const directory of ["/etc/concierge", "/var/agent-inbox"]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

for (const path of retiredFiles) {
  if (existsSync(path)) {
    rmSync(path);
    console.log(`removed ${path}`);
  }
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

for (const path of deviceKeyFiles) {
  const stored = readFileSync(path, "utf8").trim();
  if (/^sha256:[0-9a-f]{64}$/.test(stored)) continue;
  writeFileSync(path, `sha256:${createHash("sha256").update(stored).digest("hex")}\n`, { mode: 0o600 });
  console.log(`kept only the fingerprint of ${path}`);
}
