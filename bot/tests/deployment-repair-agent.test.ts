import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRepairAgent } from "../src/deployment-repair-agent";

const directories: string[] = [];
const previous = process.env.CONCIERGE_CODEX_BIN;
afterEach(() => {
  if (previous === undefined) delete process.env.CONCIERGE_CODEX_BIN;
  else process.env.CONCIERGE_CODEX_BIN = previous;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(body: string) {
  const cwd = mkdtempSync(join(tmpdir(), "repair-child-"));
  directories.push(cwd);
  const executable = join(cwd, "provider");
  writeFileSync(executable, `#!/usr/bin/env python3\n${body}\n`);
  chmodSync(executable, 0o700);
  process.env.CONCIERGE_CODEX_BIN = executable;
  return { kind: "repair" as const, cwd, prompt: "fixture", outputPath: join(cwd, "output.jsonl"),
    finalMessagePath: join(cwd, "final.txt"), onSpawn: (_pid: number) => {}, onSession: (_uuid: string) => {} };
}
const root = resolve(import.meta.dir, "../..");

test("spawn ENOENT is caught and rejects without hanging", async () => {
  const input = fixture("");
  process.env.CONCIERGE_CODEX_BIN = join(input.cwd, "missing");
  await expect(runRepairAgent(input, root)).rejects.toThrow("ENOENT");
});
test("immediate exit drains the final UUID event before resolving", async () => {
  const uuid = "01a039f1-9e1b-71d1-8f89-a6431c3d53b0";
  const input = fixture(`print('{"type":"thread.started","thread_id":"${uuid}"}', flush=True)`);
  const events: string[] = [];
  input.onSession = value => { events.push(value); };
  expect(await runRepairAgent(input, root)).toBe(0);
  expect(events).toEqual([uuid]);
  expect(readFileSync(input.outputPath, "utf8")).toContain(uuid);
});
test("a synchronous PID callback failure terminates and reaps its child", async () => {
  const input = fixture("import time\ntime.sleep(60)");
  let pid = 0;
  input.onSpawn = value => { pid = value; throw new Error("ledger failure"); };
  await expect(runRepairAgent(input, root)).rejects.toThrow("ledger failure");
  expect(() => process.kill(pid, 0)).toThrow();
});
test("a UUID callback failure escalates cleanup for a SIGTERM-resistant process group", async () => {
  const input = fixture('import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nprint(\'{"thread_id":"01a039f1-9e1b-71d1-8f89-a6431c3d53b0"}\', flush=True)\ntime.sleep(60)');
  let pid = 0;
  input.onSpawn = value => { pid = value; };
  input.onSession = () => { throw new Error("UUID mismatch"); };
  await expect(runRepairAgent(input, root)).rejects.toThrow("UUID mismatch");
  expect(() => process.kill(pid, 0)).toThrow();
}, 8000);
