import { describe, expect, test } from "bun:test";
import { withPausedObsidianSync } from "../src/sync-service";

describe("withPausedObsidianSync", () => {
  test("pauses and restores an active service around successful work", () => {
    const calls: string[] = [];
    const statuses = [0, 0, 0];
    const result = withPausedObsidianSync({
      enabled: true,
      apply: true,
      runCommand: (_command, args) => {
        calls.push(args.join(" "));
        return commandResult(statuses.shift()!);
      },
      operation: () => "done",
    });
    expect(result).toBe("done");
    expect(calls).toEqual([
      "is-active --quiet obsidian-sync",
      "stop obsidian-sync",
      "start obsidian-sync",
    ]);
  });

  test("does not stop an inactive service", () => {
    const calls: string[] = [];
    const result = withPausedObsidianSync({
      enabled: true,
      apply: true,
      runCommand: (_command, args) => {
        calls.push(args.join(" "));
        return commandResult(3);
      },
      operation: () => 42,
    });
    expect(result).toBe(42);
    expect(calls).toEqual(["is-active --quiet obsidian-sync"]);
  });

  test("surfaces stop failure before the operation", () => {
    let operated = false;
    const statuses = [0, 1];
    expect(() => withPausedObsidianSync({
      enabled: true,
      apply: true,
      runCommand: () => commandResult(statuses.shift()!),
      operation: () => { operated = true; },
    })).toThrow("Could not pause obsidian-sync");
    expect(operated).toBe(false);
  });

  test("restores after operation failure and preserves that failure", () => {
    const calls: string[] = [];
    const statuses = [0, 0, 0];
    expect(() => withPausedObsidianSync({
      enabled: true,
      apply: true,
      runCommand: (_command, args) => {
        calls.push(args[0]);
        return commandResult(statuses.shift()!);
      },
      operation: () => { throw new Error("migration failed"); },
    })).toThrow("migration failed");
    expect(calls).toEqual(["is-active", "stop", "start"]);
  });

  test("surfaces restart failure with an explicit recovery command", () => {
    const statuses = [0, 0, 1];
    expect(() => withPausedObsidianSync({
      enabled: true,
      apply: true,
      runCommand: () => commandResult(statuses.shift()!),
      operation: () => "done",
    })).toThrow("systemctl start obsidian-sync");
  });
});

function commandResult(status: number) {
  return { error: undefined, signal: null, status };
}
