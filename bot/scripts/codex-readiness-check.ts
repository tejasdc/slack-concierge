#!/usr/bin/env bun
// Codex readiness must never fail Concierge's startup (docs/incidents/2026-11-04-codex-runner-relay-startup-order.md):
// the probe keeps trying through any error, including the relay's 503 and a missing request socket,
// and settles only when the App Server answers.
import { probeCodexAppServerUntilReady, waitForCodexAppServerOrDrain } from "../src/codex-app-server-client";
import { OwnerDrainBeforeProviderAdmissionError } from "../src/provider-failures";
import { strict as assert } from "node:assert";

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
let beginDrain:()=>void=()=>{};
const drainStarted=new Promise<void>(resolve=>{beginDrain=resolve;});
const neverReady=new Promise<void>(()=>{});
const waiting=waitForCodexAppServerOrDrain(neverReady,drainStarted,()=>false);
beginDrain();
await assert.rejects(waiting,OwnerDrainBeforeProviderAdmissionError);
await waitForCodexAppServerOrDrain(Promise.resolve(),new Promise<void>(()=>{}),()=>false);
await assert.rejects(waitForCodexAppServerOrDrain(Promise.resolve(),drainStarted,()=>true),
  OwnerDrainBeforeProviderAdmissionError);
console.log("codex readiness check passed: the probe outlasted failures and a turn's wait ended on owner drain");
