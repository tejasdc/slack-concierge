import {createHash} from 'node:crypto';
import {db,type SessionRow} from './state';
import {getAcceptedSessionInput,sessionMetadata} from './session-inputs';

export type InboxCapture = {
  source:{kind:'pebble'|'thinkering'|'monologue';id:string;recordedAt:string;title?:string;metadata?:Record<string,unknown>};
  text:string;
  // transcript: words the capturing phone already made for this audio; kept with it so nothing
  // transcribes it again.
  files?:{name:string;contentType:string;base64:string;transcript?:unknown}[];
  importOnly?:boolean;
};
export const captureIdentity=(source:InboxCapture['source'])=>createHash('sha256').update(JSON.stringify([source.kind,source.id])).digest('hex');
export function inboxSession() {
  return db.query("SELECT * FROM sessions WHERE json_extract(native_metadata_json,'$.inbox')=1 ORDER BY id DESC LIMIT 1").get() as SessionRow|null;
}
export function retainedInboxCapture(captureId:string) {
  const input=getAcceptedSessionInput(`capture:${captureId}`);
  if(!input||!JSON.parse(input.payload_json).capture)throw new Error('Unknown retained Inbox capture.');
  return input;
}
export function capturePresentation(input:InboxCapture) {
  const files=[...(input.files??[])];
  const report=input.source.kind==='thinkering'&&input.text.startsWith('Thinkering bug report\n')&&input.text.includes('\nDescription:\n');
  let text=input.text;
  if(report) {
    const diagnostics=input.text.indexOf('\nComplete diagnostics JSON');
    if(diagnostics>=0)text=input.text.slice(0,diagnostics).trimEnd();
    files.unshift({name:'thinkering-bug-report.txt',contentType:'text/plain',base64:Buffer.from(input.text).toString('base64')});
  }
  return {text,files,report};
}

// The Inbox uses its accepted dialogue, including imports that never enter a
// provider transcript. Event sequence is the existing durable pagination key.
function inboxHistoryBoundary(cursor:string|null) {
  if(cursor===null)return null;
  if(!/^[1-9][0-9]*$/.test(cursor))throw new Error('INVALID_HISTORY_REFERENCE');
  const before=Number(cursor);
  if(!Number.isSafeInteger(before))throw new Error('INVALID_HISTORY_REFERENCE');
  return before;
}
// The Inbox's dialogue is its own ledger rows, so the page and the delta share one query
// shape and one mapping; they cannot disagree about what an Inbox message looks like.
export const inboxRows=`SELECT event.*,input.payload_json AS input_json,input.origin,turn.agent_text
    FROM session_owner_events event
    JOIN sessions owner ON owner.id=event.session_id AND json_extract(owner.native_metadata_json,'$.inbox')=1
    LEFT JOIN session_inputs input ON input.id=event.input_id
    LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE (event.kind='result' OR event.kind='inbox_capture' OR event.kind='post'
        OR (event.kind='accepted' AND json_extract(input.payload_json,'$.capture') IS NULL))
    -- A turn that said nothing of its own is not a message: its thread shows no reply rather
    -- than a sentence nobody wrote. A result that carries files is still a message.
    AND (event.kind<>'result' OR COALESCE(json_extract(event.payload_json,'$.text'), turn.agent_text, '')<>'' OR json_array_length(COALESCE(json_extract(event.payload_json,'$.attachments'),'[]'))>0)`;
/** The id the history page gives an Inbox row: an agent message is its event, a human message its input. */
export const inboxMessageId=(row:{kind:string;event_id:string;input_id:string|null})=>['result','post'].includes(row.kind)?row.event_id:row.input_id;
export function inboxMessage(row:any) {
  const input=row.input_json?JSON.parse(row.input_json):{},payload=input.firstInput??input;
  // A post is the agent answering a thread on purpose; a result is its whole turn's text.
  const result=row.kind==='result',post=row.kind==='post',agent=result||post;
  const eventPayload=JSON.parse(row.payload_json);
  // An agent message carries its own files: a post names them, and a result names them when
  // the retained result payload does. A human capture or a returned answer carries the
  // attachments of its accepted input.
  const attachments=((agent?eventPayload.attachments:payload.attachments)??[])
    .map((id:string)=>db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id)).filter(Boolean);
  // A result names the input it answers, so an Inbox thread is one request plus the
  // messages carrying its inputId rather than whichever rows happen to sit next to it.
  // A post carries its thread's root input the same way.
  const link=!agent&&row.input_id?inboxThreadLink(row.session_id,row.input_id):null;
  // A turn's closing words belong to one thread or none: a turn that asked or posted for
  // another thread has its result marked, and a thread's conversation leaves it out.
  const mixed=result&&typeof row.turn_id==='number'?turnMixesThreads(row.session_id,row.turn_id,row.input_id):false;
  return {id:agent?row.event_id:row.input_id,sourceSessionId:row.session_id,role:agent?'assistant':'user',...(mixed?{mixedThreads:true}:{}),
    content:post?eventPayload.text??'':result?eventPayload.text??row.agent_text??'':payload.text??'',tool:null,phase:null,
    ...(row.input_id?{inputId:row.input_id}:{}),
    ...(post?{replyToMessage:eventPayload.replyToMessage,author:{kind:'agent' as const,communication:'post' as const}}:{}),
    // Placed into a thread by whoever decided it: the app shows that it was routed, and
    // offers to split it back out, without labelling his own thread replies.
    ...(link?.attached?{replyToMessage:{kind:'message' as const,sessionId:`concierge:${row.session_id}`,messageId:link.thread},routedBy:link.routedBy}:{}),
    ...(agent?(attachments.length?{attachments}:{}):{submissionId:row.input_id,attachments}),createdAt:row.created_at.includes('T')?row.created_at:row.created_at+'Z',timestampSource:agent?'received':'submitted'};
}
/**
 * Where an accepted capture was placed, when someone said it continues a thread rather
 * than starting one. A dictated answer to the Inbox's question arrives as its own capture
 * with no link of its own, so it opened a second request row (Tejas, 2026-09-20). The link
 * is an additive record: the retained input keeps its own bytes, the latest record wins,
 * and detaching returns the capture to its own row.
 */
export type InboxThreadLink={inputId:string;root:string;thread:string;attached:boolean;routedBy:any;at:string};
export function inboxThreadLink(sessionId:number,inputId:string):InboxThreadLink|null {
  const row=db.query(`SELECT payload_json,created_at FROM session_owner_events
    WHERE session_id=? AND kind='thread_link' AND input_id=? ORDER BY sequence DESC LIMIT 1`).get(sessionId,inputId) as {payload_json:string;created_at:string}|null;
  if(!row)return null;
  const payload=JSON.parse(row.payload_json);
  return {inputId,root:payload.root,thread:payload.thread,attached:payload.attached!==false,routedBy:payload.routedBy??null,
    at:row.created_at.includes('T')?row.created_at:row.created_at+'Z'};
}

/**
 * The input at the root of the Inbox thread a message belongs to, or null when that
 * message is not one of this session's Inbox messages. It uses the page's own id rules:
 * a request or capture is its own root, and a result or earlier post carries its root
 * forward, so an answer anywhere in a thread stays in that thread.
 */
/**
 * One Inbox row by message id. Two lookups rather than one OR: with the OR, SQLite walked
 * every event of the session for each message (16 ms each; the first Threads read after a
 * restart took a minute resolving 2,000 messages, 2026-09-22). Each half uses its own index.
 */
export function inboxRowByMessageId(sessionId:number|null,messageId:string):any|null {
  const scope=sessionId===null?'':' AND event.session_id=?';
  const bind=sessionId===null?[messageId]:[sessionId,messageId];
  return db.query(`${inboxRows}${scope} AND event.kind IN ('result','post') AND event.event_id=? ORDER BY event.sequence LIMIT 1`).get(...bind)
    ??db.query(`${inboxRows}${scope} AND event.kind NOT IN ('result','post') AND event.input_id=? ORDER BY event.sequence LIMIT 1`).get(...bind)
    ??null;
}
export function inboxThreadRoot(sessionId:number,messageId:string,seen=new Set<string>()):string|null {
  const row=inboxRowByMessageId(sessionId,messageId) as {input_id:string|null}|null;
  if(!row?.input_id)return row?.input_id??null;
  if(seen.has(row.input_id))return row.input_id;
  seen.add(row.input_id);
  // A capture placed into a thread answers that thread's root, so everything answering it
  // stays there too.
  const link=inboxThreadLink(sessionId,row.input_id);
  if(link?.attached)return link.root;
  // A returned answer is not a thread of its own: it belongs to the thread of the request it
  // settles, found through the input that request was sent from (which may itself be a
  // reply or another return). Filing it as its own thread left questions Tejas had already
  // answered open in Needs attention (2026-09-21).
  // His own reply in a thread belongs to the thread it replies in.
  const own=getAcceptedSessionInput(row.input_id);
  const replyTo=own?.origin==='human'?JSON.parse(own.payload_json).replyToMessage:null;
  if(typeof replyTo?.messageId==='string'&&replyTo.messageId!==row.input_id)
    return inboxThreadRoot(sessionId,replyTo.messageId,seen)??row.input_id;
  const sent=returnedRequestSource(sessionId,row.input_id);
  return sent?inboxThreadRoot(sessionId,sent,seen)??row.input_id:row.input_id;
}
/** The input a service return's request was sent from, when this Inbox sent that request. */
function returnedRequestSource(sessionId:number,inputId:string):string|null {
  const input=getAcceptedSessionInput(inputId);
  if(!input||input.origin!=='service'||!input.request_id)return null;
  return requestThreadSource(sessionId,input.request_id);
}
/**
 * The message a request's returns file under: the thread the sender named when it asked, else
 * the input its turn started from. Naming is what stops a turn that handles several threads
 * from filing one thread's results under another (Tejas, 2026-09-23: "if you're going to
 * send this request, you have to tell me which thread it's for").
 */
export function requestThreadSource(sessionId:number,requestId:string):string|null {
  const local=db.query('SELECT source_input_id,thread_root_input_id FROM session_communication_requests WHERE request_id=? AND source_session_id=?').get(requestId,sessionId) as {source_input_id:string|null;thread_root_input_id:string|null}|null;
  if(local)return local.thread_root_input_id??local.source_input_id??null;
  const peer=db.query('SELECT source_input_id,thread_root_input_id FROM session_peer_requests WHERE request_id=? AND source_session_id=?').get(requestId,sessionId) as {source_input_id:string|null;thread_root_input_id:string|null}|null;
  return peer?.thread_root_input_id??peer?.source_input_id??null;
}
/**
 * The thread an Inbox request works for, resolved at admission: the exact message the sender
 * named, followed to its root, which must already be in a topic. Any other session has no
 * threads and names none. The refusals are addressed to the agent, before anything is sent.
 */
export function inboxRequestThread(session:SessionRow,thread:unknown):string|null {
  if(!sessionMetadata(session).inbox) {
    if(thread!==undefined)throw new Error('Only the Inbox names a thread on a request; this session has no threads. Nothing was sent.');
    return null;
  }
  if(typeof thread!=='string'||!thread.trim())throw new Error('An Inbox request names the thread it works for: --thread <message id of the capture, reply or post it is for>. Nothing was sent.');
  const root=inboxThreadRoot(session.id,thread.trim());
  if(!root)throw new Error('That message is not in your Inbox. Nothing was sent.');
  if(!db.query('SELECT 1 FROM inbox_topic_roots WHERE root_input_id=?').get(root))throw new Error('That thread is still being sorted; place it first (sessions topics place or create). Nothing was sent.');
  return root;
}
/** Whether a turn's asks and posts named a thread other than the one its own input is in. */
export function turnMixesThreads(sessionId:number,turnId:number,ownInputId:string|null):boolean {
  const own=ownInputId?inboxThreadRoot(sessionId,ownInputId):null;
  const named=new Set<string>();
  for(const row of db.query('SELECT COALESCE(thread_root_input_id,source_input_id) AS root FROM session_communication_requests WHERE source_turn_id=? AND source_session_id=?').all(turnId,sessionId) as {root:string|null}[])
    if(row.root)named.add(inboxThreadRoot(sessionId,row.root)??row.root);
  for(const row of db.query('SELECT COALESCE(thread_root_input_id,source_input_id) AS root FROM session_peer_requests WHERE source_turn_id=? AND source_session_id=?').all(turnId,sessionId) as {root:string|null}[])
    if(row.root)named.add(inboxThreadRoot(sessionId,row.root)??row.root);
  for(const row of db.query("SELECT input_id FROM session_owner_events WHERE session_id=? AND turn_id=? AND kind='post'").all(sessionId,turnId) as {input_id:string|null}[])
    if(row.input_id)named.add(row.input_id);
  return [...named].some(root=>root!==own);
}
/** One Inbox message by the id its history page gives it, or null when the Inbox has no such message. */
export function inboxMessageById(sessionId:number,messageId:string) {
  const row=inboxRowByMessageId(sessionId,messageId);
  return row?inboxMessage(row):null;
}
export function inboxHistory(session:SessionRow,cursor:string|null,limit:number) {
  if(!sessionMetadata(session).inbox)return null;
  const before=inboxHistoryBoundary(cursor);
  const rows=db.query(`${inboxRows} AND (? IS NULL OR event.sequence<?) ORDER BY event.sequence DESC LIMIT ?`).all(before,before,limit+1) as any[];
  const page=rows.slice(0,limit);
  return {messages:page.slice().reverse().map(inboxMessage),nextCursor:rows.length>limit?String(page.at(-1).sequence):null};
}
/**
 * Every Inbox message the ledger added after `after`, oldest first. Inbox rows are
 * append-only and are never rewritten, so rows after a sequence are the whole change.
 * Returns null when more than `limit` arrived: a client that far behind gains nothing
 * over one latest-page read, which is the bounded primitive for that case.
 */
export function inboxHistoryAfter(session:SessionRow,after:number,limit:number) {
  if(!sessionMetadata(session).inbox)return null;
  const rows=db.query(`${inboxRows} AND event.sequence>? ORDER BY event.sequence LIMIT ?`).all(after,limit+1) as any[];
  return rows.length>limit?null:rows.map(inboxMessage);
}

export const INBOX_INSTRUCTIONS = `This is Tejas's native Thinkering Inbox and routing workspace. Incoming captures are already retained with original source and attachment custody. Their owner-generated identity determines author and authority. Use the captureId provided by the owner for note saving and forwarding original diagnostics.
Interpret the human's intended action, not only keywords. “Take a note” saves an editable Thinkering note with sessions note; work follows the session that owns its surface when one exact owner can be established, otherwise it starts a named native session through sessions ask; “ask ChatGPT” selects ChatGPT explicitly. Ordinary clear requests work without magic prefixes. Ideas and quoted build proposals are not authorization to build. When intent or target is ambiguous, ask a concise clarification before effects, while keeping the capture intact. Explain useful interpretation; do not reduce collaboration to a keyword classifier.
Read the Description and requested scope before routing a bug report. Full diagnostics and images stay in attached custody; inspect relevant detail on demand. This router runs Claude Opus with 1M context from the slack-inbox project. A live or recently completed session that built the thing the capture concerns owns its follow-up work; continue it at its exact address so adjacent changes to one surface compose under one owner. Use sessions search/context and judge title, project, source, dialogue and send capability. Mere topical similarity and consultation-only evidence do not establish ownership; clarify an ambiguous target instead of guessing. Start a fresh Claude Opus session with --provider cc-opus when no session owns the work or the surface is genuinely different. Preserve explicit human session/provider/model/effort choices and scoped test exceptions. Use sessions projects to select the actual destination folder: Concierge code belongs to slack-concierge, Thinkering code belongs to thinkering. Decide the machine yourself from the capture; never ask which machine. Work belongs on the mac peer instance (Tejas's laptop) when it names a local file path, Xcode, iMessage, Finder, Simulator or another Mac app, carries a #mac chip, or when he says "on the Mac"/"on my laptop"; ChatGPT or server work stays here; with no signal, use the machine the most recent session in the same project folder ran on (search results carry each session's owner), else here — every project folder exists on both machines, so the folder alone never decides. sessions ask --peer mac --provider cc-opus --project <folder> --session-name <title> starts the session there and its answer returns here like any other request. sessions search covers both instances from the transcript archive first, so a live session that owns the work is continued at its discovered address wherever it runs, and a Mac session is still found and addressable while the Mac is offline: the ask is queued and delivered when it wakes — say so in your reply instead of failing. D0BMWUJ3RD5 is the retired DM workspace, never a fallback for missing projects. If the exact project is absent or unclear, ask; do not borrow this Inbox cwd or another project's cwd. Search returns canonical sessions and exact addresses, not a new Slack channel. Honor Stop/archive and source policy, and never recreate Slack channels or route through deprecated Slack posts.
Capture imports have no automatic execution. Existing report assignments and uncertain effects are historical evidence, not permission to resend them. Route only the work Tejas authorizes, with one stable action and exact attachments. Return meaningful status here through the existing request obligations. No tests, sandbox, review cycle or experiment unless the particular human investigation explicitly authorizes that exception.`;
