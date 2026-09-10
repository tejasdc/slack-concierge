import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutedRequestCoordinator, lookupExecutions, type RoutedRequest, type RoutedInput, type RoutedAdmission } from '../src/routed-requests';
import { acquireSessionTurn, claimSlackUserInput, claimNextQueuedTurn, createOrGetSession, db, finishTurn,
  getTurnDependencies, getTurnReactionCleanup, requestTurnWaitingReaction, upsertChannel } from '../src/state';
import { scheduleTurnReactionCleanup } from '../src/turn-reaction-cleanup';
import { acquireDatabaseTestLock } from './db-lock';
import { slackBucket } from '../src/rate-limit';

let unlock: () => void;
let source: number;
let a: number;
let b: number;
beforeEach(async () => {
  unlock = await acquireDatabaseTestLock();
  slackBucket.reset();
  for (const table of ['turn_dependencies', 'routed_requests', 'routed_input_events', 'deployment_drain',
    'comparison_requests', 'fork_requests', 'slack_thread_statuses', 'slack_user_input_claims',
    'turn_steering_messages', 'turn_delivery_chunks', 'turns', 'sessions', 'channels']) db.query(`DELETE FROM ${table}`).run();
  expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 0 });
  for (const id of ['C1','C2','C3']) upsertChannel({ slack_channel_id: id, slack_channel_name: id.toLowerCase(),
    group_name: null, name: id, vault_path: '/tmp', code_path: '/tmp', provider_default: 'codex' });
  a = turn('C1', '100.000001');
  b = turn('C2', '100.000002');
  source = turn('C3', '200.000001');
});
afterEach(() => {
  for (const table of ['turn_dependencies', 'routed_requests', 'routed_input_events']) db.query(`DELETE FROM ${table}`).run();
  unlock();
});

function turn(channel: string, ts: string, metadata: any = {}, root = ts) {
  const session = createOrGetSession(channel, root, 'codex');
  const claim = claimSlackUserInput(channel, ts, `claim-${ts}`, 'runtime', { userId: 'U1', userText: 'request', replyThreadTs: root });
  const acquired = acquireSessionTurn(session.id, ts, 'request', 'runtime', claim.row.claim_token, root,
    { userId: 'U1', projectionMode: 'agent', ...metadata });
  expect(acquired.duplicate).toBeFalse();
  return acquired.id;
}
function request(overrides: Partial<RoutedRequest> = {}): RoutedRequest {
  return { source: { channel_id: 'C3', message_ts: '200.000001' }, action_id: 'primary',
    destination: { channel_id: 'C3' }, task: 'do this later', defer: true,
    depends_on: [{ turn_id: a, channel_id: 'C1', root_ts: '100.000001' }, { turn_id: b, channel_id: 'C2', root_ts: '100.000002' }], ...overrides };
}

test('exact cross-channel dependencies gate admission and promotion without later-session work extending them', () => {
  const c = turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [a,b] });
  expect(db.query('SELECT status FROM turns WHERE id=?').get(c)).toEqual({ status: 'queued' });
  expect(claimNextQueuedTurn('new')).toBeNull();
  finishTurn(a, 'done', 'A completed');
  turn('C1', '400.000001', {}, '100.000001');
  expect(claimNextQueuedTurn('new')).toBeNull();
  finishTurn(b, 'error', 'B failed');
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(c);
  expect(getTurnDependencies(c).map((dep: any) => dep.outcome)).toEqual(['done','error']);
  db.query("UPDATE turns SET status='running' WHERE id=?").run(a);
  expect(getTurnDependencies(c).every((dep: any) => dep.satisfied_at)).toBeTrue();
});

test('destination FIFO remains separate from explicit dependencies, including an empty deferral', () => {
  const c = turn('C3', '300.000001', { waitRequested: true }, '200.000001');
  const d = turn('C3', '300.000002', {}, '200.000001');
  expect(claimNextQueuedTurn('new')).toBeNull();
  finishTurn(source, 'done', 'done');
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(c);
  expect(claimNextQueuedTurn('new')).toBeNull();
  finishTurn(c, 'done', 'done');
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(d);
});

test('parked/retrying provider work blocks; a terminal outcome with parked delivery satisfies ordering', () => {
  const c = turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [a] });
  for (const status of ['parked','queued','running','delivering','interrupted']) {
    db.query('UPDATE turns SET status=? WHERE id=?').run(status, a);
    if (status === 'queued') db.query('UPDATE turns SET dispatch_next_attempt_ms=? WHERE id=?').run(Date.now()+60000, a);
    expect(getTurnDependencies(c)[0]).toMatchObject({ satisfied_at: null });
  }
  db.query("UPDATE turns SET status='delivery_parked', delivery_status='parked' WHERE id=?").run(a);
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(c);
});

test('invalid dependencies roll back the entire admission', () => {
  expect(() => turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [99999999] })).toThrow();
  expect(db.query("SELECT 1 FROM turns WHERE slack_user_msg_ts='300.000001'").get()).toBeNull();
});

function harness(publish?: any, instanceId = 'runtime', failLookup = false) {
  const admissions: Array<{ input: RoutedInput; routing?: RoutedAdmission }> = [];
  let publications = 0;
  const coordinator = new RoutedRequestCoordinator({ instanceId, userToken: 'user-token', isOwnerAlive: () => false,
    request: (async () => {
      if (failLookup) throw new Error('Interrupted before input lookup');
      return Response.json({ ok: true, channel: 'C3', message: { ts: '300.000001', user: 'U1', text: 'do this later' } });
    }) as typeof fetch,
    publish: publish || (async (_action: any, _fetch: any, _timing: any, options: any) => {
      publications++;
      options.onProgress({ delivery: 'unknown', channel: 'C3', thread_ts: null, file_ids: [] });
      options.onProgress({ delivery: 'confirmed', channel: 'C3', ts: '300.000001', thread_ts: null, file_ids: [] });
      return { channel: 'C3', ts: '300.000001', thread_ts: null, file_ids: [], permalink: 'https://slack.test/message' };
    }), onError: () => {},
    admit: async (input, routing) => {
      admissions.push({ input, routing });
      const claim = claimSlackUserInput(input.channel, input.userMsgTs, `claim-${input.userMsgTs}`, 'runtime', {
        userId: input.user, userText: input.text, files: input.files, replyThreadTs: input.threadTs });
      if (!claim.claimed) return;
      const session = createOrGetSession(input.channel, input.threadTs, 'codex');
      if (routing) expect(db.query('SELECT request_id, channel_id, message_ts, turn_id FROM routed_requests WHERE request_id=?').get(routing.routedRequestId))
        .toEqual({ request_id: routing.routedRequestId, channel_id: input.channel, message_ts: input.userMsgTs, turn_id: null });
      acquireSessionTurn(session.id, input.userMsgTs, input.text, 'runtime', claim.row.claim_token, input.threadTs,
        { userId: input.user, projectionMode: 'agent', deferProvider: true, ...routing });
    } });
  return { coordinator, admissions, publications: () => publications };
}

test('receipt alone admits once; duplicate API requests and late Slack echoes retain the original turn/dependencies', async () => {
  const { coordinator, publications } = harness();
  const result = await coordinator.submit(request());
  expect(result.error).toBeNull();
  expect(result.status).toBe('admitted');
  expect(result.turn_id).toBeNumber();
  expect(getTurnDependencies(result.turn_id!)).toHaveLength(2);
  await coordinator.receive({ channel: 'C3', userMsgTs: '300.000001', threadTs: '300.000001', user: 'U1', text: 'do this later' });
  expect((await coordinator.submit(request())).turn_id).toBe(result.turn_id);
  expect(publications()).toBe(1);
  expect(claimNextQueuedTurn('new')).toBeNull();
  expect(db.query("SELECT count(*) AS n FROM turns WHERE slack_user_msg_ts='300.000001'").get()).toEqual({ n: 1 });
});

test('early echo and human reply persist behind publication; intake continues after admission while dependencies still run', async () => {
  let release!: () => void;
  let started!: () => void;
  const publishing = new Promise<void>(resolve => { started = resolve; });
  const pause = new Promise<void>(resolve => { release = resolve; });
  const { coordinator, admissions } = harness(async (_a: any,_b: any,_c: any, options: any) => {
    options.onProgress({ delivery: 'unknown', channel: 'C3', thread_ts: null, file_ids: [] });
    started(); await pause;
    return { channel: 'C3', ts: '300.000001', thread_ts: null, file_ids: [], permalink: 'https://slack.test/message' };
  });
  const submission = coordinator.submit(request());
  await publishing;
  const echo = coordinator.receive({ channel: 'C3', userMsgTs: '300.000001', threadTs: '300.000001', user: 'U1', text: 'do this later' });
  const reply = coordinator.receive({ channel: 'C3', userMsgTs: '301.000001', threadTs: '300.000001', user: 'U1', text: 'extra context' });
  expect(admissions).toHaveLength(0);
  expect(db.query('SELECT count(*) AS n FROM routed_input_events').get()).toEqual({ n: 2 });
  release(); await Promise.all([submission,echo,reply]);
  expect(admissions.map(x => x.input.userMsgTs)).toEqual(['300.000001','300.000001','301.000001']);
  expect(claimNextQueuedTurn('new')).toBeNull();
  expect(db.query('SELECT count(*) AS n FROM routed_input_events').get()).toEqual({ n: 0 });
});

test('ambiguous text publication remains parked after restart and excludes its echo from ordinary admission', async () => {
  const { coordinator } = harness(async (_a: any,_b: any,_c: any, options: any) => {
    options.onProgress({ delivery: 'unknown', channel: 'C3', thread_ts: null, file_ids: [] });
    throw new Error('lost response');
  });
  const result = await coordinator.submit(request());
  expect(result.status).toBe('parked');
  await coordinator.receive({ channel: 'C3', userMsgTs: '300.000001', threadTs: '300.000001', user: 'U1', text: 'do this later' });
  const replacement = harness();
  await replacement.coordinator.recover();
  expect(replacement.admissions).toHaveLength(0);
  expect(replacement.publications()).toBe(0);
  expect(lookupExecutions({ channel: 'C3', beforeTs: '400.000001' }).complete).toBeFalse();
});

test('source/action conflicts and mismatched dependencies are rejected before publication', async () => {
  const { coordinator, publications } = harness();
  await expect(coordinator.submit(request({ depends_on: [{ turn_id: a, channel_id: 'C2', root_ts: '100.000001' }] }))).rejects.toThrow('identity');
  expect(publications()).toBe(0);
  await coordinator.submit(request());
  await expect(coordinator.submit(request({ task: 'different task' }))).rejects.toThrow('Idempotency conflict');
  expect(publications()).toBe(1);
});

test('late waiting reaction cannot overwrite activation cleanup', async () => {
  const c = turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [a] });
  const reactions: string[] = [];
  const client = { reactions: { add: async () => { reactions.push('add'); requestTurnWaitingReaction(c, false); },
    remove: async () => { reactions.push('remove'); } } };
  expect(await scheduleTurnReactionCleanup(client, c)).toBe('delivered');
  expect(reactions).toEqual(['add','remove']);
  expect(getTurnReactionCleanup(c)).toMatchObject({ desired_present: 0, cleanup_status: 'delivered' });
});

test('failure of an obsolete waiting reaction cannot park activation cleanup', async () => {
  const c = turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [a] });
  const reactions: string[] = [];
  const client = { reactions: { add: async () => {
    reactions.push('add'); requestTurnWaitingReaction(c, false);
    throw Object.assign(new Error('invalid_name'), { data: { error: 'invalid_name' } });
  }, remove: async () => { reactions.push('remove'); } } };
  expect(await scheduleTurnReactionCleanup(client, c)).toBe('delivered');
  expect(reactions).toEqual(['add', 'remove']);
  expect(getTurnReactionCleanup(c)).toMatchObject({ desired_present: 0, cleanup_status: 'delivered' });
});

test('exact marker recovers a lost text receipt when its delayed Slack echo arrives', async () => {
  const first = harness(async (_a: any, _b: any, _c: any, options: any) => {
    options.onProgress({ delivery: 'unknown', channel: 'C3', thread_ts: null, file_ids: [] });
    throw new Error('Lost text receipt');
  });
  const accepted = await first.coordinator.submit(request());
  expect(accepted.status).toBe('parked');
  const calls: string[] = [];
  const replacement = harness(async (action: any) => {
    calls.push(action.verb);
    return { channel: 'C3', ts: '300.000001', thread_ts: null, file_ids: [], permalink: 'https://slack.test/message' };
  }, 'new');
  await replacement.coordinator.receive({ channel: 'C3', userMsgTs: '300.000001', threadTs: '300.000001',
    user: 'U1', text: 'do this later', clientMessageId: accepted.request_id });
  expect(calls).toEqual(['permalink']);
  expect(replacement.coordinator.result(accepted.request_id).status).toBe('admitted');
  expect(getTurnDependencies(replacement.coordinator.result(accepted.request_id).turn_id!)).toHaveLength(2);
});

test('lookup distinguishes complete empty work, exact completed references, and the triggering cutoff', () => {
  finishTurn(a, 'done', 'complete');
  expect(lookupExecutions({ channel: 'C1', beforeTs: '200.000001' })).toMatchObject({ complete: true, executions: [] });
  expect(lookupExecutions({ channel: 'C1', beforeTs: '200.000001', turnId: a }).executions).toHaveLength(1);
  expect(lookupExecutions({ channel: 'C2', beforeTs: '100.000002' }).executions).toHaveLength(0);
  expect(lookupExecutions({ channel: 'C2', beforeTs: '100.000003' }).executions).toHaveLength(1);
});

test('confirmed receipt recovery admits without replaying publication or requiring a Slack echo', async () => {
  const first = harness(undefined, 'old', true);
  const accepted = await first.coordinator.submit(request());
  expect(accepted.status).toBe('parked');
  expect(accepted.turn_id).toBeNull();
  expect(first.publications()).toBe(1);
  const replacement = harness(undefined, 'new');
  await replacement.coordinator.recover();
  const recovered = replacement.coordinator.result(accepted.request_id);
  expect(recovered.status).toBe('admitted');
  expect(replacement.publications()).toBe(0);
  expect(getTurnDependencies(recovered.turn_id!)).toHaveLength(2);
  expect(claimNextQueuedTurn('new')).toBeNull();
});

test('accepted attachment bytes survive caller cleanup until exact receipt admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'routed-file-'));
  const path = join(directory, 'capture.m4a');
  writeFileSync(path, 'captured audio bytes');
  try {
    const first = harness(undefined, 'old', true);
    const accepted = await first.coordinator.submit(request({ files: [path] }));
    expect(accepted.status).toBe('parked');
    rmSync(path);
    const saved = db.query('SELECT bytes FROM routed_request_files WHERE request_id=?').get(accepted.request_id) as { bytes: Uint8Array };
    expect(Buffer.from(saved.bytes).toString()).toBe('captured audio bytes');
    const replacement = harness(undefined, 'new');
    await replacement.coordinator.recover();
    expect(replacement.coordinator.result(accepted.request_id).status).toBe('admitted');
    expect(replacement.publications()).toBe(0);
    expect(db.query('SELECT 1 FROM routed_request_files WHERE request_id=?').get(accepted.request_id)).toBeNull();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a crash after turn attachment recovers the same admission instead of creating a second turn', async () => {
  const first = harness(undefined, 'old');
  const accepted = await first.coordinator.submit(request());
  db.query("UPDATE routed_requests SET status='confirmed' WHERE request_id=?").run(accepted.request_id);
  const replacement = harness(undefined, 'new');
  await replacement.coordinator.recover();
  expect(replacement.coordinator.result(accepted.request_id).turn_id).toBe(accepted.turn_id);
  expect(replacement.publications()).toBe(0);
  expect(db.query("SELECT count(*) AS n FROM turns WHERE slack_user_msg_ts='300.000001'").get()).toEqual({ n: 1 });
});

test('dependency chains release only after each actual execution finishes', () => {
  const c = turn('C3', '300.000001', { waitRequested: true, dependencyTurnIds: [a] });
  const d = turn('C2', '300.000002', { waitRequested: true, dependencyTurnIds: [c] });
  finishTurn(a, 'cancelled', 'cancelled');
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(c);
  expect(claimNextQueuedTurn('new')).toBeNull();
  finishTurn(c, 'done', 'completed');
  expect(claimNextQueuedTurn('new')?.turn_id).toBe(d);
});
