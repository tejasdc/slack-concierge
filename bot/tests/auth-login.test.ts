import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderLoginManager, extractLoginUrl } from "../src/auth-login";

let scratchDir = "";
let manager: ProviderLoginManager | null = null;

afterEach(async () => {
  await manager?.stop();
  manager = null;
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  scratchDir = "";
});

function newScratchDir() {
  scratchDir = mkdtempSync(join(tmpdir(), "concierge-auth-login-"));
  return scratchDir;
}

// Mirrors a real interactive provider login: print the authorization URL, wait
// for the pasted code on stdin, succeed only on the expected code.
const FAKE_LOGIN = `echo "Visit: https://example.com/oauth/authorize?state=abc"; read code; [ "$code" = "good-code" ] && { echo ok; exit 0; } || { echo bad; exit 1; }`;

describe("extractLoginUrl", () => {
  test("unwraps OSC-8 hyperlink escapes and stops at the duplicated visible URL", () => {
    const raw = "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?state=aWTO\x1b\\https://claude.com/cai/oauth/authorize?state=aWTO\x1b]8;;\x1b\\\nPaste code here if prompted > ";
    expect(extractLoginUrl(raw)).toBe("https://claude.com/cai/oauth/authorize?state=aWTO");
  });

  test("cuts a URL concatenated with its escaped copy on the final (terminatorless) parse", () => {
    expect(extractLoginUrl("visit https://a.example/x?state=1https://a.example/x?state=1", { requireTerminator: false }))
      .toBe("https://a.example/x?state=1");
  });

  test("does not accept a terminatorless URL mid-stream", () => {
    // A URL at the very end of the buffer may still be mid-write; require a
    // trailing delimiter so a split URL is never returned truncated.
    expect(extractLoginUrl("visit https://example.com/oauth/auth")).toBeNull();
    expect(extractLoginUrl("visit https://example.com/oauth/auth\n")).toBe("https://example.com/oauth/auth");
  });

  test("returns null without a URL", () => {
    expect(extractLoginUrl("no link yet")).toBeNull();
  });
});

describe("ProviderLoginManager", () => {
  test("captures the login URL, then completes with the pasted code", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000, completionWaitMs: 5_000 });
    const started = await manager.start("claude-code", FAKE_LOGIN, newScratchDir());
    expect(started).toEqual({
      status: "awaiting_code",
      url: "https://example.com/oauth/authorize?state=abc",
    });
    expect(manager.hasPendingLogin("claude-code")).toBeTrue();

    const completed = await manager.complete("claude-code", "good-code");
    expect(completed.status).toBe("completed");
    expect(manager.hasPendingLogin("claude-code")).toBeFalse();
  });

  test("returns the full URL even when it arrives split across output chunks", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000, completionWaitMs: 5_000 });
    const splitLogin = `printf 'Visit: https://example.com/oauth/auth'; sleep 0.3; printf 'orize?state=split\n'; read code; exit 0`;
    const started = await manager.start("claude-code", splitLogin, newScratchDir());
    expect(started).toEqual({
      status: "awaiting_code",
      url: "https://example.com/oauth/authorize?state=split",
    });
    expect((await manager.complete("claude-code", "anything")).status).toBe("completed");
  });

  test("reports failure when the provider rejects the code", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000, completionWaitMs: 5_000 });
    await manager.start("claude-code", FAKE_LOGIN, newScratchDir());
    const completed = await manager.complete("claude-code", "wrong-code");
    expect(completed.status).toBe("failed");
  });

  test("rejects a code with no pending login", async () => {
    manager = new ProviderLoginManager();
    expect(await manager.complete("claude-code", "anything"))
      .toEqual({ status: "no_pending_login" });
  });

  test("reports immediate command failure without leaving a pending login", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000 });
    const started = await manager.start("claude-code", "echo 'no url'; exit 1", newScratchDir());
    expect(started.status).toBe("failed");
    expect(manager.hasPendingLogin("claude-code")).toBeFalse();
  });

  test("treats a login that exits successfully before asking for a code as completed", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000 });
    const started = await manager.start("claude-code", "echo 'already logged in'; exit 0", newScratchDir());
    expect(started.status).toBe("completed");
    expect(manager.hasPendingLogin("claude-code")).toBeFalse();
  });

  test("a new start abandons the previous pending login", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000, completionWaitMs: 5_000 });
    await manager.start("claude-code", FAKE_LOGIN, newScratchDir());
    const restarted = await manager.start("claude-code", FAKE_LOGIN, scratchDir);
    expect(restarted.status).toBe("awaiting_code");
    const completed = await manager.complete("claude-code", "good-code");
    expect(completed.status).toBe("completed");
  });

  test("overlapping starts leave exactly one owned login, not an orphan", async () => {
    manager = new ProviderLoginManager({ urlWaitMs: 5_000, completionWaitMs: 5_000 });
    const dir = newScratchDir();
    const [first, second] = await Promise.all([
      manager.start("claude-code", FAKE_LOGIN, dir),
      manager.start("claude-code", FAKE_LOGIN, dir),
    ]);
    // Exactly one start ends up owning the pending login.
    const awaiting = [first, second].filter((result) => result.status === "awaiting_code");
    expect(awaiting.length).toBe(1);
    expect(manager.hasPendingLogin("claude-code")).toBeTrue();
    // Single ownership: one completion settles it, a second finds nothing.
    expect((await manager.complete("claude-code", "good-code")).status).toBe("completed");
    expect((await manager.complete("claude-code", "good-code")).status).toBe("no_pending_login");
  });

  test("signals unattended completion when a login finishes without a code", async () => {
    let unattended: string | null = null;
    manager = new ProviderLoginManager({
      urlWaitMs: 5_000,
      onUnattendedCompletion: (provider) => {
        unattended = provider;
      },
    });
    const started = await manager.start(
      "codex",
      `echo "Visit: https://example.com/device"; sleep 0.3; exit 0`,
      newScratchDir(),
    );
    expect(started.status).toBe("awaiting_code");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(unattended).toBe("codex");
    expect(manager.hasPendingLogin("codex")).toBeFalse();
  });
});
