import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  artifactDirectoryForTurn,
  buildArtifactPromptContext,
  cleanupArtifactDirectoryIfEmpty,
  findTurnArtifacts,
  openVerifiedArtifactStream,
  prepareArtifactDirectory,
  removeArtifactStagingTree,
} from "../src/artifacts";

const dir = "/tmp/concierge-artifacts-test";
const TOKEN_41 = "11111111-1111-4111-8111-111111111111";
const TOKEN_42 = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("turn-owned artifacts", () => {
  test("returns regular files from only the owning random-token directory", () => {
    const owningDirectory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const otherDirectory = prepareArtifactDirectory(dir, 42, TOKEN_42);
    writeFileSync(join(owningDirectory, "chart.png"), "png");
    writeFileSync(join(otherDirectory, "private.txt"), "other turn");
    writeFileSync(join(dir, ".artifacts", "legacy.txt"), "legacy shared root");
    mkdirSync(join(owningDirectory, "nested"));

    const found = findTurnArtifacts(owningDirectory);

    expect(found.map((file) => file.filename)).toEqual(["chart.png"]);
  });

  test("keeps files whose mtime predates the turn", () => {
    const artifactDirectory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const file = join(artifactDirectory, "preserved.txt");
    writeFileSync(file, "updated with old mtime");
    utimesSync(file, new Date(0), new Date(0));

    expect(findTurnArtifacts(artifactDirectory).map((item) => item.filename)).toEqual(["preserved.txt"]);
  });

  test("uses a non-reusable token path and tells the provider it is staging", () => {
    const artifactDirectory = artifactDirectoryForTurn(dir, 41, TOKEN_41);

    expect(artifactDirectory).toBe(join(dir, ".artifacts", `turn-41-${TOKEN_41}`));
    expect(buildArtifactPromptContext(artifactDirectory)).toContain(JSON.stringify(artifactDirectory));
    expect(buildArtifactPromptContext(artifactDirectory)).toContain("staging copy");
    expect(() => artifactDirectoryForTurn(dir, 0, TOKEN_41)).toThrow("positive integer turn ID");
    expect(() => artifactDirectoryForTurn(dir, 41, "predictable")).toThrow("persisted UUID");
  });

  test("creates a turn directory exclusively and rejects a pre-existing directory symlink", () => {
    const artifactRoot = join(dir, ".artifacts");
    const target = join(dir, "external");
    mkdirSync(artifactRoot, { recursive: true });
    mkdirSync(target);
    symlinkSync(target, artifactDirectoryForTurn(dir, 41, TOKEN_41));

    expect(() => prepareArtifactDirectory(dir, 41, TOKEN_41)).toThrow();
  });

  test("fails closed instead of adopting an unexpected pre-existing nonempty directory", () => {
    const directory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    writeFileSync(join(directory, "stale.txt"), "stale");

    expect(() => prepareArtifactDirectory(dir, 41, TOKEN_41)).toThrow();
    expect(existsSync(join(directory, "stale.txt"))).toBeTrue();
  });

  test("rejects direct symbolic links to sibling and external files", () => {
    const owningDirectory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const siblingDirectory = prepareArtifactDirectory(dir, 42, TOKEN_42);
    const siblingFile = join(siblingDirectory, "private.txt");
    const externalFile = join(dir, "external.txt");
    writeFileSync(siblingFile, "sibling");
    writeFileSync(externalFile, "external");
    symlinkSync(siblingFile, join(owningDirectory, "borrowed.txt"));

    expect(() => findTurnArtifacts(owningDirectory)).toThrow("symbolic-link artifact");
    unlinkSync(join(owningDirectory, "borrowed.txt"));
    symlinkSync(externalFile, join(owningDirectory, "external.txt"));
    expect(() => findTurnArtifacts(owningDirectory)).toThrow("symbolic-link artifact");
  });

  test("revalidates the opened descriptor before Slack can read a replaced path", () => {
    const owningDirectory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const path = join(owningDirectory, "safe.txt");
    const external = join(dir, "external.txt");
    writeFileSync(path, "safe");
    writeFileSync(external, "private");
    const artifact = findTurnArtifacts(owningDirectory)[0];
    unlinkSync(path);
    symlinkSync(external, path);

    expect(() => openVerifiedArtifactStream(artifact)).toThrow();
  });

  test("cleans only an empty exact owning directory", () => {
    const emptyDirectory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const nonemptyDirectory = prepareArtifactDirectory(dir, 42, TOKEN_42);
    writeFileSync(join(nonemptyDirectory, "keep.txt"), "keep");

    expect(cleanupArtifactDirectoryIfEmpty(emptyDirectory)).toBeTrue();
    expect(cleanupArtifactDirectoryIfEmpty(nonemptyDirectory)).toBeFalse();
    expect(cleanupArtifactDirectoryIfEmpty(join(dir, "missing"))).toBeFalse();
    expect(existsSync(emptyDirectory)).toBeFalse();
    expect(existsSync(nonemptyDirectory)).toBeTrue();
  });

  test("staging-tree cleanup removes ignored nested entries and symlinks without following them", () => {
    const directory = prepareArtifactDirectory(dir, 41, TOKEN_41);
    const nested = join(directory, "nested");
    const external = join(dir, "external.txt");
    mkdirSync(nested);
    writeFileSync(join(nested, "ignored.txt"), "ignored");
    writeFileSync(external, "preserve me");
    symlinkSync(external, join(directory, "external-link.txt"));

    expect(removeArtifactStagingTree(directory)).toBeTrue();
    expect(existsSync(directory)).toBeFalse();
    expect(existsSync(external)).toBeTrue();
  });
});
