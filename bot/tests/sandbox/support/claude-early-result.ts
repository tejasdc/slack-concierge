#!/usr/bin/env bun
// Inject the reproduced restart ordering; all subsequent traffic uses the real CLI.
import { spawn } from "node:child_process";

if (!process.env.CONCIERGE_SANDBOX_RUN_ID) throw new Error("A claimed Slack sandbox run is required");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false,
  result: "SANDBOX_EARLY_RESULT_MUST_NOT_DELIVER", duration_ms: 17 }) + "\n");
const child = spawn("claude", process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"] });
process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("close", (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
