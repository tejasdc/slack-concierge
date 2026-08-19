import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CodexAppServerClient } from "../src/codex-app-server-client";

describe("persistent Codex app-server client", () => {
  test("initializes once, multiplexes requests, and fans out notifications", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-codex-socket-"));
    const socketPath = join(root, "app-server.sock");
    const fixturePath = new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url).pathname;
    const fixture = spawn("/usr/bin/node", [fixturePath, socketPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const fixtureOutput = createInterface({ input: fixture.stdout });
    await new Promise<void>((resolve, reject) => {
      fixture.once("error", reject);
      fixture.once("exit", (code) => reject(new Error(`fixture exited before ready (${code})`)));
      fixtureOutput.once("line", (line) => line === "ready" ? resolve() : reject(new Error(line)));
    });
    const client = new CodexAppServerClient(socketPath);
    const notifications: any[] = [];
    const unsubscribe = client.onNotification((event) => notifications.push(event));

    try {
      const [first, second] = await Promise.all([
        client.request("thread/list", { limit: 1 }),
        client.request("model/list", {}),
      ]);
      expect(first).toEqual({ method: "thread/list" });
      expect(second).toEqual({ method: "model/list" });
      expect(await client.request("test/stats", {})).toEqual({
        connections: 1,
        initializations: 1,
        initialized: 1,
      });

      await client.request("test/emit", {});
      await Bun.sleep(10);
      expect(notifications).toEqual([{
        method: "turn/completed",
        params: { turn: { id: "turn-1" } },
      }]);

      const generation = await client.connect();
      await client.request("test/disconnect", {});
      await client.waitForDisconnect(generation);
      expect(await client.request("test/stats", {})).toEqual({
        connections: 2,
        initializations: 2,
        initialized: 2,
      });
    } finally {
      unsubscribe();
      await client.close();
      fixture.kill("SIGTERM");
      await new Promise<void>((resolve) => fixture.once("exit", () => resolve()));
      fixtureOutput.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("rejects a write racing bridge exit without an unhandled stdin error", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-codex-bridge-"));
    const controlPath = join(root, "control-epipe");
    const bridgePath = new URL("./fixtures/fake-codex-bridge.mjs", import.meta.url).pathname;
    const client = new CodexAppServerClient(controlPath, "/usr/bin/node", { bridgePath });
    try {
      await client.connect();
      await expect(client.request("test/large-write", {
        payload: "x".repeat(8 * 1024 * 1024),
      })).rejects.toThrow();
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("close waits for graceful bridge exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-codex-bridge-"));
    const controlPath = join(root, "control-graceful");
    const bridgePath = new URL("./fixtures/fake-codex-bridge.mjs", import.meta.url).pathname;
    const client = new CodexAppServerClient(controlPath, "/usr/bin/node", {
      bridgePath,
      shutdownGraceMs: 100,
    });
    try {
      await client.connect();
      await client.close();
      expect(existsSync(`${controlPath}.exited`)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("close escalates to SIGKILL only after the bridge ignores SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "concierge-codex-bridge-"));
    const controlPath = join(root, "control-stubborn");
    const bridgePath = new URL("./fixtures/fake-codex-bridge.mjs", import.meta.url).pathname;
    const client = new CodexAppServerClient(controlPath, "/usr/bin/node", {
      bridgePath,
      shutdownGraceMs: 20,
    });
    try {
      await client.connect();
      await client.close();
      expect(existsSync(`${controlPath}.sigterm`)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
