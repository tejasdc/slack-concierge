/**
 * Builds this checkout's agent helpers (router commands, hooks, the execution host) into a folder
 * that is never changed afterwards, `<root>/<commit>/bot/scripts/*.js`, and prints its `bot` path.
 * The Mac runs Concierge from a checkout that every update rewrites; an agent still running from an
 * earlier version keeps calling the helpers of the version it started with (EXECUTION-HOST.md,
 * "The Mac"). The bundles are the same ones a server release carries (deployment-artifact-files.json).
 * Usage: bun scripts/build-pinned-helpers.ts <root>
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import declaration from "../src/deployment-artifact-files.json";

const root = process.argv[2];
if (!root) { console.error("usage: build-pinned-helpers.ts <root>"); process.exit(2); }
const repository = resolve(import.meta.dir, "../..");
const commit = spawnSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["-C", repository, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(commit) || dirty) { console.error("refusing: helpers are pinned only from a clean checkout at a commit"); process.exit(2); }

const final = join(root, commit);
if (!existsSync(join(final, "bot/scripts/router-sessions.js"))) {
  const building = `${final}.building-${process.pid}`;
  rmSync(building, { recursive: true, force: true });
  for (const [destination, source] of Object.entries(declaration.controlBundles as Record<string, string>)) {
    if (!destination.startsWith("control/bot/scripts/")) continue;
    const output = join(building, destination.slice("control/".length));
    mkdirSync(dirname(output), { recursive: true });
    const result = await Bun.build({ entrypoints: [join(repository, source)], target: "bun", outdir: dirname(output), naming: basename(output) });
    if (!result.success) { console.error(`bundle failed for ${source}: ${result.logs.map(entry => entry.message).join("\n").slice(0, 2000)}`); process.exit(1); }
  }
  // Appears whole or not at all; an existing folder for this commit is never replaced.
  if (existsSync(final)) rmSync(building, { recursive: true, force: true });
  else renameSync(building, final);
}
console.log(join(final, "bot"));
