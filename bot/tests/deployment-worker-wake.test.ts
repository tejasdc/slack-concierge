import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { notifyDeploymentWorker } from "../src/deployment-worker-wake";

test("deployment state writers signal the exact live Concierge main process", () => {
  const signaled: number[] = [];
  expect(notifyDeploymentWorker({
    mainPid: () => 4242,
    signal: (pid) => { signaled.push(pid); },
  })).toBeTrue();
  expect(signaled).toEqual([4242]);
});

test("a missing bot process is a non-fatal missed wake", () => {
  expect(notifyDeploymentWorker({
    mainPid: () => 0,
    signal: () => { throw new Error("must not signal"); },
  })).toBeFalse();
});

test("interrupted candidate recovery wakes the worker after the durable repair handoff", () => {
  const source = readFileSync(resolve(import.meta.dir, "../scripts/recover-deployment.ts"), "utf8");
  const handoff = source.indexOf("const incident = beginDeploymentRepair({");
  const wake = source.indexOf("notifyDeploymentWorker();", handoff);
  expect(handoff).toBeGreaterThan(-1);
  expect(wake).toBeGreaterThan(handoff);
});
