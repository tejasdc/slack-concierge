import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isProcessIdentityAlive, type ProcessIdentity } from '../../../src/runtime-identity';

type ThinkeringFixture = {
  origin: string;
  loopbackOrigin: string;
  credentialsPath: string;
  ownerSocket: string;
  capabilitySocket: string;
  processIdentity: ProcessIdentity;
};

function privateFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new Error('Thinkering acceptance configuration must be an owner-only regular file.');
  }
  return readFileSync(path, 'utf8');
}

/** Client of the real authenticated Thinkering application; never an owner substitute. */
export class ThinkeringSessionAcceptance {
  private readonly fixture: ThinkeringFixture;
  private cookie: string | null = null;
  private readonly source: { git_sha: string; worktree: string };
  constructor(path: string, stateDirectory: string) {
    this.fixture = JSON.parse(privateFile(path));
    const origin = new URL(this.fixture.origin), loopback = new URL(this.fixture.loopbackOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== this.fixture.origin
      || loopback.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(loopback.hostname)
      || loopback.origin !== this.fixture.loopbackOrigin || !loopback.port
      || this.fixture.ownerSocket !== join(realpathSync(stateDirectory), 'requests.sock')) {
      throw new Error('Thinkering acceptance must target a source-pinned loopback app configured for the exact claimed owner socket.');
    }
    this.assertLive();
    const worktree = readlinkSync(`/proc/${this.fixture.processIdentity.pid}/cwd`);
    const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: worktree, stdout: 'pipe', stderr: 'pipe' });
    const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=all'], { cwd: worktree, stdout: 'pipe', stderr: 'pipe' });
    if (head.exitCode || status.exitCode || status.stdout.toString().trim() || !/^[a-f0-9]{40}$/.test(head.stdout.toString().trim())) {
      throw new Error('The actual Thinkering acceptance process must run from a clean pinned source checkout.');
    }
    this.source = { worktree, git_sha: head.stdout.toString().trim() };
  }
  private assertLive() {
    if (!isProcessIdentityAlive(this.fixture.processIdentity)) throw new Error('The exact Thinkering acceptance process is no longer live.');
  }
  sourceEvidence() { return { origin: this.fixture.origin, owner_socket: this.fixture.ownerSocket,
    process: this.fixture.processIdentity, source: this.source, capability_socket: this.fixture.capabilitySocket }; }
  capabilitySocket() { this.assertLive(); return this.fixture.capabilitySocket; }
  private async call(method: 'GET' | 'POST', path: string, body?: unknown, authenticated = true) {
    this.assertLive();
    if (!path.startsWith('/api/session-owner/')) throw new Error('Unexpected Thinkering acceptance route.');
    if (authenticated && !this.cookie) throw new Error('Thinkering acceptance has not authenticated its synthetic fixture session.');
    const response = await fetch(`${this.fixture.loopbackOrigin}${path}`, { method,
      headers: { origin: this.fixture.origin, ...(authenticated ? { cookie: this.cookie! } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    return { status: response.status, result };
  }
  async request(method: 'GET' | 'POST', path: string, body?: unknown) {
    const response = await this.call(method, path, body);
    if (response.status < 200 || response.status >= 300) throw new Error(`Authenticated Thinkering ${method} ${path} refused (${response.status}): ${JSON.stringify(response.result)}`);
    return response.result;
  }
  async proveBinding(sessionId: string, nativeUuid: string) {
    const credentials = JSON.parse(privateFile(this.fixture.credentialsPath));
    const login = await fetch(`${this.fixture.loopbackOrigin}/api/session/login`, { method: 'POST',
      headers: { origin: this.fixture.origin, 'content-type': 'application/json' }, body: JSON.stringify(credentials),
      redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!login.ok || !login.headers.get('set-cookie')) throw new Error('The real Thinkering login did not establish an authenticated session.');
    this.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const found = await this.request('GET', `/api/session-owner/sessions/${encodeURIComponent(sessionId)}`);
    if (found.session?.id !== sessionId || found.session?.runtimeThreadId !== nativeUuid) {
      throw new Error('Thinkering did not resolve the exact Slack-created native session in this claimed owner.');
    }
    const unauthenticated = await this.call('POST', '/api/session-owner/sessions',
      { clientActionId: randomUUID(), provider: 'codex', purpose: 'chat', title: 'Unauthenticated acceptance must refuse' }, false);
    if (![401, 403].includes(unauthenticated.status)) throw new Error('Thinkering accepted a human-origin mutation without authentication.');
    return { session: found.session, unauthenticated_status: unauthenticated.status, ...this.sourceEvidence() };
  }
  create(provider: 'codex' | 'claude-code', title: string) {
    return this.request('POST', '/api/session-owner/sessions', { clientActionId: randomUUID(), provider, purpose: 'chat', title });
  }
  input(sessionId: string, text: string, id = randomUUID()) {
    return this.request('POST', `/api/session-owner/sessions/${encodeURIComponent(sessionId)}/inputs`, { clientActionId: id, text });
  }
  action(sessionId: string, kind: 'pause' | 'continue') {
    return this.request('POST', `/api/session-owner/sessions/${encodeURIComponent(sessionId)}/actions`, { clientActionId: randomUUID(), action: { kind } });
  }
}
