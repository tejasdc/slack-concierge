import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { processIdentity } from "../src/runtime-identity";

test("an unprivileged service recognizes a live root-owned process by proc identity", async () => {
  if (process.getuid?.() !== 0) return;
  const directory = mkdtempSync(join("/var/tmp", "capture-cross-uid-"));
  chmodSync(directory, 0o755);
  try {
    const bun = join(directory, "bun");
    const entrypoint = join(directory, "probe.ts");
    const outputDirectory = join(directory, "bundle");
    copyFileSync("/root/.bun/bin/bun", bun);
    chmodSync(bun, 0o755);
    writeFileSync(entrypoint, [
      `import { isProcessIdentityAlive } from ${JSON.stringify(resolve(import.meta.dir, "../src/runtime-identity.ts"))};`,
      "const identity = JSON.parse(process.argv[2]);",
      "console.log(JSON.stringify({ alive: isProcessIdentityAlive(identity) }));",
    ].join("\n"));
    const built = await Bun.build({ entrypoints: [entrypoint], outdir: outputDirectory, target: "bun" });
    expect(built.success).toBe(true);
    const probe = join(outputDirectory, "probe.js");
    chmodSync(outputDirectory, 0o755);
    chmodSync(probe, 0o755);
    const result = Bun.spawnSync({
      cmd: ["runuser", "-u", "nobody", "--", bun, probe, JSON.stringify(processIdentity(process.pid))],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ alive: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
