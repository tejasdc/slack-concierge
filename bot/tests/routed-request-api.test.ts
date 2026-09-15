import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRoutedRequestApi } from "../src/routed-request-api";

test("request API refuses a live listener without replacing its socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request api live "));
  const path = join(directory, "requests.sock");
  const server = Bun.serve({ unix: path, fetch: () => new Response("original owner") });
  let unexpected: ReturnType<typeof startRoutedRequestApi> | null = null;
  const inode = lstatSync(path).ino;
  try {
    expect(() => { unexpected = startRoutedRequestApi(directory, null); }).toThrow("live listener");
    expect(lstatSync(path).ino).toBe(inode);
    expect(await (await fetch("http://owner/", { unix: path })).text()).toBe("original owner");
  } finally {
    await unexpected?.stop(true);
    await server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("request API preserves an endpoint bound before its owner begins listening", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request-api-bound-"));
  const path = join(directory, "requests.sock");
  const child = Bun.spawn(["python3", "-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); print('bound',flush=True); sys.stdin.read()", path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let unexpected: ReturnType<typeof startRoutedRequestApi> | null = null;
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("bound");
    reader.releaseLock();
    const inode = lstatSync(path).ino;
    expect(() => { unexpected = startRoutedRequestApi(directory, null); }).toThrow("live listener");
    expect(lstatSync(path).ino).toBe(inode);
  } finally {
    await unexpected?.stop(true);
    child.stdin.end();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("request API preserves regular files and symbolic links at its socket path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "request-api-path-"));
  const path = join(directory, "requests.sock");
  const target = join(directory, "retained.txt");
  let unexpected: ReturnType<typeof startRoutedRequestApi> | null = null;
  try {
    writeFileSync(path, "retained file");
    expect(() => { unexpected = startRoutedRequestApi(directory, null); }).toThrow("not a socket");
    expect(readFileSync(path, "utf8")).toBe("retained file");
    rmSync(path);
    writeFileSync(target, "retained target");
    symlinkSync(target, path);
    expect(() => { unexpected = startRoutedRequestApi(directory, null); }).toThrow("not a socket");
    expect(lstatSync(path).isSymbolicLink()).toBeTrue();
    expect(readFileSync(target, "utf8")).toBe("retained target");
  } finally { await unexpected?.stop(true); rmSync(directory, { recursive: true, force: true }); }
});
