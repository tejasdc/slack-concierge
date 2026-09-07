#!/usr/bin/env bun

import { loadCaptureQueueTokenFromPath } from "../src/capture-delivery-worker";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const ingressUrl = new URL(required("CONCIERGE_CAPTURE_INGRESS_URL"));
const queueUrl = new URL(required("CONCIERGE_CAPTURE_QUEUE_URL"));
for (const url of [ingressUrl, queueUrl]) {
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/") {
    throw new Error("Sandbox capture healthcheck accepts only explicit loopback HTTP origins.");
  }
}
const token = loadCaptureQueueTokenFromPath(
  required("CONCIERGE_CAPTURE_QUEUE_TOKEN_FILE"),
  required("CONCIERGE_STATE_DIR"),
);
const [ingress, queue] = await Promise.all([
  fetch(new URL("/health", ingressUrl), { signal: AbortSignal.timeout(1_000) }),
  fetch(new URL("/health", queueUrl), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(1_000),
  }),
]);
const [ingressBody, queueBody] = await Promise.all([
  ingress.json().catch(() => null),
  queue.json().catch(() => null),
]);
if (!ingress.ok || (ingressBody as any)?.ok !== true || !queue.ok || (queueBody as any)?.ok !== true) {
  throw new Error(`Sandbox capture is not ready: ingress=${ingress.status}, queue=${queue.status}`);
}
console.log(JSON.stringify({ ok: true, ingress_status: ingress.status, queue_status: queue.status }));
