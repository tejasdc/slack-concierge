import { createHash, randomUUID } from 'node:crypto';
import { db, getChannel, getSessionById, getSlackUserInputClaim, observeExecutionChanges, SETTLED_EXECUTION_SQL } from './state';
import { getRouterThreadContext, searchRouterThreads } from './router-search';
import { resolveReplySession } from './slack-thread-identity';
import { slackTimestampUs } from './router-search-index';
import { RoutedAdmissionHeld, type RoutedRequestCoordinator } from './routed-requests';
export type CommunicationSource = {
    channel_id: string;
    message_ts: string;
};
type Address = {
    session: number;
    channel: string;
    root: string;
};
type RequestRow = {
    request_id: string;
    source_channel: string;
    source_message_ts: string;
    source_turn_id: number;
    source_session_id: number;
    source_root_ts: string;
    action_id: string;
    target_session_id: number;
    target_channel: string;
    target_root_ts: string;
    payload_json: string;
    payload_hash: string;
    causal_depth: number;
    routed_request_id: string | null;
    target_turn_id: number | null;
    input_kind: string | null;
    status: string;
    outcome: string | null;
    result_json: string | null;
    due_at_ms: number;
    overdue_at_ms: number | null;
    created_at_ms: number;
};
type EventRow = {
    event_id: string;
    request_id: string;
    kind: 'progress' | 'final' | 'overdue';
    payload_json: string;
    routed_request_id: string | null;
    status: string;
    error: string | null;
};
type Actor = {
    source: CommunicationSource;
    session: number;
    turn: number;
    root: string;
    user: string;
};
type Dependencies = {
    routed: Pick<RoutedRequestCoordinator, 'submit' | 'result' | 'recoverRequest' | 'recoverUnsentReturn'>;
    now?: () => number;
    arm?: (callback: () => void, delay: number) => () => void;
    isOwnerAlive: (owner: string) => boolean;
    isLiveTarget?: (session: number, channel: string, root: string) => boolean;
    onError: (error: unknown) => void;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const action = (value: string) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error('A stable source-scoped action_id is required.'); return value; };
const text = (value: string) => { if (typeof value !== 'string' || !value.trim())
    throw new Error('A nonempty message is required.'); return value; };
const reference = (address: Address) => 'session:' + Buffer.from(JSON.stringify([1, address.session, address.channel, address.root])).toString('base64url');
/** Durable conversations over the existing routed-input and native execution owners. */
export class SessionCommunicationCoordinator {
    private readonly tasks = new Map<string, Promise<void>>();
    private readonly again = new Set<string>();
    private scheduled = false;
    private stopped = true;
    private disarm: (() => void) | null = null;
    private detach: (() => void) | null = null;
    private readonly now: () => number;
    constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now; }
    private actor(source: CommunicationSource): Actor {
        if (!source || typeof source.channel_id !== 'string' || slackTimestampUs(source.message_ts) === null)
            throw new Error('An exact accepted source input is required.');
        const claim = getSlackUserInputClaim(source.channel_id, source.message_ts);
        if (!claim?.turn_id || !claim.user_id || !['turn', 'steering'].includes(claim.kind))
            throw new Error('Source must identify an accepted session input.');
        const turn = db.query('SELECT session_id FROM turns WHERE id=?').get(claim.turn_id) as {
            session_id: number;
        } | null;
        const session = turn && getSessionById(turn.session_id);
        if (!session || session.slack_channel_id !== source.channel_id || !claim.reply_thread_ts)
            throw new Error('Source session or exact visible conversation is unproven.');
        return { source: { channel_id: source.channel_id, message_ts: source.message_ts }, session: session.id, turn: claim.turn_id, root: claim.reply_thread_ts, user: claim.user_id };
    }
    private address(value: string, callable = false): Address {
        if (typeof value !== 'string' || !value.startsWith('session:'))
            throw new Error('Use an exact address returned by session discovery.');
        let decoded: any;
        try {
            decoded = JSON.parse(Buffer.from(value.slice(8), 'base64url').toString());
        }
        catch {
            throw new Error('Invalid session address.');
        }
        if (!Array.isArray(decoded) || decoded.length !== 4 || decoded[0] !== 1 || !Number.isSafeInteger(decoded[1]) || decoded[1] < 1 || typeof decoded[2] !== 'string' || slackTimestampUs(decoded[3]) === null)
            throw new Error('Invalid session address.');
        const result = { session: decoded[1], channel: decoded[2], root: decoded[3] };
        const channel = getChannel(result.channel);
        const session = channel && resolveReplySession(db, channel, result.root).session;
        if (!session || session.id !== result.session)
            throw new Error('The addressed session binding changed. Discover the intended session again.');
        if (callable && !this.messageable(result))
            throw new Error('The exact session is not currently messageable.');
        return result;
    }
    private messageable(address: Address) {
        const session = getSessionById(address.session);
        return getChannel(address.channel)?.mode === 'agent-auto' && !!session && session.status !== 'archived'
            && !this.stoppedSession(session.id)
            && (!!session.agent_session_uuid || this.dependencies.isLiveTarget?.(address.session, address.channel, address.root) === true);
    }
    private stoppedSession(sessionId: number) {
        const stop = db.query('SELECT max(COALESCE(stop_input_cutoff,id)) AS id FROM turns WHERE session_id=? AND stop_requested_at IS NOT NULL').get(sessionId) as {
            id: number | null;
        };
        if (stop.id === null)
            return false;
        return !db.query(`SELECT 1 FROM turns turn JOIN sessions session ON session.id=turn.session_id WHERE turn.session_id=? AND turn.id>?
   AND turn.turn_kind='slack_user' AND NOT EXISTS(SELECT 1 FROM routed_requests routed WHERE routed.channel_id=session.slack_channel_id AND routed.message_ts=turn.slack_user_msg_ts) LIMIT 1`).get(sessionId, stop.id);
    }
    admissionHeld(routedId: string) {
        const target = db.query(`SELECT request.target_session_id AS session, request.target_channel AS channel, request.target_root_ts AS root
          FROM routed_requests routed JOIN session_communication_requests request
            ON routed.action_id='session-ask-' || request.request_id AND routed.source_channel=request.source_channel AND routed.source_message_ts=request.source_message_ts
          WHERE routed.request_id=?
          UNION ALL
          SELECT request.source_session_id, request.source_channel, request.source_root_ts
          FROM routed_requests routed JOIN session_communication_events event ON routed.action_id='session-event-' || event.event_id
          JOIN session_communication_requests request ON request.request_id=event.request_id
            AND routed.source_channel=request.source_channel AND routed.source_message_ts=request.source_message_ts
          WHERE routed.request_id=?`).get(routedId, routedId) as Address | null;
        if (!target) return false;
        try { this.address(reference(target), true); return false; }
        catch { return true; }
    }
    assertAdmission(routedId?: string) {
        if (routedId && this.admissionHeld(routedId))
            throw new RoutedAdmissionHeld('The addressed session is stopped, archived, or no longer callable; the input is retained.');
    }
    private causalDepth(actor: Actor) {
        const routed = db.query('SELECT action_id FROM routed_requests WHERE channel_id=? AND message_ts=?').get(actor.source.channel_id, actor.source.message_ts) as {
            action_id: string;
        } | null;
        if (!routed)
            return 0;
        if (routed.action_id.startsWith('session-ask-'))
            return this.row(routed.action_id.slice(12)).causal_depth + 1;
        if (routed.action_id.startsWith('session-event-')) {
            const event = db.query('SELECT request_id FROM session_communication_events WHERE event_id=?').get(routed.action_id.slice(14)) as {
                request_id: string;
            } | null;
            if (event)
                return this.row(event.request_id).causal_depth + 1;
        }
        return 0;
    }
    search(input: {
        source: CommunicationSource;
        concepts: string[];
        limit?: number;
    }) {
        const actor = this.actor(input.source);
        const found = searchRouterThreads(db, { beforeTs: actor.source.message_ts, concepts: input.concepts, limit: input.limit,
            excludeChannel: actor.source.channel_id, excludeRootTs: actor.root });
        return { ...found, corpus: 'routing_evidence', results: found.results.map(result => {
                const session = resolveReplySession(db, getChannel(result.channel_id)!, result.root_ts).session;
                return { ...result, messageable: !!session && this.messageable({session:session.id,channel:result.channel_id,root:result.root_ts}), session_id: session ? `concierge:${session.id}` : null, address: session ? reference({ session: session.id, channel: result.channel_id, root: result.root_ts }) : null };
            }) };
    }
    context(input: {
        source: CommunicationSource;
        address: string;
    }) {
        const actor = this.actor(input.source);
        const address = this.address(input.address);
        return { ...getRouterThreadContext(db, { channel: address.channel, rootTs: address.root, beforeTs: actor.source.message_ts }),
            session_id: `concierge:${address.session}`, address: input.address };
    }
    private row(id: string): RequestRow {
        const row = db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(id) as RequestRow | null;
        if (!row)
            throw new Error('Unknown session request.');
        return row;
    }
    get(input: {
        source: CommunicationSource;
        request_id: string;
    }) {
        const actor = this.actor(input.source);
        const row = this.row(input.request_id);
        if (actor.session !== row.source_session_id && actor.session !== row.target_session_id)
            throw new Error('Request is outside this session.');
        return this.receipt(row);
    }
    private receipt(row: RequestRow) {
        const binding = this.binding(row);
        const execution = binding?.turn_id ? db.query('SELECT status,provider_turn_id FROM turns WHERE id=?').get(binding.turn_id) as any : null;
        const steering = binding?.input_kind === 'steering' ? db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(binding.turn_id, binding.message_ts) as any : null;
        return { request_id: row.request_id, status: row.status, outcome: row.outcome, source_session_id: `concierge:${row.source_session_id}`,
            target_session_id: `concierge:${row.target_session_id}`, routed_request_id: row.routed_request_id, target_turn_id: row.target_turn_id,
            due_at_ms: row.due_at_ms, overdue_at_ms: row.overdue_at_ms, result: row.result_json ? JSON.parse(row.result_json) : null,
            execution: execution ? { turn_id: binding.turn_id, input_kind: binding.input_kind, input_status: steering?.status ?? execution.status, acknowledged_at: steering?.provider_sent_at ?? null, provider_turn_id: execution.provider_turn_id } : null,
            events: (db.query('SELECT * FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as EventRow[])
                .map(event => ({ event_id: event.event_id, kind: event.kind, status: event.status, error: event.error, payload: JSON.parse(event.payload_json), routed_request_id: event.routed_request_id })) };
    }
    ask(input: {
        source: CommunicationSource;
        action_id: string;
        address: string;
        text: string;
        after?: string[];
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting requests.');
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        if (input.after !== undefined && (!Array.isArray(input.after) || input.after.some(id => typeof id !== 'string')))
            throw new Error('after must contain exact existing request IDs.');
        const after = [...new Set(input.after ?? [])].sort();
        const encoded = JSON.stringify({ address: input.address, text: input.text, after });
        const digest = hash(encoded);
        const previous = db.query('SELECT * FROM session_communication_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?').get(actor.source.channel_id, actor.source.message_ts, input.action_id) as RequestRow | null;
        if (previous) {
            if (previous.payload_hash !== digest)
                throw new Error('Idempotency conflict: this source/action already names a different request.');
            return this.receipt(previous);
        }
        const target = this.address(input.address, true);
        const depth = this.causalDepth(actor);
        if (depth >= 8)
            throw new Error('This conversation reached its eight-hop automatic communication budget. A new human input is required to continue it.');
        if (target.session === actor.session)
            throw new Error('A session cannot ask itself to produce a separate answer.');
        for (const dependency of after)
            if (this.row(dependency).source_session_id !== actor.session)
                throw new Error('A continuation may depend only on this session’s accepted requests.');
        const id = randomUUID();
        const now = this.now();
        db.transaction(() => {
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,causal_depth) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, actor.source.channel_id, actor.source.message_ts, actor.turn, actor.session, actor.root, input.action_id, target.session, target.channel, target.root, encoded, digest, now + 30 * 60 * 1000, now, depth);
        })();
        this.wake();
        return this.receipt(this.row(id));
    }
    reply(input: {
        source: CommunicationSource;
        action_id: string;
        request_id: string;
        text: string;
        final: boolean;
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting replies.');
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        if (typeof input.final !== 'boolean')
            throw new Error('Specify whether this is a final answer.');
        const request = this.row(input.request_id);
        if (request.target_session_id !== actor.session || request.target_channel !== actor.source.channel_id || request.target_root_ts !== actor.root)
            throw new Error('Only the exact recipient session/conversation can reply.');
        const binding = this.binding(request);
        if (!binding?.turn_id || binding.turn_id !== actor.turn)
            throw new Error('This input is not part of the addressed execution.');
        const key = JSON.stringify([actor.source.channel_id, actor.source.message_ts, input.action_id]);
        const payload = { text: input.text, final: input.final, source: actor.source, responding_session_id: `concierge:${actor.session}` };
        const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
        if (prior) {
            if (prior.request_id !== request.request_id || prior.payload_json !== JSON.stringify(payload))
                throw new Error('Idempotency conflict: reply action has a different payload.');
            return this.receipt(this.row(request.request_id));
        }
        db.transaction(() => {
            if (this.row(request.request_id).outcome)
                throw new Error('This request already has a final disposition.');
            db.query('UPDATE session_communication_requests SET routed_request_id=?,target_turn_id=?,input_kind=? WHERE request_id=?').run(binding.request_id, binding.turn_id, binding.input_kind, request.request_id);
            const id = this.event(request, input.final ? 'final' : 'progress', payload, key);
            if (input.final)
                db.query("UPDATE session_communication_requests SET outcome='answered',status='settled',result_json=? WHERE request_id=?").run(JSON.stringify({ ...payload, event_id: id }), request.request_id);
        })();
        this.wake();
        return this.receipt(this.row(request.request_id));
    }
    private event(request: RequestRow, kind: EventRow['kind'], payload: unknown, key: string | null = null) {
        const id = randomUUID();
        db.query('INSERT INTO session_communication_events(event_id,request_id,kind,action_key,payload_json,created_at_ms) VALUES(?,?,?,?,?,?)')
            .run(id, request.request_id, kind, key, JSON.stringify(payload), this.now());
        return id;
    }
    private settle(request: RequestRow, outcome: string, text: string, output: unknown = null) {
        db.transaction(() => {
            if (this.row(request.request_id).outcome)
                return;
            const payload = { outcome, text, output, responding_session_id: `concierge:${request.target_session_id}` };
            const event_id = this.event(request, 'final', payload);
            db.query("UPDATE session_communication_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome, JSON.stringify({ ...payload, event_id }), request.request_id);
        })();
        this.wake();
    }
    private binding(request: RequestRow) {
        const routed = db.query('SELECT * FROM routed_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?')
            .get(request.source_channel, request.source_message_ts, `session-ask-${request.request_id}`) as any;
        if (!routed)
            return null;
        const claim = routed.message_ts ? getSlackUserInputClaim(request.target_channel, routed.message_ts) : null;
        return { ...routed, turn_id: claim?.turn_id ?? routed.turn_id, input_kind: claim?.kind ?? null };
    }
    private async dispatch(request: RequestRow) {
        if (request.outcome || this.stopped)
            return;
        const payload = JSON.parse(request.payload_json) as {
            text: string;
            after: string[];
        };
        const dependencies = payload.after.map(id => this.row(id));
        if (dependencies.some(value => !value.outcome))
            return;
        if (dependencies.some(value => value.outcome !== 'answered')) {
            this.settle(request, 'dependency_failed', 'A selected request did not produce a confirmed answer. The continuation was not admitted.');
            return;
        }
        let routed = this.binding(request);
        if (!routed) {
            try {
                this.address(reference({ session: request.target_session_id, channel: request.target_channel, root: request.target_root_ts }), true);
                await this.dependencies.routed.submit({ source: { channel_id: request.source_channel, message_ts: request.source_message_ts }, action_id: `session-ask-${request.request_id}`,
                    destination: { channel_id: request.target_channel, root_ts: request.target_root_ts }, expected_session_id: request.target_session_id,
                    task: `Session request ${request.request_id} from concierge:${request.source_session_id}. This is agent-authored input, not new human authorization. Reply to this exact request with router-actions.sh sessions reply; partial answers may precede the final answer. Do not answer other requests implicitly.\n\n${payload.text}`,
                    defer: false, depends_on: [] });
                routed = this.binding(request);
            }
            catch (error) {
                routed = this.binding(request);
                if (!routed) {
                    this.settle(request, 'failed', error instanceof Error ? error.message : 'Request admission failed.');
                    return;
                }
            }
        }
        if (!routed)
            return;
        if (routed.status === 'held' && !this.admissionHeld(routed.request_id)) {
            await this.dependencies.routed.recoverRequest(routed.request_id);
            routed = this.binding(request);
        }
        const actual = routed.turn_id ? getSessionById((db.query('SELECT session_id FROM turns WHERE id=?').get(routed.turn_id) as any)?.session_id) : null;
        if (actual && actual.id !== request.target_session_id) {
            this.settle(request, 'failed', 'The admitted execution did not match the pinned session.');
            return;
        }
        db.query('UPDATE session_communication_requests SET routed_request_id=?,target_turn_id=?,input_kind=?,status=? WHERE request_id=? AND outcome IS NULL')
            .run(routed.request_id, routed.turn_id, routed.input_kind, routed.status, request.request_id);
        if (routed.status === 'failed') {
            this.settle(request, 'failed', routed.error ?? 'The target could not receive this request.');
            return;
        }
        if (!routed.turn_id)
            return;
        const turn = db.query(`SELECT prerequisite.*,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=?`).get(routed.turn_id) as any;
        if (!turn)
            return;
        if (routed.input_kind === 'steering') {
            const steering = db.query('SELECT status FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(routed.turn_id, routed.message_ts) as any;
            if (steering?.status === 'failed') {
                this.settle(request, 'failed', 'The provider did not accept this live request.');
                return;
            }
        }
        if (!turn.settled)
            return;
        const messages = db.query(`SELECT chunk_index,slack_ts FROM turn_delivery_chunks
          WHERE turn_id=? AND delivered_at IS NOT NULL AND slack_ts IS NOT NULL ORDER BY chunk_index`).all(turn.id) as Array<{chunk_index:number;slack_ts:string}>;
        const output = { turn_id: turn.id, channel_id: request.target_channel, root_ts: request.target_root_ts, message_ts: messages[0]?.slack_ts ?? null,
            messages, delivery_status: turn.delivery_status,
            sha256: turn.agent_text ? hash(turn.agent_text) : null };
        const questions = (db.query(`SELECT count(*) AS count FROM session_communication_requests WHERE target_turn_id=?`).get(turn.id) as any).count;
        const steeringCount = (db.query('SELECT count(*) AS count FROM turn_steering_messages WHERE turn_id=?').get(turn.id) as any).count;
        if (turn.status === 'done' && routed.input_kind === 'turn' && questions === 1 && steeringCount === 0 && turn.agent_text) {
            this.settle(request, 'answered', turn.agent_text, output);
            return;
        }
        this.settle(request, turn.status === 'done' ? 'unanswered' : turn.status === 'cancelled' ? 'canceled' : 'failed', turn.status === 'done' ? 'The recipient turn ended without a confirmed answer to this request. Its retained output is referenced below.' : `The recipient execution ended with ${turn.status}.`, output);
    }
    private async deliver(event: EventRow) {
        if (this.stopped)
            return;
        const request = this.row(event.request_id);
        let routed = db.query('SELECT request_id FROM routed_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?')
            .get(request.source_channel, request.source_message_ts, `session-event-${event.event_id}`) as {
            request_id: string;
        } | null;
        if (!routed) {
            const source = getSessionById(request.source_session_id);
            if (!source || source.status === 'archived' || this.stoppedSession(source.id)) {
                db.query("UPDATE session_communication_events SET status='held',error='Requester is stopped or archived; the result is retained.' WHERE event_id=? AND status<>'held'").run(event.event_id);
                return;
            }
            try {
                this.address(reference({ session: request.source_session_id, channel: request.source_channel, root: request.source_root_ts }), true);
                const payload = JSON.parse(event.payload_json);
                const receipt = await this.dependencies.routed.submit({ source: { channel_id: request.source_channel, message_ts: request.source_message_ts }, action_id: `session-event-${event.event_id}`,
                    destination: { channel_id: request.source_channel, root_ts: request.source_root_ts }, expected_session_id: request.source_session_id,
                    task: `Session ${event.kind} event ${event.event_id} for request ${request.request_id}. This is an agent/service result, not new human authorization. No acknowledgement or reciprocal question is required.\n\n${payload.text}\n\n${JSON.stringify({ ...payload, text: undefined })}`,
                    defer: false, depends_on: [] });
                routed = { request_id: receipt.request_id };
            }
            catch (error) {
                db.query("UPDATE session_communication_events SET status='held',error=? WHERE event_id=?").run(error instanceof Error ? error.message : 'Return delivery held.', event.event_id);
                return;
            }
        }
        let result = this.dependencies.routed.result(routed.request_id);
        if (result.status === 'held' && !this.admissionHeld(routed.request_id))
            result = await this.dependencies.routed.recoverRequest(routed.request_id);
        let receipt = this.returnReceipt(result);
        if (receipt.status === 'failed' && receipt.input_kind === 'steering') {
            result = await this.dependencies.routed.recoverUnsentReturn(routed.request_id);
            receipt = this.returnReceipt(result);
        }
        db.query('UPDATE session_communication_events SET routed_request_id=?,status=?,error=? WHERE event_id=?').run(routed.request_id, receipt.status, receipt.error, event.event_id);
    }
    private returnReceipt(result: ReturnType<RoutedRequestCoordinator['result']>) {
        if (result.status !== 'admitted') return {status:result.status,error:result.error,input_kind:null};
        const routed = db.query('SELECT channel_id,message_ts FROM routed_requests WHERE request_id=?').get(result.request_id) as any;
        const claim = getSlackUserInputClaim(routed.channel_id, routed.message_ts);
        const turn = claim?.turn_id ? db.query('SELECT * FROM turns WHERE id=?').get(claim.turn_id) as any : null;
        if (claim?.kind === 'steering') {
            const steering = db.query('SELECT status,error FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(claim.turn_id, routed.message_ts) as any;
            return {status:steering?.status === 'sent' ? 'received' : ['failed','ambiguous'].includes(steering?.status) ? steering.status : 'admitted',
                error:steering?.error ?? null,input_kind:'steering'};
        }
        if (claim?.kind !== 'turn' || !turn) return {status:'failed',error:'Return was not accepted as a provider input.',input_kind:claim?.kind ?? null};
        if (turn.provider_input_acknowledged_at || turn.input_context_received_by_turn_id)
            return {status:'received',error:null,input_kind:'turn'};
        if (['cancelled','interrupted','error','parked','done'].includes(turn.status))
            return {status:turn.provider_admission_intended_at ? 'ambiguous' : 'failed',error:'Requester execution ended without confirmed receipt. Its existing input/recovery owner retains the return.',input_kind:'turn'};
        return {status:'admitted',error:null,input_kind:'turn'};
    }
    inspectOverdue() {
        const now = this.now();
        for (const request of db.query('SELECT * FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL AND due_at_ms<=?').all(now) as RequestRow[]) {
            const binding = this.binding(request);
            const turn = binding?.turn_id ? db.query('SELECT status,owner_instance_id,stop_requested_at FROM turns WHERE id=?').get(binding.turn_id) as any : null;
            const health = turn?.stop_requested_at ? 'deliberately stopped' : turn?.status === 'running' ?
                turn.owner_instance_id && this.dependencies.isOwnerAlive(turn.owner_instance_id) ? 'running under its existing owner' : 'native owner unavailable; exact recovery evidence is required' : turn?.status ?? binding?.status ?? 'waiting for admission';
            db.transaction(() => {
                if (this.row(request.request_id).outcome || this.row(request.request_id).overdue_at_ms !== null)
                    return;
                this.event(request, 'overdue', { text: `Request ${request.request_id} has no confirmed answer after 30 minutes. Recipient state: ${health}. The request remains recorded; no uncertain provider effect or deliberate Stop was replayed. Inspect the request and decide whether more work is needed.`, health });
                db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
            })();
        }
    }
    wake() {
        if (this.stopped || this.scheduled)
            return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (this.stopped)
                return;
            try {
                this.inspectOverdue();
                for (const request of db.query('SELECT * FROM session_communication_requests WHERE outcome IS NULL ORDER BY rowid').all() as RequestRow[])
                    this.schedule(`ask:${request.request_id}`, () => this.dispatch(this.row(request.request_id)));
                for (const event of db.query("SELECT * FROM session_communication_events WHERE status<>'received' ORDER BY rowid").all() as EventRow[])
                    this.schedule(`event:${event.event_id}`, () => this.deliver(event));
                this.arm();
            }
            catch (error) {
                this.disarm?.();
                this.disarm = null;
                this.dependencies.onError(error);
            }
        });
    }
    private schedule(key: string, work: () => Promise<void>) {
        if (this.tasks.has(key)) {
            this.again.add(key);
            return;
        }
        const task = Promise.resolve().then(work);
        this.tasks.set(key, task);
        void task.catch(this.dependencies.onError).finally(() => {
            this.tasks.delete(key);
            if (this.again.delete(key) && !this.stopped)
                this.schedule(key, work);
        });
    }
    private arm() {
        this.disarm?.();
        this.disarm = null;
        if (this.stopped)
            return;
        const next = db.query('SELECT min(due_at_ms) AS due FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL').get() as {
            due: number | null;
        };
        if (next.due === null)
            return;
        const delay = Math.max(0, next.due - this.now());
        if (this.dependencies.arm)
            this.disarm = this.dependencies.arm(() => this.wake(), delay);
        else {
            const timer = setTimeout(() => this.wake(), delay);
            timer.unref();
            this.disarm = () => clearTimeout(timer);
        }
    }
    start() { if (!this.stopped)
        return; this.stopped = false; this.detach = observeExecutionChanges(() => this.wake()); this.wake(); }
    async idle() { do {
        await Promise.resolve();
        await Promise.all([...this.tasks.values()]);
    } while (this.tasks.size || this.scheduled); }
    async stop() { this.stopped = true; this.detach?.(); this.detach = null; this.disarm?.(); this.disarm = null; await Promise.allSettled([...this.tasks.values()]); }
}
