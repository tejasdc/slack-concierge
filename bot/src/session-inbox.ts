import {createHash} from 'node:crypto';
import {db,type SessionRow} from './state';
import {getAcceptedSessionInput,sessionMetadata} from './session-inputs';

export type InboxCapture = {
  source:{kind:'pebble'|'thinkering'|'monologue';id:string;recordedAt:string;title?:string;metadata?:Record<string,unknown>};
  text:string;
  files?:{name:string;contentType:string;base64:string}[];
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
export function inboxHistory(session:SessionRow,cursor:string|null,limit:number) {
  if(!sessionMetadata(session).inbox)return null;
  const before=inboxHistoryBoundary(cursor);
  const rows=db.query(`SELECT event.*,input.payload_json AS input_json,input.origin,turn.agent_text
    FROM session_owner_events event
    JOIN sessions owner ON owner.id=event.session_id AND json_extract(owner.native_metadata_json,'$.inbox')=1
    LEFT JOIN session_inputs input ON input.id=event.input_id
    LEFT JOIN turns turn ON turn.id=event.turn_id
    WHERE (? IS NULL OR event.sequence<?)
      AND (event.kind='result' OR event.kind='inbox_capture'
        OR (event.kind='accepted' AND json_extract(input.payload_json,'$.capture') IS NULL))
    ORDER BY event.sequence DESC LIMIT ?`).all(before,before,limit+1) as any[];
  const page=rows.slice(0,limit);
  return {messages:page.slice().reverse().map(row=>{
    const input=row.input_json?JSON.parse(row.input_json):{},payload=input.firstInput??input;
    const result=row.kind==='result';
    const eventPayload=JSON.parse(row.payload_json);
    const attachments=(payload.attachments??[]).map((id:string)=>db.query('SELECT id,name,content_type AS contentType FROM session_attachments WHERE id=?').get(id)).filter(Boolean);
    return {id:result?row.event_id:row.input_id,sourceSessionId:row.session_id,role:result?'assistant':'user',content:result?eventPayload.text??row.agent_text??'':payload.text??'',tool:null,phase:null,
      ...(result?{}:{submissionId:row.input_id,attachments}),createdAt:row.created_at.includes('T')?row.created_at:row.created_at+'Z',timestampSource:result?'received':'submitted'};
  }),nextCursor:rows.length>limit?String(page.at(-1).sequence):null};
}

export const INBOX_INSTRUCTIONS = `This is Tejas's native Thinkering Inbox and routing workspace. Incoming captures are already retained with original source and attachment custody. Their owner-generated identity determines author and authority. Use the captureId provided by the owner for note saving and forwarding original diagnostics.
Interpret the human's intended action, not only keywords. “Take a note” saves an editable Thinkering note with sessions note; ordinary new work starts a named native session through sessions ask; an explicit request to continue specific existing work uses that session's exact address; “ask ChatGPT” selects ChatGPT explicitly. Ordinary clear requests work without magic prefixes. Ideas and quoted build proposals are not authorization to build. When intent or target is ambiguous, ask a concise clarification before effects, while keeping the capture intact. Explain useful interpretation; do not reduce collaboration to a keyword classifier.
Read the Description and requested scope before routing a bug report. Full diagnostics and images stay in attached custody; inspect relevant detail on demand. This router runs Claude Opus with 1M context from the slack-inbox project. Ordinary new destination work starts a fresh GPT-5.6 Sol session at medium effort, even when related older sessions exist. Preserve explicit requests to resume a specific session or use another provider/model/effort, as well as scoped test exceptions. Use sessions projects to select the actual destination folder: Concierge code belongs to slack-concierge, Thinkering code belongs to thinkering. D0BMWUJ3RD5 is the retired DM workspace, never a fallback for missing projects. If the exact project is absent or unclear, ask; do not borrow this Inbox cwd or another project's cwd. For an explicit resume request, use sessions search/context to establish the exact intended session; clarify an ambiguous target. Search returns canonical sessions and exact addresses, not a new Slack channel. Honor Stop/archive and source policy, and never recreate Slack channels or route through deprecated Slack posts.
Capture imports have no automatic execution. Existing report assignments and uncertain effects are historical evidence, not permission to resend them. Route only the work Tejas authorizes, with one stable action and exact attachments. Return meaningful status here through the existing request obligations. No tests, sandbox, review cycle or experiment unless the particular human investigation explicitly authorizes that exception.`;
