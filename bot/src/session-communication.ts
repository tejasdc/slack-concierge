import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { db, getChannel, getSessionById, getSlackUserInputClaim, observeExecutionChanges, SETTLED_EXECUTION_SQL, type SessionRow } from './state';
import { resolveReplySession } from './slack-thread-identity';
import { slackTimestampUs } from './router-search-index';
import { bindSessionProvider, createNativeSession, getAcceptedSessionInput, HOLDING_OUTCOMES, humanNamedSession, isInferredFinal, nativeRunId, normalizeSessionTitle, recordSessionEvent, recoverUnsentSteeredInput, retainSessionInput, retainSlackInput, sessionMetadata, updateSessionMetadata, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';
import { heldRequestNotice, inputHold, readInputExecution, resolveSessionAddress, sessionAddress, type SessionOwner } from './session-owner';
import { inboxRequestThread, inboxThreadLink, inboxThreadRoot, threadOwedByTurn, turnPostedInto } from './session-inbox';
import {inboxRequestRoot} from './inbox-request-root';
import { followForwardedReply, forwardedReplyFraming } from './session-inbox';
import { requestIdFor as peerRequestId } from './session-peers';
import { expireQuestionsForFinalReply, invalidateTopicRoots, postAgentAnswer, releaseFocusForPost, topicOfRoot, topicsCommand } from './session-topics';
import { PeerError, type SessionPeers, type PeerActor } from './session-peers';
import { answersHisOwnMessage, QUIET_REASON_REQUIRED, recordTurnOutcome, turnDeclaredByAction, type DeclaredTurnOutcome } from './session-turn-outcome';
import { auditUndeliveredReturns, releaseLateRetainedReturns } from './session-return-audit';
import { usageSignal } from './provider-usage-forecast';
import { log } from './log';
import {savedWorkSettings} from './saved-work';
import {cancelWatch,listWatches,registerWatch} from './watches';
import {boardCommand,type BoardActor,type BoardInput} from './commons-board-service';
import { AWAITING_INSPECTION, REMINDERS_SINCE_MS, STILL_WAITING_AFTER_MS, STILL_WAITING_MINUTES, updateDraining, replyCommand, sameAnswerKey, strandedStep, stalledNotice, tellWorkerCanceled, waitingOnLiveRequest, waitingOnDependency, type OwedRequest } from './request-liveness';
import { REQUEST_PROTOCOL_POINTER } from './request-protocol';
import { completionWithCheck, questionForTejas } from './answers-to-tejas';
import { answerNotice, requestLabel, sessionLabel } from './session-notices';
import { cancelledWithoutHisStopText, stoppedByTejas, stoppedByTejasText } from './stopped-by-tejas';
import { noticeTime } from './provider-free-notice';
import { isWritingSession, MACHINE_NEED_REQUIRED, takesManySubjects, WRITING_SESSION_REFUSAL } from './session-roles';
import { backfillRequestTopics, consultPointer, forTopic, handBackText, newTopicNote, sessionWorkload, topicOf, topicRootFor } from './session-fit';
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
    thread_root_input_id: string | null;
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
    reminded_at_ms: number | null;
    reminded_via: string | null;
    stalled_at_ms: number | null;
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
type ExternalRequestRow={
    request_id:string;agent_name:string;target_session_id:number;target_input_id:string;requested_effect:string;
    status:string;outcome:string|null;created_at_ms:number;reminded_at_ms:number|null;reminded_via:string|null;
    hook_offered_run:string|null;stalled_at_ms:number|null;
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
    peers?: SessionPeers;
};
type WorkDisposition = 'completed' | 'failed' | 'needs_decision';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * Every new ChatGPT request ends with this, so no asking agent can forget it. Tejas, 2026-10-09:
 * "if there's any code missing, any context missing, any database, data model, architecture ...
 * the agent should ask for more context ... Even if it's absent we get back some sort of a
 * response and we can fill those gaps." The asker answers in the same ChatGPT conversation.
 */
/**
 * The line itself lives in the skills catalog, where every agent can read and improve it
 * (model-selection-skill/references/chatgpt-request-line.md, between its markers); it is read on
 * every request so an edit applies at once. Tejas, 2026-10-09: "let's make that system like more
 * visible ... an agent should know that, if there's any recurring issues happening ... they
 * should be able to update the prompt." This constant is only the fallback when the file is gone.
 */
export const CHATGPT_REQUEST_LINE_FILE = '/root/workspace/skills/model-selection-skill/references/chatgpt-request-line.md';
export function chatgptRequestLine(): string {
    try {
        const text = readFileSync(CHATGPT_REQUEST_LINE_FILE, 'utf8');
        const line = /<!-- line:start -->\s*([^]*?)\s*<!-- line:end -->/.exec(text)?.[1]?.trim();
        if (line) return line;
    } catch {}
    return CHATGPT_ASK_FOR_CONTEXT;
}
export const CHATGPT_ASK_FOR_CONTEXT = 'Before you answer: if anything you would need is missing from this message and its files (code, the data model, database schema, architecture, logs, constraints, or any other context), list exactly what is missing and ask for it. Still give your best answer with what you have, and say which parts depend on the missing pieces. I will send what you ask for in this same conversation.';
const action = (value: string) => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error('A stable source-scoped action_id is required.'); return value; };
const text = (value: string) => { if (typeof value !== 'string' || !value.trim())
    throw new Error('A nonempty message is required.'); return value; };
/** A reply or post is a message: words, files, or both. Only an empty one is refused. */
const message = (value: string, attached: boolean) => {
    if (typeof value !== 'string') throw new Error('Message text must be text.');
    if (!value.trim() && !attached) throw new Error('Add a message or at least one attachment.');
    return value;
};
type AttachedFile = { name: string; contentType: string; base64: string };
const files = (value: unknown): AttachedFile[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((file: any) => typeof file?.name !== 'string' || typeof file?.contentType !== 'string' || typeof file?.base64 !== 'string'))
        throw new Error('Files must contain named attachment bytes.');
    return value as AttachedFile[];
};
/** Durable conversations admitted only by the common native session owner. */
/** A one-line summary: what an exchange says, shown before its body. */
export function oneLineSummary(value:unknown):string {
    const line=typeof value==='string'?value.trim():'';
    if(!line||line.includes('\n')||line.length>200)throw new Error('--summary is one line of at most 200 characters saying what this says.');
    return line;
}
/**
 * What the asker is woken with: the answer's summary first, then its body, or only the summary and how
 * to open the body when the asker chose --answer-view summary (Engelbart's view control: the reader
 * picks the level of detail). Opening a body costs the asker another model call, so summaries-only is
 * the asker's choice per request, never imposed.
 */
export function answerView(request:{request_id:string;payload_json:string},answer:{text?:string;summary?:string}) {
    const summary=answer.summary?`Summary: ${answer.summary}`:null;
    if(summary&&JSON.parse(request.payload_json).answerView==='summary')
        return `${summary}\nFull answer: router-actions.sh sessions get ${request.request_id} <source-flags>`;
    return summary?`${summary}\n\n${answer.text??''}`:answer.text??'';
}

export class SessionCommunicationCoordinator {
    private readonly tasks = new Map<string, Promise<void>>();
    private readonly again = new Set<string>();
    private reconciliation: Promise<void> | null = null;
    private reconciliationDirty = false;
    private startupReconciled = false;
    private stopped = true;
    private disarm: (() => void) | null = null;
    private detach: (() => void) | null = null;
    private readonly now: () => number;
    constructor(private readonly dependencies: Dependencies) { this.now = dependencies.now ?? Date.now; }
    /**
     * Authority belongs to the run doing the work, not to whichever of its messages opened it.
     * A question that opened the turn does not take away the work Tejas gave the same run: the
     * request is carried on the run's earliest message that holds work authority (his own, or a
     * work request). A run holding only questions stays information-only, which is what keeps a
     * question from being turned into a work order further down the chain.
     */
    private authority(actor: Actor): {actor: Actor; scope: 'informational' | 'work'} {
        if (!actor.inputId) return {actor, scope: 'work'};
        const scope = (input: AcceptedSessionInput) => sessionInputProvenance(input)?.effectScope === 'informational' ? 'informational' : 'work';
        if (scope(getAcceptedSessionInput(actor.inputId)!) === 'work') return {actor, scope: 'work'};
        const holder = (db.query("SELECT * FROM session_inputs WHERE turn_id=? AND session_id=? AND origin IN ('human','agent') ORDER BY rowid").all(actor.turn, actor.session) as AcceptedSessionInput[])
            .find(input => input.id !== actor.inputId && scope(input) === 'work');
        return holder ? {actor: {...actor, inputId: holder.id, source: {...actor.source, input_id: holder.id}}, scope: 'work'} : {actor, scope: 'informational'};
    }
    /** Whether the addressed or new session can be given work at all (not ChatGPT, consultation-only or archive history). */
    private receivesWork(input: {address?: string; provider?: string; peer?: string}) {
        if (input.provider !== undefined) return input.provider !== 'chatgpt';
        if (input.peer !== undefined || !input.address || this.dependencies.peers?.splitAddress(input.address)) return true;
        const session = getSessionById(this.address(input.address).session);
        if (!session) return true;
        const metadata = sessionMetadata(session);
        return session.provider_id !== 'chatgpt' && metadata.interactionPolicy !== 'consultation-only'
            && !(metadata.origin === 'imported' && !this.dependencies.owner?.canSend(session));
    }
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
        return !!session && this.dependencies.owner.canSend(session);
    }
    private peerActor(actor: Actor): PeerActor {
        return {session:actor.session,turn:actor.turn,inputId:actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id};
    }
    peersOrNull(): SessionPeers | null { return this.dependencies.peers ?? null; }
    private peers(): SessionPeers {
        if (!this.dependencies.peers) throw new Error('No peer Concierge instance is configured on this runtime.');
        return this.dependencies.peers;
    }
    externalAsk(input:{name:string;address:string;action_id:string;text:string;requestedEffect?:'work'|'informational'}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        if(!/^[a-z][a-z0-9-]{2,40}$/.test(input.name))throw new Error('Invalid outside agent name.');
        action(input.action_id);text(input.text);
        const effect=input.requestedEffect??'informational';
        if(effect!=='work'&&effect!=='informational')throw new Error('Invalid requested effect.');
        const target=this.address(input.address,true),session=getSessionById(target.session)!;
        if(session.provider_id==='chatgpt'||sessionMetadata(session).interactionPolicy==='consultation-only'&&effect==='work')
            throw new Error('This recipient cannot take an outside work request.');
        const digest=hash(JSON.stringify([input.address,input.text,effect]));
        const prior=()=>db.query('SELECT * FROM session_external_requests WHERE agent_name=? AND action_id=?').get(input.name,input.action_id) as any;
        const existing=prior();
        if(existing){if(existing.payload_hash!==digest)throw new Error('Idempotency conflict.');this.dependencies.owner.dispatch(getAcceptedSessionInput(existing.target_input_id)!);return this.externalGet(input.name,existing.request_id);}
        const id=randomUUID(),targetInputId=`request:${id}`;
        db.transaction(()=>{
            const raced=prior();
            if(raced){if(raced.payload_hash!==digest)throw new Error('Idempotency conflict.');return;}
            const firstInput={text:`Session request ${id} from outside agent ${input.name}. This is agent-authored input, not a human message. Requested effect: ${effect}. Close it with sessions reply ${id}${effect==='work'?' --work-disposition completed|failed|needs_decision':''} --summary "<one line>". ${REQUEST_PROTOCOL_POINTER}\n\n${input.text}`,requestedEffect:effect,delivery:'queue'};
            retainSessionInput({id:targetInputId,sessionId:session.id,scope:`external:${input.name}`,actionId:input.action_id,kind:'input',origin:'agent',payload:firstInput,requestId:id});
            db.query(`INSERT INTO session_external_requests(request_id,agent_name,action_id,target_session_id,target_input_id,requested_effect,text,payload_hash,created_at_ms)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(id,input.name,input.action_id,session.id,targetInputId,effect,input.text,digest,this.now());
        })();
        this.dependencies.owner.dispatch(getAcceptedSessionInput(targetInputId)!);
        this.wake();
        return this.externalGet(input.name,(prior() as any).request_id);
    }
    externalGet(name:string,id:string) {
        if(!/^[a-z][a-z0-9-]{2,40}$/.test(name))throw new Error('Invalid outside agent name.');
        const row=db.query('SELECT * FROM session_external_requests WHERE request_id=? AND agent_name=?').get(id,name) as any;
        if(!row)throw new Error('Unknown outside request.');
        const accepted=getAcceptedSessionInput(row.target_input_id);
        const observed=accepted?readInputExecution(accepted):null;
        const terminal=observed&&['completed','failed','canceled','uncertain'].includes(observed.state);
        return {request_id:id,from:`Outside agent · ${name}`,status:!row.outcome&&row.stalled_at_ms?'stalled':!row.outcome&&terminal?'awaiting-explicit-reply':row.status,outcome:row.outcome,
            target_session_id:`concierge:${row.target_session_id}`,target_input_id:row.target_input_id,
            stalled_at_ms:row.stalled_at_ms,
            execution:observed?{state:observed.state,acknowledged_at:observed.acknowledgedAt}:null,
            result:row.result_json?JSON.parse(row.result_json):null,
            events:(db.query('SELECT event_id,payload_json,final,created_at_ms FROM session_external_replies WHERE request_id=? ORDER BY created_at_ms').all(id) as any[])
                .map(event=>({event_id:event.event_id,final:!!event.final,payload:JSON.parse(event.payload_json),created_at_ms:event.created_at_ms}))};
    }
    private externalReply(input:{source:CommunicationSource;action_id:string;request_id:string;text:string;final:boolean;workDisposition?:WorkDisposition;attachments?:string[];files?:AttachedFile[];evidence?:unknown[];hand_back?:string}) {
        const request=db.query('SELECT * FROM session_external_requests WHERE request_id=?').get(input.request_id) as any;
        if(!request)return null;
        const priorKey=input.source.input_id?JSON.stringify(['input',input.source.input_id,input.action_id])
            :input.source.channel_id?JSON.stringify([input.source.channel_id,input.source.message_ts,input.action_id]):null;
        const committed=priorKey?db.query('SELECT * FROM session_external_replies WHERE action_key=?').get(priorKey) as any:null;
        if(committed){
            const saved=JSON.parse(committed.payload_json);
            if(committed.request_id!==input.request_id||saved.text!==input.text||!!committed.final!==input.final||saved.workDisposition!==input.workDisposition)
                throw new Error('Idempotency conflict: outside reply changed.');
            return this.externalGet(request.agent_name,request.request_id);
        }
        const actor=this.actor(input.source);
        if(actor.session!==request.target_session_id)throw new Error('Only the recipient session can reply.');
        if(!getAcceptedSessionInput(request.target_input_id)?.turn_id)throw new Error('This request has not been delivered to the recipient yet.');
        action(input.action_id);message(input.text,!!(input.attachments?.length||files(input.files).length));
        if(typeof input.final!=='boolean')throw new Error('Specify whether this is a final answer.');
        if(input.final&&request.requested_effect==='work'&&!input.workDisposition)throw new Error('A final work reply needs a disposition.');
        if(input.workDisposition&&(!input.final||request.requested_effect!=='work'))throw new Error('A work disposition requires a final work reply.');
        const key=actor.inputId?JSON.stringify(['input',actor.inputId,input.action_id])
            :JSON.stringify([actor.source.channel_id,actor.source.message_ts,input.action_id]);
        const prior=db.query('SELECT * FROM session_external_replies WHERE action_key=?').get(key) as any;
        if(prior)return this.externalGet(request.agent_name,request.request_id);
        if(request.outcome)throw new Error('This outside request already has a final reply.');
        const sourceInputId=actor.inputId??this.peerActor(actor).inputId;
        const attachments=this.retainAttachments(sourceInputId,input.action_id,'reply-file',input);
        const payload={text:input.text,final:input.final,responding_session_id:`concierge:${actor.session}`,
            ...(input.workDisposition?{workDisposition:input.workDisposition}:{}),...(attachments.length?{attachments}:{}),
            ...(input.evidence?{evidence:input.evidence}:{})};
        const eventId=randomUUID();
        db.transaction(()=>{
            db.query('INSERT INTO session_external_replies(event_id,request_id,action_key,payload_json,final,created_at_ms) VALUES(?,?,?,?,?,?)')
                .run(eventId,request.request_id,key,JSON.stringify(payload),input.final?1:0,this.now());
            if(input.final){
                const outcome=input.workDisposition==='failed'?'failed':input.workDisposition==='needs_decision'?'decision_needed':'answered';
                db.query("UPDATE session_external_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?")
                    .run(outcome,JSON.stringify({...payload,event_id:eventId}),request.request_id);
            }
            const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
                payload:{...payload,sourceInputId,sourceRunId:nativeRunId(actor.turn)},sourceInputId,sourceRunId:nativeRunId(actor.turn),requestId:request.request_id}).input;
            db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId}),operation.id);
        })();
        return this.externalGet(request.agent_name,request.request_id);
    }
    /**
     * Custody for the files a reply or post carries, retained before the action is
     * acknowledged. Own bytes are uploaded under an action identity derived from the
     * source input, action ID and position, so a retry of the same action reuses the same
     * custody and different bytes conflict instead of silently sending a second copy.
     * A custody ID a caller names grants nothing by itself: unknown IDs are refused here.
     */
    private retainAttachments(sourceInputId: string, actionId: string, scope: string,
        input: { attachments?: string[]; files?: AttachedFile[] }): string[] {
        const owner = this.dependencies.owner;
        if (!owner) throw new Error('Native session owner is unavailable.');
        const carried = files(input.files);
        if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.some(id => typeof id !== 'string')))
            throw new Error('Attachments must name retained custody IDs.');
        owner.attachments(input.attachments);
        const ids = [...(input.attachments ?? []),
            ...carried.map((file, index) => owner.upload({ name: file.name, contentType: file.contentType, base64: file.base64,
                clientActionId: this.fileAction(sourceInputId, actionId, scope, index) }).attachment.id)];
        owner.attachments(ids);
        return ids;
    }
    private fileAction(sourceInputId: string, actionId: string, scope: string, index: number) {
        return `${scope}:${hash(sourceInputId + ':' + actionId)}:${index}`;
    }
    /**
     * The custody this exact action already retained, read without uploading anything, so a
     * retried reply can be compared with its committed payload before any authority check.
     * Null when the bytes differ or were never retained: that is an idempotency conflict.
     */
    private retainedFileCustody(sourceInputId: string, actionId: string, scope: string, carried: AttachedFile[]): string[] | null {
        const ids: string[] = [];
        for (const [index, file] of carried.entries()) {
            const row = db.query('SELECT id,name,content_type,sha256 FROM session_attachments WHERE action_id=?')
                .get(this.fileAction(sourceInputId, actionId, scope, index)) as { id: string; name: string; content_type: string; sha256: string } | null;
            if (!row || row.name !== file.name || row.content_type !== file.contentType
                || row.sha256 !== createHash('sha256').update(Buffer.from(file.base64, 'base64')).digest('hex')) return null;
            ids.push(row.id);
        }
        return ids;
    }
    /**
     * The routing facts beside each local candidate (session-fit.ts), for the topic this caller works
     * on: its named Inbox thread, else the topic of the human message its own work started from.
     */
    private withWorkload<T extends {session?:any}>(entries:T[],actor:Actor,thread:unknown):(T&{workload?:unknown})[] {
        const source=getSessionById(actor.session)!;
        const named=thread!==undefined&&sessionMetadata(source).inbox?inboxRequestThread(source,thread):null;
        const topic=topicOf(topicRootFor(named,actor.inputId));
        return entries.map(entry=>{
            const local=typeof entry.session?.id==='string'?/^concierge:(\d+)$/.exec(entry.session.id):null;
            const session=local?getSessionById(Number(local[1])):null;
            return session?{...entry,workload:sessionWorkload(session,entry.session.execution,topic)}:entry;
        });
    }
    async search(input: {
        source: CommunicationSource;
        concepts: string[];
        limit?: number;
        peer?: string;
        thread?: string;
    }) {
        const actor = this.actor(input.source);
        if (!Array.isArray(input.concepts) || input.concepts.length < 1 || input.concepts.length > 8
            || input.concepts.some(value => typeof value !== 'string' || !value.trim()))
            throw new Error('Use one to eight nonempty search concepts.');
        if (input.peer !== undefined) return this.peers().search(input.peer, input.concepts, input.limit);
        if (!this.dependencies.owner) throw new Error('Common session discovery is unavailable.');
        const local = () => this.dependencies.owner.search({query:input.concepts.join(' '),limit:input.limit}, actor.inputId ? undefined : {
            beforeTs:actor.source.message_ts!,excludeChannel:actor.source.channel_id!,excludeRootTs:actor.root!
        });
        // One search for every machine: where this machine has no meaning index (the Mac), the
        // machine that has one runs the whole search, which already covers this machine's sessions
        // through the archive and a live word search here. Only when that machine cannot be reached
        // does this one search on its own, and the answer says so.
        const hub = this.dependencies.peers?.meaningHub();
        let found:any = null;
        if (hub) {
            try { found = await this.dependencies.peers!.searchThrough(hub, input.concepts, input.limit); }
            catch (error) {
                const fallback:any = await this.dependencies.peers!.federatedSearch(local, input.concepts, input.limit);
                found = {...fallback,coverage:{...fallback.coverage,complete:false,omissions:[...(fallback.coverage?.omissions??[]),`The search on ${hub} could not be reached (${error instanceof Error?error.message:String(error)}); these results match words on this machine and whatever ${hub} answered directly.`]}};
            }
        }
        // Sessions live on several instances; discovery covers all of them unless one was named.
        found ??= await (this.dependencies.peers ? this.dependencies.peers.federatedSearch(local, input.concepts, input.limit) : local());
        return {...found,results:this.withWorkload(found.results??[],actor,input.thread)};
    }
    /** The whole search from this machine, for a peer that searches through it. */
    searchEverywhere(query: string, limit?: number) {
        const local = () => this.dependencies.owner.search({query, limit});
        return this.dependencies.peers ? this.dependencies.peers.federatedSearch(local, [query], limit) : local();
    }
    async context(input: {
        source: CommunicationSource;
        address: string;
        thread?: string;
    }) {
        const actor = this.actor(input.source);
        const remote = this.dependencies.peers?.splitAddress(input.address);
        if (remote) {
            const peers = this.dependencies.peers!;
            try { return await peers.context(remote.peer, remote.address); }
            catch (error) {
                if (!(error instanceof PeerError && error.kind === 'unreachable')) throw error;
                return peers.offlineContext(remote.peer, remote.address, address => this.dependencies.owner.context({address}));
            }
        }
        const address = this.address(input.address);
        const context:any = await this.dependencies.owner.context({address:sessionAddress(getSessionById(address.session)!)});
        return this.withWorkload([context],actor,input.thread)[0];
    }
    async projects(input:{source:CommunicationSource;peer?:string}) {
        this.actor(input.source);
        if(input.peer!==undefined)return this.peers().projects(input.peer);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        return this.dependencies.owner.projects();
    }
    async peerInventory(input:{source:CommunicationSource}) {
        this.actor(input.source);
        if(!this.dependencies.peers)return {self:null,peers:[]};
        return this.dependencies.peers.inventoryWithReachability();
    }
    /**
     * The end-of-turn hook asks this when an agent tries to stop: Claude Code's and Codex's Stop
     * hook run the same script, which names the provider and its own conversation (`session_id` in
     * the hook input). The session whose turn is running on that conversation is the one asking;
     * a conversation with no running Concierge turn owes nothing, which is what every Codex or
     * Claude run outside Concierge sees. `offer` names the requests the hook has just shown the
     * agent; `remind`, sent when the agent comes back because of a Stop hook, records exactly those
     * as reminded, so the stall that follows if it still does not reply says so.
     */
    owed(input:{provider:string;provider_session_id:string;offer?:string[];remind?:boolean}) {
        const running=db.query(`SELECT session.id AS session_id,turn.id AS turn_id,turn.accepted_input_id FROM sessions session
            JOIN turns turn ON turn.session_id=session.id WHERE session.provider_id=? AND session.agent_session_uuid=?
            AND turn.status IN ('running','delivering') ORDER BY turn.id DESC LIMIT 1`).get(input.provider,input.provider_session_id) as {session_id:number;turn_id:number;accepted_input_id:string|null}|null;
        if(!running?.accepted_input_id)return {owed:[] as OwedRequest[],waiting:false,source:null};
        const runId=nativeRunId(running.turn_id);
        const source={input_id:running.accepted_input_id,run_id:runId};
        if(waitingOnLiveRequest(running.session_id))return {owed:[] as OwedRequest[],waiting:true,source};
        const owed:OwedRequest[]=[];
        for(const request of db.query(`SELECT * FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL AND stalled_at_ms IS NULL
            AND source_input_id IS NOT NULL AND target_input_id IS NOT NULL AND created_at_ms>=? ORDER BY rowid`).all(running.session_id,REMINDERS_SINCE_MS) as RequestRow[]) {
            if(!getAcceptedSessionInput(request.target_input_id!)?.turn_id||this.currentFinal(request.request_id))continue;
            const effect=JSON.parse(request.payload_json).requestedEffect??'informational';
            if(input.offer?.includes(request.request_id))db.query('UPDATE session_communication_requests SET hook_offered_run=? WHERE request_id=?').run(runId,request.request_id);
            if(input.remind)db.query("UPDATE session_communication_requests SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),request.request_id,runId);
            owed.push({request_id:request.request_id,requester:`concierge:${request.source_session_id}`,requested_effect:effect,command:replyCommand(request.request_id,effect)});
        }
        owed.push(...(this.dependencies.peers?.owedDeliveries(running.session_id,runId,{offer:input.offer??[],remind:!!input.remind})??[]));
        for(const request of db.query(`SELECT * FROM session_external_requests
            WHERE target_session_id=? AND outcome IS NULL AND stalled_at_ms IS NULL AND created_at_ms>=? ORDER BY created_at_ms`)
            .all(running.session_id,REMINDERS_SINCE_MS) as ExternalRequestRow[]) {
            if(!getAcceptedSessionInput(request.target_input_id)?.turn_id)continue;
            if(input.offer?.includes(request.request_id))db.query('UPDATE session_external_requests SET hook_offered_run=? WHERE request_id=?').run(runId,request.request_id);
            if(input.remind)db.query("UPDATE session_external_requests SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),request.request_id,runId);
            owed.push({request_id:request.request_id,requester:`Outside agent · ${request.agent_name}`,
                requested_effect:request.requested_effect,command:replyCommand(request.request_id,request.requested_effect)});
        }
        return {owed,waiting:false,source};
    }
    /**
     * How much allowance each provider has left on this machine, and when the account in
     * use is expected to run out. It is a read: it recommends nothing, changes nothing and
     * never dispatches. The router asked for the signal so it can choose where to send new
     * work; deciding that is its job, not this one's.
     */
    usage(input:{source:CommunicationSource}) {
        this.actor(input.source);
        return {providers:(['claude-code','codex'] as const).map(provider=>usageSignal(provider))};
    }
    /**
     * A session names itself, and may correct that name later. It used to be one-shot, so a
     * session that had been given a bad name — by itself earlier, or by whoever created it —
     * was stuck with it on his screen: "Threads: his messages and readable headers" stayed
     * there through three refused corrections from the session it belonged to (September 22,
     * 2026). A name Tejas set himself still wins and is never written over.
     */
    /** Moves a session (this one or another on this machine) to a project or a folder inside one; see SessionOwner.moveSession. */
    move(input:{source:CommunicationSource;action_id:string;address:string;project:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);
        action(input.action_id);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        if(!actor.inputId)throw new Error('Moving a session needs a native source input.');
        const target=resolveSessionAddress(input.address);
        return db.transaction(()=>{
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'move-session',session:target.id,project:input.project},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return {session:this.dependencies.owner!.view(getSessionById(target.id)!),...JSON.parse(saved.input.receipt_json??'{}').moved};
            const moved=this.dependencies.owner!.moveSession(target.id,input.project);
            recordSessionEvent({eventId:`moved:${saved.input.id}`,sessionId:target.id,inputId:saved.input.id,kind:'moved',payload:{...moved,by:`concierge:${actor.session}`}});
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',moved}),saved.input.id);
            return {session:this.dependencies.owner!.view(getSessionById(target.id)!),...moved};
        })();
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
            const applied=!humanNamedSession(session.id);
            if(applied&&sessionMetadata(session).title?.trim()!==title) {
                updateSessionMetadata(session.id,{title});
                recordSessionEvent({eventId:`title:${saved.input.id}`,sessionId:session.id,inputId:saved.input.id,turnId:actor.turn,kind:'title',payload:{title}});
            }
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',applied}),saved.input.id);
            return {session:this.dependencies.owner!.view(getSessionById(session.id)!),applied};
        })();
    }
    /**
     * Place an accepted capture into the thread it answers, or take it back out. The Inbox
     * agent decides this: it asked the question and knows whether the recording answers it.
     * The capture keeps its own retained bytes; this records where it belongs, and the
     * latest record wins, so a wrong merge is undone by detaching rather than by rewriting
     * history (Tejas, 2026-09-20: a dictated answer opened its own request row).
     */
    thread(input:{source:CommunicationSource;action_id:string;input_id:string;thread?:string;detach?:boolean}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        const detach=input.detach===true;
        if(detach===(typeof input.thread==='string'&&!!input.thread.trim()))throw new Error('Give either --thread <message id> or --detach.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const session=getSessionById(actor.session)!;
            if(!sessionMetadata(session).inbox)throw new Error('Only the Inbox threads its own captures.');
            const target=getAcceptedSessionInput(input.input_id);
            if(!target||target.session_id!==session.id||target.origin!=='human')throw new Error('Thread placement needs one of this Inbox\'s accepted human inputs.');
            const root=detach?null:inboxThreadRoot(session.id,input.thread!);
            if(!detach&&!root)throw new Error('That --thread is not a message in this Inbox.');
            if(root===target.id)throw new Error('A capture cannot continue its own thread.');
            const saved=retainSessionInput({sessionId:session.id,scope:`communication:${sourceInputId}`,actionId:input.action_id,kind:'action',origin:'agent',
                payload:{kind:'thread-link',inputId:target.id,...(detach?{detach:true}:{thread:input.thread})},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            const receipt={inputId:target.id,attached:!detach,...(detach?{}:{thread:input.thread,root})};
            if(saved.duplicate)return {threadLink:receipt,duplicate:true};
            recordSessionEvent({eventId:`thread-link:${saved.input.id}`,sessionId:session.id,inputId:target.id,turnId:actor.turn,kind:'thread_link',
                payload:{...receipt,routedBy:{kind:'agent',sessionId:`concierge:${actor.session}`,inputId:sourceInputId,runId:nativeRunId(actor.turn)}}});
            // Which thread a message belongs to just changed; topic membership is resolved from it.
            invalidateTopicRoots();
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',threadLink:receipt}),saved.input.id);
            return {threadLink:receipt,duplicate:false};
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
    post(input:{source:CommunicationSource;action_id:string;thread:string;text:string;topic?:string;keep_working?:boolean;attachments?:string[];files?:AttachedFile[]}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        const carried=files(input.files);
        // A post carrying files is a message even without words: the mockups are the answer.
        const text=message(typeof input.text==='string'?input.text.trim():input.text,!!(carried.length||input.attachments?.length));
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
            // A named topic must be the one the thread is in; a post cannot be filed under another.
            if(input.topic){const placed=db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(rootInputId) as {topic_id:string}|null;
                if(placed&&placed.topic_id!==input.topic)throw new Error(`That message is in thread ${placed.topic_id}, not ${input.topic}. Nothing was posted.`);}
            // Custody is retained before the post is recorded, so an accepted post always
            // names files the owner already holds.
            const attachments=carried.length||input.attachments?.length
                ?this.retainAttachments(sourceInputId,input.action_id,'post-file',input)
                :[];
            const saved=retainSessionInput({sessionId:session.id,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'thread-post',thread:input.thread,text,
                    ...(input.topic?{topic:input.topic}:{}),...(input.keep_working?{keepWorking:true}:{}),...(attachments.length?{attachments}:{})},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            const messageId=`post:${saved.input.id}`;
            const receipt={messageId,thread:input.thread,inputId:rootInputId,...(attachments.length?{attachments}:{})};
            if(saved.duplicate)return {post:receipt,duplicate:true};
            recordSessionEvent({eventId:messageId,sessionId:session.id,inputId:rootInputId,turnId:actor.turn,kind:'post',
                payload:{text,replyToMessage:{kind:'message',sessionId:`concierge:${session.id}`,messageId:input.thread},postedBy:saved.input.id,...(attachments.length?{attachments}:{})}});
            // Post and release: a deliberate reply ends the router's declared work on the
            // inputs it covers, unless it said it keeps working.
            const topic=input.keep_working?null:releaseFocusForPost(session,rootInputId,input.topic??null);
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',post:receipt}),saved.input.id);
            return {post:{...receipt,...(topic?{topicId:topic.topicId}:{})},duplicate:false};
        })();
    }
    /** A live session declares its turn's outcome as a retained, retry-safe action. */
    outcome(input:{source:CommunicationSource;action_id:string;outcome:DeclaredTurnOutcome;text?:string;quiet_because?:string;his_words?:string;why_not_answered?:string;only_he_can?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        if(!actor.inputId)throw new Error('Outcome requires an exact native source input and run.');
        if(!['done','response','needs_you','failed'].includes(input.outcome))throw new Error('Invalid turn outcome.');
        const stated=typeof input.text==='string'?input.text.trim():'';
        if(input.outcome==='done'&&input.text!==undefined)throw new Error('done takes no text.');
        if(input.outcome!=='done'&&!stated)throw new Error(`${input.outcome} requires text.`);
        if(input.outcome!=='needs_you'&&(input.his_words!==undefined||input.why_not_answered!==undefined||input.only_he_can!==undefined))
            throw new Error('--his-words, --why-not-answered and --only-he-can belong to needs_you: they say why only he can answer.');
        const content=input.outcome==='needs_you'
            ?questionForTejas({actorInputId:actor.inputId,question:stated,hisWords:input.his_words,whyNotAnswered:input.why_not_answered,onlyHeCan:input.only_he_can}):stated;
        const quiet=typeof input.quiet_because==='string'?input.quiet_because.trim():'';
        if(quiet&&input.outcome!=='done')throw new Error('--quiet-because belongs to done: it says why he need not read the answer.');
        // Silence about his own message is never the router's judgement alone: `done` on a turn
        // that answers something he sent needs the reason he need not read it, as a field.
        if(input.outcome==='done'&&!quiet&&answersHisOwnMessage(actor.session,actor.inputId))throw new Error(QUIET_REASON_REQUIRED);
        // A turn opened by another agent's return or request into a thread owes that thread a
        // post: its closing text never shows there, so an outcome declared without a post
        // would leave the answer nowhere he looks (2026-09-24, two hours).
        const owed=threadOwedByTurn(getSessionById(actor.session)!,actor.inputId);
        if(owed&&input.outcome!=='failed'&&!turnPostedInto(actor.session,actor.turn,owed))
            throw new Error(`This turn answers another agent's message in a thread, and its closing text never shows there. Post the answer first: sessions post --thread ${owed} --action-id <A> -- <the answer for Tejas>. Then declare the outcome.`);
        return db.transaction(()=>{
            this.actor({input_id:actor.inputId,run_id:nativeRunId(actor.turn)});
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'turn-outcome',outcome:input.outcome,text:content||null,...(quiet?{quiet}:{})},
                sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}'),duplicate:true};
            if(turnDeclaredByAction(actor.turn))
                throw new Error('This turn already declared its outcome by action.');
            recordTurnOutcome({eventId:`turn_outcome:action:${saved.input.id}`,sessionId:actor.session,turnId:actor.turn,
                inputId:actor.inputId,outcome:input.outcome,text:content||null,refuseUnreadable:true,quiet:quiet||null});
            const receipt={state:'completed',outcome:input.outcome,inputId:actor.inputId};
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(receipt),saved.input.id);
            return {...receipt,duplicate:false};
        })();
    }
    /**
     * `sessions topics …`: the Inbox's own commands over its topics, their requests, the
     * questions waiting on Tejas and what the router says it is working on. Authority is
     * the same as every other agent command — one admitted live run of the calling session
     * — and session-topics.ts decides what that session is allowed to do with it.
     */
    topics(input:{source:CommunicationSource;verb:string;action_id?:string;[key:string]:any}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
        return topicsCommand({sessionId:actor.session,turnId:actor.turn,inputId:sourceInputId,runId:nativeRunId(actor.turn)},input);
    }
    async note(input:{source:CommunicationSource;action_id:string;captureId:string;summary?:string;addTo?:string;person?:string;journal?:'entry'|'checkin'}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
        return this.dependencies.owner.saveInboxNote({sourceInputId,sourceRunId:nativeRunId(actor.turn),sourceSessionId:actor.session,actionId:input.action_id,...(typeof input.summary==='string'?{summary:input.summary}:{}),...(typeof input.addTo==='string'?{addTo:input.addTo}:{}),...(typeof input.person==='string'?{person:input.person}:{}),...(input.journal==='entry'||input.journal==='checkin'?{journal:input.journal}:{}),captureId:input.captureId});
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
        if (this.dependencies.peers && !this.local(input.request_id) && (this.dependencies.peers.owns(input.request_id) || this.dependencies.peers.hasDelivery(input.request_id)))
            return this.dependencies.peers.get(this.peerActor(actor), input.request_id);
        const row = this.row(input.request_id);
        if (actor.session !== row.source_session_id && actor.session !== row.target_session_id)
            throw new Error('Request is outside this session.');
        return this.receipt(row);
    }
    private local(requestId:string) { return !!db.query('SELECT 1 FROM session_communication_requests WHERE request_id=?').get(requestId); }
    inspect(requestId:string) {
        if (this.dependencies.peers && !this.local(requestId)) {
            if (this.dependencies.peers.owns(requestId)) return this.dependencies.peers.inspect(requestId);
            if (this.dependencies.peers.hasDelivery(requestId)) return this.dependencies.peers.inspectDelivery(requestId);
        }
        return this.receipt(this.row(requestId));
    }
    /**
     * The request's receipt, or null when no table here knows the id. A ledger row that names
     * a request must never take a whole receipts read down with it: a project set-up's return
     * and three Mac requests the peer table has since dropped carry ids the communication table
     * never held, and every read of the Inbox's receipts was refused over them from 2026-09-28
     * until 2026-10-01 ("Request receipts could not be loaded." on his phone).
     */
    find(requestId:string) {
        // A receipt reads the conversation's outcome, result, events and execution, never its target
        // session's view; building that view for each of the Inbox's 232 open requests on every
        // two-second poll held the owner for seconds at a time on 2026-10-07.
        if (this.local(requestId)) return this.receipt(this.row(requestId), false);
        if (this.dependencies.peers?.owns(requestId)) return this.dependencies.peers.inspect(requestId);
        if (this.dependencies.peers?.hasDelivery(requestId)) return this.dependencies.peers.inspectDelivery(requestId);
        return null;
    }
    cancel(input:{source:CommunicationSource;request_id:string;action_id:string}) {
        const actor=this.actor(input.source);
        action(input.action_id);
        if (this.dependencies.peers && !this.local(input.request_id) && this.dependencies.peers.owns(input.request_id))
            return this.dependencies.peers.cancel(this.peerActor(actor), input.request_id, input.action_id);
        const row=this.row(input.request_id);
        if(row.source_session_id!==actor.session)throw new Error('Only the requesting session can cancel this request.');
        db.transaction(()=>{
            if(actor.inputId) {
                const retained=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'cancel',origin:'agent',
                    payload:{requestId:row.request_id,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:row.request_id});
                if(retained.duplicate)return;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),retained.input.id);
            }
            if(!row.outcome)this.settle(row,'canceled','The requesting session canceled this request. The worker is told to stop.');
            // A request never handed to its recipient must not reach it later through another path.
            if(row.target_input_id)db.query("UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),'$.state','canceled'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL AND steering_id IS NULL AND json_extract(coalesce(receipt_json,'{}'),'$.state') IS NULL").run(row.target_input_id);
        })();
        // A worker already holding it is told to stop (the FIPA cancel reaches the participant).
        if(!row.outcome&&row.target_input_id&&this.row(row.request_id).outcome==='canceled')
            tellWorkerCanceled(this.dependencies.owner!,{requestId:row.request_id,workerSessionId:row.target_session_id,targetInputId:row.target_input_id,requester:sessionLabel(row.source_session_id)});
        return this.receipt(this.row(row.request_id));
    }
    private receipt(row: RequestRow, withTarget = true) {
        const binding = this.binding(row);
        const execution = binding?.turn_id ? db.query('SELECT status,provider_turn_id,provider_input_acknowledged_at FROM turns WHERE id=?').get(binding.turn_id) as any : null;
        const steering = binding?.input_kind === 'steering' ? binding.steering_id
            ? db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE id=?').get(binding.steering_id) as any
            : db.query('SELECT status,provider_sent_at FROM turn_steering_messages WHERE turn_id=? AND slack_user_msg_ts=?').get(binding.turn_id, binding.message_ts) as any : null;
        const legacyPending = !row.outcome && (!row.source_input_id || !row.target_input_id);
        return { request_id: row.request_id, status: legacyPending ? 'uncertain' : row.status,
            ...(legacyPending ? {error:'Legacy delivery requires owner reconciliation; no request or return has been replayed.'} : {}), outcome: row.outcome, source_session_id: `concierge:${row.source_session_id}`,
            target_address:sessionAddress(getSessionById(row.target_session_id)!),
            ...(withTarget ? { target: this.dependencies.owner?.view(getSessionById(row.target_session_id)!) } : {}),
            target_session_id: `concierge:${row.target_session_id}`, target_input_id:row.target_input_id,
            operation_id:(db.query("SELECT id FROM session_inputs WHERE request_id=? AND kind='request' ORDER BY rowid LIMIT 1").get(row.request_id) as {id:string}|null)?.id??null,
            routed_request_id: row.routed_request_id, target_turn_id: row.target_turn_id,
            due_at_ms: row.due_at_ms, overdue_at_ms: row.overdue_at_ms, result: row.result_json ? JSON.parse(row.result_json) : null,
            execution: execution ? { turn_id: binding.turn_id, input_kind: binding.input_kind, input_status: steering?.status ?? execution.status, acknowledged_at: steering?.provider_sent_at ?? (binding.input_kind==='turn'?execution.provider_input_acknowledged_at:null) ?? null, provider_turn_id: execution.provider_turn_id } : null,
            events: (db.query('SELECT * FROM session_communication_events WHERE request_id=? ORDER BY rowid').all(row.request_id) as EventRow[])
                .map(event => ({ event_id: event.event_id, kind: event.kind, status: event.status, error: event.error, payload: JSON.parse(event.payload_json), routed_request_id: event.routed_request_id })) };
    }
    saved(input:{source:CommunicationSource;verb:'list'|'start'|'cancel';turn_id?:number;action_id?:string;cursor?:string}) {
        this.actor(input.source);
        if(input.verb==='list')return this.dependencies.owner.savedWorkList(input.cursor??null);
        if(input.verb!=='start'&&input.verb!=='cancel')throw new Error('Choose a saved work action.');
        if(!input.action_id||!Number.isSafeInteger(input.turn_id)||input.turn_id!<1)throw new Error('Name a stable action and exact saved turn.');
        action(input.action_id);
        return this.dependencies.owner.savedWorkControl(input.turn_id!,input.verb==='start'?'start':'drop',{clientActionId:input.action_id});
    }
    /**
     * The Commons board (docs/plans/2026-10-08-commons-board.md): a shared place where sessions discuss
     * in the open. Its source of truth is plain files; the author is this live run's session, and a
     * mention wakes the mentioned session once with a notice. status and sweep are supervisor checks
     * served on this machine's owner socket and need no session.
     */
    async board(input:BoardInput&{source?:CommunicationSource}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const supervisor=input.verb==='status'||input.verb==='sweep';
        let actor:BoardActor|null=null;
        if(input.source||!supervisor) {
            if(!input.source?.input_id)throw new Error('Board commands come from an admitted native run: use --source-input and --source-run.');
            const resolved=this.actor(input.source);
            actor={session:resolved.session,inputId:resolved.inputId!,runId:nativeRunId(resolved.turn)};
        }
        return boardCommand(input,actor,{
            admit:admission=>this.dependencies.owner.admit(admission),
            askPeer:({address,actionId,text,sourceInputId,sourceRunId})=>this.ask({source:{input_id:sourceInputId,run_id:sourceRunId},action_id:actionId,address,text,requestedEffect:'informational'}),
        });
    }
    /**
     * Wake this session once, when a file or directory changes, when a command finishes, or at a
     * deadline (docs/architecture/WATCHES.md). Local to this machine and to the session whose live run
     * asks: this route is served on the owner socket only, never to a peer, and a watch is never forwarded.
     */
    watch(input:{source:CommunicationSource;verb:'file'|'command'|'list'|'cancel';action_id?:string;until?:string;path?:string;argv?:string[];cwd?:string;watch_id?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        if(!input.source?.input_id)throw new Error('A watch is registered from an admitted native run: use --source-input and --source-run.');
        const actor=this.actor(input.source),origin={originInputId:actor.inputId!,originRunId:nativeRunId(actor.turn)};
        if(input.verb==='list')return {watches:listWatches(actor.session)};
        if(!input.action_id)throw new Error('A watch command needs a stable --action-id.');
        action(input.action_id);
        if(input.verb==='cancel'){
            if(!input.watch_id)throw new Error('Name the watch to cancel.');
            return {watch:cancelWatch(actor.session,input.watch_id)};
        }
        if(typeof input.until!=='string'||!input.until.trim())throw new Error('--until is required.');
        if(input.verb==='file'){
            if(typeof input.path!=='string')throw new Error('Name the file or directory to watch.');
            return registerWatch({kind:'file',sessionId:actor.session,...origin,actionId:input.action_id,until:input.until,path:input.path});
        }
        if(!Array.isArray(input.argv)||typeof input.cwd!=='string')throw new Error('A command watch needs --cwd and the command after --.');
        return registerWatch({kind:'command',sessionId:actor.session,...origin,actionId:input.action_id,until:input.until,argv:input.argv,cwd:input.cwd});
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
        /** One line saying what is asked, shown first to the worker and on the Lab page. */
        summary?:string;
        /** How the answer comes back: 'summary' wakes the asker with the answer's one-line summary only; the body is read with sessions get. */
        answer_view?:'summary'|'full';
        peer?:string;
        /** What only the peer machine can do for this work; required to create a session there. */
        machine_need?:string;
        resurrect?:boolean;
        /** The message in the sender's Inbox that this request works for; required from the Inbox. */
        thread?:string;
        /** A session a new one should consult for context; its address is put in the first input. */
        consult?:string;
        saved?:{kind:'scheduled'|'banked';atMs?:number;expiresAtMs?:number;repeatEveryMs?:number};
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting requests.');
        const sender = this.authority(this.actor(input.source));
        const actor = sender.actor;
        action(input.action_id);
        text(input.text);
        const writing=isWritingSession(getSessionById(actor.session)!);
        if(input.requestedEffect==='work'&&writing)throw new Error(WRITING_SESSION_REFUSAL);
        // A request carries its sender's authority unless the sender narrows it to a question:
        // unmarked requests from the lab coordinator arrived information-only and three agents
        // declined to build what Tejas had asked for (2026-10-08).
        if(input.requestedEffect===undefined)input={...input,requestedEffect:writing||!this.receivesWork(input)?'informational':sender.scope};
        if(input.peer!==undefined&&input.provider!==undefined&&!input.machine_need?.trim())throw new Error(MACHINE_NEED_REQUIRED);
        if(input.consult!==undefined) {
            if(!input.provider||input.provider==='chatgpt')throw new Error('--consult points a new coding session at earlier work; it needs --provider.');
            if(typeof input.consult!=='string'||!/^([\w-]+\/)?session:[\w-]+$/.test(input.consult))throw new Error('--consult takes an exact session address from discovery.');
            input={...input,text:`${consultPointer(input.consult)}\n\n${input.text}`};
        }
        // A discovered address already says where the session lives.
        const remote = this.dependencies.peers?.splitAddress(input.address);
        if (input.resurrect && !remote) {
            const continued=await this.dependencies.owner.resurrect({clientActionId:`ask-resurrect:${hash(`${actor.session}:${actor.turn}:${actor.inputId??''}:${input.action_id}`)}`,address:input.address});
            const address=continued.session.address;
            const target=this.dependencies.peers?.splitAddress(address);
            input={...input,address:target?.address??address,peer:target?.peer,resurrect:undefined};
        } else if (remote) {
            if (input.peer !== undefined && input.peer !== remote.peer) throw new Error('The address names a different peer than --peer.');
            if (input.resurrect) {
                // Continue the peer session here, from its archived transcript, as a distinct session.
                const owner = this.dependencies.owner;
                const created = this.dependencies.peers!.resurrect(remote.peer, remote.address, {defaultCwd: owner.defaultCwd,
                    createSession: (provider, metadata) => createNativeSession(provider, metadata as any), bind: (sessionId, provider, uuid) => bindSessionProvider(sessionId, provider, uuid)});
                const local = getSessionById(created.sessionId)!;
                input = {...input, peer: undefined, address: sessionAddress(local), resurrect: undefined};
            } else input = {...input, peer: remote.peer, address: remote.address};
        }
        // The thread this request works for, decided here and recorded on the request, so its
        // returns are filed there whatever input started the turn that sent it.
        const threadRoot=inboxRequestThread(getSessionById(actor.session)!,input.thread);
        const title=normalizeSessionTitle(input.title);
        if(input.saved) {
            if(!input.provider||input.address||input.peer||!title||input.after?.length)
                throw new Error('Saved work needs a newly named local session with no prerequisites.');
            if(input.provider==='chatgpt')throw new Error('Banked and scheduled work needs a coding provider.');
            if(input.saved.kind!=='scheduled'&&input.saved.kind!=='banked')throw new Error('Unknown saved work kind.');
            if(input.saved.kind==='scheduled'&&(!Number.isFinite(input.saved.atMs)||input.saved.atMs!<=Date.now()))
                throw new Error('Scheduled work needs a future time.');
        }
        if(title!==undefined&&!input.provider)throw new Error('A session name requires new session creation.');
        if(input.provider!==undefined||input.peer!==undefined) {
            if(input.provider!==undefined&&(typeof input.provider!=='string'||!input.provider||input.address!==undefined))throw new Error('Choose either an exact session address or an explicit provider for a new session.');
            const sourceSession=getSessionById(actor.session)!;
            if(sourceSession.provider_id==='chatgpt')throw new Error('ChatGPT sessions cannot send outbound session requests.');
            if(sessionMetadata(sourceSession).interactionPolicy==='consultation-only')throw new Error('Consultation-only sessions cannot send requests or replies.');
            const sourceTurn=db.query('SELECT status,provider_admission_intended_at FROM turns WHERE id=?').get(actor.turn) as any;
            if(sourceTurn?.status!=='running'||!sourceTurn.provider_admission_intended_at)throw new Error('Source must identify this admitted input and its exact live run.');
            if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        }
        if(input.peer!==undefined) {
            if(typeof input.peer!=='string'||!input.peer)throw new Error('Name the peer instance exactly; see sessions peers.');
            if(input.after?.length)throw new Error('A peer request cannot wait on this instance\'s requests.');
            if(input.provider===undefined&&(typeof input.address!=='string'||!input.address))throw new Error('A peer request needs the peer\'s exact discovered address or --provider for a new session there.');
            if(input.requestedEffect!==undefined&&!['informational','work'].includes(input.requestedEffect))throw new Error('Requested effect must be informational or work within existing authority.');
            if(input.requestedEffect==='work'&&sessionInputProvenance(getAcceptedSessionInput(actor.inputId!)!)?.effectScope==='informational')
                throw new Error('An informational request cannot delegate work; preserve its originating scope.');
            if(input.attachments!==undefined)this.dependencies.owner?.attachments(input.attachments);
            if(input.files!==undefined&&!Array.isArray(input.files))throw new Error('Files must contain named attachment bytes.');
            if(input.captureId!==undefined&&typeof input.captureId!=='string')throw new Error('Capture ID must name a retained inbox input.');
            return this.peers().ask(this.peerActor(actor),{peer:input.peer,action_id:input.action_id,address:input.address,provider:input.provider,effort:input.effort,project:input.project,title,text:input.text,
                requestedEffect:input.requestedEffect,files:input.files,attachments:input.attachments,captureId:input.captureId,evidence:input.evidence,threadRoot});
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
        if(input.summary!==undefined)input={...input,summary:oneLineSummary(input.summary)};
        if(input.answer_view!==undefined&&!['summary','full'].includes(input.answer_view))throw new Error('--answer-view is summary or full.');
        const extra={...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),...(input.requestedEffect?{requestedEffect:input.requestedEffect}:{})};
        const encoded = JSON.stringify({ ...(input.provider?{provider:input.provider}:{address:input.address}), ...(title===undefined?{}:{title}), text: input.text, after,...extra,...(threadRoot?{thread:threadRoot}:{}),
            ...(input.consult===undefined?{}:{consult:input.consult}),
            ...(input.summary?{summary:input.summary}:{}),...(input.answer_view?{answerView:input.answer_view}:{}),
            ...(input.saved?{saved:input.saved}:{}),
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
        const historical=!!targetSession&&sessionMetadata(targetSession).origin==='imported'&&!this.dependencies.owner?.canSend(targetSession);
        if(target&&!historical&&!this.messageable(target))throw new Error('The exact session is not currently messageable.');
        const consultationOnly=!!targetSession&&sessionMetadata(targetSession).interactionPolicy==='consultation-only';
        const serviceReply=consultationOnly||targetSession?.provider_id==='chatgpt'||input.provider==='chatgpt';
        if(consultationOnly&&input.requestedEffect==='work')throw new Error('This session accepts consultation only — information, no actions.');
        if(historical&&(input.attachments?.length||input.files?.length||input.captureId))throw new Error('Historical consultation cannot inspect attached files.');
        if (target?.session === actor.session)
            throw new Error('A session cannot ask itself to produce a separate answer.');
        // A session given a topic it does not handle yet is told so, with the other topics it is on,
        // so it can judge fit and hand the request back (session-fit.ts). Facts, never a refusal.
        const topicRoot=topicRootFor(threadRoot,actor.inputId);
        let fitNote:string|null=null;
        if(target&&targetSession&&!historical&&!consultationOnly&&targetSession.provider_id!=='chatgpt'&&!takesManySubjects(targetSession)&&input.requestedEffect==='work') {
            const fit=forTopic(targetSession,topicOf(topicRoot));
            if(fit&&!fit.holds)fitNote=newTopicNote(fit);
        }
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
            // ChatGPT has no session tools and answers with its turn, so it gets only the asker's
            // words: given the request protocol it tried to run router-actions.sh (2026-10-09).
            const toChatgpt=input.provider==='chatgpt'||targetSession?.provider_id==='chatgpt';
            const firstInput={text:toChatgpt?(input.provider==='chatgpt'&&!input.effort?.startsWith('tejas:')?`${input.text}

${chatgptRequestLine()}`:input.text):`Session request ${id} from concierge:${actor.session}. This is agent-authored input within the originating human task, not a new human message. Requested effect: ${input.requestedEffect??'informational'}. Close it with sessions reply ${id}${(input.requestedEffect??'informational')==='work'?' --work-disposition completed|failed|needs_decision':''} --summary "<one line>". ${REQUEST_PROTOCOL_POINTER}\n\n${input.summary?`Summary: ${input.summary}\n\n`:''}${fitNote?`${fitNote}\n\n`:''}${input.text}`,...extra,...(serviceReply?{delivery:'queue'}:{})};
            if(input.provider) {
                const created=this.dependencies.owner!.createRequestTarget({sourceInputId:sourceInput!,sourceRunId:nativeRunId(actor.turn),requestId:id,provider:input.provider,effort:input.effort,project:input.project,title,firstInput,saved:input.saved});
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
            const retainedPayload=JSON.stringify({...retainedBody,...extra,address,...(fitNote?{newTopic:true}:{}),...(consultation?{requestedAddress:input.address,consultation:{sourceId:consultation.source.id,sourceVersion:consultation.source.version,branch:consultation.source.branch,boundary:consultation.source.consultation.boundary}}:{})});
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id,topic_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, actor.source.channel_id??null, actor.source.message_ts??null, actor.turn, actor.session, actor.root, input.action_id, selected.session, selected.channel, selected.root, retainedPayload, digest,
                    input.saved?(input.saved.kind==='scheduled'?input.saved.atMs!:now+savedWorkSettings().wait_days*24*60*60_000):now+STILL_WAITING_AFTER_MS,
                    now,sourceInput,`request:${id}`,threadRoot,topicRoot??'');
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
    /**
     * His reply inside an Inbox thread, carried to the agent working on it as a request rather than
     * as a bare message: it closes only by that agent's own `sessions reply`, queues behind a shared
     * agent's current run instead of steering into it, and comes back attributed to the agent. The
     * Inbox router is not woken: each reply is posted into the thread as the agent's words
     * (`postForwardedReply`). Design: thinkering docs/plans/2026-10-07-reply-to-who-asked.md;
     * review by concierge:3756, which ruled out inferring the answer from the agent's closing text.
     */
    forwardReply(input:{inbox:SessionRow;inputId:string;target:{sessionId:string;local:number|null;peer:{peer:string;address:string}|null;title:string|null;topicId:string;root:string};text:string;attachments?:string[]}):string {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actionId=`forward:${input.inputId}`;
        const existing=db.query('SELECT request_id FROM session_communication_requests WHERE source_input_id=? AND action_id=?').get(input.inputId,actionId) as {request_id:string}|null;
        if(existing)return existing.request_id;
        const attachments=input.attachments?.length?input.attachments:[];
        // The schema requires a source turn; a forwarded reply has none, because no router turn
        // carries it. The Inbox's latest turn stands in as the reference and is never read for it.
        const standIn=db.query('SELECT id FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1').get(input.inbox.id) as {id:number}|null;
        if(!standIn)throw new Error('The Inbox has no turn to record this request against.');
        if(input.target.peer) {
            // A session on his Mac takes the same reply by the same rule [decision: mac-sessions-have-parity]:
            // the peer path carries it as a work request under the Inbox's identity, keeps it while the
            // Mac sleeps and hands it over when the Mac wakes (SessionPeers.ask/dispatch), and its
            // answers post into the thread exactly as a server agent's do (SessionPeers.deliver).
            const {peer,address}=input.target.peer;
            const id=peerRequestId(input.inputId,actionId);
            void this.peers().ask({session:input.inbox.id,turn:standIn.id,inputId:input.inputId},{peer,action_id:actionId,address,text:input.text,requestedEffect:'work',
                ...(attachments.length?{attachments}:{}),threadRoot:input.target.root,framing:requestId=>forwardedReplyFraming(requestId,input.text),forwardedReply:{inboxInputId:input.inputId,topicId:input.target.topicId}})
              .then(receipt=>{
                if(receipt.status==='queued_offline')db.query("UPDATE session_inputs SET receipt_json=json_set(receipt_json,'$.statusDetail',json(?)),updated_at=CURRENT_TIMESTAMP WHERE id=?")
                    .run(JSON.stringify({code:'PEER_ASLEEP',message:`Queued until ${peer} wakes; the agent gets it the moment the Mac is back.`,clearsAt:null,automaticRetry:true}),input.inputId);
                log('info','inbox_reply_forwarded',{request_id:id,input_id:input.inputId,peer,target_address:address,topic_id:input.target.topicId,queued:receipt.status==='queued_offline'});
              })
              .catch(error=>{
                db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'failed',forwardedTo:{sessionId:input.target.sessionId,title:input.target.title},
                    error:{code:'FORWARDED_REPLY_NOT_SENT',message:String((error as Error)?.message??error)}}),input.inputId);
                log('warn','inbox_reply_forward_failed',{request_id:id,input_id:input.inputId,peer,error:String((error as Error)?.message??error).slice(0,300)});
              });
            return id;
        }
        const target=getSessionById(input.target.local!);
        if(!target||!this.dependencies.owner.canSend(target))throw new Error('That session cannot take a message right now.');
        const id=randomUUID(),now=this.now();
        const address=sessionAddress(target);
        const firstInput={text:forwardedReplyFraming(id,input.text),...(attachments.length?{attachments}:{})};
        const payload=JSON.stringify({address,text:input.text,after:[],requestedEffect:'work',thread:input.target.root,forwardedReply:{inboxInputId:input.inputId,topicId:input.target.topicId},...(attachments.length?{attachments}:{})});
        db.transaction(()=>{
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id,null,null,standIn.id,input.inbox.id,null,actionId,target.id,null,null,payload,hash(payload),now+STILL_WAITING_AFTER_MS,now,input.inputId,`request:${id}`,input.target.root);
            retainSessionInput({id:`request:${id}`,sessionId:target.id,scope:`session:${input.inputId}`,actionId:`request:${id}`,kind:'input',origin:'agent',payload:firstInput,sourceInputId:input.inputId,requestId:id});
            const operation=retainSessionInput({sessionId:input.inbox.id,scope:`communication:${input.inputId}`,actionId,kind:'request',origin:'human',
                payload:{text:input.text,sourceInputId:input.inputId,targetSessionId:`concierge:${target.id}`,targetAddress:address,requestedEffect:'work',thread:input.target.root,forwardedReply:true}});
            recordSessionEvent({eventId:`request:${id}`,sessionId:input.inbox.id,inputId:operation.input.id,kind:'request',payload:{requestId:id,targetSessionId:`concierge:${target.id}`}});
        })();
        log('info','inbox_reply_forwarded',{request_id:id,input_id:input.inputId,target_session_id:target.id,topic_id:input.target.topicId});
        this.wake();
        return id;
    }
    /**
     * An agent's answer that goes into a thread instead of back to the router as a return: an answer
     * to a reply he wrote in that thread, or the agent's own reply (partial or final, not a hand-back,
     * which the router must act on) to a request the Inbox sent for a thread. Each is posted there as
     * the agent's words the moment it is recorded (a stall on his forwarded reply as a service post),
     * and a final one files what he needs to see; nothing wakes the router. Stalls, hand-backs,
     * information the router asked for itself and the owner's own settlements of the router's
     * requests still return to the router, whose judgement they need.
     */
    private threadAnswer(request:RequestRow,event:EventRow,declared:any):{root:string;forwarded:{inboxInputId:string}|null}|null {
        if(!request.source_input_id)return null;
        const forwarded=JSON.parse(request.payload_json).forwardedReply;
        if(forwarded&&typeof forwarded.inboxInputId==='string')return {root:request.thread_root_input_id??request.source_input_id,forwarded};
        // Information the router asked for itself (who owns this, what is the state) answers the router.
        const work=JSON.parse(request.payload_json).requestedEffect==='work';
        // An answer that already became a return before this road existed keeps its return.
        const agentReply=work&&!event.accepted_input_id&&!!declared.source&&(event.kind==='progress'||event.kind==='final')&&!declared.handBack;
        const inbox=getSessionById(request.source_session_id);
        const root=inboxRequestRoot(db,request.request_id,request.thread_root_input_id);
        if(!agentReply||!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))return null;
        return {root,forwarded:null};
    }
    /**
     * He stopped the run working for one of his threads: the thread gets a quiet service line and
     * nothing wakes the router or files anything for him. On 2026-10-08 the bare "ended with
     * cancelled" return made the router post and file a reading item, and he was notified about
     * an agent he had just stopped. A forwarded reply of his is marked cancelled, not stalled.
     */
    private postHisStop(request:RequestRow,event:EventRow,declared:any):boolean {
        const forwarded=JSON.parse(request.payload_json).forwardedReply;
        const inbox=getSessionById(request.source_session_id);
        const root=inboxRequestRoot(db,request.request_id,request.thread_root_input_id??(forwarded?request.source_input_id:null));
        if(!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))return false;
        const responder=getSessionById(request.target_session_id);
        const title=responder?sessionMetadata(responder).title??null:null;
        postAgentAnswer({inboxSessionId:request.source_session_id,eventId:event.event_id,requestId:request.request_id,root,
            inboxInputId:forwarded?.inboxInputId??root,respondingSessionId:`concierge:${request.target_session_id}`,respondingTitle:title,
            text:`You stopped ${title?`“${title}”`:'this agent'} at ${noticeTime(db,declared.output.stoppedAtMs)}; its work on this ended there.`,
            attachments:[],stalled:true,final:true,workDisposition:null,hisInputId:null});
        if(forwarded?.inboxInputId)db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(JSON.stringify({state:'canceled',forwardedTo:{sessionId:`concierge:${request.target_session_id}`,requestId:request.request_id},stoppedBy:'tejas'}),forwarded.inboxInputId);
        db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=?").run(event.event_id);
        log('info','his_stop_posted_to_thread',{request_id:request.request_id,thread:root});
        return true;
    }
    private postThreadAnswer(request:RequestRow,event:EventRow,declared:any,thread:{root:string;forwarded:{inboxInputId:string}|null}) {
        const responder=getSessionById(request.target_session_id);
        postAgentAnswer({inboxSessionId:request.source_session_id,eventId:event.event_id,requestId:request.request_id,root:thread.root,
            inboxInputId:thread.forwarded?.inboxInputId??thread.root,respondingSessionId:`concierge:${request.target_session_id}`,
            respondingTitle:responder?sessionMetadata(responder).title??null:null,text:String(declared.text??''),
            attachments:Array.isArray(declared.attachments)?declared.attachments as string[]:[],stalled:event.kind==='overdue'||!!declared.stalled,final:event.kind==='final',
            workDisposition:declared.workDisposition??null,hisInputId:thread.forwarded?request.source_input_id:null,quiet:typeof declared.quiet==='string'?declared.quiet:null});
        db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=?").run(event.event_id);
    }
    reply(input: {
        source: CommunicationSource;
        action_id: string;
        request_id: string;
        text: string;
        final: boolean;
        workDisposition?: WorkDisposition;
        evidence?:unknown[];
        attachments?:string[];
        files?:AttachedFile[];
        his_words?:string;
        why_not_answered?:string;
        only_he_can?:string;
        checked?:string;
        not_checked?:string;
        all_done?:boolean;
        /** The receiving session's push-back: not-my-subject or too-loaded, with a failed disposition. */
        hand_back?:string;
        /** One line saying what the reply says, shown before its body to the asker and on the Lab page. */
        summary?:string;
        /** Why Tejas need not read this completed answer: it is posted in his thread but filed for nobody. */
        quiet_because?:string;
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting replies.');
        if(input.summary!==undefined)input={...input,summary:oneLineSummary(input.summary)};
        // What the requester, and through it Tejas, reads: a decision carries his words and why
        // they leave it open; completed work carries what was checked live. Folded into the words
        // so every path that carries a reply (a return, a peer, a digest) carries them too.
        if((input.his_words!==undefined||input.why_not_answered!==undefined||input.only_he_can!==undefined)&&input.workDisposition!=='needs_decision')
            throw new Error('--his-words, --why-not-answered and --only-he-can belong to --work-disposition needs_decision.');
        if((input.checked!==undefined||input.not_checked!==undefined||input.all_done!==undefined)&&input.workDisposition!=='completed')
            throw new Error('--checked, --not-checked and --all-done belong to --work-disposition completed.');
        // A send that went exactly as he asked is not news (Tejas, 2026-10-09: "why do I need a
        // confirmation if it was sent? Just let me know if it was not sent")
        // [decision: sends-notify-only-on-failure]. Only completed work may be quiet: a failure or a
        // question is always his to read.
        const quiet=typeof input.quiet_because==='string'?input.quiet_because.trim().slice(0,2000):'';
        if(input.quiet_because!==undefined&&(!quiet||input.workDisposition!=='completed'))
            throw new Error('--quiet-because goes with --work-disposition completed and says why he need not read it; a failed or needs_decision reply is always his to read.');
        if(input.hand_back!==undefined) {
            if(input.workDisposition!=='failed')throw new Error('--hand-back goes with --work-disposition failed: the request returns to the requester to start fresh.');
            const replier=getAcceptedSessionInput(input.source.input_id??''),session=replier?getSessionById(replier.session_id):null;
            if(!session)throw new Error('--hand-back needs this session\'s exact native source.');
            // A peer session's local address means nothing to a requester on another machine.
            const viaPeer=!!(this.dependencies.peers&&!this.local(input.request_id)&&this.dependencies.peers.hasDelivery(input.request_id));
            input={...input,text:handBackText(input.hand_back,input.text,session,viaPeer?null:sessionAddress(session))};
        }
        const outsideRequest=!!db.query('SELECT 1 FROM session_external_requests WHERE request_id=?').get(input.request_id);
        if(input.workDisposition==='needs_decision'&&!outsideRequest)
            input={...input,text:questionForTejas({actorInputId:input.source.input_id??'',question:input.text,hisWords:input.his_words,whyNotAnswered:input.why_not_answered,onlyHeCan:input.only_he_can})};
        else if(input.workDisposition==='completed')
            input={...input,text:completionWithCheck({text:input.text,checked:input.checked,notChecked:input.not_checked,allDone:input.all_done})};
        if(outsideRequest)
            return this.externalReply(input)!;
        const attached = !!(input.attachments?.length || files(input.files).length);
        if (this.dependencies.peers && !this.local(input.request_id) && this.dependencies.peers.hasDelivery(input.request_id)) {
            // A retry after the run ended returns the committed reply, as for a local request.
            if (input.source.input_id && db.query('SELECT 1 FROM session_peer_replies WHERE action_key=?').get(JSON.stringify(['input', input.source.input_id, input.action_id])))
                return this.dependencies.peers.inspectDelivery(input.request_id);
            const actor = this.actor(input.source);
            action(input.action_id);
            message(input.text, attached);
            if (typeof input.final !== 'boolean')
                throw new Error('Specify whether this is a final answer.');
            if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
            // The replier retains its own custody first; the peer transport carries those exact
            // bytes to the origin, which admits them into its own custody.
            const peer=this.peerActor(actor);
            const attachments=attached?this.retainAttachments(peer.inputId,input.action_id,'reply-file',input):[];
            return this.dependencies.peers.reply(peer, {action_id:input.action_id,request_id:input.request_id,text:input.text,
                final:input.final,workDisposition:input.workDisposition,evidence:input.evidence,...(attachments.length?{attachments}:{}),...(input.hand_back?{handBack:input.hand_back}:{}),...(quiet?{quiet}:{})});
        }
        // A lost socket response may be retried after the provider run ends. The
        // already committed reply is safe to inspect without requiring a live run.
        if (input.source.input_id && input.source.run_id) {
            const key = JSON.stringify(['input', input.source.input_id, input.action_id]);
            const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
            if (prior) {
                const payload = JSON.parse(prior.payload_json);
                const sourceInput = getAcceptedSessionInput(input.source.input_id);
                // Same words, same files, same order: the retained custody of this exact action
                // is read without uploading anything again.
                const retained = attached
                    ? this.retainedFileCustody(input.source.input_id, input.action_id, 'reply-file', files(input.files))
                    : [];
                const attachments = retained && [...(input.attachments ?? []), ...retained];
                if (prior.request_id !== input.request_id || payload.text !== input.text || payload.final !== input.final
                    || payload.workDisposition !== input.workDisposition
                    || JSON.stringify(payload.evidence) !== JSON.stringify(input.evidence)
                    || !attachments
                    || JSON.stringify(payload.attachments) !== JSON.stringify(attachments.length ? attachments : undefined)
                    || payload.source?.input_id !== input.source.input_id || payload.source?.run_id !== input.source.run_id
                    || !sourceInput || payload.responding_session_id !== `concierge:${sourceInput.session_id}`)
                    throw new Error('Idempotency conflict: reply action has a different payload or source.');
                return this.receipt(this.row(input.request_id));
            }
        }
        const actor = this.actor(input.source);
        action(input.action_id);
        message(input.text, attached);
        if (typeof input.final !== 'boolean')
            throw new Error('Specify whether this is a final answer.');
        const request = this.row(input.request_id);
        const requestedEffect = JSON.parse(request.payload_json).requestedEffect;
        if (input.workDisposition !== undefined && (!input.final || requestedEffect !== 'work'
            || !['completed','failed','needs_decision'].includes(input.workDisposition)))
            throw new Error('A work disposition requires a final reply to a work request.');
        // The requester and every dependent act on the disposition, so a work final without one
        // would close the request with nothing anyone can act on (52 did before this rule).
        if (input.final && requestedEffect === 'work' && input.workDisposition === undefined)
            throw new Error('A final reply to a work request needs --work-disposition completed, failed or needs_decision.');
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
        // Exact bytes are retained before this reply is acknowledged, so an accepted answer and
        // its files are one fact; a retry reuses the same custody, and different bytes conflict.
        const attachments = attached
            ? this.retainAttachments(actor.inputId ?? this.peerActor(actor).inputId, input.action_id, 'reply-file', input)
            : [];
        const payload = { text: input.text, final: input.final, source: actor.source, responding_session_id: `concierge:${actor.session}`,
            ...(input.summary?{summary:input.summary}:{}),
            ...(attachments.length?{attachments}:{}),
            ...(input.workDisposition?{workDisposition:input.workDisposition,completionTurnId:actor.turn}:{}),...(input.evidence?{evidence:input.evidence}:{}),
            ...(input.hand_back?{handBack:input.hand_back}:{}),...(quiet?{quiet}:{}) };
        const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
        if (prior) {
            if (prior.request_id !== request.request_id || prior.payload_json !== JSON.stringify(payload))
                throw new Error('Idempotency conflict: reply action has a different payload.');
            return this.receipt(this.row(request.request_id));
        }
        db.transaction(() => {
            // The owner's own inference from a finished turn is not the recipient's word, so a
            // recipient still working past it can answer, and that answer returns to the requester.
            const current = this.currentFinal(request.request_id);
            const inferred = isInferredFinal(current) ? current : null;
            if (this.row(request.request_id).outcome && !inferred)
                throw new Error('This request already has a final disposition.');
            if (input.final && current && !inferred)
                throw new Error('This request already has a final reply awaiting execution confirmation.');
            db.query('UPDATE session_communication_requests SET routed_request_id=?,target_turn_id=?,input_kind=? WHERE request_id=?').run(binding.request_id, binding.turn_id, binding.input_kind, request.request_id);
            const eventId = randomUUID();
            if (input.final && inferred)
                db.query('UPDATE session_communication_events SET superseded_by_event_id=? WHERE event_id=?').run(eventId, inferred.event_id);
            const id = this.event(request, input.final ? 'final' : 'progress', payload, key, eventId);
            if(actor.inputId) {
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'reply',origin:'agent',
                    payload:{text:input.text,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),kind:input.final?'final':'partial',workDisposition:input.workDisposition,evidence:input.evidence,...(attachments.length?{attachments}:{})},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:request.request_id}).input;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed',eventId:id}),operation.id);
            }
            if (input.final) {
                // Declared completion settles when it is written. Waiting for the answering run to end
                // held answers for hours in a session that takes new requests by steering.
                const outcome=input.workDisposition==='failed'?'failed':input.workDisposition==='needs_decision'?'decision_needed':input.workDisposition==='completed'?'answered':requestedEffect==='work'?'undetermined':'answered';
                db.query('UPDATE session_communication_requests SET outcome=?,status=?,result_json=? WHERE request_id=?')
                    .run(outcome,'settled',JSON.stringify({ ...payload, event_id: id }),request.request_id);
                // A final reply declares this turn's outcome until the turn's own structured
                // answer supersedes it. An unclassified work answer declares nothing.
                const declared=input.workDisposition==='completed'?'done':input.workDisposition==='failed'?'failed'
                    :input.workDisposition==='needs_decision'?'needs_you':requestedEffect==='work'?null:'done';
                if(declared&&!turnDeclaredByAction(actor.turn))recordTurnOutcome({eventId:`turn_outcome:reply:${id}`,sessionId:actor.session,turnId:actor.turn,
                    inputId:request.target_input_id!,outcome:declared,text:input.text});
                // The worker no longer needs the answers it asked for on this request's behalf; a
                // needs_decision final keeps them, because that reply is the question.
                if(input.workDisposition)expireQuestionsForFinalReply({workerSessionId:actor.session,requestId:request.request_id,
                    disposition:input.workDisposition,reason:input.text.trim().slice(0,200)});
            }
        })();
        this.wake();
        return this.receipt(this.row(request.request_id));
    }
    /**
     * The worker's turn ended with this request still open. It was held to the protocol by its
     * Stop hook when it tried to end the turn; if nothing will wake it again, tell the requester
     * once that the request stalled. That does not close it (request-liveness.ts).
     */
    private chaseStranded(request: RequestRow, turnId: number, effect: string) {
        const owner = this.dependencies.owner!;
        const next = strandedStep(owner, { requestId: request.request_id, workerSessionId: request.target_session_id,
            createdAtMs: request.created_at_ms, remindedAtMs: request.reminded_at_ms, remindedVia: request.reminded_via, stalledAtMs: request.stalled_at_ms });
        if (next.step !== 'stall')
            return;
        db.transaction(() => {
            const current = this.row(request.request_id);
            if (current.outcome || current.stalled_at_ms !== null)
                return;
            const partial = db.query("SELECT payload_json FROM session_communication_events WHERE request_id=? AND kind='progress' ORDER BY rowid DESC LIMIT 1").get(request.request_id) as { payload_json: string } | null;
            const text = stalledNotice(next.reason, partial ? JSON.parse(partial.payload_json).text : null);
            this.event(request, 'overdue', { text, stalled: true, reason: next.reason });
            db.query('UPDATE session_communication_requests SET stalled_at_ms=? WHERE request_id=?').run(this.now(), request.request_id);
        })();
        log('warn', 'session_request_stalled', { request_id: request.request_id, worker_session_id: `concierge:${request.target_session_id}`, reason: next.reason });
        this.wake();
    }
    /** Outside callers poll their request, so stalling changes only that durable state. */
    private chaseExternalStranded(request:ExternalRequestRow) {
        if(request.outcome||request.stalled_at_ms!==null)return;
        const accepted=getAcceptedSessionInput(request.target_input_id);
        if(!accepted?.turn_id)return;
        const turn=db.query('SELECT status FROM turns WHERE id=?').get(accepted.turn_id) as {status:string}|null;
        if(!turn||['queued','running','delivering'].includes(turn.status))return;
        const next=strandedStep(this.dependencies.owner!,{requestId:request.request_id,workerSessionId:request.target_session_id,
            createdAtMs:request.created_at_ms,remindedAtMs:request.reminded_at_ms,remindedVia:request.reminded_via,stalledAtMs:request.stalled_at_ms});
        if(next.step!=='stall')return;
        const changed=db.query("UPDATE session_external_requests SET status='stalled',stalled_at_ms=? WHERE request_id=? AND outcome IS NULL AND stalled_at_ms IS NULL")
            .run(this.now(),request.request_id).changes;
        if(changed)log('warn','external_session_request_stalled',{request_id:request.request_id,worker_session_id:`concierge:${request.target_session_id}`,reason:next.reason});
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
    /** The request's final that still stands; a superseded inference is history. */
    private currentFinal(requestId: string) {
        return db.query("SELECT * FROM session_communication_events WHERE request_id=? AND kind='final' AND superseded_by_event_id IS NULL").get(requestId) as EventRow | null;
    }
    private event(request: RequestRow, kind: EventRow['kind'], payload: unknown, key: string | null = null, id: string = randomUUID()) {
        db.query('INSERT INTO session_communication_events(event_id,request_id,kind,action_key,payload_json,created_at_ms) VALUES(?,?,?,?,?,?)')
            .run(id, request.request_id, kind, key, JSON.stringify(payload), this.now());
        if(request.source_input_id) {
            recordSessionEvent({eventId:id,sessionId:request.source_session_id,inputId:request.source_input_id,kind:'response',payload:{requestId:request.request_id,kind,...payload as object}});
            const session=getSessionById(request.source_session_id)!;
            updateSessionMetadata(session.id,{generation:(sessionMetadata(session).generation??0)+1});
        }
        return id;
    }
    private settle(request: RequestRow, outcome: string, text: string, output: unknown = null, disposition: WorkDisposition | null = null, attachments: string[] = []) {
        db.transaction(() => {
            if (this.row(request.request_id).outcome)
                return;
            const payload = { outcome, text, output, responding_session_id: `concierge:${request.target_session_id}`,
                ...(attachments.length ? { attachments } : {}),
                ...(disposition ? { workDisposition: disposition } : {}) };
            const final=this.currentFinal(request.request_id);
            if (final) {
                const declared=JSON.parse(final.payload_json);
                if (declared.workDisposition !== 'completed')
                    throw new Error('A final reply already exists for this request.');
                // The result keeps the files that reply carried: they are its answer as much as its words.
                db.query("UPDATE session_communication_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?")
                    .run(outcome,JSON.stringify({...payload,...(declared.attachments?.length?{attachments:declared.attachments}:{}),event_id:final.event_id,declaredDisposition:'completed'}),request.request_id);
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
    /**
     * The prerequisite holding this request for its requester's decision, if any. An
     * outcome without confirmed success waits for that decision, but a request the
     * requester asked after the outcome had reached it is the decision: holding it would
     * wait for a choice already made, with nothing left that could release it.
     */
    private heldPrerequisite(request: RequestRow, dependencies = ((JSON.parse(request.payload_json).after ?? []) as string[]).map(id => this.row(id))) {
        return dependencies.find(dependency => HOLDING_OUTCOMES.includes(dependency.outcome ?? '')
            && !db.query(`SELECT 1 FROM session_inputs outcome JOIN session_inputs ask ON ask.id=?
                WHERE outcome.id=? AND outcome.session_id=ask.session_id AND outcome.rowid<=ask.rowid`)
                .get(request.source_input_id, `return:${JSON.parse(dependency.result_json ?? '{}').event_id}`)) ?? null;
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
        if (this.heldPrerequisite(request, dependencies))
            return;
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
        // Every open request is dispatched on every execution change, so an unchanged binding must
        // not be rewritten: each rewrite is a commit the database's other writers queue behind.
        db.query(`UPDATE session_communication_requests SET routed_request_id=?1,target_turn_id=?2,input_kind=?3,status=?4 WHERE request_id=?5 AND outcome IS NULL
            AND (routed_request_id IS NOT ?1 OR target_turn_id IS NOT ?2 OR input_kind IS NOT ?3 OR status IS NOT ?4)`)
            .run(routed.request_id, routed.turn_id, routed.input_kind, routed.status, request.request_id);
        if (routed.status === 'failed') {
            this.settle(request, 'failed', routed.error ?? 'The target could not receive this request.');
            return;
        }
        if (JSON.parse(request.payload_json).forwardedReply) {
            const input = getAcceptedSessionInput(request.target_input_id)!;
            const observed = readInputExecution(input);
            const responder = getSessionById(request.target_session_id);
            followForwardedReply(request.source_input_id, {sessionId:`concierge:${request.target_session_id}`,requestId:request.request_id,title:responder?sessionMetadata(responder).title??null:null},
                {working:!!observed.acknowledgedAt||['running','delivering'].includes(observed.turn?.status??''),hold:inputHold(input)});
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
        // A partial reply is the recipient saying it is not finished with this request, so a
        // sibling's answer does not cover it: its own final comes later.
        const partial = this.hasNativePartialReply(request);
        const answer = !questionsOnly || partial ? null
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
            // Each sibling returns its own result, so the requester can account for every
            // question it asked. Unproven delivery of this exact question is an uncertainty
            // the requester still has to see.
            this.settle(request, outcome, declared.text, { ...output,
                answered_by_request_id: answer.request_id, shared_turn_requests: shared.length,
                ...(unconfirmed ? { delivery: 'STEERING_DELIVERY_UNCONFIRMED',
                    delivery_note: 'This request steered into the answering turn without provider acknowledgement. Its answer follows that turn’s confirmed completion; receipt of this exact message is not proven.' } : {}) },
                effect === 'work' && !unconfirmed && declared.workDisposition === 'completed' ? 'completed' : null,
                // One answer covering several questions carries its files to each of them.
                declared.attachments ?? []);
            return;
        }
        if (turn.status === 'done') {
            // A request closes only through the recipient's reply command, the requester's cancel,
            // or a failed execution. A turn ending is none of those, however its text is worded:
            // the owner used to read that text as the answer, and between September 16 and 23,
            // 2026 it closed 63 requests that way, 34 of them after the recipient had said with a
            // partial reply that it was not finished; one real answer was then discarded. The
            // request stays open, waiting on that session's final reply; the due-time notice tells
            // the requester when it has waited long. The only exception is a recipient that has no
            // reply command at all (ChatGPT, a consultation-only session): its whole turn is its
            // reply, so a turn dedicated to this one request answers it.
            const answersWithTurn = actual?.provider_id === 'chatgpt'
                || (!!actual && sessionMetadata(actual).interactionPolicy === 'consultation-only');
            const dedicated = turn.accepted_input_id === request.target_input_id && !!turn.provider_input_acknowledged_at
                && routed.input_kind === 'turn' && shared.length === 1 && steeringCount === 0;
            if (answersWithTurn) {
                if (dedicated && turn.agent_text)
                    this.settle(request, effect === 'work' ? 'undetermined' : 'answered', turn.agent_text, output);
                return;
            }
            this.chaseStranded(request, turn.id, effect);
            return;
        }
        // A turn the provider refused is carried on by its continuation, so the request it served
        // stays open for that continuation's reply (following repeated refusals). Settling it failed
        // here closed requests at 2:54 AM on 2026-10-08 whose work then resumed on the account with
        // room, and the eventual answer was refused as already settled.
        let ended: { id: number; status: string } = { id: turn.id, status: turn.status };
        if (turn.status === 'error') {
            const continuationOf = (id: number) => db.query("SELECT t.id,t.status FROM session_inputs i JOIN turns t ON t.id=i.turn_id WHERE i.id=?").get(`turn-continuation:${id}`) as {id:number;status:string}|null;
            let next = continuationOf(turn.id);
            const seen = new Set<number>([turn.id]);
            // Follow the whole chain of refusals; each continuation either carries on or ends.
            while (next && next.status === 'error' && !seen.has(next.id)) {
                seen.add(next.id);
                const after = continuationOf(next.id);
                if (!after) break;
                next = after;
            }
            const terminal = new Set(['done', 'error', 'cancelled']);
            if (next && !terminal.has(next.status)) return;
            if (next && next.status === 'done') { this.chaseStranded(request, next.id, effect); return; }
            if (next) ended = next;
        }
        if (ended.status === 'cancelled') {
            // His own Stop is his choice, not news; any other cancellation is work someone must follow up.
            const stop = stoppedByTejas(ended.id);
            this.settle(request, 'canceled', stop ? stoppedByTejasText(stop.atMs) : cancelledWithoutHisStopText(),
                { ...output, ...(stop ? { stoppedBy: 'tejas', stoppedAtMs: stop.atMs, stopInputId: stop.inputId } : { stoppedBy: 'not-tejas' }) });
            return;
        }
        // The provider's own words say why, so the requester can tell a refused API call from an
        // interrupted run; a bare "ended with error" was read as the release cutting two runs off
        // when Anthropic had refused them for rate limits (September 23, 2026).
        this.settle(request, turn.status === 'cancelled' ? 'canceled' : 'failed', `The recipient execution ended with ${turn.status}${turn.status !== 'cancelled' && turn.agent_text ? `: ${String(turn.agent_text).slice(0, 400)}` : ''}.`, output);
    }
    private async deliver(event: EventRow) {
        if (this.stopped)
            return;
        const request = this.row(event.request_id);
        const declared=JSON.parse(event.payload_json);
        // An agent's answer for a thread goes into that thread as the agent's words, never as a
        // return that would start a router turn.
        const thread=this.threadAnswer(request,event,declared);
        if(thread){this.postThreadAnswer(request,event,declared,thread);return;}
        if(declared.output?.stoppedBy==='tejas'&&this.postHisStop(request,event,declared))return;
        // A progress note wakes nobody: it stays on the request, in the asker's record and in any
        // stalled notice, and the asker learns the outcome from the final. Each wake re-read the
        // asker's whole conversation; one lab session re-read ~860k tokens per note, four times for
        // one note sent to four of its requests (2026-10-08). The Inbox already worked this way.
        if (event.kind === 'progress') {
            db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        // A stall or overdue notice for a request that has since been answered is never delivered:
        // on 2026-10-08 the coordinator read two "stalled" notices after the answers had arrived.
        // Settlement is checked here, at delivery, not only when the notice was written.
        if (event.kind === 'overdue' && this.row(request.request_id).outcome && !event.accepted_input_id) {
            db.query("UPDATE session_communication_events SET status='received',error='Answered before this notice was delivered; not sent.' WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        // The answer withdraws any notice about this request that is admitted but not yet taken up.
        if (event.kind === 'final')
            for (const notice of db.query("SELECT accepted_input_id FROM session_communication_events WHERE request_id=? AND kind='overdue' AND accepted_input_id IS NOT NULL").all(request.request_id) as {accepted_input_id:string}[])
                db.query("UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),'$.state','canceled'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL AND steering_id IS NULL AND json_extract(coalesce(receipt_json,'{}'),'$.state') IS NULL").run(notice.accepted_input_id);
        if (request.source_input_id && request.target_input_id) {
            const source = getSessionById(request.source_session_id);
            if (!source || !this.messageable({session:source.id,channel:null,root:null,native:true})) {
                db.query("UPDATE session_communication_events SET status='held',error='Requester is unavailable, paused or archived; the result is retained.' WHERE event_id=? AND (status IS NOT 'held' OR error IS NOT 'Requester is unavailable, paused or archived; the result is retained.')").run(event.event_id);
                return;
            }
            const payload = declared.workDisposition==='completed' && request.outcome!=='answered'
                ? JSON.parse(request.result_json!) : declared;
            const current = db.query('SELECT * FROM session_communication_events WHERE event_id=?').get(event.event_id) as EventRow;
            // One answer reaches the requester once (sameAnswerGroup): an event already carried by
            // another event's return only follows that return's delivery state.
            if (current.accepted_input_id && current.accepted_input_id !== `return:${event.event_id}`) {
                this.followReturn(current.event_id, current.accepted_input_id);
                return;
            }
            const group = current.accepted_input_id ? { carriedBy: null, joining: [] as EventRow[] } : this.sameAnswerGroup(current, request.source_session_id);
            if (group.carriedBy) {
                db.query('UPDATE session_communication_events SET accepted_input_id=? WHERE event_id=?').run(group.carriedBy, event.event_id);
                this.followReturn(event.event_id, group.carriedBy);
                log('info', 'session_return_merged', { event_id: event.event_id, request_id: request.request_id, carried_by: group.carriedBy });
                return;
            }
            const requestIds = [request.request_id, ...group.joining.map(joined => joined.request_id)];
            recoverUnsentSteeredInput(`return:${event.event_id}`);
            // A retry dispatches the input already recorded; its text named the requests it closed then.
            const existing = getAcceptedSessionInput(`return:${event.event_id}`);
            const accepted = existing ? this.dependencies.owner!.dispatch(existing) : this.dependencies.owner!.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:request.source_input_id,
                sourceRunId:nativeRunId(request.source_turn_id),requestId:request.request_id,
                text:answerNotice({responder:sessionLabel(request.target_session_id),labels:[request,...group.joining.map(joined=>this.row(joined.request_id))].map(row=>requestLabel(row.payload_json)),
                    kind:event.kind,stalled:!!declared.stalled,body:answerView(request,payload),outcome:payload.outcome??null,workDisposition:payload.workDisposition??null,
                    deliveryNote:payload.output?.delivery_note??null,files:Array.isArray(payload.attachments)?payload.attachments.length:0,
                    followUp:(()=>{const responder=getSessionById(request.target_session_id);return responder?sessionAddress(responder):null;})()}),
                // The answer's files travel with it: the requester opens them from its own turn.
                ...(Array.isArray(payload.attachments)&&payload.attachments.length?{attachments:payload.attachments as string[]}:{})});
            for (const joined of group.joining)
                db.query('UPDATE session_communication_events SET accepted_input_id=? WHERE event_id=? AND accepted_input_id IS NULL').run(`return:${event.event_id}`, joined.event_id);
            const observed = readInputExecution(accepted);
            const received = observed.acknowledgedAt || observed.turn?.input_context_received_by_turn_id;
            const unacknowledgedSteering=observed.steering?.status==='ambiguous'&&!observed.steering.provider_sent_at;
            const status = received?'received':unacknowledgedSteering?'uncertain':['failed','uncertain','canceled'].includes(observed.state)?observed.state:accepted.turn_id?'admitted':'held';
            const deliveryError=unacknowledgedSteering?'The provider did not acknowledge this specific return; its linked turn outcome does not prove receipt.':observed.steering?.error??null;
            // Only rows whose state actually changes are written. This runs for every unread return on
            // every coordinator pass, and passes follow every execution change; rewriting unchanged
            // rows cost one synchronous commit each, ~55 a second, and held the owner's loop ~75% of
            // the time with nothing in flight (2026-10-08).
            const error=received?null:deliveryError;
            db.query('UPDATE session_communication_events SET status=?,error=? WHERE accepted_input_id=? AND (status IS NOT ? OR error IS NOT ?)').run(status,error,accepted.id,status,error);
            db.query('UPDATE session_communication_events SET accepted_input_id=?,status=?,error=? WHERE event_id=? AND (accepted_input_id IS NOT ? OR status IS NOT ? OR error IS NOT ?)').run(accepted.id,status,error,event.event_id,accepted.id,status,error);
            return;
        }
        db.query("UPDATE session_communication_events SET status='uncertain',error='Legacy return delivery requires owner reconciliation; no effect has been replayed.' WHERE event_id=? AND status NOT IN ('received','uncertain')").run(event.event_id);
    }
    /**
     * Finals to the same requester that carry the same answer: the same responding session, the
     * same words byte for byte and the same disposition. A worker that answers several requests at
     * once replies to each (every request closes by its own command), and the requester must still
     * receive that answer once: five identical returns started five Inbox turns and put five lines
     * on his screen (2026-09-23). `carriedBy` is a return that already delivered this answer; else
     * `joining` are the not-yet-delivered copies this event's return carries with it. Identical
     * bytes are the test, never similar words.
     */
    private sameAnswerGroup(event: EventRow, requesterSessionId: number): { carriedBy: string | null; joining: EventRow[] } {
        if (event.kind !== 'final') return { carriedBy: null, joining: [] };
        const answer = sameAnswerKey(event.payload_json);
        if (!answer) return { carriedBy: null, joining: [] };
        const candidates = (db.query(`SELECT event.* FROM session_communication_events event JOIN session_communication_requests request ON request.request_id=event.request_id
            WHERE request.source_session_id=? AND event.kind='final' AND event.event_id<>? AND event.created_at_ms>=?
              -- A copy the owner already posted into a thread has reached its destination; no return carries it.
              AND NOT (event.status='received' AND event.accepted_input_id IS NULL) ORDER BY event.rowid`)
            .all(requesterSessionId, event.event_id, event.created_at_ms - 60 * 60 * 1000) as EventRow[])
            .filter(candidate => sameAnswerKey(candidate.payload_json) === answer);
        const carrier = candidates.find(candidate => candidate.accepted_input_id === `return:${candidate.event_id}`);
        return carrier ? { carriedBy: carrier.accepted_input_id, joining: [] }
            : { carriedBy: null, joining: candidates.filter(candidate => !candidate.accepted_input_id) };
    }
    /** An event carried by another event's return takes that return's delivery state. */
    private followReturn(eventId: string, inputId: string) {
        const input = getAcceptedSessionInput(inputId);
        if (!input) return;
        const observed = readInputExecution(input);
        const received = observed.acknowledgedAt || observed.turn?.input_context_received_by_turn_id;
        const status = received ? 'received' : ['failed','uncertain','canceled'].includes(observed.state) ? observed.state : input.turn_id ? 'admitted' : 'held';
        db.query('UPDATE session_communication_events SET status=? WHERE event_id=? AND status IS NOT ?').run(status, eventId, status);
    }
    /**
     * The sender hears at once when the work it asked for is parked on the recipient's
     * provider: a sign-in that failed or a usage limit. The work stays queued and runs by itself
     * when the hold clears; the sender may cancel and send it elsewhere. On 2026-10-04 an Inbox
     * request to a Codex session sat "queued" for thirty minutes behind a dead Codex sign-in, and
     * the sender learned nothing until the generic overdue note. One note per request, as its
     * overdue note, so the thirty-minute one does not repeat it.
     */
    private inspectProviderHold(request: RequestRow) {
        const now = this.now();
            const input = getAcceptedSessionInput(request.target_input_id!);
            const hold = input ? inputHold(input) : null;
            if (!hold) return;
            const forwarded=!!JSON.parse(request.payload_json).forwardedReply;
            db.transaction(() => {
                const current = this.row(request.request_id);
                if (current.outcome || current.overdue_at_ms !== null) return;
                if(!forwarded)this.event(request, 'overdue', { text:heldRequestNotice(hold), health: `held: ${hold.code}`, held: hold.code });
                db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
            })();
    }
    private inspectOverdueRequest(request: RequestRow) {
        const now = this.now();
            if (!request.source_input_id || !request.target_input_id) return;
            const binding = this.binding(request);
            const turn = binding?.turn_id ? db.query('SELECT status,owner_instance_id,stop_requested_at FROM turns WHERE id=?').get(binding.turn_id) as any : null;
            // Work in progress under a live owner is not a stall. Wait another interval rather
            // than report a healthy run as one; its answer settles this request when it ends.
            const healthy = turn?.status === 'running' ? !turn.stop_requested_at && !!turn.owner_instance_id && this.dependencies.isOwnerAlive(turn.owner_instance_id)
                : turn?.status === 'done' && this.recipientStillWorking(request, ['running']);
            // A Concierge update holds new starts and yields running work for a few minutes. Work
            // waiting only for that is not stalled, so look again after the update instead.
            // A recipient waiting on its own request to another session, or on a watch, is working through it, not stalled.
            // A ChatGPT answer that is still being written past this point tells its asker once, in
            // plain words, that it is delayed and still coming (Tejas, 2026-10-09: "at least the agent
            // will be notified that this is getting delayed"). Pro answers often take this long.
            if (healthy && getSessionById(request.target_session_id)?.provider_id === 'chatgpt') {
                const summary = request.payload_json ? (JSON.parse(request.payload_json) as {summary?: string; title?: string}) : {};
                const what = summary.summary ?? summary.title ?? 'your question';
                db.transaction(() => {
                    if (this.row(request.request_id).outcome || this.row(request.request_id).overdue_at_ms !== null) return;
                    this.event(request, 'overdue', { text: `ChatGPT is still writing its answer to "${what}" after ${STILL_WAITING_MINUTES} minutes. Pro answers can take an hour. It will arrive here by itself when it is done; nothing needs to be resent.`, health: 'still being answered by ChatGPT' });
                    db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
                })();
                return;
            }
            if (healthy || updateDraining() || (turn?.status === 'done' && waitingOnDependency(request.target_session_id, request.created_at_ms, false))) {
                db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
                    .run(now + STILL_WAITING_AFTER_MS, request.request_id);
                return;
            }
            const held = turn ? null : this.heldPrerequisite(request);
            const health = held ? `held for your decision, because prerequisite ${held.request_id} ended ${held.outcome}; cancel this request or ask again without it`
                : turn?.stop_requested_at ? 'deliberately stopped' : turn?.status === 'running'
                ? 'native owner unavailable; exact recovery evidence is required'
                : turn?.status === 'done' ? `concierge:${request.target_session_id} ended its turn without a final reply; the request stays open until that session replies or you cancel it`
                : turn?.status ?? binding?.status ?? 'waiting for admission';
            // Several questions held by one recipient turn are one piece of work, so they
            // report one stall between them instead of one stall each.
            const reported = binding?.turn_id && this.sharedTurnRequests(binding.turn_id)
                .some(sibling => sibling.request_id !== request.request_id && sibling.source_session_id === request.source_session_id
                    && !!db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='overdue' LIMIT 1").get(sibling.request_id));
            db.transaction(() => {
                if (this.row(request.request_id).outcome || this.row(request.request_id).overdue_at_ms !== null)
                    return;
                if (!reported)
                    this.event(request, 'overdue', { text: `This request has no confirmed answer after ${STILL_WAITING_MINUTES} minutes. It remains recorded and has not been sent again. The agent that sent it can inspect its progress and decide what to do next.`, health });
                db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
            })();
    }
    /** One durable record is the fairness boundary; a Promise microtask does not yield to I/O. */
    private async scanRows<T>(table: string, sql: string, visit: (row: T) => void, ...args: (number | string)[]) {
        const query = db.query(sql);
        const highWater = (db.query(`SELECT max(rowid) AS value FROM ${table}`).get() as { value: number | null }).value ?? 0;
        let cursor = 0;
        while (!this.stopped) {
            const row = query.get(...args, highWater, cursor) as (T & { reconciliation_rowid: number }) | null;
            if (!row) return;
            cursor = row.reconciliation_rowid;
            visit(row);
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
    private async scanExternalRequests() {
        const query = db.query(`SELECT rowid AS reconciliation_rowid,* FROM session_external_requests
            WHERE outcome IS NULL AND stalled_at_ms IS NULL AND created_at_ms>=?
              AND rowid<=? AND (created_at_ms>? OR (created_at_ms=? AND rowid>?))
            ORDER BY created_at_ms,rowid LIMIT 1`);
        const highWater = (db.query('SELECT max(rowid) AS value FROM session_external_requests').get() as { value: number | null }).value ?? 0;
        let createdAt = REMINDERS_SINCE_MS, cursor = 0;
        while (!this.stopped) {
            const row = query.get(REMINDERS_SINCE_MS, highWater, createdAt, createdAt, cursor) as (ExternalRequestRow & { reconciliation_rowid: number }) | null;
            if (!row) return;
            createdAt = row.created_at_ms;
            cursor = row.reconciliation_rowid;
            this.chaseExternalStranded(row);
            await new Promise<void>(resolve => setImmediate(resolve));
        }
    }
    private async reconcile() {
        let startedPeers = false;
        if (!this.startupReconciled) {
            if (!await releaseLateRetainedReturns(() => this.stopped)) return;
            if (this.stopped) return;
            this.startupReconciled = true;
            this.dependencies.peers?.start();
            // Topic backfill followed retained-return restoration before this sweep yielded.
            const backfill = setTimeout(() => void backfillRequestTopics(() => this.stopped).catch(error => log('warn', 'request_topics_backfill_failed', { error: error instanceof Error ? error.message : String(error) })), 60_000);
            backfill.unref?.();
            startedPeers = true;
        }
        while (this.reconciliationDirty && !this.stopped) {
            this.reconciliationDirty = false;
            if (!startedPeers) this.dependencies.peers?.wake();
            startedPeers = false;
            await this.scanRows<RequestRow>('session_communication_requests', `SELECT r.rowid AS reconciliation_rowid,r.* FROM session_communication_requests r
                JOIN session_inputs i ON i.id=r.target_input_id JOIN turns t ON t.id=i.turn_id
                WHERE r.outcome IS NULL AND r.overdue_at_ms IS NULL AND t.status='queued' AND r.rowid<=? AND r.rowid>?
                ORDER BY r.rowid LIMIT 1`, request => this.inspectProviderHold(request));
            await this.scanRows<RequestRow>('session_communication_requests', `SELECT rowid AS reconciliation_rowid,* FROM session_communication_requests
                WHERE ${AWAITING_INSPECTION} AND due_at_ms<=? AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,
                request => this.inspectOverdueRequest(request), this.now());
            if (this.stopped) break;
            await auditUndeliveredReturns(this.now(), () => this.stopped);
            await this.scanExternalRequests();
            await this.scanRows<RequestRow>('session_communication_requests','SELECT rowid AS reconciliation_rowid,* FROM session_communication_requests WHERE outcome IS NULL AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1',
                request => this.schedule(`ask:${request.request_id}`, () => this.dispatch(this.row(request.request_id))));
            await this.scanRows<EventRow>('session_communication_events',"SELECT rowid AS reconciliation_rowid,* FROM session_communication_events WHERE status NOT IN ('received','retained') AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1",
                event => this.schedule(`event:${event.event_id}`, () => this.deliver(event)));
            if (!this.stopped) this.arm();
        }
    }
    wake() {
        if (this.stopped) return;
        this.reconciliationDirty = true;
        if (this.reconciliation) return;
        this.reconciliation = new Promise<void>(resolve => setImmediate(resolve))
            .then(() => this.reconcile())
            .catch(error => {
                this.reconciliationDirty = false;
                this.disarm?.();
                this.disarm = null;
                this.dependencies.onError(error);
            })
            .finally(() => {
                this.reconciliation = null;
                if (this.reconciliationDirty && !this.stopped) this.wake();
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
        const next = db.query(`SELECT min(due_at_ms) AS due FROM session_communication_requests WHERE ${AWAITING_INSPECTION} AND source_input_id IS NOT NULL AND target_input_id IS NOT NULL`).get() as {
            due: number | null;
        };
        if (next.due === null)
            return;
        const delay = Math.min(24 * 60 * 60_000,Math.max(0, next.due - this.now()));
        if (this.dependencies.arm)
            this.disarm = this.dependencies.arm(() => this.wake(), delay);
        else {
            const timer = setTimeout(() => this.wake(), delay);
            timer.unref();
            this.disarm = () => clearTimeout(timer);
        }
    }
    start() { if (!this.stopped) return;
        this.stopped = false; this.startupReconciled = false;
        this.detach = observeExecutionChanges(() => this.wake());
        this.wake();
    }
    async idle() { do {
        await this.reconciliation;
        await Promise.all([...this.tasks.values()]);
    } while (this.tasks.size || this.reconciliation || this.reconciliationDirty); }
    async stop() { this.stopped = true; this.reconciliationDirty = false; this.detach?.(); this.detach = null; this.disarm?.(); this.disarm = null; await this.reconciliation; await Promise.allSettled([...this.tasks.values()]); await this.dependencies.peers?.stop(); }
}
