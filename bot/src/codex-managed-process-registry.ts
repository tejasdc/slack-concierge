import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { controlSocketListeners } from './codex-daemon-file-limit';
import { managedCodexInvocation } from './codex-managed-launch-classifier';

export type ManagedCodexProcessKind = 'rawproxy' | 'cli' | 'tui' | 'desktop-proxy';
export type ManagedCodexProcessRegistration = {
  connectionId: string;
  permitId: string;
  intentId?: string;
  kind: ManagedCodexProcessKind;
  threadScope: string;
  mediated: boolean;
  lifetimeIntentConsumed?: boolean;
  evidenceIds: string[];
};

type ProcessIdentity = { pid: number; startTicks: string; executablePath: string };
type ProcSource = {
  listPids(): number[];
  identity(pid: number): ProcessIdentity | null;
  parentPid(pid: number): number | null;
  commandLine(pid: number): string[] | null;
  ownsUnixListener(pid: number, socketPath: string): boolean;
  socketListeners(socketPath: string): number[];
};
const defaultReleaseRoot = process.env.CONCIERGE_DEPLOYMENT_RELEASE_ROOT || '/var/lib/slack-concierge-deployment';

const defaultProcSource: ProcSource = {
  listPids() {
    return readdirSync('/proc', { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(entry => Number(entry.name));
  },
  identity(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) throw new Error('malformed proc stat');
      // starttime is field 22. The suffix starts at field 3 (state).
      const startTicks = stat.slice(close + 1).trim().split(/\s+/)[19];
      const executablePath = readlinkSync(`/proc/${pid}/exe`);
      if (!startTicks || !/^\d+$/.test(startTicks) || !executablePath.startsWith('/'))
        throw new Error('incomplete process identity');
      return { pid, startTicks, executablePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return null;
      throw error;
    }
  },
  parentPid(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), close = stat.lastIndexOf(')');
      const parent = Number(close < 0 ? NaN : stat.slice(close + 1).trim().split(/\s+/)[1]);
      return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
    } catch { return null; }
  },
  commandLine(pid) {
    try {
      const values = readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
      if (values.at(-1) === '') values.pop();
      return values.length && values.every(value => value.length > 0) ? values : null;
    } catch { return null; }
  },
  ownsUnixListener(pid, socketPath) {
    try {
      const row = readFileSync('/proc/net/unix', 'utf8').split('\n').find(line => line.trim().endsWith(` ${socketPath}`));
      const fields = row?.trim().split(/\s+/) ?? [];
      const inode = fields[6];
      if (fields[4] !== '0001' || fields[5] !== '01' || !inode || !/^\d+$/.test(inode)) return false;
      return readdirSync(`/proc/${pid}/fd`).some(fd => {
        try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
      });
    } catch { return false; }
  },
  socketListeners: controlSocketListeners,
};

function isCodexExecutable(path: string) {
  return basename(path.replace(/ \(deleted\)$/, '')) === 'codex';
}

/** Called only by the canonical owner schema initializer under its schema guard. */
export function initializeManagedCodexProcessRegistrySchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_managed_process_registrations (
      connection_id TEXT NOT NULL,
      permit_id TEXT NOT NULL,
      intent_id TEXT,
      process_kind TEXT NOT NULL CHECK(process_kind IN ('rawproxy','cli','tui','desktop-proxy')),
      thread_scope TEXT NOT NULL,
      mediated INTEGER NOT NULL CHECK(mediated IN (0,1)),
      pid INTEGER NOT NULL CHECK(pid > 0),
      start_ticks TEXT NOT NULL,
      executable_path TEXT NOT NULL,
      parent_pid INTEGER NOT NULL,
      parent_start_ticks TEXT NOT NULL,
      helper_artifact_digest TEXT NOT NULL,
      lineage_evidence_digest TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','observed_exit')),
      registered_at_ms INTEGER NOT NULL,
      exit_observed_at_ms INTEGER,
      exit_code INTEGER,
      exit_evidence_digest TEXT,
      PRIMARY KEY(connection_id,permit_id),
      UNIQUE(pid,start_ticks),
      CHECK((state='active' AND exit_observed_at_ms IS NULL AND exit_code IS NULL AND exit_evidence_digest IS NULL) OR
            (state='observed_exit' AND exit_observed_at_ms IS NOT NULL AND exit_evidence_digest IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS codex_managed_process_scope_state
      ON codex_managed_process_registrations(thread_scope,state);
    CREATE TRIGGER IF NOT EXISTS codex_managed_process_identity_immutable
      BEFORE UPDATE ON codex_managed_process_registrations
      WHEN NEW.connection_id IS NOT OLD.connection_id OR NEW.permit_id IS NOT OLD.permit_id
        OR NEW.intent_id IS NOT OLD.intent_id OR NEW.process_kind IS NOT OLD.process_kind
        OR NEW.thread_scope IS NOT OLD.thread_scope OR NEW.mediated IS NOT OLD.mediated
        OR NEW.pid IS NOT OLD.pid OR NEW.start_ticks IS NOT OLD.start_ticks
        OR NEW.executable_path IS NOT OLD.executable_path
        OR NEW.parent_pid IS NOT OLD.parent_pid OR NEW.parent_start_ticks IS NOT OLD.parent_start_ticks
        OR NEW.helper_artifact_digest IS NOT OLD.helper_artifact_digest
        OR NEW.lineage_evidence_digest IS NOT OLD.lineage_evidence_digest
        OR NEW.evidence_ids_json IS NOT OLD.evidence_ids_json
        OR OLD.state='observed_exit'
      BEGIN SELECT RAISE(ABORT,'managed Codex process identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS codex_managed_process_no_delete
      BEFORE DELETE ON codex_managed_process_registrations
      BEGIN SELECT RAISE(ABORT,'managed Codex process registrations are retained'); END;
  `);
}

function readRawIdentity(source: ProcSource, pid: number) {
  const identity = source.identity(pid);
  if (!identity) throw new Error(`Managed Codex child ${pid} exited before its identity could be registered.`);
  if (identity.pid !== pid || !/^\d+$/.test(identity.startTicks) || !identity.executablePath.startsWith('/'))
    throw new Error('Managed process identity is incomplete or mismatched.');
  return identity;
}

function readIdentity(source: ProcSource, pid: number) {
  const identity = readRawIdentity(source, pid);
  if (!isCodexExecutable(identity.executablePath))
    throw new Error('Managed Codex child identity does not match a native Codex executable.');
  return identity;
}

function sha256(value: string | Uint8Array) { return createHash('sha256').update(value).digest('hex'); }

function verifySealedHelper(scriptPath: string, releaseRoot: string) {
  const root = realpathSync(releaseRoot);
  const script = realpathSync(scriptPath);
  const releases = realpathSync(join(root, 'releases'));
  const artifact = dirname(dirname(script));
  const manifest = JSON.parse(readFileSync(join(artifact, 'manifest.json'), 'utf8'));
  if (manifest?.format !== 2 || typeof manifest.artifact_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.artifact_digest) ||
      script !== join(artifact, 'control', 'codex-managed-launch.js') ||
      artifact !== join(releases, manifest.artifact_digest) ||
      typeof manifest.files?.['control/codex-managed-launch.js'] !== 'string')
    throw new Error('Managed Codex helper is not under a canonical sealed release artifact.');
  const { artifact_digest: _artifactDigest, ...unsigned } = manifest;
  if (sha256(JSON.stringify(unsigned)) !== manifest.artifact_digest ||
      sha256(readFileSync(script)) !== manifest.files['control/codex-managed-launch.js'])
    throw new Error('Managed Codex helper does not match its sealed release manifest.');
  return manifest.artifact_digest as string;
}

function verifyChildLineage(registration: ManagedCodexProcessRegistration, pid: number, source: ProcSource,
  releaseRoot: string) {
  const identity = readIdentity(source, pid);
  const parentPid = source.parentPid(pid);
  if (!parentPid) throw new Error('Managed Codex child has no readable helper parent.');
  const parentIdentity = readRawIdentity(source, parentPid);
  const parentArgv = source.commandLine(parentPid), childArgv = source.commandLine(pid);
  if (!parentArgv || !childArgv || parentArgv.length < 6 || basename(parentArgv[0]!) !== 'bun' ||
      basename(parentIdentity.executablePath.replace(/ \(deleted\)$/, '')) !== 'bun' ||
      parentArgv[2] !== '--native' || parentArgv[4] !== '--' || !parentArgv[3]!.startsWith('/'))
    throw new Error('Managed Codex process parent is not the versioned launch helper.');
  const helperDigest = verifySealedHelper(parentArgv[1]!, releaseRoot);
  const requestedNative = realpathSync(parentArgv[3]!);
  const childExecutable = realpathSync(identity.executablePath.replace(/ \(deleted\)$/, ''));
  if (requestedNative !== childExecutable || !isCodexExecutable(childExecutable) ||
      realpathSync(childArgv[0]!) !== childExecutable)
    throw new Error('Managed Codex child executable does not match the sealed helper native selection.');

  const originalArgs = parentArgv.slice(5);
  const invocation = managedCodexInvocation(originalArgs);
  if (invocation.kind === 'read') throw new Error('Read-only Codex invocation cannot register a managed writer.');
  let expectedKind: ManagedCodexProcessKind, expectedScope: string, expectedMediated: boolean;
  if (invocation.kind === 'proxy') {
    expectedKind = 'rawproxy'; expectedScope = '*'; expectedMediated = true;
    const childArgs = childArgv.slice(1);
    if (managedCodexInvocation(childArgs).kind !== 'proxy')
      throw new Error('Managed proxy child argv does not preserve the classified native proxy command.');
    const tail = childArgs.slice(invocation.proxyIndex + 1);
    const sockAt = tail.indexOf('--sock');
    const socketPath = sockAt >= 0 ? tail[sockAt + 1] : undefined;
    if (sockAt !== tail.length - 2 || !socketPath?.startsWith('/tmp/concierge-codex-proxy-') ||
        !socketPath.endsWith('/proxy.sock') || !source.ownsUnixListener(parentPid, socketPath))
      throw new Error('Managed proxy child is not connected through a helper-owned local Unix socket.');
    const normalized = originalArgs.slice();
    for (let i = invocation.proxyIndex + 1; i < normalized.length; i++) {
      if (normalized[i] === '--sock') { normalized.splice(i, 2); i--; }
      else if (normalized[i]!.startsWith('--sock=')) normalized.splice(i--, 1);
    }
    normalized.push('--sock', socketPath);
    if (JSON.stringify(childArgs) !== JSON.stringify(normalized))
      throw new Error('Managed proxy child argv differs from the source-classified invocation.');
  } else {
    expectedKind = registration.kind === 'tui' ? 'tui' : 'cli';
    expectedScope = invocation.threadId ?? '*'; expectedMediated = false;
    if (JSON.stringify(childArgv.slice(1)) !== JSON.stringify(originalArgs))
      throw new Error('Managed CLI child argv does not exactly match the sealed helper original arguments.');
  }
  if (registration.kind !== expectedKind || registration.threadScope !== expectedScope || registration.mediated !== expectedMediated)
    throw new Error('Managed Codex registration claims do not match the sealed helper argv classification.');
  const lineageEvidenceDigest = sha256(JSON.stringify({ pid, childStartTicks: identity.startTicks,
    childArgvDigest: sha256(JSON.stringify(childArgv)), parentPid, parentStartTicks: parentIdentity.startTicks,
    parentArgvDigest: sha256(JSON.stringify(parentArgv)), helperDigest }));
  return { identity, parentPid, parentStartTicks: parentIdentity.startTicks, helperArtifactDigest: helperDigest, lineageEvidenceDigest };
}

function sameRegistration(row: any, input: ManagedCodexProcessRegistration,
  proof: ReturnType<typeof verifyChildLineage>) {
  const identity = proof.identity;
  return row.connection_id === input.connectionId && row.permit_id === input.permitId &&
    row.intent_id === (input.intentId ?? null) && row.process_kind === input.kind &&
    row.thread_scope === input.threadScope && row.mediated === (input.mediated ? 1 : 0) &&
    row.pid === identity.pid && row.start_ticks === identity.startTicks &&
    row.executable_path === identity.executablePath && row.parent_pid === proof.parentPid &&
    row.parent_start_ticks === proof.parentStartTicks && row.helper_artifact_digest === proof.helperArtifactDigest &&
    row.lineage_evidence_digest === proof.lineageEvidenceDigest &&
    row.evidence_ids_json === JSON.stringify([...input.evidenceIds].sort());
}

/** Persist exact native child identity before the caller opens its forwarding path. */
export function registerManagedCodexChild(input: {
  db: Database;
  registration: ManagedCodexProcessRegistration;
  pid: number;
  nowMs: number;
  proc?: ProcSource;
  releaseRoot?: string;
}) {
  const { db, registration } = input;
  if (!registration.connectionId || !registration.permitId || !registration.threadScope ||
      !registration.evidenceIds.length || registration.evidenceIds.some(id => !id))
    throw new Error('Managed Codex process registration lacks stable evidence identity.');
  if (registration.kind === 'rawproxy' || registration.kind === 'desktop-proxy') {
    if (!registration.mediated || registration.threadScope !== '*')
      throw new Error('Managed proxy registration must be mediated and cover the wildcard scope.');
  } else {
    const exactThreadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(registration.threadScope);
    if (registration.mediated || !registration.lifetimeIntentConsumed || !registration.intentId ||
        (registration.threadScope !== '*' && !exactThreadId))
      throw new Error('Managed CLI/TUI registration requires a consumed lifetime intent and exact or wildcard scope.');
    const intent = db.query(`SELECT i.intent_id,i.permit_id,i.thread_id,i.method,i.state,p.state AS permit_state
      FROM codex_mutation_intents i JOIN codex_mutation_permits p ON p.permit_id=i.permit_id
      WHERE i.intent_id=?`).get(registration.intentId) as any;
    if (!intent || intent.permit_id !== registration.permitId || intent.thread_id !== registration.threadScope ||
        intent.method !== 'managed/cli-lifetime' || intent.state !== 'forwarding' || intent.permit_state !== 'consumed')
      throw new Error('Managed CLI/TUI lifetime intent is not durably consumed for this process scope.');
  }
  const proof = verifyChildLineage(registration, input.pid, input.proc ?? defaultProcSource, input.releaseRoot ?? defaultReleaseRoot);
  const identity = proof.identity;
  const prior = db.query(`SELECT * FROM codex_managed_process_registrations
    WHERE connection_id=? AND permit_id=?`).get(registration.connectionId, registration.permitId) as any;
  if (prior) {
    if (!sameRegistration(prior, registration, proof)) throw new Error('Managed Codex process registration identity conflicts with retained evidence.');
    return { registered: prior.state === 'active', duplicate: true, state: prior.state, ...identity };
  }
  db.query(`INSERT INTO codex_managed_process_registrations
    (connection_id,permit_id,intent_id,process_kind,thread_scope,mediated,pid,start_ticks,executable_path,
     parent_pid,parent_start_ticks,helper_artifact_digest,lineage_evidence_digest,evidence_ids_json,state,registered_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`).run(registration.connectionId, registration.permitId,
      registration.intentId ?? null, registration.kind, registration.threadScope, registration.mediated ? 1 : 0,
      identity.pid, identity.startTicks, identity.executablePath, proof.parentPid, proof.parentStartTicks,
      proof.helperArtifactDigest, proof.lineageEvidenceDigest, JSON.stringify([...registration.evidenceIds].sort()), input.nowMs);
  return { registered: true, duplicate: false, state: 'active' as const, ...identity };
}

/** Record only an exit observed from the exact child process handle; disappearance is not proof. */
export function observeManagedCodexChildExit(input: {
  db: Database;
  connectionId: string;
  permitId: string;
  pid: number;
  startTicks: string;
  exitCode: number | null;
  exitEvidenceDigest: string;
  nowMs: number;
}) {
  if (!/^[a-f0-9]{64}$/.test(input.exitEvidenceDigest)) throw new Error('Managed process exit requires a digest-only observation receipt.');
  return input.db.transaction(() => {
    const row = input.db.query(`SELECT * FROM codex_managed_process_registrations
      WHERE connection_id=? AND permit_id=?`).get(input.connectionId, input.permitId) as any;
    if (!row || row.pid !== input.pid || row.start_ticks !== input.startTicks)
      throw new Error('Managed process exit does not match the retained child identity.');
    if (row.state === 'observed_exit') {
      if (row.exit_code === input.exitCode && row.exit_evidence_digest === input.exitEvidenceDigest)
        return { observed: false, duplicate: true, state: 'observed_exit' as const };
      throw new Error('Conflicting managed process exit observation.');
    }
    input.db.query(`UPDATE codex_managed_process_registrations SET state='observed_exit',exit_observed_at_ms=?,
      exit_code=?,exit_evidence_digest=? WHERE connection_id=? AND permit_id=? AND state='active'`)
      .run(input.nowMs, input.exitCode, input.exitEvidenceDigest, input.connectionId, input.permitId);
    return { observed: true, duplicate: false, state: 'observed_exit' as const };
  }).immediate();
}

export type ManagedCodexWriterCoverage = {
  covered: boolean;
  blockers: Array<{ code: 'UNMEDIATED_NATIVE_WRITER' | 'NATIVE_WRITER_SCOPE_UNKNOWN'; pid?: number; detail: string }>;
  writers: Array<{ pid: number; startTicks: string; kind: string; threadScope: string; mediated: boolean }>;
};

/** Read-only process inventory. It neither kills nor contacts target Codex processes. */
export function assessManagedCodexWriterCoverage(input: {
  db: Database;
  threadId: string;
  socketPath: string;
  proc?: ProcSource;
}): ManagedCodexWriterCoverage {
  const source = input.proc ?? defaultProcSource;
  const blockers: ManagedCodexWriterCoverage['blockers'] = [];
  const writers: ManagedCodexWriterCoverage['writers'] = [];
  let pids: number[];
  let listeners: number[];
  try {
    pids = source.listPids();
    listeners = [...new Set(source.socketListeners(input.socketPath))];
  } catch {
    return { covered: false, blockers: [{ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', detail: 'Could not enumerate native process or listener scope.' }], writers };
  }
  if (listeners.length !== 1 || !pids.includes(listeners[0]!))
    return { covered: false, blockers: [{ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', detail: 'Expected exactly one enumerated native daemon listener for the selected control socket.' }], writers };
  try {
    const listenerIdentity = source.identity(listeners[0]!);
    if (!listenerIdentity || listenerIdentity.pid !== listeners[0] || !isCodexExecutable(listenerIdentity.executablePath))
      return { covered: false, blockers: [{ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', pid: listeners[0], detail: 'Control socket listener could not be verified as a native Codex daemon.' }], writers };
  } catch {
    return { covered: false, blockers: [{ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', pid: listeners[0], detail: 'Control socket listener process identity is unreadable.' }], writers };
  }
  const listenerSet = new Set(listeners);
  for (const pid of pids) {
    let identity: ProcessIdentity | null;
    try { identity = source.identity(pid); }
    catch {
      blockers.push({ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', pid, detail: 'Could not read process identity; native writer scope is unknown.' });
      continue;
    }
    if (identity && identity.pid !== pid) {
      blockers.push({ code: 'NATIVE_WRITER_SCOPE_UNKNOWN', pid, detail: 'Process identity did not match the enumerated PID.' });
      continue;
    }
    if (!identity || !isCodexExecutable(identity.executablePath) || listenerSet.has(pid)) continue;
    const row = input.db.query(`SELECT process_kind,thread_scope,mediated,state FROM codex_managed_process_registrations
      WHERE pid=? AND start_ticks=? AND executable_path=?`).get(identity.pid, identity.startTicks, identity.executablePath) as any;
    if (!row || row.state !== 'active') {
      blockers.push({ code: 'UNMEDIATED_NATIVE_WRITER', pid, detail: 'Native Codex process has no matching active managed registration.' });
      continue;
    }
    const inScope = row.thread_scope === '*' || input.threadId === '*' || row.thread_scope === input.threadId;
    if (inScope) writers.push({ pid, startTicks: identity.startTicks, kind: row.process_kind,
      threadScope: row.thread_scope, mediated: row.mediated === 1 });
  }
  return { covered: blockers.length === 0, blockers, writers };
}

