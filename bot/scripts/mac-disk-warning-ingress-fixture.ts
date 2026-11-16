import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runFixtureChild } from './fixture-child';

async function child() {
  const root = process.env.CONCIERGE_STATE_DIR!;
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'slack-inbox', '.git'), {recursive: true});
  await writeFile(join(workspace, 'slack-inbox', 'AGENTS.md'), 'Disposable Inbox fixture.');
  const [{SessionOwner}, {db}, {startForegroundGateway}] = await Promise.all([
    import('../src/session-owner'), import('../src/state'), import('../src/foreground-gateway')]);
  const owner = new SessionOwner({available: () => true, wake: () => {}, steer: () => false,
    stop: async () => false}, workspace);
  owner.inbox();
  // No remote provider work is performed; only the paired-owner presence is supplied.
  owner.communication = {peersOrNull: () => ({self: 'cloud'})} as any;
  const ownerSocket = join(root, 'fixture-owner.sock');
  const server = Bun.serve({unix: ownerSocket, fetch: async request =>
    await owner.handle(request) ?? new Response('Unknown', {status: 404})});
  const reserved = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved')});
  const port = reserved.port;
  await reserved.stop(true);
  const token = 'disposable-mac-disk-peer-token-never-a-real-secret';
  const gateway = await startForegroundGateway({stateDir: root, ownerSocket,
    readWorkerEntry: join(import.meta.dir, '../src/native-read-worker.ts'),
    peer: {hostname: '127.0.0.1', port, token}});
  const path = '/sessions/v1/peers/mac-disk-warning';
  const request = (freeBytes: number) => ({method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({episode: 1, freeBytes, recovered: false})});
  try {
    const spoof = request(18 * 1024 ** 3);
    spoof.headers['x-concierge-verified-peer'] = '1';
    const local = await fetch('http://fixture' + path, {...spoof, unix: join(root, 'requests.sock')});
    assert.equal(local.status, 403, 'local clients cannot forge verified peer status');
    const unauthenticated = await fetch(`http://127.0.0.1:${port}${path}`, spoof);
    assert.equal(unauthenticated.status, 401, 'network peer token is mandatory even with a forged header');
    const authenticated = request(18 * 1024 ** 3);
    authenticated.headers['authorization'] = 'Bearer ' + token;
    const accepted = await fetch(`http://127.0.0.1:${port}${path}`, authenticated);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), {status: 'recorded', key: 'mac-disk-low:1'});
    const duplicate = await fetch(`http://127.0.0.1:${port}${path}`, authenticated);
    assert.equal((await duplicate.json()).status, 'duplicate');
    assert.equal(db.query("SELECT count(*) AS n FROM session_inputs WHERE id='service:service-notice:mac-disk-low:1'").get().n, 1);
    const inbox = db.query("SELECT native_metadata_json FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1").get();
    assert.equal(JSON.parse(inbox.native_metadata_json).needs.filter(need => need.eventId === 'service-notice:mac-disk-low:1').length, 1);
    console.log(JSON.stringify({fixture: 'mac-disk-warning-ingress', status: 'passed',
      proof: 'real gateway+owner rejects forged peer headers, requires token and records one server Inbox warning'}));
  } finally {
    await gateway.stop(true);
    await server.stop(true);
  }
}

if (process.argv.includes('--child')) await child();
else {
  const root = await mkdtemp(join(tmpdir(), 'concierge-mac-disk-ingress-'));
  try {
    await writeFile(join(root, 'peer.token'), 'disposable-fixture-peer-token-not-a-real-secret', {mode: 0o600});
    const result = await runFixtureChild({command: process.execPath, args: [import.meta.path, '--child'],
      env: {...process.env, CONCIERGE_STATE_DIR: root, CONCIERGE_CAPTURE_STATE_DIR: join(root, 'capture'),
        CONCIERGE_WORKSPACE_ROOT: join(root, 'workspace'), CONCIERGE_PEER_NAME: 'cloud',
        CONCIERGE_PEERS: '[]', CONCIERGE_PEER_LISTEN: '', CONCIERGE_PEER_TOKEN_FILE: join(root, 'peer.token'),
        CONCIERGE_TEST_MODE: '1', CONCIERGE_TEST_AUTHORIZATION: 'foreground-isolation-5804d389'},
      deadlineMs: 40_000, fixture: 'mac-disk-warning-ingress'});
    console.log(JSON.stringify(result));
  } finally { await rm(root, {recursive: true, force: true}); }
}
