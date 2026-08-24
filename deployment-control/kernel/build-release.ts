#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function requiredOption(name: string) {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function digest(...values: Array<string | Uint8Array>) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value);
  return hash.digest("hex");
}

function assertContained(root: string, path: string) {
  const canonicalRoot = realpathSync(root);
  const canonicalPath = realpathSync(path);
  if (canonicalPath !== canonicalRoot && !canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${path} escapes ${root}.`);
  }
}

function listRegularFiles(root: string, directory = root): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      assertContained(root, path);
      continue;
    }
    if (stat.isDirectory()) {
      result.push(...listRegularFiles(root, path));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Release source contains special file ${path}.`);
    result.push(relative(root, path).split(sep).join("/"));
  }
  return result.sort();
}

function fileSetDigest(root: string, paths: string[]) {
  const hash = createHash("sha256");
  for (const path of paths.sort()) {
    const contents = readFileSync(join(root, path));
    hash.update(`${path}\0${contents.byteLength}\0`);
    hash.update(contents);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function main() {
  if (process.geteuid?.() === 0) throw new Error("The release builder refuses to run as root.");
  const source = realpathSync(requiredOption("--source"));
  const output = resolve(requiredOption("--output"));
  const commit = requiredOption("--commit").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("--commit must be a full Git SHA.");
  const sourceTreeDigest = requiredOption("--source-tree-digest").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sourceTreeDigest)) {
    throw new Error("--source-tree-digest must be a SHA-256 digest.");
  }
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.uid !== 0 || (sourceStat.mode & 0o022) !== 0) {
    throw new Error("Release source must be a root-owned, non-writable materialization.");
  }
  if (existsSync(output)) throw new Error("Release output must not already exist.");
  listRegularFiles(source);
  mkdirSync(join(output, "bot/src"), { recursive: true, mode: 0o700 });
  mkdirSync(join(output, "bot/scripts"), { recursive: true, mode: 0o700 });

  const application = join(output, "bot/src/index.js");
  const built = await Bun.build({
    entrypoints: [join(source, "bot/src/index.ts")],
    target: "bun",
    outdir: join(output, "bot/src"),
    naming: "index.js",
  });
  if (!built.success) {
    throw new Error(`Application bundle failed: ${built.logs.map((log) => log.message).join("\n").slice(0, 4000)}`);
  }
  if (!existsSync(application)) throw new Error("Application bundle did not produce the expected runtime path.");

  copyFileSync(
    join(source, "bot/src/codex-app-server-bridge.mjs"),
    join(output, "bot/src/codex-app-server-bridge.mjs"),
  );
  copyFileSync(
    join(source, "bot/scripts/rename-exchange.py"),
    join(output, "bot/scripts/rename-exchange.py"),
  );

  const compatibilityPaths = [
    "bot/src/state.ts",
    "bot/src/capture-state.ts",
    "bot/src/deployment-state.ts",
  ];
  const compatibilityDigest = fileSetDigest(source, compatibilityPaths);
  const runtimeFiles = [
    "bot/src/index.js",
    "bot/src/codex-app-server-bridge.mjs",
    "bot/scripts/rename-exchange.py",
  ];
  const runtimeDigest = fileSetDigest(output, runtimeFiles);
  const manifest = {
    format: 1,
    git_commit: commit,
    source_tree_digest: sourceTreeDigest,
    runtime_digest: runtimeDigest,
    compatibility_digest: compatibilityDigest,
    files: Object.fromEntries(runtimeFiles.map((path) => [path, digest(readFileSync(join(output, path)))])),
  };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const artifactFiles = [...runtimeFiles, "manifest.json"];
  const artifactDigest = fileSetDigest(output, artifactFiles);
  writeFileSync(join(output, "artifact.sha256"), `${artifactDigest}\n`, { mode: 0o600 });
  writeFileSync(join(output, "builder-result.json"), `${JSON.stringify({
    git_commit: commit,
    artifact_digest: artifactDigest,
    runtime_digest: runtimeDigest,
    compatibility_digest: compatibilityDigest,
  })}\n`, { mode: 0o600 });
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
