import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isProcessIdentityAlive } from '../../../src/runtime-identity';
import type { SandboxRunSourceEvidence } from '../adapters/live-typed-turn';
import type { SandboxEvidenceWriter } from './evidence';

export type NativeLaneBinding = {
  runId: string; lane: number; statePath: string; sourceId: string; generation: number;
  capabilitySocket?: string;
  supervisor: { pid: number; start_ticks: string; boot_id: string };
  candidate: { pid: number; start_ticks: string };
};

export function assertNativeLaneReceipt(run: any, ready: any, expected: {
  runId: string; lane: number; statePath: string; sourceId: string; previousGeneration: number; capabilitySocket?: string;
}): NativeLaneBinding {
  const stateDirectory = dirname(expected.statePath);
  if (run.run_id !== expected.runId || run.lane !== expected.lane || run.status !== 'running'
    || run.source?.source_id !== expected.sourceId || !Number.isSafeInteger(run.generation)
    || run.generation <= expected.previousGeneration || run.slack_enabled !== false
    || (expected.capabilitySocket !== undefined && run.capability_socket !== expected.capabilitySocket)
    || run.paths?.state !== stateDirectory || run.paths?.ready_file !== join(stateDirectory, 'ready.json')
    || !run.supervisor?.pid || !run.supervisor.start_ticks || !run.supervisor.boot_id
    || !run.candidate?.pid || !run.candidate.start_ticks
    || ready.schema_version !== 1 || ready.pid !== run.candidate.pid
    || ready.run_id !== expected.runId || ready.lane !== expected.lane || ready.slack_enabled !== false
    || ready.owner_socket !== join(stateDirectory, 'requests.sock')
    || !ready.ready_at || ['team_id', 'app_id', 'bot_user_id', 'bot_id'].some(key => ready[key] != null)) {
    throw new Error('Removal acceptance requires the exact controller-owned native candidate and its own non-Slack readiness.');
  }
  return { ...expected, generation: run.generation, supervisor: run.supervisor, candidate: run.candidate };
}

export class UnifiedSessionSandbox {
  readonly statePath: string;
  private readonly runRoot: string;
  private readonly database: Database;
  private nativeBinding: NativeLaneBinding | null = null;

  constructor(statePath: string, private readonly source: SandboxRunSourceEvidence,
    private readonly evidence: SandboxEvidenceWriter) {
    this.statePath = realpathSync(statePath);
    this.runRoot = dirname(dirname(this.statePath));
    if (join(this.runRoot, 'evidence') !== resolve(evidence.runRoot)
      || lstatSync(statePath).isSymbolicLink()) throw new Error('Session acceptance state must belong to the claimed evidence run.');
    this.database = new Database(this.statePath, { readonly: true, create: false });
  }
  close() { this.database.close(); }
  rows<T = Record<string, any>>(sql: string, ...parameters: Array<string | number>): T[] {
    if (this.nativeBinding) this.assertNative();
    return this.database.query(sql).all(...parameters) as T[];
  }
  one<T = Record<string, any>>(sql: string, ...parameters: Array<string | number>): T | null {
    return this.rows<T>(sql, ...parameters)[0] ?? null;
  }
  private readRun() { return JSON.parse(readFileSync(join(this.runRoot, 'run.json'), 'utf8')); }
  bindNative(previousGeneration = this.source.generation, capabilitySocket = this.nativeBinding?.capabilitySocket) {
    const run = this.readRun();
    const ready = JSON.parse(readFileSync(join(dirname(this.statePath), 'ready.json'), 'utf8'));
    this.nativeBinding = assertNativeLaneReceipt(run, ready, { runId: this.evidence.runId,
      lane: Number(this.evidence.laneId.replace('lane-', '')), statePath: this.statePath,
      sourceId: this.source.source_id, previousGeneration, capabilitySocket });
    this.assertNative();
    return this.nativeBinding;
  }
  assertNative() {
    const binding = this.nativeBinding;
    if (!binding) throw new Error('The case has not established native lane ownership.');
    const current = assertNativeLaneReceipt(this.readRun(), JSON.parse(readFileSync(join(dirname(this.statePath), 'ready.json'), 'utf8')),
      { ...binding, previousGeneration: binding.generation - 1 });
    if (current.generation !== binding.generation || current.candidate.pid !== binding.candidate.pid
      || current.candidate.start_ticks !== binding.candidate.start_ticks
      || JSON.stringify(current.supervisor) !== JSON.stringify(binding.supervisor)
      || !isProcessIdentityAlive({ pid: current.supervisor.pid, startTicks: current.supervisor.start_ticks, bootId: current.supervisor.boot_id })
      || !isProcessIdentityAlive({ pid: current.candidate.pid, startTicks: current.candidate.start_ticks, bootId: current.supervisor.boot_id })) {
      throw new Error('The exact native sandbox candidate or its supervisor changed during acceptance.');
    }
    const environment = new Map(readFileSync(`/proc/${current.candidate.pid}/environ`, 'utf8').split('\0').map(entry => {
      const index = entry.indexOf('='); return [entry.slice(0, index), entry.slice(index + 1)] as const;
    }));
    if (environment.get('CONCIERGE_SLACK_ENABLED') !== '0'
      || environment.get('CONCIERGE_STATE_DIR') !== dirname(this.statePath)
      || (binding.capabilitySocket !== undefined && environment.get('CONCIERGE_SESSION_CAPABILITY_SOCKET') !== binding.capabilitySocket)) {
      throw new Error('Native readiness does not match the candidate execution environment.');
    }
    return current;
  }
  async ownerResponse(path: string, body?: unknown) {
    this.assertNative();
    if (!path.startsWith('/sessions/v1/')) throw new Error('Acceptance only uses the existing owner contract.');
    const response = await fetch(`http://localhost${path}`, { unix: join(dirname(this.statePath), 'requests.sock'),
      ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000) });
    const result = await response.json();
    return { status: response.status, result };
  }
  async owner(path: string, body?: unknown) {
    const response = await this.ownerResponse(path, body);
    if (response.status < 200 || response.status >= 300) throw new Error(`Owner ${path} refused (${response.status}): ${JSON.stringify(response.result)}`);
    return response.result;
  }
  slackEffects() {
    return this.one(`SELECT
      (SELECT count(*) FROM slack_user_input_claims) AS inputs,
      (SELECT count(*) FROM routed_requests) AS routed,
      (SELECT count(*) FROM turn_delivery_chunks WHERE delivered_at IS NOT NULL) AS delivered`)!;
  }
  requests() { return this.rows('SELECT * FROM session_communication_requests ORDER BY rowid'); }
  events(requestId: string) { return this.rows('SELECT * FROM session_communication_events WHERE request_id=? ORDER BY rowid', requestId); }
  async until<T>(description: string, read: () => T | null | Promise<T | null>, timeout = 180_000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await read();
      if (value !== null) return value;
      await Bun.sleep(200);
    }
    throw new Error(`Unified acceptance timed out: ${description}`);
  }
  save(label: string, value: unknown) { this.evidence.writeJson(`unified-session-${label}.json`, value); }
  async reload(slack: 'enabled' | 'disabled', capabilitySocket?: string) {
    const run = this.readRun();
    if (run.run_id !== this.evidence.runId || run.source?.source_id !== this.source.source_id) throw new Error('Controller reload source changed.');
    const controller = join(run.worktree, 'bot/scripts/sandbox-lane-control.sh');
    if (!existsSync(controller)) throw new Error('Claimed controller is unavailable.');
    const child = Bun.spawn(['bash', controller, 'reload', '--lane', this.evidence.laneId.replace('lane-', ''),
      '--run-id', this.evidence.runId, '--slack', slack,
      ...(capabilitySocket ? ['--capability-socket', capabilitySocket] : [])], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    this.save(`reload-${run.generation}`, { slack, capability_socket: capabilitySocket, exitCode, stdout, stderr });
    if (exitCode) throw new Error(`Controller-owned ${slack} reload failed: ${stderr}`);
    if (slack === 'disabled') return this.bindNative(run.generation, capabilitySocket);
    this.nativeBinding = null;
    return null;
  }
}

export function assertCorrelatedExchange(request: any, events: any[], expected: {
  sourceSession: number; targetSession: number; partial: string; final: string;
}) {
  if (!request || request.source_session_id !== expected.sourceSession || request.target_session_id !== expected.targetSession
    || !request.source_input_id || !request.target_input_id || request.routed_request_id !== null
    || request.outcome !== 'answered' || request.status !== 'settled') throw new Error('The exact native request did not settle as answered.');
  const partials = events.filter(event => event.kind === 'progress');
  const finals = events.filter(event => event.kind === 'final');
  if (!partials.some(event => JSON.parse(event.payload_json).text.includes(expected.partial)) || finals.length !== 1
    || !JSON.parse(finals[0].payload_json).text.includes(expected.final)
    || events.some(event => event.request_id !== request.request_id || event.status !== 'received'
      || !event.accepted_input_id || event.routed_request_id !== null)
    || new Set(events.map(event => event.event_id)).size !== events.length) {
    throw new Error('Partial/final replies or exactly-once native returns lost their request identity.');
  }
}
