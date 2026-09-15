import { createHash, randomUUID } from 'node:crypto';
import { db, getChannel, getSessionById, getSlackUserInputClaim, observeExecutionChanges, SETTLED_EXECUTION_SQL } from './state';
import { getRouterThreadContext, searchRouterThreads } from './router-search';
import { resolveReplySession } from './slack-thread-identity';
import { slackTimestampUs } from './router-search-index';
import { RoutedAdmissionHeld, type RoutedRequestCoordinator } from './routed-requests';
import { getAcceptedSessionInput, nativeRunId, recordSessionEvent, recoverUnsentSessionReturn, retainSessionInput, retainSlackInput, sessionMetadata, updateSessionMetadata } from './session-inputs';
import { readInputExecution, resolveSessionAddress, sessionAddress, type SessionOwner } from './session-owner';
export type CommunicationSource = {
    channel_id?: string;
    message_ts?: string;
    input_id?: string;
    run_id?: string;
};
type Address = {
    session: number;
    channel: string | null;
    root: string | null;
    native?: boolean;
};
type RequestRow = {
    request_id: string;
    source_channel: string;
    source_message_ts: string;
    source_turn_id: number;
    source_session_id: number;
    source_root_ts: string;
    source_input_id: string | null;
    target_input_id: string | null;
    action_id: string;
    target_session_id: number;
    target_channel: string;
    target_root_ts: string;
    payload_json: string;
    payload_hash: string;
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
    accepted_input_id: string | null;
};
type Actor = {
    source: CommunicationSource;
    session: number;
    turn: number;
    root: string | null;
    user: string;
    inputId?: string;
};
type Dependencies = {
    routed: Pick<RoutedRequestCoordinator, 'submit' | 'result' | 'recoverRequest' | 'recoverUnsentReturn'>;
    now?: () => number;
    arm?: (callback: () => void, delay: number) => () => void;
    isOwnerAlive: (owner: string) => boolean;
    isLiveTarget?: (session: number, channel: string, root: string) => boolean;
    onError: (error: unknown) => void;
    owner?: SessionOwner;
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
        if (source?.input_id || source?.run_id) {
            if (source.channel_id || source.message_ts || !source.input_id || !source.run_id)
                throw new Error('Choose one exact accepted input identity.');
            const input = getAcceptedSessionInput(source.input_id);
            const observed = input && readInputExecution(input);
            if (!input || !observed?.turn || nativeRunId(observed.turn.id) !== source.run_id || observed.turn.session_id !== input.session_id
                || observed.turn.status !== 'running' || !observed.turn.provider_admission_intended_at
                || (observed.steering && !['sending','sent'].includes(observed.steering.status)))
                throw new Error('Source must identify this admitted input and its exact live run.');
            const session = getSessionById(input.session_id)!;
            if (sessionMetadata(session).interactionPolicy === 'consultation-only')
                throw new Error('Consultation-only sessions cannot send requests or replies.');
            return { source, session: input.session_id, turn: observed.turn.id, root: null, user: input.origin, inputId: input.id };
        }
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
        if (decoded?.[0] === 2) {
            const session = resolveSessionAddress(value);
            const result = {session:session.id,channel:null,root:null,native:true};
            if (callable && !this.messageable(result)) throw new Error('The exact session is not currently messageable.');
            return result;
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
        if (address.native) return !!session && !!this.dependencies.owner?.view(session).capabilities.send && !this.stoppedSession(session.id);
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
   AND ((turn.turn_kind='native' AND EXISTS(SELECT 1 FROM session_inputs input WHERE input.turn_id=turn.id AND input.origin='human'))
     OR (turn.turn_kind='slack_user' AND NOT EXISTS(SELECT 1 FROM routed_requests routed WHERE routed.channel_id=session.slack_channel_id AND routed.message_ts=turn.slack_user_msg_ts))) LIMIT 1`).get(sessionId, stop.id);
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
    search(input: {
        source: CommunicationSource;
        concepts: string[];
        limit?: number;
    }) {
        const actor = this.actor(input.source);
        if (actor.inputId) return this.dependencies.owner!.search({query:input.concepts.join(' '),limit:input.limit});
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
        if (address.native || actor.inputId) return this.dependencies.owner!.context({address:sessionAddress(getSessionById(address.session)!)});
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
    inspect(requestId:string) { return this.receipt(this.row(requestId)); }
    cancel(input:{source:CommunicationSource;request_id:string;action_id:string}) {
        const actor=this.actor(input.source),row=this.row(input.request_id);
        action(input.action_id);
        if(row.source_session_id!==actor.session)throw new Error('Only the requesting session can cancel this request.');
        db.transaction(()=>{
            if(actor.inputId) {
                const retained=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'cancel',origin:'agent',
                    payload:{requestId:row.request_id,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:row.request_id});
                if(retained.duplicate)return;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),retained.input.id);
            }
            if(!row.outcome)this.settle(row,'canceled','The requesting session canceled this request. Its recipient execution was not stopped.');
        })();
        return this.receipt(this.row(row.request_id));
    }
    private receipt(row: RequestRow) {
        const binding = this.binding(row);
        const execution = binding?.turn_id ? db.query('SELECT status,provider_turn_id,provider_input_acknowledged_at FROM turns WHERE id=?').get(binding.turn_id) as any : null;
        const steering = binding?.input_kind === 'steering' ? binding.steering_id
            ? db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE id=?').get(binding.steering_id) as any
            : db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(binding.turn_id, binding.message_ts) as any : null;
        return { request_id: row.request_id, status: row.status, outcome: row.outcome, source_session_id: `concierge:${row.source_session_id}`,
            target_session_id: `concierge:${row.target_session_id}`, routed_request_id: row.routed_request_id, target_turn_id: row.target_turn_id,
            due_at_ms: row.due_at_ms, overdue_at_ms: row.overdue_at_ms, result: row.result_json ? JSON.parse(row.result_json) : null,
            execution: execution ? { turn_id: binding.turn_id, input_kind: binding.input_kind, input_status: steering?.status ?? execution.status, acknowledged_at: steering?.provider_sent_at ?? (binding.input_kind==='turn'?execution.provider_input_acknowledged_at:null) ?? null, provider_turn_id: execution.provider_turn_id } : null,
            events: (db.query('SELECT * FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as EventRow[])
                .map(event => ({ event_id: event.event_id, kind: event.kind, status: event.status, error: event.error, payload: JSON.parse(event.payload_json), routed_request_id: event.routed_request_id })) };
    }
    ask(input: {
        source: CommunicationSource;
        action_id: string;
        address: string;
        text: string;
        after?: string[];
        attachments?:string[];
        evidence?:unknown[];
        requestedEffect?:'informational'|'work';
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting requests.');
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        if (input.after !== undefined && (!Array.isArray(input.after) || input.after.some(id => typeof id !== 'string')))
            throw new Error('after must contain exact existing request IDs.');
        const after = [...new Set(input.after ?? [])].sort();
        if(input.requestedEffect!==undefined&&!['informational','work'].includes(input.requestedEffect))throw new Error('Requested effect must be informational or work within existing authority.');
        if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
        if(input.attachments!==undefined)this.dependencies.owner?.attachments(input.attachments);
        const extra={...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),...(input.requestedEffect?{requestedEffect:input.requestedEffect}:{})};
        const encoded = JSON.stringify({ address: input.address, text: input.text, after,...extra });
        const digest = hash(encoded);
        const previous = actor.inputId
            ? db.query('SELECT * FROM session_communication_requests WHERE source_input_id=? AND action_id=?').get(actor.inputId,input.action_id) as RequestRow | null
            : db.query('SELECT * FROM session_communication_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?').get(actor.source.channel_id!, actor.source.message_ts!, input.action_id) as RequestRow | null;
        if (previous) {
            if (previous.payload_hash !== digest)
                throw new Error('Idempotency conflict: this source/action already names a different request.');
            return this.receipt(previous);
        }
        const target = this.address(input.address, true);
        const targetSession=getSessionById(target.session)!;
        const consultationOnly=sessionMetadata(targetSession).interactionPolicy==='consultation-only';
        const serviceReply=consultationOnly||targetSession.provider_id==='chatgpt';
        if(consultationOnly&&input.requestedEffect==='work')throw new Error('This session accepts consultation only — information, no actions.');
        if(!actor.inputId&&!target.native&&(input.attachments!==undefined||input.evidence!==undefined||input.requestedEffect!==undefined))
            throw new Error('Attachment, evidence and requested-effect metadata require a native session address.');
        if (target.session === actor.session)
            throw new Error('A session cannot ask itself to produce a separate answer.');
        for (const dependency of after)
            if (this.row(dependency).source_session_id !== actor.session)
                throw new Error('A continuation may depend only on this session’s accepted requests.');
        const id = randomUUID();
        const now = this.now();
        db.transaction(() => {
            const native = !!actor.inputId || target.native;
            const sourceInput = native ? actor.inputId ?? retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id : null;
            if (native && !this.dependencies.owner) throw new Error('Native session owner is unavailable.');
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, actor.source.channel_id??null, actor.source.message_ts??null, actor.turn, actor.session, actor.root, input.action_id, target.session, target.channel, target.root, encoded, digest, now + 30 * 60 * 1000, now,sourceInput,native?`request:${id}`:null);
            if (sourceInput) {
                retainSessionInput({id:`request:${id}`,sessionId:target.session,scope:`session:${sourceInput}`,actionId:`request:${id}`,kind:'input',origin:'agent',
                    payload:{text:`Session request ${id} from concierge:${actor.session}. This is agent-authored input, not new human authorization. Requested effect: ${input.requestedEffect??'informational'}. Reply to this exact request; partial answers may precede the final answer. Do not answer other requests implicitly.\n\n${input.text}`,...extra,...(serviceReply?{delivery:'queue'}:{})},
                    sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id});
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInput}`,actionId:input.action_id,kind:'request',origin:'agent',
                    payload:{text:input.text,sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),targetSessionId:`concierge:${target.session}`,targetAddress:input.address,afterRequestIds:after,...extra},sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id}).input;
                recordSessionEvent({eventId:`request:${id}`,sessionId:actor.session,inputId:operation.id,turnId:actor.turn,kind:'request',payload:{requestId:id,targetSessionId:`concierge:${target.session}`}});
            }
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
        evidence?:unknown[];
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting replies.');
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        if (typeof input.final !== 'boolean')
            throw new Error('Specify whether this is a final answer.');
        const request = this.row(input.request_id);
        if (request.target_session_id !== actor.session || (!request.source_input_id && (request.target_channel !== actor.source.channel_id || request.target_root_ts !== actor.root)))
            throw new Error('Only the exact recipient session/conversation can reply.');
        const binding = this.binding(request);
        if (!binding?.turn_id || binding.turn_id !== actor.turn)
            throw new Error('This input is not part of the addressed execution.');
        const key = actor.inputId?JSON.stringify(['input',actor.inputId,input.action_id]):JSON.stringify([actor.source.channel_id, actor.source.message_ts, input.action_id]);
        if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
        const payload = { text: input.text, final: input.final, source: actor.source, responding_session_id: `concierge:${actor.session}`,...(input.evidence?{evidence:input.evidence}:{}) };
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
            if(actor.inputId) {
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
                    payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),kind:input.final?'final':'partial',evidence:input.evidence},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:request.request_id}).input;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId:id}),operation.id);
            }
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
        if(request.source_input_id) {
            recordSessionEvent({eventId:id,sessionId:request.source_session_id,inputId:request.source_input_id,kind:'response',payload:{requestId:request.request_id,kind,...payload as object}});
            const session=getSessionById(request.source_session_id)!;
            updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
        }
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
        if (request.target_input_id) {
            const input = getAcceptedSessionInput(request.target_input_id);
            if (!input) throw new Error('Accepted request input is missing.');
            const observed = readInputExecution(input);
            const receipt = input.receipt_json ? JSON.parse(input.receipt_json) : {};
            return {request_id:null,turn_id:input.turn_id,input_kind:input.steering_id?'steering':'turn',steering_id:input.steering_id,
                message_ts:null,status:receipt.state??(input.turn_id?'admitted':'held'),error:receipt.error??null};
        }
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
        if (request.target_input_id) {
            let target:Address;
            try {target=this.address(JSON.parse(request.payload_json).address);}
            catch(error){this.settle(request,'failed',error instanceof Error?error.message:'The pinned session binding is unavailable.');return;}
            if (!this.messageable({...target,native:true})) return;
            this.dependencies.owner!.dispatch(getAcceptedSessionInput(request.target_input_id)!);
            routed = this.binding(request);
        }
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
        if (!request.target_input_id && routed.status === 'held' && !this.admissionHeld(routed.request_id)) {
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
            const steering = routed.steering_id?db.query('SELECT status FROM turn_steering_messages WHERE id=?').get(routed.steering_id) as any
                : db.query('SELECT status FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(routed.turn_id, routed.message_ts) as any;
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
        const serviceReply=!!request.target_input_id&&turn.accepted_input_id===request.target_input_id&&!!turn.provider_input_acknowledged_at
            &&(actual?.provider_id==='chatgpt'||actual&&sessionMetadata(actual).interactionPolicy==='consultation-only');
        if ((!request.source_input_id||serviceReply) && turn.status === 'done' && routed.input_kind === 'turn' && questions === 1 && steeringCount === 0 && turn.agent_text) {
            this.settle(request, 'answered', turn.agent_text, output);
            return;
        }
        this.settle(request, turn.status === 'done' ? 'unanswered' : turn.status === 'cancelled' ? 'canceled' : 'failed', turn.status === 'done' ? 'The recipient turn ended without a confirmed answer to this request. Its retained output is referenced below.' : `The recipient execution ended with ${turn.status}.`, output);
    }
    private async deliver(event: EventRow) {
        if (this.stopped)
            return;
        const request = this.row(event.request_id);
        if (request.source_input_id) {
            const source = getSessionById(request.source_session_id);
            if (!source || !this.messageable({session:source.id,channel:null,root:null,native:true})) {
                db.query("UPDATE session_communication_events SET status='held',error='Requester is unavailable, stopped or archived; the result is retained.' WHERE event_id=?").run(event.event_id);
                return;
            }
            const payload = JSON.parse(event.payload_json);
            recoverUnsentSessionReturn(`return:${event.event_id}`);
            const accepted = this.dependencies.owner!.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:request.source_input_id,
                sourceRunId:nativeRunId(request.source_turn_id),requestId:request.request_id,
                text:`Session ${event.kind} event ${event.event_id} for request ${request.request_id}. This is an agent/service result, not new human authorization. No acknowledgement or reciprocal question is required.\n\n${payload.text}\n\n${JSON.stringify({...payload,text:undefined})}`});
            const observed = readInputExecution(accepted);
            const received = observed.acknowledgedAt || observed.turn?.input_context_received_by_turn_id;
            const status = received?'received':['failed','uncertain','canceled'].includes(observed.state)?observed.state:accepted.turn_id?'admitted':'held';
            db.query('UPDATE session_communication_events SET accepted_input_id=?,status=?,error=? WHERE event_id=?').run(accepted.id,status,received?null:observed.steering?.error??null,event.event_id);
            return;
        }
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
