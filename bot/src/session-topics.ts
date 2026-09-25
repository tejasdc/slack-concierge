import {randomUUID} from 'node:crypto';
import {db,getSessionById,type SessionRow} from './state';
import {getAcceptedSessionInput,recordSessionEvent,retainSessionInput,sessionMetadata,updateSessionMetadata,type AcceptedSessionInput} from './session-inputs';
import {capturePresentation,inboxMessage,inboxMessageById,inboxMessageId,inboxRowByMessageId,inboxRows,inboxSession,inboxThreadRoot} from './session-inbox';
import type {OpenNeed} from './session-turn-outcome';
import {SERVICE_NOTICE_SCOPE} from './provider-free-notice';
import {log} from './log';

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

export const TOPIC_EVENT_KINDS=['topic','topic_request','topic_question','topic_answer','topic_reading','topic_focus','topics_migration'] as const;
const MANAGEMENT_KINDS=['topic','topic_request','topic_question','topic_answer'];

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
const OPEN_QUESTION_STATES=['open','partial'];
/** A decision waits on him; a reading item is something an agent wants him to read, and waits on nobody. */
type QuestionKind='decision'|'reading';
/** `declared` with `topics questions`; `marker` filed from a turn's end-of-turn marker; `recovered` by a migration. */
type QuestionOrigin='declared'|'marker'|'recovered';
/**
 * A question is agent-owned preparation until its brief can be answered: it must say why the
 * decision came up and exactly what he can answer now; choices are optional (a factual question
 * needs none), but each one present needs a label. Anything less is never a debt of his (the
 * approved design, docs/plans/2026-09-22-topic-threads.md; Tejas, 2026-09-22, on finding a
 * headline with nothing under it in Needs your answer). Returns what is still missing.
 */
function briefMissing(brief:any):string[] {
  const missing:string[]=[];
  if(!String(brief?.decision??'').trim())missing.push('decision');
  if(!String(brief?.why?.text??'').trim())missing.push('why');
  if(!String(brief?.answerable??'').trim())missing.push('answerable');
  if(Array.isArray(brief?.choices)&&brief.choices.some((choice:any)=>!String(choice?.label??'').trim()))missing.push('choices[].label');
  return missing;
}
/**
 * What a question still lacks before he can answer it. A question filed from a turn's marker
 * is answerable by construction — the agent asked him that sentence directly — so it needs only
 * the decision; a declared one needs its why and what he can answer now. Without this, the 12
 * decisions the migration filed would have landed under "Agent checking" (dry run, 2026-09-23).
 */
const missingFor=(question:{brief:any;origin?:QuestionOrigin}):string[]=>question.origin==='marker'?(String(question.brief?.decision??'').trim()?[]:['decision']):briefMissing(question.brief);
const questionReadiness=(question:{context:string;brief:any;origin?:QuestionOrigin}):'ready'|'preparing'=>question.context==='ready'&&!missingFor(question).length?'ready':'preparing';
/** The one rule for whether a question is waiting on him. Every count, list and filter uses it;
 * a client displays this answer and never recomputes it. */
const awaitingHim=(question:{state:string;context:string;brief:any;blocking:boolean;optional:boolean;pendingReply?:any;kind?:QuestionKind})=>
  (question.kind??'decision')==='decision'&&OPEN_QUESTION_STATES.includes(question.state)&&questionReadiness(question)==='ready'&&(question.blocking||!question.optional)&&!question.pendingReply;
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
  const posts=db.query(`SELECT event_id,input_id,created_at,json_extract(payload_json,'$.text') AS text
    FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post' ORDER BY sequence`).all(sessionId,turnId) as {event_id:string;input_id:string|null;created_at:string;text:string|null}[];
  const here=posts.filter(post=>!!post.input_id&&roots.has(post.input_id)&&String(post.text??'').trim());
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
export function readsFor(question:{topicId:string;kind?:QuestionKind;legacyNeedEventId:string|null;owner:any;brief:any;sources?:string[]}):ReadingText[] {
  if((question.kind??'decision')!=='reading')return [];
  const topic=db.query('SELECT session_id FROM inbox_topics WHERE topic_id=?').get(question.topicId) as {session_id:number}|null;
  if(!topic)return [];
  // The threads an answer may sit in: this topic's, and the thread of the message that raised
  // the item — a router files an item under the topic it belongs to, which is not always the
  // thread the turn answered in (the two items of 2026-09-24 were filed that way).
  const roots=new Set([...topicRoots(question.topicId),...(question.sources??[]).map(source=>inboxThreadRoot(topic.session_id,source)??source)]);
  const named:string[]=Array.isArray(question.brief?.reads)?question.brief.reads.filter((id:unknown):id is string=>typeof id==='string'&&!!id.trim()):[];
  if(named.length) {
    const found:ReadingText[]=[];
    for(const id of named) {
      const message=inboxMessageById(topic.session_id,id) as {content?:string;createdAt?:string;inputId?:string}|null;
      const root=message?.inputId?inboxThreadRoot(topic.session_id,message.inputId):null;
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
  question.kind==='reading'&&OPEN_QUESTION_STATES.includes(question.state)
  &&(question.reads?question.reads.length>0:readsFor({topicId:question.topicId,kind:question.kind,legacyNeedEventId:question.legacyNeedEventId??null,owner:question.owner,brief:question.brief,sources:question.sources}).length>0);
const preparingForHim=(question:{state:string;context:string;brief:any;kind?:QuestionKind})=>(question.kind??'decision')==='decision'&&OPEN_QUESTION_STATES.includes(question.state)&&questionReadiness(question)==='preparing';
const DISPOSITIONS=['completed','declined','withdrawn','superseded','failed'];

type StoredTopic={topicId:string;sessionId:number;title:string;summary:string;state:'open'|'closed';setAside:any|null;
  aliases:string[];revision:number;recovered:boolean;readSequence:number;closure:any|null;createdBy:TopicBy;createdAt:string;updatedAt:string};
type StoredRequest={requestId:string;topicId:string;title:string;brief:string;state:'open'|'closed';disposition:string|null;
  revision:number;sources:{inputId:string;passage?:string}[];dispatches:any[];closure:any|null;createdAt:string;updatedAt:string};
type StoredQuestion={questionId:string;topicId:string;revision:number;state:QuestionState;blocking:boolean;optional:boolean;
  context:'ready'|'agent_checking';brief:any;owner:any|null;sources:string[];replaces:string|null;replacedBy:string|null;
  answer:any|null;recovered:boolean;legacyNeedEventId:string|null;kind:QuestionKind;origin:QuestionOrigin;
  /** The Inbox session's attention generation when this was raised, so the session's read/dismiss cutoffs still mean something. */
  generation:number|null;createdAt:string;updatedAt:string};

const nowIso=()=>new Date().toISOString();
const iso=(value:string|null|undefined)=>value?(value.includes('T')?value:value.replace(' ','T')+'Z'):null;
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
  const rows=db.query(`${inboxRows} AND event.sequence>? ORDER BY event.sequence`).all(index.watermark) as any[];
  for(const row of rows) {
    index.watermark=row.sequence;
    const messageId=inboxMessageId(row);
    if(!messageId)continue;
    const root=rootOf(row.session_id,messageId);
    const kind=entryKind(row);
    const record={sequence:row.sequence,at:iso(row.created_at)!,sessionId:row.session_id};
    index.messages.set(messageId,{...record,root,kind});
    if(!root)continue;
    const current=index.byRoot.get(root);
    if(!current||row.sequence>current.sequence)index.byRoot.set(root,record);
    if(kind==='final'&&(index.finals.get(root)?.sequence??-1)<row.sequence)index.finals.set(root,{...record,inputId:messageId});
    if(kind==='post'&&(index.posts.get(root)?.sequence??-1)<row.sequence)index.posts.set(root,record);
  }
  return index;
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
  createdBy:JSON.parse(row.created_by_json),createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!});
const toStoredRequest=(row:any):StoredRequest=>({requestId:row.request_id,topicId:row.topic_id,title:row.title,brief:row.brief,
  state:row.state,disposition:row.disposition,revision:row.revision,sources:JSON.parse(row.sources_json),dispatches:JSON.parse(row.dispatches_json),
  closure:row.closure_json?JSON.parse(row.closure_json):null,createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!});
const toStoredQuestion=(row:any):StoredQuestion=>({questionId:row.question_id,topicId:row.topic_id,revision:row.revision,state:row.state,
  blocking:!!row.blocking,optional:!!row.optional,context:row.context,brief:JSON.parse(row.brief_json),
  owner:row.owner_json?JSON.parse(row.owner_json):null,sources:JSON.parse(row.sources_json),replaces:row.replaces,replacedBy:row.replaced_by,
  answer:row.answer_json?JSON.parse(row.answer_json):null,recovered:!!row.recovered,legacyNeedEventId:row.legacy_need_event_id,
  kind:row.kind==='reading'?'reading':'decision',origin:['marker','recovered'].includes(row.origin)?row.origin:'declared',
  generation:typeof row.generation==='number'?row.generation:null,
  createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!});

function upsertTopic(topic:StoredTopic) {
  db.query(`INSERT INTO inbox_topics(topic_id,session_id,title,summary,state,set_aside_json,aliases_json,revision,recovered,read_sequence,created_at,updated_at,closure_json,created_by_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(topic_id) DO UPDATE SET title=excluded.title,summary=excluded.summary,state=excluded.state,set_aside_json=excluded.set_aside_json,
      aliases_json=excluded.aliases_json,revision=excluded.revision,recovered=excluded.recovered,read_sequence=excluded.read_sequence,
      updated_at=excluded.updated_at,closure_json=excluded.closure_json`)
    .run(topic.topicId,topic.sessionId,topic.title,topic.summary,topic.state,topic.setAside?JSON.stringify(topic.setAside):null,
      JSON.stringify(topic.aliases),topic.revision,topic.recovered?1:0,topic.readSequence,topic.createdAt,topic.updatedAt,
      topic.closure?JSON.stringify(topic.closure):null,JSON.stringify(topic.createdBy));
}
function upsertRequest(request:StoredRequest) {
  db.query(`INSERT INTO inbox_requests(request_id,topic_id,title,brief,state,disposition,revision,sources_json,dispatches_json,closure_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET topic_id=excluded.topic_id,title=excluded.title,brief=excluded.brief,state=excluded.state,
      disposition=excluded.disposition,revision=excluded.revision,sources_json=excluded.sources_json,dispatches_json=excluded.dispatches_json,
      closure_json=excluded.closure_json,updated_at=excluded.updated_at`)
    .run(request.requestId,request.topicId,request.title,request.brief,request.state,request.disposition,request.revision,
      JSON.stringify(request.sources),JSON.stringify(request.dispatches),request.closure?JSON.stringify(request.closure):null,
      request.createdAt,request.updatedAt);
}
function upsertQuestion(question:StoredQuestion) {
  db.query(`INSERT INTO inbox_questions(question_id,topic_id,revision,state,blocking,optional,context,brief_json,owner_json,sources_json,replaces,replaced_by,answer_json,recovered,legacy_need_event_id,kind,origin,generation,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(question_id) DO UPDATE SET topic_id=excluded.topic_id,revision=excluded.revision,state=excluded.state,blocking=excluded.blocking,
      optional=excluded.optional,context=excluded.context,brief_json=excluded.brief_json,owner_json=excluded.owner_json,sources_json=excluded.sources_json,
      replaces=excluded.replaces,replaced_by=excluded.replaced_by,answer_json=excluded.answer_json,recovered=excluded.recovered,
      legacy_need_event_id=excluded.legacy_need_event_id,kind=excluded.kind,origin=excluded.origin,generation=excluded.generation,updated_at=excluded.updated_at`)
    .run(question.questionId,question.topicId,question.revision,question.state,question.blocking?1:0,question.optional?1:0,question.context,
      JSON.stringify(question.brief),question.owner?JSON.stringify(question.owner):null,JSON.stringify(question.sources),
      question.replaces,question.replacedBy,question.answer?JSON.stringify(question.answer):null,question.recovered?1:0,
      question.legacyNeedEventId,question.kind??'decision',question.origin??'declared',question.generation??null,question.createdAt,question.updatedAt);
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
  for(const topic of [payload.topic,payload.mergedTopic,...(payload.topics??[])])if(topic)upsertTopic(topic);
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
    for(const table of ['inbox_topic_roots','inbox_requests','inbox_questions','inbox_topic_reading','inbox_focus','inbox_topics'])db.exec(`DELETE FROM ${table}`);
    const rows=db.query(`SELECT kind,payload_json FROM session_owner_events WHERE kind IN (${TOPIC_EVENT_KINDS.map(()=>'?').join(',')}) ORDER BY sequence`).all(...[...TOPIC_EVENT_KINDS]) as {kind:string;payload_json:string}[];
    for(const row of rows) {
      if(row.kind==='topics_migration')continue;
      applyTopicChange(row.kind,JSON.parse(row.payload_json));
    }
    return {events:rows.length,topics:(db.query('SELECT count(*) AS count FROM inbox_topics').get() as {count:number}).count};
  })();
}

/* ------------------------------------------------------------------ mutation plumbing */

type Change={kind:string;payload:any};
function record(sessionId:number,inputId:string,turnId:number|null,change:Change) {
  recordSessionEvent({eventId:`topic-change:${inputId}`,sessionId,inputId,turnId:turnId??null,kind:change.kind,payload:change.payload});
  applyTopicChange(change.kind,change.payload);
}
/** Every agent mutation is retained by source input + action id; a duplicate returns the first receipt. */
function agentMutation<T extends object>(actor:TopicActor,actionId:string,payload:unknown,run:()=>{change:Change;result:T}):T&{duplicate?:boolean} {
  return db.transaction(()=>{
    const saved=retainSessionInput({sessionId:actor.sessionId,scope:`communication:${actor.inputId}`,actionId,kind:'action',origin:'agent',
      payload,sourceInputId:actor.inputId,sourceRunId:actor.runId});
    if(saved.duplicate)return {...(JSON.parse(saved.input.receipt_json??'{}').result??{}),duplicate:true};
    const {change,result}=run();
    record(actor.sessionId,saved.input.id,actor.turnId,change);
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',result}),saved.input.id);
    return {...result,duplicate:false};
  })();
}
/** His own action on a topic. Same retained-receipt shape as the owner's other human controls. */
function humanMutation(sessionId:number,clientActionId:string,payload:unknown,run:()=>{change:Change;result:Record<string,any>}) {
  if(typeof clientActionId!=='string'||!clientActionId||clientActionId.length>200)throw new TopicError('Stable clientActionId required.');
  return db.transaction(()=>{
    const saved=retainSessionInput({sessionId,scope:'surface:thinkering',actionId:clientActionId,kind:'topic-action',origin:'human',payload});
    if(saved.duplicate)return {...(JSON.parse(saved.input.receipt_json??'{}').result??{}),duplicate:true};
    const {change,result}=run();
    record(sessionId,saved.input.id,null,change);
    db.query('UPDATE session_inputs SET receipt_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(JSON.stringify({state:'completed',result}),saved.input.id);
    return {...result,duplicate:false};
  })();
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
type WorkIndex={focus:ReturnType<typeof focusRow>;focusTitle:string|null;queued:{inputId:string;root:string|null;position:number}[];
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
    dispatches.push({root:rootOf(sessionId,row.source_input_id),sessionId:`${row.peer}:${row.remote_session_id}`,
      title:(catalogue?JSON.parse(catalogue.view_json)?.title:null)||`${row.peer} session`,requestId:row.request_id});
  }
  return {focus,focusTitle,queued,dispatches};
}
/**
 * What is happening to this thread, in words he would use. `text` is detail a surface adds
 * after its own label, so it is empty when there is nothing to add, and it never names a
 * session, an id or a model: "Threads: his messages and unreadable headers is working" told
 * him nothing and read as if written about someone else (Tejas, 2026-09-22).
 */
function topicWork(topic:StoredTopic,roots:string[],index:WorkIndex,entries:EntryIndex) {
  if(index.focus?.topicId===topic.topicId)
    return {kind:'router_working' as const,text:index.focus.summary??'',runId:index.focus.runId,sessionId:`concierge:${topic.sessionId}`};
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
  const dispatch=index.dispatches.find(item=>item.root&&roots.includes(item.root));
  if(dispatch)return {kind:'worker_working' as const,text:'Handed to another agent',sessionId:dispatch.sessionId};
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
type ReadIndex={humanReplies:Map<string,HumanReply[]>;management:Map<string,{sequence:number;at:string|null}>};
function readIndex(sessionId:number):ReadIndex {
  refreshRootMemo();
  // The newest human message per thread root, newest first so the first hit wins.
  // Every human message per thread root, newest first, with the questions it reviewed and the
  // message it replied to: a reply counts against a question only when it names it (design:
  // "Answering an unrelated later message changes nothing here").
  const humanReplies=new Map<string,HumanReply[]>();
  for(const row of db.query(`SELECT id,created_at,json_extract(payload_json,'$.review.questions') AS review,
      json_extract(payload_json,'$.replyToMessage.messageId') AS reply_to
      FROM session_inputs WHERE session_id=? AND origin='human' AND kind IN ('input','create','inbox-capture')
        AND id NOT IN (SELECT input_id FROM session_input_author_corrections) ORDER BY rowid DESC LIMIT 2000`).all(sessionId) as any[]) {
    // Only message kinds: his reading marks and topic actions are human inputs too, two thirds
    // of the newest 2,000 rows, and none of them is in any thread.
    const root=rootOf(sessionId,row.id);
    if(!root)continue;
    let reviews:string[]=[];
    try{const parsed=row.review?JSON.parse(row.review):[];reviews=Array.isArray(parsed)?parsed.map((item:any)=>String(item?.id??'')).filter(Boolean):[];}catch{reviews=[];}
    humanReplies.set(root,[...(humanReplies.get(root)??[]),{inputId:row.id,at:iso(row.created_at)!,reviews,replyTo:typeof row.reply_to==='string'?row.reply_to:null}]);
  }
  const management=new Map<string,{sequence:number;at:string|null}>();
  for(const row of db.query(`SELECT json_extract(payload_json,'$.topicId') AS topic,MAX(sequence) AS sequence,MAX(created_at) AS created_at
      FROM session_owner_events WHERE session_id=? AND kind IN (${MANAGEMENT_KINDS.map(()=>'?').join(',')}) GROUP BY topic`).all(sessionId,...MANAGEMENT_KINDS) as any[]) {
    if(row.topic)management.set(row.topic,{sequence:row.sequence,at:iso(row.created_at)});
  }
  return {humanReplies,management};
}
/** His messages in this topic, newest first, so a question can find the reply that names it. */
function latestHumanReply(index:ReadIndex,roots:string[]):HumanReply[] {
  return roots.flatMap(root=>index.humanReplies.get(root)??[]).sort((first,second)=>second.at.localeCompare(first.at));
}
function questionView(question:StoredQuestion,replies:HumanReply[]) {
  const reading=db.query('SELECT kind,revision,at,by_json FROM inbox_topic_reading WHERE topic_id=? AND item_id=? ORDER BY at').all(question.topicId,question.questionId) as any[];
  const exposed=reading.filter(row=>row.kind==='exposed'&&row.revision===question.revision).at(-1);
  const acknowledged=reading.filter(row=>row.kind==='acknowledged').at(-1);
  // He answered and the router has not reconciled it yet. Retained input times are
  // second-granularity, so a reply in the same second as the question's last change counts
  // as older: a question that stays in Needs you is recoverable, one silently hidden is not.
  // Only a reply that names this question (a reviewed question, or a reply to the message that
  // raised it) is his answer to it; an unrelated later message in the thread changes nothing.
  const reply=OPEN_QUESTION_STATES.includes(question.state)?replies.find(candidate=>candidate.at>question.updatedAt
    &&(candidate.reviews.includes(question.questionId)||(!!candidate.replyTo&&question.sources.includes(candidate.replyTo)))):undefined;
  const pending=reply?{inputId:reply.inputId,at:reply.at}:null;
  const view={id:question.questionId,topicId:question.topicId,revision:question.revision,state:question.state,blocking:question.blocking,
    optional:question.optional,context:question.context,readiness:questionReadiness(question),missing:missingFor(question),
    kind:question.kind,origin:question.origin,generation:question.generation,pendingReply:pending,brief:question.brief,
    // What a reading item is for him to read, in full, from the thread's own messages.
    reads:readsFor(question)};
  return {...view,
    // The owner's own answer to "is this his to act on", so no surface recomputes it.
    waiting:awaitingHim(view)||toReadByHim(view),
    owner:question.owner,sources:question.sources,
    replaces:question.replaces,replacedBy:question.replacedBy,answer:question.answer,
    exposed:exposed?{revision:exposed.revision,at:exposed.at}:null,
    acknowledged:acknowledged?{at:acknowledged.at,by:acknowledged.by_json?JSON.parse(acknowledged.by_json):null}:null,
    pendingReply:pending,recovered:question.recovered,createdAt:question.createdAt,updatedAt:question.updatedAt};
}
const requestView=(request:StoredRequest)=>({id:request.requestId,topicId:request.topicId,title:request.title,brief:request.brief,
  state:request.state,disposition:request.disposition,revision:request.revision,sources:request.sources,dispatches:request.dispatches,
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
  const last=roots.map(root=>index.byRoot.get(root)).filter(Boolean) as {sequence:number;at:string}[];
  const events=read.management.get(topic.topicId)??{sequence:0,at:null};
  const lastSequence=Math.max(0,...last.map(entry=>entry.sequence),events.sequence);
  const lastAt=[...last.map(entry=>entry.at),events.at].filter(Boolean).sort().at(-1)??topic.updatedAt;
  return {id:topic.topicId,title:topic.title,aliases:topic.aliases,summary:topic.summary,state:topic.state,setAside:topic.setAside,
    revision:topic.revision,recovered:topic.recovered,createdAt:topic.createdAt,updatedAt:topic.updatedAt,lastEntryAt:lastAt,
    lastEntrySequence:lastSequence,unread:lastSequence>topic.readSequence,roots,
    needsYou:{count:items.length,oldestAt:items[0]?.at??null,items},
    toRead:{count:toRead.length,oldestAt:toRead[0]?.at??null,items:toRead},
    questions:{open:items.length,
      checking:views.filter(preparingForHim).length,
      deferred:views.filter(question=>question.state==='deferred').length},
    requests:{open:requests.filter(request=>request.state==='open').length,closed:requests.filter(request=>request.state==='closed').length},
    work:topicWork(topic,roots,work,index)};
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
/** Thread roots nobody has filed yet: the sorting pile above the topic list. */
function sortingCaptures(session:SessionRow,index:EntryIndex) {
  const unplaced=[...index.byRoot.entries()].filter(([root])=>!topicOfRoot(root));
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
export function expireQuestionsForFinalReply(input:{workerSessionId:number;requestId:string;disposition:string;reason:string}) {
  if(!['completed','failed'].includes(input.disposition))return 0;
  const session=inboxSession();
  if(!session)return 0;
  const address=`concierge:${input.workerSessionId}`;
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

export function listTopics(options:{state?:string|null;query?:string|null;cursor?:string|null;limit?:number|null}={}) {
  const session=inboxOrThrow();
  const index=entryIndex(),work=workIndex(session.id),read=readIndex(session.id);
  const state=options.state??'open';
  if(!['open','background','closed','all'].includes(state))throw new TopicError('Unknown topic state filter.');
  const query=(options.query??'').trim().toLowerCase();
  const rows=(db.query('SELECT * FROM inbox_topics WHERE session_id=? ORDER BY updated_at DESC,topic_id').all(session.id) as any[]).map(toStoredTopic);
  let summaries=rows.map(topic=>topicSummary(topic,session,index,work,read));
  if(query)summaries=summaries.filter(topic=>[topic.title,topic.summary,...topic.aliases].join(' ').toLowerCase().includes(query));
  if(state==='open')summaries=summaries.filter(topic=>topic.state==='open');
  else if(state==='closed')summaries=summaries.filter(topic=>topic.state==='closed');
  else if(state==='background')summaries=summaries.filter(topic=>topic.state==='open'&&!topic.needsYou.count&&topic.work.kind!=='idle');
  summaries.sort((first,second)=>String(second.lastEntryAt).localeCompare(String(first.lastEntryAt)));
  const limit=Math.min(200,Math.max(1,Number(options.limit)||50));
  const offset=Math.max(0,Number(options.cursor)||0);
  const page=summaries.slice(offset,offset+limit);
  return {topics:page,nextCursor:offset+limit<summaries.length?String(offset+limit):null,
    sorting:sortingCaptures(session,index),asOf:nowIso()};
}

function topicHistory(sessionId:number,topicId:string) {
  return (db.query(`SELECT payload_json,created_at FROM session_owner_events
    WHERE session_id=? AND kind IN (${MANAGEMENT_KINDS.map(()=>'?').join(',')}) AND json_extract(payload_json,'$.topicId')=?
    ORDER BY sequence DESC LIMIT 20`).all(sessionId,...MANAGEMENT_KINDS,topicId) as any[]).map(row=>{
      const payload=JSON.parse(row.payload_json);
      return {change:payload.change,at:iso(row.created_at),by:payload.by??null,reason:payload.reason??null};
    });
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
    entries:topicEntries(topicId,null,limit)};
}

function topicEventSentence(payload:any):string {
  const title=payload.topic?.title??payload.title??'this thread';
  switch(payload.change) {
    case 'created':return `Filed under ${title}.`;
    case 'placed':return `Added ${payload.roots?.length??0} message${(payload.roots?.length??0)===1?'':'s'} to ${title}.`;
    case 'renamed':return `Renamed from ${payload.previousTitle} to ${title}${payload.reason?` because ${payload.reason}`:''}.`;
    case 'summary':return `Now: ${payload.topic?.summary??''}`;
    case 'merged':return `Merged ${payload.mergedTopic?.title??'another thread'} into ${title}.`;
    case 'closed':return `Closed: ${payload.reason??''}${payload.scope?` (${payload.scope})`:''}`;
    case 'reopened':return `Reopened: ${payload.reason??''}`;
    case 'set_aside':return `Set aside: ${payload.topic?.setAside?.reason??''}`;
    case 'resumed':return 'Picked back up.';
    case 'added':return `Request added: ${payload.request?.title??''}`;
    case 'amended':return `Request changed: ${payload.reason??payload.request?.title??''}`;
    case 'linked':return `Work linked to ${payload.request?.title??'this request'}.`;
    case 'request_closed':return `Request ${payload.request?.title??''} closed as ${payload.request?.disposition??''}: ${payload.reason??''}`;
    case 'request_reopened':return `Request ${payload.request?.title??''} reopened: ${payload.reason??''}`;
    case 'reconciled':return `Questions updated (${payload.questions?.length??0}).`;
    case 'settled':return `Question settled as ${payload.questions?.[0]?.state??''}${payload.reason?`: ${payload.reason}`:''}`;
    case 'filed':return `Filed here: ${payload.questions?.[0]?.brief?.decision??''}`;
    case 'recovered':return `${payload.questions?.length??0} earlier attention ${(payload.questions?.length??0)===1?'entry':'entries'} filed as questions${payload.reason?` (${payload.reason})`:''}.`;
    case 'recorded':return `Your answer was recorded against ${payload.mappings?.length??0} question${(payload.mappings?.length??0)===1?'':'s'}.`;
    default:return payload.change??'Updated.';
  }
}
/** Entries: this topic's Inbox messages plus its management events, in owner sequence order. */
export function topicEntries(topicId:string,cursor:string|null=null,limit:number|null=null) {
  const session=inboxOrThrow();
  const roots=new Set(topicRoots(topicId));
  const size=Math.min(200,Math.max(1,Number(limit)||30));
  const before=cursor===null||cursor===''?Number.MAX_SAFE_INTEGER:Number(cursor);
  if(!Number.isSafeInteger(before))throw new TopicError('Invalid entries cursor.');
  refreshRootMemo();
  const collected:{sequence:number;message:any}[]=[];
  let scanned=0,position=before;
  while(collected.length<size+1&&scanned<5000) {
    const rows=db.query(`${inboxRows} AND event.sequence<? ORDER BY event.sequence DESC LIMIT 500`).all(position) as any[];
    if(!rows.length)break;
    scanned+=rows.length;
    position=rows.at(-1)!.sequence;
    for(const row of rows) {
      const messageId=inboxMessageId(row);
      if(!messageId)continue;
      const root=rootOf(row.session_id,messageId);
      if(!root||!roots.has(root))continue;
      collected.push({sequence:row.sequence,message:inboxMessage(row)});
      if(collected.length>=size+1)break;
    }
  }
  const events=(db.query(`SELECT event_id,payload_json,created_at,sequence FROM session_owner_events
    WHERE session_id=? AND kind IN (${MANAGEMENT_KINDS.map(()=>'?').join(',')}) AND json_extract(payload_json,'$.topicId')=? AND sequence<?
    ORDER BY sequence DESC LIMIT ?`).all(session.id,...MANAGEMENT_KINDS,topicId,before,size+1) as any[]).map(row=>{
      const payload=JSON.parse(row.payload_json);
      return {sequence:row.sequence,message:{id:`topic-event:${row.event_id}`,role:'system',content:topicEventSentence(payload),
        topicEvent:{change:payload.change,by:payload.by??null,reason:payload.reason??null,revision:payload.revision??null},
        createdAt:iso(row.created_at)}};
    });
  const merged=[...collected,...events].sort((first,second)=>second.sequence-first.sequence);
  const page=merged.slice(0,size);
  const more=merged.length>size;
  return {messages:page.slice().reverse().map(entry=>entry.message),nextCursor:more&&page.length?String(page.at(-1)!.sequence):null};
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
  for(const row of db.query('SELECT * FROM inbox_topics WHERE session_id=? ORDER BY updated_at DESC').all(session.id) as any[]) {
    const topic=toStoredTopic(row);
    const questions=topicQuestions(topic.topicId).filter(matches);
    if(!questions.length)continue;
    const reply=latestHumanReply(read,topicRoots(topic.topicId));
    groups.push({topic:topicSummary(topic,session,index,work,read),questions:questions.map(question=>questionView(question,reply))});
  }
  return {topics:groups};
}

/* ------------------------------------------------------------------ agent commands */

function assertInbox(session:SessionRow) {
  if(!sessionMetadata(session).inbox)throw new TopicError('Only the Inbox session owns topics.',403,'TOPIC_FORBIDDEN');
}
/** A worker may declare questions against a topic it actually holds a linked dispatch for. */
function ownsLinkedDispatch(sessionId:number,topicId:string) {
  const address=`concierge:${sessionId}`;
  for(const request of topicRequests(topicId))
    if(request.dispatches.some((dispatch:any)=>dispatch.targetSessionId===address))return true;
  return false;
}
const byOf=(actor:TopicActor):TopicBy=>({kind:'agent',sessionId:`concierge:${actor.sessionId}`,inputId:actor.inputId,runId:actor.runId});

function placementRoots(session:SessionRow,values:unknown,field='--root') {
  const roots=idList(values,field);
  if(!roots.length)throw new TopicError(`${field} names at least one thread root.`);
  refreshRootMemo();
  return roots.map(value=>{
    const root=rootOf(session.id,value)??value;
    if(!getAcceptedSessionInput(root))throw new TopicError(`${value} is not a message in this Inbox.`,404,'ROOT_UNKNOWN');
    return root;
  });
}
function rootRecords(topicId:string,roots:string[],by:TopicBy,reason:string|null) {
  const at=nowIso();
  return roots.map(rootInputId=>({rootInputId,topicId,placedAt:at,placedBy:by,reason}));
}
function parseSources(values:unknown):{inputId:string;passage?:string}[] {
  return idList(values,'--source').map(value=>{
    const prefix=['capture:','request:','post:','return:','topic-event:'].find(candidate=>value.startsWith(candidate))??'';
    const rest=value.slice(prefix.length);
    const index=rest.indexOf(':');
    return index<0?{inputId:value}:{inputId:prefix+rest.slice(0,index),passage:rest.slice(index+1)};
  });
}

function createTopic(session:SessionRow,by:TopicBy,fields:{title:string;summary?:string|null;roots:string[];reason?:string|null;recovered?:boolean;splitFrom?:string|null}) {
  const at=nowIso();
  const topic:StoredTopic={topicId:`topic:${randomUUID()}`,sessionId:session.id,title:fields.title,summary:fields.summary??'',state:'open',
    setAside:null,aliases:[],revision:1,recovered:!!fields.recovered,readSequence:0,closure:null,createdBy:by,createdAt:at,updatedAt:at};
  return {topic,change:{kind:'topic',payload:{change:'created',topicId:topic.topicId,topic,
    roots:rootRecords(topic.topicId,fields.roots,by,fields.reason??null),by,reason:fields.reason??null,revision:topic.revision,
    ...(fields.splitFrom?{splitFrom:fields.splitFrom}:{})}} as Change};
}

function placeChange(session:SessionRow,topic:StoredTopic,roots:string[],by:TopicBy,reason:string|null) {
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
  return {change:{kind:'topic',payload:{change:'merged',topicId:into.topicId,topic:destination,mergedTopic:source,fromTopicId:from.topicId,
    roots,requests,questions,by,reason,revision:destination.revision}} as Change,destination,source};
}

function lastRenameBy(topicId:string):TopicBy|null {
  const row=db.query(`SELECT payload_json FROM session_owner_events WHERE kind='topic'
    AND json_extract(payload_json,'$.topicId')=? AND json_extract(payload_json,'$.change')='renamed'
    ORDER BY sequence DESC LIMIT 1`).get(topicId) as {payload_json:string}|null;
  return row?JSON.parse(row.payload_json).by??null:null;
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
  return {decision:text(item.decision,'decision',2000),
    why:{text:typeof why.text==='string'?why.text:'',sources:idList(why.sources,'why.sources')},
    known:typeof item.known==='string'?item.known:'',
    choices,uncertain,
    answerable:typeof item.answerable==='string'?item.answerable:'',
    // A reading item may name the exact messages he is to read; otherwise they are resolved
    // from the declaring run's own posts into this thread.
    ...(item.reads!==undefined?{reads:idList(item.reads,'reads')}:{})};
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
const decisionKey=(decision:string)=>decision.replace(/\s+/g,' ').trim().toLowerCase();
const briefChanged=(first:any,second:any)=>JSON.stringify(first)!==JSON.stringify(second);

function reconcileQuestions(session:SessionRow,topic:StoredTopic,declarations:unknown,by:TopicBy,reason:string|null) {
  if(!Array.isArray(declarations)||!declarations.length)throw new TopicError('Question reconciliation needs a nonempty JSON array.');
  const at=nowIso();
  const written:StoredQuestion[]=[];
  const seen=new Map<string,StoredQuestion>();
  const current=(id:string)=>seen.get(id)??questionRow(id);
  for(const item of declarations as any[]) {
    if(!item||typeof item!=='object')throw new TopicError('Each question declaration must be an object.');
    const brief=questionBrief(item);
    const blocking=item.blocking!==false,optional=item.optional===true;
    const declaredContext=questionContext(item.context);
    const state:QuestionState=item.state==='partial'?'partial':'open';
    const owner=questionOwner(item.owner);
    const sources=idList(item.sources,'sources');
    // The read API spells the identity `id`; both spellings name the same question here.
    if(item.questionId!==undefined&&item.id!==undefined&&String(item.questionId)!==String(item.id))
      throw new TopicError('questionId and id name different questions.',409,'QUESTION_ID_CONFLICT');
    const identity=item.questionId??item.id;
    // A ready question must be answerable; one that is not stays the agent's preparation. Asking
    // for `ready` with a brief that cannot be answered is refused with what is missing.
    const missing=briefMissing(brief);
    if(declaredContext==='ready'&&missing.length)throw new TopicError(`A ready question needs ${missing.join(', ')}; declare it agent_checking while it is being prepared.`,400,'QUESTION_NOT_ANSWERABLE');
    if(identity!==undefined) {
      const existing=current(String(identity));
      if(existing.topicId!==topic.topicId)throw new TopicError('That question belongs to another topic.',409,'QUESTION_TOPIC_MISMATCH');
      const context=declaredContext??(missing.length?'agent_checking':existing.context);
      const changed=briefChanged(existing.brief,brief)||existing.blocking!==blocking||existing.optional!==optional||existing.context!==context;
      const next:StoredQuestion={...existing,brief,blocking,optional,context,owner:owner===undefined?existing.owner:owner,sources:sources.length?sources:existing.sources,
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
    const filed=typeof item.from==='string'?fileNeed(session,topic,item.from,by,brief):null;
    const kind:QuestionKind=item.kind==='reading'?'reading':filed?.kind??'decision';
    const question:StoredQuestion={questionId:`q:${randomUUID()}`,topicId:topic.topicId,revision:1,state,blocking,optional,context,
      brief:typeof item.changedBecause==='string'?{...brief,changedBecause:item.changedBecause}:brief,owner:owner??(by.sessionId?{sessionId:by.sessionId,runId:by.runId??null}:null),sources:sources.length?sources:filed?.sources??[],
      replaces:typeof item.replaces==='string'?item.replaces:null,replacedBy:null,answer:null,recovered:false,legacyNeedEventId:filed?.legacyNeedEventId??null,
      kind,origin:filed?'marker':'declared',generation:filed?.generation??raiseGeneration(session),
      createdAt:filed?.createdAt??at,updatedAt:at};
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
export function topicsCommand(actor:TopicActor,body:any) {
  const session=getSessionById(actor.sessionId);
  if(!session)throw new TopicError('Unknown session.',404);
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
    if(topicId&&['questions','read'].includes(verb)&&ownsLinkedDispatch(actor.sessionId,topicId))return;
    throw new TopicError('Only the Inbox session owns topics; a worker may declare questions against a topic it holds a dispatch for.',403,'TOPIC_FORBIDDEN');
  };
  switch(verb) {
    case 'list':guard();return listTopics({state:body?.state,query:body?.query,limit:body?.limit,cursor:body?.cursor});
    case 'read':guard(String(body?.topic_id??''));return readTopic(text(body?.topic_id,'topic id',200),body?.limit);
    case 'resolve':guard();return resolveTopicMessage(text(body?.message_id,'message id',500));
    case 'questions-read':guard();return crossTopicQuestions(body?.state??null);
    case 'create':{
      assertInbox(session);
      const roots=body?.roots===undefined?[]:placementRoots(session,body.roots);
      const title=text(body?.title,'--title',200),summary=optionalText(body?.summary,'--summary',2000);
      return agentMutation(actor,actionId(),{kind:'topic-create',title,summary,roots,reason:reason()},()=>{
        for(const root of roots){const held=topicOfRoot(root);if(held)throw new TopicError(`${root} already belongs to ${held}; use topics place to move it.`,409,'ROOT_PLACED');}
        const created=createTopic(session,by,{title,summary,roots,reason:reason()});
        return {change:created.change,result:{topic:created.topic}};
      });
    }
    case 'place':{
      assertInbox(session);
      const roots=placementRoots(session,body?.roots);
      return agentMutation(actor,actionId(),{kind:'topic-place',topicId:body?.topic_id,roots,reason:reason()},()=>{
        const topic=topicFor(body?.topic_id);
        const placed=placeChange(session,topic,roots,by,reason());
        return {change:placed.change,result:{topic:placed.topic,roots}};
      });
    }
    case 'rename':{
      assertInbox(session);
      const title=text(body?.title,'title',200),why=text(body?.reason,'--reason');
      return agentMutation(actor,actionId(),{kind:'topic-rename',topicId:body?.topic_id,title,reason:why},()=>{
        const topic=topicFor(body?.topic_id);
        if(lastRenameBy(topic.topicId)?.kind==='human'&&!why.toLowerCase().includes('human-approved'))
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
        const merged=mergeChange(from,into,by,why);
        return {change:merged.change,result:{topic:merged.destination,merged:merged.source}};
      });
    }
    case 'close':{
      assertInbox(session);
      const scope=text(body?.scope,'--scope',2000),why=text(body?.reason,'reason');
      return agentMutation(actor,actionId(),{kind:'topic-close',topicId:body?.topic_id,scope,reason:why},()=>{
        const topic=topicFor(body?.topic_id);
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
        const next=bumped(topic,{state:'open',closure:null,setAside:null});
        return {change:{kind:'topic',payload:{change:'reopened',topicId:topic.topicId,topic:next,by,reason:why,revision:next.revision}},result:{topic:next}};
      });
    }
    case 'request.add':{
      assertInbox(session);
      const title=text(body?.title,'--title',200),brief=text(body?.brief,'brief',8000),sources=parseSources(body?.sources);
      return agentMutation(actor,actionId(),{kind:'topic-request-add',topicId:body?.topic_id,title,brief,sources},()=>{
        const topic=topicFor(body?.topic_id);
        const at=nowIso();
        const request:StoredRequest={requestId:`req:${randomUUID()}`,topicId:topic.topicId,title,brief,state:'open',disposition:null,
          revision:1,sources,dispatches:[],closure:null,createdAt:at,updatedAt:at};
        const next=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'added',topicId:topic.topicId,topic:next,request,by,revision:next.revision}},result:{request}};
      });
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
      return agentMutation(actor,actionId(),{kind:'topic-request-link',requestId:body?.request_id,dispatch:dispatchId},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        const local=db.query('SELECT target_session_id,outcome,status FROM session_communication_requests WHERE request_id=?').get(dispatchId) as any;
        const peer=local?null:db.query('SELECT peer,remote_session_id,outcome,status FROM session_peer_requests WHERE request_id=?').get(dispatchId) as any;
        if(!local&&!peer)throw new TopicError('That dispatch is not a request this owner sent.',404,'DISPATCH_UNKNOWN');
        const dispatch={requestId:dispatchId,targetSessionId:local?`concierge:${local.target_session_id}`:`${peer.peer}:${peer.remote_session_id}`,
          targetTitle:local?(getSessionById(local.target_session_id)&&sessionMetadata(getSessionById(local.target_session_id)!).title)??null:null,
          outcome:(local??peer).outcome??null,state:(local??peer).status??null};
        const dispatches=[...request.dispatches.filter((existing:any)=>existing.requestId!==dispatchId),dispatch];
        const next={...request,dispatches,revision:request.revision+1,updatedAt:nowIso()};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_request',payload:{change:'linked',topicId:topic.topicId,topic:topicNext,request:next,by,revision:topicNext.revision}},result:{request:next}};
      });
    }
    case 'request.close':{
      assertInbox(session);
      const disposition=String(body?.disposition??'');
      if(!DISPOSITIONS.includes(disposition))throw new TopicError(`--disposition must be one of ${DISPOSITIONS.join(', ')}.`);
      const why=text(body?.reason,'reason',4000),evidence=idList(body?.evidence,'--evidence');
      return agentMutation(actor,actionId(),{kind:'topic-request-close',requestId:body?.request_id,disposition,evidence,reason:why},()=>{
        const request=requestRow(text(body?.request_id,'request id',200));
        const topic=topicFor(request.topicId);
        const at=nowIso();
        const next={...request,state:'closed' as const,disposition,closure:{by,at,reason:why,evidence},revision:request.revision+1,updatedAt:at};
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
        const next={...request,state:'open' as const,disposition:null,closure:null,revision:request.revision+1,updatedAt:nowIso()};
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

const HUMAN_ACTIONS=['rename','summary','close','reopen','set_aside','resume','move','split','merge','read','expose','question','request','file'];

export function createTopicByHuman(body:any) {
  const session=inboxOrThrow();
  const title=text(body?.title,'title',200);
  const roots=placementRoots(session,body?.roots);
  const by:TopicBy={kind:'human'};
  return humanMutation(session.id,body?.clientActionId,{kind:'topic-create',title,roots},()=>{
    for(const root of roots){const held=topicOfRoot(root);if(held)throw new TopicError(`${root} already belongs to ${held}.`,409,'ROOT_PLACED');}
    const created=createTopic(session,by,{title,roots});
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
        const next=bumped(topic,{state:'closed',closure:{by,at,reason:why,scope,requests:topicRequests(topicId).map(request=>request.requestId)}});
        return {change:{kind:'topic',payload:{change:'closed',topicId,topic:next,scope,by,reason:why,revision:next.revision,questions}},result:{topic:next,expired:questions.length}};
      }
      case 'file':{
        const filed=fileNeed(session,topic,text(action.need,'need',200),by);
        const next=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:'filed',topicId,topic:next,questions:[filed],by,reason:'filed by Tejas',revision:next.revision}},result:{question:filed}};
      }
      case 'reopen':{
        const why=text(action.reason,'reason',4000);
        const next=bumped(topic,{state:'open',closure:null,setAside:null});
        return {change:{kind:'topic',payload:{change:'reopened',topicId,topic:next,by,reason:why,revision:next.revision}},result:{topic:next}};
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
        const created=createTopic(session,by,{title:text(action.title,'title',200),roots,splitFrom:topicId});
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
        const index=entryIndex();
        const summary=topicSummary(topic,session,index,workIndex(session.id),readIndex(session.id));
        const clamped=Math.max(topic.readSequence,Math.min(sequence,summary.lastEntrySequence));
        const next={...topic,readSequence:clamped,updatedAt:topic.updatedAt};
        return {change:{kind:'topic_reading',payload:{change:'read',topicId,topic:next,sequence:clamped,by,revision:topic.revision}},result:{readSequence:clamped}};
      }
      case 'expose':{
        if(!Array.isArray(action.items)||!action.items.length)throw new TopicError('Name the items actually shown.');
        const reading=action.items.map((item:any)=>({topicId,itemId:text(item?.id,'item id',500),
          revision:Number.isSafeInteger(Number(item?.revision))?Number(item.revision):0,kind:'exposed' as const,at,by}));
        return {change:{kind:'topic_reading',payload:{change:'exposed',topicId,reading,by,revision:topic.revision}},result:{exposed:reading.length}};
      }
      case 'question':{
        const state=String(action.state??'');
        if(!['deferred','withdrawn','read'].includes(state))throw new TopicError('He can defer, withdraw or mark a reading item read.');
        const question=questionRow(text(action.questionId,'questionId',200));
        if(question.topicId!==topicId)throw new TopicError('That question is in another topic.',409,'QUESTION_TOPIC_MISMATCH');
        if(state==='read'&&question.kind!=='reading')throw new TopicError('Only a reading item ends by being read; a decision needs an answer.',409,'QUESTION_NOT_READING');
        const why=state==='read'?'Read':text(action.reason,'reason',4000);
        const next={...question,state:state as QuestionState,updatedAt:at};
        const topicNext=bumped(topic);
        return {change:{kind:'topic_question',payload:{change:'settled',topicId,topic:topicNext,questions:[next],by,reason:why,revision:topicNext.revision}},
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
export const ATTENTION_INSTRUCTION='Anything you need from him about a thread is a question in that thread: declare it with sessions topics questions <topicId> (kind "decision" when he must answer, "reading" when he should only read it) before the turn ends. An end-of-turn needs_you/response marker with no question declared this run is held unfiled, in no thread, until you file it with sessions topics file <topicId> --need <id>; he sees it as waiting for you to file. Every question you declare is yours to end: settle it when it is answered, replaced or no longer needed.';
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
    const recent=(db.query(`SELECT topic_id,title,summary,updated_at FROM inbox_topics WHERE session_id=? AND state='open'
      ORDER BY updated_at DESC LIMIT 8`).all(sessionId) as any[]).map(row=>({id:row.topic_id,title:row.title,summary:row.summary,lastEntryAt:iso(row.updated_at)}));
    return `\n\n<topic-placement>\n${JSON.stringify({instruction:PLACEMENT_INSTRUCTION,openTopics:recent})}\n</topic-placement>`;
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
  const entries=entryIndex();
  const unrelayed=unrelayedFinal(topicRoots(topicId),entries);
  if(unrelayed)context.unrelayedResult={inputId:unrelayed.inputId,at:unrelayed.at,instruction:'A worker\'s final answer came back into this thread and you have not posted here since; relay it with sessions post --thread, or the thread keeps showing it as not relayed.'};
  return `\n\n<topic>\n${JSON.stringify(context)}\n</topic>`;
}

/* ------------------------------------------------------------------ migration */

const MIGRATION_VERSION=1;
function migrationDone(sessionId:number) {
  return !!db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='topics_migration'
    AND json_extract(payload_json,'$.version')=?`).get(sessionId,MIGRATION_VERSION);
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
  for(const row of db.query('SELECT * FROM inbox_topics WHERE session_id=? AND recovered=1').all(session.id) as any[]) {
    const topic=toStoredTopic(row);
    if(lastRenameBy(topic.topicId))continue;
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
  if(migrationDone(session.id))return {migrated:false,reason:'already_migrated'};
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
  if(db.query(`SELECT 1 FROM session_owner_events WHERE session_id=? AND kind='topics_migration' AND json_extract(payload_json,'$.version')=?`)
    .get(session.id,ATTENTION_MIGRATION_VERSION))return {migrated:false,reason:'already_migrated'};
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
          const existing=db.query(`SELECT topic_id FROM inbox_topics WHERE session_id=? AND state='open' AND title=? ORDER BY updated_at DESC LIMIT 1`).get(session.id,title) as {topic_id:string}|null;
          const placed=existing?placeChange(session,topicRow(existing.topic_id),[root],by,reason):createTopic(session,by,{title,roots:[root],reason});
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
    dispatches.push({requestId:row.request_id,targetSessionId:`${row.peer}:${row.remote_session_id}`,targetTitle:null,
      outcome:row.outcome??null,state:row.status??null});
  }
  return dispatches;
}
