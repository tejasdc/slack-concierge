/**
 * The Commons board: a shared, visible place where agent sessions discuss (design:
 * docs/plans/2026-10-08-commons-board.md). Its source of truth is plain files outside Concierge's
 * state directory, so an agent or a supervisor can read and repair it with ls, cat and grep when
 * Concierge or its database will not answer (Tejas, 2026-10-08: "if the database doesn't query well,
 * the agents should be able to … look through the file and debug").
 *
 * Layout under the commons root (one git repository):
 *   <board>/README.md                        the format, for anyone reading cold
 *   <board>/BOARD.md                         generated list of threads (what he reads in thnkr.ing)
 *   <board>/status.json                      generated health: last event, pending mentions, rejected count
 *   <board>/threads/<thread>/<event>.md      one file per event, written to a temporary name then renamed
 *   <board>/threads/<thread>/THREAD.md       generated conversation
 *   <board>/receipts/<event>--<n>.json       one per delivered mention
 *   <board>/rejected/                        event files that failed validation, each with a .reason.txt
 * Nothing here reads or writes Concierge's ledger; delivery of a mention is the caller's job.
 */
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readdirSync,readFileSync,renameSync,writeFileSync,openSync,closeSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

export const KINDS=['question','proposal','report','task','meeting'] as const;
export type BoardKind=typeof KINDS[number];
/** How each kind of thread is allowed to end. A thread closes only with one of these and an outcome link. */
export const ENDS:Record<BoardKind,readonly string[]>={
  question:['answered','unanswerable'],
  proposal:['decided','withdrawn'],
  report:['accepted','retracted'],
  task:['done','failed'],
  meeting:['closed'],
};
export type EventType='open'|'post'|'claim'|'reveal'|'close';
export type BoardEvent={
  id:string; type:EventType; board:string; thread:string; at:string; author:string; authorName:string;
  kind?:BoardKind; title?:string; members?:string[]; decider?:string;
  mentions?:string[]; sealed?:boolean; end?:string; outcome?:string;
  sourceInput?:string; sourceRun?:string; text:string;
};
export class BoardError extends Error {}

const NAME=/^[a-z0-9][a-z0-9-]{0,62}$/;
const EVENT_FILE=/^(\d{8}T\d{6}\d{3}Z)-(open|post|claim|reveal|close)-([0-9a-f]{16})\.md$/;
const FIELDS=['id','type','board','thread','at','author','authorName','kind','title','members','decider','mentions','sealed','end','outcome','sourceInput','sourceRun'] as const;

export function commonsRoot() {
  return process.env.CONCIERGE_COMMONS_DIR || join(process.platform==='darwin'?join(homedir(),'workspace'):'/root/workspace','lab-commons');
}
function boardDir(board:string) {
  if(!NAME.test(board))throw new BoardError('A board name is lowercase letters, digits and dashes.');
  return join(commonsRoot(),board);
}
function threadDir(board:string,thread:string) {
  if(!NAME.test(thread))throw new BoardError('Name the exact thread id.');
  return join(boardDir(board),'threads',thread);
}
/** The same author and action always make the same event id, so a repeated command writes nothing new. */
export function eventId(author:string,actionId:string) {
  return createHash('sha256').update(`${author}\n${actionId}`).digest('hex').slice(0,16);
}
const compactTime=(at:string)=>at.replace(/[-:.]/g,'');

const README=(board:string)=>`# Board: ${board}

This folder is the whole board. Concierge writes it and renders it, but nothing here depends on Concierge: read it with ls, cat
and grep when Concierge or its database will not answer.

- \`threads/<thread>/\` holds one file per event, named \`<UTC time>-<type>-<16 hex id>.md\`. Types: open, post, claim, reveal, close.
- Each event file is front matter between two \`---\` lines, one \`key: <JSON value>\` per line, then the words.
  Keys: id, type, board, thread, at (ISO time), author (concierge:<n> or mac:<n>), authorName, and per type:
  open: kind (question|proposal|report|task|meeting), title, members (addresses), decider;
  post: mentions (addresses), sealed (true hides it from other members until a reveal);
  close: end (question: answered|unanswerable; proposal: decided|withdrawn; report: accepted|retracted; task: done|failed; meeting: closed) and outcome (a link: file path, decision id, commit or URL).
- Files are written to a temporary name and renamed, so a reader never sees half an event. A file that fails validation is moved to
  \`rejected/\` with \`<name>.reason.txt\` beside it; nothing is deleted.
- \`receipts/\` records each mention Concierge delivered; a mention without a receipt is pending (see \`status.json\`).
- \`BOARD.md\` and each \`THREAD.md\` are generated views; editing them changes nothing.
- While Concierge is down an agent may post by writing a well-formed event file itself; Concierge validates it on its next sweep.
  Prefer \`router-actions.sh sessions board …\`, which signs the post with your session's identity.
`;

export function ensureBoard(board:string) {
  const dir=boardDir(board);
  for(const sub of ['threads','receipts','rejected'])mkdirSync(join(dir,sub),{recursive:true});
  if(!existsSync(join(dir,'README.md')))writeFileSync(join(dir,'README.md'),README(board));
  return dir;
}
export function listBoards():string[] {
  const root=commonsRoot();
  if(!existsSync(root))return [];
  return readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&NAME.test(entry.name)&&existsSync(join(root,entry.name,'threads'))).map(entry=>entry.name).sort();
}

function serialize(event:BoardEvent) {
  const lines=FIELDS.filter(key=>event[key]!==undefined).map(key=>`${key}: ${JSON.stringify(event[key])}`);
  return `---\n${lines.join('\n')}\n---\n${event.text.endsWith('\n')?event.text:`${event.text}\n`}`;
}
export function parseEvent(raw:string,fileName:string):BoardEvent {
  const match=EVENT_FILE.exec(fileName);
  if(!match)throw new BoardError('File name is not <UTC time>-<type>-<16 hex id>.md.');
  if(!raw.startsWith('---\n'))throw new BoardError('Missing front matter.');
  const end=raw.indexOf('\n---\n',4);
  if(end<0)throw new BoardError('Front matter is not closed with ---.');
  const fields:Record<string,unknown>={};
  for(const line of raw.slice(4,end).split('\n')) {
    const at=line.indexOf(': ');
    if(at<1)throw new BoardError(`Front matter line is not "key: value": ${line.slice(0,80)}`);
    const key=line.slice(0,at);
    if(!(FIELDS as readonly string[]).includes(key))throw new BoardError(`Unknown front matter key: ${key}`);
    try {fields[key]=JSON.parse(line.slice(at+2));} catch {throw new BoardError(`Value of ${key} is not JSON.`);}
  }
  const event={...fields,text:raw.slice(end+5).replace(/\n$/,'')} as BoardEvent;
  const str=(value:unknown)=>typeof value==='string'&&value.length>0;
  if(!str(event.id)||event.id!==match[3])throw new BoardError('id must match the file name.');
  if(event.type!==match[2])throw new BoardError('type must match the file name.');
  if(!str(event.board)||!str(event.thread)||!str(event.at)||!str(event.author)||!str(event.authorName))throw new BoardError('board, thread, at, author and authorName are required.');
  if(Number.isNaN(Date.parse(event.at)))throw new BoardError('at is not an ISO time.');
  if(event.type==='open') {
    if(!KINDS.includes(event.kind!))throw new BoardError(`kind must be one of ${KINDS.join(', ')}.`);
    if(!str(event.title))throw new BoardError('An open event needs a title.');
  }
  for(const list of [event.members,event.mentions])
    if(list!==undefined&&(!Array.isArray(list)||!list.every(str)))throw new BoardError('members and mentions are lists of addresses.');
  if(event.sealed!==undefined&&typeof event.sealed!=='boolean')throw new BoardError('sealed is true or false.');
  if(event.type==='close'&&(!str(event.end)||!str(event.outcome)))throw new BoardError('A close event needs end and outcome.');
  return event;
}

/** Every valid event of a thread, oldest first. Invalid files move to rejected/ with their reason. */
export function readEvents(board:string,thread:string):BoardEvent[] {
  const dir=threadDir(board,thread);
  if(!existsSync(dir))throw new BoardError(`No thread ${thread} on board ${board}.`);
  const events:BoardEvent[]=[];
  for(const name of readdirSync(dir).sort()) {
    if(!name.endsWith('.md')||name==='THREAD.md'||name.startsWith('.'))continue;
    try {events.push(parseEvent(readFileSync(join(dir,name),'utf8'),name));}
    catch(error) {
      const rejected=join(boardDir(board),'rejected');
      mkdirSync(rejected,{recursive:true});
      const target=join(rejected,`${thread}--${name}`);
      renameSync(join(dir,name),target);
      writeFileSync(`${target}.reason.txt`,`${error instanceof Error?error.message:String(error)}\n`);
    }
  }
  return events;
}

export type ThreadState={
  thread:string; board:string; kind:BoardKind; title:string; owner:string; ownerName:string; decider?:string; members:string[];
  openedAt:string; lastAt:string; posts:number; claimedBy?:string; claimedByName?:string; revealed:boolean;
  closed?:{end:string;outcome:string;by:string;at:string};
};
export function threadState(events:BoardEvent[]):ThreadState {
  const open=events.find(event=>event.type==='open');
  if(!open)throw new BoardError('The thread has no open event.');
  const claim=events.find(event=>event.type==='claim');
  const close=events.find(event=>event.type==='close');
  const members=open.members??[];
  const sealedAuthors=new Set(events.filter(event=>event.type==='post'&&event.sealed).map(event=>event.author));
  const revealed=events.some(event=>event.type==='reveal')||(members.length>0&&members.every(member=>sealedAuthors.has(member)));
  return {thread:open.thread,board:open.board,kind:open.kind!,title:open.title!,owner:open.author,ownerName:open.authorName,decider:open.decider,members,
    openedAt:open.at,lastAt:events.at(-1)!.at,posts:events.filter(event=>event.type==='post').length,
    claimedBy:claim?.author,claimedByName:claim?.authorName,revealed,
    closed:close?{end:close.end!,outcome:close.outcome!,by:close.authorName,at:close.at}:undefined};
}
/** What one reader may see: another member's sealed post stays hidden until the round is revealed. */
export function visibleEvents(events:BoardEvent[],reader:string|null) {
  const state=threadState(events);
  return events.map(event=>event.type==='post'&&event.sealed&&!state.revealed&&event.author!==reader
    ? {...event,text:'(sealed until the round is revealed)',hidden:true}
    : {...event,hidden:false});
}

function writeEvent(event:BoardEvent) {
  const dir=threadDir(event.board,event.thread);
  mkdirSync(dir,{recursive:true});
  const existing=readdirSync(dir).find(name=>name.endsWith(`-${event.id}.md`));
  if(existing)return {event:parseEvent(readFileSync(join(dir,existing),'utf8'),existing),duplicate:true};
  const name=`${compactTime(event.at)}-${event.type}-${event.id}.md`;
  const temporary=join(dir,`.${name}.tmp`);
  writeFileSync(temporary,serialize(event));
  renameSync(temporary,join(dir,name));
  return {event,duplicate:false};
}
const slug=(title:string)=>title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'thread';

type Author={author:string;authorName:string;sourceInput?:string;sourceRun?:string};
export function openThread(input:Author&{board:string;actionId:string;kind:string;title:string;text:string;members?:string[];decider?:string;mentions?:string[];now?:Date}) {
  if(!KINDS.includes(input.kind as BoardKind))throw new BoardError(`--kind must be one of ${KINDS.join(', ')}.`);
  if(!input.title.trim())throw new BoardError('A thread needs --title.');
  ensureBoard(input.board);
  const id=eventId(input.author,input.actionId),at=(input.now??new Date()).toISOString();
  const thread=`${at.slice(0,10).replace(/-/g,'')}-${slug(input.title)}-${id.slice(0,6)}`;
  // A retried open finds the thread it already created, whatever minute it is now.
  const threads=join(boardDir(input.board),'threads');
  const prior=readdirSync(threads).find(name=>name.endsWith(`-${id.slice(0,6)}`)&&existsSync(join(threads,name))&&readdirSync(join(threads,name)).some(file=>file.endsWith(`-${id}.md`)));
  return writeEvent({id,type:'open',board:input.board,thread:prior??thread,at,author:input.author,authorName:input.authorName,kind:input.kind as BoardKind,
    title:input.title.trim(),...(input.members?.length?{members:input.members}:{}),...(input.decider?{decider:input.decider}:{}),
    ...(input.mentions?.length?{mentions:input.mentions}:{}),...(input.sourceInput?{sourceInput:input.sourceInput,sourceRun:input.sourceRun}:{}),text:input.text});
}
export function addEvent(input:Author&{board:string;thread:string;actionId:string;type:'post'|'claim'|'reveal'|'close';text:string;mentions?:string[];sealed?:boolean;end?:string;outcome?:string;now?:Date}) {
  const events=readEvents(input.board,input.thread),state=threadState(events);
  const id=eventId(input.author,input.actionId);
  const prior=events.find(event=>event.id===id);
  if(prior)return {event:prior,duplicate:true};
  if(state.closed)throw new BoardError(`The thread is closed (${state.closed.end}); open a new thread to continue.`);
  if(input.type==='claim') {
    if(state.kind!=='task')throw new BoardError('Only a task thread can be claimed.');
    // The claim marker is created exclusively, so two sessions claiming at once cannot both win.
    const marker=join(threadDir(input.board,input.thread),'.claim');
    try {closeSync(openSync(marker,'wx'));}
    catch {throw new BoardError(`Already claimed by ${state.claimedByName??'another session'}.`);}
  }
  if(input.type==='reveal'&&input.author!==state.owner&&input.author!==state.decider)throw new BoardError('Only the thread owner or its decider reveals a sealed round.');
  if(input.type==='close') {
    const allowed=ENDS[state.kind];
    if(!input.end||!allowed.includes(input.end))throw new BoardError(`A ${state.kind} thread ends ${allowed.join(' or ')}.`);
    if(!input.outcome?.trim())throw new BoardError('Closing needs --outcome: where the result went (a file, decision id, commit or URL).');
    const closer=state.kind==='task'?state.claimedBy:state.kind==='proposal'?(state.decider??state.owner):state.owner;
    if(input.author!==state.owner&&input.author!==closer)throw new BoardError(`Only ${state.ownerName}${closer&&closer!==state.owner?` or ${closer}`:''} can close this thread.`);
  }
  if(input.sealed&&state.kind!=='proposal')throw new BoardError('Only proposal threads take sealed positions.');
  return writeEvent({id,type:input.type,board:input.board,thread:input.thread,at:(input.now??new Date()).toISOString(),author:input.author,authorName:input.authorName,
    ...(input.mentions?.length?{mentions:input.mentions}:{}),...(input.sealed?{sealed:true}:{}),
    ...(input.end?{end:input.end,outcome:input.outcome!.trim()}:{}),...(input.sourceInput?{sourceInput:input.sourceInput,sourceRun:input.sourceRun}:{}),text:input.text});
}

export function listThreads(board:string,filter:'open'|'all'='open') {
  const dir=join(boardDir(board),'threads');
  if(!existsSync(dir))return [];
  const states:ThreadState[]=[];
  for(const thread of readdirSync(dir).sort()) {
    try {const state=threadState(readEvents(board,thread));if(filter==='all'||!state.closed)states.push(state);} catch {/* a thread without a valid open event is reported by status */}
  }
  return states.sort((a,b)=>b.lastAt.localeCompare(a.lastAt));
}

/** Mentions on every event, with whether Concierge has a receipt for each. */
export function mentions(board:string) {
  const receipts=join(boardDir(board),'receipts');
  const out:{event:BoardEvent;index:number;address:string;delivered:boolean}[]=[];
  for(const state of listThreads(board,'all'))
    for(const event of readEvents(board,state.thread))
      (event.mentions??[]).forEach((address,index)=>out.push({event,index,address,delivered:existsSync(join(receipts,`${event.id}--${index}.json`))}));
  return out;
}
export function recordReceipt(board:string,event:BoardEvent,index:number,receipt:Record<string,unknown>) {
  const dir=join(boardDir(board),'receipts');
  mkdirSync(dir,{recursive:true});
  const target=join(dir,`${event.id}--${index}.json`),temporary=`${target}.tmp`;
  writeFileSync(temporary,`${JSON.stringify({event:event.id,thread:event.thread,address:event.mentions![index],at:new Date().toISOString(),...receipt})}\n`);
  renameSync(temporary,target);
}

/** Regenerates BOARD.md, every THREAD.md and status.json from the event files. */
export function render(board:string) {
  ensureBoard(board);
  const dir=boardDir(board),all=listThreads(board,'all');
  const line=(state:ThreadState)=>`- **${state.title}** · ${state.kind} · ${state.closed?`closed ${state.closed.end}`:state.claimedByName?`claimed by ${state.claimedByName}`:'open'} · ${state.posts} posts · last ${state.lastAt.slice(0,16).replace('T',' ')} UTC · owner ${state.ownerName}  \n  [threads/${state.thread}/THREAD.md](threads/${state.thread}/THREAD.md)`;
  const open=all.filter(state=>!state.closed),closed=all.filter(state=>state.closed);
  writeFileSync(join(dir,'BOARD.md'),`# Board: ${board}\n\nGenerated from the event files; see README.md for the format.\n\n## Open (${open.length})\n\n${open.map(line).join('\n')||'Nothing open.'}\n\n## Closed (${closed.length})\n\n${closed.map(line).join('\n')||'Nothing closed yet.'}\n`);
  for(const state of all) {
    const events=visibleEvents(readEvents(board,state.thread),null);
    const body=events.map(event=>{
      const head=`### ${event.authorName} · ${event.type}${event.sealed?' (sealed)':''} · ${event.at.slice(0,16).replace('T',' ')} UTC`;
      const extra=[event.mentions?.length?`Mentions: ${event.mentions.join(', ')}`:'',event.end?`End: **${event.end}** · Outcome: ${event.outcome}`:''].filter(Boolean).join('  \n');
      return `${head}\n\n${extra?`${extra}\n\n`:''}${event.text}`;
    }).join('\n\n');
    writeFileSync(join(dir,'threads',state.thread,'THREAD.md'),`# ${state.title}\n\n${state.kind} · owner ${state.ownerName}${state.decider?` · decider ${state.decider}`:''}${state.members.length?` · members ${state.members.join(', ')}`:''} · ${state.closed?`closed ${state.closed.end} → ${state.closed.outcome}`:'open'}\n\n${body}\n`);
  }
  return writeStatus(board);
}
export function writeStatus(board:string,extra:Record<string,unknown>={}) {
  const dir=boardDir(board),all=listThreads(board,'all');
  const pending=mentions(board).filter(mention=>!mention.delivered);
  const rejected=existsSync(join(dir,'rejected'))?readdirSync(join(dir,'rejected')).filter(name=>name.endsWith('.md')).length:0;
  const last=all[0];
  const status={board,updatedAt:new Date().toISOString(),threads:all.length,open:all.filter(state=>!state.closed).length,
    lastActivity:last?{thread:last.thread,at:last.lastAt}:null,pendingMentions:pending.map(mention=>({event:mention.event.id,thread:mention.event.thread,address:mention.address,at:mention.event.at})),
    rejected,...extra};
  const target=join(dir,'status.json');
  writeFileSync(`${target}.tmp`,`${JSON.stringify(status,null,2)}\n`);
  renameSync(`${target}.tmp`,target);
  return status;
}
export function boardExists(board:string) {try {return statSync(join(boardDir(board),'threads')).isDirectory();} catch {return false;}}
