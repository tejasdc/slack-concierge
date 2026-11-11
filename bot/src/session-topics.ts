import {acceptedInputAuthor,sessionAuthor,withCurrentAuthors} from './session-message-author';
import {questionDisplay} from './topic-display-rules';
import {topicReplyTargets,type ReplyTargets} from './reply-target-rules';
import {answerLine,fragmentReason} from './answer-line';
import {consumeThreadNotification,hasPendingThreadNotification,messageAlreadyNotified,notifyAgentPost} from './thread-notifications';
import {createHash,randomUUID} from 'node:crypto';
import {localSessionNumber,receiveSessionFromPeer} from './peer-identity';
import {db,getSessionById,type SessionRow} from './state';
import {carryingTurn,getAcceptedSessionInput,humanAuthored,nativeRunId,sessionInputProvenance,recordSessionEvent,retainSessionInput,sessionMetadata,updateSessionMetadata,type AcceptedSessionInput,type RetainInputTiming} from './session-inputs';
import {INBOX_LINEAGE_SQL} from './inbox-lineage-sql';
import {BUG_REPORT_OWN_THREAD,isBugReportInput,capturePresentation,inboxMessage,inboxMessageById,inboxMessageId,inboxRowByMessageId,inboxRows,inboxSession,inboxThreadRoot,postForwardedThreadAnswer} from './session-inbox';
import {answerClosingLine} from './answer-closing-line';
import {notSeenWorking} from './answers-to-tejas';
import {inboxRequestRoot} from './inbox-request-root';
import type {OpenNeed} from './session-turn-outcome';
import {SERVICE_NOTICE_SCOPE} from './provider-free-notice';
import {errorFields,log} from './log';
import {readTodos,STEP_ASKS,type TodoState} from './question-todos';
import {topicCurrentWorkers} from './topic-current-workers';
import {approvalDecision} from './decision-approval';
import {hisWordsLine,ONLY_HE_CAN,requireHisWords,requireOnlyHeCan,THREAD_QUESTION_FIELDS_REQUIRED} from './answers-to-tejas';
import {deviceQuestionNamesPhysicalPrerequisite} from './agent-reachable-app-question';
import {preparedInboxDisplays,preparedTopicEntries} from './presentation-message-reader';
import {preparedTopicEventDisplays,preparedTopics,unpreparedTopics,preparedTopicOverview,preparedTopicItems,
  preparedTopicResolution,preparedQuestions,preparedTopicDetail,preparedTopicsReady} from './presentation-topic-reader';
import {areasCommand,checkedAreaIds,applyAreaChange,ensureAgentReportArea,ensureSystemNoticeArea,threadChanges} from './session-areas';
import {OPEN_QUESTION_STATES,briefMissing,missingFor,questionReadiness,awaitingHim,
  toReadByHim as toReadByHimWithReads,preparingForHim,type QuestionKind,type QuestionOrigin} from './topic-attention-rules';

/**
 * Topics: the Inbox's recognizable conversations. A topic owns a set of thread roots, the
 * human requests inside it, the questions waiting on Tejas, what he has actually seen, and
 * what the router says it is working on. Owner events are the truth; the tables in
 * session-schema.ts are their projection and `rebuildTopicProjections()` replays them.
 *
 * Contract: thinkering tmp/reviews/thread-redesign/topics-contract.md, implementing
 * thinkering docs/plans/2026-09-22-topic-threads.md.
 */
export class TopicError extends Error {
  constructor(message:string,readonly status=400,readonly code='TOPIC_ERROR'){super(message);}
}

export const TOPIC_EVENT_KINDS=['topic','topic_route','topic_request','topic_question','topic_answer','topic_reading','topic_focus','topics_migration','area'] as const;
const MANAGEMENT_KINDS=['topic','topic_route','topic_request','topic_question','topic_answer'];

export type TopicBy={kind:'agent'|'human'|'owner';sessionId?:string;inputId?:string;runId?:string};
export type TopicActor={sessionId:number;turnId:number;inputId:string;runId:string};
/**
 * Every end a question can reach, each moved by an explicit signal and recorded with its reason
 * (docs/plans/2026-09-23-attention-that-ends.md): `answered` by his mapped reply, `read` by his
 * own Read on a reading item, `superseded` by the replacement, `withdrawn`/`declined` by whoever
 * asked or by him, `deferred` by him, `expired` when the thread or the request it was for closed.
 * Nothing ends on a clock.
 */
type QuestionState='open'|'partial'|'answered'|'declined'|'withdrawn'|'superseded'|'deferred'|'read'|'expired';
const QUESTION_STATES:QuestionState[]=['open','partial','answered','declined','withdrawn','superseded','deferred','read','expired'];
/**
 * A question is agent-owned preparation until its brief can be answered: it must say why the
 * decision came up and exactly what he can answer now; choices are optional (a factual question
 * needs none), but each one present needs a label. Anything less is never a debt of his (the
 * approved design, docs/plans/2026-09-22-topic-threads.md; Tejas, 2026-09-22, on finding a
 * headline with nothing under it in Needs your answer). Returns what is still missing.
 */
/**
 * What a question still lacks before he can answer it. A question filed from a turn's marker
 * is answerable by construction — the agent asked him that sentence directly — so it needs only
 * the decision; a declared one needs its why and what he can answer now. Without this, the 12
 * decisions the migration filed would have landed under "Agent checking" (dry run, 2026-09-23).
 */
/** The one rule for whether a question is waiting on him. Every count, list and filter uses it;
 * a client displays this answer and never recomputes it. */
/**
 * What a reading item is for him to read, resolved from the owner's own records and never
 * copied: the messages the turn that raised it wrote into this thread — its posts there, else
 * its closing text when that text belongs to this thread. The message ids are the fact and the
 * text is read from the retained message, so an item can never say more than the thread does.
 * A router may name the messages itself (`reads` on a `topics questions` declaration); they
 * still have to be messages in this thread. Tejas, 2026-09-24, on an item that carried only
 * the turn's one-line outcome and a link back to his own message: "I literally cannot read
 * this … I want the answer I have to actually read".
 */
export type ReadingText={messageId:string;text:string;at:string};
export function readsForTurn(sessionId:number,turnId:number,roots:ReadonlySet<string>):ReadingText[] {
  const posts=db.query(`SELECT event_id,coalesce(json_extract(payload_json,'$.threadRoot'),input_id) AS root,created_at,json_extract(payload_json,'$.text') AS text
    FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post' ORDER BY sequence`).all(sessionId,turnId) as {event_id:string;root:string|null;created_at:string;text:string|null}[];
  const here=posts.filter(post=>!!post.root&&roots.has(post.root)&&String(post.text??'').trim());
  if(here.length)return here.map(post=>({messageId:post.event_id,text:String(post.text),at:iso(post.created_at)!}));
  // No post: the turn's closing text, only when the input it answered is in this thread — a
  // turn can work for several threads, and another thread's answer is not his to read here.
  const result=db.query(`SELECT event.event_id,event.input_id,event.created_at,COALESCE(json_extract(event.payload_json,'$.text'),turn.agent_text,'') AS text
    FROM session_owner_events event LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE event.session_id=? AND event.turn_id=? AND event.kind='result' LIMIT 1`).get(sessionId,turnId) as {event_id:string;input_id:string|null;created_at:string;text:string}|null;
  if(!result||!String(result.text).trim()||!result.input_id)return [];
  const root=inboxThreadRoot(sessionId,result.input_id);
  return root&&roots.has(root)?[{messageId:result.event_id,text:String(result.text),at:iso(result.created_at)!}]:[];
}
/** The turn that raised a question: the outcome event it was filed from, else the run that declared it. */
function turnOfQuestion(question:{legacyNeedEventId:string|null;owner:any}):number|null {
  if(question.legacyNeedEventId) {
    const row=db.query('SELECT turn_id FROM session_owner_events WHERE event_id=?').get(question.legacyNeedEventId) as {turn_id:number|null}|null;
    if(typeof row?.turn_id==='number')return row.turn_id;
  }
  const runId=question.owner?.runId;
  if(typeof runId!=='string'||!runId)return null;
  const turn=db.query('SELECT id FROM turns WHERE native_run_id=?').get(runId) as {id:number}|null;
  return turn?.id??null;
}
export function routedMessageFor(messageId:unknown) {
  if(typeof messageId!=='string'||!messageId.trim())return null;
  const id=messageId.trim();
  let row:{kind:string;payload_json:string}|null=null;
  if(id.startsWith('topic-change:')||id.startsWith('session-route:')){
    row=db.query("SELECT kind,payload_json FROM session_owner_events WHERE event_id=? AND kind IN ('topic_route','session_route')").get(id) as {kind:string;payload_json:string}|null;
  }
  if(!row&&id.startsWith('request:')){
    row=db.query("SELECT kind,payload_json FROM session_owner_events WHERE event_id=? AND kind='session_route'").get(`session-route:${id.slice('request:'.length)}`) as {kind:string;payload_json:string}|null;
  }
  if(!row){
    const routes=db.query("SELECT kind,payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 2")
      .all(id) as {kind:string;payload_json:string}[];
    // A source with several routes has no single destination for answer matching.
    if(routes.length>1)return null;
    row=routes[0]??null;
  }
  if(!row){
    row=db.query("SELECT kind,payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.destinationMessageId')=? ORDER BY sequence DESC LIMIT 1").get(id) as {kind:string;payload_json:string}|null;
  }
  if(!row)return null;
  const route=JSON.parse(row.payload_json);
  const peer=route.requestId?db.query('SELECT delivery_json,outcome FROM session_peer_requests WHERE request_id=?').get(route.requestId) as {delivery_json:string|null;outcome:string|null}|null:null;
  if(peer?.delivery_json&&peer.outcome)return null;
  return {
    kind: row.kind,
    destinationMessageId: route.destinationMessageId as string,
    sourceMessageId: route.sourceMessageId as string,
    topicId: route.topicId as string|undefined,
    sourceTopicId: route.sourceTopicId as string|undefined,
    sourceRoot: route.sourceRoot as string|undefined,
  };
}

function sourcesMatch(questionSources:string[],repliedTo:string|null):boolean {
  if(!repliedTo)return false;
  if(questionSources.includes(repliedTo))return true;
  const route=routedMessageFor(repliedTo);
  if(route&&(questionSources.includes(route.destinationMessageId)||questionSources.includes(route.sourceMessageId)))return true;
  for(const s of questionSources){
    const sRoute=routedMessageFor(s);
    if(sRoute&&(sRoute.destinationMessageId===repliedTo||sRoute.sourceMessageId===repliedTo))return true;
  }
  return false;
}

function resolveAskedSource(rawId:string,topic:StoredTopic):{source:AcceptedSessionInput}|null {
  if(typeof rawId!=='string'||!rawId.trim())return null;
  const id=rawId.trim();
  const route=routedMessageFor(id);
  if(route&&route.kind==='topic_route'&&route.topicId===topic.topicId){
    const source=getAcceptedSessionInput(route.sourceMessageId);
    if(source&&routerSessionOwnsTopic(source.session_id,topic.sessionId)&&humanAuthored(source))return {source};
    return null;
  }
  const source=getAcceptedSessionInput(id);
  if(!source||!routerSessionOwnsTopic(source.session_id,topic.sessionId)||!humanAuthored(source))return null;
  const root=inboxThreadRoot(source.session_id,source.id)??source.id;
  if(topicOfRoot(root)!==topic.topicId)return null;
  return {source};
}

function routerSessionOwnsTopic(sourceSessionId:number,topicSessionId:number):boolean {
  if(sourceSessionId===topicSessionId)return true;
  return !!db.query(`SELECT 1 WHERE ? IN (${INBOX_LINEAGE_SQL})`).get(topicSessionId,sourceSessionId);
}

export function readsFor(question:{topicId:string;kind?:QuestionKind;legacyNeedEventId:string|null;owner:any;brief:any;sources?:string[]}):ReadingText[] {
  if((question.kind??'decision')!=='reading')return [];
  const topic=db.query('SELECT session_id FROM inbox_topics WHERE topic_id=?').get(question.topicId) as {session_id:number}|null;
  if(!topic)return [];
  // The threads an answer may sit in: this topic's, and the thread of the message that raised
  // the item — a router files an item under the topic it belongs to, which is not always the
  // thread the turn answered in (the two items of 2026-09-24 were filed that way).
  const roots=new Set([...topicRoots(question.topicId),...(question.sources??[]).flatMap(source=>{
    const route=routedMessageFor(source);
    const dest=route?.kind==='topic_route'?route.destinationMessageId:null;
    const sourceSession=(inboxRowByMessageId(null,source) as {session_id:number}|null)?.session_id??topic.session_id;
    const root=inboxThreadRoot(sourceSession,source);
    return [root??source,...(dest?[dest]:[])];
  })]);
  const named:string[]=Array.isArray(question.brief?.reads)?question.brief.reads.filter((id:unknown):id is string=>typeof id==='string'&&!!id.trim()):[];
  if(named.length) {
    const found:ReadingText[]=[];
    for(const id of named) {
      const messageSession=(inboxRowByMessageId(null,id) as {session_id:number}|null)?.session_id??topic.session_id;
      const message=inboxMessageById(messageSession,id) as {content?:string;createdAt?:string;inputId?:string}|null;
      const root=message?.inputId?inboxThreadRoot(messageSession,message.inputId):null;
      if(message&&String(message.content??'').trim()&&root&&roots.has(root))found.push({messageId:id,text:String(message.content),at:message.createdAt??''});
    }
    return found;
  }
  const turnId=turnOfQuestion(question);
  const fromTurn=turnId===null?[]:readsForTurn(topic.session_id,turnId,roots);
  return fromTurn.length?fromTurn:serviceNoticeReads(topic.session_id,question.sources??[],roots);
}
/** An input the service published as a notice: no turn wrote it and no agent will answer it. */
const isServiceNotice=(inputId:string)=>getAcceptedSessionInput(inputId)?.scope===SERVICE_NOTICE_SCOPE;
/**
 * A service notice is written by no turn, so the notice itself is what he reads. Only an input
 * the service published as a notice counts here — never his own capture, and never a worker's
 * return, whose thread has a turn to answer in.
 */
function serviceNoticeReads(sessionId:number,sources:string[],roots:ReadonlySet<string>):ReadingText[] {
  const found:ReadingText[]=[];
  for(const source of sources) {
    if(!isServiceNotice(source)||!roots.has(inboxThreadRoot(sessionId,source)??source))continue;
    const message=inboxMessageById(sessionId,source) as {content?:string;createdAt?:string}|null;
    if(message&&String(message.content??'').trim())found.push({messageId:source,text:String(message.content),at:message.createdAt??''});
  }
  return found;
}
const NOTHING_TO_READ='Nothing to read: the turn that raised this posted nothing into this thread and left no closing text there. Post the answer first (sessions post), then declare it.';
/** A reading item still unread and with something to read: it is listed for him, counted separately,
 * and ends only with his own Read. One with nothing to read is nobody's: it is never listed, and
 * `expireUnreadableReadingItems` ends it with its reason at startup. */
const toReadByHim=(question:{state:string;kind?:QuestionKind;reads?:ReadingText[];topicId:string;legacyNeedEventId?:string|null;owner?:any;brief?:any;sources?:string[]})=>
  toReadByHimWithReads({...question,reads:question.reads??readsFor({topicId:question.topicId,kind:question.kind,
    legacyNeedEventId:question.legacyNeedEventId??null,owner:question.owner,brief:question.brief,sources:question.sources})});
const DISPOSITIONS=['completed','declined','withdrawn','superseded','failed'];

type StoredTopic={topicId:string;sessionId:number;title:string;summary:string;state:'open'|'closed';setAside:any|null;
  aliases:string[];revision:number;recovered:boolean;readSequence:number;closure:any|null;createdBy:TopicBy;createdAt:string;updatedAt:string;
  /** When he pinned it; pinned threads lead the Open list in either order. */
  pinnedAt?:string|null};
type StoredRequest={requestId:string;topicId:string;title:string;brief:string;state:'open'|'closed';disposition:string|null;
  revision:number;sources:{inputId:string;passage?:string}[];dispatches:any[];closure:any|null;createdAt:string;updatedAt:string;
  completionFloor?:number;reopenedAt?:string|null};
type StoredQuestion={questionId:string;topicId:string;revision:number;state:QuestionState;blocking:boolean;optional:boolean;
  context:'ready'|'agent_checking';brief:any;owner:any|null;sources:string[];replaces:string|null;replacedBy:string|null;
  answer:any|null;recovered:boolean;legacyNeedEventId:string|null;kind:QuestionKind;origin:QuestionOrigin;
  /** The Inbox session's attention generation when this was raised, so the session's read/dismiss cutoffs still mean something. */
  generation:number|null;
  /** When a question he set aside comes back in front of him, as an instant; null for one set aside with no time. */
  /** When a set-aside question comes back; absent or null for one with no moment. */
  deferUntil?:string|null;createdAt:string;updatedAt:string};
const linkedTodoId=(question:StoredQuestion):string|null=>{
  const id=question.owner?.todoId??question.brief?.todo;
  return typeof id==='string'&&id!=='none'&&id.trim()?id:null;
};

const nowIso=()=>new Date().toISOString();
const iso=(value:string|null|undefined)=>value?(value.includes('T')?value:value.replace(' ','T').replace(/Z?$/,'Z')):null;
const text=(value:unknown,field:string,max=4000)=>{
  if(typeof value!=='string'||!value.trim())throw new TopicError(`${field} is required.`);
  if(value.length>max)throw new TopicError(`${field} must be at most ${max} characters.`);
  return value.trim();
};
const optionalText=(value:unknown,field:string,max=4000)=>value===undefined||value===null?null:text(value,field,max);
const idList=(value:unknown,field:string):string[]=>{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()))throw new TopicError(`${field} must contain exact ids.`);
  return [...new Set(value.map(item=>(item as string).trim()))];
};

/* ------------------------------------------------------------------ root resolution */

// Which thread a message belongs to never changes unless a thread_link event says so, and
// resolving it walks replies and returns. Memoize it. A link moves one capture and whatever
// resolved through it, so only the memo entries that named its old or new root are dropped:
// rebuilding everything cost 85 s on the live ledger (2026-09-22), and links are frequent.
let rootMemo=new Map<string,string|null>();
let threadLinkWatermark=-1;
export function invalidateTopicRoots() {rootMemo=new Map();threadLinkWatermark=-1;entryIndexState=null;}
function refreshRootMemo() {
  const current=(db.query("SELECT COALESCE(MAX(sequence),0) AS sequence FROM session_owner_events WHERE kind='thread_link'").get() as {sequence:number}).sequence;
  if(current===threadLinkWatermark)return;
  if(threadLinkWatermark<0){rootMemo=new Map();entryIndexState=null;threadLinkWatermark=current;return;}
  const moved=db.query("SELECT input_id,payload_json FROM session_owner_events WHERE kind='thread_link' AND sequence>? ORDER BY sequence").all(threadLinkWatermark) as {input_id:string|null;payload_json:string}[];
  threadLinkWatermark=current;
  const affected=new Set<string>();
  for(const link of moved) {
    if(!link.input_id)continue;
    affected.add(link.input_id);
    for(const [key,root] of rootMemo)if(key.endsWith(':'+link.input_id)&&root)affected.add(root);
    const payload=JSON.parse(link.payload_json);
    if(typeof payload.root==='string')affected.add(payload.root);
  }
  for(const [key,root] of rootMemo)if((root&&affected.has(root))||[...affected].some(id=>key.endsWith(':'+id)))rootMemo.delete(key);
  if(entryIndexState)entryIndexState=reassignEntries(entryIndexState,affected);
}
function rootOf(sessionId:number,messageId:string):string|null {
  const key=`${sessionId}:${messageId}`;
  if(rootMemo.has(key))return rootMemo.get(key)??null;
  // A provider/cwd cutover created a new Inbox session, and its predecessors' messages are
  // still Inbox messages. Resolve through the session that actually holds the message.
  const root=inboxThreadRoot(sessionId,messageId)??(()=>{
    const row=inboxRowByMessageId(null,messageId) as {session_id:number}|null;
    return row&&row.session_id!==sessionId?inboxThreadRoot(row.session_id,messageId):null;
  })();
  // Only a found root is remembered. A null means there is no Inbox row for this message yet,
  // and that is usually a reply the owner has retained but not enqueued: submit refreshes the
  // session view (whose read index asks for every human input's root) before the accepted
  // event exists. Remembering that null hid every reply from its thread until an unrelated
  // thread link reset the memo, which is why his 12:51 reply appeared at 12:57 (2026-09-23).
  if(root!==null)rootMemo.set(key,root);
  return root;
}

type EntryRecord={sequence:number;at:string;sessionId:number};
/** `final` is a worker's final answer returned into this thread; `post` the router's deliberate reply there. */
type EntryKind='final'|'post'|'other';
type EntryIndex={watermark:number;messages:Map<string,EntryRecord&{root:string|null;kind:EntryKind}>;byRoot:Map<string,EntryRecord>;
  /** Per root, the newest final return and the newest router post, so a result nobody relayed is visible. */
  finals:Map<string,EntryRecord&{inputId:string}>;posts:Map<string,EntryRecord>};
let entryIndexState:EntryIndex|null=null;
function newestByRoot(messages:EntryIndex['messages']) {
  const byRoot=new Map<string,EntryRecord>(),finals=new Map<string,EntryRecord&{inputId:string}>(),posts=new Map<string,EntryRecord>();
  for(const [messageId,entry] of messages) {
    if(!entry.root)continue;
    const record={sequence:entry.sequence,at:entry.at,sessionId:entry.sessionId};
    const current=byRoot.get(entry.root);
    if(!current||entry.sequence>current.sequence)byRoot.set(entry.root,record);
    if(entry.kind==='final'&&(finals.get(entry.root)?.sequence??-1)<entry.sequence)finals.set(entry.root,{...record,inputId:messageId});
    if(entry.kind==='post'&&(posts.get(entry.root)?.sequence??-1)<entry.sequence)posts.set(entry.root,record);
  }
  return {byRoot,finals,posts};
}
/** A `return:<eventId>` input is a final answer when the event it carries is the worker's final reply. */
function entryKind(row:any):EntryKind {
  if(row.kind==='post')return 'post';
  // Only the returned input itself is a worker's answer. The Inbox's own turn reply carries the
  // same input id (it answered that return), and counting it kept the thread showing an answer as
  // not relayed after the Inbox had posted (2026-09-23).
  if(row.kind!=='accepted')return 'other';
  const inputId=typeof row.input_id==='string'?row.input_id:'';
  if(row.origin!=='service'||!inputId.startsWith('return:'))return 'other';
  const eventId=inputId.slice('return:'.length);
  const kind=(db.query('SELECT kind FROM session_communication_events WHERE event_id=?').get(eventId) as {kind:string}|null)?.kind
    ??(db.query('SELECT kind FROM session_peer_events WHERE event_id=?').get(eventId) as {kind:string}|null)?.kind;
  return kind==='final'?'final':'other';
}
/** Every Inbox message with its thread root, and every root with its newest entry. Built once, then only over new rows. */
function entryIndex():EntryIndex {
  refreshRootMemo();
  const index=entryIndexState??={watermark:0,messages:new Map(),byRoot:new Map(),finals:new Map(),posts:new Map()};
  entryIndexState=index;
  extendEntryIndex(index,-1);
  return index;
}
/**
 * Fills the index after a restart in time-bounded steps that yield the owner between them.
 * A reader that arrives mid-warm finishes only what is left; a thread move that resets the
 * memo mid-warm makes the next step start over. Nothing is written.
 */
export async function warmEntryIndex(options:{stopped?:()=>boolean;batch?:number}={}):Promise<{rows:number;steps:number;ms:number;complete:boolean}> {
  const batch=Math.max(1,options.batch??ENTRY_INDEX_WARM_BATCH);
  const started=performance.now();
  let rows=0,steps=0;
  for(;;) {
    if(options.stopped?.())return {rows,steps,ms:Math.round(performance.now()-started),complete:false};
    refreshRootMemo();
    const index=entryIndexState??={watermark:0,messages:new Map(),byRoot:new Map(),finals:new Map(),posts:new Map()};
    entryIndexState=index;
    const read=extendEntryIndex(index,batch,performance.now()+ENTRY_INDEX_WARM_STEP_MS);
    rows+=read.rows;steps+=1;
    if(read.exhausted)return {rows,steps,ms:Math.round(performance.now()-started),complete:true};
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
}
const ENTRY_INDEX_WARM_BATCH=16;
const ENTRY_INDEX_WARM_STEP_MS=12;
/** Extends the index over the next rows past its watermark; `limit` bounds the read, -1 reads to the end. */
function extendEntryIndex(index:EntryIndex,limit:number,deadline=Infinity):{rows:number;exhausted:boolean} {
  const rows=db.query(`${inboxRows} AND event.sequence>? ORDER BY event.sequence LIMIT ?`).all(index.watermark,limit) as any[];
  let processed=0;
  for(const row of rows) {
    indexEntryRow(index,row);
    processed++;
    if(performance.now()>=deadline)break;
  }
  return {rows:processed,exhausted:processed===rows.length&&rows.length<limit};
}
function indexEntryRow(index:EntryIndex,row:any) {
  index.watermark=row.sequence;
  const messageId=inboxMessageId(row);
  if(!messageId)return;
  const root=rootOf(row.session_id,messageId);
  const kind=entryKind(row);
  const record={sequence:row.sequence,at:iso(row.created_at)!,sessionId:row.session_id};
  index.messages.set(messageId,{...record,root,kind});
  if(!root)return;
  const current=index.byRoot.get(root);
  if(!current||row.sequence>current.sequence)index.byRoot.set(root,record);
  if(kind==='final'&&(index.finals.get(root)?.sequence??-1)<row.sequence)index.finals.set(root,{...record,inputId:messageId});
  if(kind==='post'&&(index.posts.get(root)?.sequence??-1)<row.sequence)index.posts.set(root,record);
}
/** After a thread link moved, only the messages in the threads it touched are resolved again. */
function reassignEntries(index:EntryIndex,affected:Set<string>):EntryIndex {
  for(const [messageId,entry] of index.messages) {
    if(!affected.has(messageId)&&!(entry.root&&affected.has(entry.root)))continue;
    index.messages.set(messageId,{...entry,root:rootOf(entry.sessionId,messageId)});
  }
  return {...index,...newestByRoot(index.messages)};
}

/* ------------------------------------------------------------------ stored records */

const toStoredTopic=(row:any):StoredTopic=>({topicId:row.topic_id,sessionId:row.session_id,title:row.title,summary:row.summary,
  state:row.state,setAside:row.set_aside_json?JSON.parse(row.set_aside_json):null,aliases:JSON.parse(row.aliases_json),
  revision:row.revision,recovered:!!row.recovered,readSequence:row.read_sequence,closure:row.closure_json?JSON.parse(row.closure_json):null,
  createdBy:JSON.parse(row.created_by_json),createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,pinnedAt:iso(row.pinned_at)??null});
const toStoredRequest=(row:any):StoredRequest=>({requestId:row.request_id,topicId:row.topic_id,title:row.title,brief:row.brief,
  state:row.state,disposition:row.disposition,revision:row.revision,sources:JSON.parse(row.sources_json),dispatches:JSON.parse(row.dispatches_json),
  closure:row.closure_json?JSON.parse(row.closure_json):null,createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!,
  completionFloor:row.completion_floor??0,reopenedAt:iso(row.reopened_at)});
const toStoredQuestion=(row:any):StoredQuestion=>({questionId:row.question_id,topicId:row.topic_id,revision:row.revision,state:row.state,
  blocking:!!row.blocking,optional:!!row.optional,context:row.context,brief:JSON.parse(row.brief_json),
  owner:row.owner_json?JSON.parse(row.owner_json):null,sources:JSON.parse(row.sources_json),replaces:row.replaces,replacedBy:row.replaced_by,
  answer:row.answer_json?JSON.parse(row.answer_json):null,recovered:!!row.recovered,legacyNeedEventId:row.legacy_need_event_id,
  kind:row.kind==='reading'?'reading':row.kind==='asked'?'asked':'decision',origin:['marker','recovered'].includes(row.origin)?row.origin:'declared',
  generation:typeof row.generation==='number'?row.generation:null,deferUntil:iso(row.defer_until),
  createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!});

function upsertTopic(topic:StoredTopic) {
  db.query(`INSERT INTO inbox_topics(topic_id,session_id,title,summary,state,set_aside_json,aliases_json,revision,recovered,read_sequence,created_at,updated_at,closure_json,created_by_json,pinned_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(topic_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,state=excluded.state,set_aside_json=excluded.set_aside_json,
      aliases_json=excluded.aliases_json,revision=excluded.revision,recovered=excluded.recovered,read_sequence=excluded.read_sequence,
      updated_at=excluded.updated_at,closure_json=excluded.closure_json,pinned_at=excluded.pinned_at`)
    .run(topic.topicId,topic.sessionId,topic.title,topic.summary,topic.state,topic.setAside?JSON.stringify(topic.setAside):null,
      JSON.stringify(topic.aliases),topic.revision,topic.recovered?1:0,topic.readSequence,topic.createdAt,topic.updatedAt,
      topic.closure?JSON.stringify(topic.closure):null,JSON.stringify(topic.createdBy),topic.pinnedAt??null);
}
function upsertRequest(request:StoredRequest) {
  db.query(`INSERT INTO inbox_requests(request_id,topic_id,title,brief,state,disposition,revision,sources_json,dispatches_json,closure_json,created_at,updated_at,completion_floor,reopened_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET topic_id=excluded.topic_id,title=excluded.title,brief=excluded.brief,state=excluded.state,
      disposition=excluded.disposition,revision=excluded.revision,sources_json=excluded.sources_json,dispatches_json=excluded.dispatches_json,
      closure_json=excluded.closure_json,updated_at=excluded.updated_at,completion_floor=excluded.completion_floor,reopened_at=excluded.reopened_at`)
    .run(request.requestId,request.topicId,request.title,request.brief,request.state,request.disposition,request.revision,
      JSON.stringify(request.sources),JSON.stringify(request.dispatches),request.closure?JSON.stringify(request.closure):null,
      request.createdAt,request.updatedAt,request.completionFloor??0,request.reopenedAt??null);
}
function upsertQuestion(question:StoredQuestion) {
  db.query(`INSERT INTO inbox_questions(question_id,topic_id,revision,state,blocking,optional,context,brief_json,owner_json,sources_json,replaces,replaced_by,answer_json,recovered,legacy_need_event_id,kind,origin,generation,created_at,updated_at,defer_until)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(question_id) DO UPDATE SET topic_id=excluded.topic_id,revision=excluded.revision,state=excluded.state,blocking=excluded.blocking,
      optional=excluded.optional,context=excluded.context,brief_json=excluded.brief_json,owner_json=excluded.owner_json,sources_json=excluded.sources_json,
      replaces=excluded.replaces,replaced_by=excluded.replaced_by,answer_json=excluded.answer_json,recovered=excluded.recovered,
      legacy_need_event_id=excluded.legacy_need_event_id,kind=excluded.kind,origin=excluded.origin,generation=excluded.generation,updated_at=excluded.updated_at,defer_until=excluded.defer_until`)
    .run(question.questionId,question.topicId,question.revision,question.state,question.blocking?1:0,question.optional?1:0,question.context,
      JSON.stringify(question.brief),question.owner?JSON.stringify(question.owner):null,JSON.stringify(question.sources),
      question.replaces,question.replacedBy,question.answer?JSON.stringify(question.answer):null,question.recovered?1:0,
      question.legacyNeedEventId,question.kind??'decision',question.origin??'declared',question.generation??null,question.createdAt,question.updatedAt,question.deferUntil??null);
}

function topicRow(topicId:string) {
  const row=db.query('SELECT * FROM inbox_topics WHERE topic_id=?').get(topicId) as any;
  if(!row)throw new TopicError('Unknown topic.',404,'TOPIC_UNKNOWN');
  return toStoredTopic(row);
}
function requestRow(requestId:string) {
  const row=db.query('SELECT * FROM inbox_requests WHERE request_id=?').get(requestId) as any;
  if(!row)throw new TopicError('Unknown request.',404,'REQUEST_UNKNOWN');
  return toStoredRequest(row);
}
function questionRow(questionId:string) {
  const row=db.query('SELECT * FROM inbox_questions WHERE question_id=?').get(questionId) as any;
  if(!row)throw new TopicError('Unknown question.',404,'QUESTION_UNKNOWN');
  return toStoredQuestion(row);
}
const topicRoots=(topicId:string)=>(db.query('SELECT root_input_id FROM inbox_topic_roots WHERE topic_id=? ORDER BY placed_at,root_input_id').all(topicId) as {root_input_id:string}[]).map(row=>row.root_input_id);
export function topicOfRoot(rootInputId:string):string|null {
  const row=db.query('SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?').get(rootInputId) as {topic_id:string}|null;
  return row?.topic_id??null;
}

/* ------------------------------------------------------------------ event application */

/**
 * One function applies a topic event to the tables, whether it was just recorded or is
 * being replayed. Every event carries the full record of everything it changed, so the
 * projection can never disagree with the ledger.
 */
export function applyTopicChange(kind:string,payload:any) {
  projectTopicChange(kind,payload);
  if(kind!=='area')keepThreadOpenOrClosed(payload);
  if(kind==='topic'&&MEANING_CHANGES.has(payload?.change)&&typeof payload.topicId==='string')threadChanges.changed(payload.topicId);
}
/** Topic changes after which a thread's meaning is compared with the areas again. */
const MEANING_CHANGES=new Set(['created','renamed','summary','placed','routed','merged','reopened']);
/** The projection alone, for replay: a replayed event never records anything new. */
function projectTopicChange(kind:string,payload:any) {
  if(kind==='area'){applyAreaChange(payload);return;}
  for(const topic of [payload.topic,payload.mergedTopic,...(payload.topics??[])])if(topic)upsertTopic(topic);
  for(const link of payload.removedAreaLinks??[])db.query('DELETE FROM inbox_area_threads WHERE area_id=? AND topic_id=?').run(link.areaId,link.topicId);
  for(const link of payload.areaLinks??[])db.query(`INSERT INTO inbox_area_threads(area_id,topic_id,origin,reason,created_at)
    VALUES(?,?,?,?,?) ON CONFLICT(area_id,topic_id) DO NOTHING`).run(link.areaId,link.topicId,link.origin,link.reason??'',link.at);
  for(const root of payload.removedRoots??[])db.query('DELETE FROM inbox_topic_roots WHERE root_input_id=?').run(root.rootInputId);
  for(const root of payload.roots??[])
    db.query(`INSERT INTO inbox_topic_roots(root_input_id,topic_id,placed_at,placed_by_json,reason) VALUES(?,?,?,?,?)
      ON CONFLICT(root_input_id) DO UPDATE SET topic_id=excluded.topic_id,placed_at=excluded.placed_at,placed_by_json=excluded.placed_by_json,reason=excluded.reason`)
      .run(root.rootInputId,root.topicId,root.placedAt,JSON.stringify(root.placedBy??{}),root.reason??null);
  for(const request of [...(payload.request?[payload.request]:[]),...(payload.requests??[])])upsertRequest(request);
  for(const question of payload.questions??[])upsertQuestion(question);
  for(const item of payload.reading??[])
    db.query('INSERT OR IGNORE INTO inbox_topic_reading(topic_id,item_id,revision,kind,at,by_json) VALUES(?,?,?,?,?,?)')
      .run(item.topicId,item.itemId,item.revision??0,item.kind,item.at,item.by?JSON.stringify(item.by):null);
  if(kind==='topic_focus') {
    if(payload.topicId)db.query(`INSERT INTO inbox_focus(session_id,topic_id,input_ids_json,run_id,summary,since) VALUES(?,?,?,?,?,?)
        ON CONFLICT(session_id) DO UPDATE SET topic_id=excluded.topic_id,input_ids_json=excluded.input_ids_json,run_id=excluded.run_id,summary=excluded.summary,since=excluded.since`)
      .run(payload.sessionId,payload.topicId,JSON.stringify(payload.inputIds??[]),payload.runId??null,payload.summary??null,payload.since??null);
    else db.query('DELETE FROM inbox_focus WHERE session_id=?').run(payload.sessionId);
  }
}

/** Replays every topic event into the tables. Used by migration/repair; safe to run twice. */
export function rebuildTopicProjections() {
  return db.transaction(()=>{
    for(const table of ['inbox_area_neighbors','inbox_area_threads','inbox_areas','inbox_topic_roots','inbox_requests','inbox_questions','inbox_topic_reading','inbox_focus','inbox_topics'])db.exec(`DELETE FROM ${table}`);
    const rows=db.query(`SELECT kind,payload_json FROM session_owner_events WHERE kind IN (${TOPIC_EVENT_KINDS.map(()=>'?').join(',')}) ORDER BY sequence`).all(...[...TOPIC_EVENT_KINDS]) as {kind:string;payload_json:string}[];
    for(const row of rows) {
      if(row.kind==='topics_migration')continue;
      projectTopicChange(row.kind,JSON.parse(row.payload_json));
    }
    return {events:rows.length,topics:(db.query('SELECT count(*) AS count FROM inbox_topics').get() as {count:number}).count};
  })();
}

/* ------------------------------------------------------------------ mutation plumbing */

type Change={kind:string;payload:any};
const emptyRetainTiming=():RetainInputTiming=>({serializeMs:0,existingMs:0,cancellationMs:0,insertMs:0,readbackMs:0,transactionOtherMs:0});
const roundedRetainTiming=(timing:RetainInputTiming)=>Object.fromEntries(Object.entries(timing).map(([key,value])=>[key,Math.round(value)]));
function record(sessionId:number,inputId:string,turnId:number|null,change:Change) {
  change=reopenedForNewWork(change);
  const actorSession=getSessionById(sessionId);
  const actorIsInbox=!!actorSession&&!!sessionMetadata(actorSession).inbox;
  const newlyWaiting=change.kind==='topic_question'&&change.payload?.change==='reconciled'
    ?(change.payload.questions as StoredQuestion[]).filter(question=>{
      if(!awaitingHim(question)||question.legacyNeedEventId&&actorIsInbox)return false;
      const row=db.query('SELECT * FROM inbox_questions WHERE question_id=?').get(question.questionId) as any|null;
      return !row||!awaitingHim(toStoredQuestion(row));
    }):[];
  recordSessionEvent({eventId:`topic-change:${inputId}`,sessionId,inputId,turnId:turnId??null,kind:change.kind,payload:change.payload});
  applyTopicChange(change.kind,change.payload);
  if(newlyWaiting.length) {
    const session=inboxSession();
    if(!session)return;
    refreshRootMemo();
    for(const question of newlyWaiting) {
      const source=question.sources.find(id=>rootOf(session.id,id));
      const root=(source?rootOf(session.id,source):null)??topicRoots(question.topicId).at(-1)??null;
      if(!root)continue;
      const postId=question.sources.find(id=>db.query("SELECT 1 FROM session_owner_events WHERE event_id=? AND session_id=? AND kind IN ('post','result')").get(id,session.id))??null;
      if(postId&&messageAlreadyNotified(session.id,postId))continue;
      const author=typeof question.owner?.sessionId==='string'?sessionAuthor(question.owner.sessionId):null;
      const notificationInputId=postId?consumeThreadNotification(session.id,root,postId):null;
      const generation=session.id===sessionId?question.generation:raiseGeneration(session);
      recordSessionEvent({eventId:`needs_you:question:${question.questionId}`,sessionId:session.id,inputId:root,kind:'needs_you',
        payload:{outcome:notificationInputId?'response':'needs_you',question:String(question.brief.decision).slice(0,2000),inputId:root,
          generation,topicId:question.topicId,questionId:question.questionId,
          ...(linkedTodoId(question)?{todoId:linkedTodoId(question)}:{}),
          runId:change.payload.by?.runId??null,blockingNotification:true,
          ...(author?.agentName?{agentName:author.agentName}:{}),...(author?.title?{taskTitle:author.title}:{}),
          ...(notificationInputId?{notificationInputId,requestedNotification:true}:{}),
          ...(postId?{postId}:{})}});
    }
  }
}
/** Every agent mutation is retained by source input + action id; a duplicate returns the first receipt. */
function agentMutation<T extends object>(actor:TopicActor,actionId:string,payload:unknown,run:(actionInputId:string)=>{change:Change;result:T},eventSessionId=actor.sessionId):T&{duplicate?:boolean} {
  const started=performance.now();
  let retainMs=0,computeMs=0,recordMs=0,receiptMs=0,duplicate=false,completed=false;
  let phaseStart=started,phaseName:'retain'|'compute'|'record'|'receipt'|'commit'='retain';
  const retainTiming=emptyRetainTiming();
  let resultForTrace:T|null=null;
  let changeTopicId:string|null=null;
  try {
    const result=db.transaction(()=>{
      const saved=retainSessionInput({sessionId:actor.sessionId,scope:`communication:${actor.inputId}`,actionId,kind:'action',origin:'agent',
        payload,sourceInputId:actor.inputId,sourceRunId:actor.runId,timing:retainTiming});
      retainMs=performance.now()-phaseStart;
      phaseStart=performance.now();phaseName='compute';
      if(saved.duplicate){duplicate=true;phaseName='commit';return {...(JSON.parse(saved.input.receipt_json??'{}').result??{}),duplicate:true};}
      const {change,result}=run(saved.input.id);
      computeMs=performance.now()-phaseStart;
      resultForTrace=result;
      changeTopicId=typeof change.payload?.topicId==='string'?change.payload.topicId:null;
      phaseStart=performance.now();phaseName='record';
      record(eventSessionId,saved.input.id,actor.turnId,change);
      recordMs=performance.now()-phaseStart;
      phaseStart=performance.now();phaseName='receipt';
      db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',result}),saved.input.id);
      receiptMs=performance.now()-phaseStart;
      phaseName='commit';
      return {...result,duplicate:false};
    })();
    completed=true;
    return result;
  } finally {
    const ended=performance.now(),totalMs=ended-started;
    if(phaseName==='retain')retainMs=ended-phaseStart;
    else if(phaseName==='compute'&&!duplicate)computeMs=ended-phaseStart;
    else if(phaseName==='record')recordMs=ended-phaseStart;
    else if(phaseName==='receipt')receiptMs=ended-phaseStart;
    if(totalMs>=250) {
      const named=payload as {kind?:unknown;topicId?:unknown;requestId?:unknown;questionId?:unknown;from?:unknown;into?:unknown};
      let topicId=typeof named?.topicId==='string'?named.topicId:changeTopicId??(typeof named?.from==='string'?named.from:null);
      if(!topicId&&resultForTrace&&'topic' in resultForTrace) {
        const topic=(resultForTrace as {topic?:{topicId?:unknown}}).topic;
        if(typeof topic?.topicId==='string')topicId=topic.topicId;
      }
      try {
        if(!topicId&&typeof named?.requestId==='string')
          topicId=(db.query('SELECT topic_id FROM inbox_requests WHERE request_id=?').get(named.requestId) as {topic_id:string}|null)?.topic_id??null;
        if(!topicId&&typeof named?.questionId==='string')
          topicId=(db.query('SELECT topic_id FROM inbox_questions WHERE question_id=?').get(named.questionId) as {topic_id:string}|null)?.topic_id??null;
      } catch { /* Diagnostic attribution must never replace the command's result. */ }
      log('warn','inbox_topic_mutation_slow',{actor:'agent',action:typeof named?.kind==='string'?named.kind:'unknown',topic_id:topicId,
        ...(named?.kind==='topic-merge'&&typeof named.from==='string'?{source_topic_id:named.from}:{}),
        ...(named?.kind==='topic-merge'&&typeof named.into==='string'?{target_topic_id:named.into}:{}),
        duration_ms:Math.round(totalMs),retain_ms:Math.round(retainMs),retain_detail_ms:roundedRetainTiming(retainTiming),compute_ms:Math.round(computeMs),
        record_ms:Math.round(recordMs),receipt_ms:Math.round(receiptMs),
        transaction_other_ms:Math.round(Math.max(0,totalMs-retainMs-computeMs-recordMs-receiptMs)),duplicate,outcome:completed?'completed':'failed'});
    }
  }
}
/** His own action on a topic. Same retained-receipt shape as the owner's other human controls. */
function humanMutation(sessionId:number,clientActionId:string,payload:unknown,run:()=>{change:Change;result:Record<string,any>}) {
  if(typeof clientActionId!=='string'||!clientActionId||clientActionId.length>200)throw new TopicError('Stable clientActionId required.');
  const started=performance.now();
  let retainMs=0,computeMs=0,recordMs=0,receiptMs=0,duplicate=false,completed=false;
  let phaseStart=started,phaseName:'retain'|'compute'|'record'|'receipt'|'commit'='retain';
  const retainTiming=emptyRetainTiming();
  let resultForTrace:Record<string,any>|null=null;
  try {
    const result=db.transaction(()=>{
      const saved=retainSessionInput({sessionId,scope:'surface:thinkering',actionId:clientActionId,kind:'topic-action',origin:'human',payload,timing:retainTiming});
      retainMs=performance.now()-phaseStart;
      phaseStart=performance.now();phaseName='compute';
      if(saved.duplicate){duplicate=true;phaseName='commit';return {...(JSON.parse(saved.input.receipt_json??'{}').result??{}),duplicate:true};}
      const {change,result}=run();
      computeMs=performance.now()-phaseStart;
      resultForTrace=result;
      phaseStart=performance.now();phaseName='record';
      record(sessionId,saved.input.id,null,change);
      recordMs=performance.now()-phaseStart;
      phaseStart=performance.now();phaseName='receipt';
      // His app answers an action with the thread as it now stands, so the answer is the thread view
      // at the revision just recorded, saved with the receipt so a retry returns the same bytes. The
      // stored record alone had no id or messages; the app threw on it and called a saved pin
      // pending (2026-11-04, report e0889a03).
      // The view is the answer the app wants, never a reason to refuse an action already recorded:
      // if it cannot be computed, the stored record answers (the app reads its revision too).
      let answered=result;
      if(result.topic&&typeof result.topic.topicId==='string'){
        try{answered={...result,topic:topicView(result.topic.topicId)};}
        catch(error){log('warn','inbox_topic_answer_view_failed',{topic_id:result.topic.topicId,...errorFields(error)});}
      }
      db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',result:answered}),saved.input.id);
      receiptMs=performance.now()-phaseStart;
      phaseName='commit';
      return {...answered,duplicate:false};
    })();
    completed=true;
    return result;
  } finally {
    const ended=performance.now(),totalMs=ended-started;
    if(phaseName==='retain')retainMs=ended-phaseStart;
    else if(phaseName==='compute'&&!duplicate)computeMs=ended-phaseStart;
    else if(phaseName==='record')recordMs=ended-phaseStart;
    else if(phaseName==='receipt')receiptMs=ended-phaseStart;
    if(totalMs>=250) {
      const named=payload as {kind?:unknown;topicId?:unknown;action?:{into?:unknown}};
      const createdId=resultForTrace?.topic?.topicId;
      log('warn','inbox_topic_mutation_slow',{actor:'human',action:typeof named?.kind==='string'?named.kind:'unknown',
        topic_id:typeof named?.topicId==='string'?named.topicId:typeof createdId==='string'?createdId:null,duration_ms:Math.round(totalMs),
        ...((named?.kind==='topic-merge'||named?.kind==='topic-move')&&typeof named.action?.into==='string'?{target_topic_id:named.action.into}:{}),
        retain_ms:Math.round(retainMs),retain_detail_ms:roundedRetainTiming(retainTiming),compute_ms:Math.round(computeMs),record_ms:Math.round(recordMs),
        receipt_ms:Math.round(receiptMs),transaction_other_ms:Math.round(Math.max(0,totalMs-retainMs-computeMs-recordMs-receiptMs)),
        duplicate,outcome:completed?'completed':'failed'});
    }
  }
}
/** One thread as the app's lists and thread view show it, computed from the ledger as it stands now. */
function topicView(topicId:string) {
  const session=inboxOrThrow();
  const topic=topicRow(topicId);
  const summary=topicSummary(topic,session,entryIndex(),workIndex(session.id),readIndex(session.id));
  // The stored identity field stays beside the view's own, so every reader of the old answer keeps working.
  return {...summary,topicId,closure:topic.closure,history:topicHistory(session.id,topicId)};
}
function bumped(topic:StoredTopic,change:Partial<StoredTopic>={}):StoredTopic {
  return {...topic,...change,revision:topic.revision+1,updatedAt:nowIso()};
}
function expectRevision(topic:StoredTopic,expected:unknown) {
  if(expected===undefined||expected===null)return;
  const value=Number(expected);
  if(!Number.isSafeInteger(value))throw new TopicError('Expected revision must be a whole number.');
  if(value!==topic.revision)throw new TopicError(`This topic changed (revision ${topic.revision}); read it again before deciding.`,409,'TOPIC_REVISION_STALE');
}

/* ------------------------------------------------------------------ read projections */

function focusRow(sessionId:number) {
  const row=db.query('SELECT * FROM inbox_focus WHERE session_id=?').get(sessionId) as any;
  if(!row?.topic_id)return null;
  // Focus belongs to the run that declared it; a run that ended is not working on anything.
  if(row.run_id&&!db.query("SELECT 1 FROM turns WHERE session_id=? AND native_run_id=? AND status IN ('running','delivering')").get(sessionId,row.run_id))return null;
  return {topicId:row.topic_id as string,inputIds:JSON.parse(row.input_ids_json) as string[],runId:row.run_id as string|null,
    summary:row.summary as string|null,since:row.since as string|null};
}
function queuedInboxInputs(sessionId:number) {
  return (db.query(`SELECT id FROM session_inputs WHERE session_id=? AND turn_id IS NULL AND steering_id IS NULL
    AND json_extract(COALESCE(receipt_json,'{}'),'$.state') IS NULL AND kind IN ('input','create','inbox-capture') ORDER BY rowid`).all(sessionId) as {id:string}[]).map(row=>row.id);
}
type WorkIndex={sessionId:number;focus:ReturnType<typeof focusRow>;focusTitle:string|null;queued:{inputId:string;root:string|null;position:number}[];
  dispatches:{root:string|null;sessionId:string|null;title:string;requestId:string}[]};
function workIndex(sessionId:number):WorkIndex {
  const focus=focusRow(sessionId);
  const focusTitle=focus?(db.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(focus.topicId) as {title:string}|null)?.title??null:null;
  const queued=queuedInboxInputs(sessionId).map((inputId,index)=>({inputId,root:rootOf(sessionId,inputId),position:index+1}));
  const dispatches:WorkIndex['dispatches']=[];
  // A dispatch belongs to the thread its request named, else to the input its turn started from.
  for(const row of db.query(`SELECT request_id,COALESCE(thread_root_input_id,source_input_id) AS source_input_id,target_session_id FROM session_communication_requests
      WHERE source_session_id=? AND outcome IS NULL AND source_input_id IS NOT NULL`).all(sessionId) as any[]) {
    const running=db.query("SELECT 1 FROM turns WHERE session_id=? AND status IN ('running','delivering','queued')").get(row.target_session_id);
    if(!running)continue;
    const target=getSessionById(row.target_session_id);
    dispatches.push({root:rootOf(sessionId,row.source_input_id),sessionId:`concierge:${row.target_session_id}`,
      title:(target&&sessionMetadata(target).title)||'Agent session',requestId:row.request_id});
  }
  for(const row of db.query(`SELECT request_id,COALESCE(thread_root_input_id,source_input_id) AS source_input_id,peer,remote_session_id FROM session_peer_requests
      WHERE source_session_id=? AND outcome IS NULL`).all(sessionId) as any[]) {
    const catalogue=db.query('SELECT view_json FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').get(row.peer,row.remote_session_id) as {view_json:string}|null;
    dispatches.push({root:rootOf(sessionId,row.source_input_id),sessionId:receiveSessionFromPeer(row.remote_session_id,row.peer),
      title:(catalogue?JSON.parse(catalogue.view_json)?.title:null)||`${row.peer} session`,requestId:row.request_id});
  }
  return {sessionId,focus,focusTitle,queued,dispatches};
}
/**
 * What is happening to this thread, in words he would use. `text` is detail a surface adds
 * after its own label, so it is empty when there is nothing to add, and it never names a
 * session, an id or a model: "Threads: his messages and unreadable headers is working" told
 * him nothing and read as if written about someone else (Tejas, 2026-09-22).
 */
function topicWork(topic:StoredTopic,roots:string[],index:WorkIndex,entries:EntryIndex) {
  if(index.focus?.topicId===topic.topicId)
    return {kind:'router_working' as const,text:index.focus.summary??'',runId:index.focus.runId,sessionId:`concierge:${index.sessionId}`};
  const queued=index.queued.find(item=>item.root&&roots.includes(item.root));
  if(queued) {
    const ahead=queued.position-1;
    const text=index.focusTitle
      ?ahead<=0?`Router is with ${index.focusTitle}; yours is next`
        :ahead===1?`Waiting behind ${index.focusTitle} and 1 other reply`
        :`Waiting behind ${index.focusTitle} and ${ahead} others`
      :ahead<=0?'Queued; the router takes it next':`Queued behind ${ahead} ${ahead===1?'reply':'replies'}`;
    return {kind:'router_queued' as const,text,position:queued.position};
  }
  // A worker's final answer came back into this thread and the router has not posted there
  // since. That is the router's job, shown to him so nobody has to read logs to know it is owed.
  const unrelayed=unrelayedFinal(roots,entries);
  if(unrelayed)return {kind:'result_waiting' as const,text:'An agent\'s answer came back and has not been relayed to you',returnInputId:unrelayed.inputId,since:unrelayed.at};
  // A session can hold several requests for the same thread. They are separate deliveries,
  // but one working agent in the Brief; accepted session handoffs move open requests to the
  // successor session, so the current target ID remains the stable grouping key.
  const working=index.dispatches.filter(item=>item.root&&roots.includes(item.root));
  if(working.length){
    const current=topicCurrentWorkers(db,working);
    return {kind:'worker_working' as const,text:current.length===1?`With ${current[0]!.title}`:`With ${current.length} agents`,
      sessionId:current[0]!.sessionId,workers:current};
  }
  return {kind:'idle' as const,text:''};
}
/**
 * Returns older than the relay rule are history: before it, the router answered many returns in
 * its own turn text and never posted, so every old thread would read as owing a relay (15 of 21
 * open threads in the dry run, 2026-09-23). Only a final that arrived once posting was the rule
 * can be owed.
 */
const RELAY_RULE_SINCE='2026-09-23T05:30:00.000Z';
/** The newest final return under these roots with no router post after it, if any. */
function unrelayedFinal(roots:string[],entries:EntryIndex) {
  let found:(EntryRecord&{inputId:string})|null=null;
  for(const root of roots) {
    const final=entries.finals.get(root);
    if(!final||final.at<RELAY_RULE_SINCE)continue;
    if((entries.posts.get(root)?.sequence??-1)>final.sequence)continue;
    if(!found||final.sequence>found.sequence)found=final;
  }
  return found;
}

/** A provider prompt needs only this topic's returns. It must not wait for the unrelated
 * Inbox entry index to rebuild after a restart. Topic dispatches and root-addressed
 * upkeep requests are both durable request identities; a retained return is eligible
 * only once it appears in Inbox history. */
function promptUnrelayedFinal(sessionId:number,topicId:string,roots:string[]) {
  if(!roots.length)return null;
  const rootSet=new Set(roots);
  const finals=new Map<string,EntryRecord&{inputId:string}>();
  const requestIds=new Set(topicRequests(topicId).flatMap(request=>request.dispatches.map(dispatch=>String(dispatch.requestId??''))).filter(Boolean));
  const placeholders=roots.map(()=>'?').join(',');
  for(const table of ['session_communication_requests','session_peer_requests']) {
    const addressed=db.query(`SELECT request_id FROM ${table} WHERE source_session_id IN (${inboxLineageSql})
      AND thread_root_input_id IN (${placeholders})`).all(sessionId,...roots) as {request_id:string}[];
    for(const row of addressed)requestIds.add(row.request_id);
  }
  for(const requestId of requestIds)for(const table of ['session_communication_events','session_peer_events']) {
    const events=db.query(`SELECT event_id FROM ${table} WHERE request_id=? AND kind='final'`).all(requestId) as {event_id:string}[];
    for(const event of events) {
      const inputId=`return:${event.event_id}`;
      const row=inboxRowByMessageId(null,inputId) as {session_id:number;kind:string;origin:string;sequence:number;created_at:string}|null;
      if(row?.kind!=='accepted'||row.origin!=='service')continue;
      const root=rootOf(row.session_id,inputId);
      if(!root||!rootSet.has(root))continue;
      const record={sequence:row.sequence,at:iso(row.created_at)!,sessionId:row.session_id,inputId};
      if((finals.get(root)?.sequence??-1)<record.sequence)finals.set(root,record);
    }
  }
  let found:(EntryRecord&{inputId:string})|null=null;
  for(const [root,final] of finals) {
    if(final.at<RELAY_RULE_SINCE)continue;
    // Current posts name their root directly. Historical posts can carry an explicit
    // threadRoot while naming a different input; both forms count as a relay.
    const direct=db.query(`${inboxRows} AND event.input_id=? AND event.kind='post'
      AND event.sequence>? LIMIT 1`).get(root,final.sequence);
    if(direct)continue;
    const explicit=db.query(`${inboxRows} AND event.kind='post'
      AND json_extract(event.payload_json,'$.threadRoot')=? AND event.sequence>? LIMIT 1`)
      .get(root,final.sequence);
    if(explicit)continue;
    if(!found||final.sequence>found.sequence)found=final;
  }
  return found;
}

/**
 * Attention the Inbox holds outside its question records: a turn's end-of-turn marker that no
 * declared question covered. It is not filed anywhere — filing by the thread that happened to
 * start the turn put two questions about the Mac capture bar under "Signing my other accounts
 * in" (2026-09-23) — so it waits, visibly, for the router (`topics file`) or him to file it.
 */
function unfiledNeeds(session:SessionRow):OpenNeed[] {
  const covered=new Set((db.query('SELECT legacy_need_event_id FROM inbox_questions WHERE legacy_need_event_id IS NOT NULL').all() as {legacy_need_event_id:string}[])
    .map(row=>row.legacy_need_event_id));
  return (sessionMetadata(session).needs??[]).filter(need=>!covered.has(need.eventId));
}
/**
 * Read-time indexes built once per read and shared by every topic summary. A list of a few
 * hundred topics must not scan the ledger once per topic: the first list read did exactly
 * that (a json_extract over 93k events per topic) and took 19 seconds (Tejas, 2026-09-22).
 */
type HumanReply={inputId:string;at:string;reviews:string[];replyTo:string|null};
type ReadIndex={humanReplies:Map<string,HumanReply[]>};
const inboxLineageSql=INBOX_LINEAGE_SQL;
function readIndex(sessionId:number,completeReplies=false):ReadIndex {
  refreshRootMemo();
  // Every human message per thread root, newest first, with the questions it reviewed and the
  // message it replied to: a reply counts against a question only when it names it (design:
  // "Answering an unrelated later message changes nothing here").
  // Upkeep reads every explicit reply so an answered old question cannot fall past the list
  // view's 2,000-input bound and strand its request as waiting on him.
  const humanReplies=new Map<string,HumanReply[]>();
  const replyFilter=completeReplies?`AND (json_extract(payload_json,'$.review.questions') IS NOT NULL
        OR json_extract(payload_json,'$.replyToMessage.messageId') IS NOT NULL)`:'';
  const limit=completeReplies?'':'LIMIT 2000';
  for(const row of db.query(`SELECT id,session_id,created_at,json_extract(payload_json,'$.review.questions') AS review,
      json_extract(payload_json,'$.replyToMessage.messageId') AS reply_to
      FROM session_inputs WHERE session_id IN (${inboxLineageSql}) AND origin='human' AND kind IN ('input','create','inbox-capture')
        AND id NOT IN (SELECT input_id FROM session_input_author_corrections) ${replyFilter} ORDER BY rowid DESC ${limit}`).all(sessionId) as any[]) {
    // Only message kinds: his reading marks and topic actions are human inputs too, two thirds
    // of the newest 2,000 rows in the normal list view, and none of them is in any thread.
    const root=rootOf(row.session_id,row.id);
    if(!root)continue;
    let reviews:string[]=[];
    try{const parsed=row.review?JSON.parse(row.review):[];reviews=Array.isArray(parsed)?parsed.map((item:any)=>String(item?.id??'')).filter(Boolean):[];}catch{reviews=[];}
    humanReplies.set(root,[...(humanReplies.get(root)??[]),{inputId:row.id,at:iso(row.created_at)!,reviews,replyTo:typeof row.reply_to==='string'?row.reply_to:null}]);
  }
  return {humanReplies};
}
/** His messages in this topic, newest first, so a question can find the reply that names it. */
function latestHumanReply(index:ReadIndex,roots:string[]):HumanReply[] {
  return roots.flatMap(root=>index.humanReplies.get(root)??[]).sort((first,second)=>second.at.localeCompare(first.at));
}
function questionView(question:StoredQuestion,replies:HumanReply[]) {
  const reading=db.query('SELECT kind,revision,at,by_json FROM inbox_topic_reading WHERE topic_id=? AND item_id=? ORDER BY at').all(question.topicId,question.questionId) as any[];
  return questionDisplay(question,replies,reading,readsFor(question));
}
/**
 * A dispatch as it stands now, not as it stood when the router linked it: the linked record is a
 * snapshot ("admitted", no outcome), so three finished requests to one session all read "Working
 * on it now" from the session's live state (Tejas, 2026-10-07: "Why did I just see three different
 * sends to the same session here?"). The request row carries the current outcome and status, the
 * Inbox message the router was answering when it sent it (where the card belongs), the moment, and
 * the words it was sent with. A row the owner no longer has leaves the snapshot as it was.
 */
function liveDispatch(dispatch:any) {
  const local=db.query('SELECT source_input_id,outcome,status,created_at_ms,payload_json FROM session_communication_requests WHERE request_id=?').get(String(dispatch.requestId)) as any;
  const peer=local?null:db.query('SELECT source_input_id,outcome,status,created_at_ms,payload_json,peer,remote_session_id FROM session_peer_requests WHERE request_id=?').get(String(dispatch.requestId)) as any;
  const row=local??peer;
  if(!row)return dispatch;
  let text:string|null=null;
  try{const words=String(JSON.parse(row.payload_json)?.text??'').replace(/\s+/g,' ').trim();text=words?words.slice(0,240):null;}catch{text=null;}
  // A peer session is named as the catalogue and the reply chooser name it (`mac:84`); records linked
  // before 2026-10-07 spelt it `mac:concierge:84`, which opened nothing.
  return {...dispatch,...(peer?{targetSessionId:receiveSessionFromPeer(peer.remote_session_id,peer.peer)}:{}),outcome:row.outcome??null,state:row.status??dispatch.state,
    ...(row.source_input_id?{sourceInputId:row.source_input_id}:{}),
    ...(typeof row.created_at_ms==='number'?{at:new Date(row.created_at_ms).toISOString()}:{}),
    ...(text?{text}:{})};
}
const requestView=(request:StoredRequest)=>({id:request.requestId,topicId:request.topicId,title:request.title,brief:request.brief,
  state:request.state,disposition:request.disposition,revision:request.revision,sources:request.sources,dispatches:request.dispatches.map(liveDispatch),
  closure:request.closure,createdAt:request.createdAt,updatedAt:request.updatedAt});

function topicQuestions(topicId:string):StoredQuestion[] {
  return (db.query('SELECT * FROM inbox_questions WHERE topic_id=? ORDER BY created_at,question_id').all(topicId) as any[]).map(toStoredQuestion);
}
function topicRequests(topicId:string):StoredRequest[] {
  return (db.query('SELECT * FROM inbox_requests WHERE topic_id=? ORDER BY created_at,request_id').all(topicId) as any[]).map(toStoredRequest);
}

function topicSummary(topic:StoredTopic,session:SessionRow,index:EntryIndex,work:WorkIndex,read:ReadIndex) {
  const roots=topicRoots(topic.topicId);
  const questions=topicQuestions(topic.topicId);
  const requests=topicRequests(topic.topicId);
  const reply=latestHumanReply(read,roots);
  const views=questions.map(question=>questionView(question,reply));
  // One predicate decides what waits on him (`awaitingHim`) and one what he has to read
  // (`toReadByHim`); every count and list below is taken from these two, and a client displays
  // them without recomputing. Attention outside question records never appears in a thread:
  // it sits unfiled in the sorting pile until the router or he files it.
  const needing=views.filter(awaitingHim).sort((first,second)=>String(first.createdAt).localeCompare(String(second.createdAt)));
  const reading=views.filter(toReadByHim).sort((first,second)=>String(first.createdAt).localeCompare(String(second.createdAt)));
  const item=(question:ReturnType<typeof questionView>)=>({questionId:question.id,text:question.brief?.decision??'',at:question.createdAt,revision:question.revision,
    kind:question.kind,owner:question.owner?.sessionId??null,outcome:question.kind==='reading'?'response' as const:'needs_you' as const});
  const items=needing.map(item),toRead=reading.map(item);
  // What happened in the conversation (his messages, the router's posts, agents' returns) is the
  // thread's time, its unread mark and its place in the list. Housekeeping on the thread (placing,
  // settling or withdrawing questions, summaries, closing, request bookkeeping) is recorded in the
  // Timeline and moves none of them: withdrawing 39 stale questions at 20:17 UTC on 2026-10-07 put
  // "Action Button recording", last spoken in on Sept 22, at the top of Open as 4:17 PM (Tejas:
  // "we need to separate what is happening within the thread and what actions you take on the
  // thread"). A thread with no conversation yet is dated by its creation.
  const last=roots.map(root=>index.byRoot.get(root)).filter(Boolean) as {sequence:number;at:string}[];
  const lastSequence=Math.max(0,...last.map(entry=>entry.sequence));
  const lastAt=last.map(entry=>entry.at).sort().at(-1)??topic.createdAt;
  return {id:topic.topicId,title:topic.title,aliases:topic.aliases,summary:topic.summary,state:topic.state,setAside:topic.setAside,
    revision:topic.revision,recovered:topic.recovered,createdAt:topic.createdAt,updatedAt:topic.updatedAt,lastEntryAt:lastAt,
    lastEntrySequence:lastSequence,unread:lastSequence>topic.readSequence,roots,pinnedAt:topic.pinnedAt??null,
    // When it was closed, for the Closed list's order and its rows; a merged-away topic has no moment of its own here.
    closedAt:topic.state==='closed'&&topic.closure?.kind!=='merged'?topic.closure?.at??topic.updatedAt:null,
    needsYou:{count:items.length,oldestAt:items[0]?.at??null,items},
    toRead:{count:toRead.length,oldestAt:toRead[0]?.at??null,items:toRead},
    questions:{open:items.length,
      checking:views.filter(preparingForHim).length,
      deferred:views.filter(question=>question.state==='deferred').length},
    requests:{open:requests.filter(request=>request.state==='open').length,closed:requests.filter(request=>request.state==='closed').length},
    work:topicWork(topic,roots,work,index)};
}

/**
 * The words of one Inbox message, by the exact id a topic, thread or request shows for it: a
 * capture, his reply, an agent's post or result, a routed request, or the request input a topic
 * request names as its source or dispatch. Topic reads carry ids, titles and short dispatch
 * excerpts; before 2026-11-06 the only way to read the message itself was to be the router the
 * input had been delivered to, so a stand-in router could not judge the requests it inherited.
 */
export function inboxMessageWords(session:SessionRow,messageId:string) {
  const entry=inboxMessageById(session.id,messageId) as any;
  const root=inboxThreadRoot(session.id,messageId);
  const topicId=root?topicOfRoot(root):null;
  // A request shows in its thread as "Sent to <agent>"; its words are the input it delivered.
  const sent=entry&&messageId.startsWith('request:')?getAcceptedSessionInput(messageId):null;
  const sentText=sent?(JSON.parse(sent.payload_json).firstInput??JSON.parse(sent.payload_json)).text:null;
  if(entry){
    const source=getAcceptedSessionInput(messageId);
    const author=source?acceptedInputAuthor(source).author:entry.author??{kind:entry.role==='user'?'unknown':'agent'};
    return {messageId,from:author.kind,author,
    session:typeof entry.sourceSessionId==='number'?`concierge:${entry.sourceSessionId}`:null,
    at:entry.createdAt??null,words:typeof sentText==='string'?sentText:typeof entry.content==='string'?entry.content:'',
    ...(sent?{sentTo:`concierge:${sent.session_id}`}:{}),
    attachments:(entry.attachments??[]).map((file:any)=>({id:file.id,name:file.name,contentType:file.contentType})),
    threadRoot:root,topicId};
  }
  // A request input sits in its target session; it is Inbox material only when a topic request names it.
  const named=db.query(`SELECT topic_id FROM inbox_requests WHERE EXISTS (SELECT 1 FROM json_each(sources_json) WHERE json_extract(value,'$.inputId')=?1)
      OR EXISTS (SELECT 1 FROM json_each(dispatches_json) WHERE 'request:' || json_extract(value,'$.requestId')=?1 OR json_extract(value,'$.sourceInputId')=?1)
    UNION ALL SELECT topic_id FROM inbox_topic_roots WHERE root_input_id=?1 LIMIT 1`).get(messageId) as {topic_id:string}|null;
  const input=named?getAcceptedSessionInput(messageId):null;
  if(!input)throw new TopicError('No Inbox message or topic-named request has that exact id.',404,'MESSAGE_NOT_FOUND');
  const payload=JSON.parse(input.payload_json),first=payload.firstInput??payload;
  const author=acceptedInputAuthor(input).author;
  return {messageId,from:author.kind,author,session:`concierge:${input.session_id}`,at:input.created_at,
    words:typeof first.text==='string'?first.text:'',
    attachments:((first.attachments??[]) as string[]).map(id=>db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id)).filter(Boolean),
    threadRoot:root,topicId:topicId??named!.topic_id};
}

function inboxOrThrow():SessionRow {
  const session=inboxSession();
  if(!session)throw new TopicError('No Inbox session exists yet.',503,'INBOX_UNAVAILABLE');
  return session;
}
function readableText(input:AcceptedSessionInput):string {
  const payload=JSON.parse(input.payload_json),body=payload.firstInput??payload;
  if(body.capture&&typeof body.text==='string')
    return capturePresentation({source:body.capture.source,text:body.text}).text;
  return typeof body.text==='string'?body.text:'';
}
/** Something he sent himself: agents' requests to the router and agent-authored captures are never his to sort. */
function isHisOwnRoot(root:string){
  const input=getAcceptedSessionInput(root);
  return input?.origin==='human'&&!db.query('SELECT 1 FROM session_input_author_corrections WHERE input_id=?').get(root);
}
/** Stop checks delivery custody, not the sorting page (which also includes still-queued inputs). */
export function unfiledReceivedInputs(sessionId:number,turnId:number) {
  const session=getSessionById(sessionId);
  if(!session||!sessionMetadata(session).inbox)return [];
  refreshRootMemo();
  // Outside-agent captures exercise the same filing path without impersonating Tejas. Imported
  // test captures, worker requests and service returns have no filing obligation here.
  const inputs=db.query(`SELECT input.id,input.created_at,substr(json_extract(input.payload_json,'$.text'),1,160) AS text
    FROM session_inputs input JOIN turns turn ON turn.id=input.turn_id
    LEFT JOIN turn_steering_messages steering ON steering.id=input.steering_id
    WHERE input.session_id=? AND input.kind IN ('input','create','inbox-capture')
      AND (input.origin='human' OR (input.origin='agent' AND input.scope IN ('capture:outside-agent','capture:agent-report')))
      AND NOT EXISTS (SELECT 1 FROM session_input_author_corrections correction WHERE correction.input_id=input.id)
      AND ((input.steering_id IS NULL AND (turn.provider_input_acknowledged_at IS NOT NULL OR turn.id=?))
        OR (input.steering_id IS NOT NULL AND steering.provider_sent_at IS NOT NULL))
    ORDER BY input.rowid`).all(sessionId,turnId) as {id:string;created_at:string;text:string|null}[];
  return inputs.flatMap(input=>{
    const root=rootOf(sessionId,input.id)??input.id;
    const topicId=topicOfRoot(root);
    if(topicId&&input.id.startsWith('capture:')){
      const report=db.query(`SELECT request_id FROM inbox_requests WHERE request_id=? AND state='open'
        AND json_array_length(dispatches_json)=0`).get(`req:agent-report:${input.id}`) as {request_id:string}|null;
      if(report)return [{input_id:input.id,root_id:root,at:input.created_at,text:input.text??'',
        topic_id:topicId,request_id:report.request_id}];
    }
    return topicId?[]:[{input_id:input.id,root_id:root,at:input.created_at,text:input.text??'',...(isBugReportInput(root)?{bug_report:true}:{})}];
  });
}
/** Thread roots nobody has filed yet: the sorting pile above the topic list. */
function sortingCaptures(session:SessionRow,index:EntryIndex) {
  const unplaced=[...index.byRoot.entries()].filter(([root])=>!topicOfRoot(root)&&isHisOwnRoot(root));
  unplaced.sort((first,second)=>second[1].sequence-first[1].sequence);
  const captures=unplaced.slice(0,5).map(([root,entry])=>{
    const input=getAcceptedSessionInput(root);
    return {inputId:root,text:(input?readableText(input):'').trim().slice(0,120),at:entry.at};
  });
  return {count:unplaced.length,captures,attention:unfiledAttention(session)};
}
/** Attention waiting to be filed, each with the thread its turn started from as a suggestion, never a decision. */
function unfiledAttention(session:SessionRow) {
  refreshRootMemo();
  return unfiledNeeds(session).map(need=>{
    const root=rootOf(session.id,need.inputId)??need.inputId;
    const topicId=topicOfRoot(root);
    const title=topicId?(db.query('SELECT title FROM inbox_topics WHERE topic_id=?').get(topicId) as {title:string}|null)?.title??null:null;
    return {eventId:need.eventId,inputId:need.inputId,kind:(need.outcome==='response'?'reading':'decision') as QuestionKind,outcome:need.outcome??'needs_you',
      text:need.question,at:need.at,generation:need.generation,startedFrom:topicId?{id:topicId,title}:null};
  });
}

/**
 * Files one unfiled attention entry as a question in a topic: the explicit act that replaces
 * guessing the topic from the thread that started the turn. The need is then covered by the
 * question's `legacyNeedEventId` and leaves the sorting pile; the question keeps the entry's
 * words, time and generation, and `origin:'marker'` says where it came from.
 */
function fileNeed(session:SessionRow,topic:StoredTopic,eventId:string,by:TopicBy,brief?:any):StoredQuestion {
  const need=unfiledNeeds(session).find(item=>item.eventId===eventId);
  if(!need)throw new TopicError('No unfiled attention entry has that id.',404,'NEED_UNKNOWN');
  const at=nowIso();
  const kind:QuestionKind=need.outcome==='response'?'reading':'decision';
  const filed=brief??{decision:need.question,why:{text:'',sources:[need.inputId]},known:'',choices:[],uncertain:[],answerable:'',recoveredFrom:'Filed from the turn that asked'};
  const question:StoredQuestion={questionId:`q:${randomUUID()}`,topicId:topic.topicId,revision:1,state:'open',blocking:kind==='decision',optional:false,
    context:kind==='reading'||!briefMissing(filed).length?'ready':'agent_checking',brief:filed,
    owner:by.sessionId?{sessionId:by.sessionId}:null,sources:[need.inputId],replaces:null,replacedBy:null,answer:null,recovered:false,
    legacyNeedEventId:need.eventId,kind,origin:'marker',generation:need.generation,createdAt:need.at??at,updatedAt:at};
  // A reading item is filed only when its turn left him something to read in this thread.
  if(kind==='reading'&&!readsFor(question).length)throw new TopicError(NOTHING_TO_READ,409,'NOTHING_TO_READ');
  return question;
}

/** The next attention generation on the Inbox, so a new question counts as new the way a marker did. */
function raiseGeneration(session:SessionRow):number {
  const generation=(sessionMetadata(session).generation??0)+1;
  updateSessionMetadata(session.id,{generation});
  return generation;
}

/** Every open question in a topic ended for one reason, each as its own recorded end. */
function expireOpen(questions:StoredQuestion[],reason:string,at:string):StoredQuestion[] {
  return questions.filter(question=>OPEN_QUESTION_STATES.includes(question.state))
    .map(question=>({...question,state:'expired' as QuestionState,updatedAt:at,brief:{...question.brief,endedBecause:reason}}));
}
/**
 * The questions a thread's closure ended come back open when the thread reopens, so an Undo on a
 * one-tap close from the list loses nothing. Only questions this exact closure expired qualify
 * (they carry its moment), never ones that ended earlier for their own reasons.
 */
function restoreExpiredByClosure(topic:StoredTopic,at:string):StoredQuestion[] {
  const closedAt=topic.closure?.at;
  if(!closedAt||topic.closure?.kind==='merged')return [];
  return topicQuestions(topic.topicId).filter(question=>question.state==='expired'&&question.updatedAt===closedAt)
    .map(question=>{const {endedBecause:_ended,...brief}=question.brief??{};return {...question,state:'open' as QuestionState,updatedAt:at,brief};});
}
/** The open questions a topic request's closure ends: only those linked to that exact request. */
function questionsOfRequest(topicId:string,request:StoredRequest):StoredQuestion[] {
  const dispatches=new Set(request.dispatches.map((dispatch:any)=>String(dispatch.requestId??'')));
  return topicQuestions(topicId).filter(question=>OPEN_QUESTION_STATES.includes(question.state)
    &&(question.owner?.requestId===request.requestId||(question.owner?.dispatchRequestId&&dispatches.has(String(question.owner.dispatchRequestId)))));
}

/**
 * A worker's final reply (`completed` or `failed`) ends the questions it declared for that exact
 * request: it no longer needs the answer. `needs_decision` keeps them, because that reply is the
 * question. Called from the reply path; the request reply protocol owns when a request closes.
 */
export function expireQuestionsForFinalReply(input:{workerSessionId:number|string;requestId:string;disposition:string;reason:string}) {
  if(!['completed','failed'].includes(input.disposition))return 0;
  const session=inboxSession();
  if(!session)return 0;
  // A peer agent is named as the catalogue names it (`mac:84`); a local one by its number.
  const address=typeof input.workerSessionId==='string'?input.workerSessionId:`concierge:${input.workerSessionId}`;
  const at=nowIso();
  let ended=0;
  for(const row of db.query('SELECT * FROM inbox_requests WHERE dispatches_json LIKE ?').all(`%${input.requestId}%`) as any[]) {
    const request=toStoredRequest(row);
    if(!request.dispatches.some((dispatch:any)=>dispatch.requestId===input.requestId))continue;
    const topic=topicRow(request.topicId);
    const open=topicQuestions(topic.topicId).filter(question=>OPEN_QUESTION_STATES.includes(question.state)
      &&(question.owner?.dispatchRequestId===input.requestId||question.owner?.sessionId===address));
    if(!open.length)continue;
    const reason=`The agent finished the work it was for (${input.disposition}): ${input.reason}`;
    const questions=expireOpen(open,reason,at);
    const next=bumped(topic);
    const payload={change:'settled',topicId:topic.topicId,topic:next,questions,by:{kind:'owner' as const,sessionId:address},reason,revision:next.revision};
    recordSessionEvent({eventId:`topic-expire:reply:${input.requestId}:${topic.topicId}`,sessionId:session.id,kind:'topic_question',payload});
    applyTopicChange('topic_question',payload);
    ended+=questions.length;
  }
  return ended;
}

/** Whether this run declared or revised a question, so its end-of-turn marker adds no second copy. */
export function questionsDeclaredByRun(sessionId:number,runId:string):boolean {
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='topic_question'
    AND json_extract(payload_json,'$.by.runId')=? LIMIT 1`).get(sessionId,runId);
}

/**
 * What the Inbox session is waiting on him for, as one list: unfiled attention entries and the
 * questions that wait on him or want reading, in the shape the session view already carries.
 * The session's own `needs` are only the unfiled ones now; every filed one is a question.
 */
export function inboxAttention(session:SessionRow):OpenNeed[] {
  const needs=unfiledNeeds(session);
  const questions=(db.query(`SELECT * FROM inbox_questions WHERE state IN ('open','partial') ORDER BY created_at`).all() as any[]).map(toStoredQuestion);
  const read=readIndex(session.id);
  const items:OpenNeed[]=[];
  for(const question of questions) {
    const view=questionView(question,latestHumanReply(read,topicRoots(question.topicId)));
    if(!view.waiting)continue;
    items.push({inputId:question.sources[0]??question.topicId,outcome:question.kind==='reading'?'response':'needs_you',question:question.brief?.decision??'',
      generation:question.generation??0,at:question.createdAt,runId:question.owner?.runId??'',eventId:question.questionId,
      ...(view.reads.length?{reads:view.reads}:{})});
  }
  return [...needs,...items].sort((first,second)=>first.generation-second.generation);
}

/**
 * His "mark seen" on the Inbox up to a generation: it ends reading items raised at or before it
 * (his own explicit signal that he read them) and retires unfiled reading entries the same way.
 * A decision is never ended by being seen; it stays until answered or settled.
 */
export function inboxDismiss(session:SessionRow,generation:number) {
  const at=nowIso();
  const reading=(db.query(`SELECT * FROM inbox_questions WHERE kind='reading' AND state IN ('open','partial') AND generation IS NOT NULL AND generation<=?`).all(generation) as any[]).map(toStoredQuestion);
  const byTopic=new Map<string,StoredQuestion[]>();
  for(const question of reading)byTopic.set(question.topicId,[...(byTopic.get(question.topicId)??[]),question]);
  for(const [topicId,questions] of byTopic) {
    const topic=topicRow(topicId);
    const next=bumped(topic);
    const payload={change:'settled',topicId,topic:next,questions:questions.map(question=>({...question,state:'read' as QuestionState,updatedAt:at})),
      by:{kind:'human' as const},reason:'Marked seen',revision:next.revision};
    recordSessionEvent({eventId:`topic-read:dismiss:${generation}:${topicId}`,sessionId:session.id,kind:'topic_question',payload});
    applyTopicChange('topic_question',payload);
  }
  const needs=(sessionMetadata(session).needs??[]).filter(need=>!(need.outcome==='response'&&need.generation<=generation));
  if(needs.length!==(sessionMetadata(session).needs??[]).length)updateSessionMetadata(session.id,{needs});
}

/** Both list entrances use this source-readiness decision; each chooses how it reads the prepared
 * list (the device's HTTP read waits for the worker to catch up, the agent command reads directly). */
export function inboxTopicList<Prepared>(options:Parameters<typeof preparedTopics>[0],
  readPrepared:(options:Parameters<typeof preparedTopics>[0])=>Prepared){
  if(preparedTopicsReady())return readPrepared(options);
  // The ledger list needs the Inbox; before it exists the list is still indexing, not an error.
  return inboxSession()?directTopicList(options):unpreparedTopics();
}

/** The thread list computed from the ledger while the prepared list is being rebuilt. */
function directTopicList(options:{state?:string|null;order?:string|null;query?:string|null;cursor?:string|null;limit?:number|null}){
  const offset=/^\d+$/.test(options.cursor??'')?options.cursor:null;
  return {...listTopics({...options,cursor:offset,limit:Math.min(20,Number(options.limit)||20)}),coverage:{complete:true,code:null,source:'ledger'}};
}
export function listTopics(options:{state?:string|null;order?:string|null;query?:string|null;cursor?:string|null;limit?:number|null}={}) {
  const session=inboxOrThrow();
  const index=entryIndex(),work=workIndex(session.id),read=readIndex(session.id);
  const state=options.state??'open';
  if(!['open','background','closed','all'].includes(state))throw new TopicError('Unknown topic state filter.');
  const query=(options.query??'').trim().toLowerCase();
  const rows=(db.query(`SELECT * FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) ORDER BY updated_at DESC,topic_id`).all(session.id) as any[]).map(toStoredTopic);
  let summaries=rows.map(topic=>topicSummary(topic,session,index,work,read));
  if(query)summaries=summaries.filter(topic=>[topic.title,topic.summary,...topic.aliases].join(' ').toLowerCase().includes(query));
  if(state==='open')summaries=summaries.filter(topic=>topic.state==='open');
  else if(state==='closed')summaries=summaries.filter(topic=>topic.state==='closed');
  else if(state==='background')summaries=summaries.filter(topic=>topic.state==='open'&&!topic.needsYou.count&&topic.work.kind!=='idle');
  // Open threads: newest first by the conversation's own time, one list (see the prepared order in
  // prepared-topic-values.ts for why there are no bands). Closed threads
  // are ordered by when they were closed (Tejas, 2026-10-07: "everything is kind of cluttered and
  // dumped on the main page here. Clean it up.").
  // Pinned threads lead the Open list, most recently pinned first; closing keeps the pin for a reopen.
  const band=(topic:ReturnType<typeof topicSummary>)=>topic.pinnedAt?-1:0;
  const pinned=(first:ReturnType<typeof topicSummary>,second:ReturnType<typeof topicSummary>)=>state==='closed'?0:band(first)-band(second)||String(second.pinnedAt??'').localeCompare(String(first.pinnedAt??''));
  const recency=(topic:ReturnType<typeof topicSummary>)=>state==='closed'?String(topic.closedAt??topic.lastEntryAt):String(topic.lastEntryAt);
  // Started order from the ledger is by the thread record's creation; the prepared list, which
  // serves every read once built, uses the first message's arrival instead.
  if(options.order==='started')summaries.sort((first,second)=>pinned(first,second)||String(second.createdAt).localeCompare(String(first.createdAt)));
  else summaries.sort((first,second)=>pinned(first,second)||recency(second).localeCompare(recency(first)));
  const limit=Math.min(200,Math.max(1,Number(options.limit)||50));
  const offset=Math.max(0,Number(options.cursor)||0);
  const page=summaries.slice(offset,offset+limit);
  return {topics:page,nextCursor:offset+limit<summaries.length?String(offset+limit):null,
    sorting:sortingCaptures(session,index),asOf:nowIso()};
}

/** How many human obligations are open, for the Open requests chip. One indexed count, so a list
 * that changes while he watches can ask again cheaply; the full view below rebuilds each request's
 * owner and waiting reason (about 15,800 statements and 5 s for 405 requests on 2026-11-05) and is
 * read only when he opens the list itself. Both count the same rows: every open request. */
export function openInboxObligationCount() {
  inboxOrThrow();
  const {count}=db.query(`SELECT COUNT(*) AS count FROM inbox_requests WHERE state='open'`).get() as {count:number};
  return {count,asOf:nowIso(),items:[] as never[],view:'count' as const};
}

/** One bounded view of every open human obligation, independent of thread-list paging. */
export function openInboxObligations() {
  const inbox=inboxOrThrow();
  const requests=(db.query(`SELECT * FROM inbox_requests WHERE state='open' ORDER BY created_at,request_id`).all() as any[]).map(toStoredRequest);
  const now=Date.now();
  const topics=new Map<string,StoredTopic>(),questions=new Map<string,StoredQuestion[]>(),openByTopic=new Map<string,StoredRequest[]>();
  const hasDecision=!!db.query(`SELECT 1 FROM inbox_questions WHERE kind='decision' AND state IN ('open','partial','deferred') LIMIT 1`).get();
  const read=hasDecision?readIndex(inbox.id,true):{humanReplies:new Map<string,HumanReply[]>()};
  const items=requests.map(request=>{
    let topic=topics.get(request.topicId);
    if(!topic){topic=topicRow(request.topicId);topics.set(request.topicId,topic);}
    let inTopic=questions.get(request.topicId);
    if(!inTopic){inTopic=topicQuestions(request.topicId);questions.set(request.topicId,inTopic);}
    const dispatches=new Set(request.dispatches.map((dispatch:any)=>String(dispatch.requestId??'')));
    const works=request.dispatches.map((dispatch:any)=>workRow(String(dispatch?.requestId??''))).filter((work):work is Work=>!!work)
      .sort((left,right)=>left.createdAtMs-right.createdAtMs||left.id.localeCompare(right.id));
    const live=works.filter(work=>work.outcome===null&&!work.stalled).at(-1);
    const latest=works.at(-1);
    let openRequests=openByTopic.get(request.topicId);
    if(!openRequests){openRequests=requests.filter(item=>item.topicId===request.topicId);openByTopic.set(request.topicId,openRequests);}
    const replies=latestHumanReply(read,topicRoots(request.topicId));
    const direct=inTopic.filter(item=>item.kind==='decision'&&OPEN_QUESTION_STATES.includes(item.state)
      &&(item.owner?.requestId===request.requestId||dispatches.has(String(item.owner?.dispatchRequestId??''))));
    const legacy=inTopic.filter(item=>item.kind==='decision'&&OPEN_QUESTION_STATES.includes(item.state)
      &&unlinkedQuestionImplies(item,request,openRequests));
    const deferred=inTopic.some(item=>item.kind==='decision'&&item.state==='deferred'
      &&(item.owner?.requestId===request.requestId||dispatches.has(String(item.owner?.dispatchRequestId??''))
        ||unlinkedQuestionImplies(item,request,openRequests)));
    const shared=latest?.disposition==='needs_decision'&&request.dispatches.some((dispatch:any)=>dispatch.sharedAcrossTopic&&dispatch.requestId===latest.id)
      &&!!db.query(`SELECT 1 FROM inbox_questions WHERE kind='decision' AND state IN ('open','partial','deferred')
        AND context='ready' AND blocking=1 AND optional=0 AND json_extract(owner_json,'$.dispatchRequestId')=? LIMIT 1`).get(latest.id);
    const waitingAgent=live??(latest?.outcome===null?latest:null);
    const waitingForHim=shared||deferred||[...direct,...legacy].some(item=>awaitingHim(questionView(item,replies)))
      ||!!(waitingAgent&&agentWaitingOnHim(waitingAgent,read,`concierge:${topic.sessionId}`));
    const waitingOn=waitingForHim?'his decision':live?'agent answer':!latest?'Inbox routing':latest.notCheckedReason?'verification':'recovery';
    const owner=waitingForHim?'Tejas':live?.target??`concierge:${inbox.id}`;
    return {requestId:request.requestId,topicId:request.topicId,topicTitle:topic.title,title:request.title,
      owner,createdAt:request.createdAt,ageMs:Math.max(0,now-new Date(request.createdAt).getTime()),
      waitingOn};
  });
  return {count:items.length,asOf:new Date(now).toISOString(),items};
}

/** A future-answer post may name only work already recorded for its exact source. */
export function hasOpenInboxWorkForSource(topicId:string,sourceInputId:string,promiseRequestId?:string):boolean {
  const dispatchId=sourceInputId.startsWith('request:')?sourceInputId.slice('request:'.length):null;
  return topicRequests(topicId).some(request=>request.state==='open'&&(
    promiseRequestId?request.requestId===promiseRequestId:
    request.sources.some(source=>source.inputId===sourceInputId)
    ||request.dispatches.some((dispatch:any)=>{
      const id=String(dispatch.requestId??'');
      if(id===dispatchId)return true;
      const local=db.query('SELECT source_input_id FROM session_communication_requests WHERE request_id=?').get(id) as {source_input_id:string|null}|null;
      const peer=local?null:db.query('SELECT source_input_id FROM session_peer_requests WHERE request_id=?').get(id) as {source_input_id:string|null}|null;
      return (local?.source_input_id??peer?.source_input_id)===sourceInputId;
    })));
}

function topicHistory(sessionId:number,topicId:string) {
  return (db.query(`SELECT payload_json,created_at FROM session_owner_events
    WHERE session_id IN (${inboxLineageSql}) AND kind IN (${MANAGEMENT_KINDS.map(()=>'?').join(',')}) AND json_extract(payload_json,'$.topicId')=?
    ORDER BY sequence DESC LIMIT 20`).all(sessionId,...MANAGEMENT_KINDS,topicId) as any[]).map(row=>{
      const payload=JSON.parse(row.payload_json);
      return {change:payload.change,at:iso(row.created_at),by:payload.by??null,reason:payload.reason??null};
    });
}
/** One agent a reply inside a thread can go to, and why; `owns` names the items (questions, their sources, returned answers) a reply to which goes to it by default. */
export type {ReplyTarget,ReplyTargets} from './reply-target-rules';
/** The session whose returned answer, or mirrored post, a thread message is. */
function spokenBySession(sessionId:number,messageId:string):string|null {
  if(messageId.startsWith('return:')) {
    const row=db.query(`SELECT r.target_session_id FROM session_communication_events e JOIN session_communication_requests r ON r.request_id=e.request_id WHERE e.event_id=?`)
      .get(messageId.slice('return:'.length)) as {target_session_id:number}|null;
    return row?`concierge:${row.target_session_id}`:null;
  }
  if(messageId.startsWith('post:')) {
    const row=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=? AND session_id=?').get(messageId,sessionId) as {payload_json:string}|null;
    const from=row?JSON.parse(row.payload_json)?.postedBySession:null;
    return typeof from==='string'?from:null;
  }
  return null;
}
/**
 * Who a reply inside this thread goes to: every agent that has worked in it (an open request's
 * dispatch, a dispatch in flight, an open question they asked, and any request from this thread
 * they were sent, finished or not, with the answers they returned or had posted here), the router,
 * and the default. The default is the agent whose item he is replying to, so replying under an
 * agent's answer goes to that agent even after its request closed; else the one agent still
 * working here; else the router, which also covers "several are working", so he picks.
 * Until 2026-10-08 only open work counted, so once an agent answered and its request closed it
 * vanished from the choices and the router was the only one left (Tejas: "It's the only option.
 * I can't even change to the token allowance session here"). A session on his
 * Mac is a choice exactly as one on this server [decision: mac-sessions-have-parity]; only a
 * session archived or suspended is left out. The app shows these and sends his pick; nothing in the app
 * re-derives them (design: thinkering docs/plans/2026-10-07-reply-to-who-asked.md; Tejas,
 * 2026-10-07: "I should just be talking with the agents who are working on this thread … my
 * responses go back to the same session").
 */
export function replyTargets(topicId:string,about:string|null=null,canSend:(session:SessionRow)=>boolean=session=>session.status!=='archived'&&!sessionMetadata(session).suspended):ReplyTargets {
  const session=inboxOrThrow();
  return topicReplyTargets(db,{
    router:`concierge:${session.id}`,inboxSessionId:session.id,roots:topicRoots(topicId),
    requests:topicRequests(topicId) as any,
    questions:topicQuestions(topicId).map(question=>({id:question.questionId,state:question.state,ownerSessionId:question.owner?.sessionId??null,decision:question.brief?.decision??null,sources:question.sources})),
    workDispatches:workIndex(session.id).dispatches,
    about,spokenBy:about?spokenBySession(session.id,about):null,
    resolve:sessionId=>{
      const local=localSessionNumber(sessionId);
      if(local!==null){const row=getSessionById(local);return row&&canSend(row)?{title:sessionMetadata(row).title??null}:null;}
      // A session on his Mac is a choice exactly as a server session is [decision: mac-sessions-have-parity]:
      // its name comes from the peer catalogue this owner keeps. Only one that machine archived is left out.
      const view=peerSessionView(sessionId);
      return view&&!view.archived&&!view.archivedAt&&view.status!=='archived'?{title:view.title??null}:null;
    },
  });
}
/** A session on another machine as the peer catalogue this owner keeps presents it (`mac:86` → its view), or null. */
export function peerSessionView(sessionId:string):{id:string;title?:string|null;address?:string;status?:string;archived?:boolean;archivedAt?:string|null}|null {
  if(localSessionNumber(sessionId)!==null)return null;
  const row=db.query("SELECT view_json FROM session_peer_catalogue WHERE json_extract(view_json,'$.id')=?").get(sessionId) as {view_json:string}|null;
  return row?JSON.parse(row.view_json):null;
}
export function readTopic(topicId:string,limit:number|null=null) {
  const session=inboxOrThrow();
  const topic=topicRow(topicId);
  const index=entryIndex(),work=workIndex(session.id),read=readIndex(session.id);
  const summary=topicSummary(topic,session,index,work,read);
  const roots=summary.roots;
  const reply=latestHumanReply(read,roots);
  const focus=work.focus?.topicId===topicId?work.focus:null;
  return {topic:{...summary,closure:topic.closure,history:topicHistory(session.id,topicId)},
    requests:topicRequests(topicId).map(requestView),
    questions:topicQuestions(topicId).map(question=>questionView(question,reply)),
    focus:focus?{topicId:focus.topicId,inputIds:focus.inputIds,runId:focus.runId,summary:focus.summary,since:focus.since}:null,
    work:summary.work,
    replyTargets:replyTargets(topicId),
    entries:topicEntries(topicId,null,limit)};
}

/** Entries: this topic's Inbox messages plus its management events, in owner sequence order. */
export function topicEntries(topicId:string,cursor:string|null=null,limit:number|null=null) {
  const size=Math.min(20,Math.max(1,Number(limit)||20));
  const head=(db.query('SELECT COALESCE(MAX(sequence),0) AS n FROM session_owner_events').get() as {n:number}).n;
  const page=preparedTopicEntries(topicId,size,cursor,head);
  const displayKeys=page.keys.filter((key):key is typeof key&{messageId:string}=>!!key.messageId);
  const preparedDisplays=preparedInboxDisplays(displayKeys);
  const displayBySequence=new Map(displayKeys.map((key,index)=>[key.sequence,preparedDisplays[index]]));
  const managementKeys=page.keys.filter(key=>!key.messageId);
  const managementDisplays=preparedTopicEventDisplays(managementKeys.map(key=>key.sequence));
  managementKeys.forEach((key,index)=>displayBySequence.set(key.sequence,managementDisplays[index]));
  if([...displayBySequence.values()].some(value=>value===null))
    return {messages:[],nextCursor:null,coverage:{complete:false as const,code:'presentation_indexing' as const,
      retryAfterMs:1000,appliedSequence:page.coverage.appliedSequence}};
  const messages=withCurrentAuthors(page.keys.map(key=>displayBySequence.get(key.sequence)).filter(Boolean));
  return {messages,nextCursor:page.nextCursor,coverage:page.coverage};
}

export function resolveTopicMessage(messageId:string) {
  const session=inboxOrThrow();
  if(typeof messageId!=='string'||!messageId)throw new TopicError('Name one exact Inbox message.');
  refreshRootMemo();
  const root=rootOf(session.id,messageId);
  let topicId=root?topicOfRoot(root):null;
  // A service notice published by another process has its thread made here, at the latest, so
  // the tap that opens it never lands before the thread exists.
  if(!topicId&&root&&isServiceNotice(root)) {fileServiceNotices();topicId=topicOfRoot(root);}
  if(!topicId)return {topic:null,root};
  const index=entryIndex(),work=workIndex(session.id),read=readIndex(session.id);
  return {topic:topicSummary(topicRow(topicId),session,index,work,read),root};
}

export function crossTopicQuestions(state:string|null) {
  const session=inboxOrThrow();
  const selected=state??'open';
  // One list: a four-value copy in front of this one refused `reading`, so All questions →
  // To read could never load (found by the 2026-09-24 investigation).
  if(!['open','history','deferred','checking','reading'].includes(selected))throw new TopicError('Unknown question filter.');
  const matches=(question:StoredQuestion)=>selected==='open'?awaitingHim(question)
    :selected==='reading'?toReadByHim(question)
    :selected==='checking'?preparingForHim(question)
    :selected==='deferred'?question.state==='deferred'
    :['answered','declined','withdrawn','superseded','read','expired'].includes(question.state);
  const index=entryIndex(),work=workIndex(session.id),read=readIndex(session.id);
  const groups=[];
  for(const row of db.query(`SELECT * FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) ORDER BY updated_at DESC`).all(session.id) as any[]) {
    const topic=toStoredTopic(row);
    const questions=topicQuestions(topic.topicId).filter(matches);
    if(!questions.length)continue;
    const reply=latestHumanReply(read,topicRoots(topic.topicId));
    groups.push({topic:topicSummary(topic,session,index,work,read),questions:questions.map(question=>questionView(question,reply)),replyTargets:replyTargets(topic.topicId)});
  }
  return {topics:groups};
}

/* ------------------------------------------------------------------ agent commands */

function assertInbox(session:SessionRow) {
  if(!sessionMetadata(session).inbox)throw new TopicError('Only the Inbox session owns topics.',403,'TOPIC_FORBIDDEN');
}
/** A worker may declare questions against a topic it actually holds a linked dispatch for. */
function ownsLinkedDispatch(sessionId:number,topicId:string,declarations?:unknown) {
  const address=`concierge:${sessionId}`;
  for(const request of topicRequests(topicId))
    if(request.dispatches.some((dispatch:any)=>dispatch.targetSessionId===address))return true;
  const commRows=db.query(`SELECT source_input_id,thread_root_input_id FROM session_communication_requests WHERE target_session_id=?`).all(sessionId) as {source_input_id:string|null;thread_root_input_id:string|null}[];
  for(const row of commRows){
    if(row.source_input_id&&(topicOfRoot(row.source_input_id)===topicId||topicOfRoot(rootOf(topicRow(topicId).sessionId,row.source_input_id)??row.source_input_id)===topicId))return true;
    if(row.thread_root_input_id&&(topicOfRoot(row.thread_root_input_id)===topicId||topicOfRoot(rootOf(topicRow(topicId).sessionId,row.thread_root_input_id)??row.thread_root_input_id)===topicId))return true;
  }
  const peerRows=db.query(`SELECT source_input_id FROM session_peer_requests WHERE remote_session_id=?`).all(sessionId) as {source_input_id:string|null}[];
  for(const row of peerRows){
    if(row.source_input_id&&(topicOfRoot(row.source_input_id)===topicId||topicOfRoot(rootOf(topicRow(topicId).sessionId,row.source_input_id)??row.source_input_id)===topicId))return true;
  }
  if(Array.isArray(declarations)){
    const dispatches=new Set(topicRequests(topicId).flatMap((r:any)=>(r.dispatches??[]).map((d:any)=>String(d.requestId))));
    for(const item of declarations){
      if(item?.owner?.dispatchRequestId&&dispatches.has(String(item.owner.dispatchRequestId)))return true;
    }
  }
  return false;
}
const byOf=(actor:TopicActor):TopicBy=>({kind:'agent',sessionId:`concierge:${actor.sessionId}`,inputId:actor.inputId,runId:actor.runId});

function placementRoots(session:SessionRow,values:unknown,field='--root') {
  const roots=idList(values,field);
  if(!roots.length)throw new TopicError(`${field} names at least one thread root.`);
  refreshRootMemo();
  return roots.map(value=>{
    const root=rootOf(session.id,value)??value;
    if(root!==value)throw new TopicError(`${value} is one message inside a conversation rooted at ${root}. Use topics route for that message, or name the root explicitly to move the whole conversation.`,409,'MESSAGE_IS_NOT_ROOT');
    if(!getAcceptedSessionInput(root)&&inboxRowByMessageId(session.id,root)?.kind!=='topic_route')
      throw new TopicError(`${value} is not a message in this Inbox.`,404,'ROOT_UNKNOWN');
    return root;
  });
}
export const routableMessage=(input:AcceptedSessionInput)=>{
  if(humanAuthored(input))return true;
  if(input.origin!=='agent'&&input.origin!=='service'||input.kind!=='input'||!input.scope.startsWith('capture:'))return false;
  const capture=JSON.parse(input.payload_json)?.capture?.source;
  if(capture?.kind==='reader')return true;
  if(capture?.kind==='agent-report')return true;
  return input.origin==='agent'&&capture?.kind==='outside-agent'||input.origin==='agent'&&!!(capture?.metadata?.agentSource
    &&capture.metadata.agentSource.inputId===input.source_input_id
    &&capture.metadata.agentSource.runId===input.source_run_id);
};
function existingMessageRoute(sourceMessageId:string):{event_id:string}|null {
  const route=db.query("SELECT event_id,payload_json FROM session_owner_events WHERE kind IN ('topic_route','session_route') AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC LIMIT 1")
    .get(sourceMessageId) as {event_id:string;payload_json:string}|null;
  if(!route)return null;
  const requestId=JSON.parse(route.payload_json).requestId;
  const peer=requestId?db.query('SELECT delivery_json,outcome FROM session_peer_requests WHERE request_id=?').get(requestId) as {delivery_json:string|null;outcome:string|null}|null:null;
  return peer?.delivery_json&&peer.outcome?null:route;
}
/** The ask transaction calls this after retaining its target input; no receipt exists before both commit. */
export function recordSessionMessageRoute(input:{sourceMessageId:string;destinationSessionId:string;destinationMessageId:string;
  requestId:string;actor:TopicActor}) {
  const session=getSessionById(input.actor.sessionId);
  if(!session)throw new TopicError('Unknown Inbox session.',404,'ROUTE_SOURCE_UNKNOWN');
  assertInbox(session);
  const source=getAcceptedSessionInput(input.sourceMessageId);
  if(!source||!sessionMetadata(getSessionById(source.session_id)!).inbox||!routableMessage(source))
    throw new TopicError('Route one exact accepted human Inbox message or marked agent test capture.',404,'ROUTE_MESSAGE_UNKNOWN');
  const sourceRoot=inboxThreadRoot(source.session_id,input.sourceMessageId);
  const sourceTopicId=sourceRoot?topicOfRoot(sourceRoot):null;
  if(!sourceRoot||!sourceTopicId)throw new TopicError('Place the source conversation before routing its message.',409,'ROUTE_SOURCE_UNPLACED');
  const prior=existingMessageRoute(input.sourceMessageId);
  if(prior)throw new TopicError(`This message was already routed as ${prior.event_id}.`,409,'MESSAGE_ALREADY_ROUTED');
  const route={sourceMessageId:input.sourceMessageId,sourceRoot,sourceTopicId,
    destinationSessionId:input.destinationSessionId,destinationMessageId:input.destinationMessageId,
    requestId:input.requestId,by:byOf(input.actor),at:nowIso()};
  recordSessionEvent({eventId:`session-route:${input.requestId}`,sessionId:session.id,inputId:input.actor.inputId,
    turnId:input.actor.turnId,kind:'session_route',payload:route});
  return route;
}
function rootRecords(topicId:string,roots:string[],by:TopicBy,reason:string|null) {
  const at=nowIso();
  return roots.map(rootInputId=>({rootInputId,topicId,placedAt:at,placedBy:by,reason}));
}
/**
 * A request he made closes as completed only when the latest linked attempt explicitly finished
 * with the required check or not-checked reason, every earlier attempt ended, and no decision question remains open. On 2026-10-02 a request closed
 * completed with the reason "paid bodies not read", over a worker reply that said the same, and
 * the unmet half of what he asked never reached him [decision: act-then-tell].
 */
function humanRequest(topic:StoredTopic,request:StoredRequest):boolean {
  if(request.requestId.startsWith('req:agent-report:'))return false;
  return request.sources.some(source=>{
      const input=getAcceptedSessionInput(source.inputId);
      const provenance=input?.origin==='agent'?sessionInputProvenance(input):null;
      return input?.origin==='human'||(!!provenance?.originatingHuman&&provenance.effectScope==='work');
    })
    ||topicRoots(topic.topicId).some(id=>{
      const input=getAcceptedSessionInput(id);
      return input?.origin==='human'&&new Date(iso(input.created_at)!).getTime()<=new Date(iso(request.createdAt)!).getTime();
    });
}
type CompletionRow={outcome:string|null;result_json:string|null;requested_effect:string|null;created_at_ms:number;stalled_at_ms:number|null};
/**
 * A shared dispatch can have a retained final but no answer post in a topic created later by
 * migration. Naming the exact final proves custody and attribution without posting its words
 * again. A final without a typed disposition still needs the router's request-specific judgment;
 * a typed final must already say completed without a not-checked reason. The router still
 * judges whether the retained answer actually covers this human request.
 */
function verifiedFinalEvidence(dispatchId:string,row:CompletionRow|null,evidence:readonly string[],allowFailedCheck=false):boolean {
  if((row?.outcome!=='answered'&&!(allowFailedCheck&&row?.outcome==='failed'))||!row.result_json)return false;
  let result:any;
  try{result=JSON.parse(row.result_json);}catch{return false;}
  if(typeof result.event_id!=='string'||!evidence.includes(result.event_id)
    ||result.workDisposition!==undefined
      &&(allowFailedCheck?result.workDisposition!=='failed':result.workDisposition!=='completed'||notSeenWorking(result.closingLine)))return false;
  if(allowFailedCheck&&result.workDisposition!=='failed')return false;
  const local=db.query(`SELECT payload_json FROM session_communication_events
    WHERE event_id=? AND request_id=? AND kind='final' AND superseded_by_event_id IS NULL`).get(result.event_id,dispatchId) as {payload_json:string}|null;
  const peer=local?null:db.query(`SELECT payload_json FROM session_peer_events
    WHERE event_id=? AND request_id=? AND kind='final' AND superseded_by_event_id IS NULL`).get(result.event_id,dispatchId) as {payload_json:string}|null;
  const retained=local??peer;
  if(!retained)return false;
  try {
    const payload=JSON.parse(retained.payload_json);
    // The event row binds the final to this dispatch. A recipient may answer it from a
    // later accepted input, such as a return, while preserving that input's own source.
    return payload.final===true
      &&typeof payload.source?.input_id==='string'&&!!payload.source.input_id
      &&typeof payload.source?.run_id==='string'&&!!payload.source.run_id
      &&payload.text===result.text
      &&payload.responding_session_id===result.responding_session_id
      &&payload.workDisposition===result.workDisposition;
  } catch{return false;}
}
function refuseUnfinishedCompletion(topic:StoredTopic,request:StoredRequest,evidence:string[]=[]){
  const settled=(id:string)=>{
    const local=db.query("SELECT outcome,result_json,created_at_ms,stalled_at_ms,json_extract(payload_json,'$.requestedEffect') AS requested_effect FROM session_communication_requests WHERE request_id=?").get(id) as CompletionRow|null;
    return local??db.query("SELECT outcome,result_json,created_at_ms,stalled_at_ms,json_extract(payload_json,'$.requestedEffect') AS requested_effect FROM session_peer_requests WHERE request_id=?").get(id) as CompletionRow|null;
  };
  const done=(row:{outcome:string|null;result_json:string|null;requested_effect:string|null})=>{
    if(row.outcome!=='answered')return false;
    if(row.requested_effect==='informational')return true;
    if(!row.result_json)return false;
    try{const result=JSON.parse(row.result_json);return result.workDisposition==='completed'&&!notSeenWorking(result.closingLine);}
    catch{return false;}
  };
  // The latest dispatch is where the work stands: an earlier one that asked a question or
  // failed was answered by sending the work again (2026-10-04, a proposal answered
  // needs_decision, then built by a second dispatch). Anything still running is unfinished.
  const dispatches=(request.dispatches??[]).map((dispatch:any)=>({id:String(dispatch?.requestId??''),row:settled(String(dispatch?.requestId??''))}))
    .sort((left,right)=>(left.row?.created_at_ms??0)-(right.row?.created_at_ms??0)||left.id.localeCompare(right.id));
  const latest=dispatches.at(-1);
  // A shared check can fail for another request after this request's own repair finished.
  // Require both the earlier exact completed final and the later exact failed-check final;
  // the router then judges the check's request-specific result in its closure reason.
  const latestShared=latest?db.query(`SELECT count(*) AS count FROM inbox_requests request,json_each(request.dispatches_json) dispatch
    WHERE json_extract(dispatch.value,'$.requestId')=?`).get(latest.id) as {count:number}:null;
  const completedBeforeSharedFailure=!!latest&&!!latestShared&&latestShared.count>1
    &&verifiedFinalEvidence(latest.id,latest.row,evidence,true)
    &&dispatches.slice(0,-1).some(dispatch=>verifiedFinalEvidence(dispatch.id,dispatch.row,evidence));
  if(!latest){
    if(humanRequest(topic,request)&&!evidence.some(id=>{
      const message=inboxMessageById(topic.sessionId,id) as {role?:string;createdAt?:string}|null;
      const root=inboxThreadRoot(topic.sessionId,id);
      return !!(message?.role==='assistant'&&message.createdAt&&new Date(iso(message.createdAt)!).getTime()>=new Date(iso(request.createdAt)!).getTime()
        &&root&&topicOfRoot(root)===topic.topicId);
    }))throw new TopicError('This human request has no linked work. To close it completed, name the later answer in this thread as evidence of the work you checked.',409,'REQUEST_COMPLETION_EVIDENCE_REQUIRED');
  }
  const unfinished=dispatches.filter(dispatch=>(!dispatch.row?.outcome&&!(dispatch!==latest&&dispatch.row?.stalled_at_ms!=null))
      ||(dispatch===latest&&dispatch.row!==null&&!completedBeforeSharedFailure&&!done(dispatch.row)
        &&!verifiedFinalEvidence(dispatch.id,dispatch.row,evidence))).map(dispatch=>({requestId:dispatch.id}));
  if(unfinished.length)throw new TopicError(`This request's work has not finished (${unfinished.map((d:any)=>d.requestId).join(', ')}): close it completed only when that work answered as done. If part of what he asked is not done, do it or have it built, then close.`,409,'REQUEST_WORK_UNFINISHED');
  if(request.reopenedAt&&((request.completionFloor??0)>=dispatches.length
    ||(latest&&((workRow(latest.id)?.createdAtMs??0)<new Date(request.reopenedAt).getTime())))&&!evidence.some(id=>{
    const post=db.query("SELECT input_id,payload_json,created_at FROM session_owner_events WHERE event_id=? AND kind='post'").get(id) as {input_id:string;payload_json:string;created_at:string}|null;
    if(!post||new Date(iso(post.created_at)!).getTime()<new Date(request.reopenedAt!).getTime())return false;
    const payload=JSON.parse(post.payload_json);
    return topicOfRoot(String(payload.threadRoot??post.input_id))===topic.topicId
      &&(!latest||payload.requestId==null||payload.requestId===latest.id);
  }))throw new TopicError('This request was reopened after its last linked answer. Name a new checked answer in this thread, or link the work that finished the reopened obligation.',409,'REQUEST_REOPENED_COMPLETION_EVIDENCE_REQUIRED');
  if(latest&&humanRequest(topic,request)) {
    const shared=db.query(`SELECT count(*) AS count FROM inbox_requests request,json_each(request.dispatches_json) dispatch
      WHERE json_extract(dispatch.value,'$.requestId')=?`).get(latest.id) as {count:number};
    if(shared.count>1&&!completedBeforeSharedFailure&&!verifiedFinalEvidence(latest.id,latest.row,evidence)&&!evidence.some(id=>{
      const post=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=? AND kind=?').get(id,'post') as {payload_json:string}|null;
      return post&&JSON.parse(post.payload_json).requestId===latest.id;
    }))throw new TopicError('This agent answer is linked to several human requests. Check this request separately and name the agent answer as evidence before closing it.',409,'REQUEST_SHARED_COMPLETION_EVIDENCE_REQUIRED');
  }
  if(questionsOfRequest(topic.topicId,request).some(question=>question.kind==='decision'&&OPEN_QUESTION_STATES.includes(question.state)))
    throw new TopicError('A question for this request is still open: settle it before closing the request as completed.',409,'REQUEST_QUESTION_OPEN');
}
function parseSources(values:unknown):{inputId:string;passage?:string}[] {
  return idList(values,'--source').map(value=>{
    const prefix=['capture:','request:','post:','return:','topic-event:'].find(candidate=>value.startsWith(candidate))??'';
    const rest=value.slice(prefix.length);
    const index=rest.indexOf(':');
    return index<0?{inputId:value}:{inputId:prefix+rest.slice(0,index),passage:rest.slice(index+1)};
  });
}

function createTopic(session:SessionRow,by:TopicBy,fields:{title:string;summary?:string|null;roots:string[];reason?:string|null;recovered?:boolean;splitFrom?:string|null;parentTopicId?:string|null;areaIds?:string[]}) {
  const at=nowIso();
  const topic:StoredTopic={topicId:`topic:${randomUUID()}`,sessionId:session.id,title:fields.title,summary:fields.summary??'',state:'open',
    setAside:null,aliases:[],revision:1,recovered:!!fields.recovered,readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
  return {topic,change:{kind:'topic',payload:{change:'created',topicId:topic.topicId,topic,
    roots:rootRecords(topic.topicId,fields.roots,by,fields.reason??null),
    areaLinks:(fields.areaIds??[]).map(areaId=>({areaId,topicId:topic.topicId,origin:by.kind==='human'?'human':'agent',reason:fields.reason??'',at})),
    by,reason:fields.reason??null,revision:topic.revision,
    ...(fields.splitFrom?{splitFrom:fields.splitFrom}:{}),
    ...(fields.parentTopicId?{parentTopicId:fields.parentTopicId}:{})}} as Change};
}

/** The report and its open work item are committed with the capture, before router admission. */
export function openAgentReport(sessionId:number,inputId:string,title:string,brief:string) {
  const session=getSessionById(sessionId);
  if(!session||!sessionMetadata(session).inbox)throw new TopicError('Agent reports belong to the Inbox.',400,'AGENT_REPORT_INBOX_REQUIRED');
  const existing=topicOfRoot(inputId);
  if(existing)return {topicId:existing,requestId:`req:agent-report:${inputId}`};
  const by:TopicBy={kind:'owner',sessionId:`concierge:${sessionId}`};
  const created=createTopic(session,by,{title,roots:[inputId],areaIds:[ensureAgentReportArea(sessionId)],reason:'An agent reported an issue for Inbox routing.'});
  recordOwnerTopicChange(sessionId,`topic-agent-report:${inputId}`,'topic',created.change.payload);
  const at=nowIso();
  const request:StoredRequest={requestId:`req:agent-report:${inputId}`,topicId:created.topic.topicId,title,brief:Array.from(brief).slice(0,8000).join(''),state:'open',disposition:null,
    revision:1,sources:[{inputId}],dispatches:[],closure:null,createdAt:at,updatedAt:at};
  const next=bumped(created.topic);
  recordOwnerTopicChange(sessionId,`topic-agent-report-request:${inputId}`,'topic_request',
    {change:'added',topicId:created.topic.topicId,topic:next,request,by,revision:next.revision});
  return {topicId:created.topic.topicId,requestId:request.requestId};
}

/** Keep subsequent observations on the already-owned process issue, with a durable event. */
export function appendAgentReportObservation(requestId:string,observationId:string,observation:string) {
  const eventId=`topic-agent-report-observation:${observationId}`;
  const prior=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
  if(prior){
    if(JSON.parse(prior.payload_json).observation!==observation)
      throw new TopicError('Idempotency conflict: this process observation changed under the same action.',409);
    return false;
  }
  const request=requestRow(requestId);
  if(request.state!=='open')return false;
  const topic=topicRow(request.topicId);
  const next:StoredRequest={...request,brief:(request.brief+'\n\nLater observation: '+observation).slice(-8000),
    revision:request.revision+1,updatedAt:nowIso()};
  const topicNext=bumped(topic);
  return recordOwnerTopicChange(topic.sessionId,eventId,'topic_request',
    {change:'amended',topicId:topic.topicId,topic:topicNext,request:next,
      by:{kind:'owner',sessionId:`concierge:${topic.sessionId}`},reason:'A later turn found another process for this open issue.',
      observation,revision:topicNext.revision});
}

/**
 * A leftover-process issue is only about processes that still run. When every process it
 * recorded has exited, the owner closes it with that evidence, so no agent settles each copy.
 */
export function settleExitedProcessReport(requestId:string,evidence:string) {
  const request=requestRow(requestId);
  if(request.state!=='open')return false;
  const topic=topicRow(request.topicId),at=nowIso();
  const why=`Every process this report recorded has exited. ${evidence}`.slice(0,4000);
  const next={...request,state:'closed' as const,disposition:'completed',closure:{by:OWNER_BY,at,reason:why,evidence:[]},
    revision:request.revision+1,updatedAt:at};
  const questions=expireOpen(questionsOfRequest(topic.topicId,request),`The request it was for closed (completed): ${why}`,at);
  const topicNext=bumped(topic);
  return recordOwnerTopicChange(topic.sessionId,`topic-process-report-settled:${requestId}:${request.revision}`,'topic_request',
    {change:'request_closed',topicId:topic.topicId,topic:topicNext,request:next,by:OWNER_BY,reason:why,revision:topicNext.revision,questions});
}

/**
 * An agent may put a bug report only alone into a thread that holds nothing else: a new
 * one, or an empty one when moving it back out. On Nov 5 the router placed his bug report
 * about a worker's answer into that worker's thread [decision: inbox-button-always-new-request].
 */
function refuseSharedBugReportThread(roots:string[],topicId:string|null) {
  const reports=roots.filter(isBugReportInput);
  if(!reports.length)return;
  const others=new Set([...roots,...(topicId?topicRoots(topicId):[])]);
  for(const report of reports)others.delete(report);
  if(others.size||reports.length>1)throw new TopicError(BUG_REPORT_OWN_THREAD,409,'BUG_REPORT_OWN_THREAD');
}

function placeChange(session:SessionRow,topic:StoredTopic,roots:string[],by:TopicBy,reason:string|null) {
  for(const root of roots){
    const previous=topicOfRoot(root);
    if(!previous||previous===topic.topicId)continue;
    const linked=db.query(`SELECT request_id FROM session_communication_requests
      WHERE thread_root_input_id=? AND json_extract(payload_json,'$.forwardedReply.topicId')=? LIMIT 1`)
      .get(root,previous) as {request_id:string}|null;
    if(linked)throw new TopicError(`This conversation has a human reply already sent to an agent for ${previous} (${linked.request_id}). Route the exact human message instead of moving its conversation.`,409,'FORWARDED_REPLY_TOPIC_MOVE');
  }
  const next=bumped(topic);
  return {topic:next,change:{kind:'topic',payload:{change:'placed',topicId:topic.topicId,topic:next,
    roots:rootRecords(topic.topicId,roots,by,reason),by,reason,revision:next.revision}} as Change};
}

function mergeChange(from:StoredTopic,into:StoredTopic,by:TopicBy,reason:string|null) {
  const at=nowIso();
  const destination=bumped(into,{aliases:[...new Set([...into.aliases,from.title,...from.aliases])]});
  const source:StoredTopic={...from,state:'closed',revision:from.revision+1,updatedAt:at,
    closure:{kind:'merged',into:into.topicId,by,at,reason}};
  const roots=topicRoots(from.topicId).map(rootInputId=>({rootInputId,topicId:into.topicId,placedAt:at,placedBy:by,reason}));
  const requests=topicRequests(from.topicId).map(request=>({...request,topicId:into.topicId,updatedAt:at}));
  const questions=topicQuestions(from.topicId).map(question=>({...question,topicId:into.topicId,updatedAt:at}));
  const areaLinks=(db.query('SELECT area_id AS areaId,origin,reason FROM inbox_area_threads WHERE topic_id=?').all(from.topicId) as
    {areaId:string;origin:string;reason:string}[]).map(link=>({...link,topicId:into.topicId,at}));
  return {change:{kind:'topic',payload:{change:'merged',topicId:into.topicId,topic:destination,mergedTopic:source,fromTopicId:from.topicId,
    roots,requests,questions,areaLinks,removedAreaLinks:areaLinks.map(link=>({areaId:link.areaId,topicId:from.topicId})),
    by,reason,revision:destination.revision}} as Change,destination,source};
}

/** Who last renamed this thread, seeking only its own events. Unscoped, this walked every topic event
 * in the ledger inside the rename transaction and held the owner 26.5 s (2026-11-02); scoped by
 * session alone it still walked every Inbox topic event (~330 ms). The index is named because the
 * ledger has no planner statistics. */
function lastRenameBy(topic:StoredTopic):TopicBy|null {
  const row=db.query(`SELECT json_extract(payload_json,'$.by') AS by_json FROM session_owner_events
    INDEXED BY session_owner_events_topic_relation
    WHERE session_id=? AND kind IN ('topic','topic_route') AND json_extract(payload_json,'$.topicId')=?
    AND kind='topic' AND json_extract(payload_json,'$.change')='renamed'
    ORDER BY sequence DESC LIMIT 1`).get(topic.sessionId,topic.topicId) as {by_json:string|null}|null;
  return row?.by_json?JSON.parse(row.by_json):null;
}

function questionBrief(item:any) {
  const why=item.why&&typeof item.why==='object'?item.why:{text:item.why??''};
  if(item.choices!==undefined&&!Array.isArray(item.choices))throw new TopicError('choices must be an array of {label, consequence, recommended?, reason?}.');
  if(item.uncertain!==undefined&&!Array.isArray(item.uncertain))throw new TopicError('uncertain must be an array of {text, owner} or strings.');
  // A choice's `option` and a bare string uncertainty are accepted as what they plainly mean; a
  // choice with no words at all is refused rather than stored as an empty label (2026-09-22: a
  // declaration lost its options and its uncertainties silently and reached him empty).
  const choices=(item.choices??[]).map((choice:any,index:number)=>{
    const label=typeof choice==='string'?choice:String(choice?.label??choice?.option??'').trim();
    if(!label)throw new TopicError(`choices[${index}] needs a label.`);
    return {label,consequence:typeof choice==='object'&&choice?String(choice.consequence??''):'',
      recommended:typeof choice==='object'&&choice?.recommended===true,reason:typeof choice==='object'&&typeof choice?.reason==='string'?choice.reason:''};
  });
  const uncertain=(item.uncertain??[]).map((entry:any,index:number)=>{
    const text=typeof entry==='string'?entry.trim():String(entry?.text??'').trim();
    if(!text)throw new TopicError(`uncertain[${index}] needs text.`);
    return {text,owner:typeof entry==='object'&&entry?.owner==='agent'?'agent':'human'};
  });
  const decision=text(item.decision,'decision',2000);
  // The decision is the body of his notification; a fragment there is what reached his Lock Screen as "1.".
  const fragment=fragmentReason(decision);
  if(fragment)throw new TopicError(`decision ${fragment}`,400,'DECISION_FRAGMENT');
  return {decision,
    why:{text:typeof why.text==='string'?why.text:'',sources:idList(why.sources,'why.sources')},
    known:typeof item.known==='string'?item.known:'',
    choices,uncertain,
    answerable:typeof item.answerable==='string'?item.answerable:'',
    ...(typeof item.hisWords==='string'&&item.hisWords.trim()?{hisWords:item.hisWords.trim()}:{}),
    ...(typeof item.whyNotSettled==='string'&&item.whyNotSettled.trim()?{whyNotSettled:item.whyNotSettled.trim()}:{}),
    ...(typeof item.onlyHeCan==='string'&&item.onlyHeCan.trim()?{onlyHeCan:item.onlyHeCan.trim()}:{}),
    ...(typeof item.todo==='string'&&item.todo.trim()?{todo:item.todo.trim()}:{}),
    ...(typeof item.decisionId==='string'&&item.decisionId.trim()?{decisionId:item.decisionId.trim()}:{}),
    ...(typeof item.approvalAction==='string'&&item.approvalAction.trim()?{approvalAction:item.approvalAction.trim()}:{}),
    // A reading item may name the exact messages he is to read; otherwise they are resolved
    // from the declaring run's own posts into this thread.
    ...(item.reads!==undefined?{reads:idList(item.reads,'reads')}:{})};
}
/**
 * A decision he is asked to make carries the words of his that started the work and why they
 * leave it open, checked when it is declared ready and shown with the question's why
 * [decision: questions-carry-his-words]. Only declarations are held to it: questions stored
 * before 2026-09-29 keep the readiness they had.
 */
function withHisWords(brief:any,by:TopicBy):any {
  const kind=requireOnlyHeCan(brief.onlyHeCan,THREAD_QUESTION_FIELDS_REQUIRED);
  // A step he must take names the to-do it is about, as worker questions do; its state was read
  // from thnkr.ing before this command ran (the routed request API refuses a finished one).
  if(STEP_ASKS.has(kind)&&!brief.todo)
    throw new TopicError('This question asks him to do a step himself, so it names the to-do it is about: "todo": "<his to-do id>", or "todo": "none" when no to-do for this step exists. If he already ticked it off, he has done it: do not ask.',400,'QUESTION_NEEDS_TODO');
  if(kind==='device'&&!deviceQuestionNamesPhysicalPrerequisite(brief.decision))
    throw new TopicError('An onlyHeCan device question asks for one action on a physical device in its first sentence, such as "Please unlock your iPhone." or "Can you unlock your Mac so I can continue?"; later sentences may only state what you saw or will do, never ask him for more. Try the available agent route first, then explain in whyNotSettled why only Tejas can take this step.');
  if(kind!=='approval'&&(brief.decisionId!==undefined||brief.approvalAction!==undefined))
    throw new TopicError('decisionId and approvalAction belong to onlyHeCan approval.');
  const decision=kind==='approval'?approvalDecision(brief.decisionId,brief.approvalAction):undefined;
  const {hisWords,why}=requireHisWords({actorInputId:by.inputId??'',hisWords:brief.hisWords,whyNotAnswered:brief.whyNotSettled},THREAD_QUESTION_FIELDS_REQUIRED,decision);
  const citation=decision?`\nRequired by permanent decision: ${decision} (${brief.approvalAction})`:'';
  const line=`${hisWordsLine(hisWords,why)}\nOnly you can: ${ONLY_HE_CAN[kind]}${citation}`;
  return brief.why.text.includes(line)?brief:{...brief,why:{...brief.why,text:`${brief.why.text.trim()}\n\n${line}`.trim()}};
}
/** `ready`, `agent_checking`, its plain spelling `checking`, or nothing; anything else is a mistake, not a default. */
function questionContext(value:unknown):'ready'|'agent_checking'|undefined {
  if(value===undefined||value===null)return undefined;
  if(value==='ready')return 'ready';
  if(value==='agent_checking'||value==='checking'||value==='preparing')return 'agent_checking';
  throw new TopicError(`Unknown question context ${JSON.stringify(value)}; use ready or agent_checking.`);
}
/** The responsible agent: the documented object, or a bare session id meaning the same thing. */
function questionOwner(value:unknown):any|null|undefined {
  if(value===undefined)return undefined;
  if(value===null)return null;
  if(typeof value==='string')return value.trim()?{sessionId:value.trim()}:null;
  if(typeof value==='object')return value;
  throw new TopicError('owner must be {sessionId, requestId?, dispatchRequestId?} or a session id.');
}
/** The one open request a question's sources name, or the thread's only open request. */
function impliedRequest(open:StoredRequest[],sources:string[]):StoredRequest|null {
  const bySource=open.filter(request=>request.sources.some(source=>sources.includes(source.inputId)));
  return bySource.length===1?bySource[0]!:open.length===1?open[0]!:null;
}
/** Whether a question asked before links were derived (no request named either way) belongs to this request. */
function unlinkedQuestionImplies(question:StoredQuestion,request:StoredRequest,open:StoredRequest[]):boolean {
  const owner=question.owner;
  if(owner&&('requestId' in owner||owner.dispatchRequestId))return false;
  return impliedRequest(open,question.sources)?.requestId===request.requestId;
}
/**
 * The request a decision question waits on, stored on its owner so the never-dropped sweep
 * (`settleEndedRequests`) reads the request as waiting on Tejas instead of re-flagging it. On
 * 2026-11-04 the Inbox router asked two only-he-can questions with only its session and run as
 * owner, and the sweep kept sending recovery for both requests while he had the question open.
 * The link is derived, not remembered: a question whose sources name exactly one open request's
 * source, or the thread's only open request, belongs to it. With several open requests and no
 * evidence the declaration must name one (`owner.requestId`), or say `"requestId": null` for a
 * thread-level question that blocks no request.
 */
function linkQuestionToRequest(topic:StoredTopic,owner:any|null,sources:string[]):any|null {
  if(owner&&('requestId' in owner||owner.dispatchRequestId)) {
    if(owner.requestId){
      const named=topicRequests(topic.topicId).find(request=>request.requestId===owner.requestId);
      if(!named)throw new TopicError(`Request ${owner.requestId} is not in this thread.`,409,'QUESTION_REQUEST_MISMATCH');
    }
    return owner;
  }
  const open=topicRequests(topic.topicId).filter(request=>request.state==='open');
  if(!open.length)return owner;
  const chosen=impliedRequest(open,sources);
  if(!chosen)throw new TopicError(`This thread has ${open.length} open requests (${open.map(request=>`${request.requestId} "${request.title}"`).join(', ')}). Name the one this question waits on with owner.requestId, or set owner.requestId to null for a thread-level question, so the request is not flagged as dropped while he has it.`,400,'QUESTION_REQUEST_REQUIRED');
  return {...(owner??{}),requestId:chosen.requestId};
}
const decisionKey=(decision:string)=>decision.replace(/\s+/g,' ').trim().toLowerCase();
const briefChanged=(first:any,second:any)=>JSON.stringify(first)!==JSON.stringify(second);

function reconcileQuestions(session:SessionRow,topic:StoredTopic,declarations:unknown,by:TopicBy,reason:string|null) {
  if(!Array.isArray(declarations)||!declarations.length)throw new TopicError('Question reconciliation needs a nonempty JSON array.');
  const inboxSessionRow=getSessionById(topic.sessionId)??session;
  const at=nowIso();
  const written:StoredQuestion[]=[];
  const seen=new Map<string,StoredQuestion>();
  const current=(id:string)=>seen.get(id)??questionRow(id);
  for(const item of declarations as any[]) {
    if(!item||typeof item!=='object')throw new TopicError('Each question declaration must be an object.');
    let brief=questionBrief(item);
    const blocking=item.blocking!==false,optional=item.optional===true;
    const declaredContext=questionContext(item.context);
    const state:QuestionState=item.state==='partial'?'partial':'open';
    const owner=questionOwner(item.owner);
    if(owner&&owner.dispatchRequestId&&!owner.sessionId){
      const dispatch=topicRequests(topic.topicId).flatMap((r:any)=>r.dispatches??[]).find((d:any)=>d.requestId===owner.dispatchRequestId);
      if(dispatch?.targetSessionId)owner.sessionId=dispatch.targetSessionId;
    }
    const sources=idList(item.sources,'sources');
    // The read API spells the identity `id`; both spellings name the same question here.
    if(item.questionId!==undefined&&item.id!==undefined&&String(item.questionId)!==String(item.id))
      throw new TopicError('questionId and id name different questions.',409,'QUESTION_ID_CONFLICT');
    const identity=item.questionId??item.id;
    // A ready question must be answerable; one that is not stays the agent's preparation. Asking
    // for `ready` with a brief that cannot be answered is refused with what is missing.
    const missing=briefMissing(brief);
    // An only-he-can question is meant for him now; parking it silently as agent_checking hid five
    // of them from his Needs list (2026-11-04). Staging one stays possible with an explicit context.
    if(declaredContext===undefined&&brief?.onlyHeCan&&missing.length)
      throw new TopicError(`An onlyHeCan question goes to Tejas, so it needs ${missing.join(', ')} to be shown to him; add them, or declare context agent_checking while you are still preparing it.`,400,'QUESTION_NOT_ANSWERABLE');
    if(declaredContext==='ready'&&missing.length)throw new TopicError(`A ready question needs ${missing.join(', ')}; declare it agent_checking while it is being prepared.`,400,'QUESTION_NOT_ANSWERABLE');
    if(identity!==undefined) {
      const existing=current(String(identity));
      if(existing.topicId!==topic.topicId)throw new TopicError('That question belongs to another topic.',409,'QUESTION_TOPIC_MISMATCH');
      const context=declaredContext??(missing.length?'agent_checking':existing.context);
      if(existing.kind!=='reading'&&context==='ready'&&by.kind==='agent'&&briefChanged(existing.brief,brief)){
        try{brief=withHisWords(brief,by);}catch(error){throw new TopicError((error as Error).message,400,'QUESTION_NEEDS_HIS_WORDS');}}
      const declaredOwner=owner===undefined?existing.owner:owner;
      const nextOwner=existing.kind==='decision'&&OPEN_QUESTION_STATES.includes(existing.state)
        ?linkQuestionToRequest(topic,declaredOwner,sources.length?sources:existing.sources):declaredOwner;
      if(existing.kind==='asked'&&sources.length){
        for(const s of sources){
          if(!resolveAskedSource(s,topic))
            throw new TopicError('The source must be Tejas’s message in this thread.',409,'QUESTION_SOURCE_MISMATCH');
        }
      }
      const nextSources=existing.kind==='asked'?[...new Set([...existing.sources,...sources])]:sources.length?sources:existing.sources;
      const changed=briefChanged(existing.brief,brief)||existing.blocking!==blocking||existing.optional!==optional||existing.context!==context
        ||briefChanged(existing.owner,nextOwner)||briefChanged(existing.sources,nextSources);
      const next:StoredQuestion={...existing,brief,blocking,optional,context,owner:nextOwner,sources:nextSources,
        state:OPEN_QUESTION_STATES.includes(existing.state)?state:existing.state,
        revision:changed?existing.revision+1:existing.revision,updatedAt:at,
        ...(typeof item.changedBecause==='string'?{brief:{...brief,changedBecause:item.changedBecause}}:{})};
      if(next.kind==='reading'&&OPEN_QUESTION_STATES.includes(next.state)&&!readsFor(next).length)throw new TopicError(NOTHING_TO_READ,409,'NOTHING_TO_READ');
      seen.set(next.questionId,next);written.push(next);
      continue;
    }
    // Wording is not identity, so a new declaration that repeats an unresolved decision here is
    // refused with the existing id rather than becoming its twin (2026-09-22: a revision sent
    // as `id` produced a second open copy that had to be settled by hand).
    const twin=[...seen.values(),...topicQuestions(topic.topicId)].find(candidate=>OPEN_QUESTION_STATES.includes(candidate.state)
      &&decisionKey(candidate.brief?.decision??'')===decisionKey(brief.decision)&&!(typeof item.replaces==='string'&&item.replaces===candidate.questionId));
    if(twin)throw new TopicError(`That decision is already open here as ${twin.questionId}; revise it with questionId, or replace it with replaces.`,409,'QUESTION_DUPLICATE');
    const context=declaredContext??(missing.length?'agent_checking':'ready');
    // `from` files an unfiled attention entry with this full brief instead of a bare one.
    const filed=typeof item.from==='string'?fileNeed(inboxSessionRow,topic,item.from,by,brief):null;
    const kind:QuestionKind=item.kind==='reading'?'reading':item.kind==='asked'?'asked':filed?.kind??'decision';
    let askedAt:string|null=null;
    if(kind==='asked'){
      if(sources.length!==1)throw new TopicError('A question Tejas asked needs its one source message.',400,'QUESTION_SOURCE_REQUIRED');
      const resolved=resolveAskedSource(sources[0]!,topic);
      if(!resolved)
        throw new TopicError('The source must be Tejas’s message in this thread.',409,'QUESTION_SOURCE_MISMATCH');
      askedAt=iso(resolved.source.created_at);
    }
    if(kind==='decision'&&context==='ready'&&by.kind==='agent'){
      try{brief=withHisWords(brief,by);}catch(error){throw new TopicError((error as Error).message,400,'QUESTION_NEEDS_HIS_WORDS');}}
    const questionSources=sources.length?sources:filed?.sources??[];
    const baseOwner=owner??(by.sessionId?{sessionId:by.sessionId,runId:by.runId??null}:null);
    const question:StoredQuestion={questionId:`q:${randomUUID()}`,topicId:topic.topicId,revision:1,state,blocking,optional,context,
      brief:typeof item.changedBecause==='string'?{...brief,changedBecause:item.changedBecause}:brief,
      owner:kind==='decision'?linkQuestionToRequest(topic,baseOwner,questionSources):baseOwner,sources:questionSources,
      replaces:typeof item.replaces==='string'?item.replaces:null,replacedBy:null,answer:null,recovered:false,legacyNeedEventId:filed?.legacyNeedEventId??null,
      kind,origin:filed?'marker':'declared',generation:filed?.generation??raiseGeneration(inboxSessionRow),
      createdAt:askedAt??filed?.createdAt??at,updatedAt:at};
    // A declared reading item names, or is resolved to, messages in this thread he can read.
    if(kind==='reading'&&!readsFor(question).length)throw new TopicError(NOTHING_TO_READ,409,'NOTHING_TO_READ');
    if(question.replaces) {
      const replaced=current(question.replaces);
      if(replaced.topicId!==topic.topicId)throw new TopicError('A replacement must supersede a question in the same topic.',409,'QUESTION_TOPIC_MISMATCH');
      const superseded:StoredQuestion={...replaced,state:'superseded',replacedBy:question.questionId,updatedAt:at};
      seen.set(superseded.questionId,superseded);written.push(superseded);
    }
    seen.set(question.questionId,question);written.push(question);
  }
  const next=bumped(topic);
  return {questions:written,change:{kind:'topic_question',payload:{change:'reconciled',topicId:topic.topicId,topic:next,
    questions:written,by,reason,revision:next.revision}} as Change};
}

/** Clears the legacy attention entries whose recovered question the answer just settled. */
function clearSettledLegacyNeeds(session:SessionRow,settled:StoredQuestion[]) {
  const meta=sessionMetadata(session);
  if(!meta.needs?.length)return;
  const cleared=new Set(settled.filter(question=>!OPEN_QUESTION_STATES.includes(question.state)&&question.legacyNeedEventId)
    .map(question=>question.legacyNeedEventId!));
  if(!cleared.size)return;
  const needs=meta.needs.filter(need=>!cleared.has(need.eventId));
  if(needs.length!==meta.needs.length)updateSessionMetadata(session.id,{needs});
}

function recordAnswer(session:SessionRow,input:AcceptedSessionInput,body:any,by:TopicBy) {
  const at=nowIso();
  const mappings=Array.isArray(body?.mappings)?body.mappings:[];
  if(!mappings.length&&!Array.isArray(body?.acknowledged))throw new TopicError('An answer needs mappings or acknowledged items.');
  const questions:StoredQuestion[]=[];
  const topics=new Map<string,StoredTopic>();
  const recorded:any[]=[];
  for(const mapping of mappings) {
    const question=questionRow(text(mapping?.questionId,'questionId',200));
    const state=mapping?.state==='partial'?'partial':mapping?.state==='declined'?'declined':'answered';
    const stale=mapping?.revision!==undefined&&Number(mapping.revision)!==question.revision;
    const answer={inputId:input.id,at,passage:typeof mapping?.passage==='string'?mapping.passage:null,
      interpretation:typeof mapping?.interpretation==='string'?mapping.interpretation:null,
      answeredRevision:mapping?.revision===undefined?question.revision:Number(mapping.revision),...(stale?{staleRevision:true}:{})};
    const next:StoredQuestion={...question,state:state as QuestionState,answer,updatedAt:at};
    questions.push(next);
    recorded.push({questionId:question.questionId,revision:answer.answeredRevision,state,passage:answer.passage,
      interpretation:answer.interpretation,...(stale?{staleRevision:true}:{})});
    if(!topics.has(question.topicId))topics.set(question.topicId,bumped(topicRow(question.topicId)));
  }
  const unresolved=Array.isArray(body?.unresolved)?body.unresolved.map((entry:any)=>({questionId:String(entry?.questionId??''),why:String(entry?.why??'')})):[];
  const acknowledged=idList(body?.acknowledged,'acknowledged');
  const reading=acknowledged.map(itemId=>{
    const question=db.query('SELECT topic_id,revision FROM inbox_questions WHERE question_id=?').get(itemId) as {topic_id:string;revision:number}|null;
    const root=question?null:rootOf(session.id,itemId);
    const topicId=question?.topic_id??(root?topicOfRoot(root):null);
    if(!topicId)throw new TopicError(`Cannot acknowledge ${itemId}: it is not in a topic.`,409,'ITEM_UNPLACED');
    return {topicId,itemId,revision:question?.revision??0,kind:'acknowledged' as const,at,by};
  });
  for(const item of reading)if(!topics.has(item.topicId))topics.set(item.topicId,bumped(topicRow(item.topicId)));
  const answerRoot=rootOf(session.id,input.id);
  const primary=(answerRoot?topicOfRoot(answerRoot):null)??questions[0]?.topicId??reading[0]?.topicId??null;
  if(primary&&!topics.has(primary))topics.set(primary,bumped(topicRow(primary)));
  return {questions,change:{kind:'topic_answer',payload:{change:'recorded',topicId:primary,topicIds:[...topics.keys()],
    inputId:input.id,mappings:recorded,unresolved,acknowledged,questions,reading,topics:[...topics.values()],by,
    revision:primary?topics.get(primary)!.revision:null}} as Change};
}

/**
 * One entry point for every `sessions topics …` command. The coordinator has already proved
 * the caller is an admitted live run; this decides what that run is allowed to do.
 */
/** `listHead` is the change a list read must cover, from `listReadHead` at the request entrance. */
export function topicsCommand(actor:TopicActor,body:any,listHead?:number) {
  if(typeof body?.verb==='string'&&body.verb.startsWith('area.'))return areasCommand(actor,{...body,verb:body.verb.slice(5)});
  const own=getSessionById(actor.sessionId);
  if(!own)throw new TopicError('Unknown session.',404);
  // Every agent may read and organize the Inbox's threads, credited to itself; only the Inbox
  // router once could (Tejas, 2026-11-01: "every agent should be able to do all the actions
  // here. Why were we handcuffing it?") [decision: agents-are-never-handcuffed].
  const session=sessionMetadata(own).inbox?own:inboxOrThrow();
  const verb=String(body?.verb??'');
  const by=byOf(actor);
  const inbox=!!sessionMetadata(session).inbox;
  const actionId=()=>text(body?.action_id,'--action-id',200);
  const reason=()=>optionalText(body?.reason,'--reason');
  const topicFor=(id:unknown)=>{
    const topic=topicRow(text(id,'topic id',200));
    expectRevision(topic,body?.expected_revision);
    return topic;
  };
  const guard=(topicId?:string)=>{
    if(inbox)return;
    if(topicId&&['questions','read','items','detail'].includes(verb)&&ownsLinkedDispatch(actor.sessionId,topicId,body?.questions))return;
    throw new TopicError('Only the Inbox session owns topics; a worker may declare questions against a topic it holds a dispatch for.',403,'TOPIC_FORBIDDEN');
  };
  switch(verb) {
    case 'list':return inboxTopicList({state:body?.state,query:body?.query,limit:body?.limit,cursor:body?.cursor},options=>preparedTopics(options,listHead));
    case 'obligations':return openInboxObligations();
    case 'read':return preparedTopicOverview(text(body?.topic_id,'topic id',200),body?.state??'open');
    case 'resolve':guard();return preparedTopicResolution(text(body?.message_id,'message id',500));
    case 'message':guard();return inboxMessageWords(session,text(body?.message_id,'message id',500));
    case 'questions-read':guard();return preparedQuestions({state:body?.state??'open',cursor:body?.cursor,limit:body?.limit});
    case 'items':{
      const topicId=text(body?.topic_id,'topic id',200);guard(topicId);
      if(!['questions','requests','history'].includes(body?.kind))throw new TopicError('Choose questions, requests or history.');
      return preparedTopicItems({topicId,kind:body.kind,filter:body?.state??'open',cursor:body?.cursor,limit:body?.limit});
    }
    case 'detail':{
      const topicId=text(body?.topic_id,'topic id',200);guard(topicId);
      const hash=text(body?.digest,'detail digest',64),part=body?.part??0;
      if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(part)||part<0)throw new TopicError('Name an exact detail digest and nonnegative part.');
      return preparedTopicDetail(hash,part,topicId);
    }
    case 'create':{
      const topicOwner=inboxOrThrow();
      const roots=body?.roots===undefined?[]:placementRoots(topicOwner,body.roots);
      const title=text(body?.title,'--title',200),summary=optionalText(body?.summary,'--summary',2000);
      const namedParent=body?.parent_topic_id===undefined?null:text(body.parent_topic_id,'--from',200);
      return agentMutation(actor,actionId(),{kind:'topic-create',title,summary,roots,areaIds:body?.area_ids,parentTopicId:namedParent,reason:reason()},()=>{
        for(const root of roots){const held=topicOfRoot(root);if(held)throw new TopicError(`${root} already belongs to ${held}; use topics place to move it.`,409,'ROOT_PLACED');}
        refuseSharedBugReportThread(roots,null);
        const forwarded=!inbox?db.query(`SELECT source_input_id,thread_root_input_id FROM session_communication_requests
          WHERE target_session_id=? AND target_input_id=? ORDER BY created_at_ms DESC LIMIT 1`).get(actor.sessionId,actor.inputId) as {source_input_id:string|null;thread_root_input_id:string|null}|null:null;
        const sourceRoot=inbox?rootOf(session.id,actor.inputId)??actor.inputId:
          forwarded?.thread_root_input_id??(forwarded?.source_input_id?rootOf(topicOwner.id,forwarded.source_input_id)??forwarded.source_input_id:null);
        const parentTopicId=namedParent??(sourceRoot?topicOfRoot(sourceRoot):null);
        if(parentTopicId)topicRow(parentTopicId);
        const inheritedAreas=parentTopicId?(db.query('SELECT area_id FROM inbox_area_threads WHERE topic_id=? ORDER BY created_at,area_id LIMIT 8').all(parentTopicId) as {area_id:string}[]).map(row=>row.area_id):[];
        const areaIds=checkedAreaIds(body?.area_ids??inheritedAreas);
        const created=createTopic(topicOwner,by,{title,summary,roots,areaIds,reason:reason(),parentTopicId});
        return {change:created.change,result:{topic:created.topic}};
      },topicOwner.id);
    }
    case 'link':case 'unlink':{
      const parentId=text(body?.parent_topic_id,'--into',200);
      const why=text(body?.reason,'--reason');
      return agentMutation(actor,actionId(),{kind:`topic-${verb}`,child:body?.topic_id,parent:parentId,reason:why},()=>{
        const child=topicFor(body?.topic_id),parent=topicRow(parentId);
        if(child.topicId===parent.topicId)throw new TopicError('A thread cannot link to itself.',409,'TOPIC_SELF_LINK');
        const next=bumped(child);
        return {change:{kind:'topic',payload:{change:verb==='link'?'linked':'unlinked',topicId:child.topicId,
          parentTopicId:parent.topicId,topic:next,by,reason:why,revision:next.revision}},result:{topic:next,parentTopicId:parent.topicId}};
      },inboxOrThrow().id);
    }
    case 'place':{
      assertInbox(session);
      const roots=placementRoots(session,body?.roots);
      return agentMutation(actor,actionId(),{kind:'topic-place',topicId:body?.topic_id,roots,reason:reason()},()=>{
        const topic=topicFor(body?.topic_id);
        refuseSharedBugReportThread(roots,topic.topicId);
        const placed=placeChange(session,topic,roots,by,reason());
        return {change:placed.change,result:{topic:placed.topic,roots}};
      });
    }
    case 'route':{
      assertInbox(session);
      const messageId=text(body?.message_id,'--message',500);
      const destination=text(body?.topic_id,'topic id',200);
      return agentMutation(actor,actionId(),{kind:'topic-route',messageId,destination,reason:reason()},actionInputId=>{
        const source=getAcceptedSessionInput(messageId);
        if(!source||!sessionMetadata(getSessionById(source.session_id)!).inbox)
          throw new TopicError('Route one exact accepted Inbox message.',404,'ROUTE_MESSAGE_UNKNOWN');
        const sourceRoot=inboxThreadRoot(source.session_id,messageId);
        const sourceTopicId=sourceRoot?topicOfRoot(sourceRoot):null;
        if(!sourceRoot||!sourceTopicId)throw new TopicError('Place the source conversation before routing its message.',409,'ROUTE_SOURCE_UNPLACED');
        if(sourceTopicId===destination)throw new TopicError('The destination is already this message’s topic.',409,'ROUTE_SAME_TOPIC');
        if(isBugReportInput(messageId))throw new TopicError(BUG_REPORT_OWN_THREAD,409,'BUG_REPORT_OWN_THREAD');
        const topic=topicFor(destination);
        // Match the partial route-source index's predicate exactly. SQLite cannot infer
        // that kind='topic_route' implies its two-kind predicate; that form scanned the
        // full event ledger and held the owner loop for 8.3 seconds in production.
        const prior=(db.query(`SELECT kind,event_id,payload_json FROM session_owner_events
          WHERE kind IN ('topic_route','session_route')
          AND json_extract(payload_json,'$.sourceMessageId')=? ORDER BY sequence DESC`).all(messageId) as {kind:string;event_id:string;payload_json:string}[])
          .find(route=>route.kind==='topic_route'&&topicOfRoot(JSON.parse(route.payload_json).destinationMessageId)===destination);
        if(prior)throw new TopicError(`This message was already routed to this thread as ${prior.event_id}.`,409,'MESSAGE_ALREADY_ROUTED');
        const destinationMessageId=`topic-change:${actionInputId}`;
        const by=byOf(actor),at=nowIso(),next=bumped(topic);
        const payload={change:'routed',topicId:destination,topic:next,destinationSessionId:`concierge:${session.id}`,sourceMessageId:messageId,
          sourceRoot,sourceTopicId,destinationMessageId,by,reason:reason(),revision:next.revision,
          roots:rootRecords(destination,[destinationMessageId],by,reason())};
        return {change:{kind:'topic_route',payload},result:{route:{sourceMessageId:messageId,sourceRoot,sourceTopicId,
          destinationMessageId,destinationTopicId:destination}}};
      });
    }
    case 'rename':{
      assertInbox(session);
      const title=text(body?.title,'title',200),why=text(body?.reason,'--reason');
      return agentMutation(actor,actionId(),{kind:'topic-rename',topicId:body?.topic_id,title,reason:why},()=>{
        const topic=topicFor(body?.topic_id);
        if(lastRenameBy(topic)?.kind==='human'&&!why.toLowerCase().includes('human-approved'))
          throw new TopicError('Tejas named this thread; an automatic rename needs his approval.',409,'TOPIC_TITLE_HUMAN');
        const next=bumped(topic,{title,aliases:[...new Set([...topic.aliases,topic.title])]});
        return {change:{kind:'topic',payload:{change:'renamed',topicId:topic.topicId,topic:next,title,previousTitle:topic.title,
          aliases:next.aliases,by,reason:why,revision:next.revision}},result:{topic:next}};
      });
    }
    case 'summary':{
      assertInbox(session);
      const summary=text(body?.summary,'summary',2000);
      return agentMutation(actor,actionId(),{kind:'topic-summary',topicId:body?.topic_id,summary},()=>{
        const topic=topicFor(body?.topic_id);
        const next=bumped(topic,{summary});
        return {change:{kind:'topic',payload:{change:'summary',topicId:topic.topicId,topic:next,summary,by,revision:next.revision}},result:{topic:next}};
      });
    }
    case 'merge':{
      assertInbox(session);
      const why=text(body?.reason,'--reason');
      return agentMutation(actor,actionId(),{kind:'topic-merge',from:body?.topic_id,into:body?.into,reason:why},()=>{
        const from=topicFor(body?.topic_id),into=topicRow(text(body?.into,'--into',200));
        if(from.topicId===into.topicId)throw new TopicError('A topic cannot be merged into itself.');
        if(topicRoots(from.topicId).some(isBugReportInput))throw new TopicError(BUG_REPORT_OWN_THREAD,409,'BUG_REPORT_OWN_THREAD');
        const merged=mergeChange(from,into,by,why);
        return {change:merged.change,result:{topic:merged.destination,merged:merged.source}};
      });
    }
    case 'close':{
      assertInbox(session);
      const scope=text(body?.scope,'--scope',2000),why=text(body?.reason,'reason');
      return agentMutation(actor,actionId(),{kind:'topic-close',topicId:body?.topic_id,scope,reason:why},()=>{
        const topic=topicFor(body?.topic_id);
        const openRequests=topicRequests(topic.topicId).filter(request=>request.state==='open');
        if(openRequests.length)throw new TopicError(`This thread still owns ${openRequests.length} open request(s); finish or replace their work before closing it.`,409,'TOPIC_REQUESTS_OPEN');
        const at=nowIso();
        // Closing the thread ends every question still open in it, each recorded with the
        // closure's reason: a closed thread is no place for something that waits on him (six
        // sat invisibly in one on 2026-09-23).
        const questions=expireOpen(topicQuestions(topic.topicId),`Thread closed: ${why}`,at);
        const next=bumped(topic,{state:'closed',closure:{by,at,reason:why,scope,requests:topicRequests(topic.topicId).map(request=>request.requestId)}});
        return {change:{kind:'topic',payload:{change:'closed',topicId:topic.topicId,topic:next,scope,by,reason:why,revision:next.revision,questions}},result:{topic:next,expired:questions.length}};
      });
    }
    case 'reopen':{
      assertInbox(session);
      const why=text(body?.reason,'reason');
      return agentMutation(actor,actionId(),{kind:'topic-reopen',topicId:body?.topic_id,reason:why},()=>{
        const topic=topicFor(body?.topic_id);
        const questions=restoreExpiredByClosure(topic,nowIso());
        const next=bumped(topic,{state:'open',closure:null,setAside:null});
        return {change:{kind:'topic',payload:{change:'reopened',topicId:topic.topicId,topic:next,by,reason:why,revision:next.revision,questions}},result:{topic:next,restored:questions.length}};
      });
    }
    case 'pin':case 'unpin':{
      return agentMutation(actor,actionId(),{kind:`topic-${verb}`,topicId:body?.topic_id,reason:reason()},()=>{
        const topic=topicFor(body?.topic_id);
        const next=bumped(topic,{pinnedAt:verb==='pin'?topic.pinnedAt??nowIso():null});
        return {change:{kind:'topic',payload:{change:verb==='pin'?'pinned':'unpinned',topicId:topic.topicId,topic:next,by,reason:reason(),revision:next.revision}},result:{topic:next}};
      },inboxOrThrow().id);
    }
    case 'request.add':{
      assertInbox(session);
      const title=text(body?.title,'--title',200),brief=text(body?.brief,'brief',8000),sources=parseSources(body?.sources);
      const added=agentMutation(actor,actionId(),{kind:'topic-request-add',topicId:body?.topic_id,title,brief,sources},()=>{
        const topic=topicFor(body?.topic_id);
        const at=nowIso();
        const request:StoredRequest={requestId:`req:${randomUUID()}`,topicId:topic.topicId,title,brief,state:'open',disposition:null,
          revision:1,sources,dispatches:[],closure:null,createdAt:at,updatedAt:at};
        const next=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'added',topicId:topic.topicId,topic:next,request,by,revision:next.revision}},result:{request}};
      });
      // Drift is noticed the moment it happens: the request that made the title stop fitting.
      const drift=added.duplicate?null:titleDrift(added.request.topicId);
      return drift?{...added,titleDrift:{...drift,instruction:titleDriftInstruction(drift)}}:added;
    }
    case 'request.amend':{
      assertInbox(session);
      const why=text(body?.reason,'what changed and why',4000);
      const title=optionalText(body?.title,'--title',200),sources=body?.sources===undefined?null:parseSources(body.sources);
      return agentMutation(actor,actionId(),{kind:'topic-request-amend',requestId:body?.request_id,title,sources,reason:why},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        const next={...request,title:title??request.title,sources:sources??request.sources,revision:request.revision+1,updatedAt:nowIso()};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'amended',topicId:topic.topicId,topic:topicNext,request:next,by,reason:why,revision:topicNext.revision}},result:{request:next}};
      });
    }
    case 'request.link':{
      assertInbox(session);
      const dispatchId=text(body?.dispatch,'--dispatch',200);
      const linked=agentMutation(actor,actionId(),{kind:'topic-request-link',requestId:body?.request_id,dispatch:dispatchId},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        const local=db.query('SELECT target_session_id,outcome,status FROM session_communication_requests WHERE request_id=?').get(dispatchId) as any;
        const peer=local?null:db.query('SELECT peer,remote_session_id,outcome,status FROM session_peer_requests WHERE request_id=?').get(dispatchId) as any;
        if(!local&&!peer)throw new TopicError('That dispatch is not a request this owner sent.',404,'DISPATCH_UNKNOWN');
        const ownTopic=dispatchHomeTopic(dispatchId);
        if(!ownTopic)throw new TopicError('Place the dispatch in an Inbox thread before linking its work. Nothing was linked.',409,'DISPATCH_TOPIC_MISSING');
        const dispatch={requestId:dispatchId,targetSessionId:local?`concierge:${local.target_session_id}`:receiveSessionFromPeer(peer.remote_session_id,peer.peer),
          targetTitle:local?(getSessionById(local.target_session_id)&&sessionMetadata(getSessionById(local.target_session_id)!).title)??null:null,
          outcome:(local??peer).outcome??null,state:(local??peer).status??null,
          ...(ownTopic!==topic.topicId?{sharedAcrossTopic:true}:{})};
        const dispatches=[...request.dispatches.filter((existing:any)=>existing.requestId!==dispatchId),dispatch]
          .sort((left:any,right:any)=>(workRow(left.requestId)?.createdAtMs??0)-(workRow(right.requestId)?.createdAtMs??0)
            ||String(left.requestId).localeCompare(String(right.requestId)));
        const next={...request,dispatches,revision:request.revision+1,updatedAt:nowIso()};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'linked',topicId:topic.topicId,topic:topicNext,request:next,by,revision:topicNext.revision}},result:{request:next}};
      });
      try{reconcilePlacedRequestAnswers(dispatchId);}catch(error){log('error','inbox_request_answer_reconciliation_failed',{
        request_id:dispatchId,message:error instanceof Error?error.message:String(error)});}
      return linked;
    }
    case 'request.close':{
      assertInbox(session);
      const disposition=String(body?.disposition??'');
      if(!DISPOSITIONS.includes(disposition))throw new TopicError(`--disposition must be one of ${DISPOSITIONS.join(', ')}.`);
      const why=text(body?.reason,'reason',4000),evidence=idList(body?.evidence,'--evidence');
      const humanQuote=typeof body?.human_quote==='string'?body.human_quote.trim():'';
      return agentMutation(actor,actionId(),{kind:'topic-request-close',requestId:body?.request_id,disposition,evidence,humanQuote,reason:why},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        if(request.state!=='open')throw new TopicError('This request is already closed. Reopen it before changing its disposition.',409,'REQUEST_ALREADY_CLOSED');
        if(disposition==='failed')throw new TopicError('An agent failure cannot close the underlying request. Send the remaining work onward.',409,'REQUEST_RECOVERY_REQUIRED');
        // A routed copy and its original both resolve to the exact human input in this topic.
        const laterHumanInstruction=evidence.some(id=>{
          const source=resolveAskedSource(id,topic)?.source;
          return !!source&&new Date(iso(source.created_at)!).getTime()>=new Date(iso(request.createdAt)!).getTime();
        });
        const withdrawalEvidence=evidence.some(id=>{
          const input=resolveAskedSource(id,topic)?.source;
          if(!input||new Date(iso(input.created_at)!).getTime()<new Date(iso(request.createdAt)!).getTime()||humanQuote.length<4)return false;
          let words='',replyTo:unknown;
          try{const payload=JSON.parse(input.payload_json);words=typeof payload.text==='string'?payload.text:'';replyTo=payload.replyToMessage?.messageId;}
          catch{return false;}
          if(!words.includes(humanQuote))return false;
          if(/\b(?:don['’]t|do not)\s+(?:stop|cancel|withdraw|drop)\b|\b(?:keep working|continue working|please finish|still broken)\b/i.test(humanQuote))return false;
          const post=typeof replyTo==='string'&&replyTo.startsWith('post:forward:')
            ?db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(replyTo) as {payload_json:string}|null:null;
          const answeredDispatch=post?JSON.parse(post.payload_json).requestId:null;
          const requestScoped=typeof answeredDispatch==='string'&&request.dispatches.some(dispatch=>dispatch.requestId===answeredDispatch);
          const answersRequestQuestion=typeof replyTo==='string'&&questionsOfRequest(request.topicId,request)
            .some(question=>question.sources.includes(replyTo));
          const onlyOpenRequest=topicRequests(request.topicId).filter(candidate=>candidate.state==='open').length===1;
          const titleWords=request.title.toLowerCase().split(/[^a-z0-9]+/).filter(word=>word.length>=5);
          const namesRequest=titleWords.length>=2&&titleWords.filter(word=>humanQuote.toLowerCase().includes(word)).length>=2;
          return requestScoped||answersRequestQuestion||onlyOpenRequest||namesRequest;
        });
        if(['declined','withdrawn'].includes(disposition)&&humanRequest(topic,request)&&!withdrawalEvidence)
          throw new TopicError('Withdrawing his request needs his exact withdrawal words and a later human message tied to this request. His Close control also withdraws its named requests.',409,'REQUEST_HUMAN_WITHDRAWAL_REQUIRED');
        if(disposition==='superseded'&&humanRequest(topic,request))
          throw new TopicError('A shared message or successor title cannot transfer his unfinished obligation. Keep this request open and link checked work to it.',409,'REQUEST_TRANSFER_REQUIRED');
        if(disposition==='superseded'&&!evidence.some(id=>{
          const replacementRow=db.query('SELECT * FROM inbox_requests WHERE request_id=? AND request_id<>?')
            .get(id,request.requestId) as any|null;
          if(!replacementRow)return false;
          const replacement=toStoredRequest(replacementRow);
          const sources=new Set(request.sources.map(source=>source.inputId));
          const sameSource=replacement.sources.some(source=>sources.has(source.inputId));
          return (replacement.state==='open'||replacement.disposition==='completed')&&(sameSource||laterHumanInstruction);
        }))throw new TopicError('A superseded request needs a live or completed replacement carrying the same source, or Tejas’s later instruction in this thread.',409,'REQUEST_REPLACEMENT_REQUIRED');
        if(disposition==='superseded'&&questionsOfRequest(topic.topicId,request)
          .some(question=>question.kind==='decision'&&OPEN_QUESTION_STATES.includes(question.state)))
          throw new TopicError('This request still has a live question for Tejas. Explicitly carry that question into the replacement or settle it with a proven replacement question before closing.',409,'REQUEST_QUESTION_OPEN');
        if(disposition==='completed')refuseUnfinishedCompletion(topic,request,evidence);
        const at=nowIso();
        const next={...request,state:'closed' as const,disposition,closure:{by,at,reason:why,evidence,...(['withdrawn','declined'].includes(disposition)&&humanQuote?{humanQuote}:{})},revision:request.revision+1,updatedAt:at};
        // Only the questions linked to this exact request end with it.
        const questions=expireOpen(questionsOfRequest(topic.topicId,request),`The request it was for closed (${disposition}): ${why}`,at);
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'request_closed',topicId:topic.topicId,topic:topicNext,request:next,by,reason:why,revision:topicNext.revision,questions}},result:{request:next,expired:questions.length}};
      });
    }
    case 'request.reopen':{
      assertInbox(session);
      const why=text(body?.reason,'reason',4000);
      return agentMutation(actor,actionId(),{kind:'topic-request-reopen',requestId:body?.request_id,reason:why},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        const at=nowIso();
        const next={...request,state:'open' as const,disposition:null,closure:null,
          completionFloor:request.dispatches.length,reopenedAt:at,revision:request.revision+1,updatedAt:at};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'request_reopened',topicId:topic.topicId,topic:topicNext,request:next,by,reason:why,revision:topicNext.revision}},result:{request:next}};
      });
    }
    case 'questions':{
      guard(String(body?.topic_id??''));
      const declarations=body?.questions;
      return agentMutation(actor,actionId(),{kind:'topic-questions',topicId:body?.topic_id,questions:declarations},()=>{
        const topic=topicFor(body?.topic_id);
        const reconciled=reconcileQuestions(session,topic,declarations,by,optionalText(body?.reason,'--reason'));
        return {change:reconciled.change,result:{questions:reconciled.questions}};
      });
    }
    case 'question.settle':{
      assertInbox(session);
      const state=String(body?.state??'');
      if(!['answered','declined','withdrawn','superseded','deferred'].includes(state))throw new TopicError('--state must settle the question.');
      const why=text(body?.reason,'reason',4000);
      return agentMutation(actor,actionId(),{kind:'topic-question-settle',questionId:body?.question_id,state,
        answer:body?.answer??null,replacement:body?.replacement??null,reason:why},()=>{
        const question=questionRow(text(body?.question_id,'question id',200));
        const topic=topicFor(question.topicId);
        const at=nowIso();
        const answerInput=body?.answer?getAcceptedSessionInput(String(body.answer)):null;
        if(body?.answer&&!answerInput)throw new TopicError('--answer must name one accepted input.',404,'ANSWER_UNKNOWN');
        const written:StoredQuestion[]=[];
        const next:StoredQuestion={...question,state:state as QuestionState,updatedAt:at,
          replacedBy:typeof body?.replacement==='string'?body.replacement:question.replacedBy,
          answer:answerInput?{inputId:answerInput.id,at,passage:null,interpretation:why,answeredRevision:question.revision}:question.answer};
        written.push(next);
        if(state==='superseded'&&typeof body?.replacement==='string') {
          const replacement=questionRow(body.replacement);
          if(replacement.topicId!==topic.topicId)throw new TopicError('A replacement must live in the same topic.',409,'QUESTION_TOPIC_MISMATCH');
          written.push({...replacement,replaces:question.questionId,updatedAt:at});
        }
        const topicNext=bumped(topic);
        clearSettledLegacyNeeds(session,written);
        return {change:{kind:'topic_question',payload:{change:'settled',topicId:topic.topicId,topic:topicNext,questions:written,by,reason:why,revision:topicNext.revision}},
          result:{questions:written}};
      });
    }
    case 'answer':{
      assertInbox(session);
      const inputId=text(body?.input_id,'input id',200);
      return agentMutation(actor,actionId(),{kind:'topic-answer',inputId,answer:body?.answer},()=>{
        const input=getAcceptedSessionInput(inputId);
        if(!input||input.session_id!==session.id||input.origin!=='human')throw new TopicError('An answer belongs to one of this Inbox\'s accepted human inputs.',404,'ANSWER_INPUT_UNKNOWN');
        const recorded=recordAnswer(session,input,body?.answer,by);
        clearSettledLegacyNeeds(session,recorded.questions);
        return {change:recorded.change,result:{questions:recorded.questions,mappings:(recorded.change.payload as any).mappings}};
      });
    }
    case 'acknowledge':{
      assertInbox(session);
      const items=idList(body?.items,'--item');
      if(!items.length)throw new TopicError('--item names what he said he read.');
      const source=text(body?.source_input,'--source',200);
      return agentMutation(actor,actionId(),{kind:'topic-acknowledge',topicId:body?.topic_id,items,source},()=>{
        const topic=topicFor(body?.topic_id);
        const at=nowIso();
        const read:StoredQuestion[]=[];
        const reading=items.map(itemId=>{
          const question=db.query('SELECT topic_id,revision,kind,state FROM inbox_questions WHERE question_id=?').get(itemId) as {topic_id:string;revision:number;kind:string;state:string}|null;
          if(question&&question.topic_id!==topic.topicId)throw new TopicError('That question is in another topic.',409,'QUESTION_TOPIC_MISMATCH');
          // He said he read it, through the router: a reading item's own end.
          if(question?.kind==='reading'&&OPEN_QUESTION_STATES.includes(question.state))read.push({...questionRow(itemId),state:'read',updatedAt:at});
          return {topicId:topic.topicId,itemId,revision:question?.revision??0,kind:'acknowledged' as const,at,by:{...by,sourceInputId:source}};
        });
        const next=bumped(topic);
        return {change:{kind:'topic_reading',payload:{change:'acknowledged',topicId:topic.topicId,topic:next,reading,items,source,by,revision:next.revision,
          ...(read.length?{questions:read,reason:'He said he read it'}:{})}},
          result:{acknowledged:items,read:read.map(question=>question.questionId)}};
      });
    }
    case 'file':{
      assertInbox(session);
      const eventId=text(body?.need,'--need',200);
      return agentMutation(actor,actionId(),{kind:'topic-file',topicId:body?.topic_id,need:eventId},()=>{
        const topic=topicFor(body?.topic_id);
        const question=fileNeed(session,topic,eventId,by);
        const next=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:'filed',topicId:topic.topicId,topic:next,questions:[question],by,reason:reason(),revision:next.revision}},
          result:{question}};
      });
    }
    case 'focus':{
      assertInbox(session);
      const summary=text(body?.summary,'what the router is doing',2000);
      const inputs=idList(body?.inputs,'--input');
      return agentMutation(actor,actionId(),{kind:'topic-focus',topicId:body?.topic_id,inputs,summary},()=>{
        const topic=topicFor(body?.topic_id);
        return {change:{kind:'topic_focus',payload:{change:'focus',sessionId:session.id,topicId:topic.topicId,
          inputIds:inputs.length?inputs:[actor.inputId],runId:actor.runId,summary,since:nowIso(),by,revision:topic.revision}},
          result:{focus:{topicId:topic.topicId,inputIds:inputs.length?inputs:[actor.inputId],runId:actor.runId,summary}}};
      });
    }
    case 'release':{
      assertInbox(session);
      const inputs=idList(body?.inputs,'--input');
      return agentMutation(actor,actionId(),{kind:'topic-release',inputs},()=>({
        change:releaseFocusChange(session.id,inputs,by),result:{released:true}}));
    }
    default:throw new TopicError(`Unknown topics command: ${verb||'(none)'}.`);
  }
}

/* ------------------------------------------------------------------ focus lifecycle */

function releaseFocusChange(sessionId:number,inputs:string[],by:TopicBy):Change {
  const row=db.query('SELECT * FROM inbox_focus WHERE session_id=?').get(sessionId) as any;
  const held:string[]=row?.input_ids_json?JSON.parse(row.input_ids_json):[];
  const remaining=inputs.length?held.filter(inputId=>!inputs.includes(inputId)):[];
  const keep=inputs.length&&remaining.length;
  return {kind:'topic_focus',payload:keep
    ?{change:'focus',sessionId,topicId:row.topic_id,inputIds:remaining,runId:row.run_id,summary:row.summary,since:row.since,by,released:inputs}
    :{change:'release',sessionId,topicId:null,inputIds:[],runId:null,summary:null,since:null,by,released:inputs.length?inputs:held}};
}

/**
 * A deliberate reply ends the router's declared work on the inputs it covers, unless it
 * said it keeps working. Called from `sessions post`; `--keep-working` skips it.
 */
export function releaseFocusForPost(session:SessionRow,rootInputId:string,topicId?:string|null) {
  const placed=topicOfRoot(rootInputId);
  if(topicId&&placed&&placed!==topicId)throw new TopicError(`That thread belongs to ${placed}, not ${topicId}.`,409,'TOPIC_MISMATCH');
  if(topicId&&!placed)throw new TopicError('That thread is not in a topic yet; place it before posting to one.',409,'ROOT_UNPLACED');
  const effective=topicId??placed;
  if(!effective)return null;
  const row=db.query('SELECT * FROM inbox_focus WHERE session_id=?').get(session.id) as any;
  if(!row?.topic_id||row.topic_id!==effective)return null;
  refreshRootMemo();
  const held:string[]=JSON.parse(row.input_ids_json);
  const covered=held.filter(inputId=>rootOf(session.id,inputId)===rootInputId);
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  const change=releaseFocusChange(session.id,covered.length?covered:held,by);
  recordSessionEvent({eventId:`topic-release:post:${row.run_id??'none'}:${rootInputId}`,sessionId:session.id,kind:change.kind,payload:change.payload});
  applyTopicChange(change.kind,change.payload);
  return {topicId:effective};
}

/** A run that ended, errored, was stopped or lost its binding is not working on a topic. */
export function clearFocusForEndedRun(turn:{id:number;session_id:number}) {
  const row=db.query('SELECT * FROM inbox_focus WHERE session_id=?').get(turn.session_id) as any;
  if(!row?.topic_id||!row.run_id)return;
  const run=db.query('SELECT native_run_id FROM turns WHERE id=?').get(turn.id) as {native_run_id:string|null}|null;
  if(!run?.native_run_id||run.native_run_id!==row.run_id)return;
  const payload={change:'release',sessionId:turn.session_id,topicId:null,inputIds:[],runId:null,summary:null,since:null,
    by:{kind:'owner' as const,sessionId:`concierge:${turn.session_id}`},released:JSON.parse(row.input_ids_json),reason:'run_ended'};
  recordSessionEvent({eventId:`topic-release:run:${row.run_id}`,sessionId:turn.session_id,turnId:turn.id,kind:'topic_focus',payload});
  applyTopicChange('topic_focus',payload);
}

/* ------------------------------------------------------------------ human actions */

const HUMAN_ACTIONS=['rename','summary','close','reopen','pin','unpin','set_aside','resume','move','split','merge','read','expose','question','request','file','followup'];

export function createTopicByHuman(body:any) {
  const session=inboxOrThrow();
  const title=text(body?.title,'title',200);
  const roots=placementRoots(session,body?.roots);
  const areaIds=checkedAreaIds(body?.areaIds);
  const by:TopicBy={kind:'human'};
  return humanMutation(session.id,body?.clientActionId,{kind:'topic-create',title,roots,areaIds},()=>{
    for(const root of roots){const held=topicOfRoot(root);if(held)throw new TopicError(`${root} already belongs to ${held}.`,409,'ROOT_PLACED');}
    const created=createTopic(session,by,{title,roots,areaIds});
    return {change:created.change,result:{topic:created.topic}};
  });
}

export function topicHumanAction(topicId:string,body:any) {
  const session=inboxOrThrow();
  const action=body?.action;
  if(!action||typeof action!=='object')throw new TopicError('An exact topic action is required.');
  const kind=String(action.kind??'');
  if(!HUMAN_ACTIONS.includes(kind))throw new TopicError('Unknown topic action.');
  const by:TopicBy={kind:'human'};
  return humanMutation(session.id,body?.clientActionId,{kind:`topic-${kind}`,topicId,action},()=>{
    const topic=topicRow(topicId);
    const at=nowIso();
    switch(kind) {
      case 'followup':{
        const question=questionRow(text(action.questionId,'questionId',200));
        if(question.topicId!==topicId||question.kind!=='asked')throw new TopicError('That question is not in this thread.',409,'QUESTION_TOPIC_MISMATCH');
        const inputId=text(action.inputId,'inputId',200);
        const input=getAcceptedSessionInput(inputId);
        const repliedTo=input?JSON.parse(input.payload_json)?.replyToMessage?.messageId:null;
        if(!input||input.session_id!==session.id||!humanAuthored(input)||!sourcesMatch(question.sources,repliedTo))
          throw new TopicError('The follow-up must be your accepted reply in this thread.',409,'FOLLOWUP_SOURCE_MISMATCH');
        const written:StoredQuestion={...question,sources:[...new Set([...question.sources,inputId])],revision:question.sources.includes(inputId)?question.revision:question.revision+1,updatedAt:at};
        const next=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:'followup',topicId,topic:next,questions:[written],by,revision:next.revision}},result:{question:written}};
      }
      case 'rename':{
        const title=text(action.title,'title',200);
        const next=bumped(topic,{title,aliases:[...new Set([...topic.aliases,topic.title])]});
        return {change:{kind:'topic',payload:{change:'renamed',topicId,topic:next,title,previousTitle:topic.title,aliases:next.aliases,by,revision:next.revision}},result:{topic:next}};
      }
      case 'summary':{
        const summary=text(action.summary,'summary',2000);
        const next=bumped(topic,{summary});
        return {change:{kind:'topic',payload:{change:'summary',topicId,topic:next,summary,by,revision:next.revision}},result:{topic:next}};
      }
      case 'close':{
        const why=text(action.reason,'reason',4000),scope=optionalText(action.scope,'scope',2000);
        const questions=expireOpen(topicQuestions(topicId),`Thread closed: ${why}`,at);
        const owned=topicRequests(topicId);
        const requests=owned.filter(request=>request.state==='open').map(request=>({...request,state:'closed' as const,disposition:'withdrawn',
          closure:{by,at,reason:`Thread closed by Tejas: ${why}`,evidence:[String(body.clientActionId??'')]},revision:request.revision+1,updatedAt:at}));
        const next=bumped(topic,{state:'closed',closure:{by,at,reason:why,scope,requests:owned.map(request=>request.requestId)}});
        return {change:{kind:'topic',payload:{change:'closed',topicId,topic:next,scope,by,reason:why,revision:next.revision,questions,requests}},
          result:{topic:next,expired:questions.length,withdrawn:requests.length}};
      }
      case 'file':{
        const filed=fileNeed(session,topic,text(action.need,'need',200),by);
        const next=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:'filed',topicId,topic:next,questions:[filed],by,reason:'filed by Tejas',revision:next.revision}},result:{question:filed}};
      }
      case 'reopen':{
        const why=text(action.reason,'reason',4000);
        const questions=restoreExpiredByClosure(topic,at);
        const requests=topic.closure?.by?.kind==='human'?topicRequests(topicId)
          .filter(request=>request.state==='closed'&&request.disposition==='withdrawn'&&request.closure?.at===topic.closure?.at
            &&request.closure?.by?.kind==='human'&&String(request.closure?.reason??'').startsWith('Thread closed by Tejas:'))
          .map(request=>({...request,state:'open' as const,disposition:null,closure:null,
            completionFloor:request.dispatches.length,reopenedAt:at,revision:request.revision+1,updatedAt:at})):[];
        const next=bumped(topic,{state:'open',closure:null,setAside:null});
        return {change:{kind:'topic',payload:{change:'reopened',topicId,topic:next,by,reason:why,revision:next.revision,questions,requests}},
          result:{topic:next,restored:questions.length,requests:requests.length}};
      }
      case 'pin':case 'unpin':{
        const next=bumped(topic,{pinnedAt:kind==='pin'?topic.pinnedAt??at:null});
        return {change:{kind:'topic',payload:{change:kind==='pin'?'pinned':'unpinned',topicId,topic:next,by,revision:next.revision}},result:{topic:next}};
      }
      case 'set_aside':{
        const why=text(action.reason,'reason',4000);
        const next=bumped(topic,{setAside:{reason:why,returnCondition:optionalText(action.returnCondition,'returnCondition',2000),at}});
        return {change:{kind:'topic',payload:{change:'set_aside',topicId,topic:next,by,reason:why,revision:next.revision}},result:{topic:next}};
      }
      case 'resume':{
        const next=bumped(topic,{setAside:null});
        return {change:{kind:'topic',payload:{change:'resumed',topicId,topic:next,by,revision:next.revision}},result:{topic:next}};
      }
      case 'move':{
        const roots=placementRoots(session,action.roots);
        const into=topicRow(text(action.into,'into',200));
        const placed=placeChange(session,into,roots,by,'moved by Tejas');
        return {change:placed.change,result:{topic:placed.topic,roots}};
      }
      case 'split':{
        const roots=placementRoots(session,action.roots);
        const areaIds=(db.query('SELECT area_id FROM inbox_area_threads WHERE topic_id=?').all(topicId) as {area_id:string}[]).map(row=>row.area_id);
        const created=createTopic(session,by,{title:text(action.title,'title',200),roots,splitFrom:topicId,areaIds});
        return {change:created.change,result:{topic:created.topic}};
      }
      case 'merge':{
        const into=topicRow(text(action.into,'into',200));
        if(into.topicId===topicId)throw new TopicError('A topic cannot be merged into itself.');
        const merged=mergeChange(topic,into,by,'merged by Tejas');
        return {change:merged.change,result:{topic:merged.destination,merged:merged.source}};
      }
      case 'read':{
        const sequence=Number(action.sequence);
        if(!Number.isSafeInteger(sequence)||sequence<0)throw new TopicError('Exact observed entry sequence required.');
        if(sequence>topic.readSequence){
          // The screen sends the exact event it displayed. Validate that one event against
          // its current thread placement instead of rebuilding every thread summary while
          // holding the owner's write transaction.
          const row=db.query(`${inboxRows} AND event.sequence=?`).get(sequence) as any|null;
          const messageId=row?inboxMessageId(row):null;
          const root=messageId?rootOf(row.session_id,messageId):null;
          if(!root||!db.query('SELECT 1 FROM inbox_topic_roots WHERE topic_id=? AND root_input_id=?').get(topicId,root))
            throw new TopicError('This thread changed; read it again before marking it read.',409,'TOPIC_READ_SEQUENCE_STALE');
        }
        const readSequence=Math.max(topic.readSequence,sequence);
        const next={...topic,readSequence,updatedAt:topic.updatedAt};
        return {change:{kind:'topic_reading',payload:{change:'read',topicId,topic:next,sequence:readSequence,by,revision:topic.revision}},result:{readSequence}};
      }
      case 'expose':{
        if(!Array.isArray(action.items)||!action.items.length)throw new TopicError('Name the items actually shown.');
        const reading=action.items.map((item:any)=>({topicId,itemId:text(item?.id,'item id',500),
          revision:Number.isSafeInteger(Number(item?.revision))?Number(item.revision):0,kind:'exposed' as const,at,by}));
        return {change:{kind:'topic_reading',payload:{change:'exposed',topicId,reading,by,revision:topic.revision}},result:{exposed:reading.length}};
      }
      case 'question':{
        const state=String(action.state??'');
        if(!['deferred','withdrawn','read','open'].includes(state))throw new TopicError('He can defer, withdraw, mark a reading item read, or bring a deferred question back.');
        const question=questionRow(text(action.questionId,'questionId',200));
        if(question.topicId!==topicId)throw new TopicError('That question is in another topic.',409,'QUESTION_TOPIC_MISMATCH');
        if(state==='read'&&question.kind!=='reading')throw new TopicError('Only a reading item ends by being read; a decision needs an answer.',409,'QUESTION_NOT_READING');
        if(state==='open'&&question.state!=='deferred')throw new TopicError('Only a question set aside can be brought back.',409,'QUESTION_NOT_DEFERRED');
        // "Remind me later": set aside until a moment, after which the sweep brings it back with a
        // notification (Tejas, 2026-10-07: "I want to just like be reminded later so I can finish
        // this process"). Set aside with no moment stays as before: findable, never returning.
        const until=state==='deferred'?deferUntilFrom(action.until,at):null;
        const why=state==='read'?'Read':state==='open'?(optionalText(action.reason,'reason',4000)??'Brought back'):text(action.reason,'reason',4000);
        const next={...question,state:state as QuestionState,updatedAt:at,deferUntil:until};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:state==='open'?'returned':'settled',topicId,topic:topicNext,questions:[next],by,reason:why,revision:topicNext.revision}},
          result:{question:next}};
      }
      case 'request':{
        const disposition=String(action.disposition??'');
        if(!['withdrawn','completed'].includes(disposition))throw new TopicError('He can withdraw or complete a request.');
        const request=requestRow(text(action.requestId,'requestId',200));
        if(request.topicId!==topicId)throw new TopicError('That request is in another topic.',409,'REQUEST_TOPIC_MISMATCH');
        const why=text(action.reason,'reason',4000);
        const next={...request,state:'closed' as const,disposition,closure:{by,at,reason:why,evidence:[]},revision:request.revision+1,updatedAt:at};
        const questions=expireOpen(questionsOfRequest(topicId,request),`The request it was for closed (${disposition}): ${why}`,at);
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'request_closed',topicId,topic:topicNext,request:next,by,reason:why,revision:topicNext.revision,questions}},
          result:{request:next}};
      }
      default:throw new TopicError('Unknown topic action.');
    }
  });
}

/* ------------------------------------------------------------------ remind me later */

/** At most this far ahead a question can be set aside for; a reminder further out is a calendar entry, not a snooze. */
const DEFER_AT_MOST_MS=90*24*60*60_000;
/** The moment a question set aside comes back, from his action: absent means set aside with no return. */
function deferUntilFrom(value:unknown,at:string):string|null {
  if(value===undefined||value===null)return null;
  if(typeof value!=='string')throw new TopicError('until must be an exact moment (ISO 8601).');
  const ms=Date.parse(value);
  if(!Number.isFinite(ms))throw new TopicError('until must be an exact moment (ISO 8601).');
  const now=Date.parse(at);
  if(ms<=now)throw new TopicError('until must be in the future.',409,'DEFER_UNTIL_PAST');
  if(ms-now>DEFER_AT_MOST_MS)throw new TopicError('until is more than 90 days away.',409,'DEFER_UNTIL_TOO_FAR');
  return new Date(ms).toISOString();
}
const conciergeSessionNumber=(address:unknown):number|null=>{
  const match=typeof address==='string'?/^concierge:(\d+)$/.exec(address):null;
  return match?Number(match[1]):null;
};

/**
 * Brings back every question whose "set aside until" has passed, so a reminder is a real event
 * and not a check he has to remember to make. Each one: back to open (the same `topic_question`
 * change path a settle takes, so the thread, the Needs-you count and the Questions tab all move
 * together), one `needs_you` event on the Inbox session shaped exactly like a new question's, so
 * the notifier sends the same notification a new question would and the tap opens that thread,
 * and a service notice to the session that asked the question (the Inbox router for most), naming
 * the thread, so it can refresh anything in the question that expires (a one-time form link)
 * before he opens it. The
 * notice is admitted as a service input: no new authority, no reply owed. Runs on the owner's
 * reading cadence (every three minutes), so a reminder lands within that of its time.
 */
/**
 * A question that names the to-do it asks him to do ends when he ticks that to-do off (or drops it):
 * his tick is his answer, so the question leaves Needs you and the agent that asked is told to carry
 * on. Runs on the owner's reading cadence; one read of his to-dos covers every linked question.
 */
export async function closeQuestionsAnsweredByTodos(admit?:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string})=>unknown,
  scope:'all'|'inbox'|number='all'):Promise<number> {
  const session=inboxSession();
  if(!session)return 0;
  const linked:{question_id:string}[]=[];
  let after='';
  while(typeof scope!=='number'){
    const page=db.query(`SELECT question_id FROM inbox_questions WHERE question_id>? AND state IN ('open','partial') AND kind='decision'
      AND (json_extract(owner_json,'$.todoId') IS NOT NULL OR coalesce(json_extract(brief_json,'$.todo'),'none')<>'none')
      ORDER BY question_id LIMIT 200`).all(after) as {question_id:string}[];
    linked.push(...page);
    if(page.length<200)break;
    after=page.at(-1)!.question_id;
  }
  const target=typeof scope==='number'?getSessionById(scope):null;
  const direct:{id:number}[]=target&&(sessionMetadata(target).needs??[]).some(need=>need.outcome==='needs_you'&&!!need.todoId)
    ?[{id:target.id}]:[];
  let afterSession=0;
  while(scope==='all'){
    const page=db.query(`SELECT id FROM sessions WHERE id>? AND native_metadata_json LIKE '%"todoId"%'
      ORDER BY id LIMIT 200`).all(afterSession) as {id:number}[];
    direct.push(...page);
    if(page.length<200)break;
    afterSession=page.at(-1)!.id;
  }
  if(!linked.length&&!direct.length)return 0;
  let todos:Map<string,TodoState>;
  try{todos=new Map((await readTodos()).map(todo=>[todo.id,todo]));}
  catch(error){log('warn','question_todo_check_unavailable',{questions:linked.length,direct:direct.length,reason:error instanceof Error?error.message.slice(0,80):'failed'});return 0;}
  let closed=0;
  for(const {question_id} of linked) {
    try {
      // Re-read after the wait: the question may have been answered or withdrawn meanwhile.
      const row=db.query('SELECT * FROM inbox_questions WHERE question_id=?').get(question_id) as any;
      if(!row)continue;
      const question=toStoredQuestion(row);
      const todo=todos.get(linkedTodoId(question)??'');
      if(!OPEN_QUESTION_STATES.some(state=>state===question.state)||!todo||(todo.status!=='done'&&todo.status!=='dropped'))continue;
      const at=nowIso(),reason=todo.status==='done'?`He marked his to-do "${todo.text}" done.`:`He dropped his to-do "${todo.text}".`;
      db.transaction(()=>{
        const topic=topicRow(question.topicId),topicNext=bumped(topic);
        const next:StoredQuestion={...question,state:'answered',updatedAt:at,brief:{...question.brief,endedBecause:reason}};
        const payload={change:'settled',topicId:topic.topicId,topic:topicNext,questions:[next],by:{kind:'owner' as const},reason,revision:topicNext.revision};
        recordSessionEvent({eventId:`topic-todo-done:${question.questionId}`,sessionId:session.id,kind:'topic_question',payload});
        applyTopicChange('topic_question',payload);
      })();
      closed++;
      const owner=conciergeSessionNumber(question.owner?.sessionId);
      const noticeId=`question-todo-done:${question.questionId}`;
      if(admit&&owner!==null&&owner!==session.id&&!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(noticeId))
        admit({sessionId:owner,inputId:noticeId,origin:'service',sourceInputId:noticeId,sourceRunId:noticeId,requestId:noticeId,
          text:`${reason} Your question to him, "${String(question.brief?.decision??'').slice(0,300)}", is closed by that: carry on from there and check the result yourself. You do not need to reply to this.`});
    } catch(error) {log('error','question_todo_close_failed',{question:question_id,message:error instanceof Error?error.message:String(error)});}
  }
  const {withdrawOpenNeed}=await import('./session-turn-outcome');
  for(const {id} of direct){
    const session=getSessionById(id);
    if(!session||sessionMetadata(session).inbox)continue;
    for(const need of sessionMetadata(session).needs??[]){
      if(need.outcome!=='needs_you'||!need.todoId)continue;
      const todo=todos.get(need.todoId);
      if(!todo||(todo.status!=='done'&&todo.status!=='dropped'))continue;
      const reason=todo.status==='done'?`He marked his to-do "${todo.text}" done.`:`He dropped his to-do "${todo.text}".`;
      try{
        withdrawOpenNeed({sessionId:id,needEventId:need.eventId,reason,eventId:`attention-todo-done:${need.eventId}`});
        closed++;
        const noticeId=`direct-todo-done:${need.eventId}`;
        if(admit&&!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(noticeId))
          admit({sessionId:id,inputId:noticeId,origin:'service',sourceInputId:noticeId,sourceRunId:noticeId,requestId:noticeId,
            text:`${reason} Your question to him, "${need.question.slice(0,300)}", is closed by that: carry on from there and check the result yourself. You do not need to reply to this.`});
      }catch(error){log('error','direct_question_todo_close_failed',{session:id,need:need.eventId,message:error instanceof Error?error.message:String(error)});}
    }
  }
  if(closed)log('info','questions_closed_by_todos',{closed});
  return closed;
}

export function wakeDeferredQuestions(now=Date.now(),admit?:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string})=>unknown):number {
  const session=inboxSession();
  if(!session)return 0;
  const at=new Date(now).toISOString();
  const due=(db.query("SELECT * FROM inbox_questions WHERE state='deferred' AND defer_until IS NOT NULL AND defer_until<=? ORDER BY defer_until,question_id").all(at) as any[]).map(toStoredQuestion);
  let woken=0;
  for(const question of due) {
    const topic=topicRow(question.topicId);
    const next:StoredQuestion={...question,state:'open',deferUntil:null,updatedAt:at};
    const topicNext=bumped(topic);
    const reason=`Set aside until ${question.deferUntil}; back now`;
    const payload={change:'returned',topicId:topic.topicId,topic:topicNext,questions:[next],by:{kind:'owner' as const},reason,revision:topicNext.revision};
    const stamp=question.deferUntil??at;
    recordSessionEvent({eventId:`topic-remind:${question.questionId}:${stamp}`,sessionId:session.id,kind:'topic_question',payload});
    applyTopicChange('topic_question',payload);
    // The notification, shaped like a new question's: the Inbox session, the thread's root as its
    // input, the decision as its words, a fresh attention generation.
    refreshRootMemo();
    const inputId=(question.sources[0]?rootOf(session.id,question.sources[0]):null)??topicRoots(topic.topicId).at(-1)??null;
    const meta=sessionMetadata(session),generation=(meta.generation??0)+1;
    updateSessionMetadata(session.id,{generation});
    const decision=String(question.brief?.decision??'').trim()||'A question you set aside is back.';
    const author=typeof question.owner?.sessionId==='string'?sessionAuthor(question.owner.sessionId):null;
    recordSessionEvent({eventId:`question-reminder:${question.questionId}:${stamp}`,sessionId:session.id,inputId,kind:'needs_you',
      payload:{outcome:'needs_you',question:decision,inputId,generation,topicId:topic.topicId,questionId:question.questionId,setAsideUntil:question.deferUntil,
        ...(linkedTodoId(question)?{todoId:linkedTodoId(question)}:{}),
        ...(author?.agentName?{agentName:author.agentName}:{}),...(author?.title?{taskTitle:author.title}:{})}});
    // The Inbox itself owns most questions (the router declared them); it is told like any other
    // owner, because it is the one that knows how to refresh what the question carries.
    const owner=conciergeSessionNumber(question.owner?.sessionId);
    if(admit&&owner!==null) {
      const inputId2=`question-returned:${question.questionId}:${stamp}`;
      if(!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(inputId2)) {
        try {
          admit({sessionId:owner,inputId:inputId2,origin:'service',sourceInputId:`question-reminder:${question.questionId}:${stamp}`,sourceRunId:`question-reminder:${question.questionId}:${stamp}`,requestId:inputId2,
            text:`The question you asked Tejas, "${decision}" (${question.questionId}) in the Inbox thread "${topic.title}" (${topic.topicId}, root message ${inputId??'unknown'}), was set aside by him until ${question.deferUntil} and is back in front of him now. If anything in it expires (a one-time form link, a code), refresh it now and send the fresh words to the Inbox for that thread (sessions ask to the Inbox session with --thread ${inputId??'<root>'}), so what he opens works. You do not need to reply to this.`});
        } catch { /* the reminder itself has gone out; the refresh is the owner session's to retry */ }
      }
    }
    woken++;
  }
  return woken;
}

/* ------------------------------------------------------------------ agents' answers in threads */

/**
 * An agent's answer goes into the thread it was asked for, and what it means for him is filed there
 * by the owner, with no router turn: the post (`postForwardedThreadAnswer`), then for a final answer
 * one item in Needs you with its notification — a question when the agent needs his decision, a
 * reading item otherwise (its answer, or that it could not finish) — and, when it answered as done,
 * the thread's request it was linked to closes completed by the same rule the router is held to
 * (`refuseUnfinishedCompletion`). A partial that answers his question is posted; a
 * progress-only partial stays on the Work receipt unless its agent explicitly requests a
 * notification. Server and Mac agents both arrive here
 * [decision: mac-sessions-have-parity] [decision: thread-replies-go-to-the-working-agent].
 */
export function postAgentAnswer(answer:Parameters<typeof postForwardedThreadAnswer>[0]&{respondingTitle?:string|null;informational?:boolean;notify?:boolean;summary?:string|null;todoId?:string|null}):string|null {
  if(!answer.final&&!answer.stalled&&!answer.answersQuestion&&!answer.notify)return null;
  const upkeepEventId=`answer-upkeep:${answer.eventId}`;
  if(answer.final){
    const completed=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(upkeepEventId) as {payload_json:string}|null;
    if(completed)return JSON.parse(completed.payload_json).postId as string;
  }
  answer={...answer,root:inboxRequestRoot(db,answer.requestId,answer.root)??answer.root};
  const post=postForwardedThreadAnswer(answer);
  if(post&&!answer.final&&answer.notify){
    const row=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(post) as {payload_json:string}|null;
    notifyAgentPost(answer.inboxSessionId,answer.root,post,String(row?JSON.parse(row.payload_json).text??'':answer.text),answer.notify===true);
  }
  if(!post||!answer.final)return post;
  if(answer.stalled&&answer.quiet){
    recordSessionEvent({eventId:upkeepEventId,sessionId:answer.inboxSessionId,kind:'answer_upkeep',payload:{postId:post}});
    return post;
  }
  const postText=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(post) as {payload_json:string}|null;
  const filedText=postText?String(JSON.parse(postText.payload_json).text??answer.text):answer.text;
  const disposition=answer.stalled?'failed':answer.informational?'completed':answer.workDisposition;
  const quiet=answer.informational?'Information-only answer posted in the thread; no separate alert.':
    answer.workDisposition==='completed'&&typeof answer.quiet==='string'&&answer.quiet.trim()?answer.quiet.trim():null;
  // Filing closes the request before it files his item for this answer; the thread is judged once,
  // after both, below, so it never closes and reopens around one answer.
  upkeepDepth++;
  try {
    fileAgentAnswer({inboxSessionId:answer.inboxSessionId,root:answer.root,postId:post,eventId:answer.eventId,dispatchRequestId:answer.requestId,
      respondingSessionId:answer.respondingSessionId,respondingTitle:answer.respondingTitle??null,disposition,text:filedText,summary:answer.summary??null,quiet,notify:answer.notify,
      askedInRun:answer.answerSource?.runId??null,todoId:answer.todoId??null});
  } catch(error) {
    // The event remains pending so the same post identity can finish filing on retry.
    log('error','inbox_answer_filing_failed',{request_id:answer.requestId,thread:answer.root,post,message:error instanceof Error?error.message:String(error)});
    throw error;
  } finally {upkeepDepth--;}
  try {
    mirrorLinkedAnswer({inboxSessionId:answer.inboxSessionId,sourceRoot:answer.root,sourcePostId:post,eventId:answer.eventId,
      dispatchRequestId:answer.requestId,respondingSessionId:answer.respondingSessionId,respondingTitle:answer.respondingTitle??null,
      disposition,text:filedText,summary:answer.summary??null,quiet,closingLine:answer.closingLine??null});
  } catch(error) {
    log('error','inbox_shared_answer_filing_failed',{request_id:answer.requestId,post,message:error instanceof Error?error.message:String(error)});
    throw error;
  }
  try {
    refreshRootMemo();
    const topicId=topicOfRoot(answer.root);
    if(topicId){keepThreadOpenOrClosed({topicId});keepThreadCurrent(topicId,forwardedReplies(),true);}
  } catch(error) {
    log('error','inbox_thread_upkeep_failed',{request_id:answer.requestId,thread:answer.root,message:error instanceof Error?error.message:String(error)});
    return post;
  }
  // A held return can retry every poll while its requester is unavailable. The post, filing,
  // linked copies and upkeep must all finish before that retry can skip this work.
  recordSessionEvent({eventId:upkeepEventId,sessionId:answer.inboxSessionId,kind:'answer_upkeep',payload:{postId:post}});
  return post;
}

/** One dispatch may advance requests in several threads; its answer is copied once to each
 * linked thread, while each request keeps its own completion decision. */
function mirrorLinkedAnswer(answer:{inboxSessionId:number;sourceRoot:string;sourcePostId:string;eventId:string;
  dispatchRequestId:string;respondingSessionId:string;respondingTitle:string|null;disposition:string|null;
  text:string;summary:string|null;quiet:string|null;closingLine:string|null}):number {
  // A decision is one question in the dispatch's original thread. Copy its eventual
  // final answer, not a second question that could ring or be answered independently.
  if(answer.disposition==='needs_decision')return 0;
  const sourceTopic=topicOfRoot(answer.sourceRoot);
  const rows=db.query(`SELECT request.* FROM inbox_requests request,json_each(request.dispatches_json) dispatch
    WHERE request.state='open' AND json_extract(dispatch.value,'$.requestId')=?
      AND json_extract(dispatch.value,'$.sharedAcrossTopic')=1`).all(answer.dispatchRequestId) as any[];
  const byTopic=new Map<string,StoredRequest>();
  for(const row of rows){
    const request=toStoredRequest(row);
    if(request.topicId!==sourceTopic&&!byTopic.has(request.topicId))byTopic.set(request.topicId,request);
  }
  const original=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(answer.sourcePostId) as {payload_json:string}|null;
  const attachments=original?JSON.parse(original.payload_json).attachments??[]:[];
  let mirrored=0;
  for(const [topicId,request] of byTopic){
    const root=request.sources.map(source=>rootOf(answer.inboxSessionId,source.inputId))
      .find(candidate=>candidate&&topicOfRoot(candidate)===topicId)
      ??request.dispatches.map((dispatch:any)=>`request:${dispatch.requestId}`)
        .find(candidate=>topicOfRoot(candidate)===topicId)
      ??topicRoots(topicId)[0];
    if(!root)continue;
    const eventId=`shared:${answer.eventId}:${topicId}`;
    const post=postForwardedThreadAnswer({inboxSessionId:answer.inboxSessionId,eventId,requestId:answer.dispatchRequestId,
      root,inboxInputId:root,respondingSessionId:answer.respondingSessionId,text:answer.text,attachments,
      stalled:false,final:true,workDisposition:answer.disposition,closingLine:answer.closingLine,
      answerGroup:answer.sourcePostId,quiet:answer.quiet});
    if(!post)continue;
    fileAgentAnswer({inboxSessionId:answer.inboxSessionId,root,postId:post,eventId,dispatchRequestId:answer.dispatchRequestId,
      respondingSessionId:answer.respondingSessionId,respondingTitle:answer.respondingTitle,disposition:answer.disposition,
      text:answer.text,summary:answer.summary,quiet:answer.quiet});
    keepThreadOpenOrClosed({topicId});
    mirrored++;
  }
  return mirrored;
}
/**
 * An agent working on an Inbox thread that is waiting on him is one decision in that thread, with
 * the thread's blocking notification, whichever way it said so. Its own needs_you cannot reach him:
 * thnkr.ing leaves a turn the Inbox started to the Inbox, and nothing carried it there, so the Uber
 * Eats agent's "send a photo of the biryani" on 2026-11-02 reached no device (its failed reply had
 * filed only a reading item). The thread is the one his originating message belongs to: the turn's
 * own provenance, never merely the last thread this session served, so a session he started himself
 * keeps its own notification. The question is posted as the agent's words there and filed exactly
 * as a needs_decision reply is; a reply and an outcome from the same agent run are one ask and ring
 * once, while a different ask keeps its own question (ChatGPT Pro's review, 2026-11-02).
 */
export function fileWorkerNeedInThread(input:{respondingSessionId:number;turnInputId:string;runId:string;eventId:string;text:string;todoId?:string|null}):string|null {
  const turnInput=getAcceptedSessionInput(input.turnInputId);
  const provenance=turnInput?sessionInputProvenance(turnInput):null;
  const human=provenance?.originatingHuman;
  const askedIn=human?conciergeSessionNumber(human.sessionId):null;
  const inbox=askedIn!==null?getSessionById(askedIn):null;
  if(!human||!inbox||!sessionMetadata(inbox).inbox||inbox.id===input.respondingSessionId)return null;
  // Only the request that delivered this turn can name its thread. A prior request to the
  // same worker may belong to another topic and must not capture this question.
  const request=(db.query(`SELECT request_id,thread_root_input_id FROM session_communication_requests
      WHERE request_id=? AND target_session_id=? AND source_session_id=? AND target_input_id=? AND thread_root_input_id IS NOT NULL
      LIMIT 1`)
    .get(provenance?.requestId,input.respondingSessionId,inbox.id,input.turnInputId)) as {request_id:string;thread_root_input_id:string}|null;
  if(!request)return null;
  const root=inboxRequestRoot(db,request.request_id,request.thread_root_input_id)??request.thread_root_input_id;
  refreshRootMemo();
  const topicId=topicOfRoot(root);
  if(!topicId)return null;
  const respondingSessionId=`concierge:${input.respondingSessionId}`;
  const covered=topicQuestions(topicId).find(question=>sameAsk(question,respondingSessionId,input.runId));
  if(covered)return covered.questionId;
  const post=postForwardedThreadAnswer({inboxSessionId:inbox.id,eventId:`need:${input.eventId}`,requestId:request.request_id,root,
    inboxInputId:request.thread_root_input_id,respondingSessionId,text:input.text,attachments:[],stalled:false,final:false,workDisposition:null});
  if(!post)return null;
  fileAgentAnswer({inboxSessionId:inbox.id,root,postId:post,eventId:`need:${input.eventId}`,dispatchRequestId:request.request_id,
    respondingSessionId,respondingTitle:sessionAuthor(respondingSessionId)?.title??null,disposition:'needs_decision',text:input.text,askedInRun:input.runId,todoId:input.todoId??null});
  return post;
}
/** Keep an Inbox-origin question reachable when its exact dispatch has no usable thread. */
export function fileWorkerNeedWithoutThread(input:{respondingSessionId:number;turnInputId:string;runId:string;eventId:string;text:string;todoId?:string|null}):string|null {
  const turnInput=getAcceptedSessionInput(input.turnInputId);
  const provenance=turnInput?sessionInputProvenance(turnInput):null;
  let inboxOrigin=provenance?.originatingHuman?.sessionId??null;
  // Follow retained source/run edges through any agent handoff. This also works when a
  // request row is missing, while an unrelated prior dispatch cannot supply a thread.
  if(!inboxOrigin&&provenance?.effectScope!=='informational'){
    const seen=new Set<string>();
    let current=turnInput;
    while(current?.origin==='agent'&&['input','create','consultation','request'].includes(current.kind)
      &&current.source_input_id&&current.source_run_id&&!seen.has(current.id)){
      seen.add(current.id);
      const source=getAcceptedSessionInput(current.source_input_id);
      const sourceRun=source?.turn_id?db.query('SELECT native_run_id FROM turns WHERE id=? AND session_id=?')
        .get(source.turn_id,source.session_id) as {native_run_id:string|null}|null:null;
      if(!source||sourceRun?.native_run_id!==current.source_run_id)break;
      const sourceSession=getSessionById(source.session_id);
      if(sourceSession&&sessionMetadata(sourceSession).inbox){inboxOrigin=`concierge:${source.session_id}`;break;}
      current=source;
    }
  }
  const askedIn=inboxOrigin?conciergeSessionNumber(inboxOrigin):null;
  const inbox=askedIn!==null?getSessionById(askedIn):null;
  if(!inbox||!sessionMetadata(inbox).inbox||!input.text.trim())return null;
  const respondingSessionId=`concierge:${input.respondingSessionId}`;
  const covered=db.query(`SELECT question_id FROM inbox_questions WHERE kind='decision'
    AND json_extract(owner_json,'$.sessionId')=? AND json_extract(owner_json,'$.askedInRun')=? LIMIT 1`)
    .get(respondingSessionId,input.runId) as {question_id:string}|null;
  if(covered)return covered.question_id;
  const root=input.eventId,postId=`post:worker-need:${input.eventId}`;
  const title=sessionAuthor(respondingSessionId)?.title??'Agent question';
  db.transaction(()=>{
    // The action input is accepted in the worker session and gives this Inbox post a stable root.
    // Its provenance remains agent-authored; the Inbox never presents it as Tejas's message.
    if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(postId))
      recordSessionEvent({eventId:postId,sessionId:inbox.id,inputId:root,kind:'post',
        payload:{text:input.text.trim(),postedBy:'owner-forward',postedBySession:respondingSessionId}});
    if(!topicOfRoot(root)){
      const by:TopicBy={kind:'owner',sessionId:respondingSessionId};
      const created=createTopic(inbox,by,{title:`Question from ${title}`,roots:[root],
        areaIds:[ensureSystemNoticeArea(inbox.id)],reason:'The Inbox request had no usable thread when its agent asked Tejas.'});
      recordOwnerTopicChange(inbox.id,`topic-worker-need:${input.eventId}`,created.change.kind,created.change.payload);
    }
    fileAgentAnswer({inboxSessionId:inbox.id,root,postId,eventId:`need:${input.eventId}`,
      dispatchRequestId:`need:${input.eventId}`,respondingSessionId,
      respondingTitle:title,disposition:'needs_decision',text:input.text,askedInRun:input.runId,todoId:input.todoId??null});
  })();
  return postId;
}
/** The server owns the Inbox decision for an exact Mac request; the Mac sends only its outcome fact. */
export function filePeerWorkerNeedInThread(input:{requestId:string;inboxSessionId:number;threadRootInputId:string|null;
  sourceInputId:string;respondingSessionId:string;runId:string;eventId:string;text:string}):string|null {
  const inbox=getSessionById(input.inboxSessionId),source=getAcceptedSessionInput(input.sourceInputId);
  const human=source?(sessionInputProvenance(source)?.originatingHuman
    ??(humanAuthored(source)?{sessionId:`concierge:${source.session_id}`,inputId:source.id}:null)):null;
  if(!inbox||!sessionMetadata(inbox).inbox||!human||conciergeSessionNumber(human.sessionId)!==inbox.id
    ||!input.threadRootInputId||!input.respondingSessionId||!input.runId||!input.text?.trim())return null;
  const root=inboxRequestRoot(db,input.requestId,input.threadRootInputId)??input.threadRootInputId;
  refreshRootMemo();
  const topicId=topicOfRoot(root);
  if(!topicId||topicQuestions(topicId).some(question=>sameAsk(question,input.respondingSessionId,input.runId)))return null;
  const post=postForwardedThreadAnswer({inboxSessionId:inbox.id,eventId:`need:${input.eventId}`,requestId:input.requestId,root,
    inboxInputId:input.threadRootInputId,respondingSessionId:input.respondingSessionId,text:input.text,attachments:[],stalled:false,final:false,workDisposition:null});
  if(!post)return null;
  fileAgentAnswer({inboxSessionId:inbox.id,root,postId:post,eventId:`need:${input.eventId}`,dispatchRequestId:input.requestId,
    respondingSessionId:input.respondingSessionId,respondingTitle:sessionAuthor(input.respondingSessionId)?.title??null,
    disposition:'needs_decision',text:input.text,askedInRun:input.runId});
  return post;
}
/** One run's reply and outcome are one ask; a later run, or the same run asking again in other words
 * on another day, may ask for something different and keeps its own question. */
const sameAsk=(question:StoredQuestion,respondingSessionId:string,runId:string|null)=>!!runId&&question.kind==='decision'
  &&OPEN_QUESTION_STATES.some(state=>state===question.state)&&question.owner?.sessionId===respondingSessionId&&question.owner?.askedInRun===runId;

/** Reconcile retained answers after a request is linked, including links to another thread. */
/** The live, per-request reconciliation: forwarded final answers and carried closures for one request (or all). */
export function reconcilePlacedRequestAnswers(onlyRequestId?:string):number {
  return reconcileForwardedFinalAnswers(onlyRequestId)+reconcileCarriedClosures(onlyRequestId);
}

/**
 * Forwarded final answers, optionally only those whose events fall in (afterSequence, throughSequence].
 * A bounded range reads only that slice of the event log: "+kind" and "+event_id" keep the planner
 * off the indexes that list every forwarded post ever, so the sequence range is its access path.
 */
export function reconcileForwardedFinalAnswers(onlyRequestId?:string,range?:{afterSequence:number;throughSequence:number}):number {
  const inbox=inboxSession();
  if(!inbox)return 0;
  // A request link reconciles one dispatch. Find its final event through the request index,
  // then fetch the forwarded post by primary key; scanning every historical Inbox post
  // blocked admission while the router linked a backlog of unrelated requests.
  const bounded=!!range,idColumn=bounded?'+event_id':'event_id';
  const rows=(onlyRequestId
    ?db.query(`SELECT post.event_id,post.session_id,post.input_id,post.payload_json FROM (
        SELECT event_id FROM session_communication_events WHERE request_id=? AND kind='final'
        UNION ALL SELECT event_id FROM session_peer_events WHERE request_id=? AND kind='final'
      ) reply JOIN session_owner_events post ON post.event_id='post:forward:' || reply.event_id
      WHERE post.kind='post' AND json_extract(post.payload_json,'$.replyKind')='final'
        AND json_extract(post.payload_json,'$.workDisposition') IS NOT NULL
        AND post.sequence > ? AND post.sequence <= ?`).all(onlyRequestId,onlyRequestId,
          range?.afterSequence??0,range?.throughSequence??Number.MAX_SAFE_INTEGER)
    :db.query(`SELECT event_id,session_id,input_id,payload_json FROM session_owner_events
      WHERE ${bounded?'+kind':'kind'}='post' AND ${idColumn} >= 'post:forward:' AND ${idColumn} < 'post:forward;'
        AND event_id NOT LIKE 'post:forward:shared:%'
        AND json_extract(payload_json,'$.replyKind')='final'
        AND json_extract(payload_json,'$.workDisposition') IS NOT NULL
        AND sequence > ? AND sequence <= ?`).all(range?.afterSequence??0,
          range?.throughSequence??Number.MAX_SAFE_INTEGER)) as
      {event_id:string;session_id:number;input_id:string;payload_json:string}[];
  let reconciled=0;
  for(const row of rows){
    const payload=JSON.parse(row.payload_json);
    if(typeof payload.requestId!=='string')continue;
    const postId=row.event_id,eventId=postId.slice('post:forward:'.length);
    reconciled+=mirrorLinkedAnswer({inboxSessionId:row.session_id,sourceRoot:row.input_id,sourcePostId:postId,eventId,
      dispatchRequestId:payload.requestId,respondingSessionId:payload.postedBySession??'',respondingTitle:null,
      disposition:payload.workDisposition,text:payload.text??'',summary:null,quiet:payload.quiet??null,
      closingLine:(db.query('SELECT json_extract(payload_json,\'$.closingLine\') AS line FROM session_owner_events WHERE event_id=?')
        .get(`post:closure:${eventId}`) as {line:string|null}|null)?.line??null});
    if(payload.workDisposition!=='completed')continue;
    const root=inboxRequestRoot(db,payload.requestId,row.input_id);
    if(!root||root===row.input_id||!topicOfRoot(root))continue;
    const pending=db.query(`SELECT 1 FROM inbox_requests request,json_each(request.dispatches_json) dispatch
      WHERE request.topic_id=? AND request.state='open' AND json_extract(dispatch.value,'$.requestId')=? LIMIT 1`)
      .get(topicOfRoot(root),payload.requestId);
    if(!pending)continue;
    fileAgentAnswer({inboxSessionId:row.session_id,root,postId,eventId,dispatchRequestId:payload.requestId,
      respondingSessionId:payload.postedBySession??'',respondingTitle:null,disposition:'completed',text:payload.text??'',
      quiet:'The retained answer was already notified when it first arrived.'});
    const oldFile=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?')
      .get(`topic-answer:${eventId}`) as {payload_json:string}|null;
    const oldQuestionId=oldFile?JSON.parse(oldFile.payload_json).questions?.[0]?.questionId:null;
    const movedEvent=`topic-rehome:answer:${eventId}`;
    if(typeof oldQuestionId==='string'&&!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(movedEvent)){
      const question=questionRow(oldQuestionId),toTopic=topicOfRoot(root);
      if(toTopic&&question.topicId!==toTopic&&question.kind==='reading'&&question.state==='open'){
        const from=bumped(topicRow(question.topicId)),to=bumped(topicRow(toTopic));
        const next={...question,topicId:toTopic,sources:[root,postId],revision:question.revision+1,updatedAt:nowIso()};
        const change={change:'answer_rehomed',topicId:toTopic,topic:to,topics:[from],questions:[next],
          by:{kind:'owner' as const},reason:'The answer belongs to the topic rooted at its request.',revision:to.revision};
        recordSessionEvent({eventId:movedEvent,sessionId:row.session_id,kind:'topic_question',payload:change});
        applyTopicChange('topic_question',change);
      }
    }
    reconciled++;
  }
  return reconciled;
}

/** Partial answers carried by an answer closure, mirrored once their request is answered. */
export function reconcileCarriedClosures(onlyRequestId?:string,range?:{afterSequence:number;throughSequence:number}):number {
  const inbox=inboxSession();
  if(!inbox)return 0;
  let reconciled=0;
  const carried=db.query(`SELECT closure.event_id,closure.session_id,post.input_id,closure.payload_json,post.event_id AS post_id,
      post.payload_json AS post_payload FROM session_owner_events closure INDEXED BY session_owner_events_session_kind
    JOIN session_owner_events post ON post.event_id=json_extract(closure.payload_json,'$.postId') AND post.kind='post'
    WHERE closure.session_id=? AND closure.kind='answer_closure'
      AND closure.sequence > ? AND closure.sequence <= ? AND json_extract(post.payload_json,'$.replyKind')='partial'
      AND post.event_id NOT LIKE 'post:forward:shared:%'
      AND (? IS NULL OR json_extract(closure.payload_json,'$.requestId')=?)`).all(inbox.id,range?.afterSequence??0,
        range?.throughSequence??Number.MAX_SAFE_INTEGER,onlyRequestId??null,onlyRequestId??null) as
      {event_id:string;session_id:number;input_id:string;payload_json:string;post_id:string;post_payload:string}[];
  for(const row of carried){
    const closure=JSON.parse(row.payload_json),post=JSON.parse(row.post_payload);
    if(typeof closure.requestId!=='string')continue;
    const work=workRow(closure.requestId);
    if(!work||work.outcome!=='answered')continue;
    reconciled+=mirrorLinkedAnswer({inboxSessionId:row.session_id,sourceRoot:row.input_id,sourcePostId:row.post_id,
      eventId:row.event_id.slice('post:closure:'.length),dispatchRequestId:closure.requestId,
      respondingSessionId:post.postedBySession??'',respondingTitle:null,disposition:work.disposition,
      text:post.text??'',summary:null,quiet:post.quiet??null,closingLine:closure.closingLine??null});
  }
  return reconciled;
}

/** Hide historical timer posts without deleting their request or post evidence. */
export function retireTimedRequestPosts(range?:{afterSequence:number;throughSequence:number}):number {
  // A bounded range reads only that slice of the event log (see reconcileForwardedFinalAnswers).
  const bounded=!!range;
  return db.transaction(()=>{
    const posts=db.query(`SELECT post.event_id,post.input_id,post.session_id FROM session_owner_events post
    WHERE ${bounded?'+post.kind':'post.kind'}='post' AND ${bounded?'+post.event_id':'post.event_id'} LIKE 'post:forward:%'
      AND post.sequence > ? AND post.sequence <= ?
      AND NOT EXISTS (SELECT 1 FROM session_owner_events hidden WHERE hidden.event_id='post:collapse:' || post.event_id)
      AND (EXISTS (SELECT 1 FROM session_communication_events event
        WHERE event.event_id=substr(post.event_id,length('post:forward:')+1) AND event.kind='overdue')
        OR EXISTS (SELECT 1 FROM session_peer_events event
        WHERE event.event_id=substr(post.event_id,length('post:forward:')+1) AND event.kind='overdue'))`)
      .all(range?.afterSequence??0,range?.throughSequence??Number.MAX_SAFE_INTEGER) as {event_id:string;input_id:string|null;session_id:number}[];
    for(const post of posts)
      recordSessionEvent({eventId:`post:collapse:${post.event_id}`,sessionId:post.session_id,inputId:post.input_id,
        kind:'post_collapse',payload:{postId:post.event_id,reason:'A request timer is for agents, not the Inbox conversation.'}});
    return posts.length;
  })();
}

/** Retire duplicate presentation entries while keeping every request, reply and original post as evidence. */
export function collapseDuplicateAnswerPosts(topicId:string,postIds:readonly string[]):number {
  if(postIds.length<2||new Set(postIds).size!==postIds.length)throw new Error('Name distinct answer posts.');
  const posts=postIds.map(id=>db.query("SELECT sequence,event_id,input_id,session_id,kind,payload_json FROM session_owner_events WHERE event_id=?").get(id) as
    {sequence:number;event_id:string;input_id:string;session_id:number;kind:string;payload_json:string}|null);
  if(posts.every(post=>!post))return 0;
  if(posts.some(post=>!post))throw new Error('The duplicate answer set is incomplete.');
  const ordered=posts.map(post=>post!).sort((left,right)=>left.sequence-right.sequence);
  const first=ordered[0]!,original=JSON.parse(first.payload_json);
  const closingLine=(post:typeof first)=>answerClosingLine(db,post.session_id,post.event_id,JSON.parse(post.payload_json).answersQuestion===true);
  const sameAnswer=(post:typeof first)=>{
    const payload=JSON.parse(post.payload_json);
    const request=db.query('SELECT outcome,source_session_id,target_session_id FROM session_communication_requests WHERE request_id=?')
      .get(payload.requestId) as {outcome:string|null;source_session_id:number;target_session_id:number}|null;
    return post.kind==='post'&&post.session_id===first.session_id&&topicOfRoot(post.input_id)===topicId
      &&payload.replyKind==='final'&&payload.workDisposition==='completed'&&payload.postedBySession===original.postedBySession
      &&payload.answerGroup&&payload.answerGroup===original.answerGroup&&payload.text===original.text
      &&JSON.stringify(payload.attachments??[])===JSON.stringify(original.attachments??[])
      &&(payload.quiet??null)===(original.quiet??null)
      &&(payload.messageThreadRootId??null)===(original.messageThreadRootId??null)
      &&closingLine(post)===closingLine(first)
      &&request?.outcome==='answered'&&request.source_session_id===first.session_id
      &&`concierge:${request.target_session_id}`===payload.postedBySession;
  };
  if(!ordered.every(sameAnswer))throw new Error('The named posts are not one completed answer in this topic.');
  const session=getSessionById(first.session_id);
  if(!session||!sessionMetadata(session).inbox)throw new Error('The answer topic has no Inbox owner.');
  return db.transaction(()=>{
    let collapsed=0;
    for(const post of ordered.slice(1)){
      const eventId=`post:collapse:${post.event_id}`;
      if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))continue;
      recordSessionEvent({eventId,sessionId:session.id,inputId:post.input_id,kind:'post_collapse',
        payload:{postId:post.event_id,keptPostId:first.event_id,topicId,reason:'One identical final answer closed several requests.'}});
      collapsed++;
    }
    const duplicates=new Set(ordered.slice(1).map(post=>post.event_id));
    const keptQuestion=topicQuestions(topicId).find(question=>question.kind==='reading'&&question.brief?.reads?.includes(first.event_id));
    const questions=topicQuestions(topicId).filter(question=>question.kind==='reading'&&question.state==='open'
      &&question.brief?.reads?.some((postId:string)=>duplicates.has(postId)))
      .map(question=>({...question,state:'superseded' as QuestionState,replacedBy:keptQuestion?.questionId??null,
        revision:question.revision+1,updatedAt:nowIso(),brief:{...question.brief,endedBecause:'The identical answer remains in this topic once.'}}));
    if(questions.length){
      const topic=bumped(topicRow(topicId));
      const payload={change:'duplicate_answers_collapsed',topicId,topic,questions,by:{kind:'owner' as const},
        reason:'One identical answer is visible; all request closures remain.',revision:topic.revision};
      const eventId=`topic-collapse:answers:${first.event_id}`;
      if(!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId)){
        recordSessionEvent({eventId,sessionId:session.id,kind:'topic_question',payload});
        applyTopicChange('topic_question',payload);
      }
    }
    return collapsed;
  })();
}

/** The six October 21 replies were byte-identical finals in six roots of one topic. */
export function repairOctober21RepeatedAnswer():number {
  return collapseDuplicateAnswerPosts('topic:c96e9f47-03f1-472b-b6ed-5f16dc7682d5',[
    'post:forward:c9f50f17-8b9f-40d6-a16e-9a1b583f1b90',
    'post:forward:f3eb3816-6ffc-4871-af3c-5c787c43ca39',
    'post:forward:9e67ca1d-ad70-4e13-870a-1ef561edb9be',
    'post:forward:7aa10aae-08c4-4d10-9c41-9530c9047309',
    'post:forward:8e6c6a98-205b-4ebf-bace-91ef93fd798f',
    'post:forward:9ade95ec-e8ed-4302-87c8-6257ee8c8574',
  ]);
}
/** Repair one observed burst of repeated progress and stop notices without changing request history. */
export function repairNovember4RepeatedThreadNotices():number {
  const topicId='topic:2a4135fb-be59-4269-a593-859ce7523e65';
  const groups=[
    ['post:forward:98dda8ad-c741-4f6c-8db5-731d9eb8877c','post:forward:8902c2ca-11e6-4145-a2e9-ca952d5df5ce',
      'post:forward:ba5cf0c1-4ed9-4724-a7da-c9f5ea548920','post:forward:4ae5e43f-b54a-4093-9cbd-43bee02c88d9'],
    ['post:forward:85d8e7dc-eb77-4865-bb27-1cc910c92360','post:forward:2fc8204b-8e44-464c-ad65-17e0cbced446',
      'post:forward:257b170a-2f85-40fd-8193-f3679f8679f2','post:forward:9086a441-a275-4329-9039-76a8efeedff3'],
  ];
  let collapsed=0;
  for(const ids of groups){
    const rows=ids.map(id=>db.query('SELECT event_id,input_id,session_id,kind,payload_json FROM session_owner_events WHERE event_id=?')
      .get(id) as {event_id:string;input_id:string;session_id:number;kind:string;payload_json:string}|null);
    if(rows.every(row=>!row))continue;
    if(rows.some(row=>!row))throw new Error('The November 4 repeated notice set is incomplete.');
    const first=rows[0]!,original=JSON.parse(first.payload_json),stalled=original.postedBy==='service';
    const runs=new Set<string>(),turns=new Set<number>();
    for(const row of rows){
      const post=row!,payload=JSON.parse(post.payload_json);
      const request=db.query('SELECT target_session_id,target_input_id FROM session_communication_requests WHERE request_id=?')
        .get(payload.requestId) as {target_session_id:number;target_input_id:string}|null;
      const event=db.query('SELECT kind,payload_json FROM session_communication_events WHERE event_id=?')
        .get(post.event_id.slice('post:forward:'.length)) as {kind:string;payload_json:string}|null;
      const target=request?db.query('SELECT turn_id FROM session_inputs WHERE id=?').get(request.target_input_id) as {turn_id:number|null}|null:null;
      if(post.kind!=='post'||post.session_id!==first.session_id||topicOfRoot(post.input_id)!==topicId
        ||payload.text!==original.text||payload.replyKind!=='partial'||payload.postedBy!==original.postedBy
        ||request?.target_session_id!==8153||!event||event.kind!==(stalled?'overdue':'progress')||!target?.turn_id)
        throw new Error('The November 4 posts are not one agent event in this topic.');
      turns.add(target.turn_id);
      const source=JSON.parse(event.payload_json).source;
      if(!stalled){if(!source?.run_id)throw new Error('A repeated progress post has no agent run.');runs.add(source.run_id);}
    }
    if(turns.size!==1||runs.size>1)throw new Error('The November 4 posts came from different turns.');
    const inbox=getSessionById(first.session_id);
    if(!inbox||!sessionMetadata(inbox).inbox)throw new Error('The November 4 thread has no Inbox owner.');
    for(const row of rows.slice(1)){
      const eventId=`post:collapse:${row!.event_id}`;
      if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))continue;
      recordSessionEvent({eventId,sessionId:first.session_id,inputId:row!.input_id,kind:'post_collapse',
        payload:{postId:row!.event_id,keptPostId:first.event_id,topicId,
          reason:stalled?'One stopped turn has one visible notice.':'One agent update appears once in the thread.'}});
      collapsed++;
    }
  }
  return collapsed;
}
const headline=(value:string)=>answerLine(value);
function fileAgentAnswer(answer:{inboxSessionId:number;root:string;postId:string;eventId:string;dispatchRequestId:string;respondingSessionId:string;respondingTitle:string|null;disposition:string|null;text:string;summary?:string|null;quiet?:string|null;notify?:boolean;askedInRun?:string|null;todoId?:string|null}) {
  const session=getSessionById(answer.inboxSessionId);
  if(!session||!sessionMetadata(session).inbox)return;
  refreshRootMemo();
  const topicId=topicOfRoot(answer.root);
  if(!topicId)return;
  const seen=(eventId:string)=>!!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId);
  const by:TopicBy={kind:'owner',sessionId:answer.respondingSessionId};
  const agent=answer.respondingTitle||'The agent working on this';
  db.transaction(()=>{
    // Done work closes the thread request it was sent for, exactly when the router could have closed it.
    if(answer.disposition==='completed') {
      for(const request of topicRequests(topicId).filter(item=>item.state==='open'&&item.dispatches.some((dispatch:any)=>String(dispatch?.requestId??'')===answer.dispatchRequestId)
        &&sharedAnswerPostId(answer.dispatchRequestId)===null)) {
        const eventId=`topic-close:answer:${answer.eventId}:${request.requestId}`;
        if(seen(eventId))continue;
        const topic=topicRow(topicId);
        try{refuseUnfinishedCompletion(topic,request);}catch(error){if(error instanceof TopicError)continue;throw error;}
        const at=nowIso(),why=`${agent} answered it as done.`;
        const next={...request,state:'closed' as const,disposition:'completed',closure:{by,at,reason:why,evidence:[answer.postId]},revision:request.revision+1,updatedAt:at};
        const questions=expireOpen(questionsOfRequest(topicId,request),`The request it was for closed (completed): ${why}`,at);
        const topicNext=bumped(topic);
        const payload={change:'request_closed',topicId,topic:topicNext,request:next,by,reason:why,revision:topicNext.revision,questions};
        recordSessionEvent({eventId,sessionId:session.id,kind:'topic_request',payload});
        applyTopicChange('topic_request',payload);
      }
    }
    const filedId=`topic-answer:${answer.eventId}`;
    if(seen(filedId))return;
    // Completed work its agent said he need not read is posted and closes its request, and is filed
    // for nobody: no reading item, no notification [decision: sends-notify-only-on-failure].
    if(answer.quiet&&answer.disposition==='completed'&&!answer.notify&&(!answer.text.trim()||!hasPendingThreadNotification(session.id,answer.root))){
      log('info','inbox_answer_quiet',{thread:answer.root,post:answer.postId,request_id:answer.dispatchRequestId});
      return;
    }
    const decision=answer.disposition==='needs_decision';
    const open=topicQuestions(topicId).filter(question=>OPEN_QUESTION_STATES.includes(question.state));
    // One answer posted once is filed once, however many requests it closed.
    if(!decision&&open.some(question=>question.kind==='reading'&&Array.isArray(question.brief?.reads)&&question.brief.reads.includes(answer.postId))){
      if(answer.text.trim()&&(answer.notify||hasPendingThreadNotification(session.id,answer.root)))notifyAgentPost(session.id,answer.root,answer.postId,answer.text,answer.notify===true);
      return;
    }
    // What he reads first, on his Lock Screen and in Needs you, is the agent's own one-line summary:
    // an answer that opened with background buried "class not cancelled" in its second paragraph
    // (Chelsea Piers, 2026-11-02, report 'Class cancellation result obscured in notification').
    const summary=answer.summary?.trim()??'';
    const words=summary&&!answer.text.trim().startsWith(summary)?`${summary}\n\n${answer.text.trim()}`:answer.text.trim();
    const lead=summary||headline(words);
    const brief=decision
      ?{decision:words.slice(0,2000),why:{text:`${agent} needs this from you to go on. Reply in this thread: your reply goes straight to that agent.`,sources:[answer.postId]},
        known:'',choices:[],uncertain:[],answerable:'Your reply in this thread, which goes to the agent that asked.'}
      :{decision:answer.disposition==='failed'?`Not done: ${lead}`:!fragmentReason(lead)?lead:lead?`${agent} answered: ${lead}`:'An agent answered in this thread.',
        why:{text:'',sources:[answer.postId]},known:'',choices:[],uncertain:[],answerable:'',reads:[answer.postId]};
    if(decision&&open.some(question=>decisionKey(question.brief?.decision??'')===decisionKey(brief.decision)
      ||sameAsk(question,answer.respondingSessionId,answer.askedInRun??null))){
      if(words&&(answer.notify||hasPendingThreadNotification(session.id,answer.root)))notifyAgentPost(session.id,answer.root,answer.postId,words,answer.notify===true);
      return;
    }
    const notificationInputId=words?consumeThreadNotification(session.id,answer.root,answer.postId):null;
    const requestedResult=!!notificationInputId||!!words&&!!answer.notify&&!messageAlreadyNotified(session.id,answer.postId);
    const at=nowIso(),generation=raiseGeneration(session);
    const question:StoredQuestion={questionId:`q:${randomUUID()}`,topicId,revision:1,state:'open',blocking:decision,optional:false,context:'ready',brief,
      // A decision belongs to the agent that asked, so its later final reply or the request's closure ends it;
      // a reading item is the Inbox's and ends only with his Read.
      owner:decision?{sessionId:answer.respondingSessionId,dispatchRequestId:answer.dispatchRequestId,...(answer.askedInRun?{askedInRun:answer.askedInRun}:{}),...(answer.todoId?{todoId:answer.todoId}:{})}:{sessionId:`concierge:${session.id}`,answeredBy:answer.respondingSessionId,answersRequest:answer.dispatchRequestId},
      sources:[answer.root,answer.postId],replaces:null,replacedBy:null,answer:null,recovered:false,legacyNeedEventId:null,
      kind:decision?'decision':'reading',origin:'declared',generation,createdAt:at,updatedAt:at};
    const topic=topicRow(topicId),topicNext=bumped(topic);
    const payload={change:'reconciled',topicId,topic:topicNext,questions:[question],by,reason:`${agent} answered in this thread`,revision:topicNext.revision};
    recordSessionEvent({eventId:filedId,sessionId:session.id,kind:'topic_question',payload});
    applyTopicChange('topic_question',payload);
    // The thread's one notification slot: the Inbox session, the thread's root as its input, shaped like a new question's.
    recordSessionEvent({eventId:`needs_you:${filedId}`,sessionId:session.id,inputId:answer.root,kind:'needs_you',
      payload:{outcome:requestedResult?'response':decision?'needs_you':'response',question:requestedResult?words.slice(0,2000):brief.decision,
        inputId:answer.root,generation,topicId,questionId:question.questionId,postId:answer.postId,
        ...(decision&&answer.todoId&&answer.todoId!=='none'?{todoId:answer.todoId}:{}),
        ...(decision?{blockingNotification:true,agentName:sessionAuthor(answer.respondingSessionId)?.agentName??null,
          taskTitle:answer.respondingTitle??sessionAuthor(answer.respondingSessionId)?.title??null}:{}),
        ...(requestedResult?{requestedNotification:true}:{}),...(notificationInputId?{notificationInputId}:{})}});
  })();
}

/* ------------------------------------------------------------------ thread upkeep */

/*
 * Threads keep themselves current; nobody has to remember to tidy them (Tejas, 2026-10-12, capture
 * d30a141a: "you're not maintaining the threads, so a lot of threads that could be closed are still
 * in my thread view"). On that day 71 open threads held requests whose work had long ended, for
 * three reasons this section removes: his replies to the agent working on a request were never
 * counted as that request's work, so the answer to his reply closed nothing; an agent's "could not
 * finish" answer goes into the thread instead of to the router, so nobody ever closed its request;
 * and no thread ever closed itself. The rules, all decided here and by the owner:
 * - A request follows its work. Once nothing sent for it is running, its latest answer decides:
 *   done closes it completed (the same rule the router is held to). A failed or cancelled attempt
 *   leaves his request open and sends it back for recovery. His own Stop ends only that attempt.
 *   Any other end is also sent to the router for recovery.
 * - A thread closes itself when the last thing in it ends: no open request, nothing waiting on him
 *   (an unread answer counts), no work running for it, not set aside. It is decided at that ending
 *   (a request closing, a question ending, an agent's final answer), never by a pass over quiet
 *   threads, so a thread he or the router reopened stays open until something in it ends again.
 * - A closed thread reopens when he writes in it or new work is placed there.
 */
const OWNER_BY:TopicBy={kind:'owner'};
type Work={id:string;outcome:string|null;disposition:string|null;requestedEffect:string|null;target:string|null;createdAtMs:number;stalled:boolean;
  stoppedByTejas?:boolean;notCheckedReason?:string|null};
const dispositionOf=(resultJson:string|null)=>{
  if(!resultJson)return null;
  try{const value=JSON.parse(resultJson).workDisposition;return typeof value==='string'?value:null;}catch{return null;}
};
const stoppedByTejasOf=(resultJson:string|null)=>{
  if(!resultJson)return false;
  try{return JSON.parse(resultJson)?.output?.stoppedBy==='tejas';}catch{return false;}
};
const notCheckedReasonOf=(resultJson:string|null)=>{
  if(!resultJson)return null;
  try{return notSeenWorking(JSON.parse(resultJson).closingLine);}catch{return null;}
};
function workRow(id:string):Work|null {
  const local=db.query("SELECT target_session_id,outcome,result_json,created_at_ms,stalled_at_ms,json_extract(payload_json,'$.requestedEffect') AS requested_effect FROM session_communication_requests WHERE request_id=?").get(id) as any;
  if(local)return {id,outcome:local.outcome,disposition:dispositionOf(local.result_json),requestedEffect:local.requested_effect,target:`concierge:${local.target_session_id}`,createdAtMs:local.created_at_ms,stalled:local.stalled_at_ms!==null,stoppedByTejas:stoppedByTejasOf(local.result_json),notCheckedReason:notCheckedReasonOf(local.result_json)};
  const peer=db.query("SELECT peer,remote_session_id,outcome,result_json,created_at_ms,stalled_at_ms,json_extract(payload_json,'$.requestedEffect') AS requested_effect FROM session_peer_requests WHERE request_id=?").get(id) as any;
  return peer?{id,outcome:peer.outcome,disposition:dispositionOf(peer.result_json),requestedEffect:peer.requested_effect,target:receiveSessionFromPeer(peer.remote_session_id,peer.peer),createdAtMs:peer.created_at_ms,stalled:peer.stalled_at_ms!==null,stoppedByTejas:stoppedByTejasOf(peer.result_json),notCheckedReason:notCheckedReasonOf(peer.result_json)}:null;
}
/** His replies in a thread that went to an agent (`forwardReply`), each with the root it was sent for. */
type Forward=Work&{root:string|null;inboxInputId:string|null};
function forwardedReplies(onlyRequestId?:string):Forward[] {
  const local=(db.query(`SELECT request_id,target_session_id,outcome,result_json,created_at_ms,stalled_at_ms,thread_root_input_id,
      json_extract(payload_json,'$.requestedEffect') AS requested_effect,
      json_extract(payload_json,'$.forwardedReply.inboxInputId') AS inbox_input_id FROM session_communication_requests
    WHERE json_extract(payload_json,'$.forwardedReply') IS NOT NULL ${onlyRequestId?'AND request_id=?':''}`).all(...(onlyRequestId?[onlyRequestId]:[])) as any[])
    .map(row=>({id:row.request_id,outcome:row.outcome,disposition:dispositionOf(row.result_json),notCheckedReason:notCheckedReasonOf(row.result_json),requestedEffect:row.requested_effect,target:`concierge:${row.target_session_id}`,createdAtMs:row.created_at_ms,stalled:row.stalled_at_ms!==null,root:row.thread_root_input_id,inboxInputId:row.inbox_input_id}));
  const peer=(db.query(`SELECT request_id,peer,remote_session_id,outcome,result_json,created_at_ms,stalled_at_ms,thread_root_input_id,
      json_extract(payload_json,'$.requestedEffect') AS requested_effect,
      json_extract(payload_json,'$.forwardedReply.inboxInputId') AS inbox_input_id FROM session_peer_requests
    WHERE json_extract(payload_json,'$.forwardedReply') IS NOT NULL ${onlyRequestId?'AND request_id=?':''}`).all(...(onlyRequestId?[onlyRequestId]:[])) as any[])
    .map(row=>({id:row.request_id,outcome:row.outcome,disposition:dispositionOf(row.result_json),notCheckedReason:notCheckedReasonOf(row.result_json),requestedEffect:row.requested_effect,target:receiveSessionFromPeer(row.remote_session_id,row.peer),createdAtMs:row.created_at_ms,stalled:row.stalled_at_ms!==null,root:row.thread_root_input_id,inboxInputId:row.inbox_input_id}));
  return [...local,...peer].sort((first,second)=>first.createdAtMs-second.createdAtMs);
}
/** The work whose posted answer his forwarded reply replied to, when he replied to one. */
function workHisReplyAnswered(forward:Forward):string|null {
  const input=forward.inboxInputId?getAcceptedSessionInput(forward.inboxInputId):null;
  if(!input)return null;
  let messageId:unknown;
  try{messageId=JSON.parse(input.payload_json)?.replyToMessage?.messageId;}catch{return null;}
  if(typeof messageId!=='string'||!messageId.startsWith('post:forward:'))return null;
  const post=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(messageId) as {payload_json:string}|null;
  const requestId=post?JSON.parse(post.payload_json).requestId:null;
  return typeof requestId==='string'?requestId:null;
}
/** Work still running for a thread: anything sent for one of its roots that has no outcome yet. */
function workRunningIn(topicId:string):boolean {
  const roots=new Set(topicRoots(topicId));
  if(!roots.size)return false;
  const pending=[...(db.query('SELECT thread_root_input_id AS root FROM session_communication_requests WHERE outcome IS NULL').all() as {root:string|null}[]),
    ...(db.query('SELECT thread_root_input_id AS root FROM session_peer_requests WHERE outcome IS NULL').all() as {root:string|null}[])];
  return pending.some(row=>!!row.root&&roots.has(row.root));
}
function recordOwnerTopicChange(sessionId:number,eventId:string,kind:string,payload:any):boolean {
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return false;
  recordSessionEvent({eventId,sessionId,kind,payload});
  applyTopicChange(kind,payload);
  return true;
}

/** Exact-message routing creates durable work without guessing from a shared thread. */
export function linkInboxDispatchWork(input:{topicId:string;sourceMessageId:string;dispatchId:string;targetSessionId:string;summary:string;brief:string}) {
  const topic=topicRow(input.topicId);
  const requests=topicRequests(input.topicId);
  const exact=requests.filter(request=>request.sources.some(source=>source.inputId===input.sourceMessageId));
  const existing=exact.length===1?exact[0]:null;
  const at=nowIso();
  const dispatch={requestId:input.dispatchId,targetSessionId:input.targetSessionId,targetTitle:null,outcome:null,state:'recorded'};
  if(existing){
    if(existing.dispatches.some((item:any)=>item.requestId===input.dispatchId))return existing.requestId;
    const sources=existing.sources.some(source=>source.inputId===input.sourceMessageId)?existing.sources:[...existing.sources,{inputId:input.sourceMessageId}];
    const next={...existing,state:'open' as const,disposition:null,closure:null,sources,dispatches:[...existing.dispatches,dispatch],revision:existing.revision+1,updatedAt:at};
    const change=reopenedForNewWork({kind:'topic_request',payload:{change:'linked',topicId:topic.topicId,topic:bumped(topic),request:next,by:OWNER_BY,
      reason:'This work dispatch belongs to the open request in its Inbox thread.',revision:topic.revision+1}});
    recordOwnerTopicChange(topic.sessionId,`topic-link:routed:${input.dispatchId}`,'topic_request',change.payload);
    return existing.requestId;
  }
  const request:StoredRequest={requestId:`req:${randomUUID()}`,topicId:topic.topicId,title:input.summary.slice(0,200)||topic.title,
    brief:input.brief.trim()?input.brief.slice(0,8000):`The message and its attachments are retained at ${input.sourceMessageId}.`,
    state:'open',disposition:null,revision:1,sources:[{inputId:input.sourceMessageId}],
    dispatches:[dispatch],closure:null,createdAt:at,updatedAt:at};
  const change=reopenedForNewWork({kind:'topic_request',payload:{change:'added',topicId:topic.topicId,topic:bumped(topic),request,by:OWNER_BY,
    reason:'Work sent from this Inbox thread must have a durable request.',revision:topic.revision+1}});
  recordOwnerTopicChange(topic.sessionId,`topic-request:routed:${input.dispatchId}`,'topic_request',change.payload);
  return request.requestId;
}

/** A change that places new work in a closed thread opens it again, with what its closure ended. */
const NEW_WORK_CHANGES=new Set(['placed','routed','added','linked','request_reopened']);
function reopenedForNewWork(change:Change):Change {
  const topic=change.payload?.topic as StoredTopic|undefined;
  if(!NEW_WORK_CHANGES.has(change.payload?.change)||topic?.state!=='closed'||topic.closure?.kind==='merged')return change;
  const restored=restoreExpiredByClosure(topic,nowIso());
  return {...change,payload:{...change.payload,topic:{...topic,state:'open',closure:null,setAside:null},
    questions:[...(change.payload.questions??[]),...restored],reopened:'New work was placed in this thread.'}};
}
/** Whether a change ended a request or a question: the moment a thread may have become finished. */
const QUESTION_ENDING_CHANGES=new Set(['settled','reconciled','recorded','acknowledged','followup']);
function endedSomething(payload:any):boolean {
  if(typeof payload?.topicId!=='string')return false;
  if(payload.change==='request_closed')return true;
  return QUESTION_ENDING_CHANGES.has(payload.change)
    &&(payload.questions??[]).some((question:StoredQuestion)=>!OPEN_QUESTION_STATES.includes(question.state as any)&&question.state!=='deferred');
}
/**
 * Every live topic change passes here after it is applied, from every path (the router's and his
 * commands, the owner's own filings, "mark seen"), so no path can skip the rule: something new
 * waiting on him in a closed thread opens it, and an ending that left nothing closes it.
 */
let upkeepDepth=0;
function keepThreadOpenOrClosed(payload:any) {
  const topicId=payload?.topicId;
  if(typeof topicId!=='string'||upkeepDepth)return;
  upkeepDepth++;
  try {
    const row=db.query('SELECT * FROM inbox_topics WHERE topic_id=?').get(topicId) as any;
    if(!row)return;
    const topic=toStoredTopic(row);
    if(topic.state==='closed'&&topic.closure?.kind!=='merged'&&topicQuestions(topicId).some(question=>OPEN_QUESTION_STATES.includes(question.state))) {
      const why='Something new is waiting on him here.';
      const next=bumped(topic,{state:'open',closure:null,setAside:null});
      recordOwnerTopicChange(topic.sessionId,`topic-reopen:waiting:${topicId}:${topic.revision}`,'topic',{change:'reopened',topicId,topic:next,by:OWNER_BY,reason:why,revision:next.revision,questions:[]});
    } else if(endedSomething(payload)) {
      closeThreadIfFinished(topicId,String(payload.change));
    }
  } finally {upkeepDepth--;}
}
/** What still keeps a thread open, or null when nothing does. */
function whyThreadStaysOpen(topic:StoredTopic):string|null {
  if(topic.state!=='open')return 'already closed';
  if(topic.setAside)return 'set aside';
  if(topicRequests(topic.topicId).some(request=>request.state==='open'))return 'a request is open';
  if(topicQuestions(topic.topicId).some(question=>OPEN_QUESTION_STATES.includes(question.state)||(question.state==='deferred'&&!!question.deferUntil)))return 'something waits on him';
  if(workRunningIn(topic.topicId))return 'work is running';
  return null;
}
function closeThreadIfFinished(topicId:string,cause:string):boolean {
  const topic=db.query('SELECT * FROM inbox_topics WHERE topic_id=?').get(topicId) as any;
  if(!topic)return false;
  const stored=toStoredTopic(topic);
  if(whyThreadStaysOpen(stored))return false;
  const requests=topicRequests(topicId);
  const last=[...requests].sort((first,second)=>String(first.closure?.at??first.updatedAt).localeCompare(String(second.closure?.at??second.updatedAt))).at(-1);
  const why=last?`Everything asked here is finished; the last request, "${last.title}", closed ${last.disposition??'closed'}.`:'Nothing here is open or waiting on him any more.';
  const at=nowIso(),next=bumped(stored,{state:'closed',closure:{by:OWNER_BY,at,reason:why,scope:null,automatic:true,requests:requests.map(request=>request.requestId)}});
  const payload={change:'closed',topicId,topic:next,scope:null,by:OWNER_BY,reason:why,revision:next.revision,questions:[]};
  const recorded=recordOwnerTopicChange(stored.sessionId,`topic-autoclose:${topicId}:${stored.revision}`,'topic',payload);
  if(recorded)log('info','inbox_thread_closed_itself',{topic_id:topicId,cause,requests:requests.length});
  return recorded;
}

/** A reply joins earlier work only when its addressed answer proves which work it continues. */
function forwardRecoveryStartMs(sessionId:number):number {
  const eventId='topic-forward-recovery-start';
  const existing=db.query('SELECT payload_json FROM session_owner_events WHERE event_id=?').get(eventId) as {payload_json:string}|null;
  if(existing)return Number(JSON.parse(existing.payload_json).atMs);
  const atMs=Date.now();
  recordSessionEvent({eventId,sessionId,kind:'topic_request',payload:{change:'forward_recovery_started',atMs}});
  return atMs;
}
function linkForwardedReplies(topicId:string,forwards:Forward[],admittingNow=false):number {
  const roots=new Set(topicRoots(topicId));
  const mine=forwards.filter(forward=>!!forward.root&&roots.has(forward.root));
  const recoveryStart=forwardRecoveryStartMs(topicRow(topicId).sessionId);
  let linked=0;
  for(const forward of mine) {
    const source=forward.inboxInputId?getAcceptedSessionInput(forward.inboxInputId):null;
    if(source?.origin!=='human')continue;
    // A shared agent and thread do not establish that his new message continues earlier work.
    // A reply to a different answer must never settle that earlier request.
    const requests=topicRequests(topicId);
    const answered=workHisReplyAnswered(forward);
    const byAnswer=answered?requests.filter(request=>request.dispatches.some((dispatch:any)=>dispatch.requestId===answered)):[];
    const bySource=forward.inboxInputId?requests.filter(request=>request.sources.some(source=>source.inputId===forward.inboxInputId)):[];
    const targets=byAnswer.length===1?byAnswer:bySource.length===1?bySource:[];
    const unresolved=forward.outcome!=='answered'||forward.disposition!=='completed'||!!forward.notCheckedReason;
    if(!targets.length&&(admittingNow||forward.createdAtMs>=recoveryStart||unresolved)&&forward.inboxInputId
      &&!requests.some(request=>request.dispatches.some((dispatch:any)=>dispatch.requestId===forward.id))) {
      if(source.origin==='human') {
        const topic=topicRow(topicId);
        const words=JSON.parse(source.payload_json)?.text;
        const request:StoredRequest={requestId:`req:forward:${forward.id}`,topicId,title:`Follow-up in ${topic.title}`.slice(0,200),
          brief:typeof words==='string'&&words.trim()?words.slice(0,8000):`His reply and attachments are retained at ${source.id}.`,
          state:'open',disposition:null,revision:1,sources:[{inputId:source.id}],
          dispatches:[{requestId:forward.id,targetSessionId:forward.target,targetTitle:null,outcome:forward.outcome,state:null,forwardedReply:true}],
          closure:null,createdAt:iso(source.created_at)!,updatedAt:nowIso()};
        const next=bumped(topic);
        const change=reopenedForNewWork({kind:'topic_request',payload:{change:'added',topicId,topic:next,request,by:OWNER_BY,
          reason:'His reply to an agent is its own request when no earlier request is identified.',revision:next.revision}});
        if(recordOwnerTopicChange(topic.sessionId,`topic-request:forward:${forward.id}`,'topic_request',change.payload))linked++;
      }
    }
    for(const request of targets) {
      if(request.dispatches.some((dispatch:any)=>dispatch.requestId===forward.id))continue;
      const earlier=request.dispatches.map((dispatch:any)=>workRow(String(dispatch?.requestId??''))).filter((work):work is Work=>!!work);
      // Historical forwards already considered by a completed request are not new work.
      // A later continuation still links even when its attempt stalled or ended.
      const closedAtMs=request.closure?.at?new Date(iso(request.closure.at)!).getTime():0;
      if(request.state==='closed'&&(forward.createdAtMs<=closedAtMs||(!admittingNow&&forward.createdAtMs<recoveryStart&&!unresolved)))continue;
      const dispatch={requestId:forward.id,targetSessionId:forward.target,targetTitle:null,outcome:forward.outcome,state:null,forwardedReply:true};
      const created=new Map(earlier.map(work=>[work.id,work.createdAtMs]));
      const dispatches=[...request.dispatches,dispatch].sort((first:any,second:any)=>
        (created.get(first.requestId)??forward.createdAtMs)-(created.get(second.requestId)??forward.createdAtMs));
      const reopen=request.state==='closed';
      const at=nowIso();
      const next={...request,dispatches,...(reopen?{state:'open' as const,disposition:null,closure:null,
        completionFloor:request.dispatches.length,reopenedAt:new Date(forward.createdAtMs-1).toISOString()}:{}),revision:request.revision+1,updatedAt:at};
      const topic=topicRow(topicId);
      const why=reopen?'His later reply to the agent reopened this request.':'His reply to the agent working on it is part of its work.';
      const change=reopenedForNewWork({kind:'topic_request',payload:{change:'linked',topicId,topic:bumped(topic),request:next,by:OWNER_BY,reason:why,revision:topic.revision+1}});
      if(recordOwnerTopicChange(topic.sessionId,`topic-link:forward:${forward.id}:${request.requestId}`,'topic_request',change.payload))linked++;
    }
  }
  return linked;
}
/** Admit one direct human reply into the topic ledger in the same transaction as its dispatch. */
export function linkForwardedReplyWork(topicId:string,dispatchId:string):number {
  return linkForwardedReplies(topicId,forwardedReplies(dispatchId),true);
}

type Stuck={topicId:string;topicTitle:string;requestId:string;title:string;work:string;how:string;key:string;sourceInputId:string|null;sourceRunId:string|null;sourceUncertain:boolean;stoppedByTejas:boolean;sharedAnswerPostId:string|null};
function sharedAnswerPostId(workId:string):string|null {
  const inbox=inboxSession();
  if(!inbox)return null;
  const shared=db.query(`SELECT count(*) AS count,
      max(CASE WHEN json_extract(dispatch.value,'$.sharedAcrossTopic')=1 THEN 1 ELSE 0 END) AS cross_topic
    FROM inbox_requests request,json_each(request.dispatches_json) dispatch
    WHERE request.dispatches_json LIKE ? AND json_extract(dispatch.value,'$.requestId')=?`).get(`%${workId}%`,workId) as {count:number;cross_topic:number|null};
  if(shared.count<2&&!shared.cross_topic)return null;
  const closure=db.query(`SELECT json_extract(payload_json,'$.postId') AS post_id FROM session_owner_events
    WHERE session_id=? AND kind='answer_closure' AND json_extract(payload_json,'$.requestId')=? ORDER BY sequence DESC LIMIT 1`)
    .get(inbox.id,workId) as {post_id:string|null}|null;
  return closure?.post_id??'';
}
function recoverySource(request:StoredRequest):{inputId:string;runId:string;uncertain:boolean}|null {
  const dispatchSources=request.dispatches.flatMap((dispatch:any)=>{
    const id=String(dispatch?.requestId??'');
    const local=db.query('SELECT source_input_id FROM session_communication_requests WHERE request_id=?').get(id) as {source_input_id:string}|null;
    const peer=local?null:db.query('SELECT source_input_id FROM session_peer_requests WHERE request_id=?').get(id) as {source_input_id:string}|null;
    return [local?.source_input_id??peer?.source_input_id].filter((value):value is string=>!!value);
  });
  const linked=[...request.sources.map(source=>source.inputId),...dispatchSources];
  const candidates=[...linked,...topicRoots(request.topicId)];
  for(const [index,id] of candidates.entries()){
    const input=getAcceptedSessionInput(id);
    if(!input?.turn_id)continue;
    const provenance=input.origin==='human'?null:sessionInputProvenance(input);
    if(input.origin!=='human'&&(!provenance?.originatingHuman||provenance.effectScope!=='work'))continue;
    if(input.origin==='human'&&new Date(iso(input.created_at)!).getTime()>new Date(iso(request.createdAt)!).getTime())continue;
    return {inputId:input.id,runId:nativeRunId(input.turn_id),uncertain:index>=linked.length};
  }
  return null;
}
/** A recovery remains due until another dispatch is linked or a checked completion closes it. */
function nextRecoveryAttempt(item:Stuck):number|null {
  const prefix=`topic-recovery:${item.key}:`;
  const latest=db.query(`SELECT event_id,payload_json,created_at FROM session_owner_events WHERE event_id>=? AND event_id<? ORDER BY sequence DESC LIMIT 1`)
    .get(prefix,`${prefix}\uffff`) as {event_id:string;payload_json:string;created_at:string}|null;
  if(!latest)return 0;
  const attempt=Number(latest.event_id.slice(prefix.length))+1;
  // A recovered input can be cancelled before it acquires a turn. That is a terminal
  // delivery, not a reason to leave the human request silent forever.
  const interval=Math.min(24*60*60*1000,15*60*1000*2**Math.min(attempt-1,7));
  const due=Date.now()-new Date(iso(latest.created_at)!).getTime()>=interval;
  const payload=JSON.parse(latest.payload_json);
  const inputId=typeof payload.recoveryInputId==='string'?payload.recoveryInputId:null;
  if(!inputId)return due?attempt:null;
  const input=db.query('SELECT turn_id,steering_id,receipt_json FROM session_inputs WHERE id=?').get(inputId) as {turn_id:number|null;steering_id:number|null;receipt_json:string|null}|null;
  if(!input)return due?attempt:null;
  const turnId=input.turn_id??(input.steering_id===null?null:(db.query('SELECT turn_id FROM turn_steering_messages WHERE id=?').get(input.steering_id) as {turn_id:number}|null)?.turn_id??null);
  if(turnId===null)return ['canceled','failed','uncertain'].includes(JSON.parse(input.receipt_json??'{}').state)?(due?attempt:null):null;
  const turn=carryingTurn(turnId);
  if(!turn||!['done','error','cancelled','interrupted'].includes(turn.status))return null;
  // Repeated router refusals remain due, but do not turn one stuck task into a hot loop.
  return due?attempt:null;
}
/**
 * Stuck requests whose latest attempt is the same dispatch come back to the router together.
 * One attempt shared by many requests used to come back as one recovery input each, one router
 * turn each, and the router sent the same agent a fresh request each time: on 2026-11-09 one
 * stalled attempt (1eb6fec9) linked across several threads became about a dozen requests to
 * concierge:3425 and spent the router's allowance. Requests with no attempt stay separate.
 */
export function recoveryGroups<T extends Pick<Stuck,'work'|'requestId'>>(items:T[]):T[][] {
  const groups=new Map<string,T[]>();
  for(const item of items) {
    const key=item.work==='unassigned'?`request:${item.requestId}`:`work:${item.work}`;
    const group=groups.get(key);
    if(group)group.push(item);else groups.set(key,[item]);
  }
  return [...groups.values()];
}
function recoveryInstruction(item:Stuck):string {
  return item.stoppedByTejas?'Tejas stopped that run. Do not restart it or its effects on your own; reconcile any effects already in flight and keep the human task open. If his intent for the remaining task is genuinely ambiguous, ask one focused only-he-can question.'
    :item.sharedAnswerPostId!==null?`The same answer was linked to several requests. Do not dispatch again merely to obtain a separate receipt. Read the answer ${item.sharedAnswerPostId||'on the shared dispatch'} and this request's scope; if it is fully checked, close this request citing that answer post as evidence, otherwise send only the missing work.`
    :'Inspect the exact prior attempt and its effects, then send the remaining work to its owning agent (sessions ask … --thread, then topics request link).';
}
const RECOVERY_TAIL='Never replay an ambiguous or acknowledged effect. Close only after the work is completed and checked, or keep an only-he-can question open for Tejas. A failure, hand-back, cancellation or provider error cannot close his request. You do not need to reply to this.';
const UNCERTAIN_SOURCE='The exact source of this request is not linked; establish original authorship and task scope from the retained thread before dispatching. ';
function recoveryText(item:Stuck):string {
  return `The request "${item.title}" (${item.requestId}) in "${item.topicTitle}" (${item.topicId}) is still open. Its latest attempt (${item.work}) ${item.how}. ${item.sourceUncertain?UNCERTAIN_SOURCE:''}${recoveryInstruction(item)} ${RECOVERY_TAIL}`;
}
export function groupedRecoveryText(items:Stuck[]):string {
  const lines=items.map(item=>`- "${item.title}" (${item.requestId}) in "${item.topicTitle}" (${item.topicId}): the attempt ${item.how}. ${item.sourceUncertain?UNCERTAIN_SOURCE:''}${recoveryInstruction(item)}`);
  return `${items.length} open requests share one latest attempt (${items[0].work}), so they come to you together:\n${lines.join('\n')}\n\nInspect that attempt and its effects once. Remaining work for these requests goes to its owning agent as ONE request (one sessions ask … --thread naming one of these threads, its text covering every request that still needs work), then link that one dispatch to each request it covers (topics request link). Do not send that agent one request per thread. ${RECOVERY_TAIL}`;
}
/** The agent sessions a question's work is held by: its declaring agent, else where its linked work went. */
function questionAgents(question:StoredQuestion,routerAddress:string):string[] {
  const owner=question.owner??{};
  if(typeof owner.sessionId==='string'&&owner.sessionId!==routerAddress)return [owner.sessionId];
  let dispatchIds:string[]=[];
  if(owner.dispatchRequestId)dispatchIds=[String(owner.dispatchRequestId)];
  else if(owner.requestId){
    const row=db.query('SELECT * FROM inbox_requests WHERE request_id=?').get(owner.requestId) as any|null;
    if(row)dispatchIds=toStoredRequest(row).dispatches.map((dispatch:any)=>String(dispatch?.requestId??''));
  }
  // Only the agent holding the newest work: an older attempt's agent is no longer waiting on this.
  const newest=dispatchIds.map(id=>workRow(id)).filter((work):work is Work=>!!work?.target)
    .sort((left,right)=>right.createdAtMs-left.createdAtMs)[0];
  return newest?.target?[newest.target]:[];
}
/**
 * A ready question Tejas has open that the agent holding this attempt was already waiting on when
 * the attempt was sent. Work sent to an agent that is blocked on him waits with it, even when the
 * question sits in another request or thread and cannot name this one (2026-11-04: two saving
 * requests sent to the writing agent while it waited on "Please unlock your Mac" were flagged as
 * dropped every half hour).
 */
function agentWaitingOnHim(latest:Work,read:ReadIndex,routerAddress:string):string|null {
  if(!latest.target)return null;
  const questions=(db.query(`SELECT * FROM inbox_questions WHERE kind='decision' AND state IN ('open','partial')
    AND context='ready' AND created_at<=?`).all(new Date(latest.createdAtMs).toISOString()) as any[]).map(toStoredQuestion);
  for(const question of questions) {
    if(!questionAgents(question,routerAddress).includes(latest.target))continue;
    if(awaitingHim(questionView(question,latestHumanReply(read,topicRoots(question.topicId)))))return question.questionId;
  }
  return null;
}
/**
 * Settles open requests with checked completion or an explicit human Stop. Returns all other
 * obligations with no live attempt or ready question to the router for recovery.
 */
function settleEndedRequests(topicId:string,read:ReadIndex):{stuck:Stuck[];settled:number} {
  const stuck:Stuck[]=[];
  let settled=0;
  const replies=latestHumanReply(read,topicRoots(topicId));
  for(const request of topicRequests(topicId).filter(item=>item.state==='open')) {
    const topic=topicRow(topicId);
    if(topic.state==='closed'&&topic.closure?.by?.kind==='human'
      &&Array.isArray(topic.closure.requests)&&topic.closure.requests.includes(request.requestId)) {
      const at=nowIso();
      const next={...request,state:'closed' as const,disposition:'withdrawn',
        closure:{by:topic.closure.by,at:topic.closure.at??at,reason:`Thread closed by Tejas: ${topic.closure.reason??''}`,
          evidence:[topicId]},revision:request.revision+1,updatedAt:at};
      const topicNext=bumped(topic);
      if(recordOwnerTopicChange(topic.sessionId,`topic-human-close-request:${request.requestId}:${topic.closure.at}`,'topic_request',
        {change:'request_closed',topicId,topic:topicNext,request:next,by:OWNER_BY,reason:'Tejas closed the thread with this request in it.',
          revision:topicNext.revision,questions:[]}))settled++;
      continue;
    }
    const works=request.dispatches.map((dispatch:any)=>workRow(String(dispatch?.requestId??''))).filter((work):work is Work=>!!work)
      .sort((left,right)=>left.createdAtMs-right.createdAtMs||left.id.localeCompare(right.id));
    if(works.some(work=>work.outcome===null&&!work.stalled))continue;
    if(!works.length&&Date.now()-new Date(iso(request.createdAt)!).getTime()<15*60*1000)continue;
    const latest=works.at(-1);
    const dispatchIds=new Set(request.dispatches.map((dispatch:any)=>String(dispatch?.requestId??'')));
    const decisionViews=questionsOfRequest(topicId,request).filter(question=>question.kind==='decision')
      .map(question=>questionView(question,replies));
    const openRequests=topicRequests(topicId).filter(candidate=>candidate.state==='open');
    const legacyViews=topicQuestions(topicId).filter(question=>question.kind==='decision'&&OPEN_QUESTION_STATES.includes(question.state)
      &&unlinkedQuestionImplies(question,request,openRequests)).map(question=>questionView(question,replies));
    const pendingAnswer=[...decisionViews,...legacyViews].find(question=>!!question.pendingReply)?.pendingReply;
    const sharedDecisionWaiting=latest?.disposition==='needs_decision'&&request.dispatches.some((dispatch:any)=>dispatch.sharedAcrossTopic&&dispatch.requestId===latest.id)
      &&!!db.query(`SELECT 1 FROM inbox_questions WHERE kind='decision' AND state IN ('open','partial','deferred')
        AND context='ready' AND blocking=1 AND optional=0 AND json_extract(owner_json,'$.dispatchRequestId')=? LIMIT 1`).get(latest.id);
    const waitingOnHim=sharedDecisionWaiting||(!!latest&&latest.outcome===null&&!!agentWaitingOnHim(latest,read,`concierge:${topic.sessionId}`))||decisionViews.some(awaitingHim)||legacyViews.some(awaitingHim)||topicQuestions(topicId).some(question=>question.kind==='decision'&&question.state==='deferred'
      &&(question.owner?.requestId===request.requestId||dispatchIds.has(String(question.owner?.dispatchRequestId??''))||unlinkedQuestionImplies(question,request,openRequests)));
    let disposition:string|null=null,why='';
    let completionChecked=false;
    if(works.length>(request.completionFloor??0)&&latest
      &&(!request.reopenedAt||latest.createdAtMs>=new Date(request.reopenedAt).getTime())
      &&latest.outcome==='answered'
      &&((latest.disposition==='completed'&&!latest.notCheckedReason)||latest.requestedEffect==='informational')) {
      try{refuseUnfinishedCompletion(topic,request);completionChecked=true;}
      catch(error){if(!(error instanceof TopicError))throw error;}
      // The explicit completed reply accepts either a live check or an honest reason no live
      // check was possible. Its not-checked reason remains visible in the answer; the owner
      // cannot infer unfinished work from that reason alone.
      if(completionChecked&&sharedAnswerPostId(latest.id)===null){disposition='completed';why=latest.requestedEffect==='informational'?'The information requested was answered.':'The work sent for it answered as done.';}
    }
    if(!disposition&&waitingOnHim) {
      continue;
    }
    if(!disposition&&topic.setAside)continue;
    if(!disposition) {
      const sharedPost=latest?.outcome==='answered'&&latest.disposition==='completed'&&!latest.notCheckedReason
        ?sharedAnswerPostId(latest.id):null;
      let how=latest&&works.length<=(request.completionFloor??0)?'was reopened after its last linked completion; inspect the remaining obligation and record a new checked answer'
        :!latest?'has had no agent assigned'
        :sharedPost!==null?`answered as done in a dispatch shared by several requests; verify this request against ${sharedPost||'its retained answer post'} separately`
        :latest.outcome==='answered'&&latest.disposition==='completed'&&latest.notCheckedReason?`reported completion without a live check (${latest.notCheckedReason}); verify the result without repeating an acknowledged effect`
        :latest.outcome==='answered'&&latest.disposition==='completed'?'claimed completion without a verified result'
        :latest.stalled?'stalled without a final reply'
        :latest.disposition==='failed'?'failed without finishing the task'
        :latest.outcome==='canceled'&&latest.stoppedByTejas?'was stopped by Tejas; do not automatically restart the stopped work'
        :latest.outcome==='canceled'?'was cancelled without a replacement'
        :pendingAnswer?'has Tejas’s answer to its question but no resumed work'
        :latest.outcome==='decision_needed'?'asked for a decision that nobody is waiting on any more'
        :latest.outcome==='unanswered'?'never answered':latest.outcome==='undetermined'?'ended without saying whether it was done'
        :latest.outcome==='dependency_failed'?'was held behind work that did not succeed':`ended as ${latest.outcome}`;
      if(pendingAnswer)how+=`; Tejas's answer ${pendingAnswer.inputId} is waiting to be processed`;
      // A linked question still being prepared is not shown to him, so nothing waits on him yet;
      // the router's job is to finish it, not to send the work again (2026-11-04: five only-he-can
      // questions sat as agent_checking for want of why/answerable, invisible to him).
      for(const question of [...questionsOfRequest(topicId,request),...topicQuestions(topicId).filter(question=>OPEN_QUESTION_STATES.includes(question.state)
        &&unlinkedQuestionImplies(question,request,openRequests))].filter(question=>question.kind==='decision'&&preparingForHim(question)))
        how+=`; its question ${question.questionId} is still being prepared and is not shown to Tejas (missing ${missingFor(question).join(', ')||'context ready'}): complete it with topics questions (its questionId, the missing fields, context ready) instead of restarting work`;
      const unplaced=topicQuestions(topicId).filter(question=>question.kind==='decision'&&OPEN_QUESTION_STATES.includes(question.state)
        &&!(question.owner&&('requestId' in question.owner||question.owner.dispatchRequestId))&&!impliedRequest(openRequests,question.sources)).map(question=>question.questionId);
      if(unplaced.length)how+=`; open question ${unplaced.join(', ')} in this thread names no request: if it is what this request waits on, revise it with its questionId and owner.requestId ${request.requestId} instead of restarting work`;
      const source=recoverySource(request);
      stuck.push({topicId,topicTitle:topic.title,requestId:request.requestId,title:request.title,work:latest?.id??'unassigned',how,
        key:request.requestId,sourceInputId:source?.inputId??null,sourceRunId:source?.runId??null,sourceUncertain:!source||source.uncertain,
        stoppedByTejas:!!latest?.stoppedByTejas,sharedAnswerPostId:sharedPost});
      continue;
    }
    const at=nowIso();
    const next={...request,state:'closed' as const,disposition,closure:{by:OWNER_BY,at,reason:why,evidence:[latest.id]},revision:request.revision+1,updatedAt:at};
    const questions=expireOpen(questionsOfRequest(topicId,request),`The request it was for closed (${disposition}): ${why}`,at);
    const topicNext=bumped(topic);
    if(recordOwnerTopicChange(topic.sessionId,`topic-settle:${request.requestId}:${request.revision}:${latest.id}`,'topic_request',
      {change:'request_closed',topicId,topic:topicNext,request:next,by:OWNER_BY,reason:why,revision:topicNext.revision,questions}))settled++;
  }
  return {stuck,settled};
}

/**
 * Links his replies, settles ended requests and closes the thread when that left nothing in it.
 * `answered` marks an agent's final answer having just arrived here, itself an ending.
 */
function keepThreadCurrent(topicId:string,forwards=forwardedReplies(),answered=false,read=readIndex(inboxOrThrow().id)):Stuck[] {
  return db.transaction(()=>{
    linkForwardedReplies(topicId,forwards);
    const {stuck,settled}=settleEndedRequests(topicId,read);
    if(settled||answered)closeThreadIfFinished(topicId,answered?'answer':'settled');
    return stuck;
  })();
}

/**
 * His message in a closed thread opens it again: he is talking about it, so it belongs in his list.
 * Called on every message he sends to the Inbox; a message outside a placed thread changes nothing.
 */
export function reopenThreadForHisMessage(sessionId:number,inputId:string,replyToMessageId:unknown) {
  if(typeof replyToMessageId!=='string')return false;
  refreshRootMemo();
  const root=rootOf(sessionId,replyToMessageId);
  const topicId=root?topicOfRoot(root):null;
  if(!topicId)return false;
  const topic=topicRow(topicId);
  if(topic.state!=='closed'||topic.closure?.kind==='merged')return false;
  const author=getAcceptedSessionInput(inputId)?.origin;
  const at=nowIso(),why=author==='human'?'He wrote in this thread.':'An agent wrote in this thread through his entrance (a marked test).';
  const questions=restoreExpiredByClosure(topic,at);
  const next=bumped(topic,{state:'open',closure:null,setAside:null});
  return recordOwnerTopicChange(sessionId,`topic-reopen:his:${inputId}`,'topic',{change:'reopened',topicId,topic:next,by:OWNER_BY,reason:why,revision:next.revision,questions});
}

/**
 * The owner's pass over every open thread, every thread with his reply still being worked on,
 * and every closed thread that still has an open request. A human Close withdraws the
 * requests it named; a closed thread with other open work still receives recovery.
 * Runs on the reading cadence and startup.
 */
type ThreadUpkeepResult={threads:number;closed:number;settled:number;flagged:number};
let threadUpkeepPass:Promise<ThreadUpkeepResult>|null=null;
const yieldThreadUpkeep=()=>new Promise<void>(resolve=>setImmediate(resolve));
export function keepThreadsCurrent(admit?:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string;threadReplyNotRequired:true})=>unknown):Promise<ThreadUpkeepResult> {
  if(threadUpkeepPass)return threadUpkeepPass;
  const pass=keepThreadsCurrentPass(admit);
  threadUpkeepPass=pass;
  void pass.then(()=>{if(threadUpkeepPass===pass)threadUpkeepPass=null;},()=>{if(threadUpkeepPass===pass)threadUpkeepPass=null;});
  return pass;
}
async function keepThreadsCurrentPass(admit?:(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string;threadReplyNotRequired:true})=>unknown):Promise<ThreadUpkeepResult> {
  const session=inboxSession();
  if(!session)return {threads:0,closed:0,settled:0,flagged:0};
  refreshRootMemo();
  const forwards=forwardedReplies();
  const hasOpenDecision=!!db.query(`SELECT 1 FROM inbox_questions question
    JOIN inbox_requests request ON request.topic_id=question.topic_id AND request.state='open'
    WHERE question.state IN ('open','partial') AND question.kind='decision' LIMIT 1`).get();
  const read=hasOpenDecision?readIndex(session.id,true):{humanReplies:new Map<string,HumanReply[]>()};
  const running=new Set(forwards.filter(forward=>forward.outcome===null&&forward.root).map(forward=>topicOfRoot(forward.root!)).filter((id):id is string=>!!id));
  const open=(db.query(`SELECT topic_id FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND state='open'`).all(session.id) as {topic_id:string}[]).map(row=>row.topic_id);
  const closedWithOpenRequests=(db.query(`SELECT DISTINCT request.topic_id FROM inbox_requests request
    JOIN inbox_topics topic ON topic.topic_id=request.topic_id
    WHERE request.state='open' AND topic.session_id IN (${inboxLineageSql}) AND topic.state='closed'
      AND COALESCE(json_extract(topic.closure_json,'$.kind'),'')!='merged'`)
    .all(session.id) as {topic_id:string}[]).map(row=>row.topic_id);
  const closedBefore=(db.query(`SELECT count(*) AS count FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND state='closed'`).get(session.id) as {count:number}).count;
  const openRequestsBefore=(db.query("SELECT count(*) AS count FROM inbox_requests WHERE state='open'").get() as {count:number}).count;
  const stuck:Stuck[]=[];
  let nextYield=Date.now()+40;
  for(const topicId of new Set([...open,...running,...closedWithOpenRequests])) {
    try{stuck.push(...keepThreadCurrent(topicId,forwards,false,read));}
    catch(error){log('error','inbox_thread_upkeep_failed',{topic_id:topicId,message:error instanceof Error?error.message:String(error)});}
    if(Date.now()>=nextYield){await yieldThreadUpkeep();nextYield=Date.now()+40;}
  }
  const fresh:(Stuck&{attempt:number})[]=[];
  for(const item of stuck){
    const attempt=nextRecoveryAttempt(item);
    if(attempt!==null)fresh.push({...item,attempt});
    if(Date.now()>=nextYield){await yieldThreadUpkeep();nextYield=Date.now()+40;}
  }
  let flagged=0;
  if(fresh.length&&admit) {
    for(const group of recoveryGroups(fresh))try {
      if(flagged>=5)break;
      if(Date.now()>=nextYield){await yieldThreadUpkeep();nextYield=Date.now()+40;}
      // Another owner action can run while the sweep yields. Recheck exact work and human
      // answers before admitting recovery from an earlier view of this thread.
      const members:(Stuck&{attempt:number})[]=[];
      for(const snapshot of group) {
        const current=keepThreadCurrent(snapshot.topicId,forwards,false,readIndex(session.id,true))
          .find(candidate=>candidate.requestId===snapshot.requestId);
        if(!current||current.work!==snapshot.work||nextRecoveryAttempt(current)!==snapshot.attempt)continue;
        members.push({...current,attempt:snapshot.attempt});
      }
      if(!members.length)continue;
      // The input carries the first member with a linked source; a lone request keeps its
      // original identity and words, so inputs retained before grouping are recognized.
      const lead=members.find(member=>!member.sourceUncertain&&member.sourceInputId)??members[0];
      // Keep historical recovery from flooding one router turn. A refused admission does not
      // consume capacity, so an inaccessible first request cannot starve every later one.
      const identity=members.length===1?`${lead.key}:${lead.attempt}`:members.map(member=>`${member.key}:${member.attempt}`).sort().join('\n');
      const inputId=`thread-upkeep:${createHash('sha256').update(identity).digest('hex')}`;
      // An input already retained under this id was admitted by an earlier pass; only its flags are missing.
      if(!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(inputId))
        admit({sessionId:session.id,inputId,origin:'service',threadReplyNotRequired:true,sourceInputId:!lead.sourceUncertain&&lead.sourceInputId?lead.sourceInputId:inputId,
          sourceRunId:!lead.sourceUncertain&&lead.sourceRunId?lead.sourceRunId:inputId,requestId:lead.requestId,
          text:members.length===1?recoveryText(lead):groupedRecoveryText(members)});
      for(const item of members) {
      recordSessionEvent({eventId:`topic-recovery:${item.key}:${item.attempt}`,sessionId:session.id,kind:'topic_request',
        payload:{change:'flagged',topicId:item.topicId,requestId:item.requestId,work:item.work,by:OWNER_BY,recoveryInputId:inputId,reason:`Its work ${item.how}.`}});
      // Said in his thread, never rung: Concierge retrying its own recovery gives him nothing to
      // act on (Tejas, 2026-11-04: "notifications that were nothing I could actually act on").
      if(item.attempt>=2&&humanRequest(topicRow(item.topicId),requestRow(item.requestId))) {
        const eventId=`recovery-still-open:${item.requestId}`;
        const root=topicRoots(item.topicId)[0];
        if(root&&!db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`post:forward:${eventId}`))
          postAgentAnswer({inboxSessionId:session.id,eventId,requestId:item.work,root,inboxInputId:root,
            respondingSessionId:`concierge:${session.id}`,text:item.stoppedByTejas
              ?'Your request remains open after you stopped the agent run. Concierge has not restarted that run; it is checking what remains and will ask only if your direction is needed.'
              :item.sharedAnswerPostId!==null
                ?'Your request remains open while Concierge checks whether the agent’s shared answer covered this part of your work. You do not need to repeat it.'
                :'Your request is still open. Concierge has tried twice to restart its work, but no new agent attempt is linked yet. It will keep trying; you do not need to repeat it.',
            attachments:[],stalled:false,final:false,notify:false,workDisposition:null});
      }
      }
      flagged++;
    } catch(error) {log('error','inbox_thread_upkeep_flag_failed',{request_id:group[0].requestId,requests:group.length,message:error instanceof Error?error.message:String(error)});}
  }
  const closed=(db.query(`SELECT count(*) AS count FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND state='closed'`).get(session.id) as {count:number}).count-closedBefore;
  const settled=openRequestsBefore-(db.query("SELECT count(*) AS count FROM inbox_requests WHERE state='open'").get() as {count:number}).count;
  if(closed||settled||flagged)log('info','inbox_threads_kept_current',{threads:open.length,closed,settled,flagged,stuck:stuck.length});
  return {threads:open.length,closed,settled,flagged};
}

/* ------------------------------------------------------------------ title drift */

const DRIFT_STOPWORDS=new Set(['about','after','again','also','agent','agents','and','are','been','being','but','can','could','does','doing','done','for','from','have','here','into','its','just','keep','make','more','not','now','one','our','out','should','some','than','that','the','their','them','then','there','these','they','this','thread','threads','through','what','when','where','which','while','will','with','without','work','would','your','his','him','tejas','thnkr','ing','thinkering','concierge','inbox']);
function driftWords(value:string):Set<string> {
  return new Set(value.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
    .filter(word=>word.length>=4&&!DRIFT_STOPWORDS.has(word)).map(word=>word.replace(/(ings|ing|ies|es|ed|s)$/,'')).filter(word=>word.length>=3));
}
/**
 * A thread whose title no longer says what it holds, judged from its own record: the thread's
 * newest requests share no word with its title. It is a flag for the router, which renames the
 * thread (or, when he named it, moves the unrelated request into a thread of its own); his own
 * search and list rely on titles that say what is inside (capture d30a141a: "our thread names
 * don't make sense, and each thread keeps evolving into something we can't really track").
 */
/** Whether he named this thread. */
function renamedByHim(topic:StoredTopic):boolean {
  return lastRenameBy(topic)?.kind==='human';
}
export function titleDrift(topicId:string):{title:string;unrelated:{id:string;title:string}[];namedByHim:boolean}|null {
  const topic=topicRow(topicId);
  const title=driftWords(topic.title);
  if(!title.size)return null;
  const recent=topicRequests(topicId).slice(-4);
  const unrelated=recent.filter(request=>![...driftWords(request.title)].some(word=>title.has(word)));
  const newest=recent.at(-1);
  if(!newest||!unrelated.includes(newest)||unrelated.length*2<recent.length)return null;
  return {title:topic.title,unrelated:unrelated.map(request=>({id:request.requestId,title:request.title})),namedByHim:renamedByHim(topic)};
}
const titleDriftInstruction=(drift:NonNullable<ReturnType<typeof titleDrift>>)=>drift.namedByHim
  ?'He named this thread, and its newest requests are about something else: move them into a thread of their own (topics create, then place their messages there) so he can find each by its title.'
  :'This thread\'s title no longer says what it holds: its newest requests share nothing with it. Rename it (topics rename) to what he would look for, or move the unrelated requests into a thread of their own.';

/* ------------------------------------------------------------------ reply with review */

/** A reply may pin the exact questions it answers, when they belong to the topic it replies in. */
export function validateReviewSelection(sessionId:number,input:Record<string,any>) {
  if(input.review===undefined)return;
  const review=input.review;
  if(!review||typeof review!=='object'||!Array.isArray(review.questions)||!review.questions.length)
    throw new TopicError('A review names the questions it answers.');
  const messageId=input.replyToMessage?.messageId;
  if(typeof messageId!=='string')throw new TopicError('A review requires the exact message it replies to.');
  refreshRootMemo();
  const root=rootOf(sessionId,messageId);
  const topicId=root?topicOfRoot(root):null;
  if(!topicId)throw new TopicError('That reply target is not in a topic.',409,'ROOT_UNPLACED');
  for(const item of review.questions) {
    if(!item||typeof item!=='object'||typeof item.id!=='string'||!Number.isSafeInteger(Number(item.revision)))
      throw new TopicError('Each reviewed question needs its exact id and revision.');
    const question=db.query('SELECT topic_id FROM inbox_questions WHERE question_id=?').get(item.id) as {topic_id:string}|null;
    if(!question||question.topic_id!==topicId)throw new TopicError('A reviewed question must belong to the topic you are replying in.',409,'QUESTION_TOPIC_MISMATCH');
  }
}

/* ------------------------------------------------------------------ router prompt */

const PLACEMENT_INSTRUCTION='This capture is not yet in a topic. Place it with sessions topics place/create before routing or answering.';
const bugReportPlacementInstruction=()=>`This bug report is not yet in a topic. ${BUG_REPORT_OWN_THREAD} The open topics are listed only as candidates for --from.`;
export const ATTENTION_INSTRUCTION='Anything you need from him about a thread is a question in that thread: declare it with sessions topics questions <topicId> (kind "decision" when he must answer, "reading" when he should only read it) before the turn ends. A ready decision is for what no agent can do or a permanent rule reserves for him: it carries "onlyHeCan" (sign-in, secret, device, ambiguous or approval), "hisWords" copied exactly from his message and "whyNotSettled"; the owner refuses it otherwise. Approval also carries "decisionId" and "approvalAction", which the owner verifies against the permanent record. Other permission questions are refused; do the work and tell him afterwards. A request he made closes completed only when the work sent for it answered as done. An end-of-turn needs_you/response marker with no question declared this run is held unfiled, in no thread, until you file it with sessions topics file <topicId> --need <id>; he sees it as waiting for you to file. Every question you declare is yours to end: settle it when it is answered, replaced or no longer needed.';
const UNFILED_INSTRUCTION='These attention entries are in no thread yet. File each with sessions topics file <topicId> --need <need> (or include it as "from" in a topics questions declaration with a full brief); startedFrom is the thread its turn began in, a suggestion, not a decision.';
/** What the router is told about the thread an Inbox input belongs to. */
export function topicPromptContext(sessionId:number,inputId:string,payload:any):string {
  const session=getSessionById(sessionId);
  if(!session||!sessionMetadata(session).inbox)return '';
  refreshRootMemo();
  const target=typeof payload?.replyToMessage?.messageId==='string'?payload.replyToMessage.messageId:inputId;
  const root=rootOf(sessionId,target)??rootOf(sessionId,inputId);
  const topicId=root?topicOfRoot(root):null;
  if(!topicId) {
    // Agent requests have their own request/reply custody and do not need a human topic.
    const input=getAcceptedSessionInput(inputId);
    if(input?.origin==='agent'&&input.request_id)return '';
    const recent=(db.query(`SELECT topic_id,title,summary,updated_at FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND state='open'
      ORDER BY updated_at DESC LIMIT 8`).all(sessionId) as any[]).map(row=>({id:row.topic_id,title:row.title,summary:row.summary,lastEntryAt:iso(row.updated_at)}));
    const instruction=isBugReportInput(inputId)?bugReportPlacementInstruction():PLACEMENT_INSTRUCTION;
    return `\n\n<topic-placement>\n${JSON.stringify({instruction,openTopics:recent})}\n</topic-placement>`;
  }
  const topic=topicRow(topicId);
  const context:any={id:topic.topicId,title:topic.title,summary:topic.summary,
    openRequests:topicRequests(topicId).filter(request=>request.state==='open').map(request=>({id:request.requestId,title:request.title})),
    openQuestions:topicQuestions(topicId).filter(question=>OPEN_QUESTION_STATES.includes(question.state))
      .map(question=>({id:question.questionId,revision:question.revision,decision:question.brief?.decision??'',state:question.state,kind:question.kind})),
    rootCount:topicRoots(topicId).length};
  if(Array.isArray(payload?.review?.questions))context.review=payload.review.questions.map((item:any)=>({id:item.id,revision:Number(item.revision)}));
  const unfiled=unfiledAttention(session);
  if(unfiled.length)context.unfiledAttention={instruction:UNFILED_INSTRUCTION,items:unfiled.slice(0,8).map(item=>({need:item.eventId,kind:item.kind,text:item.text.slice(0,160),startedFrom:item.startedFrom}))};
  // Agents' answers the owner posted straight into this thread: the router is not sent them, so its
  // next turn here reads them as a quiet record instead.
  const roots=topicRoots(topicId);
  if(roots.length) {
    const answers=(db.query(`SELECT event_id,created_at,json_extract(payload_json,'$.postedBySession') AS from_session,json_extract(payload_json,'$.requestId') AS request_id,
        json_extract(payload_json,'$.workDisposition') AS disposition,json_extract(payload_json,'$.replyKind') AS reply_kind,json_extract(payload_json,'$.text') AS text FROM session_owner_events
      WHERE coalesce(json_extract(payload_json,'$.threadRoot'),input_id) IN (${roots.map(()=>'?').join(',')}) AND session_id=? AND kind='post' AND json_extract(payload_json,'$.postedBy')='owner-forward'
      ORDER BY sequence DESC LIMIT 5`).all(...roots,sessionId) as any[]);
    if(answers.length)context.agentAnswers=answers.map(row=>({post:row.event_id,at:iso(row.created_at),from:row.from_session,request:row.request_id,
      kind:row.reply_kind??'answer',...(row.disposition?{disposition:row.disposition}:{}),text:String(row.text??'').slice(0,160)}));
  }
  const drift=titleDrift(topicId);
  if(drift)context.titleDrift={...drift,instruction:titleDriftInstruction(drift)};
  const unrelayed=promptUnrelayedFinal(sessionId,topicId,roots);
  if(unrelayed)context.unrelayedResult={inputId:unrelayed.inputId,at:unrelayed.at,instruction:'A worker\'s final answer came back into this thread and you have not posted here since; relay it with sessions post --thread, or the thread keeps showing it as not relayed.'};
  return `\n\n<topic>\n${JSON.stringify(context)}\n</topic>`;
}

/* ------------------------------------------------------------------ migration */

const MIGRATION_VERSION=1;
/**
 * Tejas has one Inbox. A provider or folder cutover makes a new Inbox session, but the
 * legacy backlog was already converted by whichever Inbox session ran first, and every later
 * thread is filed live. Rerunning per session rebuilt every historical thread at startup
 * (30.8 s on 2026-11-05) and opened 948 phantom requests; see
 * docs/incidents/2026-11-05-inbox-migration-reran-for-new-inbox-session.md.
 */
function inboxMigrationRan(version:number) {
  // Driven from the Inbox sessions so SQLite searches each one's (session, kind) index; the
  // join form scanned every owner event and cost 0.5 to 0.7 s per start.
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE kind='topics_migration' AND json_extract(payload_json,'$.version')=?
    AND session_id IN (SELECT id FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1) LIMIT 1`).get(version);
}
function firstLine(value:string,limit=80) {
  const line=value.split('\n').map(part=>part.trim()).find(part=>part.length)??'';
  return line.length>limit?line.slice(0,limit-1).trimEnd()+'…':line;
}
function firstSentence(value:string,limit=80) {
  const line=firstLine(value,4000);
  const stop=line.search(/[.!?](\s|$)/);
  return firstLine(stop>0?line.slice(0,stop+1):line,limit);
}
// Producer labels that name the surface, not the concern; his words make a better title.
const GENERIC_CAPTURE_TITLES=new Set(['ios share','shared to thnkr.ing','bug report','thinkering bug report','thnkr.ing capture']);
function migrationTitle(input:AcceptedSessionInput):string {
  const payload=JSON.parse(input.payload_json),body=payload.firstInput??payload;
  const label=typeof body.capture?.source?.title==='string'?body.capture.source.title.trim():'';
  if(label&&!GENERIC_CAPTURE_TITLES.has(label.toLowerCase()))return firstLine(label);
  let readable=readableText(input);
  // A bug report's words follow its Description heading; the machine header above it is not a title.
  const description=readable.indexOf('\nDescription:\n');
  if(description>=0)readable=readable.slice(description+'\nDescription:\n'.length);
  readable=readable.replace(/^Thinkering bug report\s*\n+/,'').replace(/^Report ID:.*$/gm,'').replace(/\[BLANK_AUDIO\]/g,'');
  if(input.origin==='agent') {
    // An agent request opens with the owner's transport sentence; the request itself follows the first blank line.
    const blank=readable.search(/\n\s*\n/);
    if(/^Session request /.test(readable)&&blank>0)readable=readable.slice(blank).trim();
    return firstSentence(readable)||'Agent request';
  }
  return firstLine(readable)||label||'Untitled thread';
}

/**
 * Recovered topics whose title was taken from a producer label or a transport sentence get the
 * title the current rule would give them. Only topics nobody has renamed are touched, and each
 * change is an ordinary rename event by the owner, so it replays like any other.
 */
export function retitleRecoveredTopics() {
  const session=inboxSession();
  if(!session)return {retitled:0,reason:'no_inbox_session'};
  refreshRootMemo();
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  let retitled=0;
  for(const row of db.query(`SELECT * FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND recovered=1`).all(session.id) as any[]) {
    const topic=toStoredTopic(row);
    if(lastRenameBy(topic))continue;
    const root=topicRoots(topic.topicId)[0];
    const input=root?getAcceptedSessionInput(root):null;
    if(!input)continue;
    const title=migrationTitle(input);
    if(!title||title===topic.title)continue;
    const next=bumped(topic,{title,aliases:[...new Set([...topic.aliases,topic.title])]});
    const payload={change:'renamed',topicId:topic.topicId,topic:next,title,previousTitle:topic.title,aliases:next.aliases,by,reason:'migration retitle',revision:next.revision};
    db.transaction(()=>{
      recordSessionEvent({eventId:`topic-migration-retitle:${topic.topicId}:${next.revision}`,sessionId:session.id,kind:'topic',payload});
      applyTopicChange('topic',payload);
    })();
    retitled+=1;
  }
  log('info','inbox_topics_retitled',{session_id:session.id,retitled});
  return {retitled};
}

/**
 * One topic per existing Inbox thread root, with its request, its linked dispatches and its
 * open questions recovered from the legacy attention entries. Additive, resumable and safe
 * while the Inbox is live: nothing is closed, notified, dispatched or deleted.
 */
export function migrateInboxTopics(options:{batch?:number}={}) {
  const session=inboxSession();
  if(!session)return {migrated:false,reason:'no_inbox_session'};
  forwardRecoveryStartMs(session.id);
  if(inboxMigrationRan(MIGRATION_VERSION))return {migrated:false,reason:'already_migrated'};
  invalidateTopicRoots();
  const index=entryIndex();
  const manifest={roots:0,topics:0,requests:0,questions:0,unresolved:[] as {inputId:string;reason:string}[]};
  const needs=(sessionMetadata(session).needs??[]) as OpenNeed[];
  const needsByRoot=new Map<string,OpenNeed[]>();
  for(const need of needs) {
    const root=rootOf(session.id,need.inputId)??need.inputId;
    needsByRoot.set(root,[...(needsByRoot.get(root)??[]),need]);
  }
  const roots=[...index.byRoot.entries()].sort((first,second)=>first[1].sequence-second[1].sequence);
  const size=Math.max(1,options.batch??25);
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  for(let start=0;start<roots.length;start+=size) {
    const batch=roots.slice(start,start+size);
    db.transaction(()=>{
      for(const [root,entry] of batch) {
        manifest.roots+=1;
        if(topicOfRoot(root))continue;
        const input=getAcceptedSessionInput(root);
        if(!input){manifest.unresolved.push({inputId:root,reason:'no retained input'});continue;}
        // Agent coordination, returned answers and service upkeep have their own receipts.
        // A root in the Inbox transcript does not make them requests from Tejas.
        if(!humanAuthored(input)&&!routableMessage(input))continue;
        const at=iso(input.created_at)??entry.at;
        // A topic belongs to the active Inbox, whichever Inbox session its thread was
        // accepted in: a provider/cwd cutover created new sessions, and Tejas has one Inbox.
        const topic:StoredTopic={topicId:`topic:${randomUUID()}`,sessionId:session.id,title:migrationTitle(input),summary:'',
          state:'open',setAside:null,aliases:[],revision:1,recovered:true,readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
        const request:StoredRequest={requestId:`req:${randomUUID()}`,topicId:topic.topicId,title:topic.title,brief:'',state:'open',
          disposition:null,revision:1,sources:[{inputId:root}],dispatches:migrationDispatches(session.id,root),closure:null,createdAt:at,updatedAt:at};
        const questions:StoredQuestion[]=(needsByRoot.get(root)??[]).map(need=>({questionId:`q:${randomUUID()}`,topicId:topic.topicId,
          revision:1,state:'open',blocking:true,optional:false,context:'ready',
          brief:{decision:need.question,why:{text:'',sources:[need.inputId]},known:'',choices:[],uncertain:[],
            answerable:'',recoveredFrom:'Recovered from earlier conversation'},
          owner:null,sources:[need.inputId],replaces:null,replacedBy:null,answer:null,recovered:true,legacyNeedEventId:need.eventId,
          kind:need.outcome==='response'?'reading':'decision',origin:'recovered',generation:need.generation,
          createdAt:need.at??at,updatedAt:at}));
        const payload={change:'created',topicId:topic.topicId,topic,roots:rootRecords(topic.topicId,[root],by,'migration'),
          request,questions,by,reason:'migration',revision:1,recovered:true};
        recordSessionEvent({eventId:`topic-migration:${root}`,sessionId:session.id,kind:'topic',payload});
        applyTopicChange('topic',payload);
        manifest.topics+=1;manifest.requests+=1;manifest.questions+=questions.length;
      }
    })();
  }
  for(const need of needs)if(!index.byRoot.has(rootOf(session.id,need.inputId)??need.inputId))
    manifest.unresolved.push({inputId:need.inputId,reason:'attention entry has no Inbox thread'});
  recordSessionEvent({eventId:`topics-migration:${session.id}:${MIGRATION_VERSION}`,sessionId:session.id,kind:'topics_migration',
    payload:{version:MIGRATION_VERSION,manifest,at:nowIso()}});
  log('info','inbox_topics_migrated',{session_id:session.id,roots:manifest.roots,topics:manifest.topics,
    requests:manifest.requests,questions:manifest.questions,unresolved:manifest.unresolved.length});
  return {migrated:true,manifest};
}

const SETTLED_QUESTION_STATES:ReadonlySet<string>=new Set(['answered','declined','withdrawn','superseded','read','expired']);
/** The thread that owns a dispatch's work: where its request or its original thread root was placed. */
function dispatchHomeTopic(dispatchId:string):string|null {
  const root=(db.query('SELECT thread_root_input_id AS root FROM session_communication_requests WHERE request_id=?').get(dispatchId)
    ??db.query('SELECT thread_root_input_id AS root FROM session_peer_requests WHERE request_id=?').get(dispatchId)) as {root:string|null}|null;
  return topicOfRoot(`request:${dispatchId}`)??(root?.root?topicOfRoot(root.root):null);
}
/**
 * Whether a dispatch linked into `fromTopicId` is owned by a request in its own, different home
 * thread. A home placement alone is not ownership: only an open request there that lists the dispatch
 * keeps the work visible once the linking thread's request closes.
 */
function trackedInHomeThread(dispatchId:string,fromTopicId:string):boolean {
  const home=dispatchHomeTopic(dispatchId);
  if(!home||home===fromTopicId)return false;
  return topicRequests(home).some(request=>request.state==='open'&&request.dispatches.some((dispatch:any)=>String(dispatch.requestId)===dispatchId));
}
/**
 * A dispatch that holds no live work: it was answered, the answer is not a question for Tejas,
 * not a failure and not an unverified completion. Its result stays in its own request's receipt.
 */
function finishedWithCheckedAnswer(dispatchId:string):boolean {
  const work=workRow(dispatchId);
  return !!work&&work.outcome==='answered'&&work.disposition!=='needs_decision'&&work.disposition!=='failed'&&!work.notCheckedReason;
}
/** Retire migration-created bookkeeping requests through owner events, keeping their history. */
export function retireRecoveredBookkeepingRequests() {
  const session=inboxSession();
  if(!session)return {retired:0};
  refreshRootMemo();
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  let retired=0;
  // Recovered threads keep the Inbox session that converted them. A later Inbox session
  // (provider cutover or an acting router) does not adopt them by handoff, so the correction
  // reads every Inbox session's recovered threads and every one of those sessions' human replies.
  const candidates=db.query("SELECT topic_id,session_id FROM inbox_topics WHERE recovered=1 AND state='open'")
    .all() as {topic_id:string;session_id:number}[];
  const replies=new Set<string>();
  for(const sessionId of new Set([session.id,...candidates.map(candidate=>candidate.session_id)]))
    for(const root of readIndex(sessionId,true).humanReplies)replies.add(root);
  for(const {topic_id:topicId,session_id:topicSessionId} of candidates) {
    const roots=topicRoots(topicId);
    if(!roots.length||roots.some(root=>replies.has(root)))continue;
    const inputs=roots.map(root=>getAcceptedSessionInput(root));
    // A service input is an automatic event or result for an existing request, never a new
    // request from Tejas, whatever kind of notice it is. Agent roots stay open: their source
    // may carry his delegated work.
    if(inputs.some(input=>!input||input.origin!=='service'))continue;
    const requests=topicRequests(topicId);
    if(requests.length!==1||requests[0]!.state!=='open'||requests[0]!.sources.length!==1
      ||!roots.includes(requests[0]!.sources[0]!.inputId)
      ||topicQuestions(topicId).some(question=>!SETTLED_QUESTION_STATES.has(question.state)))continue;
    const request=requests[0]!;
    // The router may have since assigned real work to this recovered thread. Its
    // request then owns that dispatch until the normal checked-outcome path settles
    // it; the migration correction must only retire the original phantom row. A later
    // dispatch whose own work lives in another thread is only a link to that thread's
    // request, which keeps owning it.
    const migration=db.query("SELECT json_extract(payload_json,'$.request.dispatches') AS dispatches FROM session_owner_events WHERE event_id=? AND kind='topic'")
      .get(`topic-migration:${request.sources[0]!.inputId}`) as {dispatches:string|null}|null;
    if(!migration?.dispatches)continue;
    const initialIds=new Set((JSON.parse(migration.dispatches) as {requestId:string}[]).map(dispatch=>dispatch.requestId));
    const laterIds=request.dispatches.map((dispatch:any)=>String(dispatch.requestId)).filter(id=>!initialIds.has(id));
    if(laterIds.some(id=>!trackedInHomeThread(id,topicId)&&!finishedWithCheckedAnswer(id)))continue;
    const input=inputs.find(candidate=>candidate?.id===request.sources[0]!.inputId)!;
    const evidence=[`topic-migration:${request.sources[0]!.inputId}`,...roots];
    if(input.id.startsWith('return:')) {
      // A return is an event on the communication request it names. A prefix alone
      // cannot prove that the input is a return or which obligation owns it.
      const eventId=input.id.slice('return:'.length);
      const event=(db.query('SELECT request_id FROM session_communication_events WHERE event_id=?').get(eventId)
        ??db.query('SELECT request_id FROM session_peer_events WHERE event_id=?').get(eventId)) as {request_id:string}|null;
      if(event?.request_id===input.request_id)evidence.push(eventId,`request:${event.request_id}`);
      else if(input.id.startsWith('return:project-setup:')) {
        const order=db.query('SELECT order_id FROM project_setup_orders WHERE return_input_id=? AND order_id=?').get(input.id,input.request_id) as {order_id:string}|null;
        if(order)evidence.push(`project-setup:${order.order_id}`);
      }
    } else if(input.id.startsWith('thread-upkeep:')) {
      // An upkeep notice points at the request it was trying to recover. Keep
      // that request open; only retire the extra request made from the notice.
      const source=input.source_input_id?getAcceptedSessionInput(input.source_input_id):null;
      if(source&&source.id!==input.id) {
        if(input.request_id===request.requestId) {
          if(source.id.startsWith('request:')
            &&request.dispatches.some((dispatch:any)=>dispatch.requestId===source.id.slice('request:'.length)))evidence.push(source.id);
        } else if(input.request_id) {
          const original=db.query('SELECT sources_json FROM inbox_requests WHERE request_id=?').get(input.request_id) as {sources_json:string}|null;
          if(original&&JSON.parse(original.sources_json).some((item:{inputId:string})=>item.inputId===source.id))
            evidence.push(input.request_id,source.id);
        }
      }
    }
    if(input.request_id)evidence.push(input.request_id);
    if(input.source_input_id)evidence.push(input.source_input_id);
    for(const id of laterIds)evidence.push(`request:${id}`);
    const exactEvidence=[...new Set(evidence)];
    const at=nowIso(),reason='Recovered service notice is not a separate request from Tejas.';
    db.transaction(()=>{
      const topic=topicRow(topicId);
      const closedRequest={...request,state:'closed' as const,disposition:'superseded',
        closure:{by,at,reason,evidence:exactEvidence},revision:request.revision+1,updatedAt:at};
      const next=bumped(topic);
      recordOwnerTopicChange(topicSessionId,`topic-bookkeeping-retired:${request.requestId}`,'topic_request',
        {change:'request_closed',topicId,topic:next,request:closedRequest,by,reason,revision:next.revision});
      // Request closure may automatically close the topic. If work is still running, the
      // receipt remains available and the normal owner pass closes it after that work ends.
      closeThreadIfFinished(topicId,'bookkeeping retired');
    })();
    retired++;
  }
  if(retired)log('info','inbox_recovered_bookkeeping_retired',{session_id:session.id,retired});
  return {retired};
}

const ATTENTION_MIGRATION_VERSION=2;
/**
 * The backlog on 2026-09-23: every attention entry the Inbox still held outside a question
 * record becomes one (docs/plans/2026-09-23-attention-that-ends.md, "Today's backlog"). Each is
 * filed under the thread its turn started from — the only placement evidence there is for old
 * entries, and stated as such on the question — with `origin:'marker'`; one in a closed thread
 * is expired at once with the closure's reason; a reading item he had already marked seen is
 * `read`. Entries whose thread is in no topic stay unfiled for the router. Nothing is deleted:
 * the original attention events remain, and each conversion and expiry is its own recorded
 * topic event with a reason. Runs once, guarded like version 1.
 */
export function migrateInboxAttention() {
  const session=inboxSession();
  if(!session)return {migrated:false,reason:'no_inbox_session'};
  if(inboxMigrationRan(ATTENTION_MIGRATION_VERSION))return {migrated:false,reason:'already_migrated'};
  refreshRootMemo();
  const meta=sessionMetadata(session);
  const dismissed=meta.dismissedGeneration??0;
  const manifest={filed:0,expired:0,read:0,unfiled:0,covered:0};
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  const at=nowIso();
  db.transaction(()=>{
    const covered=new Set((db.query('SELECT legacy_need_event_id FROM inbox_questions WHERE legacy_need_event_id IS NOT NULL').all() as {legacy_need_event_id:string}[])
      .map(row=>row.legacy_need_event_id));
    const remaining:OpenNeed[]=[];
    const byTopic=new Map<string,StoredQuestion[]>();
    for(const need of (meta.needs??[]) as OpenNeed[]) {
      if(covered.has(need.eventId)){manifest.covered+=1;continue;}
      const root=rootOf(session.id,need.inputId)??need.inputId;
      const topicId=topicOfRoot(root);
      if(!topicId){remaining.push(need);manifest.unfiled+=1;continue;}
      const topic=topicRow(topicId);
      const kind:QuestionKind=need.outcome==='response'?'reading':'decision';
      const closed=topic.state==='closed';
      const seen=kind==='reading'&&need.generation<=dismissed;
      const reason=closed?`Thread was closed on ${(topic.closure?.at??topic.updatedAt).slice(0,10)}: ${topic.closure?.reason??''}`.trim():seen?'Marked seen before it was filed':null;
      const question:StoredQuestion={questionId:`q:${randomUUID()}`,topicId,revision:1,state:closed?'expired':seen?'read':'open',blocking:kind==='decision',optional:false,
        context:'ready',brief:{decision:need.question,why:{text:'',sources:[need.inputId]},known:'',choices:[],uncertain:[],answerable:'',
          recoveredFrom:'Filed by migration under the thread its turn started from; the router can move it',...(reason?{endedBecause:reason}:{})},
        owner:{sessionId:`concierge:${session.id}`},sources:[need.inputId],replaces:null,replacedBy:null,answer:null,recovered:true,
        legacyNeedEventId:need.eventId,kind,origin:'marker',generation:need.generation,createdAt:need.at??at,updatedAt:at};
      byTopic.set(topicId,[...(byTopic.get(topicId)??[]),question]);
      manifest.filed+=1;if(closed)manifest.expired+=1;if(seen)manifest.read+=1;
    }
    for(const [topicId,questions] of byTopic) {
      const topic=topicRow(topicId);
      const next=bumped(topic);
      const payload={change:'recovered',topicId,topic:next,questions,by,reason:'Attention entries filed as questions (migration 2)',revision:next.revision};
      recordSessionEvent({eventId:`topic-attention-migration:${topicId}`,sessionId:session.id,kind:'topic_question',payload});
      applyTopicChange('topic_question',payload);
    }
    updateSessionMetadata(session.id,{needs:remaining});
    recordSessionEvent({eventId:`topics-migration:${session.id}:${ATTENTION_MIGRATION_VERSION}`,sessionId:session.id,kind:'topics_migration',
      payload:{version:ATTENTION_MIGRATION_VERSION,manifest,at}});
  })();
  log('info','inbox_attention_migrated',{session_id:session.id,...manifest});
  return {migrated:true,manifest};
}
/**
 * Ends every open reading item that has nothing to read, with its reason, so nothing labelled
 * "to read" exists without something in it. Runs at every start and changes nothing once the
 * list is clean; new items are refused at the door (`NOTHING_TO_READ`), so this only clears
 * what was filed before the rule. Tejas met two such items on 2026-09-24: a heading, a link
 * back to his own message, and a Read that failed.
 */
export function expireUnreadableReadingItems() {
  const session=inboxSession();
  if(!session)return {expired:0};
  // This repairs items filed before the read-content admission rule. Once the full
  // historical pass commits, every new item is checked at admission, so a restart
  // need not resolve all existing reading items again.
  const completionId='unreadable-reading-items:admission-rule-v1';
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(completionId))return {expired:0};
  refreshRootMemo();
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  const at=nowIso();
  const reason='Nothing to read was recorded with this: the turn that raised it left no post or closing text in this thread. The answer, if any, is in the thread.';
  const unreadable=(db.query(`SELECT * FROM inbox_questions WHERE kind='reading' AND state IN ('open','partial')`).all() as any[]).map(toStoredQuestion)
    .filter(question=>!readsFor(question).length);
  db.transaction(()=>{
    for(const question of unreadable) {
      const topic=topicRow(question.topicId);
      const next=bumped(topic);
      const ended:StoredQuestion={...question,state:'expired',brief:{...question.brief,endedBecause:reason},updatedAt:at};
      const payload={change:'settled',topicId:topic.topicId,topic:next,questions:[ended],by,reason,revision:next.revision};
      recordSessionEvent({eventId:`topic-unreadable-expiry:${question.questionId}`,sessionId:session.id,kind:'topic_question',payload});
      applyTopicChange('topic_question',payload);
    }
    recordSessionEvent({eventId:completionId,sessionId:session.id,kind:'startup_catch_up',
      payload:{name:'unreadable-reading-items',completedAt:at,expired:unreadable.length}});
  })();
  if(unreadable.length)log('info','inbox_unreadable_reading_items_expired',{session_id:session.id,expired:unreadable.length,question_ids:unreadable.map(question=>question.questionId)});
  return {expired:unreadable.length};
}
/**
 * A service notice has a thread from the moment it exists. Nobody's turn wrote it, so the
 * router never handles it and nothing would file it: the Codex App Server notice of 2026-09-25
 * sat under "being sorted", and its notification opened on "not in a thread yet" (Tejas: "Where
 * is this message? Why is it not in the thread? Why are you not able to link it?"). The owner
 * files each one itself — into the open thread already titled by the notice's first sentence,
 * else a new thread with that title — as a reading item whose text is the notice. It runs after
 * a notice is published in this process, at startup for notices another process published, and
 * when a message is resolved to its thread. Safe to run twice: a filed notice is no longer
 * unfiled. Notices never sit in "being sorted" for him or for the router.
 */
export function fileServiceNotices():{filed:number} {
  const session=inboxSession();
  if(!session)return {filed:0};
  refreshRootMemo();
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  const reason='A service notice is filed by the owner the moment it exists';
  let filed=0;
  for(const need of unfiledNeeds(session)) {
    if(!isServiceNotice(need.inputId))continue;
    const root=rootOf(session.id,need.inputId)??need.inputId;
    const title=serviceNoticeTitle(need.question);
    try {
      db.transaction(()=>{
        let topicId=topicOfRoot(root);
        if(!topicId) {
          const existing=db.query(`SELECT topic_id FROM inbox_topics WHERE session_id IN (${inboxLineageSql}) AND state='open' AND title=? ORDER BY updated_at DESC LIMIT 1`).get(session.id,title) as {topic_id:string}|null;
          const placed=existing?placeChange(session,topicRow(existing.topic_id),[root],by,reason):
            createTopic(session,by,{title,roots:[root],reason,areaIds:[ensureSystemNoticeArea(session.id)]});
          recordSessionEvent({eventId:`topic-service-notice:${need.eventId}:placed`,sessionId:session.id,inputId:need.inputId,kind:placed.change.kind,payload:placed.change.payload});
          applyTopicChange(placed.change.kind,placed.change.payload);
          topicId=placed.topic.topicId;
        }
        const topic=topicRow(topicId);
        const question=fileNeed(session,topic,need.eventId,by);
        const next=bumped(topic);
        const payload={change:'filed',topicId,topic:next,questions:[question],by,reason,revision:next.revision};
        recordSessionEvent({eventId:`topic-service-notice:${need.eventId}:filed`,sessionId:session.id,inputId:need.inputId,kind:'topic_question',payload});
        applyTopicChange('topic_question',payload);
      })();
      filed++;
      log('info','inbox_service_notice_filed',{session_id:session.id,input_id:need.inputId,title});
    } catch(error) {
      log('error','inbox_service_notice_file_failed',{session_id:session.id,input_id:need.inputId,error:String(error)});
    }
  }
  return {filed};
}
/**
 * A service notice whose condition has cleared says so, in its own thread, and the thread
 * closes: a service post ("… is running again as of …") answers the notice, and the closure
 * ends the reading item, so nothing about it waits on him. Settled once per notice; a second
 * call is a no-op. Returns whether it settled anything.
 */
export function settleServiceNotice(input:{inputId:string;text:string}):boolean {
  const session=inboxSession();
  if(!session)return false;
  const eventId=`post:service-resolved:${input.inputId}`;
  if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))return false;
  if(!isServiceNotice(input.inputId))return false;
  refreshRootMemo();
  let topicId=topicOfRoot(input.inputId);
  if(!topicId){fileServiceNotices();topicId=topicOfRoot(input.inputId);}
  const by:TopicBy={kind:'owner',sessionId:`concierge:${session.id}`};
  const at=nowIso();
  db.transaction(()=>{
    recordSessionEvent({eventId,sessionId:session.id,inputId:input.inputId,kind:'post',
      payload:{text:input.text,replyToMessage:{kind:'message',sessionId:`concierge:${session.id}`,messageId:input.inputId},postedBy:'service'}});
    if(!topicId)return;
    const topic=topicRow(topicId);
    if(topic.state==='closed')return;
    const questions=expireOpen(topicQuestions(topicId),`Thread closed: ${input.text}`,at);
    const next=bumped(topic,{state:'closed',closure:{by,at,reason:input.text,scope:null,requests:topicRequests(topicId).map(request=>request.requestId)}});
    const payload={change:'closed',topicId,topic:next,scope:null,by,reason:input.text,revision:next.revision,questions};
    recordSessionEvent({eventId:`topic-service-notice:${input.inputId}:closed`,sessionId:session.id,inputId:input.inputId,kind:'topic',payload});
    applyTopicChange('topic',payload);
  })();
  log('info','inbox_service_notice_settled',{session_id:session.id,input_id:input.inputId,topic_id:topicId});
  return true;
}
/** A notice's thread is titled by the first sentence of its first line: "Codex conversation observation stopped after repeated failures". */
function serviceNoticeTitle(text:string):string {
  const line=text.split('\n').map(part=>part.trim()).find(Boolean)??'Service notice';
  const sentence=line.split(/(?<=[.!?])\s/)[0]!.replace(/[.!?]+$/,'').trim();
  return (sentence||line).slice(0,120);
}
function migrationDispatches(sessionId:number,root:string) {
  const dispatches:any[]=[];
  for(const row of db.query(`SELECT request_id,source_input_id,target_session_id,outcome,status FROM session_communication_requests
      WHERE source_session_id=? AND source_input_id IS NOT NULL`).all(sessionId) as any[]) {
    if(rootOf(sessionId,row.source_input_id)!==root)continue;
    const target=getSessionById(row.target_session_id);
    dispatches.push({requestId:row.request_id,targetSessionId:`concierge:${row.target_session_id}`,
      targetTitle:(target&&sessionMetadata(target).title)??null,outcome:row.outcome??null,state:row.status??null});
  }
  for(const row of db.query(`SELECT request_id,source_input_id,peer,remote_session_id,outcome,status FROM session_peer_requests
      WHERE source_session_id=?`).all(sessionId) as any[]) {
    if(rootOf(sessionId,row.source_input_id)!==root)continue;
    dispatches.push({requestId:row.request_id,targetSessionId:receiveSessionFromPeer(row.remote_session_id,row.peer),targetTitle:null,
      outcome:row.outcome??null,state:row.status??null});
  }
  return dispatches;
}
