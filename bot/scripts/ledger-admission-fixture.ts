import assert from 'node:assert/strict';
import { LedgerAdmission } from '../src/ledger-admission';

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const gate = new LedgerAdmission();
gate.enable();
assert.throws(() => gate.assertSegment(), /NOT_ADMITTED/);
const entered = latch(), finished = latch();
const events: string[] = [];
const maintenance = gate.maintain(async epoch => {
  assert.equal(epoch, 1);
  events.push('maintenance'); entered.release(); await finished.promise;
});
await entered.promise;
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
assert.throws(() => gate.assertSegment(), /NOT_ADMITTED/);

let continuation!: Promise<void>;
await gate.run(() => {
  continuation = Promise.resolve().then(() => {
    assert.throws(() => gate.assertSegment(), /NOT_ADMITTED/);
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
