#!/usr/bin/env bun
// Codex readiness must never fail Concierge's startup (docs/incidents/2026-11-04-codex-runner-relay-startup-order.md):
// the probe keeps trying through any error, including the relay's 503 and a missing request socket,
// and settles only when the App Server answers.
import { probeCodexAppServerUntilReady } from "../src/codex-app-server-client";

const errors = [
  new Error("connect ENOENT /root/.local/state/concierge/requests.sock"),
  new Error("Unexpected server response: 503"),
  new Error("runner not connected"),
];
let calls = 0;
const sleeps: number[] = [];
await probeCodexAppServerUntilReady(async () => {
  const error = errors[calls++];
  if (error) throw error;
  return { data: [] };
}, async ms => { sleeps.push(ms); });

if (calls !== errors.length + 1) throw new Error(`expected ${errors.length + 1} probes, saw ${calls}`);
if (sleeps.join(",") !== "1000,2000,3000") throw new Error(`unexpected backoff ${sleeps.join(",")}`);
console.log("codex readiness check passed: the probe outlasted ENOENT, 503 and an unknown error, then settled");
