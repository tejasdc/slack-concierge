import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ImmutableReleaseManager,
  releaseFileSetDigest,
  type ReleaseManagerServices,
} from "../../../deployment-control/kernel/releases";

const repositoryRoot = join(import.meta.dir, "../../..");

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function git(...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", repositoryRoot, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function materializeBuilderResult(command: string[]) {
  const option = (name: string) => command[command.indexOf(name) + 1];
  const output = option("--output");
  const commit = option("--commit");
  const sourceTreeDigest = option("--source-tree-digest");
  mkdirSync(join(output, "bot/src"), { recursive: true });
  mkdirSync(join(output, "bot/scripts"), { recursive: true });
  writeFileSync(join(output, "bot/src/index.js"), "application\n");
  writeFileSync(join(output, "bot/src/codex-app-server-bridge.mjs"), "bridge\n");
  writeFileSync(join(output, "bot/scripts/rename-exchange.py"), "helper\n");
  const runtimeFiles = [
    "bot/src/index.js",
    "bot/src/codex-app-server-bridge.mjs",
    "bot/scripts/rename-exchange.py",
  ];
  const runtimeDigest = releaseFileSetDigest(output, runtimeFiles);
  const compatibilityDigest = sha256("compatibility");
  const manifest = {
    format: 1,
    git_commit: commit,
    source_tree_digest: sourceTreeDigest,
    runtime_digest: runtimeDigest,
    compatibility_digest: compatibilityDigest,
  };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  const artifactDigest = releaseFileSetDigest(output, [...runtimeFiles, "manifest.json"]);
  writeFileSync(join(output, "artifact.sha256"), `${artifactDigest}\n`);
  writeFileSync(join(output, "builder-result.json"), `${JSON.stringify({
    git_commit: commit,
    artifact_digest: artifactDigest,
    runtime_digest: runtimeDigest,
    compatibility_digest: compatibilityDigest,
  })}\n`);
}

describe("immutable deployment releases", () => {
  let root: string;
  let restartFails: boolean;
  let commands: string[][];
  let manager: ImmutableReleaseManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "concierge-releases-"));
    restartFails = false;
    commands = [];
    const services: ReleaseManagerServices = {
      spawn(command, options = {}) {
        commands.push(command);
        if (command[0] === "/usr/bin/git" || command[0] === "/usr/bin/tar") {
          return Bun.spawnSync({
            cmd: command,
            cwd: options.cwd,
            stdin: options.stdin,
            stdout: "pipe",
            stderr: "pipe",
          }) as any;
        }
        if (command[0] === "/usr/bin/systemd-run") {
          materializeBuilderResult(command);
          return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
        }
        if (command.includes("restart")) {
          return { exitCode: restartFails ? 1 : 0, stdout: new Uint8Array(), stderr: Buffer.from("restart failed") };
        }
        if (command.includes("show")) {
          return { exitCode: 0, stdout: Buffer.from("invocation-1\n"), stderr: new Uint8Array() };
        }
        throw new Error(`Unexpected command: ${command.join(" ")}`);
      },
      resolveIdentity: () => ({ uid: 0, gid: 0 }),
    };
    manager = new ImmutableReleaseManager({
      repositoryRoot,
      releaseRoot: root,
      installRoot: join(root, "installed"),
      builderUser: "concierge-builder",
      builderGroup: "concierge-builder",
      systemdRunBin: "/usr/bin/systemd-run",
      systemctlBin: "/usr/bin/systemctl",
      serviceName: "concierge-bot.service",
    }, services);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("root materializes an exact tree and invokes a credential-free contained builder", () => {
    const commit = git("rev-parse", "HEAD");
    const prepared = manager.prepare("12345678-1234-4234-8234-123456789abc", commit);
    expect(prepared.gitCommit).toBe(commit);
    expect(readFileSync(join(prepared.artifactPath, "manifest.json"), "utf8")).toContain(commit);
    const builder = commands.find((command) => command[0] === "/usr/bin/systemd-run")!;
    expect(builder).toContain("--property=PrivateNetwork=yes");
    expect(builder).toContain("--property=CapabilityBoundingSet=");
    expect(builder.some((argument) => argument.startsWith("--setenv=NODE_PATH="))).toBeTrue();
    expect(builder.some((argument) => /token|secret|github/i.test(argument))).toBeFalse();
  });

  test("tampering is rejected before the stable pointer moves", () => {
    const commit = git("rev-parse", "HEAD");
    const prepared = manager.prepare("22345678-1234-4234-8234-123456789abc", commit);
    writeFileSync(join(prepared.artifactPath, "bot/src/index.js"), "tampered\n");
    expect(() => manager.activate(prepared.artifactPath)).toThrow("runtime or compatibility digest is invalid");
  });

  test("failed candidate activation restores the prior immutable pointer", () => {
    const commit = git("rev-parse", "HEAD");
    const prior = manager.prepare("32345678-1234-4234-8234-123456789abc", commit);
    manager.activate(prior.artifactPath);
    const candidate = manager.prepare("42345678-1234-4234-8234-123456789abc", git("rev-parse", "HEAD^"));
    restartFails = true;
    expect(() => manager.activate(candidate.artifactPath)).toThrow("prior runtime restoration was not proven");
    expect(readFileSync(join(root, "current", "manifest.json"), "utf8"))
      .toBe(readFileSync(join(prior.artifactPath, "manifest.json"), "utf8"));
  });
});
