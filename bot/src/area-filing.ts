import {createHash} from 'node:crypto';
import {db} from './state';
import {CURRENT_INBOX_ID_SQL} from './inbox-lineage-sql';
import {log} from './log';
import {recordSessionEvent} from './session-inputs';
import {applyAreaChange,MEANING_REASON_PREFIX,SYSTEM_NOTICE_AREA,threadChanges} from './session-areas';
import {meaningIndex} from './meaning-index';
import {linkEarlierWork,type SessionSearch} from './earlier-work';

/**
 * Inbox threads gather into areas of interest by meaning (Tejas, 2026-11-01: "why are these
 * threads not getting entangled automatically, instead of relying on me to remember?").
 *
 * When a thread is created, renamed, re-summarised or gains a message, it is compared by meaning
 * (the session search's EmbeddingGemma engine) with every other open thread. It joins an area when
 * at least MIN_SHARED of its NEIGHBOURS nearest threads already belong there and that share is LIFT
 * times the area's share of all open threads. Comparing with the area's members, not its name, is
 * what works on his data: in the 2026-11-01 dry run an area's name and summary scored members and
 * strangers alike (0.3–0.6), while the neighbour rule proposed exactly the threads he would pair
 * (a journal entry about curiosity and the smart-notes habit into "Doing great work"). The lift
 * keeps a catch-all area ("thnkr.ing app", 69% of threads) from attracting everything, so themes
 * gather threads and places do not. Calibration and the dry run: docs/architecture/AREAS-OF-INTEREST.md.
 *
 * Only memberships chosen by the router or by him count as evidence, so a meaning link never pulls
 * in the next one. A pair once linked by meaning, or unlinked by anyone, is never linked again by
 * meaning: his undo stands. A cluster of open threads that no area holds is offered to the Inbox
 * router once, which names a theme area if they share an idea; no question goes to Tejas.
 */
const NEIGHBOURS=6,SIMILAR=0.53,MIN_SHARED=2,LIFT=3;
/** A cluster is this many neighbours of one thread, and an area holds it when it holds half of them. */
const CLUSTER=3;
/** An area holding more than this share of open threads is a place, not a theme, and never holds a cluster. */
const PLACE_SHARE=0.25;
const OWN_WORDS=600,DEBOUNCE_MS=2_000;

type Admit=(input:{sessionId:number;inputId:string;origin:'service';sourceInputId:string;sourceRunId:string;requestId:string;text:string})=>unknown;
type Thread={id:string;title:string;text:string};

const pending=new Set<string>();
let admit:Admit|null=null,search:SessionSearch|null=null,startedMs=Date.now(),timer:ReturnType<typeof setTimeout>|null=null,running=false,catchUp=true;

const inboxSessionId=()=>(db.query(CURRENT_INBOX_ID_SQL).get() as {id:number}|null)?.id??null;

/** His own words for a thread: its title and the first captured messages placed in it. */
function openThreads(sessionId:number):Thread[] {
  const topics=db.query("SELECT topic_id AS id,title FROM inbox_topics WHERE session_id=? AND state='open'").all(sessionId) as {id:string;title:string}[];
  const roots=db.query("SELECT root_input_id AS id FROM inbox_topic_roots WHERE topic_id=? AND root_input_id LIKE 'capture:%' ORDER BY placed_at,root_input_id LIMIT 2");
  const words=db.query("SELECT substr(json_extract(payload_json,'$.text'),1,?) AS text FROM session_inputs WHERE id=?");
  return topics.map(topic=>{
    const own=(roots.all(topic.id) as {id:string}[]).map(root=>(words.get(OWN_WORDS,root.id) as {text:string|null}|null)?.text??'').filter(Boolean).join(' ').slice(0,OWN_WORDS);
    return {id:topic.id,title:topic.title,text:own?`${topic.title}. ${own}`:topic.title};
  });
}

const dot=(a:Float32Array,b:Float32Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};

async function file() {
  const index=meaningIndex(),sessionId=inboxSessionId();
  if(!index?.installed||sessionId===null){pending.clear();return;}
  const threads=openThreads(sessionId);
  const vectors=await index.documentVectors(threads.map(thread=>({key:`thread:${thread.id}`,text:thread.text})));
  const vectorOf=(id:string)=>vectors.get(`thread:${id}`);
  const open=new Set(threads.map(thread=>thread.id));
  const changed=catchUp?[...open]:[...pending].filter(id=>open.has(id));
  catchUp=false;pending.clear();
  // Evidence: memberships the router or he chose, among open threads.
  const chosen=new Map<string,Set<string>>(),all=new Map<string,Set<string>>();
  for(const row of db.query('SELECT area_id,topic_id,reason FROM inbox_area_threads').all() as {area_id:string;topic_id:string;reason:string}[]){
    if(!open.has(row.topic_id))continue;
    (all.get(row.area_id)??all.set(row.area_id,new Set()).get(row.area_id)!).add(row.topic_id);
    if(!row.reason.startsWith(MEANING_REASON_PREFIX))(chosen.get(row.area_id)??chosen.set(row.area_id,new Set()).get(row.area_id)!).add(row.topic_id);
  }
  const names=new Map((db.query('SELECT area_id,name FROM inbox_areas').all() as {area_id:string;name:string}[]).map(row=>[row.area_id,row.name]));
  const undone=new Set((db.query(`SELECT json_extract(payload_json,'$.areaId') AS area,json_extract(payload_json,'$.topicId') AS topic
    FROM session_owner_events WHERE session_id=? AND kind='area' AND json_extract(payload_json,'$.action')='unlink'`).all(sessionId) as {area:string;topic:string}[]).map(row=>`${row.area} ${row.topic}`));
  const titleOf=new Map(threads.map(thread=>[thread.id,thread.title]));
  let linked=0,suggested=0;
  for(const topicId of changed){
    const vector=vectorOf(topicId);if(!vector)continue;
    const near=threads.filter(other=>other.id!==topicId).map(other=>({id:other.id,score:dot(vector,vectorOf(other.id)!)}))
      .filter(other=>other.score>=SIMILAR).sort((a,b)=>b.score-a.score).slice(0,NEIGHBOURS);
    if(!near.length)continue;
    for(const [areaId,members] of chosen){
      if(areaId===SYSTEM_NOTICE_AREA||all.get(areaId)?.has(topicId))continue;
      const shared=near.filter(other=>members.has(other.id));
      if(shared.length<MIN_SHARED||(shared.length/near.length)/(members.size/open.size)<LIFT)continue;
      const eventId=`area-meaning:${areaId}:${topicId}`;
      if(undone.has(`${areaId} ${topicId}`)||db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(eventId))continue;
      const reason=`${MEANING_REASON_PREFIX}close to ${shared.slice(0,3).map(other=>`"${titleOf.get(other.id)}"`).join(', ')}.`;
      const payload={action:'link',areaId,topicId,origin:'agent',reason,at:new Date().toISOString()};
      db.transaction(()=>{recordSessionEvent({eventId,sessionId,kind:'area',payload});applyAreaChange(payload);})();
      (all.get(areaId)??all.set(areaId,new Set()).get(areaId)!).add(topicId);
      linked++;
      log('info','area_filed_by_meaning',{area_id:areaId,topic_id:topicId,shared:shared.length,neighbours:near.length});
    }
    if(near.length>=CLUSTER&&suggestTheme(sessionId,[topicId,...near.map(other=>other.id)],all,open.size,titleOf,names))suggested++;
  }
  // The same changes also link each new message to his earlier work.
  const posted=search?await linkEarlierWork({inboxSessionId:sessionId,topicIds:changed,startedMs,search,threads}):0;
  if(linked||suggested||posted)log('info','area_filing_pass',{threads:changed.length,linked,suggested,posted});
}

/** A group of open threads close in meaning that no theme area holds is offered to the router once. */
function suggestTheme(sessionId:number,group:string[],all:Map<string,Set<string>>,openCount:number,titleOf:Map<string,string>,names:Map<string,string>) {
  for(const [areaId,members] of all){
    if(areaId===SYSTEM_NOTICE_AREA||members.size/openCount>PLACE_SHARE)continue;
    if(group.filter(id=>members.has(id)).length>=Math.ceil(group.length/2))return false;
  }
  if(group.some(id=>db.query('SELECT 1 FROM session_owner_events WHERE event_id=?').get(`area-theme-offered:${id}`)))return false;
  if(!admit)return false;
  const inputId=`area-theme:${createHash('sha256').update([...group].sort().join(',')).digest('hex').slice(0,32)}`;
  const lines=group.map(id=>{
    const areas=[...all].filter(([,members])=>members.has(id)).map(([areaId])=>names.get(areaId)).filter(Boolean);
    return `- "${titleOf.get(id)}" (${id})${areas.length?`, now in ${areas.join(', ')}`:''}`;
  });
  // An input already retained under this id was admitted by an earlier pass; only its markers are missing.
  if(!db.query('SELECT 1 FROM session_inputs WHERE id=?').get(inputId))
    admit({sessionId,inputId,origin:'service',sourceInputId:inputId,sourceRunId:inputId,requestId:inputId,
      text:`These open Inbox threads are close in meaning and no theme area holds them:\n${lines.join('\n')}\nIf they share one idea, make it a theme area (sessions areas create --name … --summary …), link each thread that belongs (sessions areas link), and neighbour it with related areas. If they do not share an idea, leave them. Do not ask Tejas. You do not need to reply to this.`});
  db.transaction(()=>{for(const id of group)recordSessionEvent({eventId:`area-theme-offered:${id}`,sessionId,kind:'area_offer',payload:{topicId:id,offer:inputId}});})();
  return true;
}

async function drain() {
  timer=null;
  if(running)return;
  running=true;
  try{await file();}
  catch(error){log('warn','area_filing_failed',{error:error instanceof Error?error.message:String(error)});}
  finally{running=false;}
  if(pending.size)schedule();
}
function schedule(){if(admit&&!timer)timer=setTimeout(()=>void drain(),DEBOUNCE_MS);}

/**
 * Started once per composition, after the owner can admit inputs. The first pass files every open
 * thread whose meaning it has not compared yet (including threads changed while Concierge was down);
 * afterwards only the threads whose recorded changes name them.
 */
export function startAreaFiling(admitInput:Admit,searchSessions:SessionSearch) {
  if(admit)return;
  admit=admitInput;search=searchSessions;startedMs=Date.now();
  threadChanges.listen(topicId=>{pending.add(topicId);schedule();});
  schedule();
}
