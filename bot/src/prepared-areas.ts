import type {Database} from 'bun:sqlite';

type Change={source_table:string;row_key:string};
const PAGE=20;
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=(value:string)=>{try{return JSON.parse(Buffer.from(value,'base64url').toString());}catch{return null;}};
const edgeKey=(value:string)=>{try{return JSON.parse(value);}catch{return null;}};
const areaSummary=(row:any)=>({id:row.area_id,name:row.name,summary:row.summary,updatedAt:row.updated_at});

/** A disposable, bounded projection of the canonical area graph. Every changed edge is
 * copied by its exact key; a thread update reads its existing prepared card at view time. */
export class PreparedAreas {
  constructor(private source:Database,private prepared:Database){
    prepared.exec(`CREATE TABLE IF NOT EXISTS presentation_areas(
      generation INTEGER NOT NULL,area_id TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,
      summary TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(generation,area_id));
      CREATE INDEX IF NOT EXISTS presentation_areas_name ON presentation_areas(generation,name_key,area_id);
      CREATE TABLE IF NOT EXISTS presentation_area_threads(
        generation INTEGER NOT NULL,area_id TEXT NOT NULL,topic_id TEXT NOT NULL,
        PRIMARY KEY(generation,area_id,topic_id));
      CREATE INDEX IF NOT EXISTS presentation_area_threads_topic ON presentation_area_threads(generation,topic_id,area_id);
      CREATE TABLE IF NOT EXISTS presentation_area_neighbors(
        generation INTEGER NOT NULL,left_area_id TEXT NOT NULL,right_area_id TEXT NOT NULL,
        PRIMARY KEY(generation,left_area_id,right_area_id));
      CREATE INDEX IF NOT EXISTS presentation_area_neighbors_right ON presentation_area_neighbors(generation,right_area_id,left_area_id);
      CREATE TABLE IF NOT EXISTS presentation_area_projection_meta(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL,version INTEGER NOT NULL);`);
  }
  isReady(generation:number){
    const row=this.prepared.query('SELECT generation,version FROM presentation_area_projection_meta WHERE singleton=1')
      .get() as {generation:number;version:number}|null;
    return row?.generation===generation&&row.version===2;
  }
  activate(generation:number){
    this.prepared.query(`INSERT INTO presentation_area_projection_meta VALUES(1,?,2)
      ON CONFLICT(singleton) DO UPDATE SET generation=excluded.generation,version=excluded.version`).run(generation);
  }
  beginRebuild(generation:number){
    for(const table of ['presentation_areas','presentation_area_threads','presentation_area_neighbors'])
      this.prepared.query(`DELETE FROM ${table} WHERE generation=?`).run(generation);
  }
  rebuildPage(generation:number,kind:'areas'|'threads'|'neighbors',after:number,limit=50){
    const table=kind==='areas'?'inbox_areas':kind==='threads'?'inbox_area_threads':'inbox_area_neighbors';
    const rows=this.source.query(`SELECT rowid,* FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT ?`).all(after,limit+1) as any[];
    for(const row of rows.slice(0,limit)){
      if(kind==='areas')this.area(generation,row.area_id);
      else if(kind==='threads')this.thread(generation,row.area_id,row.topic_id);
      else this.neighbor(generation,row.left_area_id,row.right_area_id);
    }
    return {last:rows[Math.min(rows.length,limit)-1]?.rowid??after,hasMore:rows.length>limit};
  }
  apply(generation:number,changes:readonly Change[]){
    for(const change of changes){
      if(change.source_table==='inbox_areas')this.area(generation,change.row_key);
      else if(change.source_table==='inbox_area_threads'){
        const key=edgeKey(change.row_key);if(Array.isArray(key)&&key.length===2)this.thread(generation,key[0],key[1]);
      } else if(change.source_table==='inbox_area_neighbors'){
        const key=edgeKey(change.row_key);if(Array.isArray(key)&&key.length===2)this.neighbor(generation,key[0],key[1]);
      }
    }
  }
  private area(generation:number,id:string){
    const row=this.source.query('SELECT * FROM inbox_areas WHERE area_id=?').get(id) as any;
    if(!row){this.prepared.query('DELETE FROM presentation_areas WHERE generation=? AND area_id=?').run(generation,id);return;}
    this.prepared.query(`INSERT INTO presentation_areas VALUES(?,?,?,?,?,?)
      ON CONFLICT(generation,area_id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,
      summary=excluded.summary,updated_at=excluded.updated_at`)
      .run(generation,id,row.name,row.name_key,row.summary,row.updated_at);
  }
  private thread(generation:number,areaId:string,topicId:string){
    const exists=this.source.query('SELECT 1 FROM inbox_area_threads WHERE area_id=? AND topic_id=?').get(areaId,topicId);
    if(exists)this.prepared.query('INSERT OR IGNORE INTO presentation_area_threads VALUES(?,?,?)').run(generation,areaId,topicId);
    else this.prepared.query('DELETE FROM presentation_area_threads WHERE generation=? AND area_id=? AND topic_id=?').run(generation,areaId,topicId);
  }
  private neighbor(generation:number,left:string,right:string){
    const exists=this.source.query('SELECT 1 FROM inbox_area_neighbors WHERE left_area_id=? AND right_area_id=?').get(left,right);
    if(exists)this.prepared.query('INSERT OR IGNORE INTO presentation_area_neighbors VALUES(?,?,?)').run(generation,left,right);
    else this.prepared.query('DELETE FROM presentation_area_neighbors WHERE generation=? AND left_area_id=? AND right_area_id=?').run(generation,left,right);
  }
  collectPage(generation:number){
    for(const table of ['presentation_areas','presentation_area_threads','presentation_area_neighbors'])
      this.prepared.query(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE generation<? LIMIT 100)`).run(generation);
  }
}

const status=(db:Database,head:number)=>{
  const row=db.query('SELECT generation,source_head,ready FROM presentation_topics_meta WHERE singleton=1').get() as
    {generation:number;source_head:number;ready:number};
  let areaMeta:{generation:number;version:number}|null=null;
  try{areaMeta=db.query('SELECT generation,version FROM presentation_area_projection_meta WHERE singleton=1')
    .get() as {generation:number;version:number}|null;}catch{ /* The worker has not installed its disposable schema yet. */ }
  const complete=!!row.ready&&row.source_head>=head&&areaMeta?.generation===row.generation&&areaMeta.version===2;
  return {generation:row.generation,coverage:{complete,
    code:complete?null:'presentation_indexing',appliedSequence:row.source_head}};
};
export function readPreparedAreas(db:Database,head:number,query:string|null,cursor:string|null,limit=20){
  const {generation,coverage}=status(db,head),size=Math.max(1,Math.min(PAGE,limit));
  const search=(query??'').normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const old=cursor?decode(cursor):null;
  if(cursor&&(!old||old.g!==generation||old.q!==search||typeof old.name!=='string'||typeof old.id!=='string'))
    return {areas:[],nextCursor:null,coverage:{complete:false,code:'reset_required'}};
  // Prefix range stays indexed even as old threads and areas accumulate.
  const upper=search+'\uffff';
  const rows=db.query(`SELECT area_id,name,summary,updated_at,name_key FROM presentation_areas
    WHERE generation=? AND name_key>=? AND name_key<?
      AND (?=0 OR name_key>? OR (name_key=? AND area_id>?))
    ORDER BY name_key,area_id LIMIT ?`).all(generation,search,upper,old?1:0,old?.name??'',old?.name??'',old?.id??'',size+1) as any[];
  const page=rows.slice(0,size),count=db.query('SELECT count(*) AS n FROM presentation_area_threads WHERE generation=? AND area_id=?');
  return {areas:page.map(area=>({...areaSummary(area),threadCount:(count.get(generation,area.area_id) as {n:number}).n})),
    nextCursor:rows.length>size&&page.length?encode({g:generation,q:search,name:page.at(-1)!.name_key,id:page.at(-1)!.area_id}):null,coverage};
}
export function readPreparedArea(db:Database,head:number,id:string,cursor:string|null,limit=20){
  const {generation,coverage}=status(db,head),size=Math.max(1,Math.min(PAGE,limit));
  const area=db.query('SELECT * FROM presentation_areas WHERE generation=? AND area_id=?').get(generation,id) as any;
  if(!area)return {area:null,coverage};
  const old=cursor?decode(cursor):null;
  if(cursor&&(!old||old.g!==generation||old.id!==id||typeof old.key!=='string'))
    return {area:null,coverage:{complete:false,code:'reset_required'}};
  const neighborRows=db.query(`SELECT a.area_id AS id,a.name FROM presentation_area_neighbors n
    JOIN presentation_areas a ON a.generation=n.generation AND a.area_id=CASE WHEN n.left_area_id=? THEN n.right_area_id ELSE n.left_area_id END
    WHERE n.generation=? AND (n.left_area_id=? OR n.right_area_id=?) ORDER BY a.name_key LIMIT 21`)
    .all(id,generation,id,id) as {id:string;name:string}[];
  const rows=db.query(`SELECT t.topic_id,t.summary_json,t.sort_key FROM presentation_area_threads m
    JOIN presentation_topics t ON t.generation=m.generation AND t.topic_id=m.topic_id
    WHERE m.generation=? AND m.area_id=? AND (?='' OR t.sort_key>?)
    ORDER BY t.sort_key LIMIT ?`).all(generation,id,old?.key??'',old?.key??'',size+1) as any[];
  const page=rows.slice(0,size);
  return {area:{...areaSummary(area),neighbors:neighborRows.slice(0,20),neighborsMore:neighborRows.length>20,
    threadCount:(db.query('SELECT count(*) AS n FROM presentation_area_threads WHERE generation=? AND area_id=?').get(generation,id) as {n:number}).n,
    threads:page.map(row=>{const item=JSON.parse(row.summary_json);return {id:row.topic_id,title:item.title,summary:item.summary,state:item.state,updatedAt:item.lastEntryAt};}),
    nextCursor:rows.length>size&&page.length?encode({g:generation,id,key:page.at(-1)!.sort_key}):null},coverage};
}
