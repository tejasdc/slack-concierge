import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { initializeCodexMutationFenceSchema, grantCodexMutationPermit, consumeCodexMutationPermit } from '../src/codex-mutation-fence';
import { assessManagedCodexWriterCoverage, initializeManagedCodexProcessRegistrySchema,
  observeManagedCodexChildExit, registerManagedCodexChild } from '../src/codex-managed-process-registry';

const dir = mkdtempSync(join(tmpdir(), 'codex-managed-process-registry-fixture-'));
const path = join(dir, 'state.db');
const db = new Database(path);
const independent = new Database(path);
db.exec('PRAGMA foreign_keys=ON');
independent.exec('PRAGMA foreign_keys=ON');
initializeCodexMutationFenceSchema(db);
initializeManagedCodexProcessRegistrySchema(db);

const threadA = '11111111-1111-4111-8111-111111111111';
const threadB = '22222222-2222-4222-8222-222222222222';
const rows = new Map<number, { pid: number; startTicks: string; executablePath: string }>();
const parents = new Map<number, number>();
const commandLines = new Map<number, string[]>();
const localListenerOwners = new Set<string>();
const unreadable = new Set<number>();
const releaseRoot = join(dir, 'release');
const helperBytes = Buffer.from('sealed fixture helper source');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const unsigned = { format: 2, files: { 'control/codex-managed-launch.js': hash(helperBytes) } };
const artifactDigest = hash(JSON.stringify(unsigned));
const artifact = join(releaseRoot, 'releases', artifactDigest);
mkdirSync(join(artifact, 'control'), { recursive: true });
writeFileSync(join(artifact, 'control', 'codex-managed-launch.js'), helperBytes);
writeFileSync(join(artifact, 'manifest.json'), JSON.stringify({ ...unsigned, artifact_digest: artifactDigest }));
const helperPath = join(artifact, 'control', 'codex-managed-launch.js');
const nativePath = join(dir, 'codex');
writeFileSync(nativePath, 'fixture native executable');
const proc = {
  listPids: () => [...rows.keys(), ...unreadable],
  identity(pid: number) {
    if (unreadable.has(pid)) throw new Error('synthetic unreadable /proc entry');
    return rows.get(pid) ?? null;
  },
  parentPid(pid: number) { return parents.get(pid) ?? null; },
  commandLine(pid: number) { return commandLines.get(pid) ?? null; },
  ownsUnixListener(pid: number, socketPath: string) { return localListenerOwners.has(`${pid}:${socketPath}`); },
  socketListeners: (_socketPath: string) => [100],
};
const identity = (pid: number, startTicks: string) => ({ pid, startTicks, executablePath: nativePath });
const evidence = (connectionId: string, permitId: string) => [connectionId, permitId];
function helperParent(childPid: number, originalArgs: string[], childArgs: string[]) {
  const parentPid = childPid + 1000;
  rows.set(parentPid, { pid: parentPid, startTicks: `${parentPid}1`, executablePath: '/usr/bin/bun' });
  parents.set(childPid, parentPid);
  commandLines.set(parentPid, ['/usr/bin/bun', helperPath, '--native', nativePath, '--', ...originalArgs]);
  commandLines.set(childPid, [nativePath, ...childArgs]);
  return parentPid;
}

try {
  // The daemon exemption is tied to the socket inode listener adapter, not a name or timestamp.
  rows.set(100, identity(100, '900'));
  rows.set(200, identity(200, '1200')); // Existing proxy: no durable registration.
  const oldParent = helperParent(200, ['app-server', 'proxy'], ['app-server', 'proxy']);
  commandLines.set(oldParent, ['/usr/bin/bun', '/tmp/old-proxy-launcher.js', '--native', nativePath, '--', 'app-server', 'proxy']);
  const oldProxy = assessManagedCodexWriterCoverage({ db: independent, threadId: threadA,
    socketPath: '/run/codex.sock', proc });
  assert.equal(oldProxy.covered, false);
  assert.deepEqual(oldProxy.blockers.map(item => [item.code, item.pid]), [['UNMEDIATED_NATIVE_WRITER', 200]]);
  assert(!oldProxy.blockers.some(item => item.pid === 100));

  const proxyRegistration = { connectionId: 'proxy-connection', permitId: 'proxy-process', kind: 'rawproxy' as const,
    threadScope: '*', mediated: true, evidenceIds: evidence('proxy-connection', 'proxy-process') };
  rows.set(201, identity(201, '1201')); // New managed proxy.
  const proxySocket = '/tmp/concierge-codex-proxy-fixture/proxy.sock';
  const proxyParent = helperParent(201, ['app-server', 'proxy'], ['app-server', 'proxy', '--sock', proxySocket]);
  localListenerOwners.add(`${proxyParent}:${proxySocket}`);
  assert.throws(() => registerManagedCodexChild({ db, registration: proxyRegistration, pid: 200, nowMs: 1, proc, releaseRoot }));
  assert.equal(registerManagedCodexChild({ db, registration: proxyRegistration, pid: 201, nowMs: 1, proc, releaseRoot }).registered, true);
  assert.equal(registerManagedCodexChild({ db: independent, registration: proxyRegistration, pid: 201, nowMs: 2, proc, releaseRoot }).duplicate, true);
  assert.equal(assessManagedCodexWriterCoverage({ db: independent, threadId: threadA,
    socketPath: '/run/codex.sock', proc }).covered, false); // Old unmanaged proxy still blocks.
  rows.delete(200);
  const registeredProxy = assessManagedCodexWriterCoverage({ db: independent, threadId: threadA,
    socketPath: '/run/codex.sock', proc });
  assert.equal(registeredProxy.covered, true);
  assert.deepEqual(registeredProxy.writers.map(writer => [writer.pid, writer.kind, writer.mediated]), [[201, 'rawproxy', true]]);

  // CLI registration is accepted only after its exact lifetime intent and permit are durable.
  const lifetimePermit = 'cli-permit';
  const lifetimeIntent = 'cli-intent';
  const owner = { acceptedInputId: 'input-1', runId: 'run-1', dispatchAttempt: 1 };
  assert.equal(grantCodexMutationPermit(db, { permitId: lifetimePermit, threadId: threadA, owner,
    method: 'managed/cli-lifetime', paramsDigest: 'a'.repeat(64), purpose: 'ordinary', nowMs: 3 }).granted, true);
  assert.equal(consumeCodexMutationPermit(independent, { permitId: lifetimePermit, intentId: lifetimeIntent,
    paramsDigest: 'a'.repeat(64), nowMs: 4 }).forward, true);
  rows.set(202, identity(202, '1202'));
  const cliRegistration = { connectionId: 'cli-connection', permitId: lifetimePermit, intentId: lifetimeIntent,
    kind: 'cli' as const, threadScope: threadA, mediated: false, lifetimeIntentConsumed: true,
    evidenceIds: ['input-1', 'run-1', lifetimePermit, lifetimeIntent] };
  helperParent(202, ['resume', threadA], ['resume', threadA]);
  assert.equal(registerManagedCodexChild({ db: independent, registration: cliRegistration, pid: 202, nowMs: 5, proc, releaseRoot }).registered, true);
  const targetCli = assessManagedCodexWriterCoverage({ db, threadId: threadA, socketPath: '/run/codex.sock', proc });
  assert.equal(targetCli.covered, true);
  assert.deepEqual(targetCli.writers.map(writer => [writer.pid, writer.threadScope, writer.mediated]),
    [[201, '*', true], [202, threadA, false]]);
  const unrelated = assessManagedCodexWriterCoverage({ db, threadId: threadB, socketPath: '/run/codex.sock', proc });
  assert.equal(unrelated.covered, true);
  assert.deepEqual(unrelated.writers.map(writer => writer.pid), [201]);

  // PID reuse cannot inherit an old registration: the process start tick is part of its identity.
  rows.set(201, identity(201, '9999'));
  const pidAba = assessManagedCodexWriterCoverage({ db: independent, threadId: threadA,
    socketPath: '/run/codex.sock', proc });
  assert(pidAba.blockers.some(item => item.code === 'UNMEDIATED_NATIVE_WRITER' && item.pid === 201));
  rows.set(201, identity(201, '1201'));

  // Only an observed child-handle exit updates process registration. It does not resolve the
  // separately durable native mutation intent, and a still-present process after that receipt blocks.
  const cliIdentity = identity(202, '1202');
  const exitDigest = 'b'.repeat(64);
  assert.equal(observeManagedCodexChildExit({ db: independent, connectionId: 'cli-connection', permitId: lifetimePermit,
    pid: cliIdentity.pid, startTicks: cliIdentity.startTicks, exitCode: 0, exitEvidenceDigest: exitDigest, nowMs: 6 }).observed, true);
  assert.equal(observeManagedCodexChildExit({ db, connectionId: 'cli-connection', permitId: lifetimePermit,
    pid: cliIdentity.pid, startTicks: cliIdentity.startTicks, exitCode: 0, exitEvidenceDigest: exitDigest, nowMs: 7 }).duplicate, true);
  assert.equal(assessManagedCodexWriterCoverage({ db, threadId: threadA, socketPath: '/run/codex.sock', proc })
    .blockers.some(item => item.pid === 202), true);
  assert.equal((db.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(lifetimeIntent) as any).state, 'forwarding');
  rows.delete(202);
  assert.equal(assessManagedCodexWriterCoverage({ db, threadId: threadA, socketPath: '/run/codex.sock', proc }).covered, true);
  assert.equal((independent.query('SELECT state FROM codex_mutation_intents WHERE intent_id=?').get(lifetimeIntent) as any).state, 'forwarding');

  unreadable.add(303);
  const unknown = assessManagedCodexWriterCoverage({ db, threadId: threadA, socketPath: '/run/codex.sock', proc });
  assert.equal(unknown.covered, false);
  assert(unknown.blockers.some(item => item.code === 'NATIVE_WRITER_SCOPE_UNKNOWN' && item.pid === 303));
  assert.throws(() => registerManagedCodexChild({ db, registration: {
    connectionId: 'cli-connection-2', permitId: 'not-consumed', intentId: 'missing', kind: 'cli', threadScope: threadB,
    mediated: false, lifetimeIntentConsumed: true, evidenceIds: ['missing'],
  }, pid: 100, nowMs: 8, proc, releaseRoot }));
  console.log('codex-managed-process-registry-fixture: sealed helper lineage, legacy proxy rejection, helper-local proxy socket, exact CLI binding, inode daemon exemption, PID ABA, exit retention, and unknown scope refusal: PASS');
} finally {
  independent.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
