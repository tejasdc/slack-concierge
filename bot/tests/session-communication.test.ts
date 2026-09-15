import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SessionCommunicationCoordinator } from '../src/session-communication';
import { RoutedRequestCoordinator } from '../src/routed-requests';
import { acquireSessionTurn, claimSlackUserInput, createOrGetSession, createTurnSteeringMessage, db, finishTurn, markTurnSteeringMessageSending, markTurnSteeringMessageSent, upsertChannel, markTurnDelivering, markDeliveryChunkDelivered, markTurnResponseDelivered, finishDeliveredTurn } from '../src/state';
import { acquireDatabaseTestLock } from './db-lock';
import { startRoutedRequestApi } from '../src/routed-request-api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acknowledgeTurnProviderInput, claimNextQueuedTurn, markTurnSteeringMessageFailed, markTurnSteeringMessageAmbiguous, requestAgentStopForSession, releaseHeldRoutedInputClaim } from '../src/state';
import { TurnSteeringController } from '../src/steering';
let unlock: () => void;
let communication: SessionCommunicationCoordinator;
let routed: RoutedRequestCoordinator;
let source: any;
let recipient: any;
let now: number;
let clock: Map<number, () => void>;
let published: any[];
let admissions: any[];
let onAdmission: ((input: any) => void) | null;
let publicationGate: ((channel: string) => Promise<void>) | null;
let returnController: TurnSteeringController | null;
let acknowledgeInitial: boolean;
let ownerAlive: boolean;
const requester = { channel_id: 'C1', message_ts: '200.000001' };
function turn(channel: string, root: string, ts = root, content = 'Shared capture contract') {
    const session = createOrGetSession(channel, root, 'codex');
    db.query('UPDATE sessions SET agent_session_uuid=? WHERE id=?').run(`native-${session.id}`, session.id);
    const claim = claimSlackUserInput(channel, ts, `claim-${channel}-${ts}`, 'runtime', { userId: 'U1', userText: content, replyThreadTs: root });
    const value = acquireSessionTurn(session.id, ts, content, 'runtime', claim.row.claim_token, root, { userId: 'U1', projectionMode: 'agent' });
    return { session: session.id, turn: value.id, root, channel, ts };
}
function makeCoordinator(liveTargets = false) {
    return new SessionCommunicationCoordinator({ routed, now: () => now, isOwnerAlive: () => ownerAlive, onError: error => { throw error; },
        isLiveTarget: (session,channel,root) => liveTargets && !!db.query(`SELECT 1 FROM turns turn JOIN sessions session ON session.id=turn.session_id
          WHERE turn.session_id=? AND session.slack_channel_id=? AND turn.slack_reply_thread_ts=? AND turn.status='running'`).get(session,channel,root),
        arm: (work, delay) => { const key = now + delay; clock.set(key, work); return () => { clock.delete(key); }; } });
}
beforeEach(async () => {
    unlock = await acquireDatabaseTestLock();
    for (const table of ['session_communication_events', 'session_communication_requests', 'turn_dependencies', 'routed_requests', 'routed_input_events', 'deployment_drain',
        'comparison_requests', 'fork_requests', 'slack_thread_statuses', 'slack_user_input_claims', 'turn_steering_messages', 'turn_delivery_chunks', 'turns', 'sessions', 'channels'])
        db.query(`DELETE FROM ${table}`).run();
    for (const id of ['C1', 'C2', 'C3'])
        upsertChannel({ slack_channel_id: id, slack_channel_name: id.toLowerCase(), group_name: null, name: id, vault_path: '/tmp', code_path: '/tmp', provider_default: 'codex' });
    recipient = turn('C2', '100.000001');
    source = turn('C1', '200.000001');
    now = 1000;
    clock = new Map();
    published = [];
    admissions = [];
    onAdmission = null;
    publicationGate = null;
    returnController = null;
    acknowledgeInitial = true;
    ownerAlive = true;
    const messages = new Map<string, any>();
    let sequence = 0;
    routed = new RoutedRequestCoordinator({ instanceId: 'runtime', userToken: 'fixture', isOwnerAlive: () => false, onError: error => { throw error; }, onChanged: () => communication?.wake(),
        admissionHeld: id => communication?.admissionHeld(id) ?? false,
        publish: async (action, _request, _timing, options) => {
            await publicationGate?.(action.channel!);
            const ts = `300.${String(++sequence).padStart(6, '0')}`;
            const message = { ts, thread_ts: action.threadTs, user: 'U1', text: action.text };
            messages.set(ts, message);
            published.push({ channel: action.channel, ...message });
            options!.onProgress!({ delivery: 'confirmed', channel: action.channel!, ts, thread_ts: action.threadTs, file_ids: [] });
            return { channel: action.channel!, ts, thread_ts: action.threadTs!, file_ids: [], permalink: `https://slack.test/${ts}` };
        }, request: (async (input) => { const url = new URL(String(input)); const message = messages.get(url.searchParams.get('timestamp')!); return Response.json({ ok: true, channel: url.searchParams.get('channel'), message }); }) as typeof fetch,
        admit: async (input, routing) => {
            communication.assertAdmission(routing?.routedRequestId);
            const claim = claimSlackUserInput(input.channel, input.userMsgTs, `claim-${input.channel}-${input.userMsgTs}`, 'runtime', { userId: input.user, userText: input.text, replyThreadTs: input.threadTs });
            if (!claim.claimed)
                return;
            const session = createOrGetSession(input.channel, input.threadTs, 'codex');
            if (routing?.expectedSessionId !== undefined)
                expect(session.id).toBe(routing.expectedSessionId);
            const active = db.query("SELECT id FROM turns WHERE session_id=? AND status='running'").get(session.id) as any;
            if (active && !routing?.waitRequested) {
                const steering = createTurnSteeringMessage(active.id, input.userMsgTs, input.text, input.text, claim.row.claim_token, input.threadTs);
                if (input.channel === 'C1' && returnController) returnController.enqueue({clientMessageId:String(steering.row.id),text:input.text,
                    onSending:()=>markTurnSteeringMessageSending(steering.row.id), onSent:()=>markTurnSteeringMessageSent(steering.row.id),
                    onError:error=>markTurnSteeringMessageFailed(steering.row.id,error.message), onAmbiguous:error=>markTurnSteeringMessageAmbiguous(steering.row.id,error.message)});
                else { markTurnSteeringMessageSending(steering.row.id); markTurnSteeringMessageSent(steering.row.id); }
            }
            else {
                const accepted = acquireSessionTurn(session.id, input.userMsgTs, input.text, 'runtime', claim.row.claim_token, input.threadTs, { userId: input.user, projectionMode: 'agent', deferProvider:!!routing?.waitRequested, ...routing });
                if (accepted.acquired && acknowledgeInitial) acknowledgeTurnProviderInput(accepted.id,'runtime',accepted.dispatchAttempt,[]);
            }
            admissions.push(input);
            onAdmission?.(input);
        } });
    communication = makeCoordinator();
    communication.start();
    await communication.idle();
});
afterEach(async () => { await communication.stop(); await routed.stop(); unlock(); });
function address() { return communication.search({ source: requester, concepts: ['capture contract'] }).results.find(row => row.channel_id === 'C2')!.address!; }
function ask(action: string, extra: any = {}) { return communication.ask({ source: requester, action_id: action, address: address(), text: 'Confirm the capture contract', ...extra }); }
function reply(id: string, action: string, final = true) {
    const message = published.find(message => message.text.startsWith(`Session request ${id}`));
    return communication.reply({ source: { channel_id: message.channel, message_ts: message.ts }, action_id: action, request_id: id, text: `Answer for ${id}`, final });
}
test('search/context preserve exact branch evidence and reject an unknown source', () => {
    const found = communication.search({ source: requester, concepts: ['capture contract'] });
    expect(found.complete).toBeTrue();
    expect(found.corpus).toBe('routing_evidence');
    expect(found.results).toHaveLength(1);
    const context = communication.context({ source: requester, address: address() });
    expect(context.session_id).toBe(`concierge:${recipient.session}`);
    expect(context.fragments[0]!.source).toBe('turn_input');
    expect(() => communication.search({ source: { ...requester, message_ts: '999.000001' }, concepts: ['capture'] })).toThrow('accepted');
});
test('multiple live questions settle independently; a whole-turn final cannot answer the rest', async () => {
    const first = ask('first');
    const second = ask('second');
    expect(first.status).toBe('recorded');
    await communication.idle();
    expect(communication.get({ source: requester, request_id: first.request_id }).outcome).toBeNull();
    expect(db.query('SELECT input_kind,target_turn_id FROM session_communication_requests').all()).toEqual([{ input_kind: 'steering', target_turn_id: recipient.turn }, { input_kind: 'steering', target_turn_id: recipient.turn }]);
    reply(first.request_id, 'progress', false);
    reply(first.request_id, 'answer');
    await communication.idle();
    expect(communication.get({ source: requester, request_id: first.request_id }).outcome).toBe('answered');
    expect(communication.get({ source: requester, request_id: second.request_id }).outcome).toBeNull();
    finishTurn(recipient.turn, 'done', 'This general final does not answer every steered question.');
    await communication.idle();
    const remaining = communication.get({ source: requester, request_id: second.request_id });
    expect(remaining.outcome).toBe('unanswered');
    expect(remaining.result.text).toContain('without a confirmed answer');
    expect(remaining.result.output.turn_id).toBe(recipient.turn);
    expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 2 });
    expect(clock.size).toBe(0);
});
test('return obligations survive idle requester and service reconstruction without creating a reply loop', async () => {
    const question = ask('idle');
    await communication.idle();
    finishTurn(source.turn, 'done', 'Independent work finished.');
    await communication.idle();
    db.query("UPDATE sessions SET status='archived' WHERE id=?").run(source.session);
    reply(question.request_id, 'final');
    await communication.idle();
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(0);
    await communication.stop();
    communication = makeCoordinator();
    communication.start();
    await communication.idle();
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(0);
    db.query("UPDATE sessions SET status='active' WHERE id=?").run(source.session);
    communication.wake();
    await communication.idle();
    const returns = published.filter(message => message.channel === 'C1');
    expect(returns).toHaveLength(1);
    expect(returns[0].text).toContain('No acknowledgement or reciprocal question');
    expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM turns WHERE session_id=? AND status='running'").get(source.session)).toEqual({ n: 1 });
});
test('duplicate actions preserve immutable request/reply identity and a failed reply transaction leaves no settlement', async () => {
    const question = ask('duplicate');
    expect(ask('duplicate').request_id).toBe(question.request_id);
    expect(() => ask('duplicate', { text: 'Different' })).toThrow('conflict');
    await communication.idle();
    db.exec("CREATE TEMP TRIGGER reject_session_final BEFORE INSERT ON session_communication_events WHEN NEW.kind='final' BEGIN SELECT RAISE(ABORT,'injected persistence failure'); END");
    try {
        expect(() => reply(question.request_id, 'final')).toThrow('injected');
        expect(communication.get({ source: requester, request_id: question.request_id }).outcome).toBeNull();
    }
    finally {
        db.exec('DROP TRIGGER reject_session_final');
    }
    reply(question.request_id, 'final');
    reply(question.request_id, 'final');
    await communication.idle();
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(1);
    expect(() => reply(question.request_id, 'second-final')).toThrow('final disposition');
});
test('one durable overdue inspection re-arms after restart and does no recurring work afterward', async () => {
    const question = ask('deadline');
    await communication.idle();
    expect(clock.size).toBe(1);
    await communication.stop();
    expect(clock.size).toBe(0);
    communication = makeCoordinator();
    communication.start();
    await communication.idle();
    expect(clock.size).toBe(1);
    now += 30 * 60 * 1000;
    for (const work of [...clock.values()])
        work();
    await communication.idle();
    const request = communication.get({ source: requester, request_id: question.request_id });
    expect(request.events.filter(event => event.kind === 'overdue')).toHaveLength(1);
    expect(clock.size).toBe(0);
    communication.wake();
    await communication.idle();
    expect(communication.get({ source: requester, request_id: question.request_id }).events).toHaveLength(1);
    reply(question.request_id, 'late');
    await communication.idle();
    expect(communication.get({ source: requester, request_id: question.request_id }).outcome).toBe('answered');
    expect(clock.size).toBe(0);
});
for (const state of [
    { name: 'live owner', status: 'running', alive: true, owner: 'runtime', stopped: false, health: 'running under its existing owner' },
    { name: 'dead owner', status: 'running', alive: false, owner: 'runtime', stopped: false, health: 'native owner unavailable; exact recovery evidence is required' },
    { name: 'missing owner', status: 'running', alive: true, owner: null, stopped: false, health: 'native owner unavailable; exact recovery evidence is required' },
    { name: 'native Stop', status: 'running', alive: true, owner: 'runtime', stopped: true, health: 'deliberately stopped' },
    { name: 'queued execution', status: 'queued', alive: true, owner: null, stopped: false, health: 'queued' },
    { name: 'pending output delivery', status: 'delivering', alive: true, owner: 'runtime', stopped: false, health: 'delivering' },
]) {
    test(`overdue notice delivers exact ${state.name} evidence without replaying the request`, async () => {
        const question = ask('health');
        await communication.idle();
        ownerAlive = state.alive;
        db.query('UPDATE turns SET status=?,owner_instance_id=?,stop_requested_at=? WHERE id=?')
            .run(state.status, state.owner, state.stopped ? '2026-09-15 00:00:00' : null, recipient.turn);
        now += 30 * 60 * 1000;
        communication.inspectOverdue();
        communication.wake();
        await communication.idle();
        const request = communication.get({ source: requester, request_id: question.request_id });
        const notice = request.events.find(event => event.kind === 'overdue')!;
        const expectedText = `Request ${question.request_id} has no confirmed answer after 30 minutes. Recipient state: ${state.health}. The request remains recorded; no uncertain provider effect or deliberate Stop was replayed. Inspect the request and decide whether more work is needed.`;
        expect(notice).toMatchObject({ status: 'received', payload: { health: state.health, text: expectedText } });
        expect(published.filter(message => message.channel === 'C1')).toHaveLength(1);
        expect(admissions.find(input => input.channel === 'C1').text).toContain(expectedText);
        expect(published.filter(message => message.channel === 'C2')).toHaveLength(1);
        expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 2 });
        expect(request.outcome).toBeNull();
        expect(clock.size).toBe(0);
    });
}
test('an unpublished dependency wait reports waiting for admission to its requester', async () => {
    const prerequisite = ask('prior');
    const waiting = ask('later', { after: [prerequisite.request_id] });
    await communication.idle();
    now += 30 * 60 * 1000;
    communication.wake();
    await communication.idle();
    const request = communication.get({ source: requester, request_id: waiting.request_id });
    expect(request.target_turn_id).toBeNull();
    const expectedText = `Request ${waiting.request_id} has no confirmed answer after 30 minutes. Recipient state: waiting for admission. The request remains recorded; no uncertain provider effect or deliberate Stop was replayed. Inspect the request and decide whether more work is needed.`;
    expect(request.events[0]).toMatchObject({ status: 'received', payload: { health: 'waiting for admission', text: expectedText } });
    expect(admissions.find(input => input.channel === 'C1' && input.text.includes(waiting.request_id)).text)
        .toContain(expectedText);
    expect(published.filter(message => message.channel === 'C2')).toHaveLength(1);
    expect(clock.size).toBe(0);
});
test('a reply during admission finds the already-durable obligation and exact execution', async () => {
    onAdmission = input => {
        if (input.channel !== 'C2')
            return;
        const id = input.text.match(/^Session request ([a-f0-9-]+)/)[1];
        const recorded = db.query('SELECT due_at_ms,outcome FROM session_communication_requests WHERE request_id=?').get(id) as any;
        expect(recorded.due_at_ms).toBe(now + 30 * 60 * 1000);
        expect(recorded.outcome).toBeNull();
        reply(id, 'fast-answer');
    };
    const question = ask('fast');
    await communication.idle();
    const receipt = communication.get({ source: requester, request_id: question.request_id });
    expect(receipt.outcome).toBe('answered');
    expect(receipt.target_turn_id).toBe(recipient.turn);
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(1);
});
test('request prerequisites wait outside native FIFO so later communication can unblock them', async () => {
    turn('C3', '100.000002');
    const other = communication.search({ source: requester, concepts: ['capture'] }).results.find(row => row.channel_id === 'C3')!.address!;
    const prerequisite = ask('prerequisite', { address: other });
    const waiting = ask('waiting', { after: [prerequisite.request_id] });
    const incoming = ask('incoming');
    await communication.idle();
    expect(published.some(message => message.text.startsWith(`Session request ${waiting.request_id}`))).toBeFalse();
    expect(published.some(message => message.text.startsWith(`Session request ${incoming.request_id}`))).toBeTrue();
    reply(prerequisite.request_id, 'release');
    await communication.idle();
    expect(published.filter(message => message.text.startsWith(`Session request ${waiting.request_id}`))).toHaveLength(1);
    expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 3 });
});
test('a deliberately stopped requester retains returns until a later direct human input', async () => {
    const question = ask('stop');
    await communication.idle();
    db.query('UPDATE turns SET stop_requested_at=CURRENT_TIMESTAMP WHERE id=?').run(source.turn);
    finishTurn(source.turn, 'cancelled', null);
    reply(question.request_id, 'stopped-return');
    await communication.idle();
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(0);
    turn('C1', source.root, '400.000001', 'Continue the stopped session');
    communication.wake();
    await communication.idle();
    expect(published.filter(message => message.channel === 'C1')).toHaveLength(1);
});
test('a request cannot redirect to a different session when shared-session mode changes', async () => {
    const exact = address();
    const alternate = turn('C2', '150.000001');
    db.query("UPDATE channels SET session_mode='single-persistent',default_session_uuid=? WHERE slack_channel_id='C2'").run(`native-${alternate.session}`);
    expect(() => ask('stale', { address: exact })).toThrow('binding changed');
    expect(published).toHaveLength(0);
});
test('overdue intent and its return event roll back together on a storage failure', async () => {
    const question = ask('deadline-atomic');
    await communication.idle();
    now += 30 * 60 * 1000;
    db.exec("CREATE TEMP TRIGGER reject_overdue BEFORE INSERT ON session_communication_events WHEN NEW.kind='overdue' BEGIN SELECT RAISE(ABORT,'injected overdue failure'); END");
    try {
        expect(() => communication.inspectOverdue()).toThrow('injected overdue');
        expect(communication.get({ source: requester, request_id: question.request_id }).overdue_at_ms).toBeNull();
    }
    finally {
        db.exec('DROP TRIGGER reject_overdue');
    }
    communication.wake();
    await communication.idle();
    expect(communication.get({ source: requester, request_id: question.request_id }).events.filter(event => event.kind === 'overdue')).toHaveLength(1);
});
test('a slow destination publication does not block its overdue return to another channel', async () => {
    let release!: () => void;
    let entered!: () => void;
    let returned!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const notification = new Promise<void>(resolve => { returned = resolve; });
    publicationGate = async (channel) => { if (channel === 'C2') {
        entered();
        await held;
    } };
    onAdmission = input => { if (input.channel === 'C1' && input.text.startsWith('Session overdue'))
        returned(); };
    const question = ask('slow');
    try {
        await started;
        now += 30 * 60 * 1000;
        for (const work of [...clock.values()])
            work();
        await notification;
        const events = communication.get({ source: requester, request_id: question.request_id }).events.filter(event => event.kind === 'overdue');
        expect(events).toHaveLength(1);
        const expectedText = `Request ${question.request_id} has no confirmed answer after 30 minutes. Recipient state: publishing. The request remains recorded; no uncertain provider effect or deliberate Stop was replayed. Inspect the request and decide whether more work is needed.`;
        expect(events[0].payload).toMatchObject({ health: 'publishing', text: expectedText });
        expect(admissions.find(input => input.channel === 'C1').text).toContain(expectedText);
        expect(published.filter(message => message.channel === 'C2')).toHaveLength(0);
    }
    finally {
        release();
        await communication.idle();
    }
});
for (const mode of ['received question', 'received answer']) {
    test(`ten successive asks from each ${mode} remain callable without reciprocal obligations`, async () => {
        let input = requester;
        const questions: string[] = [];
        for (let index = 0; index < 10; index++) {
            const targetChannel = input.channel_id === 'C1' ? 'C2' : 'C1';
            const target = communication.search({ source: input, concepts: ['capture contract'] }).results.find(row => row.channel_id === targetChannel)!.address!;
            const question = communication.ask({ source: input, action_id: `chain-${index}`, address: target, text: `Follow-up ${index}` });
            questions.push(question.request_id);
            await communication.idle();
            const received = published.find(message => message.text.startsWith(`Session request ${question.request_id}`));
            expect(received.channel).toBe(targetChannel);
            if (mode === 'received answer') {
                reply(question.request_id, `answer-${index}`);
                await communication.idle();
                const returned = communication.get({ source: input, request_id: question.request_id }).events[0];
                expect(returned.status).toBe('received');
                const event = published.find(message => message.text.startsWith(`Session final event ${returned.event_id}`));
                input = { channel_id: event.channel, message_ts: event.ts };
            } else input = { channel_id: received.channel, message_ts: received.ts };
        }
        if (mode === 'received question') {
            for (const id of questions) reply(id, `answer-${id}`);
            await communication.idle();
        }
        expect(db.query('SELECT count(*) AS n FROM session_communication_requests').get()).toEqual({ n: 10 });
        expect(db.query("SELECT count(*) AS n FROM session_communication_requests WHERE outcome='answered'").get()).toEqual({ n: 10 });
        expect(db.query("SELECT count(*) AS n FROM session_communication_events WHERE kind='final' AND status='received'").get()).toEqual({ n: 10 });
        expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({ n: 2 });
        expect(published).toHaveLength(20);
        expect(clock.size).toBe(0);
    }, 20_000);
}
test('only the addressed execution can answer; failed prerequisites never admit the dependent question', async () => {
    const question = ask('failure');
    const waiting = ask('blocked', { after: [question.request_id] });
    await communication.idle();
    expect(() => communication.reply({ source: requester, action_id: 'wrong-sender', request_id: question.request_id, text: 'Forged answer', final: true })).toThrow('exact recipient');
    const later = turn('C2', recipient.root, '400.000001');
    expect(() => communication.reply({ source: { channel_id: 'C2', message_ts: later.ts }, action_id: 'wrong-execution', request_id: question.request_id, text: 'Different execution', final: true })).toThrow('addressed execution');
    finishTurn(recipient.turn, 'error', 'Recipient failed');
    await communication.idle();
    expect(communication.get({ source: requester, request_id: question.request_id }).outcome).toBe('failed');
    expect(communication.get({ source: requester, request_id: waiting.request_id }).outcome).toBe('dependency_failed');
    expect(published.some(message => message.text.startsWith(`Session request ${waiting.request_id}`))).toBeFalse();
});
test('a dedicated unsteered question can return its exact final output automatically', async () => {
    finishTurn(recipient.turn, 'done', 'Previous work');
    await communication.idle();
    const question = ask('dedicated');
    await communication.idle();
    const target = communication.get({ source: requester, request_id: question.request_id }).target_turn_id!;
    expect(target).not.toBe(recipient.turn);
    finishTurn(target, 'done', 'The contract is accepted.');
    await communication.idle();
    const receipt = communication.get({ source: requester, request_id: question.request_id });
    expect(receipt.outcome).toBe('answered');
    expect(receipt.result.text).toBe('The contract is accepted.');
    expect(receipt.result.output.turn_id).toBe(target);
});
test('ambiguous publication retains one routed identity across wake and restart', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    publicationGate = async (channel) => { if (channel === 'C2') {
        entered();
        await held;
    } };
    const question = ask('ambiguous');
    await started;
    const bound = db.query('SELECT request_id FROM routed_requests WHERE action_id=?').get(`session-ask-${question.request_id}`) as any;
    release();
    await communication.idle();
    db.query("UPDATE routed_requests SET status='ambiguous',turn_id=NULL,message_ts=NULL,error='unknown publication' WHERE request_id=?").run(bound.request_id);
    const count = published.length;
    communication.wake();
    await communication.idle();
    await communication.stop();
    communication = makeCoordinator();
    communication.start();
    await communication.idle();
    const receipt = communication.get({ source: requester, request_id: question.request_id });
    expect(receipt.routed_request_id).toBe(bound.request_id);
    expect(receipt.status).toBe('ambiguous');
    expect(receipt.outcome).toBeNull();
    expect(published).toHaveLength(count);
});
test('private session routes preserve recorded acceptance and exact error responses', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'session-api-'));
    const server = startRoutedRequestApi(directory, routed, undefined, communication);
    const post = (operation: string, input: unknown) => fetch(`http://localhost/session-communication/${operation}`, { unix: join(directory, 'requests.sock'), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    try {
        const found = await post('search', { source: requester, concepts: ['capture'] });
        expect(found.status).toBe(200);
        expect((await found.json()).results[0].address).toBe(address());
        const accepted = await post('ask', { source: requester, action_id: 'api-ask', address: address(), text: 'Confirm' });
        expect(accepted.status).toBe(202);
        const receipt = await accepted.json();
        expect(receipt.request_id).toBeString();
        const read = await post('get', { source: requester, request_id: receipt.request_id });
        expect((await read.json()).request_id).toBe(receipt.request_id);
        const rejected = await post('reply', { source: requester, action_id: 'invalid', request_id: receipt.request_id, text: 'Wrong actor', final: true });
        expect(rejected.status).toBe(400);
        expect((await rejected.json()).error).toContain('exact recipient');
    }
    finally {
        await server.stop(true);
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a submit error after durable admission cannot erase the return obligation', async () => {
    await communication.stop();
    communication = new SessionCommunicationCoordinator({
        routed: {
            submit: async input => {
                await routed.submit(input);
                throw new Error('An unrelated queued input failed during channel flush');
            },
            result: id => routed.result(id),
            recoverRequest: id => routed.recoverRequest(id),
            recoverUnsentReturn: id => routed.recoverUnsentReturn(id),
        },
        now: () => now,
        isOwnerAlive: () => true,
        onError: error => { throw error; },
        arm: () => () => {},
    });
    communication.start();
    const question = ask('post-admission-error');
    await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).outcome).toBeNull();
    expect(published.filter(message=>message.channel==='C2')).toHaveLength(1);
    reply(question.request_id,'answer-after-error');
    await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).outcome).toBe('answered');
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(1);
});

test('unanswered output uses confirmed response chunks instead of a legacy status timestamp', async () => {
    const question=ask('delivered-output');
    await communication.idle();
    db.query('UPDATE turns SET slack_bot_msg_ts=? WHERE id=?').run('400.000000',recipient.turn);
    expect(markTurnDelivering(recipient.turn,'General final','Slack presentation',2,'General final')).toBeTrue();
    markDeliveryChunkDelivered(recipient.turn,0,'400.000001');
    markDeliveryChunkDelivered(recipient.turn,1,'400.000002');
    markTurnResponseDelivered(recipient.turn);
    expect(finishDeliveredTurn(recipient.turn)).toBeTrue();
    await communication.idle();
    const receipt=communication.get({source:requester,request_id:question.request_id});
    expect(receipt.outcome).toBe('unanswered');
    expect(receipt.result.output.message_ts).toBe('400.000001');
    expect(receipt.result.output.messages).toEqual([{chunk_index:0,slack_ts:'400.000001'},{chunk_index:1,slack_ts:'400.000002'}]);
    expect(receipt.result.output.delivery_status).toBe('delivered');
});

test('first-turn live steering is messageable before UUID persistence; idle sessions still need a native binding', async () => {
    await communication.stop();
    db.query('UPDATE sessions SET agent_session_uuid=NULL').run();
    communication=makeCoordinator(true);
    communication.start();
    const target=communication.search({source:requester,concepts:['capture']}).results[0]!;
    expect(target.resumable).toBeFalse();expect(target.messageable).toBeTrue();
    const question=ask('first-turn');await communication.idle();
    reply(question.request_id,'first-turn-answer');await communication.idle();
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(1);
    expect(communication.get({source:requester,request_id:question.request_id}).outcome).toBe('answered');
    expect(db.query('SELECT count(*) AS n FROM turns').get()).toEqual({n:2});
    finishTurn(recipient.turn,'done','Ended without a persisted native binding');await communication.idle();
    expect(communication.search({source:requester,concepts:['capture']}).results[0]!.messageable).toBeFalse();
    expect(()=>ask('not-idle-resumable')).toThrow('not currently messageable');
});

test('an unsent return remains tracked and moves once into the native queue without republishing', async () => {
    returnController = new TurnSteeringController();
    const question = ask('unsent-return');
    await communication.idle();
    reply(question.request_id,'final');
    await communication.idle();
    const event = communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(event.status).toBe('admitted');
    returnController.close();
    await Promise.resolve();
    await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).events[0]!.status).toBe('failed');
    await communication.stop();
    communication = makeCoordinator(); communication.start();
    finishTurn(source.turn,'done','Independent requester work ended');
    await communication.idle();
    const recovered = communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(recovered.event_id).toBe(event.event_id);
    expect(recovered.routed_request_id).toBe(event.routed_request_id);
    expect(recovered.status).toBe('admitted');
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(1);
    const next = claimNextQueuedTurn('runtime')!;
    expect(next.session_id).toBe(source.session);
    acknowledgeTurnProviderInput(next.turn_id,'runtime',next.dispatch_attempt,[]);
    await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).events[0]!.status).toBe('received');
    expect(claimNextQueuedTurn('runtime')).toBeNull();
});

test('an ambiguous return is never replayed and a late native acknowledgement upgrades the same event', async () => {
    returnController = new TurnSteeringController();
    let acknowledge!:()=>void;
    let started!:()=>void;
    const sending = new Promise<void>(resolve=>started=resolve);
    returnController.registerSender(()=>{started();return new Promise<void>(resolve=>acknowledge=resolve);});
    const question=ask('ambiguous-return'); await communication.idle(); reply(question.request_id,'final');
    await sending; returnController.close(); await Promise.resolve(); await communication.idle();
    const event=communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(event.status).toBe('ambiguous');
    await communication.stop(); communication=makeCoordinator();communication.start();await communication.idle();
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(1);
    expect(communication.get({source:requester,request_id:question.request_id}).events[0]!.status).toBe('ambiguous');
    acknowledge(); await Promise.resolve();await Promise.resolve();await communication.idle();
    const received=communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(received.event_id).toBe(event.event_id); expect(received.status).toBe('received');
});

test('Stop during return publication holds the exact input without blocking a later human continuation', async () => {
    const question=ask('publication-stop');await communication.idle();
    let release!:()=>void;let publishing!:()=>void;
    const started=new Promise<void>(resolve=>publishing=resolve);
    publicationGate=async channel=>{if(channel==='C1'){publishing();await new Promise<void>(resolve=>release=resolve);}};
    reply(question.request_id,'final');await started;
    db.query("UPDATE turns SET progress_stream_ts='200.100000' WHERE id=?").run(source.turn);
    expect(requestAgentStopForSession({turnId:source.turn,channel:'C1',threadTs:source.root,eventTs:'250.000001'})).toBeTrue();
    finishTurn(source.turn,'cancelled','User stopped');release();await communication.idle();
    const event=communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(event.status).toBe('held');expect(claimNextQueuedTurn('runtime')).toBeNull();
    const returned=published.find(message=>message.channel==='C1');
    await routed.receive({channel:'C1',threadTs:source.root,userMsgTs:returned.ts,user:'U1',text:returned.text,clientMessageId:event.routed_request_id!});
    expect(claimNextQueuedTurn('runtime')).toBeNull();
    await communication.stop();communication=makeCoordinator();communication.start();await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).events[0]!.status).toBe('held');
    await routed.receive({channel:'C1',threadTs:source.root,userMsgTs:'400.000001',user:'U1',text:'Continue my session'});
    await communication.idle();
    const received=communication.get({source:requester,request_id:question.request_id}).events[0]!;
    expect(received.event_id).toBe(event.event_id);expect(received.routed_request_id).toBe(event.routed_request_id);expect(received.status).toBe('received');
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(1);
});

test('a held native admission releases only its own unclassified input claim', async () => {
    const question=ask('held-claim');await communication.idle();
    const row=db.query('SELECT * FROM routed_requests WHERE request_id=?').get(communication.get({source:requester,request_id:question.request_id}).routed_request_id!) as any;
    const other=claimSlackUserInput('C2','999.000001','other-token','runtime',{userId:'U1',userText:'human',replyThreadTs:recipient.root});
    releaseHeldRoutedInputClaim(row.request_id,other.row.claim_token);
    expect(db.query("SELECT kind FROM slack_user_input_claims WHERE slack_user_msg_ts='999.000001'").get()).toEqual({kind:'pending'});
    releaseHeldRoutedInputClaim(row.request_id,`claim-C2-${row.message_ts}`);
    expect(db.query('SELECT kind FROM slack_user_input_claims WHERE slack_user_msg_ts=?').get(row.message_ts)).toEqual({kind:'steering'});
    const pending={...row,request_id:'held-pending-intent',action_id:'held-pending',message_ts:'999.000001',status:'confirmed',turn_id:null};
    db.query(`INSERT INTO routed_requests(${Object.keys(pending).join(',')}) VALUES(${Object.keys(pending).map(()=>'?').join(',')})`).run(...Object.values(pending) as any[]);
    releaseHeldRoutedInputClaim(pending.request_id,other.row.claim_token);
    expect(db.query("SELECT kind FROM slack_user_input_claims WHERE slack_user_msg_ts='999.000001'").get()).toBeNull();
});

test('human work accepted before Stop cannot release a later return', async () => {
    const question=ask('before-stop-human');await communication.idle();
    const human=claimSlackUserInput('C1','210.000001','before-stop-human','runtime',{userId:'U1',userText:'Earlier queued work',replyThreadTs:source.root});
    const queued=acquireSessionTurn(source.session,'210.000001','Earlier queued work','runtime',human.row.claim_token,source.root,{userId:'U1',deferProvider:true});
    expect(queued.queued).toBeTrue();
    db.query("UPDATE turns SET progress_stream_ts='200.100000' WHERE id=?").run(source.turn);
    expect(requestAgentStopForSession({turnId:source.turn,channel:'C1',threadTs:source.root,eventTs:'250.000001'})).toBeTrue();
    reply(question.request_id,'final');await communication.idle();
    expect(communication.get({source:requester,request_id:question.request_id}).events[0]!.status).toBe('held');
    expect(published.filter(message=>message.channel==='C1')).toHaveLength(0);
});
