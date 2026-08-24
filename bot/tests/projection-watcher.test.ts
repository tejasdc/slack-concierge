import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectionWatcher } from "../src/projection-watcher";
import type { ChannelRow } from "../src/state";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `concierge-${name}-`));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "source"), "initial\n");
  return directory;
}

function channel(): ChannelRow {
  return { slack_channel_id: "C_WATCH" } as ChannelRow;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for watcher condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ProjectionWatcher", () => {
  test("coalesces events and rebinds when the resolved source target changes", async () => {
    const firstDirectory = temporaryDirectory("watch-first");
    const secondDirectory = temporaryDirectory("watch-second");
    let watchedDirectory = firstDirectory;
    const reasons: string[] = [];
    const watcher = new ProjectionWatcher({
      name: "test",
      startupReason: "startup",
      changedReason: "changed",
      resolveTarget: () => ({ directory: watchedDirectory, filename: "source" }),
      project: async (_channel, reason) => { reasons.push(reason); },
      debounceMs: 15,
      retryMs: null,
    });

    watcher.watchChannel(channel());
    appendFileSync(join(firstDirectory, "source"), "one\n");
    appendFileSync(join(firstDirectory, "source"), "two\n");
    await waitFor(() => reasons.length === 1);

    watchedDirectory = secondDirectory;
    watcher.watchChannel(channel());
    appendFileSync(join(firstDirectory, "source"), "ignored\n");
    appendFileSync(join(secondDirectory, "source"), "observed\n");
    await waitFor(() => reasons.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    watcher.close();

    expect(reasons).toEqual(["changed", "changed"]);
  });

  test("retries only when the projection config opts in", async () => {
    const retryDirectory = temporaryDirectory("watch-retry");
    let retryAttempts = 0;
    const retrying = new ProjectionWatcher({
      name: "retrying",
      startupReason: "startup",
      changedReason: "changed",
      resolveTarget: () => ({ directory: retryDirectory, filename: "source" }),
      project: async () => {
        retryAttempts += 1;
        if (retryAttempts === 1) throw new Error("temporary failure");
      },
      debounceMs: 5,
      retryMs: 10,
    });
    retrying.schedule(channel(), "changed");
    await waitFor(() => retryAttempts === 2);
    retrying.close();

    const noRetryDirectory = temporaryDirectory("watch-no-retry");
    let noRetryAttempts = 0;
    const noRetry = new ProjectionWatcher({
      name: "no-retry",
      startupReason: "startup",
      changedReason: "changed",
      resolveTarget: () => ({ directory: noRetryDirectory, filename: "source" }),
      project: async () => {
        noRetryAttempts += 1;
        throw new Error("do not retry");
      },
      debounceMs: 5,
      retryMs: null,
    });
    noRetry.schedule(channel(), "changed");
    await waitFor(() => noRetryAttempts === 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    noRetry.close();

    expect(retryAttempts).toBe(2);
    expect(noRetryAttempts).toBe(1);
  });

  test("cancels pending work and source events when closed", async () => {
    const directory = temporaryDirectory("watch-close");
    let projections = 0;
    const watcher = new ProjectionWatcher({
      name: "close",
      startupReason: "startup",
      changedReason: "changed",
      resolveTarget: () => ({ directory, filename: "source" }),
      project: async () => { projections += 1; },
      debounceMs: 25,
      retryMs: null,
    });
    watcher.schedule(channel(), "changed");
    watcher.close();
    appendFileSync(join(directory, "source"), "after close\n");
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(projections).toBe(0);
  });
});
