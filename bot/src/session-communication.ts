import { createHash, randomUUID } from 'node:crypto';
import { db, getChannel, getSessionById, getSlackUserInputClaim, observeExecutionChanges, SETTLED_EXECUTION_SQL } from './state';
import { resolveReplySession } from './slack-thread-identity';
import { slackTimestampUs } from './router-search-index';
import { getAcceptedSessionInput, nativeRunId, normalizeSessionTitle, recordSessionEvent, recoverUnsentSteeredInput, retainSessionInput, retainSlackInput, sessionMetadata, updateSessionMetadata, sessionInputProvenance } from './session-inputs';
import { readInputExecution, resolveSessionAddress, sessionAddress, type SessionOwner } from './session-owner';
import { inboxThreadRoot } from './session-inbox';
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
    created_at_ms: number;
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
    now?: () => number;
    arm?: (callback: () => void, delay: number) => () => void;
    isOwnerAlive: (owner: string) => boolean;
    onError: (error: unknown) => void;
    owner: SessionOwner;
};
type WorkDisposition = 'completed' | 'failed' | 'needs_decision';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const action = (value: string) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error('A stable source-scoped action_id is required.'); return value; };
const text = (value: string) => { if (typeof value !== 'string' || !value.trim())
    throw new Error('A nonempty message is required.'); return value; };
/** Durable conversations admitted only by the common native session owner. */
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
            const live = !!input && !!observed?.turn && nativeRunId(observed.turn.id) === source.run_id && observed.turn.session_id === input.session_id
                && observed.turn.status === 'running' && !observed.turn.stop_requested_at && !!observed.turn.provider_admission_intended_at;
            // A run citing its own ambiguous steering input is strong evidence it received it, and
            // refusing left agents unable to act on requests they were answering. It is not proof:
            // the input ID derives from a request ID another message could quote, so this admits
            // the action without recording an acknowledgement. The action's reach is unchanged,
            // since any live run of the recipient session may already reply.
            if (!live || (observed!.steering && !['sending','sent','ambiguous'].includes(observed!.steering.status)))
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
        const turn = db.query('SELECT session_id,status,provider_admission_intended_at FROM turns WHERE id=?').get(claim.turn_id) as {
            session_id: number; status: string; provider_admission_intended_at: string | null;
        } | null;
        if (turn?.status !== 'running' || !turn.provider_admission_intended_at)
            throw new Error('Source must identify this admitted input and its exact live run.');
        const session = turn && getSessionById(turn.session_id);
        if (!session || session.slack_channel_id !== source.channel_id || !claim.reply_thread_ts)
            throw new Error('Source session or exact visible conversation is unproven.');
        const retained = retainSlackInput(source.channel_id, source.message_ts);
        return { ...this.actor({input_id:retained.id,run_id:nativeRunId(claim.turn_id)}),
            source: {channel_id:source.channel_id,message_ts:source.message_ts},root:claim.reply_thread_ts };
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
        return {...result,native:true};
    }
    private messageable(address: Address) {
        const session = getSessionById(address.session);
        return !!session && !!this.dependencies.owner.view(session).capabilities.send;
    }
    search(input: {
        source: CommunicationSource;
        concepts: string[];
        limit?: number;
    }) {
        const actor = this.actor(input.source);
        if (!Array.isArray(input.concepts) || input.concepts.length < 1 || input.concepts.length > 8
            || input.concepts.some(value => typeof value !== 'string' || !value.trim()))
            throw new Error('Use one to eight nonempty search concepts.');
        if (!this.dependencies.owner) throw new Error('Common session discovery is unavailable.');
        return this.dependencies.owner.search({query:input.concepts.join(' '),limit:input.limit}, actor.inputId ? undefined : {
            beforeTs:actor.source.message_ts!,excludeChannel:actor.source.channel_id!,excludeRootTs:actor.root!
        });
    }
    context(input: {
        source: CommunicationSource;
        address: string;
    }) {
        const actor = this.actor(input.source);
        const address = this.address(input.address);
        return this.dependencies.owner.context({address:sessionAddress(getSessionById(address.session)!)});
    }
    projects(input:{source:CommunicationSource}) {
        this.actor(input.source);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        return this.dependencies.owner.projects();
    }
    title(input:{source:CommunicationSource;action_id:string;title:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source),title=normalizeSessionTitle(input.title);
        action(input.action_id);
        if(!title)throw new Error('A session title is required.');
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'self-title',title},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return {session:this.dependencies.owner!.view(getSessionById(actor.session)!),applied:JSON.parse(saved.input.receipt_json??'{}').applied===true};
            const session=getSessionById(actor.session)!;
            const applied=!sessionMetadata(session).title?.trim();
            if(applied) {
                updateSessionMetadata(session.id,{title});
                recordSessionEvent({eventId:`title:${saved.input.id}`,sessionId:session.id,inputId:saved.input.id,turnId:actor.turn,kind:'title',payload:{title}});
            }
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',applied}),saved.input.id);
            return {session:this.dependencies.owner!.view(getSessionById(session.id)!),applied};
        })();
    }
    /**
     * An agent answers a thread of its own Inbox on purpose. Tejas asked that answering a
     * thread be an action the agent takes, rather than the thread collecting whatever the
     * agent said while it worked. A post starts no provider turn and creates no request or
     * return obligation, so it cannot wake anyone into a loop.
     *
     * Only the Inbox accepts posts, because only its history is built from the ledger. Every
     * other session shows its provider transcript, which a post never enters: it would be
     * accepted there and then never seen, and it would sit inside the window a history
     * delta fingerprints.
     */
    post(input:{source:CommunicationSource;action_id:string;thread:string;text:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        const text=typeof input.text==='string'?input.text.trim():'';
        if(!text)throw new Error('A post needs message text.');
        if(typeof input.thread!=='string'||!input.thread.trim())throw new Error('A post needs the exact --thread message ID.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const session=getSessionById(actor.session)!;
            if(!sessionMetadata(session).inbox)throw new Error('Only the Inbox accepts posts: this session shows its provider transcript, which a post never enters.');
            // The owner, not the caller, decides which thread this belongs to. A reply to any
            // message in a thread carries that thread's root forward.
            const rootInputId=inboxThreadRoot(session.id,input.thread);
            if(!rootInputId)throw new Error('That --thread is not a message in this Inbox.');
            const saved=retainSessionInput({sessionId:session.id,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'thread-post',thread:input.thread,text},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            const messageId=`post:${saved.input.id}`;
            const receipt={messageId,thread:input.thread,inputId:rootInputId};
            if(saved.duplicate)return {post:receipt,duplicate:true};
            recordSessionEvent({eventId:messageId,sessionId:session.id,inputId:rootInputId,turnId:actor.turn,kind:'post',
                payload:{text,replyToMessage:{kind:'message',sessionId:`concierge:${session.id}`,messageId:input.thread},postedBy:saved.input.id}});
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',post:receipt}),saved.input.id);
            return {post:receipt,duplicate:false};
        })();
    }
    async note(input:{source:CommunicationSource;action_id:string;captureId:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
        return this.dependencies.owner.saveInboxNote({sourceInputId,sourceRunId:nativeRunId(actor.turn),sourceSessionId:actor.session,actionId:input.action_id,captureId:input.captureId});
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
        const legacyPending = !row.outcome && (!row.source_input_id || !row.target_input_id);
        return { request_id: row.request_id, status: legacyPending ? 'uncertain' : row.status,
            ...(legacyPending ? {error:'Legacy delivery requires owner reconciliation; no request or return has been replayed.'} : {}), outcome: row.outcome, source_session_id: `concierge:${row.source_session_id}`,
            target_address:sessionAddress(getSessionById(row.target_session_id)!),
            target:this.dependencies.owner?.view(getSessionById(row.target_session_id)!),
            target_session_id: `concierge:${row.target_session_id}`, target_input_id:row.target_input_id,
            operation_id:(db.query("SELECT id FROM session_inputs WHERE request_id=? AND kind='request' ORDER BY rowid LIMIT 1").get(row.request_id) as {id:string}|null)?.id??null,
            routed_request_id: row.routed_request_id, target_turn_id: row.target_turn_id,
            due_at_ms: row.due_at_ms, overdue_at_ms: row.overdue_at_ms, result: row.result_json ? JSON.parse(row.result_json) : null,
            execution: execution ? { turn_id: binding.turn_id, input_kind: binding.input_kind, input_status: steering?.status ?? execution.status, acknowledged_at: steering?.provider_sent_at ?? (binding.input_kind==='turn'?execution.provider_input_acknowledged_at:null) ?? null, provider_turn_id: execution.provider_turn_id } : null,
            events: (db.query('SELECT * FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as EventRow[])
                .map(event => ({ event_id: event.event_id, kind: event.kind, status: event.status, error: event.error, payload: JSON.parse(event.payload_json), routed_request_id: event.routed_request_id })) };
    }
    async ask(input: {
        source: CommunicationSource;
        action_id: string;
        address?: string;
        provider?: string;
        effort?: string;
        project?: string;
        title?: string;
        text: string;
        after?: string[];
        attachments?:string[];
        files?:{name:string;contentType:string;base64:string}[];
        captureId?:string;
        evidence?:unknown[];
        requestedEffect?:'informational'|'work';
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting requests.');
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        const title=normalizeSessionTitle(input.title);
        if(title!==undefined&&!input.provider)throw new Error('A session name requires new session creation.');
        if(input.provider!==undefined) {
            if(typeof input.provider!=='string'||!input.provider||input.address!==undefined)throw new Error('Choose either an exact session address or an explicit provider for a new session.');
            const sourceSession=getSessionById(actor.session)!;
            if(sourceSession.provider_id==='chatgpt')throw new Error('ChatGPT sessions cannot send outbound session requests.');
            if(sessionMetadata(sourceSession).interactionPolicy==='consultation-only')throw new Error('Consultation-only sessions cannot send requests or replies.');
            const sourceTurn=db.query('SELECT status,provider_admission_intended_at FROM turns WHERE id=?').get(actor.turn) as any;
            if(sourceTurn?.status!=='running'||!sourceTurn.provider_admission_intended_at)throw new Error('Source must identify this admitted input and its exact live run.');
            if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        }
        if(!input.provider&&(input.effort!==undefined||input.project!==undefined))throw new Error('Model, effort and project selection require a new session; addressed requests preserve the target.');
        if (input.after !== undefined && (!Array.isArray(input.after) || input.after.some(id => typeof id !== 'string')))
            throw new Error('after must contain exact existing request IDs.');
        const after = [...new Set(input.after ?? [])].sort();
        if(input.requestedEffect!==undefined&&!['informational','work'].includes(input.requestedEffect))throw new Error('Requested effect must be informational or work within existing authority.');
        if(input.requestedEffect==='work'&&sessionInputProvenance(getAcceptedSessionInput(actor.inputId!)!)?.effectScope==='informational')
            throw new Error('An informational request cannot delegate work; preserve its originating scope.');
        if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
        if(input.attachments!==undefined)this.dependencies.owner?.attachments(input.attachments);
        if(input.files!==undefined&&!Array.isArray(input.files))throw new Error('Files must contain named attachment bytes.');
        if(input.captureId!==undefined&&typeof input.captureId!=='string')throw new Error('Capture ID must name a retained inbox input.');
        const extra={...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),...(input.requestedEffect?{requestedEffect:input.requestedEffect}:{})};
        const encoded = JSON.stringify({ ...(input.provider?{provider:input.provider}:{address:input.address}), ...(title===undefined?{}:{title}), text: input.text, after,...extra,
            ...(input.effort===undefined?{}:{effort:input.effort}),...(input.project===undefined?{}:{project:input.project}),
            ...(input.files===undefined?{}:{files:input.files}),...(input.captureId===undefined?{}:{captureId:input.captureId}) });
        const digest = hash(encoded);
        const prior = () => actor.inputId
            ? db.query('SELECT * FROM session_communication_requests WHERE action_id=? AND (source_input_id=? OR (source_channel=? AND source_message_ts=?))').get(input.action_id,actor.inputId,actor.source.channel_id??null,actor.source.message_ts??null) as RequestRow | null
            : db.query('SELECT * FROM session_communication_requests WHERE source_channel=? AND source_message_ts=? AND action_id=?').get(actor.source.channel_id!, actor.source.message_ts!, input.action_id) as RequestRow | null;
        const previous = prior();
        if (previous) {
            if (previous.payload_hash !== digest)
                throw new Error('Idempotency conflict: this source/action already names a different request.');
            return this.receipt(previous);
        }
        let target = input.provider?null:this.address(input.address!);
        const targetSession=target?getSessionById(target.session)!:null;
        const historical=!!targetSession&&sessionMetadata(targetSession).origin==='imported'&&!this.dependencies.owner?.view(targetSession).capabilities.send;
        if(target&&!historical&&!this.messageable(target))throw new Error('The exact session is not currently messageable.');
        const consultationOnly=!!targetSession&&sessionMetadata(targetSession).interactionPolicy==='consultation-only';
        const serviceReply=consultationOnly||targetSession?.provider_id==='chatgpt'||input.provider==='chatgpt';
        if(consultationOnly&&input.requestedEffect==='work')throw new Error('This session accepts consultation only — information, no actions.');
        if(historical&&(input.attachments?.length||input.files?.length||input.captureId))throw new Error('Historical consultation cannot inspect attached files.');
        if (target?.session === actor.session)
            throw new Error('A session cannot ask itself to produce a separate answer.');
        for (const dependency of after)
            if (this.row(dependency).source_session_id !== actor.session)
                throw new Error('A continuation may depend only on this session’s accepted requests.');
        const consultation=historical?await this.dependencies.owner!.prepareConsultation(input.address!,undefined,input.evidence):null;
        if(consultation) {
            if(this.stopped)throw new Error('Session communication is not accepting requests.');
            const raced=prior();
            if(raced){if(raced.payload_hash!==digest)throw new Error('Idempotency conflict: this source/action already names a different request.');return this.receipt(raced);}
        }
        const id = randomUUID();
        const now = this.now();
        db.transaction(() => {
            const sourceInput = actor.inputId!;
            if(input.provider||consultation)this.actor({input_id:sourceInput!,run_id:nativeRunId(actor.turn)});
            if(input.files?.length||input.captureId) {
                this.actor({input_id:sourceInput!,run_id:nativeRunId(actor.turn)});
                const captured=input.captureId?this.dependencies.owner!.inboxCaptureAttachments(input.captureId):[];
                const attachments=[...(input.attachments??[]),...captured,...(input.files??[]).map((file,index)=>
                    this.dependencies.owner!.upload({...file,clientActionId:`request-file:${hash(sourceInput!+':'+input.action_id)}:${index}`}).attachment.id)];
                this.dependencies.owner!.attachments(attachments);
                extra.attachments=attachments;
            }
            const firstInput={text:`Session request ${id} from concierge:${actor.session}. This is agent-authored input within the originating human task, not a new human message. Requested effect: ${input.requestedEffect??'informational'}. Reply to each request this run received; partial answers may precede the final answer. When one answer covers several of them, a single final reply naming the others settles them too.\n\n${input.text}`,...extra,...(serviceReply?{delivery:'queue'}:{})};
            if(input.provider) {
                const created=this.dependencies.owner!.createRequestTarget({sourceInputId:sourceInput!,sourceRunId:nativeRunId(actor.turn),requestId:id,provider:input.provider,effort:input.effort,project:input.project,title,firstInput});
                target={session:created.session_id,channel:null,root:null,native:true};
            }
            if(consultation) {
                const created=this.dependencies.owner!.createRequestConsultation(consultation,{sourceInputId:sourceInput!,sourceRunId:nativeRunId(actor.turn),requestId:id,firstInput});
                target={session:created.session_id,channel:null,root:null,native:true};
            }
            const selected=target!;
            const address=sessionAddress(getSessionById(selected.session)!);
            const retainedBody=JSON.parse(encoded);
            if(input.files)retainedBody.files=input.files.map(({name,contentType,base64})=>({name,contentType,sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')}));
            const retainedPayload=JSON.stringify({...retainedBody,...extra,address,...(consultation?{requestedAddress:input.address,consultation:{sourceId:consultation.source.id,sourceVersion:consultation.source.version,branch:consultation.source.branch,boundary:consultation.source.consultation.boundary}}:{})});
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, actor.source.channel_id??null, actor.source.message_ts??null, actor.turn, actor.session, actor.root, input.action_id, selected.session, selected.channel, selected.root, retainedPayload, digest, now + 30 * 60 * 1000, now,sourceInput,`request:${id}`);
            if (sourceInput) {
                if(!input.provider&&!consultation)retainSessionInput({id:`request:${id}`,sessionId:selected.session,scope:`session:${sourceInput}`,actionId:`request:${id}`,kind:'input',origin:'agent',
                    payload:firstInput,
                    sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id});
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInput}`,actionId:input.action_id,kind:'request',origin:'agent',
                    payload:{text:input.text,sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),targetSessionId:`concierge:${selected.session}`,targetAddress:address,...(input.provider?{targetProvider:input.provider}:{}),...(title===undefined?{}:{title}),afterRequestIds:after,...extra},sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id}).input;
                if(consultation)db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({childSessionId:`concierge:${selected.session}`}),operation.id);
                recordSessionEvent({eventId:`request:${id}`,sessionId:actor.session,inputId:operation.id,turnId:actor.turn,kind:'request',payload:{requestId:id,targetSessionId:`concierge:${selected.session}`}});
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
        workDisposition?: WorkDisposition;
        evidence?:unknown[];
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting replies.');
        // A lost socket response may be retried after the provider run ends. The
        // already committed reply is safe to inspect without requiring a live run.
        if (input.source.input_id && input.source.run_id) {
            const key = JSON.stringify(['input', input.source.input_id, input.action_id]);
            const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
            if (prior) {
                const payload = JSON.parse(prior.payload_json);
                const sourceInput = getAcceptedSessionInput(input.source.input_id);
                if (prior.request_id !== input.request_id || payload.text !== input.text || payload.final !== input.final
                    || payload.workDisposition !== input.workDisposition
                    || JSON.stringify(payload.evidence) !== JSON.stringify(input.evidence)
                    || payload.source?.input_id !== input.source.input_id || payload.source?.run_id !== input.source.run_id
                    || !sourceInput || payload.responding_session_id !== `concierge:${sourceInput.session_id}`)
                    throw new Error('Idempotency conflict: reply action has a different payload or source.');
                return this.receipt(this.row(input.request_id));
            }
        }
        const actor = this.actor(input.source);
        action(input.action_id);
        text(input.text);
        if (typeof input.final !== 'boolean')
            throw new Error('Specify whether this is a final answer.');
        const request = this.row(input.request_id);
        const requestedEffect = JSON.parse(request.payload_json).requestedEffect;
        if (input.workDisposition !== undefined && (!input.final || requestedEffect !== 'work'
            || !['completed','failed','needs_decision'].includes(input.workDisposition)))
            throw new Error('A work disposition requires a final reply to a work request.');
        if (!request.source_input_id || !request.target_input_id)
            throw new Error('Legacy delivery requires owner reconciliation before a new reply.');
        if (request.target_session_id !== actor.session || (!request.source_input_id && (request.target_channel !== actor.source.channel_id || request.target_root_ts !== actor.root)))
            throw new Error('Only the exact recipient session/conversation can reply.');
        const binding = this.binding(request);
        // The recipient session is one conversation. After an interruption its later run still
        // holds the delivered request and the work, so any live run of that session may answer.
        if (!binding?.turn_id)
            throw new Error('This request has not been delivered to this session yet.');
        const key = actor.inputId?JSON.stringify(['input',actor.inputId,input.action_id]):JSON.stringify([actor.source.channel_id, actor.source.message_ts, input.action_id]);
        if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
        const payload = { text: input.text, final: input.final, source: actor.source, responding_session_id: `concierge:${actor.session}`,
            ...(input.workDisposition?{workDisposition:input.workDisposition,completionTurnId:actor.turn}:{}),...(input.evidence?{evidence:input.evidence}:{}) };
        const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
        if (prior) {
            if (prior.request_id !== request.request_id || prior.payload_json !== JSON.stringify(payload))
                throw new Error('Idempotency conflict: reply action has a different payload.');
            return this.receipt(this.row(request.request_id));
        }
        db.transaction(() => {
            if (this.row(request.request_id).outcome)
                throw new Error('This request already has a final disposition.');
            if (input.final && db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='final'").get(request.request_id))
                throw new Error('This request already has a final reply awaiting execution confirmation.');
            db.query('UPDATE session_communication_requests SET routed_request_id=?,target_turn_id=?,input_kind=? WHERE request_id=?').run(binding.request_id, binding.turn_id, binding.input_kind, request.request_id);
            const id = this.event(request, input.final ? 'final' : 'progress', payload, key);
            if(actor.inputId) {
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
                    payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),kind:input.final?'final':'partial',workDisposition:input.workDisposition,evidence:input.evidence},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:request.request_id}).input;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId:id}),operation.id);
            }
            if (input.final) {
                const outcome=input.workDisposition==='failed'?'failed':input.workDisposition==='needs_decision'?'decision_needed':input.workDisposition==='completed'?null:requestedEffect==='work'?'undetermined':'answered';
                db.query('UPDATE session_communication_requests SET outcome=?,status=?,result_json=? WHERE request_id=?')
                    .run(outcome,outcome?'settled':'awaiting_execution',JSON.stringify({ ...payload, event_id: id }),request.request_id);
            }
        })();
        this.wake();
        return this.receipt(this.row(request.request_id));
    }
    private hasNativePartialReply(request: RequestRow): boolean {
        return !!request.source_input_id && !!db.query(
            "SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='progress' LIMIT 1",
        ).get(request.request_id);
    }
    private recipientStillWorking(request: RequestRow, states = ['running', 'queued']): boolean {
        const session = getSessionById(request.target_session_id);
        return !!session && states.includes(this.dependencies.owner.view(session).execution);
    }
    /** Every request this recipient turn is carrying, whichever input opened or steered it. */
    private sharedTurnRequests(turnId: number): RequestRow[] {
        return db.query(`SELECT request.* FROM session_communication_requests request
            JOIN session_inputs input ON input.id=request.target_input_id WHERE input.turn_id=? ORDER BY request.rowid`)
            .all(turnId) as RequestRow[];
    }
    private steeringRow(routed: { turn_id: number; steering_id?: number | null; message_ts?: string | null }) {
        return (routed.steering_id ? db.query('SELECT status FROM turn_steering_messages WHERE id=?').get(routed.steering_id)
            : db.query('SELECT status FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(routed.turn_id, routed.message_ts)) as { status: string } | null;
    }
    private deliveredToTurn(routed: any): boolean {
        return routed.input_kind === 'turn' || (routed.input_kind === 'steering'
            && ['sent', 'ambiguous'].includes(this.steeringRow(routed)?.status ?? ''));
    }
    private steeringAcknowledged(routed: any): boolean {
        return this.steeringRow(routed)?.status === 'sent';
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
    private settle(request: RequestRow, outcome: string, text: string, output: unknown = null, disposition: WorkDisposition | null = null) {
        db.transaction(() => {
            if (this.row(request.request_id).outcome)
                return;
            const payload = { outcome, text, output, responding_session_id: `concierge:${request.target_session_id}`,
                ...(disposition ? { workDisposition: disposition } : {}) };
            const final=db.query("SELECT * FROM session_communication_events WHERE request_id=? AND kind='final'").get(request.request_id) as EventRow|null;
            if (final) {
                if (JSON.parse(final.payload_json).workDisposition !== 'completed')
                    throw new Error('A final reply already exists for this request.');
                db.query("UPDATE session_communication_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?")
                    .run(outcome,JSON.stringify({...payload,event_id:final.event_id,declaredDisposition:'completed'}),request.request_id);
                return;
            }
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
        if (!request.source_input_id || !request.target_input_id) {
            db.query("UPDATE session_communication_requests SET status='uncertain' WHERE request_id=? AND outcome IS NULL AND status<>'uncertain'").run(request.request_id);
            return;
        }
        const payload = JSON.parse(request.payload_json) as {
            text: string;
            after: string[];
        };
        const dependencies = payload.after.map(id => this.row(id));
        if (dependencies.some(value => !value.outcome))
            return;
        // Missing confirmation is a decision needed by the requester, not proof
        // that the prerequisite work failed. Keep its continuation unadmitted.
        if (dependencies.some(value => !['answered','unanswered','decision_needed','undetermined'].includes(value.outcome!))) {
            this.settle(request, 'dependency_failed', 'A selected prerequisite failed or was canceled. The continuation was not admitted.');
            return;
        }
        if (dependencies.some(value => value.outcome === 'unanswered' || value.outcome === 'decision_needed' || value.outcome === 'undetermined'))
            return;
        const declared = db.query("SELECT * FROM session_communication_events WHERE request_id=? AND kind='final'").get(request.request_id) as EventRow | null;
        if (declared && JSON.parse(declared.payload_json).workDisposition === 'completed') {
            const declaration=JSON.parse(declared.payload_json);
            const turn=db.query(`SELECT prerequisite.*,(${SETTLED_EXECUTION_SQL}) AS settled FROM turns prerequisite WHERE id=? AND session_id=?`)
                .get(declaration.completionTurnId,request.target_session_id) as any;
            if (!turn?.settled) return;
            const completed=turn.status==='done' && !!turn.provider_input_acknowledged_at && !turn.stop_requested_at;
            const result=completed?declaration:{
                outcome:turn.status==='cancelled'?'canceled':turn.status==='done'?'unanswered':'failed',
                text:`The recipient declared completion, but its execution ended with ${turn.status} without confirmed successful completion. Inspect the retained run before continuing.`,
                responding_session_id:`concierge:${request.target_session_id}`, declaredDisposition:'completed',
                output:{turn_id:turn.id,run_id:nativeRunId(turn.id),sha256:turn.agent_text?hash(turn.agent_text):null,text:turn.agent_text??null}
            };
            db.query('UPDATE session_communication_requests SET outcome=?,status=?,result_json=? WHERE request_id=? AND outcome IS NULL')
                .run(completed?'answered':result.outcome,'settled',JSON.stringify({...result,event_id:declared.event_id}),request.request_id);
            this.wake();
            return;
        }
        let routed = this.binding(request);
        if(routed?.status==='failed') {
            this.settle(request,'failed',routed.error??'The target could not receive this request.');
            return;
        }
        if (request.target_input_id) {
            let target:Address;
            try {target=this.address(JSON.parse(request.payload_json).address);}
            catch(error){this.settle(request,'failed',error instanceof Error?error.message:'The pinned session binding is unavailable.');return;}
            if (!this.messageable({...target,native:true})) return;
            this.dependencies.owner!.dispatch(getAcceptedSessionInput(request.target_input_id)!);
            routed = this.binding(request);
        }
        if (!routed) return;
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
        const parkedChatGpt=request.target_input_id===turn.accepted_input_id&&actual?.provider_id==='chatgpt'
            &&turn.status==='parked'&&turn.owner_instance_id===null&&turn.ended_at
            &&['parked_access','parked_terminal','parked_ambiguous'].includes(turn.dispatch_failure_class);
        if (!turn.settled&&!parkedChatGpt)
            return;
        const output = { turn_id: turn.id, session_id: `concierge:${request.target_session_id}`,
            run_id:nativeRunId(turn.id), input_id:request.target_input_id,
            sha256: turn.agent_text ? hash(turn.agent_text) : null,
            ...(turn.status==='done'&&turn.agent_text?{text:turn.agent_text}:{}),
            ...(actual?.provider_id==='chatgpt'&&!['done','cancelled'].includes(turn.status)?{error:turn.agent_text}:{} ) };
        // One recipient turn often carries several of a requester's questions: the first opens
        // the turn and later ones steer into it. The recipient answers them together in one
        // final text, so that answer belongs to every question the turn was holding — not only
        // to the request an explicit reply happened to name.
        const shared = this.sharedTurnRequests(turn.id);
        // A failed steering send never reached this turn; its input runs later as its own turn.
        const steeringCount = (db.query("SELECT count(*) AS count FROM turn_steering_messages WHERE turn_id=? AND status<>'failed'").get(turn.id) as any).count;
        const questionsOnly = turn.status === 'done' && !!turn.provider_input_acknowledged_at
            && shared.length === steeringCount + 1
            && shared.some(value => value.target_input_id === turn.accepted_input_id)
            && this.deliveredToTurn(routed);
        // The recipient's own explicit reply is the strongest confirmation available, and it
        // answers every question this turn already held when the reply was written. A question
        // that arrived afterwards, or another requester's, is not covered by it. Only a reply
        // action counts: a sibling the owner itself settled carries the owner's words, not the
        // recipient's, and reading those back as an answer would invent one.
        const answer = !questionsOnly ? null
            : shared.filter(value => value.request_id !== request.request_id && value.source_session_id === request.source_session_id)
                .map(value => db.query("SELECT * FROM session_communication_events WHERE request_id=? AND kind='final' AND action_key IS NOT NULL").get(value.request_id) as EventRow | null)
                .find((event): event is EventRow => !!event && event.created_at_ms >= request.created_at_ms) ?? null;
        const effect = JSON.parse(request.payload_json).requestedEffect;
        if (answer) {
            const declared = JSON.parse(answer.payload_json);
            const unconfirmed = routed.input_kind === 'steering' && !this.steeringAcknowledged(routed);
            const outcome = effect !== 'work' ? 'answered' : declared.workDisposition === 'failed' ? 'failed'
                : declared.workDisposition === 'needs_decision' ? 'decision_needed'
                : declared.workDisposition === 'completed' ? 'answered' : 'undetermined';
            // Declared completion is retained rather than woken, so one answer to several
            // questions wakes the requester once at most. Unproven delivery of this exact
            // question is an uncertainty the requester still has to see.
            this.settle(request, outcome, declared.text, { ...output,
                answered_by_request_id: answer.request_id, shared_turn_requests: shared.length,
                ...(unconfirmed ? { delivery: 'STEERING_DELIVERY_UNCONFIRMED',
                    delivery_note: 'This request steered into the answering turn without provider acknowledgement. Its answer follows that turn’s confirmed completion; receipt of this exact message is not proven.' } : {}) },
                effect === 'work' && !unconfirmed && declared.workDisposition === 'completed' ? 'completed' : null);
            return;
        }
        // With no reply anywhere on the turn, only a turn that existed for this one request
        // has an unambiguous answer in its retained text. Several unanswered questions stay
        // unanswered rather than have an answer invented for them.
        const dedicated = turn.accepted_input_id === request.target_input_id && !!turn.provider_input_acknowledged_at
            && routed.input_kind === 'turn' && shared.length === 1 && steeringCount === 0;
        if (dedicated && turn.status === 'done' && turn.agent_text) {
            this.settle(request, effect === 'work' ? 'undetermined' : 'answered', turn.agent_text, output);
            return;
        }
        // A turn that ended without an answer is not the recipient's last word while its session
        // is still working: an interrupted turn's answer arrives from the run that follows it.
        if (turn.status === 'done' && (this.hasNativePartialReply(request) || this.recipientStillWorking(request)))
            return;
        this.settle(request, turn.status === 'done' ? 'unanswered' : turn.status === 'cancelled' ? 'canceled' : 'failed', turn.status === 'done' ? 'The recipient turn ended without a confirmed answer to this request. Its retained output is referenced below.' : `The recipient execution ended with ${turn.status}.`, output);
    }
    private async deliver(event: EventRow) {
        if (this.stopped)
            return;
        const request = this.row(event.request_id);
        const declared=JSON.parse(event.payload_json);
        if (event.kind==='final' && declared.workDisposition==='completed') {
            if (!request.outcome) return;
            if (request.outcome==='answered') {
                db.query("UPDATE session_communication_events SET status='retained',error=NULL WHERE event_id=?").run(event.event_id);
                return;
            }
        }
        if (request.source_input_id && request.target_input_id) {
            const source = getSessionById(request.source_session_id);
            if (!source || !this.messageable({session:source.id,channel:null,root:null,native:true})) {
                db.query("UPDATE session_communication_events SET status='held',error='Requester is unavailable, paused or archived; the result is retained.' WHERE event_id=?").run(event.event_id);
                return;
            }
            const payload = declared.workDisposition==='completed' && request.outcome!=='answered'
                ? JSON.parse(request.result_json!) : declared;
            recoverUnsentSteeredInput(`return:${event.event_id}`);
            const accepted = this.dependencies.owner!.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:request.source_input_id,
                sourceRunId:nativeRunId(request.source_turn_id),requestId:request.request_id,
                text:`Session ${event.kind} event ${event.event_id} for request ${request.request_id}. This is an agent/service result, not new human authorization. No acknowledgement or reciprocal question is required.\n\n${payload.text}\n\n${JSON.stringify({...payload,text:undefined})}`});
            const observed = readInputExecution(accepted);
            const received = observed.acknowledgedAt || observed.turn?.input_context_received_by_turn_id;
            const unacknowledgedSteering=observed.steering?.status==='ambiguous'&&!observed.steering.provider_sent_at;
            const status = received?'received':unacknowledgedSteering?'uncertain':['failed','uncertain','canceled'].includes(observed.state)?observed.state:accepted.turn_id?'admitted':'held';
            const deliveryError=unacknowledgedSteering?'The provider did not acknowledge this specific return; its linked turn outcome does not prove receipt.':observed.steering?.error??null;
            db.query('UPDATE session_communication_events SET accepted_input_id=?,status=?,error=? WHERE event_id=?').run(accepted.id,status,received?null:deliveryError,event.event_id);
            return;
        }
        db.query("UPDATE session_communication_events SET status='uncertain',error='Legacy return delivery requires owner reconciliation; no effect has been replayed.' WHERE event_id=? AND status<>'received'").run(event.event_id);
    }
    inspectOverdue() {
        const now = this.now();
        for (const request of db.query('SELECT * FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL AND due_at_ms<=?').all(now) as RequestRow[]) {
            if (!request.source_input_id || !request.target_input_id) continue;
            const binding = this.binding(request);
            const turn = binding?.turn_id ? db.query('SELECT status,owner_instance_id,stop_requested_at FROM turns WHERE id=?').get(binding.turn_id) as any : null;
            // Work in progress under a live owner is not a stall. Wait another interval rather
            // than report a healthy run as one; its answer settles this request when it ends.
            const healthy = turn?.status === 'running' ? !turn.stop_requested_at && !!turn.owner_instance_id && this.dependencies.isOwnerAlive(turn.owner_instance_id)
                : turn?.status === 'done' && this.recipientStillWorking(request, ['running']);
            if (healthy) {
                db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
                    .run(now + 30 * 60 * 1000, request.request_id);
                continue;
            }
            const health = turn?.stop_requested_at ? 'deliberately stopped' : turn?.status === 'running'
                ? 'native owner unavailable; exact recovery evidence is required' : turn?.status ?? binding?.status ?? 'waiting for admission';
            // Several questions held by one recipient turn are one piece of work, so they
            // report one stall between them instead of one stall each.
            const reported = binding?.turn_id && this.sharedTurnRequests(binding.turn_id)
                .some(sibling => sibling.request_id !== request.request_id && sibling.source_session_id === request.source_session_id
                    && !!db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='overdue' LIMIT 1").get(sibling.request_id));
            db.transaction(() => {
                if (this.row(request.request_id).outcome || this.row(request.request_id).overdue_at_ms !== null)
                    return;
                if (!reported)
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
                for (const event of db.query("SELECT * FROM session_communication_events WHERE status NOT IN ('received','retained') ORDER BY rowid").all() as EventRow[])
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
        const next = db.query('SELECT min(due_at_ms) AS due FROM session_communication_requests WHERE outcome IS NULL AND overdue_at_ms IS NULL AND source_input_id IS NOT NULL AND target_input_id IS NOT NULL').get() as {
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
