import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { db, finishTurn, getChannel, getSessionById, getSlackUserInputClaim, observeExecutionChanges, settleTurnDependencies, SETTLED_EXECUTION_SQL, type SessionRow } from './state';
import { resolveReplySession } from './slack-thread-identity';
import { slackTimestampUs } from './router-search-index';
import { bindSessionProvider, carryingTurn, createNativeSession, enqueueSessionInput, getAcceptedSessionInput, handedToARun, withdrawUnstartedServiceInput, HOLDING_OUTCOMES, humanAuthored, humanNamedSession, isInferredFinal, nativeRunId, normalizeSessionTitle, recordSessionEvent, recoverUnsentSteeredInput, retainSessionInput, retainSlackInput, sessionMetadata, updateSessionMetadata, sessionInputProvenance, type AcceptedSessionInput } from './session-inputs';
import { heldRequestNotice, inputHold, readInputExecution, resolveSessionAddress, sessionAddress, type SessionOwner } from './session-owner';
import { inboxRequestThread, inboxSession, inboxThreadLink, inboxThreadRoot, messageRouteForSource, threadOwedByTurn, turnPostedInto } from './session-inbox';
import {inboxRequestRoot,returnsToRequester,topicRouteAnchor} from './inbox-request-root';
import { followForwardedReply, forwardedReplyFraming } from './session-inbox';
import { requestIdFor as peerRequestId } from './session-peers';
import { expireQuestionsForFinalReply, fileWorkerNeedInThread, fileWorkerNeedWithoutThread, invalidateTopicRoots, linkInboxDispatchWork, postAgentAnswer, recordSessionMessageRoute, releaseFocusForPost, routableMessage, topicOfRoot, topicsCommand, unfiledReceivedInputs } from './session-topics';
import { PeerError, type SessionPeers, type PeerActor } from './session-peers';
import { answersHisOwnMessage, QUIET_REASON_REQUIRED, recordRequesterDecisionReturn, recordTurnOutcome, turnDeclaredByAction, withdrawOpenNeed, type DeclaredTurnOutcome } from './session-turn-outcome';
import {turnRoutedInput} from './inbox-routing-result';
import {sessionAuthor} from './session-message-author';
import { auditUndeliveredReturns, releaseLateRetainedReturns } from './session-return-audit';
import { usageSignal } from './provider-usage-forecast';
import { log } from './log';
import { STEP_ASKS, finishedTodoRefusal, type TodoState } from './question-todos';
import {boundSearchResponse} from './search-response-boundary';
import {saveQueuedTurn,savedWorkSettings} from './saved-work';
import {cancelWatch,listWatches,registerWatch} from './watches';
import {boardCommand,type BoardActor,type BoardInput} from './commons-board-service';
import {notifyAgentPost} from './thread-notifications';
import {acceptHandoff,handoffObligations,proposeHandoff,supersededAddress,supersededBy,withdrawHandoff,withdrawnSuccessor} from './session-handoff';
import {askAsideOnce} from './session-asides';
import {awaitingOutside} from './storage-observation';
import {earlierWorkFor,type EarlierWork} from './request-history';
import { isHisChatGpt } from './aliases';
import {admitChatGptAttachmentCorrection,admitChatGptContextFollowUp,admitChatGptObligation,bindDirectChatGptTaskSource,chatGptAnswerCommand,chatGptObligationForAttempt,classifyLegacyChatGptAsk,holdUnmessageableChatGptAsker,migrateOpenLegacyChatGptAsks,openChatGptObligations,recordChatGptAttemptResult,recordChatGptOriginalRequeued,recordChatGptReturnReceipt,reconcileCanceledChatGptObligations,requireChatGptTaskDisposition,requireChatGptTaskResolved,resolveChatGptAnswer,resolveChatGptTask,resumeMessageableChatGptAsker,withdrawCanceledChatGptAttempt,type ChatGptObligationRow} from './chatgpt-obligations';
import { AWAITING_INSPECTION, PROMPT_ANSWER_REMINDER_MS, PROMPT_ANSWER_OVERDUE_MS, REMINDERS_SINCE_MS, STILL_WAITING_AFTER_MS, STILL_WAITING_MINUTES, updateDraining, replyCommand, reportBackNotice, strandedStep, stalledNotice, tellWorkerCanceled, cancelQueuedWithdrawnRequest, waitingOnLiveRequest, waitingOnDependency, type OwedRequest } from './request-liveness';
import { REQUEST_PROTOCOL_POINTER } from './request-protocol';
import { completionWithCheck, finalClosingLine, leadFirst, NEEDS_YOU_SUMMARY_REQUIRED, questionForTejas } from './answers-to-tejas';
import { answerNotice, requestLabel, sessionLabel, unresolvedRequestReminder } from './session-notices';
import { cancelledWithoutHisStopText, stoppedByTejas, stoppedByTejasText } from './stopped-by-tejas';
import { noticeTime } from './provider-free-notice';
import { endedWorkInPlainWords } from './provider-failures';
import { isWritingSession, takesManySubjects, WRITING_SESSION_REFUSAL } from './session-roles';
import {standingAgent,standingAgentProject,standingAgentSession,bindStandingAgentSession,canOwnStandingWork,STANDING_WORK_REFUSAL} from './standing-agents';
import {sessionProject} from './session-projects';
import {parseMachineNeed} from './machine-need';
import {signInWorkerActionId} from './signin-renewal';
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
    prompt_reminded_at_ms: number | null;
    prompt_answered_at_ms: number | null;
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

/**
 * The to-do a question to Tejas is about. An ask for a sign-in, a secret or a step on his device
 * names it (or says there is none), and a to-do he already finished refuses the question before it
 * can ring him (2026-11-04: he was asked at 2:58 PM for a Spotify invite he had ticked off at
 * 10:20 PM the night before). The routed request API reads the to-do from thnkr.ing before this
 * runs; when thnkr.ing cannot be read the question is accepted, never lost.
 */
const TODO_REQUIRED='This asks him to do a step himself (sign-in, secret or device), so name the to-do it is about: --todo <id> from his to-dos (on the server or a runner: thinkering -s \'http://x/todos/tasks?limit=200\', or curl -s --unix-socket /run/thinkering/session-capabilities.sock with the same URL where thinkering is not found; from the Mac: ssh remote-box curl -s --unix-socket /run/thinkering/session-capabilities.sock with the same URL), or --todo none when no to-do for this step exists. If he already ticked it off, he has done it: do not ask.';
function questionTodo(input:{only_he_can?:string;todo?:string;todo_checked?:TodoState|null|'unavailable'}):string|null {
    const id=typeof input.todo==='string'?input.todo.trim():'';
    if(!id){if(typeof input.only_he_can==='string'&&STEP_ASKS.has(input.only_he_can.trim()))throw new Error(TODO_REQUIRED);return null;}
    if(id==='none')return null;
    if(input.todo_checked===null)throw new Error(`He has no to-do "${id}". Name one of his to-dos by its exact id, or --todo none.`);
    if(input.todo_checked&&input.todo_checked!=='unavailable'){const refusal=finishedTodoRefusal(input.todo_checked);if(refusal)throw new Error(refusal);}
    return id;
}

export class SessionCommunicationCoordinator {
    private readonly tasks = new Map<string, Promise<void>>();
    private readonly forwarding = new Set<string>();
    private readonly again = new Set<string>();
    private reconciliation: Promise<void> | null = null;
    private reconciliationDirty = false;
    private pendingAcceptedRecovery = false;
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
        return session.provider_id !== 'chatgpt' && metadata.interactionPolicy !== 'consultation-only' && !metadata.canvasObservation
            && !(metadata.origin === 'imported' && !this.dependencies.owner?.canSend(session)) && !this.frozenSession(session.id);
    }
    /**
     * A session whose work was handed to a successor keeps its reads and its closing outcome, but
     * every owner write from it is refused with the successor's address (provider-change handoff).
     */
    private fenced(actor: Actor): Actor {
        const next = supersededAddress(actor.session);
        if (next) throw new Error(`This session's work was handed off; its obligations and authority moved to ${next}. Reads and your closing sessions outcome still work.`);
        if (withdrawnSuccessor(actor.session)) throw new Error('This session was proposed as a successor and the handoff was withdrawn; it holds no obligations.');
        return actor;
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
            if (callable && !this.messageable(result)) {
                const next=supersededAddress(session.id);
                if(next)throw new Error(`This session is superseded. Send the request to ${next}.`);
                throw new Error('The exact session is not currently messageable.');
            }
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
    /**
     * A Claude or Codex session Concierge started that is archived or paused (and not handed off):
     * it takes no messages, so its work stays as it was left, but its conversation can still answer
     * a question through a side copy. Before 2026-11-04 asking one failed with "not currently
     * messageable", so its findings were lost to every later agent.
     */
    private frozenSession(sessionId: number) {
        const session = getSessionById(sessionId);
        if (!session || this.dependencies.owner.canSend(session) || supersededBy(sessionId)) return null;
        const meta = sessionMetadata(session);
        if ((meta.origin ?? 'native') !== 'native' || meta.canvasObservation || !['claude-code', 'codex'].includes(session.provider_id) || !session.agent_session_uuid) return null;
        if (session.status !== 'archived' && !meta.suspended) return null;
        return {session, state: session.status === 'archived' ? 'archived' : 'paused'};
    }
    /**
     * What came before, for a work request: Concierge looks it up and the request carries it, so
     * the receiving agent starts from the earlier requests, sessions and diagnosed failures on the
     * same problem (request-history.ts). Questions and ChatGPT get none: they are not repairs.
     */
    private async earlierWork(actor: Actor, input: {summary?: string; text: string; requestedEffect?: string; provider?: string; saved?: unknown},
        topicRoot: string | null, targetSessionId: number | null): Promise<EarlierWork | null> {
        const target = targetSessionId ? getSessionById(targetSessionId) : null;
        if (input.requestedEffect !== 'work' || input.saved || input.provider === 'chatgpt' || target?.provider_id === 'chatgpt'
            || (target && (sessionMetadata(target).interactionPolicy === 'consultation-only' || takesManySubjects(target) || isWritingSession(target)))) return null;
        // A recipient already working this thread holds its history; a follow-up is not a fresh start.
        if (target && topicRoot && db.query(`SELECT 1 FROM session_communication_requests WHERE target_session_id=?
            AND (thread_root_input_id=? OR (topic_root_input_id=? AND thread_root_input_id IS NULL)) LIMIT 1`).get(target.id, topicRoot, topicRoot)) return null;
        const inbox = inboxSession();
        const owner = this.dependencies.owner;
        return earlierWorkFor({summary: input.summary, text: input.text, topicRoot, recipient: targetSessionId, sendingTurn: actor.turn, nowMs: this.now(),
            exclude: [actor.session, ...(targetSessionId ? [targetSessionId] : []), ...(inbox ? [inbox.id] : [])],
            titleOf: id => { const session = getSessionById(id); return session ? (owner?.catalogueLabels(session).title ?? `Session ${id}`) : `Session ${id}`; },
            answerability: id => { try { return this.answerability(id); } catch { return 'how it can be asked is unknown'; } }});
    }
    /** How an earlier session can be asked now, in the words a receiving agent acts on. */
    private answerability(sessionId: number): string {
        const session = getSessionById(sessionId);
        if (!session) return 'no longer exists';
        const address = sessionAddress(session);
        const successor = supersededAddress(sessionId);
        if (successor) return `handed off; asking ${address} reaches the session that continues it, ${successor}`;
        if (this.dependencies.owner.canSend(session))
            return session.provider_id === 'chatgpt' ? `ChatGPT, answers questions but has no tools: ${address}` : `can answer: ask ${address}`;
        const frozen = this.frozenSession(sessionId);
        if (frozen) return `${frozen.state}; a side copy of its conversation answers questions: ask ${address} --requested-effect informational`;
        const view = this.dependencies.owner.view(session);
        if (view.capabilities.consult) return `conversation from outside Concierge; a consultation copy answers questions: ask ${address} --requested-effect informational`;
        return `cannot be asked (${view.capabilities.reason ?? 'no provider can reopen it'}); read it with sessions context ${address}`;
    }
    /**
     * A question to an archived or paused session, answered from a throwaway copy of its
     * conversation (the same copy a side question in thnkr.ing uses): no tools, never saved, and
     * the session itself is not woken or changed. The answer is this command's result; one that
     * takes longer than the command may wait is collected by repeating the same command.
     */
    private async sideCopyAnswer(actor: Actor, input: {action_id: string; text: string; files?: unknown[]; attachments?: unknown[]; captureId?: string}, frozen: {session: SessionRow; state: string}) {
        if (input.files?.length || input.attachments?.length || input.captureId) throw new Error('A side copy answers from the conversation alone; it cannot inspect attached files.');
        const {session} = frozen, meta = sessionMetadata(session);
        const question = input.text.trim().slice(0, 8000);
        const id = `${session.id}:request-side:${hash(`${actor.inputId ?? ''}:${input.action_id}:${question}`)}`;
        const asked = await awaitingOutside(() => askAsideOnce(id, () => ({provider: session.provider_id, sessionUuid: session.agent_session_uuid!,
            cwd: meta.cwd ?? this.dependencies.owner.defaultCwd, model: meta.model ?? null, running: false, passage: '', question, earlier: [],
            agentAsker: `concierge:${actor.session}`}), 90_000));
        const address = sessionAddress(session);
        if (asked.state === 'asking')
            return {state: 'asking', address, answeredBy: 'side copy',
                notice: `This session is ${frozen.state}, so a side copy of its conversation is answering. It has not finished yet: repeat the same command with the same --action-id to collect the answer.`};
        log('info', 'request_side_copy_answered', {session_id: session.id, duration_ms: asked.durationMs});
        return {state: 'answered', address, answeredBy: 'side copy', answer: asked.answer, model: asked.model,
            notice: `This session is ${frozen.state}, so a side copy of its conversation answered (no tools, nothing saved; the session itself was not woken). No request was opened.`};
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
        if(sessionMetadata(session).canvasObservation||session.provider_id==='chatgpt'||sessionMetadata(session).interactionPolicy==='consultation-only'&&effect==='work')
            throw new Error('This recipient cannot take an outside work request.');
        const digest=hash(JSON.stringify([input.address,input.text,effect]));
        const prior=()=>db.query('SELECT * FROM session_external_requests WHERE agent_name=? AND action_id=?').get(input.name,input.action_id) as any;
        const existing=prior();
        if(existing){if(existing.payload_hash!==digest)throw new Error('Idempotency conflict.');this.dependencies.owner.dispatch(getAcceptedSessionInput(existing.target_input_id)!);return this.externalGet(input.name,existing.request_id);}
        const id=randomUUID(),targetInputId=`request:${id}`;
        db.transaction(()=>{
            const raced=prior();
            if(raced){if(raced.payload_hash!==digest)throw new Error('Idempotency conflict.');return;}
            const firstInput={text:`Session request ${id} from outside agent ${input.name}. This is agent-authored input, not a human message. Requested effect: ${effect}. Close it with sessions reply ${id}${effect==='work'?' --work-disposition completed|failed|needs_decision':''} --summary "<one line>". ${REQUEST_PROTOCOL_POINTER}\n\n${input.text}`,requestedEffect:effect};
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
    private externalReply(input:{source:CommunicationSource;action_id:string;request_id:string;text:string;reply_body?:string;final:boolean;workDisposition?:WorkDisposition;openChatGptIds?:string[];attachments?:string[];files?:AttachedFile[];evidence?:unknown[];hand_back?:string}) {
        const request=db.query('SELECT * FROM session_external_requests WHERE request_id=?').get(input.request_id) as any;
        if(!request)return null;
        const priorKey=input.source.input_id?JSON.stringify(['input',input.source.input_id,input.action_id])
            :input.source.channel_id?JSON.stringify([input.source.channel_id,input.source.message_ts,input.action_id]):null;
        const committed=priorKey?db.query('SELECT * FROM session_external_replies WHERE action_key=?').get(priorKey) as any:null;
        if(committed){
            const saved=JSON.parse(committed.payload_json);
            if(committed.request_id!==input.request_id||saved.text!==input.text||saved.replyBody!==input.reply_body||!!committed.final!==input.final||saved.workDisposition!==input.workDisposition)
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
        const payload={text:input.text,...(input.reply_body!==undefined?{replyBody:input.reply_body}:{}),final:input.final,responding_session_id:`concierge:${actor.session}`,
            ...(input.workDisposition?{workDisposition:input.workDisposition}:{}),...(attachments.length?{attachments}:{}),
            ...(input.evidence?{evidence:input.evidence}:{})};
        const eventId=randomUUID();
        db.transaction(()=>{
            if(input.final)requireChatGptTaskDisposition({kind:'external_request',id:request.request_id},input.workDisposition,input.openChatGptIds);
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
        if (input.peer !== undefined) return boundSearchResponse(await this.peers().search(input.peer, input.concepts, input.limit));
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
        return boundSearchResponse({...found,results:this.withWorkload(found.results??[],actor,input.thread)});
    }
    /** The whole search from this machine, for a peer that searches through it. */
    async searchEverywhere(query: string, limit?: number) {
        const local = () => this.dependencies.owner.search({query, limit});
        return boundSearchResponse(await (this.dependencies.peers ? this.dependencies.peers.federatedSearch(local, [query], limit) : local()));
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
    agents(input:{source:CommunicationSource}) {
        this.actor(input.source);
    }
    bindAgent(input:{source:CommunicationSource;action_id:string;role:string;address:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));
        action(input.action_id);
        if(!standingAgent(input.role))throw new Error(`Unknown standing agent role ${input.role}; use sessions agents.`);
        const target=resolveSessionAddress(input.address);
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'bind-standing-agent',role:input.role,address:input.address},
                sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return JSON.parse(saved.input.receipt_json??'{}');
            const session=getSessionById(target.id);
            if(!session)throw new Error('The exact session does not exist.');
            bindStandingAgentSession(this.dependencies.owner.defaultCwd,input.role,session);
            const receipt={state:'completed',role:input.role,binding:'bound',session:{id:`concierge:${session.id}`,address:sessionAddress(session)}};
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(JSON.stringify(receipt),saved.input.id);
            return receipt;
        })();
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
    /**
     * The machine need of the run holding this provider conversation: the newest one among the inputs that
     * run took, its first message or a later request steered into it. The tool guard asks this when its
     * process environment names none: Codex turns all run on one shared App Server, so a per-turn
     * environment never reaches Codex's hook, and no process environment changes when a later request
     * arrives by steering. On 2026-11-02 the Mac's Voice Memos session (mac:258) was created with a mac-app
     * need and its guard saw none, twice.
     */
    macNeed(input:{provider_session_id:string}) {
        const running=db.query(`SELECT turn.id AS turn_id,session.id AS session_id FROM sessions session JOIN turns turn ON turn.session_id=session.id
            WHERE session.agent_session_uuid=? AND turn.status IN ('running','delivering') ORDER BY turn.id DESC LIMIT 1`)
            .get(input.provider_session_id) as {turn_id:number;session_id:number}|null;
        if(!running)return {kind:null};
        let newest=true;
        for(const row of db.query(`SELECT id,payload_json FROM session_inputs WHERE turn_id=? ORDER BY rowid DESC LIMIT 50`).all(running.turn_id) as {id:string;payload_json:string}[]){
            const payload=JSON.parse(row.payload_json);
            const need=payload?.machineNeed??payload?.firstInput?.machineNeed;
            const kind=need?.kind;
            if(typeof kind==='string'&&kind&&(kind!=='provider-renewal'||newest)){
                const accepted=getAcceptedSessionInput(row.id);
                const provenance=accepted?sessionInputProvenance(accepted):null;
                return {kind,why:typeof need.why==='string'?need.why:'',
                    humanInputId:provenance?.originatingHuman?.inputId,effectScope:provenance?.effectScope};
            }
            // A return to the worker carries the original renewal input as its request source.
            // Other turns in the same session never inherit this browser exception.
            if(newest){
                const sources=db.query(`SELECT DISTINCT request.source_input_id FROM session_communication_events event
                    JOIN session_communication_requests request ON request.request_id=event.request_id
                    WHERE event.accepted_input_id=? AND request.source_session_id=?`).all(row.id,running.session_id) as {source_input_id:string}[];
                const sourceInput=sources.length===1?sources[0]!.source_input_id:row.id;
                const peerRenewal=db.query(`SELECT 1 FROM session_peer_deliveries WHERE target_input_id=? AND target_session_id=?
                    AND closed_at_ms IS NULL AND json_extract(origin_provenance_json,'$.machineNeed.kind')='provider-renewal'`)
                    .get(sourceInput,running.session_id);
                if(peerRenewal)return {kind:'provider-renewal'};
                const renewal=db.query(`SELECT action_id FROM session_external_requests WHERE target_input_id=? AND agent_name='signin-renewal' AND outcome IS NULL`).get(sourceInput) as {action_id:string}|null;
                if(renewal){
                    const notices=db.query(`SELECT key FROM repair_notices WHERE kind IN ('claude_signin_expired','codex_signin_expired')`).all() as {key:string}[];
                    if(notices.some(notice=>signInWorkerActionId(notice.key)===renewal.action_id))return {kind:'provider-renewal'};
                }
            }
            newest=false;
        }
        return {kind:null};
    }
    owed(input:{provider:string;provider_session_id:string;offer?:string[];remind?:boolean}) {
        const running=db.query(`SELECT session.id AS session_id,turn.id AS turn_id,turn.accepted_input_id FROM sessions session
            JOIN turns turn ON turn.session_id=session.id WHERE session.provider_id=? AND session.agent_session_uuid=?
            AND turn.status IN ('running','delivering') ORDER BY turn.id DESC LIMIT 1`).get(input.provider,input.provider_session_id) as {session_id:number;turn_id:number;accepted_input_id:string|null}|null;
        if(!running?.accepted_input_id)return {owed:[] as OwedRequest[],unfiled:[],waiting:false,source:null};
        const runId=nativeRunId(running.turn_id);
        const source={input_id:running.accepted_input_id,run_id:runId};
        const unfiled=unfiledReceivedInputs(running.session_id,running.turn_id);
        if(waitingOnLiveRequest(running.session_id))return {owed:[] as OwedRequest[],unfiled,waiting:true,source};
        const owed:OwedRequest[]=[];
        for(const request of db.query(`SELECT * FROM session_communication_requests WHERE target_session_id=? AND outcome IS NULL AND stalled_at_ms IS NULL
            AND source_input_id IS NOT NULL AND target_input_id IS NOT NULL AND created_at_ms>=? ORDER BY rowid`).all(running.session_id,REMINDERS_SINCE_MS) as RequestRow[]) {
            if(!handedToARun(request.target_input_id!)||this.currentFinal(request.request_id))continue;
            const effect=JSON.parse(request.payload_json).requestedEffect??'informational';
            if(input.offer?.includes(request.request_id))db.query('UPDATE session_communication_requests SET hook_offered_run=? WHERE request_id=?').run(runId,request.request_id);
            if(input.remind)db.query("UPDATE session_communication_requests SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),request.request_id,runId);
            owed.push({request_id:request.request_id,requester:`concierge:${request.source_session_id}`,requested_effect:effect,command:replyCommand(request.request_id,effect)});
        }
        owed.push(...(this.dependencies.peers?.owedDeliveries(running.session_id,runId,{offer:input.offer??[],remind:!!input.remind})??[]));
        for(const request of db.query(`SELECT * FROM session_external_requests
            WHERE target_session_id=? AND outcome IS NULL AND stalled_at_ms IS NULL AND created_at_ms>=? ORDER BY created_at_ms`)
            .all(running.session_id,REMINDERS_SINCE_MS) as ExternalRequestRow[]) {
            if(!handedToARun(request.target_input_id))continue;
            if(input.offer?.includes(request.request_id))db.query('UPDATE session_external_requests SET hook_offered_run=? WHERE request_id=?').run(runId,request.request_id);
            if(input.remind)db.query("UPDATE session_external_requests SET reminded_at_ms=?,reminded_via='hook' WHERE request_id=? AND reminded_at_ms IS NULL AND hook_offered_run=?").run(this.now(),request.request_id,runId);
            owed.push({request_id:request.request_id,requester:`Outside agent · ${request.agent_name}`,
                requested_effect:request.requested_effect,command:replyCommand(request.request_id,request.requested_effect)});
        }
        return {owed,unfiled,waiting:false,source};
    }
    /**
     * How much allowance each provider has left on this machine, and when the account in
     * use is expected to run out. It is a read: it recommends nothing, changes nothing and
     * never dispatches. The router asked for the signal so it can choose where to send new
     * work; deciding that is its job, not this one's.
     */
    usage(input:{source:CommunicationSource}) {
        this.actor(input.source);
        return {providers:(['claude-code','codex','antigravity'] as const).map(provider=>usageSignal(provider))};
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
        const actor=this.fenced(this.actor(input.source));
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
    /** Any agent may name any session here; a title Tejas set himself always wins [decision: agents-are-never-handcuffed]. */
    title(input:{source:CommunicationSource;action_id:string;title:string;address?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source)),title=normalizeSessionTitle(input.title);
        action(input.action_id);
        if(!title)throw new Error('A session title is required.');
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const session=input.address?resolveSessionAddress(input.address):getSessionById(actor.session)!;
            if(!session)throw new Error('That session address is unknown here.');
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'self-title',title,...(session.id===actor.session?{}:{session:session.id})},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return {session:this.dependencies.owner!.view(getSessionById(session.id)!),applied:JSON.parse(saved.input.receipt_json??'{}').applied===true};
            const applied=!humanNamedSession(session.id);
            if(applied&&sessionMetadata(session).title?.trim()!==title) {
                updateSessionMetadata(session.id,{title});
                recordSessionEvent({eventId:`title:${saved.input.id}`,sessionId:session.id,...(session.id===actor.session?{inputId:saved.input.id,turnId:actor.turn}:{}),kind:'title',payload:{title,...(session.id===actor.session?{}:{by:`concierge:${actor.session}`})}});
            }
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',applied}),saved.input.id);
            return {session:this.dependencies.owner!.view(getSessionById(session.id)!),applied};
        })();
    }
    /**
     * Place an accepted Inbox message into the thread it answers, or take it back out. Any agent
     * may: the Inbox router, or a worker that knows a message belongs to its thread
     * [decision: agents-are-never-handcuffed].
     * The capture keeps its own retained bytes; this records where it belongs, and the
     * latest record wins, so a wrong merge is undone by detaching rather than by rewriting
     * history (Tejas, 2026-09-20: a dictated answer opened its own request row).
     */
    thread(input:{source:CommunicationSource;action_id:string;input_id:string;thread?:string;detach?:boolean}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        const detach=input.detach===true;
        if(detach===(typeof input.thread==='string'&&!!input.thread.trim()))throw new Error('Give either --thread <message id> or --detach.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            const own=getSessionById(actor.session)!,session=sessionMetadata(own).inbox?own:inboxSession();
            if(!session)throw new Error('No Inbox session exists yet.');
            const router=session.id===own.id;
            const target=getAcceptedSessionInput(input.input_id);
            if(!target||target.session_id!==session.id)throw new Error('Thread placement needs an accepted message in the Inbox.');
            const root=detach?null:inboxThreadRoot(session.id,input.thread!);
            if(!detach&&!root)throw new Error('That --thread is not a message in this Inbox.');
            if(root===target.id)throw new Error('A message cannot continue its own thread.');
            const saved=retainSessionInput({sessionId:own.id,scope:`communication:${sourceInputId}`,actionId:input.action_id,kind:'action',origin:'agent',
                payload:{kind:'thread-link',inputId:target.id,...(detach?{detach:true}:{thread:input.thread})},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            const receipt={inputId:target.id,attached:!detach,...(detach?{}:{thread:input.thread,root})};
            if(saved.duplicate)return {threadLink:receipt,duplicate:true};
            recordSessionEvent({eventId:`thread-link:${saved.input.id}`,sessionId:session.id,inputId:target.id,...(router?{turnId:actor.turn}:{}),kind:'thread_link',
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
    post(input:{source:CommunicationSource;action_id:string;thread:string;text:string;topic?:string;keep_working?:boolean;notify?:boolean;attachments?:string[];files?:AttachedFile[]}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        const carried=files(input.files);
        // A post carrying files is a message even without words: the mockups are the answer.
        const text=message(typeof input.text==='string'?input.text.trim():input.text,!!(carried.length||input.attachments?.length));
        if(input.notify&&!text.trim())throw new Error('--notify requires words in the message being posted.');
        if(typeof input.thread!=='string'||!input.thread.trim())throw new Error('A post needs the exact --thread message ID.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        return db.transaction(()=>{
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            // Any agent may post into an Inbox thread, credited to itself; posts live in the Inbox's
            // ledger-backed history [decision: agents-are-never-handcuffed].
            const own=getSessionById(actor.session)!,session=sessionMetadata(own).inbox?own:inboxSession();
            if(!session)throw new Error('No Inbox session exists yet.');
            const router=session.id===own.id;
            // The owner, not the caller, decides which thread this belongs to. A reply to any
            // message in a thread carries that thread's root forward.
            const rootInputId=inboxThreadRoot(session.id,input.thread);
            if(!rootInputId)throw new Error('That --thread is not a message in this Inbox.');
            // A named topic must be the one the thread is in; a post cannot be filed under another.
            if(input.topic){const placed=db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(rootInputId) as {topic_id:string}|null;
                if(placed&&placed.topic_id!==input.topic)throw new Error(`That message is in thread ${placed.topic_id}, not ${input.topic}. Nothing was posted.`);}
            if(router){
                const opening=getAcceptedSessionInput(sourceInputId);
                if(opening?.origin==='service'&&JSON.parse(opening.payload_json).alreadyPostedInThread===true)
                    throw new Error('The agent already posted this return in its named thread. Do not relay it from the Inbox; nothing was posted.');
            }
            // Custody is retained before the post is recorded, so an accepted post always
            // names files the owner already holds.
            const attachments=carried.length||input.attachments?.length
                ?this.retainAttachments(sourceInputId,input.action_id,'post-file',input)
                :[];
            const saved=retainSessionInput({sessionId:own.id,scope:`communication:${sourceInputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'thread-post',thread:input.thread,text,
                    ...(input.topic?{topic:input.topic}:{}),...(input.keep_working?{keepWorking:true}:{}),...(input.notify?{notify:true}:{}),...(attachments.length?{attachments}:{})},sourceInputId,sourceRunId:nativeRunId(actor.turn)});
            const messageId=`post:${saved.input.id}`;
            const receipt={messageId,thread:input.thread,inputId:rootInputId,...(attachments.length?{attachments}:{})};
            if(saved.duplicate)return {post:receipt,duplicate:true};
            recordSessionEvent({eventId:messageId,sessionId:session.id,inputId:rootInputId,...(router?{turnId:actor.turn}:{}),kind:'post',
                payload:{text,replyToMessage:{kind:'message',sessionId:`concierge:${session.id}`,messageId:input.thread},postedBy:saved.input.id,...(router?{}:{postedBySession:`concierge:${own.id}`}),...(attachments.length?{attachments}:{})}});
            if(input.notify)notifyAgentPost(session.id,rootInputId,messageId,text);
            // Post and release: a deliberate reply ends the router's declared work on the
            // inputs it covers, unless it said it keeps working.
            const topic=input.keep_working||!router?null:releaseFocusForPost(session,rootInputId,input.topic??null);
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',post:receipt}),saved.input.id);
            return {post:{...receipt,...(topic?{topicId:topic.topicId}:{})},duplicate:false};
        })();
    }
    /** A live session declares its turn's outcome as a retained, retry-safe action. */
    outcome(input:{source:CommunicationSource;action_id:string;outcome:DeclaredTurnOutcome;text?:string;quiet_because?:string;summary?:string;his_words?:string;why_not_answered?:string;only_he_can?:string;todo?:string;todo_checked?:TodoState|null|'unavailable';decision_id?:string;approval_action?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        if(!actor.inputId)throw new Error('Outcome requires an exact native source input and run.');
        if(!['done','response','needs_you','failed'].includes(input.outcome))throw new Error('Invalid turn outcome.');
        const stated=typeof input.text==='string'?input.text.trim():'';
        if(input.outcome==='done'&&input.text!==undefined)throw new Error('done takes no text.');
        if(input.outcome!=='done'&&!stated)throw new Error(`${input.outcome} requires text.`);
        if(input.outcome!=='needs_you'&&(input.summary!==undefined||input.his_words!==undefined||input.why_not_answered!==undefined||input.only_he_can!==undefined||input.todo!==undefined||input.decision_id!==undefined||input.approval_action!==undefined))
            throw new Error('Question fields belong to needs_you: they say why only he can answer.');
        // His notice shows the start of the question, so a needs_you opens with the agent's one line.
        let lead='';
        if(input.outcome==='needs_you'){
            if(typeof input.summary!=='string'||!input.summary.trim())throw new Error(NEEDS_YOU_SUMMARY_REQUIRED);
            lead=oneLineSummary(input.summary);
        }
        const todoId=input.outcome==='needs_you'?questionTodo(input):null;
        const content=input.outcome==='needs_you'
            ?questionForTejas({actorInputId:actor.inputId,question:stated,lead,hisWords:input.his_words,whyNotAnswered:input.why_not_answered,onlyHeCan:input.only_he_can,decisionId:input.decision_id,approvalAction:input.approval_action}):stated;
        const quiet=typeof input.quiet_because==='string'?input.quiet_because.trim():'';
        if(quiet&&input.outcome!=='done')throw new Error('--quiet-because belongs to done: it says why he need not read the answer.');
        const routed=turnRoutedInput(db,actor.session,actor.turn,actor.inputId);
        // Silence about his own message is never the router's judgement alone: `done` on a turn
        // that answers something he sent needs a reason unless the route receipt is the answer.
        if(input.outcome==='done'&&!quiet&&answersHisOwnMessage(actor.session,actor.inputId)&&!routed)throw new Error(QUIET_REASON_REQUIRED);
        if(routed&&(input.outcome==='response'||input.outcome==='needs_you')
            &&!turnPostedInto(actor.session,actor.turn,inboxThreadRoot(actor.session,actor.inputId)??actor.inputId))
            throw new Error('The routing receipt already shows the handoff. Post a substantive answer or question into this thread before declaring a response; closing text is never a second thread reply after routing.');
        // A turn opened by another agent's return or request into a thread owes that thread a
        // post: its closing text never shows there, so an outcome declared without a post
        // would leave the answer nowhere he looks (2026-09-24, two hours).
        const owed=threadOwedByTurn(getSessionById(actor.session)!,actor.inputId);
        // A route-only close already appears on that agent-authored source message as a
        // handoff. The ordinary owed-post rule still protects answers and questions.
        if(owed&&input.outcome!=='failed'&&!(input.outcome==='done'&&routed)
            &&!turnPostedInto(actor.session,actor.turn,owed))
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
                inputId:actor.inputId,outcome:input.outcome,text:content||null,todoId,refuseUnreadable:true,quiet:quiet||null});
            const receipt={state:'completed',outcome:input.outcome,inputId:actor.inputId};
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(receipt),saved.input.id);
            // A worker on an Inbox thread waiting on him reaches him through that thread; its own
            // needs_you is left to the Inbox by thnkr.ing, which would otherwise never hear of it.
            if(input.outcome==='needs_you'&&!sessionMetadata(getSessionById(actor.session)!).inbox){
                const need={respondingSessionId:actor.session,turnInputId:actor.inputId!,runId:nativeRunId(actor.turn),eventId:saved.input.id,text:leadFirst(lead,stated),todoId};
                let filed:string|null=null;
                try{filed=db.transaction(()=>fileWorkerNeedInThread(need))();}
                catch(error){log('error','worker_need_thread_filing_failed',{session:actor.session,input:saved.input.id,message:error instanceof Error?error.message:String(error)});}
                if(!filed)fileWorkerNeedWithoutThread(need);
                this.dependencies.peers?.recordTurnNeed(this.peerActor(actor),`turn_outcome:action:${saved.input.id}`,leadFirst(lead,stated));
            }
            return {...receipt,duplicate:false};
        })();
    }
    handleChatGptAnswer(input:{source:CommunicationSource;action_id:string;obligation_id:string;answer_event_id:string;
        handling:'used'|'context_supplied'|'scoped'|'superseded';reason?:string;follow_up_request_id?:string;successor_request_id?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        if(!actor.inputId)throw new Error('Handling a ChatGPT answer needs the exact accepted source input and run.');
        const receipt={obligationId:input.obligation_id,answerEventId:input.answer_event_id,handling:input.handling};
        return db.transaction(()=>{
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'chatgpt-answer-handled',...receipt,reason:input.reason??null,
                    followUpRequestId:input.follow_up_request_id??null,successorRequestId:input.successor_request_id??null},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:input.obligation_id});
            if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}'),duplicate:true};
            resolveChatGptAnswer({obligationId:input.obligation_id,askerSessionId:actor.session,answerEventId:input.answer_event_id,
                actionId:input.action_id,handling:input.handling,reason:input.reason,followUpRequestId:input.follow_up_request_id,
                successorRequestId:input.successor_request_id,sourceInputId:actor.inputId,now:this.now()});
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify(receipt),saved.input.id);
            return {...receipt,duplicate:false};
        })();
    }
    classifyLegacyChatGpt(input:{source:CommunicationSource;action_id:string;request_id:string;for_task:string;
        provider:'chatgpt'|'other';reason:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        if(!actor.inputId)throw new Error('Historical classification needs the asking session’s exact accepted source input and run.');
        return db.transaction(()=>{
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'chatgpt-legacy-classification',requestId:input.request_id,
                    task:input.for_task,provider:input.provider,reason:input.reason},sourceInputId:actor.inputId,
                sourceRunId:nativeRunId(actor.turn),requestId:input.request_id});
            if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}'),duplicate:true};
            const result=classifyLegacyChatGptAsk({requestId:input.request_id,task:input.for_task,provider:input.provider,
                askerSessionId:actor.session,reason:input.reason,now:this.now()});
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(JSON.stringify(result),saved.input.id);
            this.wake();
            return {...result,duplicate:false};
        })();
    }
    /** Resume the original native run only after the capability proves its browser send never
     * happened. The owner checks that proof and requeues the same run, not a new question. */
    async recoverChatGptNeverSent(input:{source:CommunicationSource;action_id:string;request_id:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        if(!actor.inputId)throw new Error('ChatGPT recovery needs the asking session’s exact accepted input and live run.');
        const retainedAction={sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
            kind:'action' as const,origin:'agent' as const,payload:{kind:'chatgpt-never-sent-recovery',requestId:input.request_id},
            sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:input.request_id};
        if(db.query('SELECT 1 FROM session_inputs WHERE scope=? AND action_id=?').get(retainedAction.scope,input.action_id)){
            const previous=retainSessionInput(retainedAction);
            if(!previous.duplicate)throw new Error('The recovery action changed during duplicate lookup.');
            return {...JSON.parse(previous.input.receipt_json??'{}'),duplicate:true};
        }
        const request=this.row(input.request_id);
        const obligation=chatGptObligationForAttempt(input.request_id);
        if(request.source_session_id!==actor.session||!request.target_input_id
            ||!obligation||obligation.active_request_id!==input.request_id||obligation.asker_session_id!==actor.session
            ||['resolved','withdrawn_by_tejas'].includes(obligation.state))
            throw new Error('This asking session has no open obligation for that exact original ChatGPT request.');
        if(getSessionById(request.target_session_id)?.provider_id!=='chatgpt')
            throw new Error('The exact original request does not target a ChatGPT session.');
        const result=await this.dependencies.owner.requeueProvenUnsentChatGpt(request.target_session_id,request.target_input_id);
        const receipt=db.transaction(()=>{
            const saved=retainSessionInput(retainedAction);
            if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}'),duplicate:true};
            recordChatGptOriginalRequeued({requestId:input.request_id,runId:result.runId,now:this.now()});
            const retained={requestId:input.request_id,obligationId:obligation.obligation_id,...result};
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(JSON.stringify(retained),saved.input.id);
            return {...retained,duplicate:false};
        })();
        this.wake();
        return receipt;
    }
    /** The asking session or Inbox router may retire one exact open needs_you, without redeclaring its turn. */
    withdrawAttention(input:{source:CommunicationSource;action_id:string;address:string;need_event_id:string;reason:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);action(input.action_id);
        if(!actor.inputId)throw new Error('Attention withdrawal needs an exact native source input and run.');
        const target=resolveSessionAddress(input.address);
        if(actor.session!==target.id&&!sessionMetadata(getSessionById(actor.session)!).inbox)
            throw new Error('Only the session that asked or the Inbox router can withdraw its needs_you.');
        const reason=input.reason?.trim();
        if(!reason)throw new Error('Attention withdrawal requires a reason.');
        if(reason.length>2000)throw new Error('Attention withdrawal reason is too long.');
        if(!input.need_event_id?.trim())throw new Error('Name the exact open needs_you event.');
        return db.transaction(()=>{
            this.actor({input_id:actor.inputId,run_id:nativeRunId(actor.turn)});
            const saved=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,
                kind:'action',origin:'agent',payload:{kind:'attention-withdrawal',sessionId:target.id,needEventId:input.need_event_id,reason},
                sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn)});
            if(saved.duplicate)return {...JSON.parse(saved.input.receipt_json??'{}'),duplicate:true};
            const receipt=withdrawOpenNeed({sessionId:target.id,needEventId:input.need_event_id,reason,
                bySessionId:actor.session,eventId:`attention_withdrawn:${saved.input.id}`});
            db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(JSON.stringify(receipt),saved.input.id);
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
        const started=performance.now();
        let actorMs=0,sourceMs=0,commandMs=0,completed=false;
        let phaseStart=started,phaseName:'actor'|'source'|'command'|'done'='actor';
        try {
            if(this.stopped)throw new Error('Session communication is not accepting requests.');
            const actor=this.actor(input.source);
            actorMs=performance.now()-phaseStart;
            phaseStart=performance.now();phaseName='source';
            const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
            this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
            sourceMs=performance.now()-phaseStart;
            phaseStart=performance.now();phaseName='command';
            const result=topicsCommand({sessionId:actor.session,turnId:actor.turn,inputId:sourceInputId,runId:nativeRunId(actor.turn)},input);
            commandMs=performance.now()-phaseStart;
            phaseName='done';
            completed=true;
            return result;
        } finally {
            const ended=performance.now(),totalMs=ended-started;
            if(phaseName==='actor')actorMs=ended-phaseStart;
            else if(phaseName==='source')sourceMs=ended-phaseStart;
            else if(phaseName==='command')commandMs=ended-phaseStart;
            if(totalMs>=250)log('warn','inbox_topic_command_slow',{
                action:typeof input.verb==='string'?input.verb:'unknown',
                topic_id:typeof input.topic_id==='string'?input.topic_id:null,
                duration_ms:Math.round(totalMs),actor_ms:Math.round(actorMs),source_ms:Math.round(sourceMs),
                command_ms:Math.round(commandMs),outcome:completed?'completed':'failed'
            });
        }
    }
    async note(input:{source:CommunicationSource;action_id:string;captureId?:string;messageId?:string;summary?:string;addTo?:string;person?:string;journal?:'entry'|'checkin'}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.fenced(this.actor(input.source));action(input.action_id);
        if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        const sourceInputId=actor.inputId??retainSlackInput(actor.source.channel_id!,actor.source.message_ts!).id;
        this.actor({input_id:sourceInputId,run_id:nativeRunId(actor.turn)});
        return this.dependencies.owner.saveInboxNote({sourceInputId,sourceRunId:nativeRunId(actor.turn),sourceSessionId:actor.session,actionId:input.action_id,...(typeof input.summary==='string'?{summary:input.summary}:{}),...(typeof input.addTo==='string'?{addTo:input.addTo}:{}),...(typeof input.person==='string'?{person:input.person}:{}),...(input.journal==='entry'||input.journal==='checkin'?{journal:input.journal}:{}),...(typeof input.messageId==='string'?{messageId:input.messageId}:{captureId:input.captureId})});
    }
    /** Whether a request paced with --after-settled still has to wait for this earlier request. */
    private pacingWaitsOn(id: string): boolean {
        const earlier = this.row(id);
        return !earlier.outcome && earlier.stalled_at_ms === null;
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
    cancel(input:{source:CommunicationSource;request_id:string;action_id:string;reason?:string}) {
        const actor=this.fenced(this.actor(input.source));
        action(input.action_id);
        if(input.reason==='provider-change'){
            const target=(db.query('SELECT target_session_id FROM session_communication_requests WHERE request_id=?').get(input.request_id) as {target_session_id:number}|null)?.target_session_id;
            const address=target?sessionAddress(getSessionById(target)!):this.dependencies.peers?.inspect(input.request_id)?.target_address??'<predecessor-address>';
            throw new Error(`Provider changes keep this request intact. Run sessions handoff '${address}' --provider <alias> --reason "<why>" --source-input <this input> --source-run <this run> --action-id <A> instead.`);
        }
        if (this.dependencies.peers && !this.local(input.request_id) && this.dependencies.peers.owns(input.request_id))
            return this.dependencies.peers.cancel(this.peerActor(actor), input.request_id, input.action_id,input.reason);
        const row=this.row(input.request_id);
        if(row.source_session_id!==actor.session)throw new Error('Only the requesting session can cancel this request.');
        let stoppedQueuedTarget=false;
        db.transaction(()=>{
            if(actor.inputId) {
                const retained=retainSessionInput({sessionId:actor.session,scope:`communication:${actor.inputId}`,actionId:input.action_id,kind:'cancel',origin:'agent',
                    payload:{requestId:row.request_id,sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),
                        ...(input.reason?{reason:input.reason}:{})},sourceInputId:actor.inputId,sourceRunId:nativeRunId(actor.turn),requestId:row.request_id});
                if(retained.duplicate)return;
                db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({state:'completed'}),retained.input.id);
            }
            if(!row.outcome)this.settle(row,'canceled','The requesting session canceled this request. The worker is told to stop.');
            withdrawCanceledChatGptAttempt(row.request_id,this.now());
            // A paused or usage-held worker can already have a queued turn. Withdrawing its
            // request revokes that turn before a later account reset or Continue can claim it.
            if(this.row(row.request_id).outcome==='canceled'&&row.target_input_id)
                stoppedQueuedTarget=cancelQueuedWithdrawnRequest(row.target_input_id);
            if(stoppedQueuedTarget)withdrawUnstartedServiceInput(`canceled:${row.request_id}`,'The request was withdrawn before its worker began.');
        })();
        // A worker already holding it is told to stop (the FIPA cancel reaches the participant).
        if(!stoppedQueuedTarget&&!row.outcome&&row.target_input_id&&this.row(row.request_id).outcome==='canceled')
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
        const actor=this.actor(input.source);
        if(input.verb==='list')return this.dependencies.owner.savedWorkList(input.cursor??null);
        if(input.verb!=='start'&&input.verb!=='cancel')throw new Error('Choose a saved work action.');
        if(!input.action_id||!Number.isSafeInteger(input.turn_id)||input.turn_id!<1)throw new Error('Name a stable action and exact saved turn.');
        action(input.action_id);
        return this.dependencies.owner.savedWorkControl(input.turn_id!,input.verb==='start'?'start':'drop',
            {clientActionId:input.action_id,cancelingSessionId:actor.session});
    }
    async pause(input:{source:CommunicationSource;verb:'status'|'all'|'resume';action_id?:string;session_ids?:string[]}) {
        this.actor(input.source);
        if(input.verb==='status')return this.dependencies.owner.globalPauseStatus();
        if(!input.action_id)throw new Error('Pause or resume needs a stable action ID.');
        action(input.action_id);
        return this.dependencies.owner.globalPauseControl(input.verb==='all',
            {clientActionId:input.action_id,...(input.session_ids?{sessionIds:input.session_ids}:{})});
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
            if(this.dependencies.peers?.self==='mac') {
                const source=actor;
                actor={...source,labProxy:(method,path,body)=>this.dependencies.peers!.client('cloud').request('POST','/sessions/v1/peers/lab',
                    {method,path,inputId:source.inputId,runId:source.runId,...(body===undefined?{}:{body})})};
            }
        }
        return boardCommand(input,actor,{
            admit:admission=>this.dependencies.owner.admit(admission),
            askPeer:({address,actionId,text,sourceInputId,sourceRunId})=>this.ask({source:{input_id:sourceInputId,run_id:sourceRunId},action_id:actionId,address,text,requestedEffect:'informational'}),
        });
    }
    async obligations(input:{source:CommunicationSource;address?:string}) {
        const actor=this.actor(input.source);
        if(!actor.inputId)throw new Error('Obligations require an exact native source input and run.');
        const target=input.address?this.address(input.address).session:actor.session;
        return handoffObligations(actor.session,target,{inputId:actor.inputId,runId:nativeRunId(actor.turn)});
    }
    async handoff(input:{source:CommunicationSource;verb:'propose'|'accept'|'withdraw';address?:string;provider?:string;model?:string;effort?:string;
      reason?:string;session_name?:string;action_id?:string;handoff_id?:string;digest?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const actor=this.actor(input.source);
        if(!actor.inputId)throw new Error('Handoff requires an exact native source input and run.');
        if(input.verb==='propose'){
            this.fenced(actor);
            if(!input.address||!input.provider||!input.reason||!input.action_id)throw new Error('Handoff needs predecessor address, provider, reason and stable action ID.');
            action(input.action_id);
            const proposed=await proposeHandoff({actorSession:actor.session,inputId:actor.inputId,runId:nativeRunId(actor.turn),
                predecessorId:this.address(input.address).session,provider:input.provider,model:input.model,effort:input.effort,
                reason:input.reason,sessionName:input.session_name,actionId:input.action_id});
            this.wake();return proposed;
        }
        if(!input.handoff_id)throw new Error('Name the exact handoff ID.');
        if(input.verb==='accept'){
            if(!input.digest)throw new Error('Acknowledge the exact inventory digest.');
            const accepted=await acceptHandoff({actorSession:actor.session,inputId:actor.inputId,runId:nativeRunId(actor.turn),
                handoffId:input.handoff_id,digest:input.digest});
            if(accepted.accepted&&!('duplicate' in accepted)){this.dependencies.owner.notifySupersededSession(accepted.predecessor,accepted.successor,input.handoff_id);this.wake();}
            return accepted;
        }
        if(input.verb==='withdraw')return withdrawHandoff({actorSession:actor.session,handoffId:input.handoff_id});
        throw new Error('Choose handoff propose, accept or withdraw.');
    }
    /**
     * Wake this session once, when a file or directory changes, when a command finishes, or at a
     * deadline (docs/architecture/WATCHES.md). Local to this machine and to the session whose live run
     * asks: this route is served on the owner socket only, never to a peer, and a watch is never forwarded.
     */
    /** A link opened in a browser on a machine, with no session: the order waits in the ledger while that machine sleeps. */
    async openLink(input:{source:CommunicationSource;action_id:string;url:string;on?:string;browser?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        if(!input.source?.input_id)throw new Error('Open a link from an admitted native run: use --source-input and --source-run.');
        const links=this.dependencies.owner?.peerLinks;
        if(!links)throw new Error('Opening links on another machine is not available on this instance.');
        const actor=this.fenced(this.actor(input.source));
        const source=getAcceptedSessionInput(actor.inputId!);
        if(!source||!humanAuthored(source))throw new Error('Opening a link in Tejas’s own browser requires his current direct request. Agent work and verification use a server browser.');
        action(input.action_id);
        return links.open({source:{session:actor.session,input:actor.inputId!,run:nativeRunId(actor.turn)},actionId:input.action_id,url:input.url,
            ...(input.on===undefined?{}:{peer:input.on}),...(input.browser===undefined?{}:{browser:input.browser})});
    }
    watch(input:{source:CommunicationSource;verb:'file'|'command'|'list'|'cancel';action_id?:string;until?:string;renew?:boolean;path?:string;argv?:string[];cwd?:string;watch_id?:string;runner?:string}) {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        if(!input.source?.input_id)throw new Error('A watch is registered from an admitted native run: use --source-input and --source-run.');
        const actor=this.actor(input.source),origin={originInputId:actor.inputId!,originRunId:nativeRunId(actor.turn)};
        if(input.verb==='list')return {watches:listWatches(actor.session)};
        this.fenced(actor);
        if(!input.action_id)throw new Error('A watch command needs a stable --action-id.');
        action(input.action_id);
        if(input.verb==='cancel'){
            if(!input.watch_id)throw new Error('Name the watch to cancel.');
            return {watch:cancelWatch(actor.session,input.watch_id)};
        }
        if(typeof input.until!=='string'||!input.until.trim())throw new Error('--until is required.');
        if(input.verb==='file'){
            if(typeof input.path!=='string')throw new Error('Name the file or directory to watch.');
            if(input.renew&&!canOwnStandingWork(this.dependencies.owner.defaultCwd,sessionMetadata(getSessionById(actor.session)!).cwd))
                throw new Error(STANDING_WORK_REFUSAL);
            return registerWatch({kind:'file',sessionId:actor.session,...origin,actionId:input.action_id,until:input.until,path:input.path,renew:input.renew,runner:input.runner??null});
        }
        if(!Array.isArray(input.argv)||typeof input.cwd!=='string')throw new Error('A command watch needs --cwd and the command after --.');
        return registerWatch({kind:'command',sessionId:actor.session,...origin,actionId:input.action_id,until:input.until,argv:input.argv,cwd:input.cwd,runner:input.runner??null});
    }
    async ask(input: {
        source: CommunicationSource;
        action_id: string;
        address?: string;
        role?: string;
        provider?: string;
        smallTask?: boolean;
        hisChat?: boolean;
        /** Run the new Codex session's turns outside Concierge (outside-codex.ts); otherwise an ordinary request. */
        outside?: boolean;
        /** Run the new session's Claude turns on a runner machine (docs/architecture/RUNNERS.md). */
        onRunner?: boolean;
        effort?: string;
        project?: string;
        title?: string;
        text: string;
        /** Exact work task that needs this ChatGPT answer when this run holds several tasks. */
        for_task?:string;
        /** Exact original obligation for a missing-context follow-up, never an ambiguous-send retry. */
        recovery_of?:string;
        /** Original request whose attachment was definitively rejected before Send. */
        correction_of?:string;
        after?: string[];
        pace?: string[];
        attachments?:string[];
        files?:{name:string;contentType:string;base64:string}[];
        captureId?:string;
        evidence?:unknown[];
        requestedEffect?:'informational'|'work';
        /** One line saying what is asked, shown first to the worker and on the Lab page. */
        summary?:string;
        /** How the answer comes back: 'summary' wakes the asker with the answer's one-line summary only; the body is read with sessions get. */
        answer_view?:'summary'|'full';
        return_to_requester?:boolean;
        peer?:string;
        /** What only the peer machine can do for this work; required to create a session there. */
        machine_need?:string;
        /** Exact site and observed reason the always-on server browser could not finish. */
        server_attempt?:{url?:string;failure?:string};
        resurrect?:boolean;
        /** The message in the sender's Inbox that this request works for; required from the Inbox. */
        thread?:string;
        /** Route this exact accepted Inbox message into the addressed session. */
        routeMessageId?:string;
        /** A session a new one should consult for context; its address is put in the first input. */
        consult?:string;
        saved?:{kind:'scheduled'|'banked';atMs?:number;expiresAtMs?:number;repeatEveryMs?:number};
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting requests.');
        const sender = this.authority(this.fenced(this.actor(input.source)));
        const actor = sender.actor;
        action(input.action_id);
        const requestedRole=input.role;
        const requestedTitle=input.title;
        let standingRole:import('./standing-agents').StandingAgentRole|undefined;
        if(input.role!==undefined) {
            const agent=standingAgent(input.role);
            if(!agent)throw new Error(`Unknown standing agent role ${input.role}; use sessions agents.`);
            if(input.address||input.provider||input.project||input.peer||input.outside||input.resurrect||input.saved?.kind==='banked'||input.consult)
                throw new Error('--role chooses the standing agent session and project; do not combine it with an address, provider, project, peer or banked work.');
            const project=standingAgentProject(this.dependencies.owner.defaultCwd,agent.role);
            if(!project)throw new Error(`The ${agent.role} agent project is unavailable on this machine.`);
            const session=standingAgentSession(this.dependencies.owner.defaultCwd,agent.role);
            if(!session)standingRole=agent.role;
            input=session?{...input,role:undefined,address:sessionAddress(session)}
                :{...input,role:undefined,provider:'auto',project:project.cwd,title:input.title??agent.description};
        }
        let routedFrom:{sessionId:string;messageId:string;topicId:string;root:string;title:string;originalText:string;originalCreatedAt:string;authorKind:'human'|'agent'}|null=null;
        if(input.routeMessageId!==undefined){
            if(input.provider||!input.address||input.saved||input.after?.length||input.consult||input.thread||input.return_to_requester)
                throw new Error('Routing one message to a session needs one exact existing address, without a second thread or request destination.');
            // Any agent may route any accepted Inbox message [decision: agents-are-never-handcuffed].
            const source=getAcceptedSessionInput(input.routeMessageId);
            if(!source||!sessionMetadata(getSessionById(source.session_id)!).inbox)
                throw new Error('The routed message must be an accepted input in the Inbox.');
            const body=JSON.parse(source.payload_json);
            const root=inboxThreadRoot(source.session_id,source.id);
            const topicId=root?topicOfRoot(root):null;
            if(!root||!topicId)throw new Error('The source message must already belong to an Inbox thread.');
            const originalText=typeof body.text==='string'?body.text:'';
            const attachments=Array.isArray(body.attachments)?body.attachments.filter((id:unknown):id is string=>typeof id==='string'):[];
            if(!originalText.trim()&&!attachments.length)throw new Error('The routed message has no words or attachments.');
            const title=(db.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(topicId) as {title:string}|null)?.title??topicId;
            routedFrom={sessionId:`concierge:${source.session_id}`,messageId:source.id,topicId,root,title,originalText,
                originalCreatedAt:source.created_at.replace(' ','T')+'Z',authorKind:source.origin==='human'?'human':'agent'};
            input={...input,text:originalText.trim()?originalText:'Attachment message from the Inbox.',attachments};
        }
        text(input.text);
        // A session that handed its work to a successor is reached through that successor; the
        // handed-off session itself is frozen. Asking it used to fail with "not currently
        // messageable", which agents read as "this agent cannot answer" (2026-11-04).
        let forwardedFrom:string|null=null;
        if(input.address&&!input.resurrect&&input.peer===undefined&&!this.dependencies.peers?.splitAddress(input.address)) {
            for(let hop=0;hop<8;hop++) {
                const resolved=this.address(input.address!);
                const next=this.messageable(resolved)?null:supersededAddress(resolved.session);
                if(!next)break;
                forwardedFrom??=input.address!;
                input={...input,address:next};
            }
        }
        const writing=isWritingSession(getSessionById(actor.session)!);
        if(input.requestedEffect==='work'&&writing)throw new Error(WRITING_SESSION_REFUSAL);
        if(input.smallTask!==undefined&&(input.smallTask!==true||input.provider!=='auto'||input.peer))
            throw new Error('A small task mark requires a new local Automatic session.');
        // A request carries its sender's authority unless the sender narrows it to a question:
        // unmarked requests from the lab coordinator arrived information-only and three agents
        // declined to build what Tejas had asked for (2026-10-08).
        if(input.requestedEffect===undefined)input={...input,requestedEffect:writing||!this.receivesWork(input)?'informational':sender.scope};
        const frozen=input.address&&!input.provider&&!input.routeMessageId&&!input.resurrect&&input.peer===undefined&&!this.dependencies.peers?.splitAddress(input.address)
            ?this.frozenSession(this.address(input.address).session):null;
        if(frozen) {
            if(input.requestedEffect==='work')
                throw new Error(`This session is ${frozen.state}, so its work stays as it was left. Ask it a question with --requested-effect informational and a side copy of its conversation answers, or start a new session that consults it with --consult ${sessionAddress(frozen.session)}.`);
            if(input.thread||input.return_to_requester||input.after?.length||input.pace?.length||input.consult||input.saved)
                throw new Error(`This session is ${frozen.state}; a side copy of its conversation answers a question only as this command's result, so ask without --thread, --return-to-requester, --after-request or saved-work options and carry the answer on yourself.`);
            return this.sideCopyAnswer(actor,input,frozen);
        }
        if(input.onRunner!==undefined&&(input.onRunner!==true||!input.provider||input.provider==='chatgpt'||input.address||input.peer||input.outside))
            throw new Error('--on-runner starts a new Claude Code session on this owner whose turns run on a runner: give --project and a Claude provider, not an address, --peer, --outside or ChatGPT.');
        if(input.outside!==undefined&&(input.outside!==true||!input.provider||['auto','chatgpt'].includes(input.provider)||input.address||input.peer||input.saved||input.resurrect))
            throw new Error('An outside request starts a new local Codex session: --outside with --project and an optional Codex alias.');
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
        const threadRoot=routedFrom?null:inboxRequestThread(getSessionById(actor.session)!,input.thread);
        if(threadRoot&&(typeof input.summary!=='string'||!input.summary.trim()||/[\r\n]/.test(input.summary)))
            throw new Error('A thread request needs a one-line summary for its visible handoff.');
        const currentInput=actor.inputId?getAcceptedSessionInput(actor.inputId):null;
        const threadSourceMessageId=threadRoot&&currentInput?.origin==='human'
            &&inboxThreadRoot(actor.session,currentInput.id)===threadRoot?currentInput.id:input.thread;
        if(input.return_to_requester!==undefined&&input.return_to_requester!==true)
            throw new Error('Requester returns must be explicitly enabled.');
        const title=normalizeSessionTitle(input.title);
        if(input.saved) {
            if((!input.provider&&!requestedRole)||input.peer||(!requestedRole&&!title)||input.after?.length)
                throw new Error('Saved work needs a standing role or a newly named local session with no prerequisites.');
            if(input.provider==='chatgpt')throw new Error('Banked and scheduled work needs a coding provider.');
            if(input.saved.kind!=='scheduled'&&input.saved.kind!=='banked')throw new Error('Unknown saved work kind.');
            if(input.saved.kind==='scheduled'&&(!Number.isFinite(input.saved.atMs)||input.saved.atMs!<=Date.now()))
                throw new Error('Scheduled work needs a future time.');
            if(input.saved.repeatEveryMs!==undefined) {
                const root=this.dependencies.owner.defaultCwd;
                const target=input.project?sessionProject(root,input.project,{inside:true}):null;
                if((!requestedRole&&!canOwnStandingWork(root,sessionMetadata(getSessionById(actor.session)!).cwd))
                  ||!canOwnStandingWork(root,target?.cwd??sessionMetadata(getSessionById(this.address(input.address!).session)!).cwd))
                    throw new Error(STANDING_WORK_REFUSAL);
            }
        }
        if(title!==undefined&&!input.provider&&!requestedRole)throw new Error('A session name requires new session creation.');
        if(input.provider!==undefined||input.peer!==undefined) {
            if(input.provider!==undefined&&(typeof input.provider!=='string'||!input.provider||input.address!==undefined))throw new Error('Choose either an exact session address or an explicit provider for a new session.');
            const sourceSession=getSessionById(actor.session)!;
            if(sourceSession.provider_id==='chatgpt')throw new Error('ChatGPT sessions cannot send outbound session requests.');
            if(sessionMetadata(sourceSession).interactionPolicy==='consultation-only')throw new Error('Consultation-only sessions cannot send requests or replies.');
            const sourceTurn=db.query('SELECT status,provider_admission_intended_at FROM turns WHERE id=?').get(actor.turn) as any;
            if(sourceTurn?.status!=='running'||!sourceTurn.provider_admission_intended_at)throw new Error('Source must identify this admitted input and its exact live run.');
            if(!this.dependencies.owner)throw new Error('Native session owner is unavailable.');
        }
        if(input.summary!==undefined)input={...input,summary:oneLineSummary(input.summary)};
        // ChatGPT runs in the server's signed-in Chrome; a machine without that connection (the
        // Mac) starts the chat there, and the answer returns here like any peer reply. Every Mac
        // ChatGPT ask failed at once with "chatgpt start unavailable" until 2026-10-15.
        if(input.provider==='chatgpt'&&input.peer===undefined&&!this.dependencies.owner.runtime.available('chatgpt')) {
            const host=this.dependencies.peers?.chatGptHost();
            if(!host)throw new Error('ChatGPT is not connected on this machine and no peer runs it.');
            input={...input,peer:host};
        }
        if(input.peer!==undefined) {
            if(typeof input.peer!=='string'||!input.peer)throw new Error('Name the peer instance exactly; see sessions peers.');
            const machineNeed=input.peer==='mac'&&(input.provider!==undefined||input.requestedEffect==='work')
                ?parseMachineNeed(input.machine_need,input.server_attempt):undefined;
            if(input.machine_need!==undefined&&input.peer!=='mac')throw new Error('--machine-need is for Mac work.');
            if(input.server_attempt!==undefined&&input.peer!=='mac')throw new Error('--server-attempt is for Mac browser fallback.');
            if(input.server_attempt!==undefined&&machineNeed?.kind!=='browser-fallback')throw new Error('--server-attempt needs a Mac browser-fallback work request.');
            if(input.after?.length||input.pace?.length)throw new Error('A peer request cannot wait on this instance\'s requests.');
            if(input.provider===undefined&&(typeof input.address!=='string'||!input.address))throw new Error('A peer request needs the peer\'s exact discovered address or --provider for a new session there.');
            if(input.requestedEffect!==undefined&&!['informational','work'].includes(input.requestedEffect))throw new Error('Requested effect must be informational or work within existing authority.');
            if(input.requestedEffect==='work'&&sessionInputProvenance(getAcceptedSessionInput(actor.inputId!)!)?.effectScope==='informational')
                throw new Error('An informational request cannot delegate work; preserve its originating scope.');
            if(input.attachments!==undefined)this.dependencies.owner?.attachments(input.attachments);
            if(input.files!==undefined&&!Array.isArray(input.files))throw new Error('Files must contain named attachment bytes.');
            if(input.captureId!==undefined&&typeof input.captureId!=='string')throw new Error('Capture ID must name a retained inbox input.');
            // The peer keeps the asked words; a retry reuses them, so a fresh lookup cannot conflict with the first.
            const askedPeer=db.query('SELECT payload_json FROM session_peer_requests WHERE source_input_id=? AND action_id=?').get(actor.inputId??'',input.action_id) as {payload_json:string}|null;
            if(askedPeer)input={...input,text:JSON.parse(askedPeer.payload_json).text??input.text};
            else {
                const history=await this.earlierWork(actor,input,routedFrom?.root??topicRootFor(threadRoot,actor.inputId),null);
                if(history?.text)input={...input,text:`${history.text}\n\n${input.text}`};
            }
            return this.peers().ask(this.peerActor(actor),{peer:input.peer,action_id:input.action_id,address:input.address,provider:input.provider,effort:input.effort,project:input.project,title,summary:input.summary,text:input.text,
                forTask:input.for_task,recoveryOf:input.recovery_of,correctionOf:input.correction_of,
                requestedEffect:input.requestedEffect,files:input.files,attachments:input.attachments,captureId:input.captureId,evidence:input.evidence,threadRoot,threadSourceMessageId,returnToRequester:input.return_to_requester,
                ...(machineNeed?{machineNeed}:{}),
                ...(routedFrom?{routedFrom}:{})});
        }
        if(!input.provider&&(input.effort!==undefined||input.project!==undefined))throw new Error('Model, effort and project selection require a new session; addressed requests preserve the target.');
        if(input.machine_need!==undefined&&process.platform!=='darwin')throw new Error('--machine-need is for Mac work.');
        if(input.server_attempt!==undefined&&process.platform!=='darwin')throw new Error('--server-attempt is for Mac browser fallback.');
        const localMachineNeed=process.platform==='darwin'&&(input.provider!==undefined||input.requestedEffect==='work')
            ?parseMachineNeed(input.machine_need,input.server_attempt):undefined;
        if(localMachineNeed?.kind==='browser-fallback')throw new Error('Mac browser fallback must follow a recorded server attempt from a server session.');
        if (input.after !== undefined && (!Array.isArray(input.after) || input.after.some(id => typeof id !== 'string')))
            throw new Error('after must contain exact existing request IDs.');
        const after = [...new Set(input.after ?? [])].sort();
        // Pacing is not a prerequisite: a paced request waits until each named request settles,
        // whatever its outcome, and is then delivered. --after-request means the earlier work must
        // succeed, so a nightly review that used it only to keep two repairs in flight had every
        // later finding in a lane refused when one unrelated repair settled failed (2026-11-01 and
        // -02: 14 and 15 requests never reached their owners).
        if (input.pace !== undefined && (!Array.isArray(input.pace) || input.pace.some(id => typeof id !== 'string')))
            throw new Error('pace must contain exact existing request IDs.');
        const pace = [...new Set(input.pace ?? [])].sort();
        if(input.requestedEffect!==undefined&&!['informational','work'].includes(input.requestedEffect))throw new Error('Requested effect must be informational or work within existing authority.');
        if(input.requestedEffect==='work'&&sessionInputProvenance(getAcceptedSessionInput(actor.inputId!)!)?.effectScope==='informational')
            throw new Error('An informational request cannot delegate work; preserve its originating scope.');
        if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
        if(input.attachments!==undefined)this.dependencies.owner?.attachments(input.attachments);
        if(input.files!==undefined&&!Array.isArray(input.files))throw new Error('Files must contain named attachment bytes.');
        if(input.captureId!==undefined&&typeof input.captureId!=='string')throw new Error('Capture ID must name a retained inbox input.');
        if(input.answer_view!==undefined&&!['summary','full'].includes(input.answer_view))throw new Error('--answer-view is summary or full.');
        const extra={...(input.attachments?{attachments:input.attachments}:{}),...(input.evidence?{evidence:input.evidence}:{}),...(input.requestedEffect?{requestedEffect:input.requestedEffect}:{}),...(localMachineNeed?{machineNeed:localMachineNeed}:{}),...(routedFrom?{routedMessage:{sourceInputId:routedFrom.messageId},routedFrom}:{})};
        const encoded = JSON.stringify({ ...(requestedRole?{role:requestedRole}:input.provider?{provider:input.provider}:{address:input.address}),
            ...((requestedRole?requestedTitle:title)===undefined?{}:{title:requestedRole?requestedTitle:title}), text: input.text, after,...(pace.length?{pace}:{}),...extra,...(threadRoot?{thread:threadRoot}:{}),
            ...(input.for_task?{forTask:input.for_task}:{}),
            ...(input.recovery_of?{recoveryOf:input.recovery_of}:{}),
            ...(input.correction_of?{correctionOf:input.correction_of}:{}),
            ...(input.consult===undefined?{}:{consult:input.consult}),
            ...(input.summary?{summary:input.summary}:{}),...(input.answer_view?{answerView:input.answer_view}:{}),
            ...(input.return_to_requester?{returnToRequester:true}:{}),
            ...(input.saved?{saved:input.saved}:{}),
            ...(input.effort===undefined?{}:{effort:input.effort}),...(input.project===undefined?{}:{project:input.project}),
            ...(input.outside?{outside:true}:{}),...(input.onRunner?{onRunner:true}:{}),
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
        let correctionProof:{runId:string;reason:string;attachmentHashes:string[]}|null=null;
        if(input.correction_of){
            if(input.recovery_of||input.provider||!targetSession||targetSession.provider_id!=='chatgpt'
                ||!input.for_task||!input.files?.length||input.attachments?.length||input.captureId)
                throw new Error('Attachment correction needs the original ChatGPT address, exact task, and a corrected --file.');
            const original=this.row(input.correction_of);
            const obligation=chatGptObligationForAttempt(input.correction_of);
            if(!obligation||obligation.obligation_id!==input.correction_of||obligation.active_request_id!==input.correction_of
                ||obligation.state!=='reconcile_receipt'||obligation.asker_session_id!==actor.session
                ||`${obligation.task_kind}:${obligation.task_id}`!==input.for_task
                ||obligation.target_session_id!==`concierge:${targetSession.id}`||obligation.question_text!==input.text
                ||original.source_session_id!==actor.session||original.target_session_id!==targetSession.id
                ||original.outcome!=='failed'||!original.target_input_id)
                throw new Error('The original failed ChatGPT request does not own this exact unanswered question, task, and target.');
            correctionProof=await this.dependencies.owner.proveRejectedChatGptAttachment(targetSession.id,original.target_input_id);
            const originalHashes=new Set(correctionProof.attachmentHashes);
            if(!input.files.some(file=>!originalHashes.has(createHash('sha256').update(Buffer.from(file.base64,'base64')).digest('hex'))))
                throw new Error('The correction needs at least one attached file with changed bytes.');
        }
        const historical=!!targetSession&&sessionMetadata(targetSession).origin==='imported'&&!this.dependencies.owner?.canSend(targetSession);
        if(target&&!historical&&!this.messageable(target))throw new Error('The exact session is not currently messageable.');
        const consultationOnly=!!targetSession&&sessionMetadata(targetSession).interactionPolicy==='consultation-only';
        const serviceReply=consultationOnly||targetSession?.provider_id==='chatgpt'||input.provider==='chatgpt';
        if(consultationOnly&&input.requestedEffect==='work')throw new Error('This session accepts consultation only — information, no actions.');
        if(historical&&(input.attachments?.length||input.files?.length||input.captureId))throw new Error('Historical consultation cannot inspect attached files.');
        if (target?.session === actor.session) {
            // A standing agent arming its own schedule is not asking itself for an answer: its
            // firing is a plain scheduled input in its own session, like every later repeat
            // (saved-work.ts), so no request to itself is opened and nothing returns to it.
            // saveQueuedTurn keeps the role's identity and refuses a second queued repeat.
            if(input.saved&&requestedRole&&actor.inputId)return this.scheduleOwnRole(actor,input.saved,requestedRole,input.action_id,input.text,digest);
            throw new Error('A session cannot ask itself to produce a separate answer.');
        }
        // A session given a topic it does not handle yet is told so, with the other topics it is on,
        // so it can judge fit and hand the request back (session-fit.ts). Facts, never a refusal.
        const topicRoot=routedFrom?.root??topicRootFor(threadRoot,actor.inputId);
        let fitNote:string|null=null;
        if(target&&targetSession&&!historical&&!consultationOnly&&targetSession.provider_id!=='chatgpt'&&!takesManySubjects(targetSession)&&input.requestedEffect==='work') {
            const fit=forTopic(targetSession,topicOf(topicRoot));
            if(fit&&!fit.holds)fitNote=newTopicNote(fit);
        }
        for (const dependency of after)
            if (this.row(dependency).source_session_id !== actor.session)
                throw new Error('A continuation may depend only on this session’s accepted requests.');
        for (const earlier of pace)
            if (this.row(earlier).source_session_id !== actor.session)
                throw new Error('A request may be paced only behind this session’s own requests.');
        // Looked up once, after every refusal above, when the request is first accepted; a retry
        // returned the receipt earlier.
        const history=await this.earlierWork(actor,input,topicRoot??null,target?.session??null);
        const consultation=historical?await this.dependencies.owner!.prepareConsultation(input.address!,undefined,input.evidence):null;
        if(consultation||history) {
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
            if(input.for_task&&!toChatgpt)throw new Error('--for-task belongs to a ChatGPT question.');
            if(input.recovery_of&&!toChatgpt)throw new Error('--recovery-of belongs to a ChatGPT question.');
            if(input.correction_of&&!toChatgpt)throw new Error('--correction-of belongs to a ChatGPT question.');
            if(toChatgpt&&threadRoot&&!input.return_to_requester)
                throw new Error('A ChatGPT question for a named thread must also return to its asking agent; add --return-to-requester.');
            const isHisChat = isHisChatGpt({
                origin: targetSession ? sessionMetadata(targetSession).origin : undefined,
                model: targetSession ? sessionMetadata(targetSession).model : undefined,
                effort: input.effort,
                hisChat: input.hisChat,
            });
            const chatgptText = isHisChat ? input.text : `${input.text}\n\n${chatgptRequestLine()}`;
            const firstInput={text:toChatgpt?chatgptText:`Session request ${id} from concierge:${actor.session}. This is agent-authored input within the originating human task, not a new human message. Requested effect: ${input.requestedEffect??'informational'}. Close it with sessions reply ${id}${(input.requestedEffect??'informational')==='work'?' --work-disposition completed|failed|needs_decision':''} --summary "<one line>". ${REQUEST_PROTOCOL_POINTER}\n\n${input.summary?`Summary: ${input.summary}\n\n`:''}${fitNote?`${fitNote}\n\n`:''}${history?.text?`${history.text}\n\n`:''}${input.text}`,...extra,...(serviceReply?{delivery:'queue'}:{})};
            if(routedFrom)firstInput.text=`This request carries Tejas’s exact Inbox message ${routedFrom.messageId} into this session. Answer here; the original thread displays only its routing receipt.\n\n${firstInput.text}`;
            if(input.provider) {
                const created=this.dependencies.owner!.createRequestTarget({sourceInputId:sourceInput!,sourceRunId:nativeRunId(actor.turn),requestId:id,provider:input.provider,effort:input.effort,project:input.project,title,summary:input.summary,smallTask:input.smallTask,outside:input.outside,onRunner:input.onRunner,standingRole,firstInput,saved:input.saved});
                target={session:created.session_id,channel:null,root:null,native:true};
            }
            if(input.saved&&requestedRole&&!input.provider){
                const admitted=retainSessionInput({id:`request:${id}`,sessionId:target!.session,
                    scope:`session:${sourceInput}`,actionId:`request:${id}`,kind:'input',origin:'agent',
                    payload:firstInput,sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id}).input;
                const queued=enqueueSessionInput(admitted.id);
                if(queued.turn_id===null)throw new Error('Scheduled input could not be queued.');
                saveQueuedTurn(queued.turn_id,input.saved.kind,input.saved.atMs,input.saved.expiresAtMs,input.saved.repeatEveryMs,undefined,requestedRole);
            }
            if(consultation) {
                const created=this.dependencies.owner!.createRequestConsultation(consultation,{sourceInputId:sourceInput!,sourceRunId:nativeRunId(actor.turn),requestId:id,firstInput});
                target={session:created.session_id,channel:null,root:null,native:true};
            }
            const selected=target!;
            const address=sessionAddress(getSessionById(selected.session)!);
            const retainedBody=JSON.parse(encoded);
            if(input.files)retainedBody.files=input.files.map(({name,contentType,base64})=>({name,contentType,sha256:createHash('sha256').update(Buffer.from(base64,'base64')).digest('hex')}));
            const retainedPayload=JSON.stringify({...retainedBody,...extra,address,...(input.smallTask?{smallTask:true}:{}),...(fitNote?{newTopic:true}:{}),...(history?{history:{requests:history.requests,sessions:history.sessions,cases:history.cases,omissions:history.omissions.length}}:{}),...(forwardedFrom?{forwardedFrom}:{}),...(consultation?{requestedAddress:input.address,consultation:{sourceId:consultation.source.id,sourceVersion:consultation.source.version,branch:consultation.source.branch,boundary:consultation.source.consultation.boundary}}:{})});
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id,topic_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id, actor.source.channel_id??null, actor.source.message_ts??null, actor.turn, actor.session, actor.root, input.action_id, selected.session, selected.channel, selected.root, retainedPayload, digest,
                    // A scheduled request is handed to its agent at its fire time, so its
                    // 15-minute reminder clock starts there, not at the fire time itself.
                    input.saved?(input.saved.kind==='scheduled'?input.saved.atMs!+STILL_WAITING_AFTER_MS:now+savedWorkSettings().wait_days*24*60*60_000):now+STILL_WAITING_AFTER_MS,
                    now,sourceInput,`request:${id}`,threadRoot,topicRoot??'');
            if(toChatgpt){
                const task=resolveChatGptTask(actor.session,sourceInput,input.for_task);
                bindDirectChatGptTaskSource(task,sourceInput,actor.session);
                if(input.recovery_of)admitChatGptContextFollowUp({requestId:id,obligationId:input.recovery_of,task,
                    askerSessionId:actor.session,targetSessionId:`concierge:${selected.session}`,now});
                else if(input.correction_of&&correctionProof)admitChatGptAttachmentCorrection({requestId:id,obligationId:input.correction_of,task,
                    askerSessionId:actor.session,targetSessionId:`concierge:${selected.session}`,question:input.text,
                    originalRunId:correctionProof.runId,reason:correctionProof.reason,now});
                else admitChatGptObligation({requestId:id,task,askerSessionId:actor.session,question:input.text,
                    targetSessionId:`concierge:${selected.session}`,now});
            }
            if (sourceInput) {
                if(!input.provider&&!consultation&&!(input.saved&&requestedRole))retainSessionInput({id:`request:${id}`,sessionId:selected.session,scope:`session:${sourceInput}`,actionId:`request:${id}`,kind:'input',origin:'agent',
                    payload:firstInput,
                    sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id});
                const operation=retainSessionInput({sessionId:actor.session,scope:`communication:${sourceInput}`,actionId:input.action_id,kind:'request',origin:'agent',
                    payload:{text:input.text,sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),targetSessionId:`concierge:${selected.session}`,targetAddress:address,...(input.provider?{targetProvider:input.provider}:{}),...(title===undefined?{}:{title}),afterRequestIds:after,...extra},sourceInputId:sourceInput,sourceRunId:nativeRunId(actor.turn),requestId:id}).input;
                if(consultation)db.query('UPDATE session_inputs SET receipt_json=? WHERE id=?').run(JSON.stringify({childSessionId:`concierge:${selected.session}`}),operation.id);
                recordSessionEvent({eventId:`request:${id}`,sessionId:actor.session,inputId:operation.id,turnId:actor.turn,kind:'request',payload:{requestId:id,targetSessionId:`concierge:${selected.session}`,...(threadRoot?{threadSourceMessageId}:{})}});
                if(routedFrom){
                    recordSessionMessageRoute({sourceMessageId:routedFrom.messageId,destinationSessionId:`concierge:${selected.session}`,
                        destinationMessageId:`request:${id}`,requestId:id,actor:{sessionId:actor.session,turnId:actor.turn,inputId:actor.inputId!,runId:nativeRunId(actor.turn)}});
                    if(input.requestedEffect==='work')linkInboxDispatchWork({topicId:routedFrom.topicId,sourceMessageId:routedFrom.messageId,
                        dispatchId:id,targetSessionId:`concierge:${selected.session}`,summary:input.summary??routedFrom.title,brief:routedFrom.originalText});
                }
            }
        })();
        this.wake();
        return this.receipt(this.row(id));
    }
    private scheduleOwnRole(actor:{session:number;turn:number;inputId?:string|null},
        saved:{kind:'scheduled'|'banked';atMs?:number;expiresAtMs?:number;repeatEveryMs?:number},
        role:string,actionId:string,text:string,digest:string) {
        const inputId=`saved-self:${hash(`${actor.inputId}:${actionId}`)}`;
        const existing=getAcceptedSessionInput(inputId);
        if(existing){
            if(JSON.parse(existing.payload_json).digest!==digest)
                throw new Error('Idempotency conflict: this source/action already scheduled different work.');
            return {state:'scheduled',role,sessionId:`concierge:${actor.session}`,inputId,turnId:existing.turn_id};
        }
        const turnId=db.transaction(()=>{
            const retained=retainSessionInput({id:inputId,sessionId:actor.session,scope:`saved-self:${actor.inputId}`,actionId,
                kind:'input',origin:'agent',payload:{text,digest},sourceInputId:actor.inputId!,sourceRunId:nativeRunId(actor.turn)}).input;
            const queued=enqueueSessionInput(retained.id);
            if(queued.turn_id===null)throw new Error('Scheduled input could not be queued.');
            saveQueuedTurn(queued.turn_id,saved.kind,saved.atMs,saved.expiresAtMs,saved.repeatEveryMs,undefined,role);
            return queued.turn_id;
        })();
        this.wake();
        return {state:'scheduled',role,sessionId:`concierge:${actor.session}`,inputId,turnId};
    }
    /**
     * His reply inside an Inbox thread, carried to the agent working on it as a request rather than
     * as a bare message: it closes only by that agent's own `sessions reply`, joins the shared
     * agent's current run, and comes back attributed to the agent. The
     * Inbox router is not woken: each reply is posted into the thread as the agent's words
     * (`postForwardedReply`). Design: thinkering docs/plans/2026-10-07-reply-to-who-asked.md;
     * review by concierge:3756, which ruled out inferring the answer from the agent's closing text.
     */
    forwardReply(input:{inbox:SessionRow;inputId:string;target:{sessionId:string;local:number|null;peer:{peer:string;address:string}|null;title:string|null;topicId:string;root:string;messageThreadRootId?:string;messageThreadRequestId?:string};text:string;attachments?:string[]}):string {
        if(this.stopped)throw new Error('Session communication is not accepting requests.');
        const origin=getAcceptedSessionInput(input.inputId)?.origin==='agent'?'agent':'human';
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
            if(this.forwarding.has(id))return id;
            this.forwarding.add(id);
            void this.peers().ask({session:input.inbox.id,turn:standIn.id,inputId:input.inputId},{peer,action_id:actionId,address,text:input.text,requestedEffect:'work',
                ...(attachments.length?{attachments}:{}),threadRoot:input.target.root,framing:requestId=>forwardedReplyFraming(requestId,input.text,origin,input.target.topicId,input.inputId,input.target.messageThreadRootId,input.target.messageThreadRequestId),forwardedReply:{inboxInputId:input.inputId,topicId:input.target.topicId,authorKind:origin,
                  ...(input.target.messageThreadRootId?{messageThreadRootId:input.target.messageThreadRootId}:{}),...(input.target.messageThreadRequestId?{messageThreadRequestId:input.target.messageThreadRequestId}:{})}})
              .then(receipt=>{
                if(receipt.status==='queued_offline')db.query("UPDATE session_inputs SET receipt_json=json_set(receipt_json,'$.statusDetail',json(?)),updated_at=CURRENT_TIMESTAMP WHERE id=?")
                    .run(JSON.stringify({code:'PEER_ASLEEP',message:`Queued until ${peer} wakes; the agent gets it the moment the Mac is back.`,clearsAt:null,automaticRetry:true}),input.inputId);
                log('info','inbox_reply_forwarded',{request_id:id,input_id:input.inputId,peer,target_address:address,topic_id:input.target.topicId,queued:receipt.status==='queued_offline'});
              })
              .catch(error=>{
                // The peer may have committed the stable request before our answer was lost.
                // Keep the exact target as a recoverable intent, never claim it was not sent.
                const detail={code:'FORWARD_DELIVERY_UNCONFIRMED',message:'Delivery to the other machine is unconfirmed; the same request will be checked again.',clearsAt:null,automaticRetry:true};
                db.query("UPDATE session_inputs SET receipt_json=json_set(receipt_json,'$.statusDetail',json(?)),updated_at=CURRENT_TIMESTAMP WHERE id=? AND json_extract(receipt_json,'$.state')='waiting'")
                    .run(JSON.stringify(detail),input.inputId);
                log('warn','inbox_reply_forward_failed',{request_id:id,input_id:input.inputId,peer,error:String((error as Error)?.message??error).slice(0,300)});
              }).finally(()=>this.forwarding.delete(id));
            this.wake();
            return id;
        }
        const target=getSessionById(input.target.local!);
        if(!target||!this.dependencies.owner.canSend(target))throw new Error('That session cannot take a message right now.');
        const id=randomUUID(),now=this.now();
        const address=sessionAddress(target);
        const firstInput={text:forwardedReplyFraming(id,input.text,origin,input.target.topicId,input.inputId,input.target.messageThreadRootId,input.target.messageThreadRequestId),...(attachments.length?{attachments}:{})};
        const payload=JSON.stringify({address,text:input.text,after:[],requestedEffect:'work',thread:input.target.root,forwardedReply:{inboxInputId:input.inputId,topicId:input.target.topicId,
          ...(input.target.messageThreadRootId?{messageThreadRootId:input.target.messageThreadRootId}:{}),...(input.target.messageThreadRequestId?{messageThreadRequestId:input.target.messageThreadRequestId}:{})},promptAnswer:true,...(attachments.length?{attachments}:{})});
        db.transaction(()=>{
            db.query(`INSERT INTO session_communication_requests(request_id,source_channel,source_message_ts,source_turn_id,source_session_id,source_root_ts,action_id,
    target_session_id,target_channel,target_root_ts,payload_json,payload_hash,due_at_ms,created_at_ms,source_input_id,target_input_id,thread_root_input_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
                .run(id,null,null,standIn.id,input.inbox.id,null,actionId,target.id,null,null,payload,hash(payload),now+PROMPT_ANSWER_REMINDER_MS,now,input.inputId,`request:${id}`,input.target.root);
            retainSessionInput({id:`request:${id}`,sessionId:target.id,scope:`session:${input.inputId}`,actionId:`request:${id}`,kind:'input',origin:'agent',payload:firstInput,sourceInputId:input.inputId,requestId:id});
            const operation=retainSessionInput({sessionId:input.inbox.id,scope:`communication:${input.inputId}`,actionId,kind:'request',origin,
                payload:{text:input.text,sourceInputId:input.inputId,targetSessionId:`concierge:${target.id}`,targetAddress:address,requestedEffect:'work',thread:input.target.root,forwardedReply:true},
                // The receipt names its request and his message, as every other ask does, so thnkr.ing draws
                // this hand-off once, on the route card, instead of a second card beside it (2026-11-04).
                sourceInputId:input.inputId,requestId:id});
            recordSessionEvent({eventId:`request:${id}`,sessionId:input.inbox.id,inputId:operation.input.id,kind:'request',payload:{requestId:id,targetSessionId:`concierge:${target.id}`}});
        })();
        log('info','inbox_reply_forwarded',{request_id:id,input_id:input.inputId,target_session_id:target.id,topic_id:input.target.topicId});
        this.wake();
        return id;
    }
    /** Post every fresh reply for a named Inbox thread, independently of its effect scope. */
    private threadAnswer(request:RequestRow,event:EventRow,declared:any):{root:string;forwarded:{inboxInputId:string}|null}|null {
        const thread=this.answerThread(request);
        // Pending old returns use the same post identity when custody moves to the thread.
        const agentReply=((event.kind==='progress'&&!!declared.source)||event.kind==='final'||event.kind==='overdue');
        return thread&&(thread.forwarded||agentReply)?thread:null;
    }
    /** The Inbox thread this request's agent replies are posted into, if any. */
    private answerThread(request:RequestRow):{root:string;forwarded:{inboxInputId:string}|null}|null {
        if(!request.source_input_id)return null;
        const payload=JSON.parse(request.payload_json);
        if(payload.routedMessage)return null;
        const forwarded=payload.forwardedReply;
        if(forwarded&&typeof forwarded.inboxInputId==='string'){
            const route=messageRouteForSource(forwarded.inboxInputId);
            if(route&&'sessionId' in route)return null;
            return {root:route&&'topicId' in route?route.messageId:request.thread_root_input_id??request.source_input_id,forwarded};
        }
        const inbox=getSessionById(request.source_session_id);
        const root=inboxRequestRoot(db,request.request_id,request.thread_root_input_id);
        if(!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))return null;
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
        const route=forwarded?.inboxInputId?messageRouteForSource(forwarded.inboxInputId):null;
        if(route&&'sessionId' in route)return false;
        const inbox=getSessionById(request.source_session_id);
        const root=route&&'topicId' in route?route.messageId:inboxRequestRoot(db,request.request_id,request.thread_root_input_id??(forwarded?request.source_input_id:null));
        if(!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))return false;
        const responder=getSessionById(request.target_session_id);
        const title=responder?sessionMetadata(responder).title??null:null;
        postAgentAnswer({inboxSessionId:request.source_session_id,eventId:event.event_id,requestId:request.request_id,root,
            inboxInputId:forwarded?.inboxInputId??root,respondingSessionId:`concierge:${request.target_session_id}`,respondingTitle:title,
            text:`You stopped ${title?`“${title}”`:'this agent'} at ${noticeTime(db,declared.output.stoppedAtMs)}; its work on this ended there.`,
            attachments:[],stalled:true,final:true,workDisposition:null,hisInputId:null,quiet:'Stopped by Tejas',
            messageThreadRootId:typeof forwarded?.messageThreadRootId==='string'?forwarded.messageThreadRootId:null});
        if(forwarded?.inboxInputId)db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(JSON.stringify({state:'canceled',forwardedTo:{sessionId:`concierge:${request.target_session_id}`,requestId:request.request_id},stoppedBy:'tejas'}),forwarded.inboxInputId);
        log('info','his_stop_posted_to_thread',{request_id:request.request_id,thread:root});
        return true;
    }
    private postThreadAnswer(request:RequestRow,event:EventRow,declared:any,thread:{root:string;forwarded:{inboxInputId:string}|null}) {
        const responder=getSessionById(request.target_session_id);
        const forwarded=JSON.parse(request.payload_json).forwardedReply;
        postAgentAnswer({inboxSessionId:request.source_session_id,eventId:event.event_id,requestId:request.request_id,root:thread.root,
            inboxInputId:thread.forwarded?.inboxInputId??thread.root,respondingSessionId:`concierge:${request.target_session_id}`,
            respondingTitle:responder?sessionMetadata(responder).title??null:null,text:String(declared.replyBody??declared.text??''),todoId:typeof declared.todoId==='string'?declared.todoId:null,
            attachments:Array.isArray(declared.attachments)?declared.attachments as string[]:[],
            stalled:event.kind==='overdue'||!!declared.stalled||(!declared.source&&declared.outcome!=='answered'),final:event.kind==='final',
            answersQuestion:declared.answersQuestion===true,workDisposition:declared.workDisposition??null,closingLine:declared.closingLine??null,
            answerGroup:declared.answerGroup??null,summary:typeof declared.summary==='string'?declared.summary:null,
            answerSource:declared.source?.input_id&&declared.source?.run_id
                ?{inputId:declared.source.input_id,runId:declared.source.run_id}:null,
            noticeGroup:typeof declared.noticeGroup==='string'?declared.noticeGroup:null,
            hisInputId:thread.forwarded?request.source_input_id:null,quiet:typeof declared.quiet==='string'?declared.quiet:null,notify:declared.notify===true,
            informational:JSON.parse(request.payload_json).requestedEffect==='informational',
            messageThreadRootId:typeof forwarded?.messageThreadRootId==='string'?forwarded.messageThreadRootId:null,
            alsoMainThread:declared.alsoMainThread===true});
    }
    reply(input: {
        source: CommunicationSource;
        action_id: string;
        request_id: string;
        text: string;
        final: boolean;
        answers_question?: boolean;
        workDisposition?: WorkDisposition;
        openChatGptIds?:string[];
        evidence?:unknown[];
        attachments?:string[];
        files?:AttachedFile[];
        his_words?:string;
        why_not_answered?:string;
        only_he_can?:string;
        /** The to-do of his this question is about, or "none"; its state is read from thnkr.ing before this runs. */
        todo?:string;
        todo_checked?:TodoState|null|'unavailable';
        decision_id?:string;
        approval_action?:string;
        checked?:string;
        not_checked?:string;
        all_done?:boolean;
        /** The receiving session's push-back: not-my-subject or too-loaded, with a failed disposition. */
        hand_back?:string;
        /** One line saying what the reply says, shown before its body to the asker and on the Lab page. */
        summary?:string;
        /** Original final body, separate from the mandatory completion evidence. */
        reply_body?:string;
        answer_group?:string;
        /** Why Tejas need not read this completed answer: it is posted in his thread but filed for nobody. */
        quiet_because?:string;
        notify?:boolean;
        also_main_thread?:boolean;
        waiting_on_watch?:string;
        /** What earlier agents did on this problem and how this approach differs; required on the first reply to a request that came with earlier work. */
        before?:string;
    }) {
        if (this.stopped)
            throw new Error('Session communication is not accepting replies.');
        if(input.summary!==undefined)input={...input,summary:oneLineSummary(input.summary)};
        // What the requester, and through it Tejas, reads: a decision carries his words and why
        // they leave it open; completed work carries what was checked live. Folded into the words
        // so every path that carries a reply (a return, a peer, a digest) carries them too.
        const asksHim=input.his_words!==undefined||input.why_not_answered!==undefined||input.only_he_can!==undefined||input.todo!==undefined||input.decision_id!==undefined||input.approval_action!==undefined;
        // "Could not finish" that names what only he can do is waiting on him, not finished: it is
        // recorded as the question it is, so it reaches his device. A failed reply files only a quiet
        // reading item, and that is how the Uber Eats agent's photo request reached nobody (2026-11-02).
        let convertedNotice:string|null=null;
        if(asksHim&&input.workDisposition==='failed'&&input.final&&input.hand_back===undefined){
            input={...input,workDisposition:'needs_decision'};
            convertedNotice='Recorded as needs_decision: a failed reply that names what only Tejas can do is a question to him, and it now reaches his device.';
        }
        if(asksHim&&input.workDisposition!=='needs_decision')
            throw new Error('Question fields belong to --work-disposition needs_decision.');
        const todoId=input.workDisposition==='needs_decision'?questionTodo(input):null;
        if((input.checked!==undefined||input.not_checked!==undefined||input.all_done!==undefined)&&input.workDisposition!=='completed')
            throw new Error('--checked, --not-checked and --all-done belong to --work-disposition completed.');
        // A request that came with earlier work on the same problem is answered first by saying what
        // that work was and how this approach differs (request-history.ts). Without it the earlier
        // findings sat in the request unread; with it the requester, and Tejas in his thread, see that
        // the agent started from them. A hand-back is exempt: it declines the work.
        const before=typeof input.before==='string'?input.before.trim().slice(0,4000):'';
        if(input.before!==undefined&&!before)throw new Error('--before needs words: what earlier agents did on this problem and how your approach differs.');
        if(!before&&input.hand_back===undefined) {
            const asked=db.query('SELECT payload_json FROM session_communication_requests WHERE request_id=?').get(input.request_id) as {payload_json:string}|null;
            const history=asked?JSON.parse(asked.payload_json).history:null;
            if(history&&(history.requests||history.sessions||history.cases)
              &&!db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind IN ('progress','final')").get(input.request_id))
                throw new Error('This request came with WHAT CAME BEFORE: earlier work on the same problem. Your first reply must say what that work did and how your approach differs: add --before "<what came before and how this differs>" to this reply.');
        }
        if(before)input={...input,text:`What came before: ${before}${input.text.trim()?`\n\n${input.text}`:''}`};
        if(input.final)input={...input,reply_body:input.text};
        // An answer is never refused for how it was marked: a flag that does not fit is dropped,
        // the reply is recorded as written, and the worker is told why in its receipt. Refusing
        // it left an urgent answer to his question unmarked for hours (2026-10-21, request 39914136).
        let answerNotice:string|null=convertedNotice;
        const dropAnswerMark=(why:string)=>{answerNotice=why;input={...input,answers_question:false};};
        if(input.answers_question&&input.final)
            dropAnswerMark('--answers-question was ignored: a final reply already answers the request. Your reply was recorded.');
        else if(input.answers_question&&!input.text.trim())
            dropAnswerMark('--answers-question was ignored because the reply has no words. It was recorded as ordinary progress.');
        // His phone rings for a question only he can answer (needs_decision files its own alert) or
        // once for a finished result that was checked live; progress, corrections and partial updates
        // never ring, whatever an agent or its instructions ask (Tejas, 2026-11-02: "Why can't it wait
        // until everything is deployed and tested and then let me know?", after one agent sent 14
        // partial-update alerts in two hours). The flag is dropped, never the reply.
        if(input.notify&&!(input.final&&input.workDisposition==='completed'&&typeof input.checked==='string'&&input.checked.trim())){
            input={...input,notify:false};
            answerNotice=(answerNotice?answerNotice+' ':'')+'--notify was ignored: only a final completed reply with --checked rings his phone; progress, corrections and failures stay in the thread.';
        }
        const noted=<T extends object>(receipt:T):T=>answerNotice?{...receipt,notice:answerNotice}:receipt;
        if(input.waiting_on_watch!==undefined){
            if(input.final)throw new Error('--waiting-on-watch belongs to a partial reply; the request stays open until the watched condition wakes you.');
            const source=getAcceptedSessionInput(input.source.input_id??'');
            const actionKey=JSON.stringify(['input',input.source.input_id,input.action_id]);
            const alreadyRecorded=!!db.query('SELECT 1 FROM session_communication_events WHERE action_key=?').get(actionKey)
                ||!!db.query('SELECT 1 FROM session_peer_replies WHERE action_key=?').get(actionKey);
            const watch=source?db.query("SELECT session_id,state,delivery_state FROM watches WHERE watch_id=?").get(input.waiting_on_watch) as
                {session_id:number;state:string;delivery_state:string|null}|null:null;
            const request=db.query('SELECT created_at_ms FROM session_communication_requests WHERE request_id=?').get(input.request_id) as {created_at_ms:number}|null;
            const peerRequest=db.query('SELECT created_at_ms FROM session_peer_deliveries WHERE request_id=?').get(input.request_id) as {created_at_ms:number}|null;
            if(!alreadyRecorded&&(!source||!watch||watch.session_id!==source.session_id||(!request&&!peerRequest)
                ||(!['accepted','observing'].includes(watch.state)&&watch.delivery_state!=='pending')))
                throw new Error('--waiting-on-watch needs an active watch owned by this agent.');
        }
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
        // The summary opens his notice; the owner holds it, not only the command line.
        if(input.final&&input.workDisposition==='needs_decision'&&!outsideRequest&&!input.summary)
            throw new Error('A needs_decision reply leads with --summary "<one line: what he must decide and the result it depends on>"; it opens his phone notice.');
        if(input.workDisposition==='needs_decision'&&!outsideRequest)
            input={...input,text:questionForTejas({actorInputId:input.source.input_id??'',question:input.text,lead:input.summary,hisWords:input.his_words,whyNotAnswered:input.why_not_answered,onlyHeCan:input.only_he_can,decisionId:input.decision_id,approvalAction:input.approval_action})};
        else if(input.workDisposition==='completed')
            input={...input,reply_body:input.text,text:completionWithCheck({text:input.text,checked:input.checked,notChecked:input.not_checked,allDone:input.all_done})};
        if(input.final&&['failed','needs_decision'].includes(input.workDisposition??'')&&input.openChatGptIds?.length)
            input={...input,text:`${input.text}\n\nChatGPT answers still owed: ${input.openChatGptIds.join(', ')}. The exact questions remain open for recovery; this report does not close them.`};
        if(outsideRequest)
            return this.externalReply(input)!;
        const attached = !!(input.attachments?.length || files(input.files).length);
        if (this.dependencies.peers && !this.local(input.request_id) && this.dependencies.peers.hasDelivery(input.request_id)) {
            // A retry after the run ended returns the committed reply, as for a local request.
            if (input.source.input_id && db.query('SELECT 1 FROM session_peer_replies WHERE action_key=?').get(JSON.stringify(['input', input.source.input_id, input.action_id])))
                return this.dependencies.peers.inspectDelivery(input.request_id);
            const actor = this.fenced(this.actor(input.source));
            action(input.action_id);
            message(input.text, attached||!!(input.final&&!input.reply_body?.trim()));
            if (typeof input.final !== 'boolean')
                throw new Error('Specify whether this is a final answer.');
            if(input.evidence!==undefined&&!Array.isArray(input.evidence))throw new Error('Evidence must be exact references.');
            // The replier retains its own custody first; the peer transport carries those exact
            // bytes to the origin, which admits them into its own custody.
            const peer=this.peerActor(actor);
            const attachments=attached?this.retainAttachments(peer.inputId,input.action_id,'reply-file',input):[];
            return noted(this.dependencies.peers.reply(peer, {action_id:input.action_id,request_id:input.request_id,text:input.text,replyBody:input.reply_body,answerGroup:input.answer_group,
                closingLine:input.final&&input.workDisposition?finalClosingLine(input.workDisposition,input.checked,input.not_checked):undefined,
                final:input.final,answersQuestion:input.answers_question,waitingOnWatch:input.waiting_on_watch,workDisposition:input.workDisposition,openChatGptIds:input.openChatGptIds,evidence:input.evidence,...(todoId?{todoId}:{}),...(attachments.length?{attachments}:{}),...(input.hand_back?{handBack:input.hand_back}:{}),...(quiet?{quiet}:{}),...(input.notify?{notify:true}:{}),...(input.also_main_thread?{alsoMainThread:true}:{})}));
        }
        // Any request whose replies post into an Inbox thread can carry the answer to his question
        // there: a forwarded reply of his, and equally work the router sent for a question it
        // recorded in that thread. Elsewhere there is no thread to answer in.
        if(input.answers_question){
            const candidate=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(input.request_id) as RequestRow|null;
            if(candidate&&!JSON.parse(candidate.payload_json).promptAnswer&&!this.answerThread(candidate))
                dropAnswerMark('--answers-question was ignored: this request does not post into an Inbox thread, so there is no question of his to answer there. Your reply was recorded as ordinary progress for the requester.');
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
                    || payload.workDisposition !== input.workDisposition || payload.answersQuestion !== (input.answers_question || undefined)
                    || payload.answerGroup !== input.answer_group
                    || payload.waitingOnWatch !== input.waiting_on_watch
                    || payload.notify !== (input.notify||undefined)
                    || payload.alsoMainThread !== (input.also_main_thread||undefined)
                    || JSON.stringify(payload.evidence) !== JSON.stringify(input.evidence)
                    || !attachments
                    || JSON.stringify(payload.attachments) !== JSON.stringify(attachments.length ? attachments : undefined)
                    || payload.source?.input_id !== input.source.input_id || payload.source?.run_id !== input.source.run_id
                    || !sourceInput || payload.responding_session_id !== `concierge:${sourceInput.session_id}`)
                    throw new Error('Idempotency conflict: reply action has a different payload or source.');
                return noted(this.receipt(this.row(input.request_id)));
            }
        }
        const actor = this.fenced(this.actor(input.source));
        action(input.action_id);
        message(input.text, attached||!!(input.final&&!input.reply_body?.trim()));
        if (typeof input.final !== 'boolean')
            throw new Error('Specify whether this is a final answer.');
        const request = this.row(input.request_id);
        const requestPayload=JSON.parse(request.payload_json);
        if(input.notify){
            const root=inboxRequestRoot(db,request.request_id,request.thread_root_input_id);
            const inbox=getSessionById(request.source_session_id);
            if(!root||!inbox||!sessionMetadata(inbox).inbox||!topicOfRoot(root))
                throw new Error('--notify requires a reply that posts into an Inbox thread.');
        }
        const requestedEffect = requestPayload.requestedEffect;
        if(input.also_main_thread&&!requestPayload.forwardedReply?.messageThreadRootId)
            throw new Error('--also-main-thread belongs to a reply inside one agent message thread.');
        const bodylessFinal=input.final&&!input.reply_body?.trim()&&!attached;
        if(input.also_main_thread&&bodylessFinal)
            throw new Error('--also-main-thread needs new answer words or a file to copy into the main thread.');
        if(input.notify&&(!input.text.trim()||bodylessFinal))throw new Error('--notify requires a new reply message with words.');
        if(bodylessFinal&&!db.query("SELECT 1 FROM session_communication_events WHERE request_id=? AND kind='progress' AND json_extract(payload_json,'$.answersQuestion')=1").get(request.request_id))
            throw new Error('A final reply without a body needs an earlier prompt answer to this request.');
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
            ...(input.reply_body!==undefined?{replyBody:input.reply_body}:{}),
            ...(input.answer_group?{answerGroup:input.answer_group}:{}),
            ...(input.final&&input.workDisposition?{closingLine:finalClosingLine(input.workDisposition,input.checked,input.not_checked)}:{}),
            ...(input.summary?{summary:input.summary}:{}),
            ...(input.notify?{notify:true}:{}),
            ...(input.also_main_thread?{alsoMainThread:true}:{}),
            ...(input.answers_question?{answersQuestion:true}:{}),
            ...(input.waiting_on_watch?{waitingOnWatch:input.waiting_on_watch}:{}),
            ...(todoId?{todoId}:{}),
            ...(attachments.length?{attachments}:{}),
            ...(input.workDisposition?{workDisposition:input.workDisposition,completionTurnId:actor.turn}:{}),...(input.evidence?{evidence:input.evidence}:{}),
            ...(input.hand_back?{handBack:input.hand_back}:{}),...(quiet?{quiet}:{}) };
        const prior = db.query('SELECT * FROM session_communication_events WHERE action_key=?').get(key) as EventRow | null;
        if (prior) {
            if (prior.request_id !== request.request_id || prior.payload_json !== JSON.stringify(payload))
                throw new Error('Idempotency conflict: reply action has a different payload.');
            return noted(this.receipt(this.row(request.request_id)));
        }
        db.transaction(() => {
            if(input.final)requireChatGptTaskDisposition({kind:'local_request',id:request.request_id},input.workDisposition,input.openChatGptIds);
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
            if(requestPayload.promptAnswer&&(input.final||input.answers_question))
                db.query('UPDATE session_communication_requests SET prompt_answered_at_ms=?,due_at_ms=? WHERE request_id=? AND prompt_answered_at_ms IS NULL')
                    .run(this.now(),this.now()+STILL_WAITING_AFTER_MS,request.request_id);
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
                    inputId:request.target_input_id!,outcome:declared,text:input.text,todoId});
                // The worker no longer needs the answers it asked for on this request's behalf; a
                // needs_decision final keeps them, because that reply is the question.
                if(input.workDisposition)expireQuestionsForFinalReply({workerSessionId:actor.session,requestId:request.request_id,
                    disposition:input.workDisposition,reason:input.text.trim().slice(0,200)});
            }
        })();
        this.wake();
        return noted(this.receipt(this.row(request.request_id)));
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
        if (next.step === 'report-back') {
            // The reminder input and the mark that it was sent are one transaction: a restart can
            // neither use the reminder up unsent nor leave a sent one unrecorded. Its stable ID makes
            // any repeat the same input. Dispatch follows the commit, as for every admitted input.
            const turn = db.query('SELECT native_run_id FROM turns WHERE id=?').get(turnId) as { native_run_id: string | null } | null;
            const inputId = `report-back:${request.request_id}`;
            const marked = db.transaction(() => {
                if (db.query("UPDATE session_communication_requests SET reminded_at_ms=?,reminded_via='owner' WHERE request_id=? AND reminded_via IS NULL AND outcome IS NULL")
                    .run(this.now(), request.request_id).changes !== 1) return false;
                retainSessionInput({ id: inputId, sessionId: request.target_session_id, scope: `session:${request.target_input_id}`, actionId: inputId,
                    kind: 'input', origin: 'service', sourceInputId: request.target_input_id!, sourceRunId: turn?.native_run_id ?? nativeRunId(turnId), requestId: request.request_id,
                    payload: { text: reportBackNotice(requestLabel(request.payload_json).replace(/^your /, 'the '), replyCommand(request.request_id, effect ?? 'informational')) } });
                return true;
            })();
            const reminder = getAcceptedSessionInput(inputId);
            if (!reminder || (!marked && reminder.turn_id)) return;
            owner.dispatch(reminder);
            log('info', 'session_request_report_back', { request_id: request.request_id, worker_session_id: `concierge:${request.target_session_id}` });
            return;
        }
        if (next.step !== 'stall')
            return;
        db.transaction(() => {
            const current = this.row(request.request_id);
            if (current.outcome || current.stalled_at_ms !== null)
                return;
            const partial = db.query("SELECT payload_json FROM session_communication_events WHERE request_id=? AND kind='progress' ORDER BY rowid DESC LIMIT 1").get(request.request_id) as { payload_json: string } | null;
            const text = stalledNotice(next.reason, partial ? JSON.parse(partial.payload_json).text : null);
            this.event(request, 'overdue', { text, stalled: true, reason: next.reason,
                noticeGroup:`stalled:concierge:${request.target_session_id}:${turnId}` });
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
        // The thread uses the owner's event order, never the router's later execution order.
        const event=db.query('SELECT * FROM session_communication_events WHERE event_id=?').get(id) as EventRow;
        if((kind==='overdue'||this.postThreadEvent(request,event,JSON.parse(event.payload_json)))&&!returnsToRequester(request,event))
            db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=?").run(id);
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
                recordChatGptAttemptResult({requestId:request.request_id,outcome,answerEventId:final.event_id,now:this.now(),reason:text});
                return;
            }
            const event_id = this.event(request, 'final', payload);
            db.query("UPDATE session_communication_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?").run(outcome, JSON.stringify({ ...payload, event_id }), request.request_id);
            recordChatGptAttemptResult({requestId:request.request_id,outcome,answerEventId:event_id,now:this.now(),reason:text});
        })();
        this.wake();
    }
    /** A retained native receipt can correct the owner's earlier failed final for this same
     * question. The prior failure and its return remain history; the new final is returned
     * separately so the requester sees the correction. This never sends provider input. */
    restoreChatGptAnswer(requestId: string): boolean {
        const restored=db.transaction(() => {
            const request=db.query('SELECT * FROM session_communication_requests WHERE request_id=?').get(requestId) as RequestRow|null;
            if(!request||request.outcome!=='failed'||!request.target_input_id||!request.result_json)return false;
            const obligation=chatGptObligationForAttempt(requestId);
            if(!obligation||obligation.active_request_id!==requestId||['resolved','withdrawn_by_tejas'].includes(obligation.state))return false;
            const target=getSessionById(request.target_session_id);
            const input=getAcceptedSessionInput(request.target_input_id);
            if(target?.provider_id!=='chatgpt'||!input||input.session_id!==target.id||input.request_id!==requestId||!input.turn_id)return false;
            const turn=db.query('SELECT * FROM turns WHERE id=? AND session_id=?').get(input.turn_id,target.id) as {
                id:number;status:string;turn_kind:string;accepted_input_id:string|null;native_run_id:string|null;
                provider_input_acknowledged_at:string|null;provider_turn_id:string|null;agent_text:string|null;
            }|null;
            if(!turn||turn.status!=='done'||turn.turn_kind!=='native'||turn.accepted_input_id!==input.id
                ||!turn.native_run_id||!turn.provider_input_acknowledged_at||!turn.agent_text?.trim())return false;
            if(this.sharedTurnRequests(turn.id).length!==1)return false;
            const oldFinal=this.currentFinal(requestId) as (EventRow&{action_key:string|null})|null;
            const oldResult=JSON.parse(request.result_json);
            if(!oldFinal||oldFinal.action_key!==null||oldResult.event_id!==oldFinal.event_id
                ||JSON.parse(oldFinal.payload_json).outcome!=='failed')return false;
            const proofRows=db.query(`SELECT payload_json FROM session_owner_events INDEXED BY session_owner_events_turn_kind
                WHERE turn_id=? AND kind='capability' AND input_id=?
                  AND json_extract(payload_json,'$.kind') IN ('start','reconcile','observe') ORDER BY sequence DESC`)
                .all(turn.id,input.id) as {payload_json:string}[];
            const evidence=proofRows.map(({payload_json})=>JSON.parse(payload_json)).filter(value=>
                value.run?.runId===turn.native_run_id&&value.run?.inputId===input.id
                &&value.run?.sessionId===`concierge:${target.id}`);
            const validResult=(result:any)=>result?.state==='completed'&&result.text===turn.agent_text
                &&result.turnId===turn.provider_turn_id&&typeof result.sessionId==='string'
                &&result.sessionId===result.nativeBinding?.sessionId
                &&typeof result.nativeBinding?.accountScope==='string';
            const terminalResults=evidence.flatMap(value=>{
                if(['start','reconcile'].includes(value.kind)){
                    const receipt=value.receipt;
                    return receipt?.state==='completed'&&validResult(receipt.result)
                        ?[receipt.result]:[];
                }
                return value.kind==='observe'&&validResult(value.observation?.result)
                    &&value.observation?.runId===turn.native_run_id
                    &&value.observation?.events?.some((event:any)=>event.kind==='result'
                        &&event.runId===turn.native_run_id&&event.inputId===input.id
                        &&event.payload?.text===turn.agent_text&&event.payload?.turnId===turn.provider_turn_id
                        &&event.payload?.sessionId===value.observation.result.sessionId)
                    ?[value.observation.result]:[];
            });
            const proven=terminalResults.some(result=>evidence.some(value=>{
                if(!['start','reconcile'].includes(value.kind))return false;
                const receipt=value.receipt;
                return receipt?.runId===turn.native_run_id
                    &&['recorded','running','completed'].includes(receipt.state)
                    &&(!receipt.nativeBinding||receipt.nativeBinding.sessionId===result.sessionId
                        &&receipt.nativeBinding.accountScope===result.nativeBinding.accountScope);
            }));
            if(!proven)return false;
            const effect=JSON.parse(request.payload_json).requestedEffect;
            const outcome=effect==='work'?'undetermined':'answered';
            const eventId=randomUUID();
            db.query('UPDATE session_communication_events SET superseded_by_event_id=? WHERE event_id=? AND superseded_by_event_id IS NULL')
                .run(eventId,oldFinal.event_id);
            const payload={outcome,text:turn.agent_text,responding_session_id:`concierge:${target.id}`,
                output:{turn_id:turn.id,session_id:`concierge:${target.id}`,run_id:turn.native_run_id,input_id:input.id,
                    sha256:hash(turn.agent_text),text:turn.agent_text,recovered_from_event_id:oldFinal.event_id,
                    delivery_note:'The original ChatGPT operation was reconciled to this answer. The earlier failure is superseded; no new question was sent.'}};
            this.event(request,'final',payload,null,eventId);
            db.query("UPDATE session_communication_requests SET status='settled',outcome=?,result_json=? WHERE request_id=?")
                .run(outcome,JSON.stringify({...payload,event_id:eventId}),requestId);
            recordChatGptAttemptResult({requestId,outcome,answerEventId:eventId,now:this.now(),reason:'Exact provider receipt recovered the original question.'});
            return true;
        })();
        if(restored)this.wake();
        return restored;
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
        const ask=db.query("SELECT sequence FROM session_owner_events WHERE event_id=?").get(`request:${request.request_id}`) as {sequence:number}|null;
        return dependencies.find(dependency => {
            if(!HOLDING_OUTCOMES.includes(dependency.outcome ?? ''))return false;
            const resultEventId=JSON.parse(dependency.result_json??'{}').event_id;
            const directPost=resultEventId?db.query("SELECT sequence FROM session_owner_events WHERE event_id=?").get(`post:forward:${resultEventId}`) as {sequence:number}|null:null;
            const declared=resultEventId?db.query("SELECT payload_json FROM session_communication_events WHERE event_id=?").get(resultEventId) as {payload_json:string}|null:null;
            const group=declared?JSON.parse(declared.payload_json).answerGroup:null;
            const root=inboxRequestRoot(db,dependency.request_id,dependency.thread_root_input_id);
            const groupedPost=!directPost&&typeof group==='string'&&root
                ?db.query(`SELECT sequence FROM session_owner_events WHERE session_id=? AND coalesce(json_extract(payload_json,'$.threadRoot'),input_id)=? AND kind='post'
                    AND json_extract(payload_json,'$.answerGroup')=? ORDER BY sequence LIMIT 1`)
                    .get(dependency.source_session_id,root,group) as {sequence:number}|null:null;
            const answerPost=!directPost&&!groupedPost&&root
                ?db.query(`SELECT sequence FROM session_owner_events WHERE session_id=? AND coalesce(json_extract(payload_json,'$.threadRoot'),input_id)=? AND kind='post'
                    AND json_extract(payload_json,'$.requestId')=? ORDER BY sequence DESC LIMIT 1`)
                    .get(dependency.source_session_id,root,dependency.request_id) as {sequence:number}|null:null;
            const postSequence=(directPost??groupedPost??answerPost)?.sequence;
            if(ask&&postSequence!==undefined&&postSequence<=ask.sequence)return false;
            return !db.query(`SELECT 1 FROM session_inputs outcome JOIN session_inputs ask ON ask.id=?
                WHERE outcome.id=? AND outcome.session_id=ask.session_id AND outcome.rowid<=ask.rowid`)
                .get(request.source_input_id, `return:${resultEventId}`);
        })??null;
    }
    private holdFailedChatGptRequest(request:RequestRow,reason:string):boolean {
        const obligation=chatGptObligationForAttempt(request.request_id);
        if(!obligation||obligation.active_request_id!==request.request_id
            ||['resolved','withdrawn_by_tejas'].includes(obligation.state))return false;
        const now=this.now();
        const needsRepair=obligation.state==='awaiting_answer';
        if(needsRepair)recordChatGptAttemptResult({requestId:request.request_id,outcome:'failed',now,reason});
        recordSessionEvent({eventId:`chatgpt-original-attempt-failed:${request.request_id}`,
            sessionId:request.source_session_id,inputId:request.source_input_id,kind:'response',
            payload:{requestId:request.request_id,kind:'overdue',text:`The original ChatGPT request ${request.request_id} failed before an answer returned: ${reason}. Its answer is still owed to this task. Concierge is inspecting that exact run and receipt; do not continue as if it answered or send a replacement. ${chatGptAnswerCommand(obligation)}`}});
        if(needsRepair)this.wake();
        return true;
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
            pace?: string[];
        };
        const dependencies = payload.after.map(id => this.row(id));
        if (dependencies.some(value => !value.outcome))
            return;
        // A paced request waits for the earlier request to settle, or to stall: Concierge marks a
        // request stalled when its recipient's run ended twice without a final reply, and nothing
        // settles it after that. Waiting for settlement alone held 18 nightly findings for 11.5
        // hours behind one stalled request (2026-11-03/04). The stalled request stays open, so a
        // late answer still settles it; pacing just stops waiting on a peer that stopped.
        if ((payload.pace ?? []).some(id => this.pacingWaitsOn(id)))
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
        // A request that waited behind others starts its reminder clock when it is handed over,
        // not when it was asked, so its agent gets the same time as any other request.
        if(!routed&&(payload.after.length||payload.pace?.length))
            db.query('UPDATE session_communication_requests SET due_at_ms=max(due_at_ms,?) WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
                .run(this.now()+STILL_WAITING_AFTER_MS, request.request_id);
        if(routed?.status==='failed') {
            if(this.holdFailedChatGptRequest(request,routed.error??'The target could not receive this request.'))return;
            this.settle(request,'failed',routed.error??'The target could not receive this request.');
            return;
        }
        if (request.target_input_id) {
            // The request is pinned to the input the target session already retained, not to the
            // address generation it was asked at. A zero-work first turn moved off a model at
            // capacity bumps that generation while keeping the request's identity; re-decoding the
            // address here settled such a request failed ("The exact session binding changed.")
            // while the moved turn was running and answering it (2026-10-16). The address is only
            // decoded again when the retained input is gone.
            let target:Address;
            const retained=getAcceptedSessionInput(request.target_input_id);
            if(retained&&retained.session_id===request.target_session_id)target={session:retained.session_id,channel:null,root:null,native:true};
            else {
                try {target=this.address(JSON.parse(request.payload_json).address);}
                catch(error){this.settle(request,'failed',error instanceof Error?error.message:'The pinned session binding is unavailable.');return;}
            }
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
            if(this.holdFailedChatGptRequest(request,routed.error??'The target could not receive this request.'))return;
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
                if(this.holdFailedChatGptRequest(request,'The provider did not accept this live request.'))return;
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
        // A final reply settles exactly the requests it names (its own and any --also). Sharing a
        // recipient turn is not evidence that one reply answers another request: the Inbox sends
        // one request per thread, and they routinely steer into one turn. Until 2026-11-04 a
        // sibling's reply was copied onto every request that turn held, and one answer closed
        // two unrelated threads with the wrong text (docs/incidents/2026-11-04-one-reply-closed-sibling-requests.md).
        // A recipient that answers several together says so with --also.
        const shared = this.sharedTurnRequests(turn.id);
        // A failed steering send never reached this turn; its input runs later as its own turn.
        const steeringCount = (db.query("SELECT count(*) AS count FROM turn_steering_messages WHERE turn_id=? AND status<>'failed'").get(turn.id) as any).count;
        const effect = JSON.parse(request.payload_json).requestedEffect;
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
            // Follow the whole chain of refusals; each continuation either carries on or ends.
            const next = carryingTurn(turn.id) ?? ended;
            if (!['done', 'error', 'cancelled'].includes(next.status)) return;
            if (next.status === 'done') { this.chaseStranded(request, next.id, effect); return; }
            ended = next;
        }
        if (ended.status === 'cancelled') {
            if(this.holdFailedChatGptRequest(request,'The original provider turn was canceled without an answer.'))return;
            // His own Stop is his choice, not news; any other cancellation is work someone must follow up.
            const stop = stoppedByTejas(ended.id);
            this.settle(request, 'canceled', stop ? stoppedByTejasText(stop.atMs) : cancelledWithoutHisStopText(),
                { ...output, ...(stop ? { stoppedBy: 'tejas', stoppedAtMs: stop.atMs, stopInputId: stop.inputId } : { stoppedBy: 'not-tejas' }) });
            return;
        }
        // Plain words say why, so the requester can tell a refused account from an interrupted run
        // (a bare "ended with error" was read as the release cutting two runs off, September 23,
        // 2026); the provider's own text stays with the request for diagnosis.
        if(this.holdFailedChatGptRequest(request,endedWorkInPlainWords(turn.agent_text)))return;
        this.settle(request, 'failed', endedWorkInPlainWords(turn.agent_text),
            { ...output, ...(turn.agent_text ? { providerError: String(turn.agent_text).slice(0, 2000) } : {}) });
    }
    private async deliver(event: EventRow) {
        if (this.stopped)
            return;
        const request = this.row(event.request_id);
        const declared=JSON.parse(event.payload_json);
        const requestPayload=JSON.parse(request.payload_json);
        const routedMessage=requestPayload.routedMessage;
        const forwardedRoute=requestPayload.forwardedReply?.inboxInputId?messageRouteForSource(requestPayload.forwardedReply.inboxInputId):null;
        if(event.kind==='overdue'&&(declared.promptAnswerOverdue?request.prompt_answered_at_ms!==null:!!request.outcome)){
            withdrawUnstartedServiceInput(`return:${event.event_id}`,"Answered before this notice was delivered.");
            withdrawUnstartedServiceInput(`question-overdue:${request.request_id}`,"Answered before this notice was delivered.");
            db.query("UPDATE session_communication_events SET status='received',error='Answered before this notice was delivered; not sent.' WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        const legacyAgentReminder=event.kind==='overdue'&&/^This request has no confirmed answer after \d+ minutes\./.test(String(declared.text??''));
        if (event.kind === 'overdue' && (declared.agentReminder || legacyAgentReminder || declared.held)) {
            const source = getSessionById(request.source_session_id);
            if (!source || !this.messageable({session:source.id,channel:null,root:null,native:true})) {
                db.query("UPDATE session_communication_events SET status='held',error='Asking agent is unavailable; reminder retained.' WHERE event_id=? AND (status IS NOT 'held' OR error IS NOT 'Asking agent is unavailable; reminder retained.')").run(event.event_id);
                return;
            }
            const inputId = `request-reminder:${event.event_id}`;
            const text=legacyAgentReminder?unresolvedRequestReminder(request.payload_json,STILL_WAITING_MINUTES,
                'Inspect the recipient’s status and follow up or cancel if the work can no longer wait.')
                :declared.held&&!declared.agentReminder?`${requestLabel(request.payload_json)} is waiting: ${String(declared.text)}`:String(declared.text);
            const accepted=this.dependencies.owner!.admit({sessionId:source.id,inputId,origin:'service',sourceInputId:request.source_input_id!,sourceRunId:nativeRunId(request.source_turn_id),requestId:request.request_id,text});
            const observed=readInputExecution(accepted);
            const received=observed.acknowledgedAt||observed.turn?.input_context_received_by_turn_id;
            const status=received?'received':accepted.turn_id?'admitted':'held';
            db.query('UPDATE session_communication_events SET accepted_input_id=?,status=?,error=NULL WHERE event_id=? AND (accepted_input_id IS NOT ? OR status IS NOT ? OR error IS NOT NULL)')
                .run(inputId,status,event.event_id,inputId,status);
            return;
        }
        const returnToRequester=returnsToRequester(request,event);
        // Timing is for the request ledger and agents. A named thread never receives
        // a timer post, including overdue events retained before this release.
        if(event.kind==='overdue'&&!returnToRequester){
            db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        // A named thread is the result destination. A requester turn is a separately chosen effect.
        const alreadyPostedInThread=this.postThreadEvent(request,event,declared);
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
        // The answer withdraws any notice about this request that is admitted but not yet taken up.
        if (event.kind === 'final')
            for (const notice of db.query("SELECT accepted_input_id FROM session_communication_events WHERE request_id=? AND kind='overdue' AND accepted_input_id IS NOT NULL").all(request.request_id) as {accepted_input_id:string}[])
                db.query("UPDATE session_inputs SET receipt_json=json_set(coalesce(receipt_json,'{}'),'$.state','canceled'),updated_at=CURRENT_TIMESTAMP WHERE id=? AND turn_id IS NULL AND steering_id IS NULL AND json_extract(coalesce(receipt_json,'{}'),'$.state') IS NULL").run(notice.accepted_input_id);
        if(routedMessage||(forwardedRoute&&'sessionId' in forwardedRoute)){
            withdrawUnstartedServiceInput(`return:${event.event_id}`,'Answer retained in the destination session.');
            db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        if(!returnToRequester){
            if(!alreadyPostedInThread)throw new Error("The named thread has not received this reply.");
            withdrawUnstartedServiceInput(`return:${event.event_id}`,"Delivered directly to its Inbox thread.");
            withdrawUnstartedServiceInput(`question-overdue:${request.request_id}`,"The overdue notice belongs to its Inbox thread.");
            db.query("UPDATE session_communication_events SET status='received',error=NULL WHERE event_id=? AND status IS NOT 'received'").run(event.event_id);
            return;
        }
        if (request.source_input_id && request.target_input_id) {
            const source = getSessionById(request.source_session_id);
            if (!source || !this.messageable({session:source.id,channel:null,root:null,native:true})) {
                db.query("UPDATE session_communication_events SET status='held',error='Requester is unavailable, paused or archived; the result is retained.' WHERE event_id=? AND (status IS NOT 'held' OR error IS NOT 'Requester is unavailable, paused or archived; the result is retained.')").run(event.event_id);
                return;
            }
            const payload = declared.workDisposition==='completed' && request.outcome!=='answered'
                ? JSON.parse(request.result_json!) : declared;
            const current = db.query('SELECT * FROM session_communication_events WHERE event_id=?').get(event.event_id) as EventRow;
            // Historical returns already carried by another event keep their delivery state.
            if (current.accepted_input_id && current.accepted_input_id !== `return:${event.event_id}`) {
                this.followReturn(current.event_id, current.accepted_input_id);
                return;
            }
            const group=current.accepted_input_id?{carriedBy:null as string|null,joining:[] as EventRow[]}:this.explicitAnswerGroup(current,request.source_session_id);
            if(group.carriedBy){
                db.query('UPDATE session_communication_events SET accepted_input_id=? WHERE event_id=?').run(group.carriedBy,event.event_id);
                this.followReturn(event.event_id,group.carriedBy);
                return;
            }
            recoverUnsentSteeredInput(`return:${event.event_id}`);
            // A retry dispatches the input already recorded; its text named the requests it closed then.
            const existing = getAcceptedSessionInput(`return:${event.event_id}`);
            const coveredResponder=declared.coverage?.kind==='completed_elsewhere'
                && typeof declared.responding_session_id==='string'
                && /^concierge:\d+$/.test(declared.responding_session_id)
                ? Number(declared.responding_session_id.slice('concierge:'.length)):request.target_session_id;
            const accepted = existing ? this.dependencies.owner!.dispatch(existing) : this.dependencies.owner!.admit({sessionId:source.id,inputId:`return:${event.event_id}`,origin:'service',sourceInputId:request.source_input_id,
                sourceRunId:nativeRunId(request.source_turn_id),requestId:request.request_id,
                text:answerNotice({responder:sessionLabel(coveredResponder),labels:[request,...group.joining.map(joined=>this.row(joined.request_id))].map(row=>requestLabel(row.payload_json)),
                    kind:event.kind,stalled:!!declared.stalled,body:answerView(request,payload),outcome:payload.outcome??null,workDisposition:payload.workDisposition??null,
                    deliveryNote:alreadyPostedInThread?'Already posted in the named Inbox thread. This is your copy; do not relay it.':payload.output?.delivery_note??null,
                    files:Array.isArray(payload.attachments)?payload.attachments.length:0,
                    followUp:(()=>{const responder=getSessionById(coveredResponder);return responder?sessionAddress(responder):null;})()})
                    +[event,...group.joining].flatMap(returnEvent=>{
                        const row=db.query('SELECT * FROM session_chatgpt_obligations WHERE answer_event_id=? AND state NOT IN (\'resolved\',\'withdrawn_by_tejas\')').get(returnEvent.event_id) as ChatGptObligationRow|null;
                        return row?[`\n\nChatGPT answer still owed for ${row.obligation_id}. After reading this exact return, record how you handled it: ${chatGptAnswerCommand(row)}`]:[];
                    }).join(''),
                // The answer's files travel with it: the requester opens them from its own turn.
                ...(Array.isArray(payload.attachments)&&payload.attachments.length?{attachments:payload.attachments as string[]}:{}),
                ...(alreadyPostedInThread?{alreadyPostedInThread:true}:{})});
            if(event.kind==='final'&&payload.workDisposition==='needs_decision'&&!sessionMetadata(source).inbox){
                const author=sessionAuthor(`concierge:${coveredResponder}`);
                recordRequesterDecisionReturn({sessionId:source.id,returnInputId:accepted.id,requestId:request.request_id,
                    question:String(payload.text??''),todoId:typeof payload.todoId==='string'?payload.todoId:null,
                    agentName:author?.agentName,taskTitle:author?.title});
            }
            for(const joined of group.joining)db.query('UPDATE session_communication_events SET accepted_input_id=? WHERE event_id=? AND accepted_input_id IS NULL').run(`return:${event.event_id}`,joined.event_id);
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
            if(event.kind==='final'&&received)recordChatGptReturnReceipt({eventId:event.event_id,returnInputId:accepted.id,now:this.now()});
            return;
        }
        db.query("UPDATE session_communication_events SET status='uncertain',error='Legacy return delivery requires owner reconciliation; no effect has been replayed.' WHERE event_id=? AND status NOT IN ('received','uncertain')").run(event.event_id);
    }
    private postThreadEvent(request:RequestRow,event:EventRow,declared:any):boolean {
        if(event.kind==='overdue')return false;
        const thread=this.threadAnswer(request,event,declared);
        const stoppedPost=declared.output?.stoppedBy==='tejas'&&this.postHisStop(request,event,declared);
        if(thread&&!stoppedPost)this.postThreadAnswer(request,event,declared,thread);
        return !!thread||!!stoppedPost;
    }
    private explicitAnswerGroup(event:EventRow,requesterSessionId:number):{carriedBy:string|null;joining:EventRow[]} {
        if(event.kind!=='final')return {carriedBy:null,joining:[]};
        const group=JSON.parse(event.payload_json).answerGroup;
        if(typeof group!=='string'||!group)return {carriedBy:null,joining:[]};
        const candidates=db.query(`SELECT event.* FROM session_communication_events event JOIN session_communication_requests request ON request.request_id=event.request_id
            WHERE request.source_session_id=? AND event.kind='final' AND event.event_id<>?
              AND json_extract(event.payload_json,'$.answerGroup')=? ORDER BY event.rowid`)
            .all(requesterSessionId,event.event_id,group) as EventRow[];
        const carrier=candidates.filter(candidate=>returnsToRequester(this.row(candidate.request_id),candidate)).find(candidate=>candidate.accepted_input_id===`return:${candidate.event_id}`);
        return carrier?{carriedBy:carrier.accepted_input_id,joining:[]}:{carriedBy:null,joining:candidates.filter(candidate=>!candidate.accepted_input_id&&returnsToRequester(this.row(candidate.request_id),candidate))};
    }
    /** An event carried by another event's return takes that return's delivery state. */
    private followReturn(eventId: string, inputId: string) {
        const input = getAcceptedSessionInput(inputId);
        if (!input) return;
        const observed = readInputExecution(input);
        const received = observed.acknowledgedAt || observed.turn?.input_context_received_by_turn_id;
        const status = received ? 'received' : ['failed','uncertain','canceled'].includes(observed.state) ? observed.state : input.turn_id ? 'admitted' : 'held';
        db.query('UPDATE session_communication_events SET status=? WHERE event_id=? AND status IS NOT ?').run(status, eventId, status);
        if(received)recordChatGptReturnReceipt({eventId,returnInputId:inputId,now:this.now()});
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
                if(!forwarded)this.event(request, 'overdue', { text:`${requestLabel(request.payload_json)} is waiting: ${heldRequestNotice(hold)}`,
                    health: `held: ${hold.code}`, held: hold.code, agentReminder:true });
                db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
            })();
    }
    private inspectOverdueRequest(request: RequestRow) {
        const now = this.now();
            if (!request.source_input_id || !request.target_input_id) return;
            // A request still queued behind earlier requests (--after-request or --after-settled
            // that have not settled) has not been handed to its agent, so it cannot be late yet:
            // look again later instead of telling the asker to inspect a recipient that has
            // nothing. The nightly review got about ten such reminders for queued findings on
            // 2026-11-02.
            const queuedBehind=JSON.parse(request.payload_json) as {after?:string[];pace?:string[]};
            if((queuedBehind.after??[]).some(id=>!this.row(id).outcome)||(queuedBehind.pace??[]).some(id=>this.pacingWaitsOn(id))) {
                db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
                    .run(now + STILL_WAITING_AFTER_MS, request.request_id);
                return;
            }
            if(JSON.parse(request.payload_json).promptAnswer && request.prompt_answered_at_ms===null) {
                const asker=getAcceptedSessionInput(request.source_input_id)?.origin==='agent'?'The marked agent test':'Tejas';
                db.transaction(()=>{
                    const current=this.row(request.request_id);
                    if(current.outcome||current.prompt_answered_at_ms!==null||current.overdue_at_ms!==null)return;
                    if(current.prompt_reminded_at_ms===null) {
                        // One reminder joins the recipient's current run. The retained input ID
                        // makes a restart or reconciliation harmless.
                        this.dependencies.owner!.admit({sessionId:current.target_session_id,inputId:`question-reminder:${current.request_id}`,
                            origin:'service',sourceInputId:current.source_input_id!,sourceRunId:nativeRunId(current.source_turn_id),requestId:current.request_id,
                            text:`${asker} is still waiting for an answer to the question in request ${current.request_id}. Answer in the Inbox thread now with sessions reply ${current.request_id} --partial --answers-question, even if the rest of the work continues. A progress-only reply does not answer it.`});
                        db.query('UPDATE session_communication_requests SET prompt_reminded_at_ms=?,due_at_ms=? WHERE request_id=?')
                            .run(now,current.created_at_ms+PROMPT_ANSWER_OVERDUE_MS,current.request_id);
                    } else {
                        this.event(current,'overdue',{text:`No answer to this ${asker==='Tejas'?'question':'marked test question'} arrived within three minutes. The agent has been reminded. The request remains open, and its answer will still appear here when it arrives.`,promptAnswerOverdue:true,
                            noticeGroup:`prompt-overdue:concierge:${current.target_session_id}:${this.binding(current)?.turn_id??current.target_input_id}`});
                        db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now,current.request_id);
                    }
                })();
                return;
            }
            const binding = this.binding(request);
            const turn = binding?.turn_id ? db.query('SELECT status,owner_instance_id,stop_requested_at,provider_input_acknowledged_at,saved_kind,saved_fire_at_ms FROM turns WHERE id=?').get(binding.turn_id) as any : null;
            // Scheduled work is not handed over until its saved fire time, which can move when the
            // schedule is edited. Its agent gets the same 15 minutes from that point; a request
            // scheduled for 18:42:30 was reported as 15 minutes overdue at 18:42:31 (2026-11-04).
            if (turn?.status === 'queued' && turn.saved_kind === 'scheduled' && turn.saved_fire_at_ms !== null
                && turn.saved_fire_at_ms + STILL_WAITING_AFTER_MS > now) {
                db.query('UPDATE session_communication_requests SET due_at_ms=? WHERE request_id=? AND outcome IS NULL AND overdue_at_ms IS NULL')
                    .run(turn.saved_fire_at_ms + STILL_WAITING_AFTER_MS, request.request_id);
                return;
            }
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
                    // A send not yet acknowledged has not reached ChatGPT: it is waiting its pacing turn
                    // (6 an hour, 2 minutes apart). Saying "still writing" then told session 6065 an answer
                    // existed that had never been asked (2026-10-13).
                    const sent = !!turn?.provider_input_acknowledged_at;
                    this.event(request, 'overdue', sent
                        ? { text: `ChatGPT is still writing its answer to "${what}" after ${STILL_WAITING_MINUTES} minutes. Pro answers can take an hour. It will arrive here by itself when it is done; nothing needs to be resent.`, health: 'still being answered by ChatGPT' }
                        : { text: `"${what}" has not been sent to ChatGPT yet after ${STILL_WAITING_MINUTES} minutes: it is waiting its turn, because sends to his ChatGPT are spaced out to at most 6 an hour, 2 minutes apart. It goes out by itself and its answer arrives here; nothing needs to be resent.`, health: 'waiting its turn to be sent to ChatGPT' });
                    db.query('UPDATE session_communication_requests SET overdue_at_ms=? WHERE request_id=?').run(now, request.request_id);
                })();
                return;
            }
            if (healthy || updateDraining() || (turn?.status === 'done' && waitingOnDependency(request.target_session_id, request.request_id, request.created_at_ms, false))) {
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
                    this.event(request, 'overdue', { text: unresolvedRequestReminder(request.payload_json, STILL_WAITING_MINUTES,
                        'Inspect the recipient’s status and follow up or cancel if the work can no longer wait.'), health, agentReminder:true });
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
    private recoverChatGptObligation(row:ChatGptObligationRow) {
        const now=this.now();
        let current=db.query(`SELECT * FROM session_chatgpt_obligations WHERE obligation_id=? AND due_at_ms<=?
            AND state NOT IN ('resolved','withdrawn_by_tejas')`).get(row.obligation_id,now) as ChatGptObligationRow|null;
        if(!current)return;
        if(withdrawCanceledChatGptAttempt(current.active_request_id,now))return;
        if(this.restoreChatGptAnswer(current.active_request_id))return;
        if(current.next_action==='observe_original_requeued_run'){
            const proof=db.query(`SELECT json_extract(evidence_json,'$.runId') AS run_id
                FROM session_chatgpt_obligation_events WHERE obligation_id=? AND action_id LIKE 'original-requeued:%'
                ORDER BY created_at_ms DESC LIMIT 1`).get(current.obligation_id) as {run_id:string|null}|null;
            const active=proof?.run_id?db.query('SELECT status FROM turns WHERE native_run_id=?').get(proof.run_id) as {status:string}|null:null;
            if(active&&['queued','running'].includes(active.status)){
                db.query('UPDATE session_chatgpt_obligations SET due_at_ms=?,updated_at_ms=? WHERE obligation_id=? AND due_at_ms<=?')
                    .run(now+300_000,now,current.obligation_id,now);
                return;
            }
        }
        const source=getSessionById(current.asker_session_id);
        const request=(db.query('SELECT source_input_id,source_turn_id FROM session_communication_requests WHERE request_id=?').get(current.active_request_id)
            ??db.query('SELECT source_input_id,source_turn_id FROM session_peer_requests WHERE request_id=?').get(current.active_request_id)) as {source_input_id:string;source_turn_id:number}|null;
        if(!source||!request?.source_input_id||!this.dependencies.owner?.canSend(source)){
            const reason=!source?'asking session no longer exists':!request?.source_input_id?'original asking input is unavailable':'asking session is paused, archived, or otherwise unmessageable';
            const changed=holdUnmessageableChatGptAsker(current.obligation_id,now,reason);
            if(changed&&source&&request?.source_input_id){
                const held=db.query('SELECT generation FROM session_chatgpt_obligations WHERE obligation_id=?').get(current.obligation_id) as {generation:number};
                recordSessionEvent({eventId:`chatgpt-asker-hold:${current.obligation_id}:${held.generation}`,sessionId:source.id,
                    inputId:request.source_input_id,kind:'response',payload:{requestId:current.active_request_id,kind:'overdue',
                        text:`ChatGPT answer obligation ${current.obligation_id} is held: ${reason}. Its original request and next repair action remain retained; no browser resend occurs.`}});
            }
            return;
        }
        if(resumeMessageableChatGptAsker(current.obligation_id,now)){
            current=db.query('SELECT * FROM session_chatgpt_obligations WHERE obligation_id=?').get(current.obligation_id) as ChatGptObligationRow;
            recordSessionEvent({eventId:`chatgpt-asker-resume:${current.obligation_id}:${current.generation}`,sessionId:source.id,
                inputId:request.source_input_id,kind:'response',payload:{requestId:current.active_request_id,kind:'progress',
                    text:`ChatGPT answer obligation ${current.obligation_id} is messageable again; its exact repair action is resuming.`}});
        }
        const inputId=`chatgpt-repair:${current.obligation_id}:${current.generation}`;
        const prior=getAcceptedSessionInput(inputId);
        if(prior){
            const observed=readInputExecution(prior);
            if(!['completed','failed','canceled','uncertain'].includes(observed.state)){
                this.dependencies.owner.dispatch(prior);
                db.query('UPDATE session_chatgpt_obligations SET due_at_ms=?,updated_at_ms=? WHERE obligation_id=? AND due_at_ms<=?')
                    .run(now+300_000,now,current.obligation_id,now);
                return;
            }
        }
        const completedRepairs=(db.query(`SELECT count(*) AS count FROM session_chatgpt_obligation_events
            WHERE obligation_id=? AND action_id LIKE 'repair:%' AND rowid>COALESCE((SELECT max(rowid)
              FROM session_chatgpt_obligation_events WHERE obligation_id=? AND
              (action_id LIKE 'answer:%' OR action_id LIKE 'return:%' OR action_id LIKE 'original-requeued:%'
                OR action_id LIKE 'follow-up:%')),0)`).get(current.obligation_id,current.obligation_id) as {count:number}).count;
        if(completedRepairs>=3){
            db.query('UPDATE session_chatgpt_obligations SET due_at_ms=?,updated_at_ms=? WHERE obligation_id=? AND due_at_ms<=?')
                .run(now+21_600_000,now,current.obligation_id,now);
            recordSessionEvent({eventId:`chatgpt-repair-persistent:${current.obligation_id}:${current.generation}`,sessionId:source.id,
                inputId:request.source_input_id,kind:'response',payload:{requestId:current.active_request_id,kind:'overdue',
                    text:`ChatGPT question ${current.obligation_id} remains unresolved after three repair turns. Its task and original browser operation remain retained. The owner now checks the exact receipt and answer return without starting more repair turns. A new provider answer or explicit recovery action will resume handling; no browser resend is authorized.`}});
            return;
        }
        db.transaction(()=>{
            const fresh=db.query('SELECT generation FROM session_chatgpt_obligations WHERE obligation_id=? AND due_at_ms<=?')
                .get(current.obligation_id,now) as {generation:number}|null;
            if(!fresh)return;
            const next=fresh.generation+1;
            const nextDelay=Math.min(300_000*2**Math.min(completedRepairs,7),21_600_000);
            db.query('UPDATE session_chatgpt_obligations SET generation=?,due_at_ms=?,updated_at_ms=? WHERE obligation_id=?')
                .run(next,now+nextDelay,now,current.obligation_id);
            db.query(`INSERT INTO session_chatgpt_obligation_events(event_id,obligation_id,action_id,state,evidence_json,created_at_ms)
                VALUES(?,?,?,?,?,?)`).run(`chatgpt-obligation:${current.obligation_id}:repair:${next}`,current.obligation_id,
                    `repair:${next}`,current.state,JSON.stringify({priorInputId:prior?.id??null,requestId:current.active_request_id}),now);
            this.dependencies.owner!.admit({sessionId:source.id,inputId:`chatgpt-repair:${current.obligation_id}:${next}`,
                origin:'service',sourceInputId:request.source_input_id,sourceRunId:nativeRunId(request.source_turn_id),
                requestId:current.active_request_id,text:current.state==='resolution_pending'
                    ? `ChatGPT answered question ${current.obligation_id} for ${current.task_kind}:${current.task_id}. Exact question: ${current.question_text}\n${chatGptAnswerCommand(current)} Read the returned answer and record how you handled it. The task stays open until you do.`
                    : `ChatGPT answer obligation ${current.obligation_id} for ${current.task_kind}:${current.task_id} remains open. Exact question: ${current.question_text}\nActive request: ${current.active_request_id}. State: ${current.state}; next action: ${current.next_action}. ${chatGptAnswerCommand(current)} Inspect the original browser operation and retained conversation/receipt, then get the exact answer back and declare how it was handled. If the original request settled failed and a later received ChatGPT answer covers this question, use sessions answer ${current.obligation_id} --handling superseded --successor-request <later-request-id> --answer-event <received-event-id> --reason <coverage> <source-flags> --action-id <stable-id>. If the original receipt proves Send was never pressed, use sessions chatgpt-recover ${current.active_request_id} --action-id <stable-action> to requeue that original run. A timeout, generic failed turn, or ambiguous receipt does not authorize another send. If this repair attempt cannot finish, the owner will wake this same obligation again.`});
        })();
    }
    private async reconcile() {
        let startedPeers = false;
        if (!this.startupReconciled) {
            const legacy=migrateOpenLegacyChatGptAsks(this.now());
            if(legacy.scanned)log('info','chatgpt_legacy_reconciliation',{...legacy});
            const withdrawn=reconcileCanceledChatGptObligations(this.now());
            if(withdrawn)log('info','chatgpt_asker_withdrawal_reconciliation',{withdrawn});
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
            let pendingAcceptedRecovery=false;
            // Both recovery scans name their narrow partial index. Without the hint Bun's SQLite chose the
            // plain turn index for `turn_id IS NULL` and walked every input without a turn (37,000 of
            // 54,000 rows, 80 MB of pages) twice per wake, while the system sqlite3 used to check the plan
            // chose the partial index (2026-10-30). The hint makes the bound hold under the engine that runs.
            await this.scanRows<AcceptedSessionInput>('session_inputs',`SELECT rowid AS reconciliation_rowid,* FROM session_inputs INDEXED BY session_inputs_surface_recovery
                WHERE scope='surface:thinkering' AND kind='input' AND turn_id IS NULL AND steering_id IS NULL
                  AND request_id IS NULL AND (json_extract(receipt_json,'$.admissionIntent') IN ('queue','live')
                    OR json_extract(receipt_json,'$.state')='waiting' AND json_extract(receipt_json,'$.forwardTarget') IS NOT NULL)
                  AND (origin='human' AND source_input_id IS NULL AND source_run_id IS NULL
                    OR origin='agent' AND (json_extract(receipt_json,'$.forwardTarget') IS NOT NULL OR json_extract(receipt_json,'$.admissionIntent')='live')
                      AND source_input_id=json_extract(payload_json,'$.agentSource.inputId')
                      AND source_run_id=json_extract(payload_json,'$.agentSource.runId'))
                  AND NOT EXISTS (SELECT 1 FROM session_communication_requests r WHERE r.source_input_id=session_inputs.id)
                  AND NOT EXISTS (SELECT 1 FROM session_peer_requests p WHERE p.source_input_id=session_inputs.id)
                  AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`, input=>{
                pendingAcceptedRecovery=true;
                try{this.dependencies.owner.recoverAcceptedInput(input);}
                catch(error){log('warn','accepted_input_recovery_waiting',{input_id:input.id,error:String(error).slice(0,300)});}
            });
            await this.scanRows<AcceptedSessionInput>('session_inputs',`SELECT rowid AS reconciliation_rowid,* FROM session_inputs INDEXED BY session_inputs_capture_recovery
                WHERE scope GLOB 'capture:*' AND kind='input' AND turn_id IS NULL AND steering_id IS NULL
                  AND request_id IS NULL AND json_extract(receipt_json,'$.admissionIntent')='live'
                  AND id='capture:' || json_extract(payload_json,'$.capture.id')
                  AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`, input=>{
                pendingAcceptedRecovery=true;
                try{this.dependencies.owner.recoverAcceptedInput(input);}
                catch(error){log('warn','capture_input_recovery_waiting',{input_id:input.id,error:String(error).slice(0,300)});}
            });
            this.pendingAcceptedRecovery=pendingAcceptedRecovery;
            // A cancellation that arrived while a session was paused must revoke its already
            // queued turn. Reconcile historical cancellations too, before any account wake.
            // Driven from the few queued turns: starting from the requests walked every request's
            // stored text on each wake (2026-11-03).
            await this.scanRows<RequestRow>('session_communication_requests', `SELECT r.rowid AS reconciliation_rowid,r.* FROM turns t INDEXED BY turns_queued_order
                CROSS JOIN session_inputs i ON i.turn_id=t.id CROSS JOIN session_communication_requests r ON r.target_input_id=i.id
                WHERE r.outcome='canceled' AND t.status='queued' AND t.saved_kind IS NULL AND r.rowid<=? AND r.rowid>?
                ORDER BY r.rowid LIMIT 1`, request => db.transaction(()=>{
                    if(request.target_input_id&&cancelQueuedWithdrawnRequest(request.target_input_id))
                        withdrawUnstartedServiceInput(`canceled:${request.request_id}`,'The request was withdrawn before its worker began.');
                })());
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
            await this.scanRows<ChatGptObligationRow>('session_chatgpt_obligations',`SELECT rowid AS reconciliation_rowid,* FROM session_chatgpt_obligations INDEXED BY chatgpt_obligations_due
                WHERE state NOT IN ('resolved','withdrawn_by_tejas') AND due_at_ms IS NOT NULL AND due_at_ms<=?
                  AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1`,row=>this.recoverChatGptObligation(row),this.now());
            await this.scanRows<RequestRow>('session_communication_requests','SELECT rowid AS reconciliation_rowid,* FROM session_communication_requests WHERE outcome IS NULL AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1',
                request => this.schedule(`ask:${request.request_id}`, () => this.dispatch(this.row(request.request_id))));
            await this.scanRows<EventRow>('session_communication_events',"SELECT rowid AS reconciliation_rowid,* FROM session_communication_events INDEXED BY session_communication_outbox WHERE status<>'received' AND status NOT IN ('received','retained') AND rowid<=? AND rowid>? ORDER BY rowid LIMIT 1",
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
        const chatGptNext=db.query(`SELECT min(due_at_ms) AS due FROM session_chatgpt_obligations INDEXED BY chatgpt_obligations_due
            WHERE state NOT IN ('resolved','withdrawn_by_tejas') AND due_at_ms IS NOT NULL`).get() as {due:number|null};
        if (next.due === null && chatGptNext.due===null && !this.pendingAcceptedRecovery)
            return;
        const delay = Math.min(this.pendingAcceptedRecovery?60_000:Infinity,24 * 60 * 60_000,
            Math.max(0,(next.due??Infinity)-this.now()),Math.max(0,(chatGptNext.due??Infinity)-this.now()));
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
