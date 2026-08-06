import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findNewArtifacts } from "../src/artifacts";

const dir = "/tmp/concierge-artifacts-test";

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findNewArtifacts", () => {
  test("returns only files newer than the turn start", async () => {
    const artifacts = join(dir, ".artifacts");
    mkdirSync(artifacts, { recursive: true });
    const before = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    writeFileSync(join(artifacts, "chart.png"), "png");
    const found = findNewArtifacts(dir, before);
    expect(found.map((file) => file.filename)).toEqual(["chart.png"]);
  });

  test("missing directory is empty", () => {
    expect(findNewArtifacts(dir, Date.now())).toEqual([]);
  });

  test("keeps files whose mtime was preserved during the turn", () => {
    const artifacts = join(dir, ".artifacts");
    mkdirSync(artifacts, { recursive: true });
    const before = Date.now();
    const file = join(artifacts, "preserved.txt");
    writeFileSync(file, "updated with old mtime");
    utimesSync(file, new Date(before - 60_000), new Date(before - 60_000));

    const found = findNewArtifacts(dir, before);

    expect(found.map((item) => item.filename)).toEqual(["preserved.txt"]);
  });
});
