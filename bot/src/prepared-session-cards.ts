import type {Database} from 'bun:sqlite';
import {spaceForCwd,type SessionSpace} from './session-space';

type SourceSession={id:number;provider_id:string;status:string;native_metadata_json:string|null;
  agent_session_uuid:string|null;slack_channel_id:string|null;slack_thread_ts:string|null;created_at:string;last_turn_at:string|null};
type Labels={title:string;summary:string;project:string|null};
type SourceChange={sequence:number;source_table?:string;row_key?:string;session_id?:number|null;target_session_id?:number|null};
export type SessionCard=Readonly<{id:string;title:string;titleTruncated:boolean;summary:string;summaryTruncated:boolean;
  project:string|null;projectTruncated:boolean;provider:string;origin:string;catalogueKind:'conversation'|'historical-evidence';
  createdAt:string;updatedAt:string;archived:boolean;suspended:boolean;pinned:boolean;saved:boolean;
  outcome:string;space:SessionSpace;needsAttention:boolean|null;attentionCoverage:'complete'|'catching_up';
  unread:boolean;execution:string;pendingCount:number;model:string|null;reasoningEffort:string|null;revision?:number}>;
type CardRow={generation:number;session_id:number;sort_ms:number;space:SessionSpace;needs_attention:number|null;
  card_json:string;revision:number};
const MAX_PAGE=40,MAX_BYTES=96*1024,MAX_CARD_BYTES=3*1024;
const iso=(value:string|null|undefined)=>value?new Date(value.includes('T')?value:value+'Z').toISOString():new Date(0).toISOString();
const preview=(value:string,maxBytes:number)=>{
  let text='',bytes=0;
  for(const character of value){const next=Buffer.byteLength(character);if(bytes+next>maxBytes)break;text+=character;bytes+=next;}
  return {text,truncated:text.length<value.length};
};

/** A read-only canonical handle computes one changed card; the prepared handle owns its index.
 * This class never imports the mutable owner ledger or a provider runtime. */
export class PreparedSessionCards {
  constructor(private readonly source:Database,private readonly prepared:Database,
    private readonly labels:(source:Database,session:SourceSession)=>Labels,
    private readonly inboxAttention?:(session:SourceSession)=>boolean|null){
    prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_session_meta(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL DEFAULT 0,
      source_head INTEGER NOT NULL DEFAULT 0,change_base INTEGER NOT NULL DEFAULT 0,ready INTEGER NOT NULL DEFAULT 0
    ); INSERT OR IGNORE INTO presentation_session_meta(singleton) VALUES(1);
    CREATE TABLE IF NOT EXISTS presentation_session_cards(
      generation INTEGER NOT NULL,session_id INTEGER NOT NULL,sort_ms INTEGER NOT NULL,
      space TEXT NOT NULL,needs_attention INTEGER,card_json TEXT NOT NULL,revision INTEGER NOT NULL,
      PRIMARY KEY(generation,session_id)
    );
    CREATE INDEX IF NOT EXISTS presentation_session_window
      ON presentation_session_cards(generation,space,sort_ms DESC,session_id DESC);
    CREATE INDEX IF NOT EXISTS presentation_session_attention_window
      ON presentation_session_cards(generation,space,needs_attention,sort_ms DESC,session_id DESC);
    CREATE TABLE IF NOT EXISTS presentation_session_changes(
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,generation INTEGER NOT NULL,session_id INTEGER NOT NULL,
      before_json TEXT,after_json TEXT,before_space TEXT,after_space TEXT,
      before_revision INTEGER,source_sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS presentation_session_changes_page
      ON presentation_session_changes(generation,change_id);
    CREATE INDEX IF NOT EXISTS presentation_session_changes_before_space
      ON presentation_session_changes(generation,before_space,change_id);
    CREATE INDEX IF NOT EXISTS presentation_session_changes_after_space
      ON presentation_session_changes(generation,after_space,change_id);`);
  }
  beginRebuild(generation:number){
    this.prepared.query('DELETE FROM presentation_session_cards WHERE generation=?').run(generation);
    this.prepared.query('DELETE FROM presentation_session_changes WHERE generation=?').run(generation);
  }
  /** Finite batches let the worker yield between pages; the owner keeps serving the old generation. */
  rebuildPage(generation:number,afterSessionId:number,limit=100):{lastId:number;hasMore:boolean}{
    const rows=this.source.query('SELECT * FROM sessions WHERE id>? ORDER BY id LIMIT ?').all(afterSessionId,limit+1) as SourceSession[];
    for(const row of rows.slice(0,limit))this.write(generation,row.id,0,false);
    return {lastId:rows[Math.min(rows.length,limit)-1]?.id??afterSessionId,hasMore:rows.length>limit};
  }
  /** Call inside the worker's checkpoint transaction, after the canonical change page. */
  apply(generation:number,changes:readonly SourceChange[],attentionChangedSessionIds:readonly number[]=[]):void{
    const changed=new Map<number,number>();
    for(const change of changes){
      if(change.source_table==='turns'||change.source_table==='sessions')for(const id of [change.session_id,change.target_session_id])
        if(Number.isSafeInteger(id)&&Number(id)>0)changed.set(Number(id),Math.max(changed.get(Number(id))??0,change.sequence));
      if(change.source_table==='sessions'&&/^\d+$/.test(change.row_key??'')){
        const id=Number(change.row_key);changed.set(id,Math.max(changed.get(id)??0,change.sequence));
      }
    }
    for(const id of attentionChangedSessionIds)if(Number.isSafeInteger(id)&&id>0)
      changed.set(id,Math.max(changed.get(id)??0,changes.at(-1)?.sequence??0));
    for(const [id,sequence] of changed)this.write(generation,id,sequence,true);
  }
  activate(generation:number,sourceHead:number){
    const changeBase=(this.prepared.query('SELECT COALESCE(MAX(change_id),0) AS n FROM presentation_session_changes WHERE generation=?')
      .get(generation) as {n:number}).n;
    this.prepared.query('UPDATE presentation_session_meta SET generation=?,source_head=?,change_base=?,ready=1 WHERE singleton=1')
      .run(generation,sourceHead,changeBase);
  }
  checkpoint(generation:number,sourceHead:number){
    this.prepared.query('UPDATE presentation_session_meta SET source_head=? WHERE singleton=1 AND generation=? AND ready=1')
      .run(sourceHead,generation);
  }
  private write(generation:number,sessionId:number,sourceSequence:number,trackChange:boolean){
    const previous=this.prepared.query('SELECT card_json,revision FROM presentation_session_cards WHERE generation=? AND session_id=?')
      .get(generation,sessionId) as {card_json:string;revision:number}|null;
    const session=this.source.query('SELECT * FROM sessions WHERE id=?').get(sessionId) as SourceSession|null;
    if(!session){
      this.prepared.query('DELETE FROM presentation_session_cards WHERE generation=? AND session_id=?').run(generation,sessionId);
      if(trackChange&&previous)this.change(generation,sessionId,previous.card_json,null,previous.revision,sourceSequence);
      return;
    }
    const meta=JSON.parse(session.native_metadata_json||'{}');
    const labels=this.labels(this.source,session);
    const title=preview(labels.title,480),summary=preview(labels.summary,1200),project=labels.project?preview(labels.project,600):null;
    const latest=this.source.query('SELECT id,status,started_at FROM turns WHERE session_id=? ORDER BY id DESC LIMIT 1').get(sessionId) as
      {id:number;status:string;started_at:string|null}|null;
    const active=this.source.query("SELECT id FROM turns WHERE session_id=? AND status IN ('running','delivering') ORDER BY id DESC LIMIT 1")
      .get(sessionId) as {id:number}|null;
    const queued=(this.source.query("SELECT COUNT(*) AS n FROM turns WHERE session_id=? AND status='queued'").get(sessionId) as {n:number}).n;
    const observed=session.provider_id==='codex'&&meta.codexLifecycle?.threadId===session.agent_session_uuid
      ?meta.codexLifecycle:null;
    const lastStarted=this.source.query("SELECT started_at FROM turns WHERE session_id=? AND status<>'queued' AND started_at IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(sessionId) as {started_at:string}|null;
    const observedTurn=observed?.turnId?this.source.query('SELECT 1 FROM turns WHERE session_id=? AND provider_turn_id=? LIMIT 1')
      .get(sessionId,observed.turnId):null;
    const external=observed&&observed.state!=='idle'&&!active&&!observedTurn&&
      (!lastStarted||Date.parse(observed.startedAt??observed.observedAt)>=Date.parse(iso(lastStarted.started_at)))?observed:null;
    const execution=active?'running':external&&['running','uncertain'].includes(external.state)?external.state:
      queued?'queued':external?external.state:latest?({done:'completed',error:'failed',cancelled:'canceled',parked:'uncertain',interrupted:'uncertain',delivery_parked:'uncertain'} as Record<string,string>)[latest.status]??'idle':'idle';
    const inboxAttention=meta.inbox?this.inboxAttention?.(session)??null:null;
    const needsAttention=meta.inbox?inboxAttention:Array.isArray(meta.needs)
      ?meta.needs.some((need:{generation?:number})=>(need.generation??0)>(meta.dismissedGeneration??0)):false;
    const origin=meta.origin??'native';
    const card:SessionCard={id:`concierge:${sessionId}`,title:title.text,titleTruncated:title.truncated,
      summary:summary.text,summaryTruncated:summary.truncated,project:project?.text??null,projectTruncated:project?.truncated??false,
      provider:session.provider_id,origin,catalogueKind:origin==='imported'&&!meta.nativeBinding?'historical-evidence':'conversation',
      createdAt:iso(session.created_at),updatedAt:iso(session.last_turn_at??session.created_at),
      archived:session.status==='archived',suspended:meta.suspended??false,pinned:meta.pinned??false,saved:meta.saved??false,
      outcome:meta.outcome??'open',space:spaceForCwd(meta.cwd),needsAttention,attentionCoverage:needsAttention===null?'catching_up':'complete',
      unread:(meta.generation??0)>(meta.readGeneration??0),execution,pendingCount:queued,
      model:typeof meta.model==='string'?preview(meta.model,120).text:null,
      reasoningEffort:typeof meta.reasoningEffort==='string'?preview(meta.reasoningEffort,80).text:null};
    const encoded=JSON.stringify(card);
    if(Buffer.byteLength(encoded)>MAX_CARD_BYTES)throw new Error('SESSION_CARD_EXCEEDS_PREPARED_RECORD_BOUND');
    if(previous?.card_json===encoded)return;
    const sortMs=Date.parse(card.updatedAt);
    this.prepared.query(`INSERT INTO presentation_session_cards
      (generation,session_id,sort_ms,space,needs_attention,card_json,revision)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(generation,session_id) DO UPDATE SET
      sort_ms=excluded.sort_ms,space=excluded.space,needs_attention=excluded.needs_attention,
      card_json=excluded.card_json,revision=excluded.revision`).run(
      generation,sessionId,Number.isFinite(sortMs)?sortMs:0,card.space,needsAttention===null?null:Number(needsAttention),encoded,sourceSequence);
    if(trackChange)this.change(generation,sessionId,previous?.card_json??null,encoded,previous?.revision??null,sourceSequence);
  }
  private change(generation:number,sessionId:number,before:string|null,after:string|null,beforeRevision:number|null,sourceSequence:number){
    const beforeSpace=before?(JSON.parse(before) as SessionCard).space:null;
    const afterSpace=after?(JSON.parse(after) as SessionCard).space:null;
    this.prepared.query(`INSERT INTO presentation_session_changes
      (generation,session_id,before_json,after_json,before_space,after_space,before_revision,source_sequence)
      VALUES(?,?,?,?,?,?,?,?)`).run(generation,sessionId,before,after,beforeSpace,afterSpace,beforeRevision,sourceSequence);
  }
}

type WindowCursor={v:1;g:number;h:number;sort:number;id:number;space:SessionSpace;attention:boolean};
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=<T>(value:string):T|null=>{try{
  return value.length<=512&&/^[A-Za-z0-9_-]+$/.test(value)?JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as T:null;
}catch{return null;}};
export type SessionWindow={cards:SessionCard[];nextCursor:string|null;asOf:string;
  coverage:{complete:boolean;code?:'presentation_indexing'|'reset'|'attention_catching_up'|'catching_up';appliedSequence:number}};
export function readPreparedSessionWindow(database:Database,options:{space:SessionSpace;needsAttention?:boolean;cursor?:string|null;limit?:number;canonicalHead:number}):SessionWindow{
  const limit=Math.min(MAX_PAGE,Math.max(1,options.limit??20));
  return database.transaction(()=>{
    const meta=database.query('SELECT generation,source_head,change_base,ready FROM presentation_session_meta WHERE singleton=1')
      .get() as {generation:number;source_head:number;change_base:number;ready:number}|null;
    if(!meta?.ready)return {cards:[],nextCursor:null,asOf:'',coverage:{complete:false,code:'presentation_indexing',appliedSequence:meta?.source_head??0}};
    const head=(database.query('SELECT COALESCE(MAX(change_id),?) AS n FROM presentation_session_changes WHERE generation=?')
      .get(meta.change_base,meta.generation) as {n:number}).n;
    const position=options.cursor?decode<WindowCursor>(options.cursor):null;
    if(options.cursor&&(!position||position.v!==1||position.g!==meta.generation||position.space!==options.space||
      position.attention!==!!options.needsAttention||!Number.isSafeInteger(position.h)||position.h>head||
      position.h<meta.change_base||!Number.isSafeInteger(position.id)||!Number.isFinite(position.sort)))
      return {cards:[],nextCursor:null,asOf:encode({v:1,g:meta.generation,h:head,space:options.space}),coverage:{complete:false,code:'reset',appliedSequence:meta.source_head}};
    const rows=database.query(`SELECT session_id,sort_ms,card_json,revision FROM presentation_session_cards WHERE generation=? AND space=?
      AND (?=0 OR needs_attention=1)
      AND (sort_ms<? OR (sort_ms=? AND session_id<?))
      ORDER BY sort_ms DESC,session_id DESC LIMIT ?`).all(meta.generation,options.space,options.needsAttention?1:0,
        position?.sort??Number.MAX_SAFE_INTEGER,position?.sort??Number.MAX_SAFE_INTEGER,position?.id??Number.MAX_SAFE_INTEGER,limit+1) as CardRow[];
    const cards:SessionCard[]=[];let bytes=0;
    for(const row of rows.slice(0,limit)){
      const size=Buffer.byteLength(row.card_json);
      if(bytes+size>MAX_BYTES)break;
      cards.push({...JSON.parse(row.card_json),revision:row.revision});bytes+=size;
    }
    const last=rows[cards.length-1];
    const hasMore=rows.length>cards.length;
    const attentionUnknown=!!options.needsAttention&&!!database.query(`SELECT 1 FROM presentation_session_cards
      WHERE generation=? AND space=? AND needs_attention IS NULL LIMIT 1`).get(meta.generation,options.space);
    return {cards,nextCursor:hasMore&&last?encode({v:1,g:meta.generation,h:position?.h??head,sort:last.sort_ms,id:last.session_id,
      space:options.space,attention:!!options.needsAttention} satisfies WindowCursor):null,
      asOf:encode({v:1,g:meta.generation,h:position?.h??head,space:options.space}),
      coverage:attentionUnknown?{complete:false,code:'attention_catching_up',appliedSequence:meta.source_head}:
        meta.source_head<options.canonicalHead?{complete:false,code:'catching_up',appliedSequence:meta.source_head}:
        {complete:true,appliedSequence:meta.source_head}};
  })();
}

export function readPreparedSessionChanges(database:Database,cursor:string,space:SessionSpace,canonicalHead:number,limit=20){
  return database.transaction(()=>{
  const pageLimit=Math.min(MAX_PAGE,Math.max(1,limit));
  const position=decode<{v:1;g:number;h:number;space:SessionSpace}>(cursor);
  const meta=database.query('SELECT generation,source_head,change_base,ready FROM presentation_session_meta WHERE singleton=1')
    .get() as {generation:number;source_head:number;change_base:number;ready:number}|null;
  if(!meta?.ready||!position||position.v!==1||position.g!==meta.generation||position.space!==space||
    !Number.isSafeInteger(position.h)||position.h<0)
    return {changes:[],nextCursor:null,asOf:'',coverage:{complete:false,code:'reset',appliedSequence:meta?.source_head??0}};
  const head=(database.query('SELECT COALESCE(MAX(change_id),?) AS n FROM presentation_session_changes WHERE generation=?')
    .get(meta.change_base,meta.generation) as {n:number}).n;
  const floor=(database.query('SELECT MIN(change_id) AS n FROM presentation_session_changes WHERE generation=?')
    .get(meta.generation) as {n:number|null}).n;
  if(position.h>head||position.h<meta.change_base||(floor!==null&&position.h<floor-1))
    return {changes:[],nextCursor:null,asOf:encode({v:1,g:meta.generation,h:head,space}),coverage:{complete:false,code:'reset',appliedSequence:meta.source_head}};
  type ChangeRow={change_id:number;session_id:number;before_json:string|null;after_json:string|null;
    before_revision:number|null;source_sequence:number};
  const before=database.query(`SELECT change_id,session_id,before_json,after_json,before_revision,source_sequence
    FROM presentation_session_changes WHERE generation=? AND before_space=? AND change_id>? AND change_id<=?
    ORDER BY change_id LIMIT ?`).all(meta.generation,space,position.h,head,pageLimit+1) as ChangeRow[];
  const after=database.query(`SELECT change_id,session_id,before_json,after_json,before_revision,source_sequence
    FROM presentation_session_changes WHERE generation=? AND after_space=? AND change_id>? AND change_id<=?
    ORDER BY change_id LIMIT ?`).all(meta.generation,space,position.h,head,pageLimit+1) as ChangeRow[];
  const rows=[...new Map([...before,...after].map(row=>[row.change_id,row])).values()]
    .sort((a,b)=>a.change_id-b.change_id).slice(0,pageLimit+1);
  const changes=[] as {revision:number;id:string;before:SessionCard|null;after:SessionCard|null}[];let bytes=0;
  for(const row of rows.slice(0,pageLimit)){
    const size=Buffer.byteLength(row.before_json??'')+Buffer.byteLength(row.after_json??'');
    if(bytes+size>MAX_BYTES)break;
    changes.push({revision:row.change_id,id:`concierge:${row.session_id}`,
      before:row.before_json?{...JSON.parse(row.before_json),revision:row.before_revision}:null,
      after:row.after_json?{...JSON.parse(row.after_json),revision:row.source_sequence}:null});bytes+=size;
  }
  const more=rows.length>changes.length;
  const applied=changes.at(-1)?.revision??position.h;
  return {changes,nextCursor:more?encode({v:1,g:meta.generation,h:applied,space}):null,
    asOf:encode({v:1,g:meta.generation,h:more?applied:head,space}),coverage:meta.source_head<canonicalHead
      ?{complete:false,code:'catching_up',appliedSequence:meta.source_head}:{complete:true,appliedSequence:meta.source_head}};
  })();
}
