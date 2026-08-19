#!/root/.bun/bin/bun
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";

const secretFiles = [
  "/etc/agent-inbox.token",
  "/etc/concierge/pebble-index.token",
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
