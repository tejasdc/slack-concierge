import assert from 'node:assert/strict';
import { LedgerAdmission } from '../src/ledger-admission';

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const gate = new LedgerAdmission();
const reported: Error[] = [];
gate.enable(undefined, error => { reported.push(error); });
gate.assertSegment();
assert.equal(reported.length, 1, 'a serving-phase miss is reported, not fatal');
const entered = latch(), finished = latch();
const events: string[] = [];
const maintenance = gate.maintain(async epoch => {
  assert.equal(epoch, 1);
  events.push('maintenance'); entered.release(); await finished.promise;
});
await entered.promise;
assert.throws(() => gate.assertSegment(), /NOT_ADMITTED/, 'a miss inside maintenance is refused');
let settled = false;
const command = gate.run(() => {
  gate.assertSegment();
  assert.equal(gate.synchronous(() => 7), 7);
  events.push('command');
  return 42;
}).then(result => { settled = true; return result; });
await Promise.resolve();
assert.equal(settled, false);
assert.deepEqual(events, ['maintenance']);
finished.release();
await maintenance;
assert.equal(await command, 42);
assert.deepEqual(events, ['maintenance', 'command']);
gate.assertSegment();
assert.equal(reported.length, 2, 'serving again: a miss is reported, not fatal');

let continuation!: Promise<void>;
await gate.run(() => {
  continuation = Promise.resolve().then(() => {
    // A continuation after the segment holds no permission; while serving it is reported.
    gate.assertSegment();
    assert.equal(reported.length, 3);
  });
});
await continuation;
await assert.rejects(gate.run((() => Promise.resolve()) as never), /MUST_BE_SYNCHRONOUS/);

const resume = latch();
const nextMaintenance = gate.maintain(() => resume.promise);
const order: string[] = [];
const first = gate.run(() => { order.push('first'); });
const second = gate.run(() => { order.push('second'); });
resume.release();
await nextMaintenance;
const control = new Promise<void>(resolve => setImmediate(() => { order.push('control'); resolve(); }));
await Promise.all([first, second, control]);
assert.deepEqual(order, ['first', 'control', 'second']);

const broken = new LedgerAdmission(); broken.enable();
const fail = latch();
const failure = broken.maintain(async () => { await fail.promise; throw new Error('worker lost'); });
let escaped = false;
void broken.run(() => { escaped = true; });
fail.release();
await assert.rejects(failure, /worker lost/);
await Promise.resolve();
assert.equal(escaped, false);
assert.equal(broken.snapshot().phase, 'failed');
assert.equal(broken.snapshot().pending, 1);
assert.throws(() => broken.synchronous(() => {}), /MAINTENANCE_PENDING/);
console.log(JSON.stringify({ fixture: 'ledger-admission', result: 'pass',
  properties: ['queued closure ownership', 'nested synchronous permission', 'no permission after await',
    'async segment refused', 'failed maintenance never releases work'] }));
