import type {Database} from 'bun:sqlite';
import type {SessionCard} from './prepared-session-cards';
import type {SessionSpace} from './session-space';

const SPACES:readonly SessionSpace[]=['everyday','lab'];
type Checkpoint={peer:string;space:SessionSpace;phase:'window'|'changes'|'prune';epoch:number;
 cursor:string|null;baseline:string|null;version:number;started_at_ms:number;applied_sequence:number;ready:number;error:string|null};
type Coverage={complete:boolean;code?:string;appliedSequence:number};
type Page={cards?:SessionCard[];changes?:{id:string;sourceSequence:number;before:SessionCard|null;after:SessionCard|null}[];
 nextCursor:string|null;asOf:string;coverage:Coverage};
export type CatalogueRequest=(path:string,signal?:AbortSignal)=>Promise<Page>;

/** The existing peer catalogue remains the addressable cache; only its refresh checkpoint is new. */
export function initializePeerCatalogueSchema(db:Database){
 const fields=db.query('PRAGMA table_info(session_peer_catalogue)').all() as {name:string}[];
 if(!fields.some(field=>field.name==='sync_space'))db.exec('ALTER TABLE session_peer_catalogue ADD COLUMN sync_space TEXT');
 if(!fields.some(field=>field.name==='sync_epoch'))db.exec('ALTER TABLE session_peer_catalogue ADD COLUMN sync_epoch INTEGER NOT NULL DEFAULT 0');
 if(!fields.some(field=>field.name==="sync_revision"))db.exec("ALTER TABLE session_peer_catalogue ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT -1");
 db.exec(`CREATE INDEX IF NOT EXISTS session_peer_catalogue_generation ON session_peer_catalogue(peer,sync_space,sync_epoch,remote_session_id);
  CREATE INDEX IF NOT EXISTS session_peer_catalogue_legacy ON session_peer_catalogue(peer,sync_space,updated_at_ms);
  CREATE TABLE IF NOT EXISTS session_peer_catalogue_sync(
   peer TEXT NOT NULL,space TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'window',epoch INTEGER NOT NULL DEFAULT 1,
   cursor TEXT,baseline TEXT,version INTEGER NOT NULL DEFAULT 0,started_at_ms INTEGER NOT NULL,
   ready INTEGER NOT NULL DEFAULT 0,applied_sequence INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(peer,space));
  CREATE TABLE IF NOT EXISTS session_peer_catalogue_tombstones(peer TEXT NOT NULL,remote_session_id TEXT NOT NULL,
   at_ms INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(peer,remote_session_id));`);
}

/** One invocation transfers at most one page per space and retires at most one cache page.
 * Every page and cursor commit together; a restart resumes the exact next page. */
export class PeerCatalogueSync {
 constructor(private readonly db:Database,private readonly now:()=>number=Date.now){}
 status(peer:string){
  const rows=this.db.query('SELECT space,phase,ready,error FROM session_peer_catalogue_sync WHERE peer=? ORDER BY space')
   .all(peer) as Pick<Checkpoint,'space'|'phase'|'ready'|'error'>[];
  return {complete:rows.length===SPACES.length&&rows.every(row=>row.ready===1&&!row.error),spaces:rows};
 }
 private checkpoint(peer:string,space:SessionSpace):Checkpoint{
  this.db.query('INSERT OR IGNORE INTO session_peer_catalogue_sync(peer,space,started_at_ms) VALUES(?,?,?)').run(peer,space,this.now());
  return this.db.query('SELECT * FROM session_peer_catalogue_sync WHERE peer=? AND space=?').get(peer,space) as Checkpoint;
 }
 private save(state:Checkpoint){
  this.db.query(`UPDATE session_peer_catalogue_sync SET phase=?,epoch=?,cursor=?,baseline=?,version=version+1,
   started_at_ms=?,ready=?,applied_sequence=?,error=? WHERE peer=? AND space=?`).run(state.phase,state.epoch,state.cursor,state.baseline,
    state.started_at_ms,state.ready,state.applied_sequence,state.error,state.peer,state.space);
 }
 private current(state:Checkpoint){return (this.db.query('SELECT version FROM session_peer_catalogue_sync WHERE peer=? AND space=?')
  .get(state.peer,state.space) as {version:number}|null)?.version===state.version;}
 private isOlder(state:Checkpoint,id:string,revision:number){
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error("PEER_CATALOGUE_REVISION_INVALID");
  const retained=this.db.query("SELECT sync_revision AS revision FROM session_peer_catalogue WHERE peer=? AND remote_session_id=? UNION ALL SELECT revision FROM session_peer_catalogue_tombstones WHERE peer=? AND remote_session_id=?").all(state.peer,id,state.peer,id) as {revision:number}[];
  return retained.some(row=>row.revision>revision);
 }
 private writeCard(state:Checkpoint,card:SessionCard){
  if(!/^concierge:[1-9][0-9]*$/.test(card.id)||!/^session:[A-Za-z0-9_-]+$/.test(card.address)||card.space!==state.space)
   throw new Error('PEER_CATALOGUE_CARD_IDENTITY_INVALID');
  if(Buffer.byteLength(JSON.stringify(card))>8*1024)throw new Error('PEER_CATALOGUE_CARD_TOO_LARGE');
  if(this.isOlder(state,card.id,card.revision??0))return;
  this.db.query('DELETE FROM session_peer_catalogue_tombstones WHERE peer=? AND remote_session_id=?').run(state.peer,card.id);
  const view={...card,id:`${state.peer}:${card.id.slice(10)}`,address:`${state.peer}/${card.address}`,peer:state.peer};
  this.db.query(`INSERT INTO session_peer_catalogue(peer,remote_session_id,address,runtime_thread_id,view_json,updated_at_ms,sync_space,sync_epoch,sync_revision)
   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(peer,remote_session_id) DO UPDATE SET address=excluded.address,
   runtime_thread_id=excluded.runtime_thread_id,view_json=excluded.view_json,updated_at_ms=excluded.updated_at_ms,
   sync_space=excluded.sync_space,sync_epoch=excluded.sync_epoch,sync_revision=excluded.sync_revision`).run(state.peer,card.id,card.address,card.runtimeThreadId,
    JSON.stringify(view),this.now(),state.space,state.epoch,card.revision??0);
 }
 private remove(state:Checkpoint,id:string,deleted=false,revision=0){
  if(!/^concierge:[1-9][0-9]*$/.test(id))throw new Error('PEER_CATALOGUE_TOMBSTONE_INVALID');
  if(deleted){
   if(this.isOlder(state,id,revision))return;
   this.db.query('INSERT INTO session_peer_catalogue_tombstones VALUES(?,?,?,?) ON CONFLICT(peer,remote_session_id) DO UPDATE SET at_ms=excluded.at_ms,revision=excluded.revision').run(state.peer,id,this.now(),revision);
   this.db.query('DELETE FROM session_peer_catalogue WHERE peer=? AND remote_session_id=?').run(state.peer,id);return;
  }
  // A late removal from the old space must not delete the card already moved to the other space.
  this.db.query('DELETE FROM session_peer_catalogue WHERE peer=? AND remote_session_id=? AND (sync_space IS NULL OR sync_space=?)')
   .run(state.peer,id,state.space);
 }
 private prune(state:Checkpoint){
  const rows=this.db.query(`SELECT remote_session_id FROM session_peer_catalogue
   WHERE peer=? AND sync_space=? AND sync_epoch<? ORDER BY sync_epoch,remote_session_id LIMIT 40`)
   .all(state.peer,state.space,state.epoch) as {remote_session_id:string}[];
  for(const row of rows)this.remove(state,row.remote_session_id,true,state.applied_sequence);
  if(rows.length===40)return true;
  state.phase='changes';state.ready=1;state.error=null;this.save(state);return false;
 }
 private retireLegacy(peer:string){
  const states=this.db.query('SELECT ready,started_at_ms FROM session_peer_catalogue_sync WHERE peer=?').all(peer) as {ready:number;started_at_ms:number}[];
  if(states.length!==SPACES.length||states.some(state=>!state.ready))return false;
  const started=Math.min(...states.map(state=>state.started_at_ms));
  const rows=this.db.query(`SELECT remote_session_id FROM session_peer_catalogue WHERE peer=? AND sync_space IS NULL
   AND updated_at_ms<? ORDER BY updated_at_ms LIMIT 40`).all(peer,started) as {remote_session_id:string}[];
  for(const row of rows)this.db.query('DELETE FROM session_peer_catalogue WHERE peer=? AND remote_session_id=? AND sync_space IS NULL AND updated_at_ms<?')
   .run(peer,row.remote_session_id,started);
  return rows.length===40;
 }
 async refresh(peer:string,request:CatalogueRequest,signal?:AbortSignal):Promise<{more:boolean}>{
  let more=false;
  for(const space of SPACES){
   if(signal?.aborted)return {more:false};
   const state=this.checkpoint(peer,space);
   if(state.phase==='prune'){
    more=this.db.transaction(()=>this.current(state)?this.prune(state):false)()||more;continue;
   }
   const query=new URLSearchParams({space,limit:'40',...(state.cursor?{cursor:state.cursor}:{})});
   let page:Page;
   try{page=await request(`/sessions/v1/presentation/sessions/${state.phase==='window'?'window':'changes'}?${query}`,signal);}
   catch(error){
    if(!signal?.aborted)this.db.query('UPDATE session_peer_catalogue_sync SET error=? WHERE peer=? AND space=? AND version=?')
     .run(error instanceof Error?error.message:'PEER_CATALOGUE_UNAVAILABLE',peer,space,state.version);
    throw error;
   }
   if(signal?.aborted)return {more:false};
   try{more=this.db.transaction(()=>{
    if(!this.current(state))return false;
    if(page.coverage?.code==='reset'){
     this.save({...state,phase:'window',epoch:state.epoch+1,cursor:null,baseline:null,ready:0,started_at_ms:this.now(),error:'reset'});
     return true;
    }
    if(!page.asOf||!page.coverage||page.coverage.code==='presentation_indexing'){
     this.save({...state,error:'presentation_indexing'});return false;
    }
    if(page.nextCursor!==null&&typeof page.nextCursor!=='string'||page.nextCursor&&page.nextCursor===state.cursor)
     throw new Error('PEER_CATALOGUE_CURSOR_NOT_ADVANCING');
    if(typeof page.coverage.complete!=='boolean'||!Number.isSafeInteger(page.coverage.appliedSequence)||page.coverage.appliedSequence<0)throw new Error('PEER_CATALOGUE_COVERAGE_INVALID');
    state.applied_sequence=page.coverage.appliedSequence;
    if(state.phase==='window'){
     if(!Array.isArray(page.cards)||page.cards.length>40)throw new Error('PEER_CATALOGUE_PAGE_INVALID');
     for(const card of page.cards)this.writeCard(state,{...card,revision:Math.max(card.revision??0,page.coverage.appliedSequence)});
     state.baseline??=page.asOf;
     state.cursor=page.nextCursor??state.baseline;
     if(!page.nextCursor)state.phase='changes';
     state.error=page.coverage.complete?null:page.coverage.code??'catching_up';
     this.save(state);return true;
    }
    if(!Array.isArray(page.changes)||page.changes.length>40)throw new Error('PEER_CATALOGUE_CHANGE_PAGE_INVALID');
    for(const change of page.changes){
     if(!Number.isSafeInteger(change.sourceSequence)||change.sourceSequence<0||change.after&&change.after.id!==change.id)
      throw new Error('PEER_CATALOGUE_CHANGE_IDENTITY_INVALID');
     if(change.after?.space===space)this.writeCard(state,{...change.after,revision:change.sourceSequence});
     else this.remove(state,change.id,change.after===null,change.sourceSequence);
    }
    state.cursor=page.nextCursor??page.asOf;
    state.error=page.coverage.complete?null:page.coverage.code??'catching_up';
    if(!page.nextCursor&&page.coverage.complete&&!state.ready)state.phase='prune';
    this.save(state);return !!page.nextCursor||state.phase==='prune';
   })()||more;}catch(error){
    this.db.query('UPDATE session_peer_catalogue_sync SET error=? WHERE peer=? AND space=? AND version=?')
     .run(error instanceof Error?error.message:'PEER_CATALOGUE_INVALID',peer,space,state.version);throw error;
   }
  }
  if(!signal?.aborted)more=this.db.transaction(()=>this.retireLegacy(peer))()||more;
  return {more};
 }
}
