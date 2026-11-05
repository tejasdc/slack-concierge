import {readdir,readFile,stat} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {db} from './state';
import {log} from './log';
import {recordSessionEvent} from './session-inputs';
import {meaningIndex} from './meaning-index';

/**
 * A new message in an Inbox thread is shown the one or two strongest earlier things he thought
 * about it: his sessions (ChatGPT conversations included), his notes and his other Inbox threads.
 * Tejas, 2026-11-01, after only connecting "invest in a startup that employs me" with IdeaFlow in
 * the shower: "our system didn't notify me either ... showcase these connections."
 *
 * The questions are his own words in overlapping windows of a few sentences (about 350
 * characters), because a voice capture wanders and one idea is a few sentences long: fixed
 * 600-character pieces cut "invest in … Jacob" from "a startup that is employing me" and missed
 * the match (2026-11-02 live check). A session that is a top match for more than a third of the
 * windows is a hub, close to everything he says, and is passed over. When a window names
 * something in his standing facts (the vault's bio/standing-facts.md, a line "IdeaFlow, Jacob:
 * IdeaFlow is the startup that employs you…"), that window marks what he cares about: its best
 * match takes the first place. The rest are ranked by how many windows they answer best.
 *
 * Only earlier work counts: the Inbox itself, sessions working on this thread, and anything
 * written after this message arrived are passed over, since those are this message's own echoes
 * (in the 2026-11-01 run they were the top three hits). What it finds is one quiet post in the
 * thread with links he can open; nothing asks him anything.
 */
const MIN_SCORE=0.5,SHOWN=3,WINDOW=350,WINDOWS=14,PER_WINDOW=3,NAMED_WINDOWS=2;
/** How much of a note's opening is compared, the same length the thread filer reads of his words. */
const NOTE_OPENING=600;
/** Messages that arrived before this owner started are linked only when this recent, so a restart never posts into old threads. */
const RECENT_MS=24*60*60_000;
const NOTES_ROOT=process.env.CONCIERGE_NOTES_ROOT||'/root/workspace/vault';
/** Folders of other people's words, retired material and scratch, which are not his notes. */
const NOT_NOTES=new Set(['Readwise','tmp','archive','templates']);
const APP='https://thnkr.ing/agents';

export type SessionSearch=(body:{query:string;limit:number})=>Promise<{results?:any[]}>;
type Found={key:string;title:string;link:string;kind:string;score:number;snippet:string;because?:string};

/** Overlapping windows of whole sentences, each about WINDOW characters, advancing half a window. */
const windows=(text:string)=>{
  const sentences=text.replace(/\s+/g,' ').trim().split(/(?<=[.?!])\s+/),out:string[]=[];
  for(let start=0;start<sentences.length&&out.length<WINDOWS;){
    let end=start,length=0;
    while(end<sentences.length&&length<WINDOW){length+=sentences[end]!.length+1;end++;}
    out.push(sentences.slice(start,end).join(' ').slice(0,WINDOW*2));
    start+=Math.max(1,Math.floor((end-start)/2));
  }
  return out;
};
const dot=(a:Float32Array,b:Float32Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};
const time=(value:unknown)=>{
  if(typeof value!=='string'||!value)return null;
  const ms=Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value)?value:value.replace(' ','T')+'Z');
  return Number.isFinite(ms)?ms:null;
};

/** The names his standing facts are about; a window naming one is about something he cares about. */
async function standingNames():Promise<string[]> {
  let text:string;try{text=await readFile(join(NOTES_ROOT,'bio','standing-facts.md'),'utf8');}catch{return [];}
  return text.split('\n').map(line=>/^\s*-\s*([^:]+):/.exec(line)?.[1]).filter((names):names is string=>!!names)
    .flatMap(names=>names.split(',').map(name=>name.trim().toLocaleLowerCase('en-US')).filter(Boolean));
}

const noteCache=new Map<string,{mtime:number;title:string;text:string}>();
/** His own notes: title and opening words, re-read only when a file changes. */
async function notes():Promise<{path:string;title:string;text:string}[]> {
  const out:{path:string;title:string;text:string}[]=[];
  const walk=async(dir:string,depth:number):Promise<void>=>{
    let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(entry.name.startsWith('.'))continue;
      const path=join(dir,entry.name);
      if(entry.isDirectory()){if(depth===0&&NOT_NOTES.has(entry.name))continue;if(depth<6)await walk(path,depth+1);continue;}
      if(!entry.name.endsWith('.md'))continue;
      const mtime=(await stat(path).catch(()=>null))?.mtimeMs;if(mtime===undefined)continue;
      let cached=noteCache.get(path);
      if(cached?.mtime!==mtime){
        const body=(await readFile(path,'utf8').catch(()=>'')).replace(/^---\n[\s\S]*?\n---\n/,'');
        const title=entry.name.slice(0,-3);
        cached={mtime,title,text:`${title}. ${body.replace(/\s+/g,' ').trim().slice(0,NOTE_OPENING)}`};
        noteCache.set(path,cached);
      }
      out.push({path,title:cached.title,text:cached.text});
    }
  };
  await walk(NOTES_ROOT,0);
  return out;
}

/** Earlier sessions, notes and threads close to one message, best first. */
async function earlierWork(input:{inboxSessionId:number;topicId:string;words:string;arrivedMs:number;search:SessionSearch;threads:{id:string;title:string;text:string;createdMs:number|null}[]}) {
  const index=meaningIndex();if(!index?.installed)return [];
  // One question for the whole thread (his words, as the search reads its first 800 characters),
  // plus at most two passages that name something in his standing facts, which the whole-thread
  // question can drown out (the IdeaFlow case, 2026-11-02). Fourteen windows per message cost up
  // to fourteen owner searches and he asked why the text was being broken up (2026-11-05).
  const names=await standingNames();
  const names_in=(text:string)=>{const lower=text.toLocaleLowerCase('en-US');return names.some(name=>lower.includes(name));};
  const salient=windows(input.words).filter(names_in).slice(0,NAMED_WINDOWS);
  const questions=[input.words.replace(/\s+/g,' ').trim(),...salient];
  const named=questions.map((question,at)=>at>0||names_in(question));
  const working=new Set<number>([input.inboxSessionId]);
  for(const row of db.query('SELECT dispatches_json FROM inbox_requests WHERE topic_id=?').all(input.topicId) as {dispatches_json:string}[])
    for(const dispatch of JSON.parse(row.dispatches_json) as any[]){const id=/^concierge:(\d+)$/.exec(String(dispatch?.targetSessionId??''));if(id)working.add(Number(id[1]));}
  // Each window's own best few, from every store.
  const perWindow:Found[][]=questions.map(()=>[]);
  for(const [at,query] of questions.entries()){
    const answer=await input.search({query,limit:10}).catch(error=>{log('warn','earlier_work_search_failed',{error:error instanceof Error?error.message:String(error)});return {results:[]};});
    for(const result of answer.results??[]){
      const view=result.session,score=Number(result.match?.meaning);
      const local=/^concierge:(\d+)$/.exec(String(view?.id??''));
      if(!Number.isFinite(score)||!local||working.has(Number(local[1])))continue;
      const evidenceAt=time(result.evidence?.[0]?.at);
      if(evidenceAt!==null&&evidenceAt>=input.arrivedMs)continue;
      if(view.origin!=='imported'&&(time(view.createdAt??view.timing?.startedAt)??0)>=input.arrivedMs)continue;
      const title=String(view.title??'').replace(/<[^>]*>/g,'').trim()||'A session';
      perWindow[at]!.push({key:view.id,title,kind:view.provider==='chatgpt'?'ChatGPT conversation':'session',
        link:`${APP}?sessionView=sessions&conversation=${encodeURIComponent(view.id)}`,score,snippet:String(result.evidence?.[0]?.snippet??'')});
    }
  }
  const vectors=await index.queryVectors(questions);
  const noteList=await notes();
  const noteVectors=await index.documentVectors(noteList.map(note=>({key:`note:${relative(NOTES_ROOT,note.path)}`,text:note.text})));
  const threadVectors=await index.documentVectors(input.threads.map(thread=>({key:`thread:${thread.id}`,text:thread.text})));
  for(const [at,vector] of vectors.entries()){
    for(const note of noteList){
      const other=noteVectors.get(`note:${relative(NOTES_ROOT,note.path)}`);if(!other)continue;
      perWindow[at]!.push({key:note.path,title:note.title,kind:'note',link:note.path,score:dot(vector,other),snippet:''});
    }
    for(const thread of input.threads){
      if(thread.id===input.topicId||(thread.createdMs??0)>=input.arrivedMs)continue;
      const other=threadVectors.get(`thread:${thread.id}`);if(!other)continue;
      perWindow[at]!.push({key:thread.id,title:thread.title,kind:'Inbox thread',
        link:`${APP}?sessionView=inbox&topic=${encodeURIComponent(thread.id)}&topicView=conversation`,score:dot(vector,other),snippet:''});
    }
  }
  const tops=perWindow.map(list=>{
    const seen=new Set<string>();
    return list.filter(found=>found.score>=MIN_SCORE).sort((a,b)=>b.score-a.score).filter(found=>!seen.has(found.key)&&!!seen.add(found.key)).slice(0,PER_WINDOW);
  });
  const appearances=new Map<string,number>();
  for(const list of tops)for(const found of list)appearances.set(found.key,(appearances.get(found.key)??0)+1);
  const hub=(key:string)=>(appearances.get(key)??0)>Math.max(2,questions.length/3);
  // Each window votes for its best non-hub match; named windows vote first.
  const votes=new Map<string,{found:Found;named:number;all:number;best:number}>();
  for(const [at,list] of tops.entries()){
    const found=list.find(item=>!hub(item.key));if(!found)continue;
    const vote=votes.get(found.key)??{found,named:0,all:0,best:0};
    vote.all++;if(named[at])vote.named++;
    if(found.score>vote.best){vote.best=found.score;vote.found={...found,because:at===0?closestSentence(input.words,found):questions[at]};}
    votes.set(found.key,vote);
  }
  return [...votes.values()].sort((a,b)=>b.named-a.named||b.all-a.all||b.best-a.best).slice(0,SHOWN).map(vote=>vote.found);
}

/** The sentence of his sharing the most words with what was found, so the quote says why this link is here. */
function closestSentence(words:string,found:Found):string{
  const of=(text:string)=>new Set(text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]{4,}/gu)??[]);
  const target=of(`${found.title} ${found.snippet}`);
  let best='',bestShared=-1;
  for(const sentence of words.replace(/\s+/g,' ').split(/(?<=[.?!])\s+/)){
    const shared=[...of(sentence)].filter(word=>target.has(word)).length;
    if(shared>bestShared){bestShared=shared;best=sentence;}
  }
  return best;
}
/** A few of his words from the passage that found the link, so he can see why it is there. */
const yourWords=(text:string|undefined)=>{
  const words=(text??'').replace(/\s+/g,' ').trim();
  return words.length>110?`${words.slice(0,110).replace(/\s+\S*$/,'')}…`:words;
};
const line=(found:Found)=>{
  // thnkr.ing opens a file link only for a path without spaces, and most note names have them,
  // so a note is named with its place in the vault instead of a link that would not open.
  const what=found.kind==='note'?`your note “${found.title}” (in your vault: ${relative(NOTES_ROOT,found.link)})`
    :`[${found.title}](${found.link}), ${found.kind==='Inbox thread'?'an earlier Inbox thread':`an earlier ${found.kind}`}`;
  const because=yourWords(found.because);
  return `- ${what}${because?`, close to where you said “${because}”`:''}`;
};

/**
 * His own words in a capture: a bug report's form scaffolding (its header, "What changed:" summary,
 * the image list and everything from "Complete diagnostics JSON" on) is removed. The same rule as
 * thnkr.ing's captureWords (apps/web/src/inbox-capture-text.ts): 100 of the first 717 links were
 * found by the form's own lines, not by anything he said (2026-11-05).
 */
export function hisCaptureWords(text:string):string{
  const lines=text.split('\n');
  const end=lines.findIndex(line=>line.startsWith('Complete diagnostics JSON'));
  const readable=end>=0?lines.slice(0,end):lines;
  if((readable[0]??'').trim()!=='Thinkering bug report')return readable.join('\n').trim();
  const words:string[]=[];let listing=false;
  for(const line of readable.slice(1)){
    if(line.trim()==='Description:'){listing=false;continue;}
    if(line.trim()==='Attached images:'||line.trim()==='What changed:'){listing=true;continue;}
    if(!listing)words.push(line);
  }
  return words.join('\n').trim();
}

/**
 * Links each changed thread, as a whole, to his earlier work: one post per thread, made again only
 * when his own words in it change (a new captured message of his). Only messages he sent count;
 * agent reports and alerts filed into his threads are not his thinking. Returns how many posts it made.
 */
export async function linkEarlierWork(input:{inboxSessionId:number;topicIds:string[];startedMs:number;search:SessionSearch;threads:{id:string;title:string;text:string}[]}) {
  const created=new Map((db.query("SELECT topic_id,created_at FROM inbox_topics WHERE session_id=? AND state='open'").all(input.inboxSessionId) as {topic_id:string;created_at:string}[]).map(row=>[row.topic_id,time(row.created_at)]));
  const threads=input.threads.map(thread=>({...thread,createdMs:created.get(thread.id)??null}));
  let posted=0;
  for(const topicId of input.topicIds){
    const roots=db.query("SELECT r.root_input_id AS id,i.created_at AS at,substr(json_extract(i.payload_json,'$.text'),1,4000) AS text FROM inbox_topic_roots r JOIN session_inputs i ON i.id=r.root_input_id WHERE r.topic_id=? AND r.root_input_id LIKE 'capture:%' AND i.origin='human' ORDER BY i.created_at,i.id")
      .all(topicId) as {id:string;at:string;text:string|null}[];
    const his=roots.map(root=>({...root,words:hisCaptureWords(root.text??'')})).filter(root=>root.words.length>=40);
    const latest=his.at(-1);if(!latest)continue;
    const arrivedMs=time(latest.at);
    if(arrivedMs===null||arrivedMs<input.startedMs-RECENT_MS)continue;
    const words=his.map(root=>root.words).join('\n').slice(0,4000);
    const eventId=`post:earlier-work:${topicId}:${createHash('sha256').update(words).digest('hex').slice(0,16)}`;
    if(db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))continue;
    const started=performance.now();
    // Earlier means before his first message here, so the thread's own later work is never its own match.
    const found=await earlierWork({inboxSessionId:input.inboxSessionId,topicId,words,arrivedMs:time(his[0]!.at)??arrivedMs,search:input.search,threads});
    const durationMs=Math.round(performance.now()-started);
    // A thread with nothing close enough is marked too, so the same words are not searched again.
    const text=found.length?`**Earlier work related to this thread.** Concierge found it by meaning in your sessions, threads and notes, from your own messages here; nothing to do unless you want to open it.\n${found.map(line).join('\n')}`:null;
    recordSessionEvent({eventId,sessionId:input.inboxSessionId,inputId:latest.id,kind:text?'post':'earlier_work',
      payload:text?{text,replyToMessage:{kind:'message',sessionId:`concierge:${input.inboxSessionId}`,messageId:latest.id},postedBy:'service'}:{found:0}});
    if(text)posted++;
    log('info','earlier_work_linked',{topic_id:topicId,root:latest.id,messages:his.length,durationMs,
      found:found.map(item=>({kind:item.kind,score:Math.round(item.score*1000)/1000}))});
  }
  return posted;
}
