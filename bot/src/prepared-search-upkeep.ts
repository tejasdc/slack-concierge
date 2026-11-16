import type {Database} from 'bun:sqlite';
import {allocatedBytes,releaseFreePages} from './sqlite-free-pages';
import type {PreparedSearchIndex} from './prepared-search';

/**
 * Moves the presentation file from the November 2026 search layout (three copies of every
 * text, tool output included) to the single-copy layout, then keeps freed pages returned.
 *
 * Order matters for disk: the old tables are emptied first, so the new index reuses their
 * pages and the file never grows; the free pages left over are then handed back with holes.
 * Every step is one small committed transaction followed by a pause sized to the bytes it
 * touched, so the worker never floods the disk the ledger shares (2026-10-09, 2026-10-23).
 *
 * The old tables are renamed before anything is deleted. An earlier release finds no table by
 * its old name, creates a fresh empty one and runs normally, so a rollback never meets a
 * half-deleted index. When this release returns, it retires that table again and re-runs the
 * backfill without hiding search (`warm`), because the earlier release indexed into the old name.
 */
const OLD=['prepared_search_text','prepared_search_short','prepared_search_documents'] as const;
const retired=(name:string)=>name.replace('prepared_search_','retired_search_');
const RETIRED_ROWS=['retired_search_text_data','retired_search_text_content','retired_search_text_docsize',
 'retired_search_short_data','retired_search_short_content','retired_search_short_docsize','retired_search_documents'];
/** Old bytes released per second (reads of the rows deleted; writes are a few pages). */
export const LEGACY_RELEASE_BYTES_PER_SECOND=32*1024*1024;
/** Ledger bytes read plus text indexed per second during backfill. */
export const BACKFILL_BYTES_PER_SECOND=8*1024*1024;
const STEP_BYTES=8*1024*1024;
const FREE_PAGE_RELEASE_THRESHOLD=256*1024*1024;
const HOUR=3_600_000;
const FAILURE_BACKOFF_MS=60_000;

/**
 * Bun opens SQLite in defensive mode, which refuses writes to an FTS5 table's own storage
 * tables. Deleting their rows in small steps is the only way to release an index without one
 * long read of every page, so this uses the system shell with defensive mode off for that one
 * connection. The worker is the file's only writer and waits for the shell to finish.
 */
function deleteShadowRows(path:string,table:string,last:number):boolean {
 if(!Bun.which('sqlite3'))return false;
 const result=Bun.spawnSync(['sqlite3','-bail',path,'.dbconfig defensive off','.timeout 5000',
  `DELETE FROM ${table} WHERE rowid<=${Math.trunc(last)};`],{stdout:'ignore',stderr:'pipe'});

 if(result.exitCode!==0)throw new Error(`LEGACY_SEARCH_RELEASE_FAILED: ${result.stderr.toString().slice(0,300)}`);
 return true;
}
type Phase={phase:'legacy'}|{phase:'messages';generation:number;after:number}|{phase:'inputs';after:number}
 |{phase:'sessions';after:number}|{phase:'done'};
type Backfill=Phase&{warm?:boolean};
export type SearchSources={
 generation():number;
 indexMessage(sessionId:number,messageId:string,sequence:number):void;
 inputsAfter(after:number,limit:number):{rowid:number;id:string}[];
 indexInput(id:string):void;
 sessionsAfter(after:number,limit:number):number[];
 indexSession(id:number):void;
};

export class PreparedSearchUpkeep {
 private nextAt=0;
 private lastCheck=0;
 private legacyRoles=new Map<string,{documents:number;bytes:number}>();
 private legacyBytes=0;
 private shellUsable=true;
 constructor(private readonly db:Database,private readonly path:string,private readonly search:PreparedSearchIndex,
  private readonly sources:SearchSources,private readonly keepLease:()=>void,
  private readonly log:(event:string,fields:Record<string,unknown>)=>void,
  private readonly releaseThresholdBytes=FREE_PAGE_RELEASE_THRESHOLD){}

 private state():Backfill {
  const row=this.db.query('SELECT backfill_json FROM search_meta WHERE singleton=1').get() as {backfill_json:string|null}|null;
  return JSON.parse(row?.backfill_json??'{"phase":"done"}') as Backfill;
 }
 private save(state:Backfill){
  this.db.query('UPDATE search_meta SET backfill_json=?,ready=? WHERE singleton=1')
   .run(JSON.stringify(state),state.phase==='done'||state.warm?1:0);
 }
 private exists(name:string){return !!this.db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(name);}

 /** One paced step; returns quickly when nothing is due. A failing step backs off, never loops. */
 step(now=Date.now()){
  if(now<this.nextAt)return;
  try {this.advance(now);}
  catch(error){
   this.nextAt=now+FAILURE_BACKOFF_MS;
   this.log('presentation_search_upkeep_failed',{error:String(error).slice(0,500),retry_ms:FAILURE_BACKOFF_MS});
  }
 }
 private advance(now:number){
  if(RETIRED_ROWS.some(name=>this.exists(name))||OLD.some(name=>this.exists(retired(name)))){
   this.pace(this.releaseRetired(),LEGACY_RELEASE_BYTES_PER_SECOND,now);return;
  }
  if(OLD.some(name=>this.exists(name))){this.retireOld();return;}
  const state=this.state();
  if(state.phase==='legacy'){
   this.db.transaction(()=>{this.keepLease();this.save({phase:'messages',generation:this.sources.generation(),after:0,warm:state.warm});})();
   this.log('presentation_search_legacy_released',{released_bytes:this.legacyBytes,documents_by_role:Object.fromEntries(this.legacyRoles)});
   return;
  }
  if(state.phase!=='done'){
   this.search.indexedBytes=0;this.backfill(state);
   this.pace(this.search.indexedBytes,BACKFILL_BYTES_PER_SECOND,now);return;
  }
  if(now-this.lastCheck<HOUR&&this.lastCheck)return;
  this.lastCheck=now;
  const pageSize=(this.db.query('PRAGMA page_size').get() as {page_size:number}).page_size;
  const free=(this.db.query('PRAGMA freelist_count').get() as {freelist_count:number}).freelist_count;
  const pages=(this.db.query('PRAGMA page_count').get() as {page_count:number}).page_count;
  const before=allocatedBytes(this.path);
  // Free pages already punched hold no blocks; only blocks beyond the live pages are reclaimable.
  const reclaimable=before-(pages-free)*pageSize;
  const release=reclaimable>=this.releaseThresholdBytes?releaseFreePages(this.db,this.path):null;
  const documents=(this.db.query('SELECT COUNT(*) AS n FROM search_documents').get() as {n:number}).n;
  // A partial release continues ten seconds later instead of in an hour.
  if(release?.released&&release.more)this.lastCheck=now-HOUR+10_000;
  this.log('presentation_search_size',{documents,file_bytes:pages*pageSize,free_bytes:free*pageSize,
   allocated_bytes_before:before,allocated_bytes:allocatedBytes(this.path),release});
 }
 private pace(bytes:number,rate:number,now:number){this.nextAt=now+Math.ceil(bytes/rate*1000);}

 /** One schema-only transaction: FTS5 renames its storage tables with the table. */
 private retireOld(){
  const state=this.state();
  this.db.transaction(()=>{
   this.keepLease();
   for(const name of OLD)if(this.exists(name))this.db.exec(`ALTER TABLE ${name} RENAME TO ${retired(name)}`);
   // Back after a rollback: the earlier release indexed new messages into the old name.
   if(state.phase!=='legacy')this.save({phase:'legacy',warm:state.phase==='done'||!!state.warm});
  })();
  this.log('presentation_search_legacy_retired',{after_phase:state.phase});
 }

 private releaseRetired():number {
  for(const table of RETIRED_ROWS){
   if(!this.exists(table))continue;
   const columns=(this.db.query(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column=>column.name);
   // octet_length reads a value's stored size without loading it.
   const size=columns.map(name=>`COALESCE(octet_length("${name}"),0)`).join('+');
   const roles=table==='retired_search_documents'&&columns.includes('role');
   let bytes=0,last:number|null=null;
   // A complete read, not an early-exited iterator: an unfinished statement would pin this
   // connection's snapshot and hide the shell's deletes.
   for(const row of this.db.query(`SELECT rowid AS id,${size} AS bytes${roles?',role':''} FROM ${table} ORDER BY rowid LIMIT 4096`)
    .all() as {id:number;bytes:number;role?:string}[]){
    bytes+=row.bytes;last=row.id;
    if(row.role!==undefined){const entry=this.legacyRoles.get(row.role)??{documents:0,bytes:0};entry.documents++;entry.bytes+=row.bytes;this.legacyRoles.set(row.role,entry);}
    if(bytes>=STEP_BYTES)break;
   }
   if(last===null){if(table==='retired_search_documents')this.db.transaction(()=>{this.keepLease();this.db.exec(`DROP TABLE ${table}`);})();continue;}
   if(table==='retired_search_documents')
    this.db.transaction(()=>{this.keepLease();this.db.query(`DELETE FROM ${table} WHERE rowid<=?`).run(last);})();
   else if(this.shellUsable&&deleteShadowRows(this.path,table,last)){
    // The shell writes from another process; this connection must see its delete.
    if(this.db.query(`SELECT 1 FROM ${table} WHERE rowid<=? LIMIT 1`).get(last)){
     this.shellUsable=false;
     this.log('presentation_search_shell_delete_unseen',{table});
    }
   }else{
    // Without the command-line shell, drop the whole index at once: one read of its pages.
    const index=table.replace(/_(data|content|docsize)$/,'');
    this.db.transaction(()=>{this.keepLease();this.db.exec(`DROP TABLE IF EXISTS ${index}`);})();
    this.log('presentation_search_legacy_dropped_whole',{table:index,reason:this.shellUsable?'sqlite3_shell_unavailable':'shell_delete_unseen'});
   }
   const before=this.legacyBytes;this.legacyBytes+=bytes;
   if(Math.floor(before/(1<<30))!==Math.floor(this.legacyBytes/(1<<30)))
    this.log('presentation_search_legacy_progress',{table,released_bytes:this.legacyBytes});
   return bytes;
  }
  // Every large storage table is empty: dropping the indexes now touches only a few pages.
  this.db.transaction(()=>{
   this.keepLease();
   for(const name of OLD)if(this.exists(retired(name)))this.db.exec(`DROP TABLE ${retired(name)}`);
  })();
  return 0;
 }

 private backfill(state:Exclude<Backfill,{phase:'legacy'|'done'}>) {
  const warm=state.warm;
  this.db.transaction(()=>{
   this.keepLease();
   if(state.phase==='messages'){
    const generation=this.sources.generation();
    const after=state.generation===generation?state.after:0;
    // Walk by rowid; the primary-key index would sort the whole generation on every step.
    const rows=this.db.query(`SELECT rowid AS id,session_id AS sessionId,message_id AS messageId,last_sequence AS sequence
      FROM presentation_owner_messages NOT INDEXED WHERE rowid>? AND generation=? ORDER BY rowid LIMIT 250`)
     .all(after,generation) as {id:number;sessionId:number;messageId:string;sequence:number}[];
    let last=after;
    for(const row of rows){
     this.sources.indexMessage(row.sessionId,row.messageId,row.sequence);last=row.id;
     if(this.search.indexedBytes>=STEP_BYTES)break;
    }
    // The rowid walk may pass rows of other generations, so only an empty page ends the phase.
    this.save(rows.length?{phase:'messages',generation,after:last,warm}:{phase:'inputs',after:0,warm});
    return;
   }
   if(state.phase==='inputs'){
    const rows=this.sources.inputsAfter(state.after,50);
    for(const row of rows)this.sources.indexInput(row.id);
    this.save(rows.length?{phase:'inputs',after:rows.at(-1)!.rowid,warm}:{phase:'sessions',after:0,warm});
    return;
   }
   const ids=this.sources.sessionsAfter(state.after,100);
   for(const id of ids)this.sources.indexSession(id);
   this.save(ids.length?{phase:'sessions',after:ids.at(-1)!,warm}:{phase:'done'});
  })();
  if(this.state().phase==='done')this.log('presentation_search_ready',{});
 }
}
