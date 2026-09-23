#!/root/.bun/bin/bun
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";

// The intake also accepts a device key kept as `sha256:<hex>`, so no process here can read it
// back. Converting a key is a change to his devices' keys and needs his OK first; this installer
// only creates missing keys and checks permissions (2026-09-23).
const secretFiles = [
  "/etc/agent-inbox.token",
  "/etc/concierge/pebble-index.token",
  // Unused since Thinkering delivers through the owner; kept only until the route list that no
  // longer names it is installed, because the intake refuses to start without a named key.
  "/etc/concierge/thinkering.token",
  "/etc/concierge/capture-queue.token",
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
