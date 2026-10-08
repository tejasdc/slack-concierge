import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {Database} from 'bun:sqlite';
import {db} from './state-database';
import {log} from './log';

/**
 * Session search by meaning. Word search finds a session only when the query's words appear in
 * one of its messages, so "provider account switching" never reached the sessions about Claude
 * sign-in folders. This index keeps one vector per thing a session was asked or answered (its
 * title, each human or agent request, each final reply) and per prompt in the transcript
 * archive, and ranks sessions by how close the query's meaning is to any of them.
 *
 * Design and the decision history (the September QMD/EmbeddingGemma evaluation this builds on):
 * docs/plans/2026-10-07-session-search-by-meaning.md.
 *
 * Kept off the owner's hot path on purpose (2026-10-07 freezes): the model runs in its own
 * llama.cpp process; indexing reads the ledger in small pages and writes only its own database;
 * a query is one embedding call plus a scan of an in-memory int8 matrix (~20 ms). Nothing here
 * reads a transcript file. Tool output and assistant streaming text are never indexed: they are
 * expensive and, as the September evaluation found, poor evidence of what a session was about.
 */

const ROOT='/root/.local/share/concierge/meaning';
const SERVER=process.env.CONCIERGE_MEANING_SERVER||`${ROOT}/llama-server`;
const MODEL=process.env.CONCIERGE_MEANING_MODEL||`${ROOT}/models/embeddinggemma-300M-Q8_0.gguf`;
const PORT=Number(process.env.CONCIERGE_MEANING_PORT)||8796;
const ARCHIVE_INDEX=process.env.CONCIERGE_ARCHIVE_SEARCH_INDEX||'/var/lib/thinkering/production/agents/sources/search.sqlite';
/** EmbeddingGemma is Matryoshka-trained; 512 of 768 dimensions keep nearly all quality at two thirds the memory. */
const DIMENSIONS=512;
const PASSAGE_CHARS=800,SNIPPET_CHARS=400,PAGE=24,IDLE_POLL_MS=60_000;
const QUERY_PREFIX='task: search result | query: ',DOCUMENT_PREFIX='title: none | text: ';
const IDENTITY_HEADER='{"type":"concierge-session-input"';
/** Bumped when what a ledger passage is keyed or credited by changes; the ledger part is then rebuilt. */
const LEDGER_FORMAT='2';
/** The request boilerplate every delegated session opens with says nothing about its work. */
const REQUEST_PREAMBLE=/^Session request [0-9a-f-]{36} from [^\n]*(?:\n(?!\n)[^\n]*)*\n\n/;
const RESULT_PREAMBLE=/^Session (?:final|progress|stalled) event [0-9a-f-]{36} for requests? [0-9a-f-]{36}[^\n]*(?:\n(?!\n)[^\n]*)*\n\n/;
/** A carried result ends with its delivery record as one line of JSON; the reply's words are what came before it. */
const RESULT_RECORD=/\n\n\{[^\n]*\}\s*$/;

export type MeaningHit={target:{kind:'session';sessionId:number}|{kind:'peer';peer:string;remoteSessionId:string}|{kind:'archive';sourceId:string;sourceVersion:string;eventId:string;branch?:unknown;nativeId?:string|null};score:number;text:string;at:string|null;ref:string};
export type MeaningSearch={available:boolean;hits:MeaningHit[];reason:string|null;indexed:number;pending:boolean};

/** One llama.cpp server process, started on first use; CPU only, because the box's Vulkan path failed in September. */
class EmbeddingEngine {
  private child:ChildProcess|null=null;
  private ready:Promise<void>|null=null;
  installed(){return existsSync(SERVER)&&existsSync(MODEL);}
  private async healthy(){try{return (await fetch(`http://127.0.0.1:${PORT}/health`,{signal:AbortSignal.timeout(1_000)})).ok;}catch{return false;}}
  private start():Promise<void> {
    if(this.ready)return this.ready;
    this.ready=this.spawnOrAdopt();
    this.ready.catch(()=>{this.ready=null;});
    return this.ready;
  }
  /** An engine left on the port by an earlier Concierge process is used rather than fought: a second one could not bind and would exit in a loop. */
  private async spawnOrAdopt():Promise<void> {
    if(await this.healthy()){log('info','meaning_engine_adopted',{port:PORT});return;}
    // The engine dies with Concierge: stopped on exit below, and killed by the kernel if Concierge
    // is killed outright, so an update restart never finds a leftover engine (2026-10-07).
    const child=spawn('nice',['-n','10','setpriv','--pdeathsig','KILL',SERVER,'-m',MODEL,'--embedding','--host','127.0.0.1','--port',String(PORT),'-c','8192','-b','2048','-ub','2048','-np','4','-t','4','--device','none','--log-disable'],{stdio:'ignore'});
    this.child=child;
    child.on('exit',code=>{if(this.child===child){this.child=null;this.ready=null;log('warn','meaning_engine_exited',{code});}});
    child.on('error',error=>{if(this.child===child){this.child=null;this.ready=null;log('warn','meaning_engine_failed',{error:error.message});}});
    for(let attempt=0;attempt<60;attempt++){
      if(await this.healthy())return;
      if(this.child!==child)throw new Error('meaning engine exited while starting');
      await Bun.sleep(250);
    }
    child.kill();throw new Error('meaning engine did not become ready');
  }
  /** One deadline covers starting the engine and the request, so a caller never waits longer than it asked. */
  async embed(texts:string[],timeoutMs=60_000):Promise<Float32Array[]> {
    const deadline=AbortSignal.timeout(timeoutMs);
    await Promise.race([this.start(),new Promise<never>((_,reject)=>deadline.addEventListener('abort',()=>reject(new Error('meaning engine did not start in time')),{once:true}))]);
    let response:Response;
    try{response=await fetch(`http://127.0.0.1:${PORT}/v1/embeddings`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:texts}),signal:deadline});}
    catch(error){
      // An engine that stopped answering (adopted and then gone, or hung) is replaced on the next call.
      if(!(await this.healthy())){this.child?.kill();this.child=null;this.ready=null;}
      throw error;
    }
    if(!response.ok)throw new Error(`meaning engine answered ${response.status}`);
    const body=await response.json() as {data:{index:number;embedding:number[]}[]};
    return body.data.sort((a,b)=>a.index-b.index).map(item=>normalized(item.embedding.slice(0,DIMENSIONS)));
  }
  stop(){this.child?.kill();this.child=null;this.ready=null;}
}

function normalized(values:number[]){const vector=Float32Array.from(values);let sum=0;for(const value of vector)sum+=value*value;const norm=Math.sqrt(sum)||1;for(let i=0;i<vector.length;i++)vector[i]!/=norm;return vector;}
/** int8 with one scale per vector: a quarter of the memory, and ranking is unchanged in practice. */
function quantize(vector:Float32Array){let max=0;for(const value of vector)max=Math.max(max,Math.abs(value));const scale=max/127||1;const out=new Int8Array(vector.length);for(let i=0;i<vector.length;i++)out[i]=Math.round(vector[i]!/scale);return {values:out,scale};}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');

/** What a person or agent wrote, without the transport header or the request boilerplate. */
export function meaningText(text:string) {
  let spoken=text;
  if(spoken.startsWith(IDENTITY_HEADER)){const end=spoken.indexOf('\n\n');spoken=end<0?'':spoken.slice(end+2);}
  if(RESULT_PREAMBLE.test(spoken))return spoken.replace(RESULT_PREAMBLE,'').replace(RESULT_RECORD,'').trim();
  return spoken.replace(REQUEST_PREAMBLE,'').trim();
}

type Row={key:string;target:MeaningHit['target'];text:string;at:string|null};

export class MeaningIndex {
  private readonly store:Database;
  private readonly engine=new EmbeddingEngine();
  private keys:string[]=[];private rowOf=new Map<string,number>();private scales:number[]=[];private matrix=new Int8Array(DIMENSIONS*4096);private count=0;
  private targets:MeaningHit['target'][]=[];private texts:string[]=[];private times:(string|null)[]=[];
  private timer:ReturnType<typeof setTimeout>|null=null;private caughtUp=false;private stopped=false;private failure:string|null=null;
  constructor(path:string,private readonly titleOf:(sessionId:number)=>string|null) {
    this.store=new Database(path,{create:true});
    this.store.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS passages(key TEXT PRIMARY KEY,target_json TEXT NOT NULL,text TEXT NOT NULL,at TEXT,scale REAL NOT NULL,vector BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS watermarks(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;`);
    if(this.watermark('ledger-format')!==LEDGER_FORMAT){
      // Ledger passages are a rebuildable cache; re-read them under the current crediting rule.
      this.store.exec("DELETE FROM passages WHERE key LIKE 'input:%' OR key LIKE 'said:%'");
      this.setWatermark('ledger','0');this.setWatermark('ledger-format',LEDGER_FORMAT);
    }
    for(const row of this.store.query('SELECT key,target_json,text,at,scale,vector FROM passages').all() as any[])this.remember(row.key,JSON.parse(row.target_json),row.text,row.at,new Int8Array(row.vector),row.scale);
  }
  get installed(){return this.engine.installed();}
  private remember(key:string,target:MeaningHit['target'],text:string,at:string|null,values:Int8Array,scale:number) {
    if(this.count*DIMENSIONS>=this.matrix.length){const grown=new Int8Array(this.matrix.length*2);grown.set(this.matrix);this.matrix=grown;}
    this.matrix.set(values,this.count*DIMENSIONS);this.rowOf.set(key,this.count);this.keys.push(key);this.scales.push(scale);this.targets.push(target);this.texts.push(text);this.times.push(at);this.count++;
  }
  private watermark(name:string){return (this.store.query('SELECT value FROM watermarks WHERE name=?').get(name) as {value:string}|null)?.value??null;}
  private setWatermark(name:string,value:string){this.store.query('INSERT INTO watermarks(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name,value);}
  private known(key:string){return !!this.store.query('SELECT 1 FROM passages WHERE key=?').get(key);}
  private async save(rows:Row[]) {
    const pageKeys=new Set<string>();
    const fresh=rows.filter(row=>row.text.length>=(row.key.startsWith('title:')?3:12)&&!pageKeys.has(row.key)&&!this.known(row.key)&&!!pageKeys.add(row.key));
    if(!fresh.length)return;
    const vectors=await this.engine.embed(fresh.map(row=>DOCUMENT_PREFIX+row.text.slice(0,PASSAGE_CHARS)));
    const insert=this.store.query('INSERT OR REPLACE INTO passages(key,target_json,text,at,scale,vector) VALUES(?,?,?,?,?,?)');
    this.store.transaction(()=>{for(const [index,row] of fresh.entries()){const {values,scale}=quantize(vectors[index]!);insert.run(row.key,JSON.stringify(row.target),row.text.slice(0,SNIPPET_CHARS),row.at,scale,values);}})();
    for(const [index,row] of fresh.entries()){const {values,scale}=quantize(vectors[index]!);if(row.key.startsWith('title:')){const prior=(this.rowOf.get(row.key)??-1);if(prior>=0){this.matrix.set(values,prior*DIMENSIONS);this.scales[prior]=scale;this.texts[prior]=row.text.slice(0,SNIPPET_CHARS);continue;}}this.remember(row.key,row.target,row.text.slice(0,SNIPPET_CHARS),row.at,values,scale);}
  }
  /**
   * Everything said in the ledger's conversations, a small page at a time, credited to whoever
   * wrote it: his messages and agents' requests to the session that received them, a reply to the
   * session that wrote it. A result carried back to its requester (an Inbox "return") is that same
   * reply, so it is credited to its author too, including a Mac session whose reply exists on this
   * machine only as that return. Passages are keyed by author and exact words, so a reply and its
   * returned copy are one passage, not two.
   */
  private author(row:any,payload:any):MeaningHit['target']|null {
    if(row.kind==='request'){const target=/^concierge:(\d+)$/.exec(String(payload.targetSessionId??''));return target?{kind:'session',sessionId:Number(target[1])}:null;}
    const result=/^Session (final|progress|stalled) event [0-9a-f-]{36} for requests? ([0-9a-f-]{36})/.exec(String(payload.text??''));
    // A stalled notice and any other service input are Concierge's words, not any session's.
    if(result?.[1]==='stalled'||(!result&&row.origin==='service'))return null;
    if(result){
      const local=db.query('SELECT target_session_id FROM session_communication_requests WHERE request_id=?').get(result[2]) as {target_session_id:number}|null;
      if(local)return {kind:'session',sessionId:local.target_session_id};
      const peer=db.query('SELECT peer,remote_session_id FROM session_peer_requests WHERE request_id=?').get(result[2]) as {peer:string;remote_session_id:string}|null;
      if(peer)return {kind:'peer',peer:peer.peer,remoteSessionId:peer.remote_session_id};
    }
    return {kind:'session',sessionId:row.session_id};
  }
  private async ledgerPage():Promise<boolean> {
    const after=Number(this.watermark('ledger')??0);
    const rows=db.query(`SELECT rowid,id,session_id,kind,origin,payload_json,created_at FROM session_inputs WHERE rowid>? AND kind IN ('input','create','request','reply') ORDER BY rowid LIMIT ${PAGE}`).all(after) as any[];
    if(!rows.length)return false;
    const passages:Row[]=[];
    for(const row of rows){
      let payload:any;try{payload=JSON.parse(row.payload_json);}catch{continue;}
      const text=meaningText(String(payload.text??payload.firstInput?.text??''));
      const target=this.author(row,payload);if(!target)continue;
      const who=target.kind==='session'?`s:${target.sessionId}`:target.kind==='peer'?`p:${target.peer}:${target.remoteSessionId}`:'a';
      passages.push({key:`said:${who}:${hash(text)}`,target,text,at:row.created_at});
    }
    await this.save(passages);
    this.setWatermark('ledger',String(rows[rows.length-1].rowid));
    return true;
  }
  /** Session titles change as sessions name themselves; re-embed only the ones that changed. */
  private async titles() {
    const sessions=db.query('SELECT id FROM sessions ORDER BY id').all() as {id:number}[];
    for(let start=0;start<sessions.length;start+=PAGE){
      const rows:Row[]=[];
      for(const {id} of sessions.slice(start,start+PAGE)){const title=this.titleOf(id);if(!title||title.length<3||title==='Agent session'||title==='Imported session'||title.startsWith('{'))continue;const key=`title:${id}`;const index=this.rowOf.get(key)??-1;if(index>=0&&this.texts[index]===title.slice(0,SNIPPET_CHARS))continue;this.store.query('DELETE FROM passages WHERE key=?').run(key);rows.push({key,target:{kind:'session',sessionId:id},text:title,at:null});}
      await this.save(rows);
    }
    // The Mac's sessions as this machine last saw them, credited to the Mac sessions themselves.
    const peers=db.query('SELECT peer,remote_session_id,view_json FROM session_peer_catalogue').all() as {peer:string;remote_session_id:string;view_json:string}[];
    for(let start=0;start<peers.length;start+=PAGE){
      const rows:Row[]=[];
      for(const row of peers.slice(start,start+PAGE)){
        let title:unknown;try{title=JSON.parse(row.view_json).title;}catch{continue;}
        if(typeof title!=='string'||title.length<3||title==='Agent session'||title==='Imported session'||title.startsWith('{'))continue;
        const key=`title:p:${row.peer}:${row.remote_session_id}`;const index=this.rowOf.get(key)??-1;
        if(index>=0&&this.texts[index]===title.slice(0,SNIPPET_CHARS))continue;
        this.store.query('DELETE FROM passages WHERE key=?').run(key);
        rows.push({key,target:{kind:'peer',peer:row.peer,remoteSessionId:row.remote_session_id},text:title,at:null});
      }
      await this.save(rows);
    }
  }
  /** The archive's prompts (both machines' transcripts), read from Thinkering's disposable index without touching any transcript file. */
  private archive():Database|null {
    if(!existsSync(ARCHIVE_INDEX))return null;
    const archive=new Database(ARCHIVE_INDEX,{readonly:true});
    const version=Number((archive.query('PRAGMA user_version').get() as any)?.user_version);
    if(version!==3){archive.close();throw new Error(`archive index format ${version} is not the one this reader knows (3)`);}
    return archive;
  }
  private async archivePage():Promise<boolean> {
    const archive=this.archive();if(!archive)return false;
    try{
      let after=Number(this.watermark('archive')??0);
      // Thinkering's index is disposable; a rebuilt one numbers its rows from 1 again, so start over (known prompts are skipped by hash).
      const highest=Number((archive.query('SELECT max(id) AS id FROM bodies').get() as any)?.id??0);
      if(highest<after){after=0;this.setWatermark('archive','0');log('info','meaning_index_archive_rebuilt',{highest});}
      const rows=archive.query(`SELECT b.id,b.hash,b.body FROM bodies b WHERE b.lane='dialogue' AND b.id>? AND EXISTS(SELECT 1 FROM evidence e WHERE e.bodyId=b.id AND e.role='user') ORDER BY b.id LIMIT ${PAGE}`).all(after) as any[];
      if(!rows.length)return false;
      await this.save(rows.map(row=>({key:`archive:${row.hash}`,target:{kind:'archive',sourceId:'',sourceVersion:'',eventId:''},text:meaningText(inflateRawSync(row.body).toString('utf8')),at:null})));
      this.setWatermark('archive',String(rows[rows.length-1].id));
      return true;
    }finally{archive.close();}
  }
  /** Indexing runs on its own timer, one page per tick, so it never holds the owner for long. */
  start() {
    if(!this.engine.installed()){log('info','meaning_index_unavailable',{reason:'engine not installed',server:SERVER});return;}
    let titlesAt=0;
    const tick=async()=>{
      if(this.stopped)return;
      let worked=false;
      try{
        worked=await this.ledgerPage();
        if(!worked&&Date.now()-titlesAt>IDLE_POLL_MS){await this.titles();titlesAt=Date.now();}
        if(!worked)worked=await this.archivePage();
        this.failure=null;
      }catch(error){this.failure=error instanceof Error?error.message:String(error);log('warn','meaning_index_failed',{error:this.failure});}
      if(!worked&&!this.caughtUp){this.caughtUp=true;log('info','meaning_index_caught_up',{passages:this.count});}
      if(worked)this.caughtUp=false;
      this.timer=setTimeout(tick,worked?50:this.failure?IDLE_POLL_MS*5:IDLE_POLL_MS);
    };
    this.timer=setTimeout(tick,5_000);
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.engine.stop();this.store.close();}
  /** Archive hits resolve to the exact source, version and event the archive holds now, so a stale vector never names a changed file. */
  private resolveArchive(archive:Database,key:string):MeaningHit['target']|null {
    try{
      const row=archive.query(`SELECT s.metadata,e.eventId FROM bodies b JOIN evidence e ON e.bodyId=b.id JOIN sources s ON s.rowid=e.sourceRow WHERE b.hash=? AND b.lane='dialogue' ORDER BY e.id DESC LIMIT 1`).get(key.slice('archive:'.length)) as any;
      if(!row)return null;
      const source=JSON.parse(row.metadata);
      return {kind:'archive',sourceId:source.id,sourceVersion:source.version,eventId:row.eventId,branch:source.branch??null,nativeId:typeof source.nativeId==='string'?source.nativeId:null};
    }catch{return null;}
  }
  async search(query:string,limit:number):Promise<MeaningSearch> {
    const indexed=this.count;
    if(!this.engine.installed())return {available:false,hits:[],reason:'The meaning search engine is not installed on this machine.',indexed,pending:false};
    if(!indexed)return {available:false,hits:[],reason:'The meaning index is still being built.',indexed,pending:true};
    let vector:Float32Array;
    try{[vector]=(await this.engine.embed([QUERY_PREFIX+query.slice(0,PASSAGE_CHARS)],6_000)) as [Float32Array];}
    catch(error){return {available:false,hits:[],reason:`Meaning search unavailable: ${error instanceof Error?error.message:String(error)}`,indexed,pending:!this.caughtUp};}
    // Best passage per session (or per archived prompt): one strong match is the signal, many weak ones are not.
    const best=new Map<string,{index:number;score:number}>();
    for(let row=0;row<this.count;row++){
      let dot=0;const offset=row*DIMENSIONS;
      for(let i=0;i<DIMENSIONS;i++)dot+=vector[i]!*this.matrix[offset+i]!;
      const score=dot*this.scales[row]!;
      const target=this.targets[row]!;const id=target.kind==='session'?`s:${target.sessionId}`:target.kind==='peer'?`p:${target.peer}:${target.remoteSessionId}`:this.keys[row]!;
      const prior=best.get(id);if(!prior||score>prior.score)best.set(id,{index:row,score});
    }
    const ranked=[...best.values()].sort((a,b)=>b.score-a.score);
    const hits:MeaningHit[]=[],seen=new Set<string>();
    // One read-only connection per search, a bounded number of lookups, and none at all when the
    // archive cannot be opened: a failing lookup must never walk every candidate on the owner's loop.
    let archive:Database|null=null,archiveReason:string|null=null,lookups=0;
    try{archive=this.archive();}catch(error){archiveReason=`Archive matches skipped: ${error instanceof Error?error.message:String(error)}`;}
    try{
      for(const {index,score} of ranked){
        if(hits.length>=limit)break;
        let target=this.targets[index]!;
        if(target.kind==='archive'){
          if(!archive||lookups>=limit*3)continue;
          lookups++;
          const resolved=this.resolveArchive(archive,this.keys[index]!);if(!resolved)continue;target=resolved;
        }
        // Many prompts of one archived conversation are one result.
        const identity=target.kind==='session'?`s:${target.sessionId}`:target.kind==='peer'?`p:${target.peer}:${target.remoteSessionId}`:`a:${target.nativeId??target.sourceId}`;
        if(seen.has(identity))continue;seen.add(identity);
        hits.push({target,score:Math.round(score*1000)/1000,text:this.texts[index]!,at:this.times[index]??null,ref:this.keys[index]!});
      }
    }finally{archive?.close();}
    const reason=[this.caughtUp?null:'The meaning index is still catching up; older sessions may be missing.',archiveReason].filter(Boolean).join(' ')||null;
    return {available:true,hits,reason,indexed,pending:!this.caughtUp};
  }
}

let shared:MeaningIndex|null=null;
export function startMeaningIndex(stateDir:string,titleOf:(sessionId:number)=>string|null){
  if(shared)return shared;
  shared=new MeaningIndex(`${stateDir}/meaning-index.db`,titleOf);shared.start();
  process.once('exit',()=>{try{shared?.stop();}catch{}});
  return shared;
}
export function meaningIndex(){return shared;}
