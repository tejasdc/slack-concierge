#!/usr/bin/env bun
import {strict as assert} from "node:assert";
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {CacheBackupAdmission, CacheBackupTrace, CACHE_BACKUP_POLICY} from "../src/provider-history-cache-admission";
import {HistoryCacheMaintenance, HostCacheRestic} from "../src/provider-history-cache-maintenance";
import {check, fixture} from "./history-cache-maintenance-fixture";
import {DisposableCacheEvidence, parseForegroundJournalRow} from "./cache-admission-observation";

// Child mode must precede every acceptance case, including custody checks.
if (process.argv[2] === "--native-blocked") {
  const child = Bun.spawn(["sleep", "120"], {stdout: "ignore", stderr: "ignore"});
  writeFileSync(process.argv[3]!, String(child.pid));
  process.on("SIGTERM", () => {});
  await Bun.sleep(120_000);
  process.exit(1);
}

await (async () => {
  const f = fixture();
  try {
  const custody = new DisposableCacheEvidence(), before = readFileSync(f.path);
  const expected = {bytes: before.length, sha256: createHash("sha256").update(before).digest("hex")};
  custody.captureOriginal(before);
  let snapshot: string | undefined;
  const restic = custody.wrap({backup: async paths => snapshot ??= await f.restic.backup(paths),
    readback: f.restic.readback.bind(f.restic)});
  const maintenance = new HistoryCacheMaintenance(f.state, restic, () => {}, f.objects);
  const prepared = await maintenance.prepare(f.session);
  custody.fullReadbackVerified(prepared.snapshot);
  const folder = maintenance.batch(prepared.id);
  const accepted = JSON.parse(readFileSync(join(folder, "backup.json"), "utf8"));
  const receipt = JSON.parse(readFileSync(join(folder, "receipt.json"), "utf8"));
  assert.equal(await restic.backup([join(folder, "cache.sqlite"), join(folder, "manifest.json"), f.object],
    `concierge-history-cache:${prepared.id}`), prepared.snapshot);
  assert.deepEqual(custody.captureAfter(() => readFileSync(f.path)), before);
  f.cleanup();
  const retained = JSON.parse(JSON.stringify(custody.summary()));
  assert.deepEqual(retained.original, {before: expected, after: expected, afterReadFailed: false});
  assert.equal(retained.acceptedSnapshot, accepted.snapshot);
  assert.equal(retained.adoptedSnapshot, receipt.snapshot);
  assert.equal(retained.fullReadbackVerifiedSnapshot, prepared.snapshot);
  assert.equal(retained.readbacks.length, 3);
  assert.deepEqual(retained.readbacks[0], {snapshot: prepared.snapshot, ...expected});
  assert.equal(retained.readbackFailures, 0);
  assert.equal(JSON.stringify(retained).includes(f.state), false);
  assert.equal(JSON.stringify(retained).includes("Only an older version has me"), false);
  retained.readbacks.length = 0;
  assert.equal(custody.summary().readbacks.length, 3, "report snapshots cannot mutate retained evidence");
  assert.equal(f.restic.snapshots.size, 1, "adoption uses the accepted snapshot without another backup");
  console.log(JSON.stringify({check: "disposable custody retains original identities and exact verified snapshot after cleanup", status: "passed"}));
  } finally {if (existsSync(f.state)) f.cleanup();}
})();

await check("refusal retains missing evidence and byte mutation or failed reads cannot look preserved", async f => {
  const custody = new DisposableCacheEvidence();
  assert.deepEqual(custody.summary().original, {before: null, after: null, afterReadFailed: false});
  assert.equal(custody.summary().acceptedSnapshot, null);
  assert.equal(custody.summary().fullReadbackVerifiedSnapshot, null);
  const before = readFileSync(f.path), changed = Buffer.from(before);
  custody.captureOriginal(before);
  changed[changed.length - 1] ^= 1;
  writeFileSync(f.path, changed);
  custody.captureAfter(() => readFileSync(f.path));
  const report = custody.summary();
  assert.equal(report.original.before!.bytes, report.original.after!.bytes);
  assert.notEqual(report.original.before!.sha256, report.original.after!.sha256);
  const unreadable = new DisposableCacheEvidence();
  unreadable.captureOriginal(before);
  assert.equal(unreadable.captureAfter(() => {throw new Error("private-path");}), undefined);
  assert.equal(unreadable.summary().original.after, null);
  assert.equal(unreadable.summary().original.afterReadFailed, true);
  assert.equal(JSON.stringify(unreadable.summary()).includes("private-path"), false);
});

await check("failed full readback retains accepted snapshot and mismatching stream without a verified marker", async f => {
  const custody = new DisposableCacheEvidence();
  custody.captureOriginal(readFileSync(f.path));
  f.restic.failReadback = true;
  const maintenance = new HistoryCacheMaintenance(f.state, custody.wrap(f.restic), () => {}, f.objects);
  await assert.rejects(maintenance.prepare(f.session), /READBACK_FAILED/);
  custody.captureAfter(() => readFileSync(f.path));
  const report = custody.summary();
  assert.equal(report.acceptedSnapshot, [...f.restic.snapshots.keys()][0]);
  assert.equal(report.fullReadbackVerifiedSnapshot, null);
  assert.equal(report.adoptedSnapshot, null);
  assert.equal(report.readbacks.length, 1);
  assert.equal(report.readbacks[0].sha256, "0".repeat(64));
  assert.deepEqual(report.original.before, report.original.after);
});

await check("transport failure is retained while its original rejection propagates", async f => {
  const custody = new DisposableCacheEvidence(), restic = custody.wrap(f.restic);
  f.restic.failBackup = true;
  await assert.rejects(restic.backup([f.path], "disposable-tag"), /backup_failed/);
  assert.equal(custody.summary().acceptedSnapshot, null);
  await assert.rejects(restic.readback("f".repeat(64), "private-path"), /snapshot_missing/);
  assert.equal(custody.summary().readbackFailures, 1);
  assert.deepEqual(custody.summary().readbacks, []);
  assert.equal(custody.summary().fullReadbackVerifiedSnapshot, null);
  assert.equal(JSON.stringify(custody.summary()).includes("private-path"), false);
});

const load = (at: number, busyMs: number, device = "fixture") => ({at, pressure: 0,
  available: CACHE_BACKUP_POLICY.minAvailableBytes + 1,
  devices: {[device]: {readBytes: at * 10, writeBytes: at * 10, busyMs}},
  process: {readBytes: 0, writeBytes: 0, rssBytes: 0, cpuTicks: 0, processes: 1}});

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
