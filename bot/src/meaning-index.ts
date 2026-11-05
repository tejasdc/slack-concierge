import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,realpathSync,rmSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
import {Database} from 'bun:sqlite';
import {db} from './state-database';
import {log} from './log';
import type {CapabilitySource} from './session-capability-client';
import {indexedArchiveSource} from './archive-search-source';
import {embedWithWorkersAi,workersAiEmbeddingsEnabled,workersAiEmbeddingsServe,WORKERS_AI_EMBEDDING_MODEL} from './workers-ai';
import {dirname,join} from 'node:path';

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
const INDEX_BATCH=4,PASSAGE_CHARS=800,SNIPPET_CHARS=400,PAGE=24,IDLE_POLL_MS=60_000;
const QUERY_PREFIX='task: search result | query: ',DOCUMENT_PREFIX='title: none | text: ';
const IDENTITY_HEADER='{"type":"concierge-session-input"';
/** Bumped when what a ledger passage is keyed or credited by changes; the ledger part is then rebuilt. */
const LEDGER_FORMAT='2';
/** The request boilerplate every delegated session opens with says nothing about its work. */
const REQUEST_PREAMBLE=/^Session request [0-9a-f-]{36} from [^\n]*(?:\n(?!\n)[^\n]*)*\n\n/;
const RESULT_PREAMBLE=/^Session (?:final|progress|stalled) event [0-9a-f-]{36} for requests? [0-9a-f-]{36}[^\n]*(?:\n(?!\n)[^\n]*)*\n\n/;
/** A carried result ends with its delivery record as one line of JSON; the reply's words are what came before it. */
const RESULT_RECORD=/\n\n\{[^\n]*\}\s*$/;

export type MeaningHit={target:{kind:'session';sessionId:number}|{kind:'peer';peer:string;remoteSessionId:string}|{kind:'archive';sourceId:string;sourceVersion:string;eventId:string;branch?:unknown;nativeId?:string|null;source?:CapabilitySource};score:number;text:string;at:string|null;ref:string};
export type MeaningSearch={available:boolean;hits:MeaningHit[];reason:string|null;indexed:number;pending:boolean};

/** A text embedding model. Vectors from two models never share an index: each index records its engine's model. */
interface EmbeddingEngine {
  readonly model:string;
  /** Texts per request: small for the local engine so a waiting search is never stuck behind a long batch. */
  readonly batch:number;
  installed():boolean;
  embed(texts:string[],timeoutMs?:number):Promise<Float32Array[]>;
  stop():void;
  /** May this engine's complete index answer searches in place of another one? */
  servable():boolean;
}

/** The same EmbeddingGemma model on Cloudflare Workers AI, so no embedding runs on this machine. */
class WorkersAiEngine implements EmbeddingEngine {
  readonly model=WORKERS_AI_EMBEDDING_MODEL;
  readonly batch=50;
  installed(){return workersAiEmbeddingsEnabled();}
  servable(){return workersAiEmbeddingsServe();}
  async embed(texts:string[],timeoutMs=60_000){return (await embedWithWorkersAi(texts,timeoutMs)).map(vector=>normalized(vector.slice(0,DIMENSIONS)));}
  stop(){}
}

/**
 * Where a local engine listens and how many threads it computes with.
 *
 * Two engines run the same model file (its pages are shared, so the second costs about 140 MB).
 * The shared one on port 8796 does Concierge's indexing and serves every other local caller
 * (thnkr.ing's note meanings and Reader queries, agents' experiments). Concierge's own question
 * embeddings go to a private one on a socket in its state folder, so a bulk caller on the shared
 * port never makes a session search wait: on 2026-11-05 an agent embedding 904 failure cases there
 * held searches to their 6 s limit.
 *
 * Threads and polling come from measurements on the saturated box (load ~54 on 12 cores, same
 * day): with 4 threads that spin while they wait for each other, one query took 6-17 s and the
 * engine burned up to 3.6 cores; with 1 thread and no spinning it took 0.15-0.28 s; 2 threads with
 * no spinning took 0.3-1.9 s and keep the shared engine's throughput for batches.
 */
type EngineSeat={socket:string|null;threads:number;parallel:number};
const SHARED_SEAT:EngineSeat={socket:null,threads:2,parallel:4};
// In Concierge's state folder, which agents' launches do not see; a socket path longer than the
// kernel's limit (about 104 bytes on macOS) falls back to /tmp.
const QUERY_SEAT=(stateDir:string):EngineSeat=>{const inState=join(stateDir,'meaning-query.sock');return {socket:inState.length<100?inState:`/tmp/concierge-meaning-query-${hash(stateDir).slice(0,12)}.sock`,threads:1,parallel:2};};

/** One llama.cpp server process, started on first use; CPU only, because the box's Vulkan path failed in September. */
class LocalEngine implements EmbeddingEngine {
  readonly model=`llama.cpp:${MODEL.split('/').pop()}`;
  readonly batch=INDEX_BATCH;
  private child:ChildProcess|null=null;
  private ready:Promise<void>|null=null;
  constructor(private readonly seat:EngineSeat=SHARED_SEAT){}
  installed(){return existsSync(SERVER)&&existsSync(MODEL);}
  servable(){return true;}
  private call(path:string,init:RequestInit={}){
    return this.seat.socket?fetch(`http://localhost${path}`,{...init,unix:this.seat.socket} as RequestInit):fetch(`http://127.0.0.1:${PORT}${path}`,init);
  }
  private async healthy(){try{return (await this.call('/health',{signal:AbortSignal.timeout(1_000)})).ok;}catch{return false;}}
  private start():Promise<void> {
    if(this.ready)return this.ready;
    this.ready=this.spawnOrAdopt();
    this.ready.catch(()=>{this.ready=null;});
    return this.ready;
  }
  /** An engine left on the port by an earlier Concierge process is used rather than fought: a second one could not bind and would exit in a loop. */
  private async spawnOrAdopt():Promise<void> {
    const where=this.seat.socket??PORT;
    if(await this.healthy()){log('info','meaning_engine_adopted',{at:where});return;}
    // A socket file left by an engine that died would stop the new one from listening.
    if(this.seat.socket)rmSync(this.seat.socket,{force:true});
    const listen=this.seat.socket?['--host',this.seat.socket]:['--host','127.0.0.1','--port',String(PORT)];
    // 2048 tokens per slot, whatever the slot count: a passage or question is far shorter.
    const context=String(2048*this.seat.parallel);
    // The engine dies with Concierge: stopped on exit below, and killed by the kernel if Concierge
    // is killed outright, so an update restart never finds a leftover engine (2026-10-07).
    const child=spawn('nice',['-n','10','setpriv','--pdeathsig','KILL',SERVER,'-m',MODEL,'--embedding',...listen,'-c',context,'-b','2048','-ub','2048','-np',String(this.seat.parallel),'-t',String(this.seat.threads),'--poll','0','--device','none','--log-disable'],{stdio:'ignore'});
    log('info','meaning_engine_started',{at:where,threads:this.seat.threads});
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
    // A released engine stays released: a late caller must not start a process nothing will stop.
    if(this.released)throw new Error('the local meaning engine was released for Workers AI');
    const deadline=AbortSignal.timeout(timeoutMs);
    await Promise.race([this.start(),new Promise<never>((_,reject)=>deadline.addEventListener('abort',()=>reject(new Error('meaning engine did not start in time')),{once:true}))]);
    let response:Response;
    try{response=await this.call('/v1/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:texts}),signal:deadline});}
    catch(error){
      // An engine that stopped answering (adopted and then gone, or hung) is replaced on the next call.
      if(!(await this.healthy())){this.child?.kill();this.child=null;this.ready=null;}
      throw error;
    }
    if(!response.ok)throw new Error(`meaning engine answered ${response.status}`);
    const body=await response.json() as {data:{index:number;embedding:number[]}[]};
    return body.data.sort((a,b)=>a.index-b.index).map(item=>normalized(item.embedding.slice(0,DIMENSIONS)));
  }
  private released=false;
  stop(){this.released=true;this.child?.kill();this.child=null;this.ready=null;}
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
  private store!:Database;
  private keys:string[]=[];private rowOf=new Map<string,number>();private scales:number[]=[];private matrix=new Int8Array(DIMENSIONS*4096);private count=0;
  private targets:MeaningHit['target'][]=[];private texts:string[]=[];private times:(string|null)[]=[];
  private searching=0;private archiveAbsent=false;
  private timer:ReturnType<typeof setTimeout>|null=null;private caughtUp=false;private stopped=false;private failure:string|null=null;
  /** Called once, the first time indexing finds nothing left to read: every passage then has this model's vector. */
  onComplete:(()=>void)|null=null;
  constructor(path:string,private readonly titleOf:(sessionId:number)=>string|null,private readonly engine:EmbeddingEngine=new LocalEngine(),
    /** Embeds questions (searches and callers comparing a question): its own engine when local, so indexing and other callers never delay one. Same model as engine. */
    private readonly questions:EmbeddingEngine=engine) {
    if(questions.model!==engine.model)throw new Error(`question engine ${questions.model} differs from index engine ${engine.model}`);
    // The index is derived from the ledger and rebuilt from it, so its commits never wait for the
    // disk: a sync here ran on the owner's event loop and stalled it under agent disk load
    // (2026-10-10). A power loss can then leave it unreadable, which is answered by rebuilding.
    for(let attempt=0;;attempt++) {
      this.store=new Database(path,{create:true});
      try {
        this.store.exec('PRAGMA synchronous=OFF');this.store.exec('PRAGMA temp_store=MEMORY');
        this.store.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS passages(key TEXT PRIMARY KEY,target_json TEXT NOT NULL,text TEXT NOT NULL,at TEXT,scale REAL NOT NULL,vector BLOB NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS watermarks(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS documents(key TEXT PRIMARY KEY,digest TEXT NOT NULL,vector BLOB NOT NULL) STRICT;`);
        const recorded=this.watermark('model');
        if(recorded!==engine.model){
          // A file written by another model (or before models were recorded, which was always the
          // local engine) is never searched with this one's vectors: start it over.
          if(recorded!==null||engine.model!==new LocalEngine().model){
            this.store.exec('DELETE FROM passages;DELETE FROM documents;DELETE FROM watermarks;');
            log('info','meaning_index_model_changed',{from:recorded,to:engine.model});
          }
          this.setWatermark('model',engine.model);
        }
        if(this.watermark('ledger-format')!==LEDGER_FORMAT){
          // Ledger passages are a rebuildable cache; re-read them under the current crediting rule.
          this.store.exec("DELETE FROM passages WHERE key LIKE 'input:%' OR key LIKE 'said:%'");
          this.setWatermark('ledger','0');this.setWatermark('ledger-format',LEDGER_FORMAT);
        }
        for(const row of this.store.query('SELECT key,target_json,text,at,scale,vector FROM passages').all() as any[])this.remember(row.key,JSON.parse(row.target_json),row.text,row.at,new Int8Array(row.vector),row.scale);
        break;
      } catch(error) {
        this.store.close();
        if(attempt)throw error;
        log('warn','meaning_index_rebuilt',{reason:error instanceof Error?error.message:String(error)});
        // The index may live on the ledger's own filesystem behind a link: rebuild it there, never
        // in place of the link.
        const real=existsSync(path)?realpathSync(path):path;
        for(const suffix of ['','-wal','-shm'])rmSync(real+suffix,{force:true});
        this.keys=[];this.rowOf=new Map();this.scales=[];this.count=0;this.targets=[];this.texts=[];this.times=[];
      }
    }
  }
  get installed(){return this.engine.installed();}
  /** Every passage has been read at least once under this index's model. */
  get complete(){return this.watermark('complete')==='1';}
  get size(){return this.count;}
  servable(){return this.engine.servable();}
  /**
   * Vectors for short texts other features compare by meaning (Inbox threads against areas),
   * cached here by key and exact words so an unchanged text is never embedded twice, even across
   * restarts. Same batches and the same courtesy to waiting searches as indexing.
   */
  /** Vectors for texts used as questions, prefixed as the session search prefixes its query. */
  async queryVectors(texts:string[]):Promise<Float32Array[]> {
    const out:Float32Array[]=[];
    for(let start=0;start<texts.length;start+=this.engine.batch){
      while(this.searching>0)await Bun.sleep(50);
      out.push(...await this.questions.embed(texts.slice(start,start+this.engine.batch).map(text=>QUERY_PREFIX+text.slice(0,PASSAGE_CHARS))));
    }
    return out;
  }
  async documentVectors(items:{key:string;text:string}[]):Promise<Map<string,Float32Array>> {
    const out=new Map<string,Float32Array>(),missing:{key:string;text:string;digest:string}[]=[];
    const read=this.store.query('SELECT digest,vector FROM documents WHERE key=?');
    for(const item of items){
      const digest=hash(item.text),row=read.get(item.key) as {digest:string;vector:Uint8Array}|null;
      if(row?.digest===digest)out.set(item.key,new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength)));
      else missing.push({...item,digest});
    }
    const write=this.store.query('INSERT OR REPLACE INTO documents(key,digest,vector) VALUES(?,?,?)');
    for(let start=0;start<missing.length;start+=this.engine.batch){
      while(this.searching>0)await Bun.sleep(50);
      const batch=missing.slice(start,start+this.engine.batch);
      const vectors=await this.engine.embed(batch.map(item=>DOCUMENT_PREFIX+item.text.slice(0,PASSAGE_CHARS)));
      this.store.transaction(()=>{for(const [index,item] of batch.entries()){write.run(item.key,item.digest,new Uint8Array(vectors[index]!.buffer));out.set(item.key,vectors[index]!);}})();
    }
    return out;
  }
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
    // A search waits behind whatever the engine is computing, so indexing hands it small batches
    // and steps aside while a search is waiting (a 24-passage batch held a query for 3.7 s).
    const vectors:Float32Array[]=[];
    for(let start=0;start<fresh.length;start+=this.engine.batch){
      while(this.searching>0)await Bun.sleep(50);
      vectors.push(...await this.engine.embed(fresh.slice(start,start+this.engine.batch).map(row=>DOCUMENT_PREFIX+row.text.slice(0,PASSAGE_CHARS))));
    }
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
  // One connection held while the index file stays the same. Opening it per page or per search
  // made SQLite open and chown its log on the root disk each time, and under load each open held
  // the owner for up to 1.6 s (2026-10-12). A rebuilt index is a new file, so it is reopened.
  private held:{db:Database,identity:string}|null=null;
  private archive():Database|null {
    const file=statSync(ARCHIVE_INDEX,{throwIfNoEntry:false});
    const identity=file?`${file.dev}:${file.ino}`:null;
    if(this.held&&this.held.identity===identity)return this.held.db;
    this.held?.db.close();this.held=null;
    if(!identity)return null;
    const archive=new Database(ARCHIVE_INDEX,{readonly:true});
    const version=Number((archive.query('PRAGMA user_version').get() as any)?.user_version);
    if(version!==3){archive.close();throw new Error(`archive index format ${version} is not the one this reader knows (3)`);}
    this.held={db:archive,identity};
    return archive;
  }
  private async archivePage():Promise<boolean> {
    const archive=this.archive();
    // Thinkering rebuilds its archive index; while it is missing this index is not complete.
    this.archiveAbsent=!archive;if(!archive)return false;
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
    }catch(error){this.held?.db.close();this.held=null;throw error;}
  }
  /** Indexing runs on its own timer, one page per tick, so it never holds the owner for long. */
  start() {
    if(!this.engine.installed()){log('info','meaning_index_unavailable',{reason:'engine not installed',model:this.engine.model});return;}
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
      if(!worked&&!this.caughtUp&&!this.failure){this.caughtUp=true;log('info','meaning_index_caught_up',{passages:this.count,model:this.engine.model});}
      // Complete (and so eligible to take over from another index) only with the archive read too.
      if(!worked&&!this.failure&&!this.archiveAbsent&&this.watermark('complete')!=='1')this.setWatermark('complete','1');
      if(this.onComplete&&this.complete&&this.servable()){const done=this.onComplete;this.onComplete=null;done();}
      if(worked)this.caughtUp=false;
      this.timer=setTimeout(tick,worked?50:this.failure?IDLE_POLL_MS*5:IDLE_POLL_MS);
    };
    this.timer=setTimeout(tick,5_000);
    // Loading the model takes seconds; pay it now rather than inside the first search's 6 s. The
    // shared engine is started too, because thnkr.ing's Reader expects it on port 8796 even when
    // the index has nothing new to embed.
    for(const engine of new Set([this.engine,this.questions]))if(engine instanceof LocalEngine)
      engine.embed([QUERY_PREFIX+'warm up'],60_000).catch(error=>log('warn','meaning_engine_warmup_failed',{error:error instanceof Error?error.message:String(error)}));
  }
  stop(){this.stopped=true;if(this.timer)clearTimeout(this.timer);this.engine.stop();if(this.questions!==this.engine)this.questions.stop();this.held?.db.close();this.held=null;this.store.close();}
  /** Archive hits resolve to the exact source, version and event the archive holds now, so a stale vector never names a changed file. */
  private resolveArchive(archive:Database,key:string):MeaningHit['target']|null {
    try{
      const row=archive.query(`SELECT s.metadata,e.eventId FROM bodies b JOIN evidence e ON e.bodyId=b.id JOIN sources s ON s.rowid=e.sourceRow WHERE b.hash=? AND b.lane='dialogue' ORDER BY e.id DESC LIMIT 1`).get(key.slice('archive:'.length)) as any;
      if(!row)return null;
      const source=JSON.parse(row.metadata);
      const metadata=indexedArchiveSource(source);
      if(!metadata)return null;
      return {kind:'archive',sourceId:source.id,sourceVersion:source.version,eventId:row.eventId,branch:source.branch??null,
        nativeId:typeof source.nativeId==='string'?source.nativeId:null,
        source:metadata};
    }catch{return null;}
  }
  async search(query:string,limit:number):Promise<MeaningSearch> {
    const indexed=this.count;
    if(!this.engine.installed())return {available:false,hits:[],reason:'The meaning search engine is not installed on this machine.',indexed,pending:false};
    if(!indexed)return {available:false,hits:[],reason:'The meaning index is still being built.',indexed,pending:true};
    let vector:Float32Array;
    this.searching++;
    try{[vector]=(await this.questions.embed([QUERY_PREFIX+query.slice(0,PASSAGE_CHARS)],6_000)) as [Float32Array];}
    catch(error){return {available:false,hits:[],reason:`Meaning search unavailable: ${error instanceof Error?error.message:String(error)}`,indexed,pending:!this.caughtUp};}
    finally{this.searching--;}
    return this.ranked(vector,limit,indexed);
  }
  /**
   * The same search for a question already embedded with queryVectors, so a caller comparing one
   * question against sessions and other documents pays for one embedding (request-history.ts).
   */
  /** A question embedded at search priority: indexing steps aside for it as it does for a search, where queryVectors waits behind searches. */
  async questionVector(query:string):Promise<Float32Array> {
    this.searching++;
    try{const [vector]=await this.questions.embed([QUERY_PREFIX+query.slice(0,PASSAGE_CHARS)],6_000) as [Float32Array];return vector;}
    finally{this.searching--;}
  }
  searchVector(vector:Float32Array,limit:number):MeaningSearch {
    const indexed=this.count;
    if(!indexed)return {available:false,hits:[],reason:'The meaning index is still being built.',indexed,pending:true};
    return this.ranked(vector,limit,indexed);
  }
  private ranked(vector:Float32Array,limit:number,indexed:number):MeaningSearch {
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
    // The held read-only connection, a bounded number of lookups, and none at all when the
    // archive cannot be opened: a failing lookup must never walk every candidate on the owner's loop.
    let archive:Database|null=null,archiveReason:string|null=null,lookups=0,unresolved=0;
    try{archive=this.archive();}catch(error){archiveReason=`Archive matches skipped: ${error instanceof Error?error.message:String(error)}`;}
    try{
      for(const {index,score} of ranked){
        if(hits.length>=limit)break;
        let target=this.targets[index]!;
        if(target.kind==='archive'){
          if(!archive||lookups>=limit*3)continue;
          lookups++;
          const resolved=this.resolveArchive(archive,this.keys[index]!);if(!resolved){unresolved++;continue;}target=resolved;
        }
        // Many prompts of one archived conversation are one result.
        const identity=target.kind==='session'?`s:${target.sessionId}`:target.kind==='peer'?`p:${target.peer}:${target.remoteSessionId}`:`a:${target.nativeId??target.sourceId}`;
        if(seen.has(identity))continue;seen.add(identity);
        hits.push({target,score:Math.round(score*1000)/1000,text:this.texts[index]!,at:this.times[index]??null,ref:this.keys[index]!});
      }
    }catch(error){this.held?.db.close();this.held=null;throw error;}
    const reason=[this.caughtUp?null:'The meaning index is still catching up; older sessions may be missing.',archiveReason,
      unresolved?`${unresolved} archive meaning matches had unavailable or invalid indexed source metadata and were omitted.`:null].filter(Boolean).join(' ')||null;
    return {available:true,hits,reason,indexed,pending:!this.caughtUp};
  }
}

let shared:MeaningIndex|null=null;
/**
 * The index searches use. With the Workers AI embeddings switch on, an index is built from Workers
 * AI's EmbeddingGemma in a file named for that model, beside the local one, while the local index
 * keeps answering. The new index takes over only when it has read everything once (about 96,000
 * passages, archive included) and the switch says `serve`, which is written after the routing
 * comparison on the two full indexes passes (docs/architecture/WORKERS-AI.md). Then the local
 * engine process is stopped for good. Callers take this once per search and use that one index
 * throughout, so a question and its candidates always share a model.
 */
export function startMeaningIndex(stateDir:string,titleOf:(sessionId:number)=>string|null){
  if(shared)return shared;
  const legacyPath=`${stateDir}/meaning-index.db`;
  const running=new Set<MeaningIndex>();
  process.once('exit',()=>{for(const index of running)try{index.stop();}catch{}});
  const cloud=new WorkersAiEngine();
  if(!cloud.installed()){
    shared=new MeaningIndex(legacyPath,titleOf,new LocalEngine(),new LocalEngine(QUERY_SEAT(stateDir)));shared.start();running.add(shared);
    return shared;
  }
  // Beside the local index's real file, which lives on the ledger's own disk behind a link. One
  // file per model, so a later model change builds beside the serving index instead of clearing it.
  const directory=existsSync(legacyPath)?dirname(realpathSync(legacyPath)):stateDir;
  const primary=new MeaningIndex(join(directory,`meaning-index.${cloud.model.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')}.db`),titleOf,cloud);
  running.add(primary);
  const local=new LocalEngine();
  if((primary.complete&&primary.servable())||!local.installed()){shared=primary;primary.start();return shared;}
  const standby=new MeaningIndex(legacyPath,titleOf,local,new LocalEngine(QUERY_SEAT(stateDir)));
  running.add(standby);
  shared=standby;standby.start();
  primary.onComplete=()=>{
    shared=primary;
    log('info','meaning_index_switched',{model:cloud.model,passages:primary.size});
    // Searches that already took the local index finish on it; then its engine is released and
    // its memory (about 100 MB of vectors and snippets) let go.
    setTimeout(()=>{try{standby.stop();}catch{}running.delete(standby);},30_000);
  };
  primary.start();
  return shared;
}
export function meaningIndex(){return shared;}
