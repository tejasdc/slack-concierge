#!/usr/bin/env bun
import {strict as assert} from "node:assert";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {CacheBackupAdmission, CacheBackupTrace, CACHE_BACKUP_POLICY} from "../src/provider-history-cache-admission";
import {HistoryCacheMaintenance, HostCacheRestic} from "../src/provider-history-cache-maintenance";
import {check, fixture} from "./history-cache-maintenance-fixture";
import {parseForegroundJournalRow} from "./cache-admission-observation";

const load = (at: number, busyMs: number, device = "fixture") => ({at, pressure: 0,
  available: CACHE_BACKUP_POLICY.minAvailableBytes + 1,
  devices: {[device]: {readBytes: at * 10, writeBytes: at * 10, busyMs}},
  process: {readBytes: 0, writeBytes: 0, rssBytes: 0, cpuTicks: 0, processes: 1}});

// Child mode is intentionally the same blocked disposable transport used by
// the established fixture; it never runs host sampling or Restic.
if (process.argv[2] === "--native-blocked") {
  const child = Bun.spawn(["sleep", "120"], {stdout: "ignore", stderr: "ignore"});
  writeFileSync(process.argv[3]!, String(child.pid));
  process.on("SIGTERM", () => {});
  await Bun.sleep(120_000);
  process.exit(1);
}

await check("diagnostic trace preserves raw device intervals and records the unchanged busy refusal", async f => {
  const trace = new CacheBackupTrace();
  const firstLoad = load(1000, 0);
  let next = firstLoad;
  const folder = join(f.state, "diagnostics"); mkdirSync(folder);
  const admission = new CacheBackupAdmission(folder, () => {}, () => next, trace);
  admission.sample();
  next = load(2000, 510);
  assert.throws(() => admission.sample(), /HISTORY_BACKUP_LOAD_BUSY/);
  const report = admission.finish(new Error("HISTORY_BACKUP_LOAD_BUSY"));
  const summary = report.trace;
  assert.ok(summary && Array.isArray(summary.events));
  const samples = summary.events.filter((event: any) => event.kind === "load_sample");
  assert.equal(samples.length, 2);
  assert.deepEqual(samples[0].load.devices.fixture, {readBytes: 10000, writeBytes: 10000, busyMs: 0});
  assert.deepEqual(samples[0].intervals, {}, "the first sample has no preceding interval");
  assert.deepEqual(samples[1].intervals.fixture, {
    elapsedMs: 1000, busyDeltaMs: 510, busyPercent: 51,
  });
  assert.equal(report.peakDiskBusyPercent, 51);
  assert.ok(summary.events.some((event: any) => event.kind === "load_refusal"));
  firstLoad.devices.fixture!.busyMs = 999;
  assert.equal(samples[0].load.devices.fixture.busyMs, 0, "trace retains the sample as captured");
  const originalAnchor = summary.anchor.atMs;
  summary.anchor.atMs = -1;
  (summary.events as any).push({kind: "forged"});
  const reread = trace.summary();
  assert.equal(reread.anchor.atMs, originalAnchor, "a returned summary cannot mutate the trace");
  assert.equal(reread.events.some(event => event.kind === "forged"), false);
  assert.equal(reread.events[0].load.devices.fixture.busyMs, 0);
});

await check("trace truncation reports dropped events and unknown device coverage still refuses", async f => {
  const trace = new CacheBackupTrace();
  for (let i = 0; i < 4096; i++) trace.event("fixture_event", {sequence: i});
  const summary = trace.summary();
  assert.ok(summary.events.length > 0 && summary.events.length < 4096);
  assert.equal(summary.dropped, 4096 - summary.events.length);
  summary.events[0].sequence = -1;
  const reread = trace.summary();
  assert.equal(reread.events[0].sequence, 0, "returned events are detached snapshots");
  assert.equal(reread.dropped, summary.dropped);

  let next = load(1000, 0, "first-device");
  const folder = join(f.state, "unknown-coverage"); mkdirSync(folder);
  const admission = new CacheBackupAdmission(folder, () => {}, () => next, new CacheBackupTrace());
  admission.sample();
  next = load(2000, 10, "different-device");
  assert.throws(() => admission.sample(), /HISTORY_LOAD_OBSERVATION_UNKNOWN/);
  const report = admission.finish(new Error("HISTORY_LOAD_OBSERVATION_UNKNOWN"));
  assert.equal(report.status, "refused_or_interrupted");
  assert.ok(report.trace.events.some((event: any) => event.kind === "sample_refused"
    && String(event.error).includes("HISTORY_LOAD_OBSERVATION_UNKNOWN")));
});

await check("foreground evidence keeps numeric durability context without private receipt or request data", async () => {
  const event = parseForegroundJournalRow(JSON.stringify({__MONOTONIC_TIMESTAMP: "1234000", __REALTIME_TIMESTAMP: "5678000", _BOOT_ID: "fixture",
    MESSAGE: JSON.stringify({event: "ledger_durability_slow_sync", ms: 1500, fdatasync_ms: 2, delivery_ms: 1498,
      receipt_join: [{id: "private-sentinel"}], route: "private-sentinel", storage: {waiters: 3, private: "private-sentinel"}})}));
  assert.deepEqual(event?.metrics, {ms: 1500, fdatasync_ms: 2, delivery_ms: 1498, storage: {waiters: 3}});
  assert.equal(event?.monotonicMs, 1234); assert.equal(event?.wallAtMs, 5678);
  assert.equal(JSON.stringify(event).includes("private-sentinel"), false);
  assert.equal(parseForegroundJournalRow(JSON.stringify({MESSAGE: JSON.stringify({event: "unrelated", ms: 123})})), null);
});

if (process.argv.includes("--native-collision")) {
  await check("native collision records owned signal before wrapper exit and scratch cleanup", async f => {
    const trace = new CacheBackupTrace();
    const before = readFileSync(f.path), pidFile = join(f.state, "diagnostic-transport-pid");
    const folder = join(f.state, "native-diagnostics"); mkdirSync(folder);
    let available = true;
    const loadNow = load(performance.now(), 0);
    const admission = new CacheBackupAdmission(join(f.state, "native-diagnostics"),
      () => { if (!available) throw new Error("backup_collision"); },
      () => ({...loadNow, at: performance.now(), available: CACHE_BACKUP_POLICY.minAvailableBytes + 1}), trace);
    let failure: unknown;
    const flip = setTimeout(() => { available = false; }, 1500);
    try {
      await admission.start();
      const restic = new HostCacheRestic([process.execPath, import.meta.path, "--native-blocked", pidFile], admission);
      const maintenance = new HistoryCacheMaintenance(f.state, restic, () => {}, f.objects, undefined, admission);
      await assert.rejects(maintenance.prepare(f.session), /backup_collision/);
      failure = new Error("backup_collision");
    } finally {
      clearTimeout(flip);
      admission.finish(failure);
    }
    assert.ok(existsSync(pidFile));
    assert.deepEqual(readFileSync(f.path), before);
    const events = trace.summary().events;
    const stop = events.findIndex((event: any) => event.kind === "native_signal" && event.reason === "admission");
    const exit = events.findIndex((event: any) => event.kind === "native_exit");
    const cleanup = events.findIndex((event: any) => event.kind === "native_cleanup_end");
    assert.ok(stop >= 0 && exit >= 0 && cleanup >= 0, "signal, wrapper exit and scratch cleanup are traced");
    assert.ok(stop < exit && exit < cleanup, "owned child signal precedes wrapper exit and scratch cleanup");
  });
}

console.log("cache admission diagnostics fixture passed");
